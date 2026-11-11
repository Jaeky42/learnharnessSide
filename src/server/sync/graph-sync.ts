/**
 * Cloud sync (Phase 5, docs/cloud-sync.md): the graph log in motion.
 *
 *   loggedGraphStore   the wrapper at the composition root: every change to
 *                      the four ledgers is written down as an entry BEFORE
 *                      it is made (so a crash can't leave a change the log
 *                      doesn't know about)
 *   graph authority    the server: numbers the entries, applies a desktop's
 *                      entries to its own graph, hands out what a desktop
 *                      hasn't seen
 *   graph desktop      one round: fetch what it hasn't seen, redo its own
 *                      unsent entries on top, send them. The server takes
 *                      them only if nothing new arrived in between;
 *                      otherwise the desktop fetches again.
 *
 * Both sides apply the same entries in the same order with the same code,
 * which is why their graphs end identical.
 *
 * Until graph sync has started on a device (no log file, no cursor file)
 * the wrapper records nothing and every call is the inner store's own.
 */

import type { GraphChain } from "../../core/contracts.ts";
import type { GraphStore } from "../../core/ports.ts";
import {
	applyChange,
	belongsOnlyTo,
	checkEntry,
	emptyLedgers,
	entry,
	isSimplification,
	LEDGERS,
	ledgersAsEntries,
	memoryGraphStore,
	readLedgers,
	rewriteAsChanges,
	type GraphChange,
	type GraphEntry,
	type Ledgers,
} from "../../core/sync/graph-log.ts";
import type { DesktopGraphJournal, LoggedEntry, ServerGraphLog } from "../../store/sync/graph-journal.ts";
import type { AuthorityReply } from "./authority.ts";
import type { SyncRequester } from "./desktop-sync.ts";

/** Where the wrapper writes a change down. */
export interface GraphRecorder {
	active(): boolean;
	record(change: GraphChange): void;
}

const PAGE = 2000;
/** One send carries at most this much; a first sync of a big graph goes in pieces. */
const SEND_ENTRIES = 1000;
const SEND_BYTES = 4 * 1024 * 1024;

// ─── The wrapper ─────────────────────────────────────────────────────────────

export interface LoggedGraph {
	store: GraphStore;
	/**
	 * Run a named deletion: it is logged once, as what was done, and the
	 * ledger writes it makes inside are not logged again.
	 */
	action<T>(change: GraphChange, run: () => T): T;
}

export function loggedGraphStore(inner: GraphStore, recorder: () => GraphRecorder): LoggedGraph {
	let inAction = 0;
	const note = (change: GraphChange): void => {
		if (inAction > 0) return;
		const r = recorder();
		if (r.active()) r.record(change);
	};
	const line = (ledger: "nodes" | "chains" | "coverage" | "checkpoints", value: unknown) => note({ kind: "line", ledger, line: value as Record<string, unknown> });
	const store: GraphStore = {
		appendNode(node) { line("nodes", node); inner.appendNode(node); },
		readNodes: () => inner.readNodes(),
		appendChain(chain) { line("chains", chain); inner.appendChain(chain); },
		readChains: () => inner.readChains(),
		appendCheckpoint(checkpoint) { line("checkpoints", checkpoint); inner.appendCheckpoint(checkpoint); },
		readCheckpoints: () => inner.readCheckpoints(),
		appendCoverage(row) { line("coverage", row); inner.appendCoverage(row); },
		readCoverage: () => inner.readCoverage(),
		upsertSource: (source) => inner.upsertSource(source),
		readSources: () => inner.readSources(),
		deleteSources: (ids) => inner.deleteSources(ids),
		appendSourceUsage: (id, usage) => inner.appendSourceUsage(id, usage),
		readPositions: () => inner.readPositions(),
		writePositions: (positions) => inner.writePositions(positions),
		rewriteLedgers(next) {
			if (inAction === 0 && recorder().active()) {
				const keys = Object.keys(next) as Array<keyof typeof next>;
				if (keys.length === 1 && next.chains && isSimplification(inner.readChains(), next.chains as GraphChain[])) {
					// The clean-up of redundant arguments after an extraction.
					note({ kind: "simplify-chains" });
				} else {
					// A rewrite this build can't name: its exact result is logged.
					const before = readLedgers(inner);
					for (const ledger of LEDGERS) {
						const after = next[ledger];
						if (after) for (const change of rewriteAsChanges(ledger, before[ledger] as unknown[], after as unknown[])) note(change);
					}
				}
			}
			inner.rewriteLedgers(next);
		},
	};
	return {
		store,
		action(change, run) {
			note(change);
			inAction++;
			try { return run(); } finally { inAction--; }
		},
	};
}

// ─── The server ──────────────────────────────────────────────────────────────

export interface GraphAuthority {
	recorder: GraphRecorder;
	/** `known` is the name of the log the desktop's place counts in, if it has one. */
	pull(after: unknown, known?: string | null): AuthorityReply;
	push(deviceId: string, body: unknown): AuthorityReply;
}

export function createGraphAuthority(deps: { store: GraphStore; log: ServerGraphLog; announce?: () => void }): GraphAuthority {
	const { store, log } = deps;
	/** The first time a desktop asks: the server's graph as it stands becomes the start of the log. */
	function started(): void {
		if (!log.exists()) log.create("cloud", ledgersAsEntries(readLedgers(store)));
	}
	return {
		recorder: {
			active: () => log.exists(),
			record(change) { log.append("cloud", [entry(change)]); },
		},
		pull(after, known) {
			if (typeof after !== "number" || !Number.isInteger(after) || after < 0) return { status: 400, body: { error: "The graph request is missing its place in the log." } };
			started();
			// A place in another log (this server was reset or restored): from the top.
			const from = after > log.head() || (!!known && known !== log.id()) ? 0 : after;
			const page = log.after(from, PAGE);
			return { status: 200, body: { log: log.id(), head: log.head(), from, entries: page.entries, more: page.more } };
		},
		push(deviceId, body) {
			const raw = (body ?? {}) as { after?: unknown; entries?: unknown; log?: unknown };
			if (typeof raw.after !== "number" || !Array.isArray(raw.entries)) return { status: 400, body: { error: "The graph changes didn't arrive whole." } };
			const entries: GraphEntry[] = [];
			for (const item of raw.entries) {
				const checked = checkEntry(item);
				if (!checked) return { status: 400, body: { error: "The graph changes didn't arrive whole." } };
				entries.push(checked);
			}
			started();
			// Only on top of everything the server has: otherwise fetch first.
			if (raw.after !== log.head() || raw.log !== log.id()) return { status: 409, body: { error: "The graph changed on the server in the meantime.", code: "behind", head: log.head() } };
			const fresh = entries.filter((e) => !log.has(e.eid));
			// One stretch with no awaits: apply to the server's own ledgers, then log.
			for (const e of fresh) applyChange(store, e.change);
			const head = log.append(deviceId, fresh);
			if (fresh.length > 0) deps.announce?.();
			return { status: 200, body: { head } };
		},
	};
}

// ─── A desktop ───────────────────────────────────────────────────────────────

export type GraphRound = { ok: true; fetched: number; sent: number } | { ok: false; reason: "not-paired" | "offline" | "paused" | "refused" | "busy" };

export interface GraphDesktop {
	recorder: GraphRecorder;
	round(): Promise<GraphRound>;
	/** A session was lost to a take-over: drop what only it taught and wasn't sent yet. */
	discardSession(chatId: string): void;
}

function copy(ledgers: Ledgers): Ledgers {
	return { nodes: [...ledgers.nodes], chains: [...ledgers.chains], coverage: [...ledgers.coverage], checkpoints: [...ledgers.checkpoints] };
}

export function createGraphDesktop(deps: { store: GraphStore; journal: DesktopGraphJournal; request: SyncRequester; announce?: () => void }): GraphDesktop {
	const { store, journal } = deps;
	let running: Promise<GraphRound> | null = null;

	/** Make the real ledgers equal `wanted`, touching only the ones that differ. */
	function settle(wanted: Ledgers): void {
		const now = readLedgers(store);
		const next: Partial<Ledgers> = {};
		for (const ledger of LEDGERS) {
			if (JSON.stringify(now[ledger]) !== JSON.stringify(wanted[ledger])) (next as Record<string, unknown>)[ledger] = wanted[ledger];
		}
		if (Object.keys(next).length > 0) store.rewriteLedgers(next);
	}

	/**
	 * Fetched entries arrive: the graph here becomes "the server's, then my
	 * own unsent entries on top". One stretch with no awaits.
	 */
	function absorb(remote: LoggedEntry[], head: number, known: string | null): void {
		const outbox = journal.outbox();
		const accepted = new Set(remote.map((e) => e.eid));
		// An entry of mine in what was fetched: the server took it, the answer got lost.
		const mine = outbox.filter((e) => !accepted.has(e.eid));
		if (outbox.length === 0) {
			for (const e of remote) applyChange(store, e.change);
		} else {
			const working = memoryGraphStore(journal.base() ?? emptyLedgers());
			for (const e of remote) applyChange(working, e.change);
			const base = copy(working.ledgers());
			for (const e of mine) applyChange(working, e.change);
			settle(working.ledgers());
			if (mine.length > 0) journal.writeBase(base); else journal.clearBase();
			journal.writeOutbox(mine);
		}
		journal.setCursor(head, known);
		if (remote.length > 0) deps.announce?.();
	}

	/** Everything here becomes "mine, not sent yet", on top of nothing. */
	function startOver(): void {
		journal.writeBase(emptyLedgers());
		journal.writeOutbox(ledgersAsEntries(readLedgers(store)));
		journal.setCursor(0, null);
	}

	/** The front of the outbox that fits in one send. */
	function piece(outbox: GraphEntry[]): GraphEntry[] {
		let bytes = 0;
		let count = 0;
		while (count < outbox.length && count < SEND_ENTRIES) {
			bytes += JSON.stringify(outbox[count]).length;
			if (count > 0 && bytes > SEND_BYTES) break;
			count++;
		}
		return outbox.slice(0, count);
	}

	async function round(): Promise<GraphRound> {
		// The first graph sync: combining the two graphs then needs no special case.
		if (!journal.started()) startOver();
		let fetched = 0;
		let sent = 0;
		let behind = 0;
		for (;;) {
			// 1. Fetch what the server has that this desktop hasn't seen.
			const remote: LoggedEntry[] = [];
			let from = journal.cursor();
			let known = journal.log();
			let head = from;
			for (;;) {
				const reply = await deps.request<{ log: string; head: number; from: number; entries: LoggedEntry[]; more: boolean }>(`/api/sync/graph?after=${from}${known ? `&log=${encodeURIComponent(known)}` : ""}`);
				if (!reply.ok) return { ok: false, reason: reply.reason };
				if (reply.body.from !== from || (known !== null && reply.body.log !== known)) {
					// The server's log started over (it was reset or restored): what is
					// here is combined with it afresh.
					startOver();
					remote.length = 0;
				}
				known = reply.body.log;
				remote.push(...reply.body.entries);
				head = reply.body.head;
				from = reply.body.from + reply.body.entries.length;
				if (!reply.body.more) break;
			}
			const place = remote.length > 0 ? remote[remote.length - 1]!.seq : head;
			if (remote.length > 0 || place !== journal.cursor() || known !== journal.log()) absorb(remote, place, known);
			fetched += remote.length;

			// 2. Send what is mine, a piece at a time.
			const outbox = journal.outbox();
			if (outbox.length === 0) { journal.clearBase(); return { ok: true, fetched, sent }; }
			const sending = piece(outbox);
			const reply = await deps.request<{ head: number }>("/api/sync/graph", { method: "POST", body: { after: journal.cursor(), log: journal.log(), entries: sending } });
			if (reply.ok) {
				// Entries may have been made here while the send was under way.
				const gone = new Set(sending.map((e) => e.eid));
				const rest = journal.outbox().filter((e) => !gone.has(e.eid));
				if (rest.length > 0) {
					const working = memoryGraphStore(journal.base() ?? emptyLedgers());
					for (const e of sending) applyChange(working, e.change);
					journal.writeBase(working.ledgers());
				} else journal.clearBase();
				journal.writeOutbox(rest);
				journal.setCursor(reply.body.head);
				sent += sending.length;
				// More pieces of what was waiting when this round began: go on.
				if (outbox.length > sending.length) continue;
				return { ok: true, fetched, sent };
			}
			if (reply.reason === "refused" && reply.code === "behind" && ++behind < 4) continue;
			return { ok: false, reason: reply.reason === "refused" && reply.code === "behind" ? "busy" : reply.reason };
		}
	}

	return {
		recorder: {
			active: () => journal.started(),
			record(change) {
				// The first unsent change since the last round: keep the ledgers as
				// the server has them, so later rounds can redo mine on top of theirs.
				if (!journal.hasOutbox()) journal.writeBase(readLedgers(store));
				journal.appendOutbox(entry(change));
			},
		},
		round() {
			if (running) return Promise.resolve({ ok: false, reason: "busy" } as GraphRound);
			running = round().finally(() => { running = null; });
			return running;
		},
		discardSession(chatId) {
			if (!journal.started()) return;
			const outbox = journal.outbox();
			const keep = outbox.filter((e) => !belongsOnlyTo(e.change, chatId));
			if (keep.length === outbox.length) return;
			const working = memoryGraphStore(journal.base() ?? emptyLedgers());
			for (const e of keep) applyChange(working, e.change);
			settle(working.ledgers());
			journal.writeOutbox(keep);
			if (keep.length === 0) journal.clearBase();
			deps.announce?.();
		},
	};
}
