/**
 * Cloud sync (Phase 5): the files that sync one item at a time, read and
 * written through the app's own stores, so every value passes the same
 * sanitizers as a change made in the app.
 *
 *   settings.json                     the synced settings only (core/sync/maps.ts)
 *   prompts/**                        prompt override texts
 *   graph/render-settings.json        the graph view's sliders
 *   graph/source-organization.json    the chains view's folders
 *   graph/sources.json                imported-file records
 *   graph/positions.json              node places in the graph view
 *
 * A file that is there but can't be read is NOT an empty file: its kinds
 * are reported as unreadable and sync leaves them alone on both sides.
 * Reading a damaged file as "nothing here" would delete the other side's.
 */

import fs from "node:fs";
import path from "node:path";
import { POSITIONS_FILE, PROMPTS_OVERRIDE_DIR, RENDER_SETTINGS_FILE, SETTINGS_FILE, SOURCE_ORGANIZATION_FILE, SOURCES_FILE } from "../../../config.ts";
import type { NotesSource, Position } from "../../core/contracts.ts";
import { emit } from "../../core/events.ts";
import { CURRENT_SETTINGS_VERSION, type UserSettings } from "../../core/settings.ts";
import { organizationItems, settingsItems, withOrganizationItems, withSettingsItems, kindOf, type MapKind } from "../../core/sync/maps.ts";
import { graphStore } from "../../store/graph.ts";
import { promptOverrides } from "../../store/prompt-overrides.ts";
import { DEFAULT_RENDER_SETTINGS, readRenderSettings, writeRenderSettings } from "../../store/render-settings.ts";
import { readSettings, writeSettings } from "../../store/settings.ts";
import { sourceOrganizationStore } from "../../store/source-organization.ts";

export interface MapItem {
	value: unknown;
	/** When the file holding it last changed (ms), or null when unknown. */
	mtime: number | null;
}

export interface MapSnapshot {
	items: Map<string, MapItem>;
	/** Kinds whose file is there but can't be read: left alone this round. */
	unreadable: Set<MapKind>;
	/** When each kind's file last changed: the time given to an item that went. */
	fileTimes: Map<MapKind, number | null>;
}

export interface MapFiles {
	read(): MapSnapshot;
	/**
	 * Set items, or remove them (null). Keys of unreadable kinds must not be
	 * passed. A file that refuses the change keeps what it had; the caller
	 * reads again to see what is really there.
	 */
	apply(changes: ReadonlyMap<string, unknown>): void;
}

function mtimeOf(file: string): number | null {
	try { return fs.statSync(/* turbopackIgnore: true */ file).mtimeMs; } catch { return null; }
}

/** "absent" (never written), "ok", or "broken" (there, but not the JSON object it should be). */
function jsonFile(file: string): "absent" | "ok" | "broken" {
	let raw: string;
	try { raw = fs.readFileSync(/* turbopackIgnore: true */ file, "utf-8"); }
	catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "broken"; }
	try {
		const parsed: unknown = JSON.parse(raw);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? "ok" : "broken";
	} catch {
		return "broken";
	}
}

interface View {
	kinds: MapKind[];
	file: string;
	/** The items, or null when the file can't be read. */
	read(): Map<string, unknown> | null;
	apply(changes: Map<string, unknown>): void;
}

const views: View[] = [
	{
		kinds: ["s"],
		file: SETTINGS_FILE,
		read() {
			const state = jsonFile(SETTINGS_FILE);
			if (state === "absent") return new Map();
			const record = state === "ok" ? readSettings() : null;
			return record ? settingsItems(record) : null;
		},
		apply(changes) {
			const record: UserSettings = readSettings() ?? { version: CURRENT_SETTINGS_VERSION };
			writeSettings(withSettingsItems(record, changes));
		},
	},
	{
		kinds: ["r"],
		file: RENDER_SETTINGS_FILE,
		read() {
			const state = jsonFile(RENDER_SETTINGS_FILE);
			if (state === "absent") return new Map();
			const record = state === "ok" ? readRenderSettings() : null;
			return record ? new Map(Object.entries(record).map(([field, value]) => [`r|${field}`, value])) : null;
		},
		apply(changes) {
			const next: Record<string, unknown> = { ...(readRenderSettings() ?? DEFAULT_RENDER_SETTINGS) };
			// The sliders have no "unset": a removed field keeps the value it has.
			for (const [key, value] of changes) if (value !== null) next[key.slice(2)] = value;
			writeRenderSettings(next);
		},
	},
	{
		kinds: ["f", "o"],
		file: SOURCE_ORGANIZATION_FILE,
		read() {
			return organizationItems(sourceOrganizationStore.read());
		},
		apply(changes) {
			sourceOrganizationStore.write(withOrganizationItems(sourceOrganizationStore.read(), changes));
		},
	},
	{
		kinds: ["n"],
		file: SOURCES_FILE,
		read() {
			if (jsonFile(SOURCES_FILE) === "broken") return null;
			return new Map(graphStore.readSources().map((source) => [`n|${source.id}`, source]));
		},
		apply(changes) {
			// upsertSource keeps an existing record's usage log; removing first makes it a plain set.
			graphStore.deleteSources(new Set([...changes.keys()].map((key) => key.slice(2))));
			for (const value of changes.values()) if (value !== null) graphStore.upsertSource(value as NotesSource);
			emit("sources-changed", {});
		},
	},
	{
		kinds: ["x"],
		file: POSITIONS_FILE,
		read() {
			if (jsonFile(POSITIONS_FILE) === "broken") return null;
			return new Map(Object.entries(graphStore.readPositions()).map(([id, position]) => [`x|${id}`, position]));
		},
		apply(changes) {
			const all = graphStore.readPositions();
			for (const [key, value] of changes) {
				if (value === null) delete all[key.slice(2)]; else all[key.slice(2)] = value as Position;
			}
			graphStore.writePositions(all);
		},
	},
];

const promptFile = (segment: string): string => path.join(/* turbopackIgnore: true */ PROMPTS_OVERRIDE_DIR, ...segment.split("/"));

/** The real files of this copy. */
export const mapFiles: MapFiles = {
	read() {
		const items = new Map<string, MapItem>();
		const unreadable = new Set<MapKind>();
		const fileTimes = new Map<MapKind, number | null>();
		for (const view of views) {
			let found: Map<string, unknown> | null;
			try { found = view.read(); } catch { found = null; }
			if (!found) { for (const kind of view.kinds) unreadable.add(kind); continue; }
			const mtime = mtimeOf(view.file);
			for (const kind of view.kinds) fileTimes.set(kind, mtime);
			for (const [key, value] of found) items.set(key, { value, mtime });
		}
		try {
			for (const segment of promptOverrides.listOverrides()) {
				const text = promptOverrides.readOverride(segment);
				if (text !== null) items.set(`p|${segment}`, { value: text, mtime: mtimeOf(promptFile(segment)) });
			}
		} catch {
			unreadable.add("p");
		}
		return { items, unreadable, fileTimes };
	},
	apply(changes) {
		// Prompt texts first: a switch that arrives with its text finds the file there.
		for (const [key, value] of changes) {
			if (kindOf(key) !== "p") continue;
			try {
				if (value === null) promptOverrides.deleteOverride(key.slice(2)); else promptOverrides.writeOverride(key.slice(2), String(value));
			} catch { /* kept as it was */ }
		}
		for (const view of views) {
			const mine = new Map([...changes].filter(([key]) => view.kinds.includes(kindOf(key) as MapKind)));
			if (mine.size === 0) continue;
			try { view.apply(mine); } catch { /* kept as it was */ }
		}
	},
};
