/**
 * Cloud sync (Phase 5): the graph log's files, under <data>/sync/.
 *
 *   server   graph-log.jsonl      the one ordered log: {seq, by, eid, change}
 *            graph-log-id         a random name for this log, so a desktop can
 *                                 tell a log that started over (the server was
 *                                 reset or restored) from the one it knows
 *   desktop  graph.json           how far into the server's log it has read,
 *                                 and which log that was
 *            graph-outbox.jsonl   its own entries the server hasn't accepted
 *            graph-base/*.jsonl   the ledgers as the server has them at that
 *                                 point, kept only while the outbox isn't empty
 *
 * Never synced themselves. Absent files mean graph sync has never run here.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { LEDGERS, type GraphEntry, type Ledgers } from "../../core/sync/graph-log.ts";
import { writeFileAtomicSync } from "../atomic-write.ts";

export interface LoggedEntry extends GraphEntry {
	seq: number;
	/** The device that made the change ("cloud" for the server itself). */
	by: string;
}

function readLines<T>(file: string): T[] {
	let raw: string;
	try { raw = fs.readFileSync(/* turbopackIgnore: true */ file, "utf-8"); } catch { return []; }
	const out: T[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try { out.push(JSON.parse(line) as T); } catch { /* a torn last line: the entry was never acknowledged */ }
	}
	return out;
}

function stampOf(file: string): string {
	try {
		const st = fs.statSync(/* turbopackIgnore: true */ file);
		return `${st.mtimeMs}:${st.size}`;
	} catch {
		return "-";
	}
}

const jsonl = (items: unknown[]): string => items.map((item) => JSON.stringify(item)).join("\n") + (items.length > 0 ? "\n" : "");

export interface ServerGraphLog {
	exists(): boolean;
	/** This log's own name; "" before the log exists. */
	id(): string;
	head(): number;
	has(eid: string): boolean;
	/** Entries after `seq`, at most `limit`, and whether more follow. */
	after(seq: number, limit: number): { entries: LoggedEntry[]; more: boolean };
	/** Start the log with these entries (the server's graph as it is). */
	create(by: string, entries: GraphEntry[]): void;
	append(by: string, entries: GraphEntry[]): number;
}

export function serverGraphLog(syncDir: string): ServerGraphLog {
	const file = path.join(/* turbopackIgnore: true */ syncDir, "graph-log.jsonl");
	const idFile = path.join(/* turbopackIgnore: true */ syncDir, "graph-log-id");
	let cache: { stamp: string; entries: LoggedEntry[]; eids: Set<string> } | null = null;
	let knownId: { stamp: string; id: string } | null = null;
	function logId(): string {
		const stamp = stampOf(idFile);
		if (knownId && knownId.stamp === stamp) return knownId.id;
		let id = "";
		try { id = fs.readFileSync(/* turbopackIgnore: true */ idFile, "utf-8").trim(); } catch { /* none yet */ }
		knownId = { stamp, id };
		return id;
	}
	function nameLog(): void {
		fs.mkdirSync(/* turbopackIgnore: true */ syncDir, { recursive: true });
		writeFileAtomicSync(idFile, `gl_${randomBytes(8).toString("hex")}\n`, { allowInPlaceFallback: true });
		knownId = null;
	}
	function load(): { entries: LoggedEntry[]; eids: Set<string> } {
		const stamp = stampOf(file);
		if (!cache || cache.stamp !== stamp) {
			const entries = stamp === "-" ? [] : readLines<LoggedEntry>(file);
			cache = { stamp, entries, eids: new Set(entries.map((e) => e.eid)) };
		}
		return cache;
	}
	function write(by: string, entries: GraphEntry[], fresh: boolean): number {
		const log = load();
		let seq = log.entries.length > 0 ? log.entries[log.entries.length - 1]!.seq : 0;
		const added = entries.map((e) => ({ seq: ++seq, by, eid: e.eid, change: e.change }));
		fs.mkdirSync(/* turbopackIgnore: true */ syncDir, { recursive: true });
		if (fresh) writeFileAtomicSync(file, jsonl(added), { allowInPlaceFallback: true });
		else if (added.length > 0) fs.appendFileSync(/* turbopackIgnore: true */ file, jsonl(added), "utf-8");
		log.entries.push(...added);
		for (const e of added) log.eids.add(e.eid);
		cache = { stamp: stampOf(file), entries: log.entries, eids: log.eids };
		return seq;
	}
	return {
		exists: () => stampOf(file) !== "-",
		id() {
			if (stampOf(file) === "-") return "";
			if (!logId()) nameLog();
			return logId();
		},
		head() {
			const { entries } = load();
			return entries.length > 0 ? entries[entries.length - 1]!.seq : 0;
		},
		has: (eid) => load().eids.has(eid),
		after(seq, limit) {
			const { entries } = load();
			// seq numbers run 1, 2, 3 … with no gaps, so the place is the number.
			const start = Math.max(0, Math.min(seq, entries.length));
			return { entries: entries.slice(start, start + limit), more: start + limit < entries.length };
		},
		create(by, entries) { nameLog(); write(by, entries, true); },
		append: (by, entries) => write(by, entries, false),
	};
}

export interface DesktopGraphJournal {
	/** Has graph sync ever run on this desktop? */
	started(): boolean;
	cursor(): number;
	/** The name of the server log the cursor counts in; null before the first answer. */
	log(): string | null;
	setCursor(cursor: number, log?: string | null): void;
	outbox(): GraphEntry[];
	/** Is anything waiting to be sent? (A look at the file's size, no read.) */
	hasOutbox(): boolean;
	appendOutbox(entry: GraphEntry): void;
	writeOutbox(entries: GraphEntry[]): void;
	/** The ledgers as the server has them at the cursor; null when the outbox is empty. */
	base(): Ledgers | null;
	writeBase(ledgers: Ledgers): void;
	clearBase(): void;
}

export function desktopGraphJournal(syncDir: string): DesktopGraphJournal {
	const cursorFile = path.join(/* turbopackIgnore: true */ syncDir, "graph.json");
	const outboxFile = path.join(/* turbopackIgnore: true */ syncDir, "graph-outbox.jsonl");
	const baseDir = path.join(/* turbopackIgnore: true */ syncDir, "graph-base");
	const baseFile = (ledger: string) => path.join(/* turbopackIgnore: true */ baseDir, `${ledger}.jsonl`);
	function place(): { cursor: number; log: string | null } {
		try {
			const value = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ cursorFile, "utf-8")) as { cursor?: unknown; log?: unknown };
			return { cursor: typeof value.cursor === "number" ? value.cursor : 0, log: typeof value.log === "string" ? value.log : null };
		} catch {
			return { cursor: 0, log: null };
		}
	}
	return {
		started: () => stampOf(cursorFile) !== "-",
		cursor: () => place().cursor,
		log: () => place().log,
		setCursor(cursor, log) {
			fs.mkdirSync(/* turbopackIgnore: true */ syncDir, { recursive: true });
			const next = { cursor, log: log === undefined ? place().log : log };
			writeFileAtomicSync(cursorFile, `${JSON.stringify(next)}\n`, { allowInPlaceFallback: true });
		},
		outbox: () => readLines<GraphEntry>(outboxFile),
		hasOutbox() {
			try { return fs.statSync(/* turbopackIgnore: true */ outboxFile).size > 0; } catch { return false; }
		},
		appendOutbox(entry) {
			fs.mkdirSync(/* turbopackIgnore: true */ syncDir, { recursive: true });
			fs.appendFileSync(/* turbopackIgnore: true */ outboxFile, jsonl([entry]), "utf-8");
		},
		writeOutbox(entries) {
			fs.mkdirSync(/* turbopackIgnore: true */ syncDir, { recursive: true });
			writeFileAtomicSync(outboxFile, jsonl(entries), { allowInPlaceFallback: true });
		},
		base() {
			if (stampOf(baseFile("nodes")) === "-") return null;
			const out = {} as Record<string, unknown[]>;
			for (const ledger of LEDGERS) out[ledger] = readLines<unknown>(baseFile(ledger));
			return out as unknown as Ledgers;
		},
		writeBase(ledgers) {
			fs.mkdirSync(/* turbopackIgnore: true */ baseDir, { recursive: true });
			// "nodes" is written last: its presence is what says the snapshot is whole.
			for (const ledger of [...LEDGERS].reverse()) writeFileAtomicSync(baseFile(ledger), jsonl(ledgers[ledger] as unknown[]), { allowInPlaceFallback: true });
		},
		clearBase() {
			fs.rmSync(/* turbopackIgnore: true */ baseDir, { recursive: true, force: true });
		},
	};
}
