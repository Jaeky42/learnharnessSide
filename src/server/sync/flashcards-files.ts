/**
 * Flashcards sync (docs/phone-plugins-plan.md, "Flashcards sync"): the
 * plugin's one file as the per-item exchange (maps-sync.ts) sees it.
 *
 *   <data>/core-plugin-data/flashcards/flashcards.json   the library (the plugin's own file)
 *   <data>/sync/flashcards-memory.json                   what this device last read or wrote: every
 *                                                        item but the reviews (core/sync/flashcards.ts:
 *                                                        how a deletion is told from "never had it")
 *   <data>/sync/flashcards-memory-reviews.json           the rest of it: the review ids, and the file's
 *                                                        revision it was made from (small, so a review
 *                                                        doesn't rewrite the big part)
 *
 * READ turns the file into items with the pure rules (`readFlashcards`), and
 * saves the memory BEFORE anything is sent. The snapshot is kept until the
 * file or the memory changes on disk (inode, size and times), so an idle
 * round parses and hashes nothing; an item's fingerprint is kept while its
 * value is the same (a review's for good: reviews never change).
 *
 * APPLY is one synchronous step, with nothing awaited between reading and
 * writing: read the file again, combine, write the file whole (a temporary
 * file renamed over it, as the plugin writes), save the memory (after the
 * file: a memory ahead of its file would read as deletions), then tell the
 * plugin's open pages (`plugin-message`, topic `changed`). What it wrote is
 * kept as the next read (no second parse of the file). The plugin, in the
 * same process, re-reads its file when it changed on disk (the one edit to
 * its store.cjs). It works with the plugin switched off or never started:
 * the file is still written, and a missing file is a library with nothing
 * in it.
 *
 * A FILE PUT BACK (a restored backup, a copy from elsewhere) is not a list of
 * deletions: a file whose revision is lower than the memory's, or that lacks
 * a review the memory saw, doesn't follow the memory (`followsMemory`). The
 * memory is set aside, nothing is read as deleted, and the exchange treats
 * this side's records as lost (flashcards-engine.ts). Crashes can't get there
 * the other way round: the file is always written before its memory.
 *
 * THE FORMAT LOCK: a file whose `version` isn't the one this build reads
 * (`FLASHCARDS_FORMAT`), or that isn't the plugin's shape, is neither sent
 * nor taken: every kind reads as unreadable and nothing is written to it.
 */

import fs from "node:fs";
import path from "node:path";
import pluginScheduler from "../../../plugins/flashcards/src/scheduler.cjs";
import {
	applyFlashcardsChanges, FLASHCARDS_FORMAT, FLASHCARDS_KINDS, followsMemory, isFlashcardsFile, isFlashcardsItem, readFlashcards, rebuildFlashcards,
	type FlashcardsFile, type FlashcardsMemory, type FlashcardsRead, type FlashcardsScheduler,
} from "../../core/sync/flashcards.ts";
import { itemHash } from "../../core/sync/maps.ts";
import { writeFileAtomicSync } from "../../store/atomic-write.ts";
import type { ApplyContext, MapFiles, MapItem, MapSnapshot } from "./map-views.ts";

/** The plugin's own scheduler: the same code its back end runs, in this process's time zone. */
export const flashcardsScheduler = pluginScheduler as unknown as FlashcardsScheduler;

export const FLASHCARDS_PLUGIN_ID = "flashcards";

/**
 * A generation that has shown no change for this long no longer holds the
 * exchange (a batch left "running" when its worker record was lost would
 * otherwise hold it for good).
 */
export const BUSY_HOLD_MAX_MS = 15 * 60_000;

/** The plugin's data folder (as src/server/plugins.ts gives it to a core plugin). */
export const flashcardsDataDir = (dataDir: string): string => path.join(/* turbopackIgnore: true */ dataDir, "core-plugin-data", FLASHCARDS_PLUGIN_ID);

/** This side's sync files for Flashcards, under <data>/sync/ (also what the first-sync backups copy). */
export const FLASHCARDS_SYNC_FILES = ["flashcards-memory.json", "flashcards-memory-reviews.json", "flashcards.json", "flashcards-desktop.json"] as const;

/**
 * "ok": the memory belongs to this file. "lost": the library can be read
 * but there is no memory for it. "stale": the file doesn't follow the
 * memory (put back or replaced). "unreadable": the library can't be read
 * (nothing is decided about the memory then).
 */
export type FlashcardsRecords = "ok" | "lost" | "stale" | "unreadable";

export interface FlashcardsFiles extends MapFiles {
	/**
	 * A generation batch is under way here (running or cancelling, while the
	 * plugin is switched on, and not stuck for BUSY_HOLD_MAX_MS): this side
	 * holds its Flashcards exchange.
	 */
	busy(): boolean;
	/** The library can't be read at all (the format lock, or a damaged file). */
	locked(): boolean;
	records(): FlashcardsRecords;
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

/** One item's fingerprint, and whether the other side would take it, for the JSON it had. */
interface Known { json: string | null; h: string; ok: boolean }

export function createFlashcardsFiles(deps: {
	dataDir: string;
	syncDir: string;
	now: () => number;
	/** Open Flashcards pages learn that the library changed under them. */
	announce: () => void;
	scheduler?: FlashcardsScheduler;
	log?: (line: string) => void;
}): FlashcardsFiles {
	const libraryFile = path.join(/* turbopackIgnore: true */ flashcardsDataDir(deps.dataDir), "flashcards.json");
	const itemsFile = path.join(/* turbopackIgnore: true */ deps.syncDir, "flashcards-memory.json");
	const reviewsFile = path.join(/* turbopackIgnore: true */ deps.syncDir, "flashcards-memory-reviews.json");
	const pluginsState = path.join(/* turbopackIgnore: true */ deps.dataDir, "plugins-state.json");
	const scheduler = deps.scheduler ?? flashcardsScheduler;
	const log = deps.log ?? ((line: string) => console.log(line));

	let parsed: { stamp: string | null; library: Library } | null = null;
	let snapshot: { key: string; value: MapSnapshot } | null = null;
	/** The memory as last read or written, and the JSON of each part (to write a part only when it changed). */
	let memory: { stamps: string; value: FlashcardsMemory | null; itemJson: Map<string, string>; reviewsText: string | null } | null = null;
	let known = new Map<string, Known>();
	let busySeen: { print: string; since: number; said: boolean } | null = null;
	/** The last read or apply, with the stamps it was made for: an apply on the same file and memory starts from it. */
	let lastRead: { key: string; read: FlashcardsRead } | null = null;
	const stampsKey = (): string => `${stampOf(libraryFile) ?? "-"}|${memoryStamps()}`;

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

	const memoryStamps = (): string => `${stampOf(itemsFile) ?? "-"}|${stampOf(reviewsFile) ?? "-"}`;

	function readMemory(): FlashcardsMemory | null {
		const stamps = memoryStamps();
		if (memory && memory.stamps === stamps) return memory.value;
		let value: FlashcardsMemory | null = null;
		const itemJson = new Map<string, string>();
		let reviewsText: string | null = null;
		try {
			const items = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ itemsFile, "utf-8")) as { version?: unknown; items?: unknown };
			reviewsText = fs.readFileSync(/* turbopackIgnore: true */ reviewsFile, "utf-8");
			const rest = JSON.parse(reviewsText) as { version?: unknown; reviews?: unknown; revision?: unknown };
			const ok = items?.version === 1 && !!items.items && typeof items.items === "object" && !Array.isArray(items.items)
				&& rest?.version === 1 && Array.isArray(rest.reviews) && rest.reviews.every((id) => typeof id === "string")
				&& (rest.revision === undefined || Number.isSafeInteger(rest.revision));
			if (ok) {
				value = { version: 1, items: items.items as Record<string, unknown>, reviews: rest.reviews as string[], ...(rest.revision !== undefined ? { revision: rest.revision as number } : {}) };
				for (const [key, v] of Object.entries(value.items)) itemJson.set(key, JSON.stringify(v));
			}
		} catch { value = null; }
		memory = { stamps, value, itemJson: value ? itemJson : new Map(), reviewsText: value ? reviewsText : null };
		return value;
	}

	/** Save the memory: the big part only when an item changed, the small part only when it changed. */
	function saveMemory(next: FlashcardsMemory): void {
		readMemory();
		const keys = Object.keys(next.items);
		const itemJson = new Map<string, string>();
		let changed = !memory?.value || keys.length !== memory.itemJson.size;
		for (const key of keys) {
			const json = JSON.stringify(next.items[key]);
			itemJson.set(key, json);
			if (!changed && memory!.itemJson.get(key) !== json) changed = true;
		}
		const reviewsText = JSON.stringify({ version: 1, reviews: next.reviews, ...(next.revision !== undefined ? { revision: next.revision } : {}) });
		if (!changed && memory?.reviewsText === reviewsText) { memory.value = next; return; }
		fs.mkdirSync(/* turbopackIgnore: true */ deps.syncDir, { recursive: true });
		// The items first: a crash between the two leaves the small part older, never ahead.
		if (changed) writeFileAtomicSync(itemsFile, `{"version":1,"items":{${keys.map((key) => `${JSON.stringify(key)}:${itemJson.get(key)}`).join(",")}}}`, { mode: 0o600 });
		if (memory?.reviewsText !== reviewsText || changed) writeFileAtomicSync(reviewsFile, reviewsText, { mode: 0o600 });
		memory = { stamps: memoryStamps(), value: next, itemJson, reviewsText };
	}

	/** An item's fingerprint and check, kept while its JSON is the same; a review's for good. */
	function knownOf(next: Map<string, Known>, key: string, value: unknown): Known {
		const prior = known.get(key);
		if (prior && key[0] === "r") { next.set(key, prior); return prior; }
		const json = JSON.stringify(value);
		if (prior && prior.json === json) { next.set(key, prior); return prior; }
		const entry: Known = { json: key[0] === "r" ? null : json, h: itemHash(value), ok: isFlashcardsItem(key, value) };
		next.set(key, entry);
		return entry;
	}

	const unreadable = (): MapSnapshot => ({ items: new Map(), unreadable: new Set(FLASHCARDS_KINDS), unreadableKeys: new Set(), fileTimes: new Map() });

	/** The snapshot of a read; every item timed by the file's time (0 for a file put back: what it holds is old). */
	function snapshotOf(read: FlashcardsRead, next: Map<string, Known>, mtime: number | null): MapSnapshot {
		const time = read.stale ? 0 : mtime;
		const items = new Map<string, MapItem>();
		for (const [key, value] of read.items) items.set(key, { value, mtime: time, h: next.get(key)?.h ?? itemHash(value) });
		return { items, unreadable: new Set(), unreadableKeys: read.missing, fileTimes: new Map(FLASHCARDS_KINDS.map((kind) => [kind, time])) };
	}

	function read(): MapSnapshot {
		const lib = library();
		const key = `${parsed?.stamp ?? "-"}|${memoryStamps()}`;
		if (snapshot && snapshot.key === key) return snapshot.value;
		// Never sent, never taken, never written: the format lock, and a damaged file.
		if (lib.state === "unreadable") return unreadable();
		const next = new Map<string, Known>();
		const result = readFlashcards(lib.state === "ok" ? lib.file : null, readMemory(), deps.now(), (itemKey, value) => knownOf(next, itemKey, value).ok);
		if (result.stale) log("[LearnHarness] Flashcards sync: the library doesn't follow what sync last saw here (it was put back or replaced); nothing missing from it counts as deleted, and it is combined again.");
		// Stamps and deletions are decided here, once: saved before the items go anywhere.
		saveMemory(result.memory);
		known = next;
		const value = snapshotOf(result, next, lib.state === "ok" ? mtimeOf(libraryFile) : null);
		snapshot = { key: `${parsed?.stamp ?? "-"}|${memoryStamps()}`, value };
		lastRead = result.stale ? null : { key: snapshot.key, read: result };
		return value;
	}

	function apply(changes: ReadonlyMap<string, unknown>, context?: ApplyContext): void {
		// One synchronous step from here to the announcement.
		const lib = library();
		if (lib.state === "unreadable") throw new Error("The Flashcards library can't be read, so nothing was written to it.");
		const next = new Map<string, Known>();
		const base = lastRead && lastRead.key === stampsKey() ? lastRead.read : undefined;
		const result = applyFlashcardsChanges(lib.state === "ok" ? lib.file : null, readMemory(), changes, {
			now: deps.now(), scheduler, senderHad: context ? (key) => context.senderHad(key) : undefined,
			check: (key, value) => knownOf(next, key, value).ok, base,
		});
		if (result.changed && result.file) {
			fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(libraryFile), { recursive: true });
			writeFileAtomicSync(libraryFile, JSON.stringify(result.file), { mode: 0o600 });
			parsed = { stamp: stampOf(libraryFile), library: { state: "ok", file: result.file } };
		}
		saveMemory(result.memory);
		known = next;
		// What was just written is what a read gives: kept, so nothing is parsed or hashed again.
		const mtime = parsed?.library.state === "ok" ? mtimeOf(libraryFile) : null;
		snapshot = { key: `${parsed?.stamp ?? "-"}|${memoryStamps()}`, value: snapshotOf({ ...result.read, stale: false }, next, mtime) };
		lastRead = { key: snapshot.key, read: result.read };
		if (result.changed) deps.announce();
	}

	function rebuild(): boolean {
		const lib = library();
		if (lib.state !== "ok") return false;
		const file = rebuildFlashcards(lib.file, readMemory(), scheduler, deps.now());
		if (file === lib.file) return false;
		writeFileAtomicSync(libraryFile, JSON.stringify(file), { mode: 0o600 });
		parsed = { stamp: stampOf(libraryFile), library: { state: "ok", file } };
		snapshot = null;
		lastRead = null;
		deps.announce();
		return true;
	}

	function pluginOn(): boolean {
		try {
			const state = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ pluginsState, "utf-8")) as { enabled?: Record<string, unknown> };
			return state?.enabled?.[FLASHCARDS_PLUGIN_ID] === true;
		} catch {
			return false;
		}
	}

	return {
		read,
		apply,
		rebuild,
		busy() {
			const lib = library();
			// The plugin's own test (backend.cjs activeBatch); a switched-off plugin runs nothing.
			const active = lib.state === "ok" ? lib.file.batches.filter((batch) => ["running", "cancelling"].includes((batch as { status?: unknown })?.status as string)) : [];
			if (active.length === 0 || !pluginOn()) { busySeen = null; return false; }
			const print = JSON.stringify(active);
			const now = deps.now();
			if (!busySeen || busySeen.print !== print) busySeen = { print, since: now, said: false };
			if (now - busySeen.since < BUSY_HOLD_MAX_MS) return true;
			if (!busySeen.said) {
				busySeen.said = true;
				log("[LearnHarness] Flashcards sync: a generation has shown no progress for 15 minutes; Flashcards sync goes on without waiting for it.");
			}
			return false;
		},
		locked: () => library().state === "unreadable",
		records() {
			const lib = library();
			if (lib.state === "unreadable") return "unreadable";
			const mem = readMemory();
			if (!mem) return "lost";
			return followsMemory(lib.state === "ok" ? lib.file : null, mem) ? "ok" : "stale";
		},
	};
}
