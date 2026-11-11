/**
 * Cloud sync (Phase 5, docs/cloud-sync.md): the graph log, the pure part.
 *
 * Every change to the four graph ledgers is an ENTRY. The server keeps one
 * ordered log of entries and every device applies them in that order, so
 * all graphs end identical. An entry is either
 *
 *   a line        one record appended to a ledger (a concept, an argument,
 *                 a coverage mark, a checkpoint), or
 *   an action     what was done, repeated on each device by the same code
 *                 that did it the first time (owner's decision: "repeat the
 *                 action"): delete sources' traces, delete one node or
 *                 argument, or the clean-up of redundant arguments, or
 *   a rewrite     the exact result of a change this build doesn't recognise
 *                 (which lines went, which changed), so nothing is skipped.
 *
 * Replaying an action needs both sides to run the same deletion rules.
 * That is one of the things the sync protocol version guards.
 */

import { createHash, randomBytes } from "node:crypto";
import type { CoverageEntry, GraphChain, GraphNode, SessionCheckpoint } from "../contracts.ts";
import { simplifyChains } from "../graph.ts";
import { deleteNodeTraces, deleteSourcesTraces, type ChatDeleteMode } from "../graph-deletion.ts";
import type { GraphStore } from "../ports.ts";

export const LEDGERS = ["nodes", "chains", "coverage", "checkpoints"] as const;
export type Ledger = (typeof LEDGERS)[number];

export interface Ledgers {
	nodes: GraphNode[];
	chains: GraphChain[];
	coverage: CoverageEntry[];
	checkpoints: SessionCheckpoint[];
}

export type GraphChange =
	| { kind: "line"; ledger: Ledger; line: Record<string, unknown> }
	| { kind: "delete-sources"; ids: string[]; mode: ChatDeleteMode }
	| { kind: "delete-node"; id: string }
	| { kind: "simplify-chains" }
	| { kind: "rewrite"; ledger: Ledger; remove: string[]; replace: Array<{ hash: string; line: Record<string, unknown> }> };

/** One entry: a change plus an id that is the same wherever the entry travels. */
export interface GraphEntry {
	eid: string;
	change: GraphChange;
}

export function newEntryId(): string {
	return `ge_${randomBytes(9).toString("hex")}`;
}

export function entry(change: GraphChange): GraphEntry {
	return { eid: newEntryId(), change };
}

export function lineHash(line: unknown): string {
	return createHash("sha256").update(JSON.stringify(line), "utf8").digest("hex");
}

const isLedger = (value: unknown): value is Ledger => typeof value === "string" && (LEDGERS as readonly string[]).includes(value);
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isHash = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

const isStr = (value: unknown): value is string => typeof value === "string";
const isPoints = (value: unknown): boolean => Array.isArray(value) && value.every((p) => isObject(p) && isStr(p.chatId) && isStr(p.messageId));

/** The same shapes the ledger files accept on read (src/store/graph.ts): a line that
 *  would be skipped there must never enter the log, or replays would disagree. */
function isLedgerLine(ledger: Ledger, line: unknown): line is Record<string, unknown> {
	if (!isObject(line)) return false;
	if (ledger === "nodes") {
		return isStr(line.id) && isStr(line.name) && isStr(line.statement) && Array.isArray(line.aliases) && line.aliases.every(isStr) && isStr(line.createdAt) && isPoints(line.provenance);
	}
	if (ledger === "chains") {
		return isStr(line.id) && Array.isArray(line.premises) && line.premises.length > 0 && line.premises.every(isStr) && isStr(line.conclusion) && isPoints(line.provenance) && isStr(line.createdAt);
	}
	if (ledger === "coverage") return isStr(line.chatId) && isStr(line.fp) && typeof line.tokens === "number" && isStr(line.foldedAt);
	return isStr(line.chatId) && isStr(line.foldedAt);
}

/** An entry from the other side, checked before it is applied or stored. */
export function checkEntry(value: unknown): GraphEntry | null {
	if (!isObject(value) || typeof value.eid !== "string" || !/^ge_[0-9a-f]{18}$/.test(value.eid) || !isObject(value.change)) return null;
	const c = value.change;
	const ok =
		(c.kind === "line" && isLedger(c.ledger) && isLedgerLine(c.ledger, c.line)) ||
		(c.kind === "delete-sources" && Array.isArray(c.ids) && c.ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 200) && (c.mode === "preserve-graph" || c.mode === "delete-nodes")) ||
		(c.kind === "delete-node" && typeof c.id === "string" && c.id.length > 0 && c.id.length <= 200) ||
		c.kind === "simplify-chains" ||
		(c.kind === "rewrite" && isLedger(c.ledger) && Array.isArray(c.remove) && c.remove.every(isHash) &&
			Array.isArray(c.replace) && c.replace.every((r) => isObject(r) && isHash(r.hash) && isLedgerLine(c.ledger as Ledger, r.line)));
	return ok ? { eid: value.eid, change: c as unknown as GraphChange } : null;
}

// ─── Applying entries ────────────────────────────────────────────────────────

const READERS = {
	nodes: (store: GraphStore) => store.readNodes(),
	chains: (store: GraphStore) => store.readChains(),
	coverage: (store: GraphStore) => store.readCoverage(),
	checkpoints: (store: GraphStore) => store.readCheckpoints(),
} as const;

/** Apply one change to a graph store: the real one, or one held in memory. */
export function applyChange(store: GraphStore, change: GraphChange): void {
	switch (change.kind) {
		case "line":
			if (change.ledger === "nodes") store.appendNode(change.line as unknown as GraphNode);
			else if (change.ledger === "chains") store.appendChain(change.line as unknown as GraphChain);
			else if (change.ledger === "coverage") store.appendCoverage(change.line as unknown as CoverageEntry);
			else store.appendCheckpoint(change.line as unknown as SessionCheckpoint);
			return;
		case "delete-sources":
			deleteSourcesTraces(store, new Set(change.ids), change.mode);
			return;
		case "delete-node":
			deleteNodeTraces(store, change.id);
			return;
		case "simplify-chains": {
			const all = store.readChains();
			const kept = simplifyChains(all);
			if (kept.length !== all.length) store.rewriteLedgers({ chains: kept });
			return;
		}
		case "rewrite": {
			const gone = new Set(change.remove);
			const swap = new Map(change.replace.map((r) => [r.hash, r.line]));
			const before = READERS[change.ledger](store) as unknown[];
			const after: unknown[] = [];
			let changed = false;
			for (const line of before) {
				const hash = lineHash(line);
				if (gone.has(hash)) { changed = true; continue; }
				const replacement = swap.get(hash);
				if (replacement) { changed = true; after.push(replacement); } else after.push(line);
			}
			if (changed) store.rewriteLedgers({ [change.ledger]: after } as Parameters<GraphStore["rewriteLedgers"]>[0]);
			return;
		}
	}
}

/** The four ledgers of a store, as they are now. */
export function readLedgers(store: GraphStore): Ledgers {
	return { nodes: store.readNodes(), chains: store.readChains(), coverage: store.readCoverage(), checkpoints: store.readCheckpoints() };
}

export function emptyLedgers(): Ledgers {
	return { nodes: [], chains: [], coverage: [], checkpoints: [] };
}

/**
 * A graph store held in memory, for working out "the server's entries, then
 * mine on top" without touching the real ledgers. Positions and sources
 * aren't part of the log (they sync as maps), so here they are empty.
 */
export function memoryGraphStore(initial: Ledgers): GraphStore & { ledgers(): Ledgers } {
	const state: Ledgers = { nodes: [...initial.nodes], chains: [...initial.chains], coverage: [...initial.coverage], checkpoints: [...initial.checkpoints] };
	return {
		ledgers: () => state,
		appendNode: (node) => { state.nodes.push(node); },
		readNodes: () => [...state.nodes],
		appendChain: (chain) => { state.chains.push(chain); },
		readChains: () => [...state.chains],
		appendCheckpoint: (checkpoint) => { state.checkpoints.push(checkpoint); },
		readCheckpoints: () => [...state.checkpoints],
		appendCoverage: (row) => { state.coverage.push(row); },
		readCoverage: () => [...state.coverage],
		upsertSource: () => {},
		readSources: () => [],
		deleteSources: () => 0,
		appendSourceUsage: () => {},
		readPositions: () => ({}),
		writePositions: () => {},
		rewriteLedgers(next) {
			if (next.nodes) state.nodes = [...next.nodes];
			if (next.chains) state.chains = [...next.chains];
			if (next.coverage) state.coverage = [...next.coverage];
			if (next.checkpoints) state.checkpoints = [...next.checkpoints];
		},
	};
}

/** The entries that rebuild a set of ledgers from nothing: every line, in order. */
export function ledgersAsEntries(ledgers: Ledgers): GraphEntry[] {
	const out: GraphEntry[] = [];
	for (const ledger of LEDGERS) {
		for (const line of ledgers[ledger] as unknown[]) out.push(entry({ kind: "line", ledger, line: line as Record<string, unknown> }));
	}
	return out;
}

export function ledgersEqual(a: Ledgers, b: Ledgers): boolean {
	return LEDGERS.every((ledger) => a[ledger].length === b[ledger].length && JSON.stringify(a[ledger]) === JSON.stringify(b[ledger]));
}

// ─── Recognising a rewrite ───────────────────────────────────────────────────

/** What ties two versions of one line together when its content changed. */
function identity(ledger: Ledger, line: unknown): string {
	const l = line as Record<string, unknown>;
	if (ledger === "nodes" || ledger === "chains") return String(l.id);
	if (ledger === "coverage") return `${String(l.chatId)}\0${String(l.fp)}`;
	return `${String(l.chatId)}\0${String(l.foldedAt)}`;
}

/**
 * The exact result of replacing a ledger's `before` with `after`: which
 * lines went and which changed, plus any lines that are simply new (they
 * follow as ordinary line entries). The fallback for a rewrite this build
 * can't name.
 */
export function rewriteAsChanges(ledger: Ledger, before: unknown[], after: unknown[]): GraphChange[] {
	const afterByHash = new Map<string, number>();
	for (const line of after) { const h = lineHash(line); afterByHash.set(h, (afterByHash.get(h) ?? 0) + 1); }
	// Changed lines are matched to what replaced them by identity, in order.
	const candidates = new Map<string, Array<Record<string, unknown>>>();
	const beforeHashes = new Map<string, number>();
	for (const line of before) { const h = lineHash(line); beforeHashes.set(h, (beforeHashes.get(h) ?? 0) + 1); }
	const fresh: Array<Record<string, unknown>> = [];
	for (const line of after) {
		const h = lineHash(line);
		const left = beforeHashes.get(h) ?? 0;
		if (left > 0) { beforeHashes.set(h, left - 1); continue; }
		const key = identity(ledger, line);
		const list = candidates.get(key);
		if (list) list.push(line as Record<string, unknown>); else candidates.set(key, [line as Record<string, unknown>]);
	}
	const remove: string[] = [];
	const replace: Array<{ hash: string; line: Record<string, unknown> }> = [];
	for (const line of before) {
		const h = lineHash(line);
		const kept = afterByHash.get(h) ?? 0;
		if (kept > 0) { afterByHash.set(h, kept - 1); continue; }
		const next = candidates.get(identity(ledger, line))?.shift();
		if (next) replace.push({ hash: h, line: next }); else remove.push(h);
	}
	for (const list of candidates.values()) fresh.push(...list);
	const changes: GraphChange[] = [];
	if (remove.length > 0 || replace.length > 0) changes.push({ kind: "rewrite", ledger, remove, replace });
	for (const line of fresh) changes.push({ kind: "line", ledger, line });
	return changes;
}

/** Is this rewrite of the chains ledger exactly the redundant-argument clean-up? */
export function isSimplification(before: GraphChain[], after: GraphChain[]): boolean {
	const expected = simplifyChains(before);
	return expected.length === after.length && JSON.stringify(expected) === JSON.stringify(after);
}

// ─── A discarded session's unsent knowledge ──────────────────────────────────

/**
 * Entries that carry only what one session taught, for a desktop that lost
 * that session with knowledge it hadn't sent: those entries are dropped with
 * the turns (the new holder extracts again where needed).
 */
export function belongsOnlyTo(change: GraphChange, chatId: string): boolean {
	if (change.kind !== "line") return false;
	const line = change.line as { chatId?: unknown; provenance?: unknown };
	if (change.ledger === "coverage" || change.ledger === "checkpoints") return line.chatId === chatId;
	const points = Array.isArray(line.provenance) ? line.provenance as Array<{ chatId?: unknown }> : [];
	return points.length > 0 && points.every((p) => p.chatId === chatId);
}
