/**
 * Cloud sync (Phase 5, docs/cloud-sync.md): the small files that sync ONE
 * ITEM AT A TIME, latest change wins. Pure rules; the files themselves are
 * read and written by src/server/sync/map-views.ts.
 *
 * An item is a key and a JSON value (or nothing, when it was removed):
 *
 *   s|appearance.theme           one synced setting
 *   s|agent.tools|<tool id>      one tool switch (and s|agent.prompts|<segment>)
 *   p|<segment path>             one prompt override text
 *   t|<theme id>                 one custom theme file (themes/<id>.json)
 *   r|<field>                    one field of the graph view's sliders
 *   f|<folder id>                one chains-view folder
 *   o|<source id>                where one source is filed
 *   n|<source id>                one imported-file record
 *   x|<node id>                  one node's place in the graph view
 *
 * THE SETTINGS SPLIT (owner's decision): only the settings listed here
 * travel. Everything else in settings.json stays per device: model slots
 * and per-role models, the custom provider, the Claude Code switch,
 * file-access folders, the reading font, automatic updates, keyboard
 * shortcuts; since upstream 0.6.0 also the side-question model
 * (agent.models.sideQuestion) and the helpers' request limit
 * (agent.workerRequestConcurrency). A setting this list doesn't name is
 * never read or written by sync, whatever a request says.
 */

import { createHash } from "node:crypto";
import type { SourceFolder, SourceOrganization, SourcePlacement } from "../source-organization.ts";
import { COLOR_OVERRIDE_KEYS, isBuiltinThemeId, isThemeId, sanitizeThemeFile } from "../themes.ts";

/** One item as it travels: `value: null` means "not there". */
export interface MapChange {
	key: string;
	value: unknown;
	/** When it last changed, on the server's clock (ms). */
	t: number;
}

export const ABSENT = "-";
const MAX_KEY = 512;
const MAX_VALUE_BYTES = 2 * 1024 * 1024;

/** JSON with object keys in a fixed order, so equal values hash equal. */
export function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
	}
	return JSON.stringify(value ?? null);
}

/** A short fingerprint of a value; ABSENT for "not there". */
export function itemHash(value: unknown): string {
	if (value === undefined || value === null) return ABSENT;
	return createHash("sha256").update(canonical(value)).digest("hex").slice(0, 24);
}

// ─── Settings ────────────────────────────────────────────────────────────────

/** The single settings that sync. */
export const SYNCED_SETTINGS: ReadonlyArray<readonly string[]> = [
	// Upstream 0.6.0 replaced `mode` with `theme`, and the settings store no
	// longer keeps it. The key stays on this list so a record that still names
	// it (a state file from before, a settings file not yet rewritten) is
	// taken and then drops out by itself; a key that isn't listed is refused
	// with the whole request, which would stall the sync of every setting.
	["appearance", "mode"],
	["appearance", "theme"],
	["appearance", "background"],
	// The per-color overrides on top of the theme (upstream 0.6.0), each its
	// own item. null and absent both mean "the theme's color".
	...COLOR_OVERRIDE_KEYS.map((key) => ["appearance", "colors", key] as const),
	["appearance", "proseFontSize"],
	["appearance", "codeLigatures"],
	["appearance", "sessionNameSerif"],
	["appearance", "mdRendering", "headingWeight"],
	["appearance", "mdRendering", "boldColor"],
	["appearance", "mdRendering", "italicColor"],
	["dictation", "language"],
	["graph", "enabled"],
	["graph", "rendering"],
	["graph", "extractionChunkTokens"],
	["compaction", "thresholdTokens"],
	["compaction", "includeReasoning"],
	["agent", "search", "engine"],
	["agent", "graphTools", "enabled"],
];

/** The maps inside settings whose entries each sync: tool switches and prompt switches. */
export const SYNCED_SETTING_MAPS: ReadonlyArray<readonly string[]> = [
	["agent", "tools"],
	["agent", "prompts"],
];

const settingKey = (path: readonly string[]): string => `s|${path.join(".")}`;
const SETTING_KEYS = new Map(SYNCED_SETTINGS.map((path) => [settingKey(path), path]));
const SETTING_MAP_PREFIXES = SYNCED_SETTING_MAPS.map((path) => ({ prefix: `${settingKey(path)}|`, path }));

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);

function dig(record: unknown, path: readonly string[]): unknown {
	let at: unknown = record;
	for (const part of path) {
		if (!isObject(at) || !Object.hasOwn(at, part)) return undefined;
		at = at[part];
	}
	return at;
}

/** Set (or, with undefined, remove) one leaf; empty parents left behind are removed too. */
function plant(record: Json, path: readonly string[], value: unknown): void {
	const trail: Json[] = [record];
	for (const part of path.slice(0, -1)) {
		const at = trail[trail.length - 1]!;
		if (!isObject(at[part])) {
			if (value === undefined) return;
			at[part] = {};
		} else at[part] = { ...(at[part] as Json) };
		trail.push(at[part] as Json);
	}
	const leaf = path[path.length - 1]!;
	if (value === undefined) delete trail[trail.length - 1]![leaf]; else trail[trail.length - 1]![leaf] = value;
	for (let i = trail.length - 1; i > 0; i--) {
		if (Object.keys(trail[i]!).length === 0) delete trail[i - 1]![path[i - 1]!];
	}
}

/** The synced settings in a settings record, as items. */
export function settingsItems(record: unknown): Map<string, unknown> {
	const out = new Map<string, unknown>();
	for (const [key, path] of SETTING_KEYS) {
		const value = dig(record, path);
		if (value !== undefined) out.set(key, value);
	}
	for (const { prefix, path } of SETTING_MAP_PREFIXES) {
		const map = dig(record, path);
		if (isObject(map)) for (const [id, value] of Object.entries(map)) if (typeof value === "boolean") out.set(prefix + id, value);
	}
	return out;
}

/** Where a settings key points, or null when it isn't a synced setting. */
function settingPath(key: string): string[] | null {
	const single = SETTING_KEYS.get(key);
	if (single) return [...single];
	for (const { prefix, path } of SETTING_MAP_PREFIXES) {
		if (key.startsWith(prefix) && key.length > prefix.length) return [...path, key.slice(prefix.length)];
	}
	return null;
}

/** A copy of the record with these items set or removed. Other settings are untouched. */
export function withSettingsItems<T extends Json>(record: T, changes: ReadonlyMap<string, unknown>): T {
	const next = { ...record } as Json;
	for (const [key, value] of changes) {
		const path = settingPath(key);
		if (path) plant(next, path, value === null ? undefined : value);
	}
	return next as T;
}

// ─── Chains-view folders ─────────────────────────────────────────────────────

export function organizationItems(state: SourceOrganization): Map<string, unknown> {
	const out = new Map<string, unknown>();
	for (const folder of state.folders) out.set(`f|${folder.id}`, folder);
	for (const [id, placement] of Object.entries(state.placements)) out.set(`o|${id}`, placement);
	return out;
}

/**
 * The organization with these items set or removed, then made whole again:
 * two devices can each make a change that is fine alone and broken together
 * (a folder moved into a folder the other device deleted; two folders moved
 * into each other). A folder whose parent is gone, or that would sit inside
 * itself, moves to the top; a source filed in a missing folder is unfiled.
 * The same on every device, so they still end equal.
 */
export function withOrganizationItems(state: SourceOrganization, changes: ReadonlyMap<string, unknown>): SourceOrganization {
	const folders = new Map(state.folders.map((f) => [f.id, f]));
	const placements = new Map(Object.entries(state.placements));
	for (const [key, value] of changes) {
		const id = key.slice(2);
		if (key.startsWith("f|")) {
			if (value === null || value === undefined) folders.delete(id); else folders.set(id, { ...(value as SourceFolder), id });
		} else if (key.startsWith("o|")) {
			if (value === null || value === undefined) placements.delete(id); else placements.set(id, value as SourcePlacement);
		}
	}
	const ordered = [...folders.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
	const fixed = new Map(ordered.map((f) => [f.id, f]));
	for (const folder of ordered) {
		if (folder.parentId === null) continue;
		const seen = new Set<string>([folder.id]);
		let broken = false;
		for (let next: string | null = folder.parentId; next !== null;) {
			const parent = fixed.get(next);
			if (!parent || seen.has(next)) { broken = true; break; }
			seen.add(next);
			next = parent.parentId;
		}
		if (broken) fixed.set(folder.id, { ...fixed.get(folder.id)!, parentId: null });
	}
	const placed: Record<string, SourcePlacement> = {};
	for (const [id, placement] of placements) {
		placed[id] = placement.folderId !== null && !fixed.has(placement.folderId) ? { ...placement, folderId: null } : placement;
	}
	// Keep the order the file had; new folders follow, oldest first.
	const before = state.folders.map((f) => f.id).filter((id) => fixed.has(id));
	const known = new Set(before);
	const order = [...before, ...ordered.map((f) => f.id).filter((id) => !known.has(id))];
	return { version: 1, folders: order.map((id) => fixed.get(id)!), placements: placed };
}

// ─── What may arrive ─────────────────────────────────────────────────────────

const isFolder = (v: unknown): boolean => isObject(v) && typeof v.id === "string" && !!v.id && typeof v.name === "string" && !!v.name.trim()
	&& (v.parentId === null || typeof v.parentId === "string") && typeof v.createdAt === "string" && (v.importPath === undefined || typeof v.importPath === "string");
const isPlacement = (v: unknown): boolean => isObject(v) && (v.folderId === null || typeof v.folderId === "string") && (v.name === undefined || (typeof v.name === "string" && !!v.name.trim()));
const isPosition = (v: unknown): boolean => isObject(v) && typeof v.x === "number" && Number.isFinite(v.x) && typeof v.y === "number" && Number.isFinite(v.y);

/** A custom theme's key, t|<id>: a theme id, and not one of the built-in themes (those never travel). */
export function isCustomThemeKey(key: string): boolean {
	const id = key.slice(2);
	return key.startsWith("t|") && isThemeId(id) && !isBuiltinThemeId(id);
}

/** The kinds of item, by the key's first letter. */
export const MAP_KINDS = ["s", "p", "t", "r", "f", "o", "n", "x"] as const;
export type MapKind = (typeof MAP_KINDS)[number];

export function kindOf(key: string): MapKind | null {
	const kind = key[0] as MapKind;
	return key[1] === "|" && key.length > 2 && MAP_KINDS.includes(kind) ? kind : null;
}

/** A change received from the other side, or null when it can't be trusted. */
export function checkMapChange(raw: unknown): MapChange | null {
	if (!isObject(raw) || typeof raw.key !== "string" || raw.key.length > MAX_KEY) return null;
	if (typeof raw.t !== "number" || !Number.isFinite(raw.t) || raw.t < 0) return null;
	const kind = kindOf(raw.key);
	if (!kind) return null;
	const value = raw.value === undefined ? null : raw.value;
	if (value !== null) {
		if (canonical(value).length > MAX_VALUE_BYTES) return null;
		const id = raw.key.slice(2);
		const fine = kind === "s" ? settingPath(raw.key) !== null && (typeof value !== "object")
			: kind === "p" ? typeof value === "string"
			: kind === "t" ? isCustomThemeKey(raw.key) && canonical(sanitizeThemeFile(value)) === canonical(value)
			: kind === "r" ? true
			: kind === "f" ? isFolder(value) && (value as { id: string }).id === id
			: kind === "o" ? isPlacement(value)
			: kind === "n" ? isObject(value) && value.id === id
			: isPosition(value);
		if (!fine) return null;
	} else if ((kind === "s" && settingPath(raw.key) === null) || (kind === "t" && !isCustomThemeKey(raw.key))) return null;
	return { key: raw.key, value, t: raw.t };
}

/** A vault's top-level folder name that the server may leave out of Obsidian sync. */
export function isVaultFolderName(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 255 && !/[\\/\u0000-\u001f]/.test(value) && value !== "." && value !== "..";
}

export const MAX_VAULT_FOLDERS = 500;
