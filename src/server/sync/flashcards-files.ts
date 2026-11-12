/**
 * Flashcards sync (docs/phone-plugins-plan.md, "Flashcards sync"): the
 * plugin's one file as the per-item exchange (maps-sync.ts) sees it.
 *
 *   <data>/core-plugin-data/flashcards/flashcards.json   the library (the plugin's own file)
 *   <data>/sync/flashcards-memory.json                   what this device last read or wrote
 *                                                        (core/sync/flashcards.ts: how a deletion
 *                                                        is told from "never had it")
 *
 * READ turns the file into items with the pure rules (`readFlashcards`), and
 * saves the memory BEFORE anything is sent. The snapshot, the items'
 * fingerprints included, is kept until the file or the memory changes on
 * disk (inode, size and times), so an idle round parses and hashes nothing.
 *
 * APPLY is one synchronous step, with nothing awaited between reading and
 * writing: read the file again, combine, write the file whole (a temporary
 * file renamed over it, as the plugin writes), save the memory (after the
 * file: a memory ahead of its file would read as deletions), then tell the
 * plugin's open pages (`plugin-message`, topic `changed`). The plugin, in
 * the same process, re-reads its file when it changed on disk (the one edit
 * to its store.cjs). It works with the plugin switched off or never
 * started: the file is still written, and a missing file is a library with
 * nothing in it.
 *
 * THE FORMAT LOCK: a file whose `version` isn't the one this build reads
 * (`FLASHCARDS_FORMAT`), or that isn't the plugin's shape, is neither sent
 * nor taken: every kind reads as unreadable and nothing is written to it.
 */

import fs from "node:fs";
import path from "node:path";
import pluginScheduler from "../../../plugins/flashcards/src/scheduler.cjs";
import {
	applyFlashcardsChanges, FLASHCARDS_FORMAT, FLASHCARDS_KINDS, isFlashcardsFile, isFlashcardsMemory, readFlashcards, rebuildFlashcards,
	type FlashcardsFile, type FlashcardsMemory, type FlashcardsScheduler,
} from "../../core/sync/flashcards.ts";
import { itemHash } from "../../core/sync/maps.ts";
import { writeFileAtomicSync } from "../../store/atomic-write.ts";
import type { MapFiles, MapItem, MapSnapshot } from "./map-views.ts";

/** The plugin's own scheduler: the same code its back end runs, in this process's time zone. */
export const flashcardsScheduler = pluginScheduler as unknown as FlashcardsScheduler;

export const FLASHCARDS_PLUGIN_ID = "flashcards";

/** The plugin's data folder (as src/server/plugins.ts gives it to a core plugin). */
export const flashcardsDataDir = (dataDir: string): string => path.join(/* turbopackIgnore: true */ dataDir, "core-plugin-data", FLASHCARDS_PLUGIN_ID);

export interface FlashcardsFiles extends MapFiles {
	/**
	 * A generation batch is under way here (running or cancelling, while the
	 * plugin is switched on): this side holds its Flashcards exchange.
	 */
	busy(): boolean;
	/** Is there a memory this side can read? */
	memoryReadable(): boolean;
	/**
	 * Work every fact's schedule out again from its reviews, in this
	 * process's time zone as it is now (after the zone changed: the other
	 * side works them out in that zone too). One synchronous step, like
	 * `apply`. True when the file changed.
	 */
	rebuild(): boolean;
}

/** inode, size and times; null when the file isn't there. */
function stampOf(file: string): string | null {
	try {
		const st = fs.statSync(/* turbopackIgnore: true */ file);
		return `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
	} catch {
		return null;
	}
}

function mtimeOf(file: string): number | null {
	try { return fs.statSync(/* turbopackIgnore: true */ file).mtimeMs; } catch { return null; }
}

type Library = { state: "absent" } | { state: "ok"; file: FlashcardsFile } | { state: "unreadable" };

export function createFlashcardsFiles(deps: {
	dataDir: string;
	syncDir: string;
	now: () => number;
	/** Open Flashcards pages learn that the library changed under them. */
	announce: () => void;
	scheduler?: FlashcardsScheduler;
}): FlashcardsFiles {
	const libraryFile = path.join(/* turbopackIgnore: true */ flashcardsDataDir(deps.dataDir), "flashcards.json");
	const memoryFile = path.join(/* turbopackIgnore: true */ deps.syncDir, "flashcards-memory.json");
	const pluginsState = path.join(/* turbopackIgnore: true */ deps.dataDir, "plugins-state.json");
	const scheduler = deps.scheduler ?? flashcardsScheduler;

	let parsed: { stamp: string | null; library: Library } | null = null;
	let snapshot: { key: string; value: MapSnapshot } | null = null;
	let memory: { stamp: string | null; value: FlashcardsMemory | null; text: string | null } | null = null;

	/** The library as it is on disk now; parsed again only when the file changed. */
	function library(): Library {
		const stamp = stampOf(libraryFile);
		if (parsed && parsed.stamp === stamp) return parsed.library;
		let result: Library;
		if (stamp === null) result = { state: "absent" };
		else {
			try {
				const value: unknown = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ libraryFile, "utf-8"));
				result = isFlashcardsFile(value) && value.version === FLASHCARDS_FORMAT ? { state: "ok", file: value } : { state: "unreadable" };
			} catch (error) {
				result = (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "absent" } : { state: "unreadable" };
			}
		}
		parsed = { stamp, library: result };
		return result;
	}

	function readMemory(): FlashcardsMemory | null {
		const stamp = stampOf(memoryFile);
		if (memory && memory.stamp === stamp) return memory.value;
		let value: FlashcardsMemory | null = null;
		let text: string | null = null;
		if (stamp !== null) {
			try {
				text = fs.readFileSync(/* turbopackIgnore: true */ memoryFile, "utf-8");
				const json: unknown = JSON.parse(text);
				value = isFlashcardsMemory(json) ? json : null;
			} catch { value = null; }
		}
		memory = { stamp, value, text: value ? text : null };
		return value;
	}

	function saveMemory(next: FlashcardsMemory): void {
		const text = JSON.stringify(next);
		readMemory();
		if (memory?.text === text) return;
		fs.mkdirSync(/* turbopackIgnore: true */ deps.syncDir, { recursive: true });
		writeFileAtomicSync(memoryFile, text, { mode: 0o600 });
		memory = { stamp: stampOf(memoryFile), value: next, text };
	}

	const unreadable = (): MapSnapshot => ({ items: new Map(), unreadable: new Set(FLASHCARDS_KINDS), unreadableKeys: new Set(), fileTimes: new Map() });

	function read(): MapSnapshot {
		const lib = library();
		const key = `${parsed?.stamp ?? "-"}|${stampOf(memoryFile) ?? "-"}`;
		if (snapshot && snapshot.key === key) return snapshot.value;
		// Never sent, never taken, never written: the format lock, and a damaged file.
		if (lib.state === "unreadable") return unreadable();
		const result = readFlashcards(lib.state === "ok" ? lib.file : null, readMemory(), deps.now());
		// Stamps and deletions are decided here, once: saved before the items go anywhere.
		saveMemory(result.memory);
		const mtime = lib.state === "ok" ? mtimeOf(libraryFile) : null;
		const items = new Map<string, MapItem>();
		for (const [itemKey, value] of result.items) items.set(itemKey, { value, mtime, h: itemHash(value) });
		const value: MapSnapshot = {
			items,
			unreadable: new Set(),
			unreadableKeys: result.missing,
			fileTimes: new Map(FLASHCARDS_KINDS.map((kind) => [kind, mtime])),
		};
		snapshot = { key: `${parsed?.stamp ?? "-"}|${stampOf(memoryFile) ?? "-"}`, value };
		return value;
	}

	function apply(changes: ReadonlyMap<string, unknown>): void {
		// One synchronous step from here to the announcement.
		const lib = library();
		if (lib.state === "unreadable") throw new Error("The Flashcards library can't be read, so nothing was written to it.");
		const result = applyFlashcardsChanges(lib.state === "ok" ? lib.file : null, readMemory(), changes, { now: deps.now(), scheduler });
		if (result.changed && result.file) {
			fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(libraryFile), { recursive: true });
			writeFileAtomicSync(libraryFile, JSON.stringify(result.file), { mode: 0o600 });
		}
		saveMemory(result.memory);
		snapshot = null;
		parsed = null;
		if (result.changed) deps.announce();
	}

	function pluginOn(): boolean {
		try {
			const state = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ pluginsState, "utf-8")) as { enabled?: Record<string, unknown> };
			return state?.enabled?.[FLASHCARDS_PLUGIN_ID] === true;
		} catch {
			return false;
		}
	}

	function rebuild(): boolean {
		const lib = library();
		if (lib.state !== "ok") return false;
		const file = rebuildFlashcards(lib.file, readMemory(), scheduler, deps.now());
		if (file === lib.file) return false;
		writeFileAtomicSync(libraryFile, JSON.stringify(file), { mode: 0o600 });
		snapshot = null;
		parsed = null;
		deps.announce();
		return true;
	}

	return {
		read,
		apply,
		rebuild,
		busy() {
			const lib = library();
			if (lib.state !== "ok") return false;
			// The plugin's own test (backend.cjs activeBatch); a switched-off plugin runs nothing.
			return lib.file.batches.some((batch) => ["running", "cancelling"].includes((batch as { status?: unknown })?.status as string)) && pluginOn();
		},
		memoryReadable() {
			return readMemory() !== null;
		},
	};
}
