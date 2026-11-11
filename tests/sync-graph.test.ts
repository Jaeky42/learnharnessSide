/**
 * Cloud sync Phase 5, slice 4 (docs/cloud-sync.md): the graph log.
 *
 * Pins the owner's decisions: the server keeps one ordered log of graph
 * changes and every device replays it in that order; a deletion is logged
 * as what was done and repeated by the same code on each device ("repeat
 * the action"); a rewrite the engine can't name is logged as its exact
 * result; the first sync joins both graphs; a discarded session takes its
 * unsent knowledge with it; and nothing is recorded before sync has started.
 *
 * Each side's graph is held in memory here; the log files are real.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sync-graph-"));
process.env.LH_AUTH_FILE = path.join(TMP, "prod", "secrets", "auth.json");
process.env.LH_DATA_DIR = path.join(TMP, "prod", "data");

const log = await import("../src/core/sync/graph-log.ts");
const { simplifyChains } = await import("../src/core/graph.ts");
const { deleteSourcesTraces, deleteNodeTraces } = await import("../src/core/graph-deletion.ts");
const { serverGraphLog, desktopGraphJournal } = await import("../src/store/sync/graph-journal.ts");
const { createGraphAuthority, createGraphDesktop, loggedGraphStore } = await import("../src/server/sync/graph-sync.ts");
import type { SyncReply } from "../src/server/sync/client.ts";
import type { AuthorityReply } from "../src/server/sync/authority.ts";
import type { GraphChain, GraphNode } from "../src/core/contracts.ts";
import type { Ledgers } from "../src/core/sync/graph-log.ts";

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let worlds = 0;
let tick = 0;
const stamp = () => `2026-11-01T10:00:${String(tick++ % 60).padStart(2, "0")}.${String(tick).padStart(3, "0")}Z`;

const node = (id: string, chat: string, name = id): GraphNode => ({ id, name, statement: `${name} is so`, aliases: [`${name} (${chat})`], createdAt: stamp(), provenance: [{ chatId: chat, messageId: "" }] });
const chain = (id: string, premises: string[], conclusion: string, chat: string): GraphChain => ({ id, premises, conclusion, createdAt: stamp(), provenance: [{ chatId: chat, messageId: "" }] });
const cover = (chat: string, fp: string) => ({ chatId: chat, fp, tokens: 10, foldedAt: stamp() });

function world() {
	const root = path.join(TMP, `w${++worlds}`);
	const serverGraph = log.memoryGraphStore(log.emptyLedgers());
	const serverLog = serverGraphLog(path.join(root, "server", "sync"));
	const authority = createGraphAuthority({ store: serverGraph, log: serverLog });
	const server = loggedGraphStore(serverGraph, () => authority.recorder);
	const reply = <T>(result: AuthorityReply): SyncReply<T> => result.status === 200
		? { ok: true, body: result.body as T }
		: { ok: false, reason: "refused", status: result.status, code: typeof result.body.code === "string" ? result.body.code : null, error: String(result.body.error), body: result.body };

	function desktop(deviceId: string) {
		const graph = log.memoryGraphStore(log.emptyLedgers());
		const syncDir = path.join(root, deviceId, "sync");
		let online = true;
		const hooks: { beforePush?: () => void; afterPush?: () => void; loseAnswer?: boolean } = {};
		const sync = createGraphDesktop({
			store: graph,
			journal: desktopGraphJournal(syncDir),
			request: async <T>(pathname: string, init: { method?: string; body?: unknown } = {}) => {
				if (!online) return { ok: false, reason: "offline" } as SyncReply<T>;
				if (init.method === "POST") {
					hooks.beforePush?.();
					hooks.beforePush = undefined;
					const result = authority.push(deviceId, JSON.parse(JSON.stringify(init.body)) as unknown);
					hooks.afterPush?.();
					hooks.afterPush = undefined;
					if (hooks.loseAnswer) { hooks.loseAnswer = false; return { ok: false, reason: "offline" } as SyncReply<T>; }
					return reply<T>(JSON.parse(JSON.stringify(result)) as AuthorityReply);
				}
				const params = new URL(`http://x${pathname}`).searchParams;
				return reply<T>(JSON.parse(JSON.stringify(authority.pull(Number(params.get("after")), params.get("log")))) as AuthorityReply);
			},
		});
		const app = loggedGraphStore(graph, () => sync.recorder);
		return { graph, sync, app, syncDir, hooks, setOnline: (value: boolean) => { online = value; } };
	}
	return { root, serverGraph, serverLog, authority, server, desktop };
}

const ids = (ledgers: Ledgers) => ({ nodes: ledgers.nodes.map((n) => n.id), chains: ledgers.chains.map((c) => c.id), coverage: ledgers.coverage.map((c) => `${c.chatId}:${c.fp}`) });
const same = (a: { ledgers(): Ledgers }, b: { ledgers(): Ledgers }) => assert.deepEqual(a.ledgers(), b.ledgers());

describe("entries", () => {
	it("are checked before they are trusted", () => {
		const good = log.entry({ kind: "line", ledger: "nodes", line: node("n_1", "chat_a") as never });
		assert.deepEqual(log.checkEntry(JSON.parse(JSON.stringify(good))), good);
		assert.equal(log.checkEntry({ ...good, eid: "nope" }), null);
		assert.equal(log.checkEntry({ ...good, change: { kind: "line", ledger: "nodes", line: { id: "n_1" } } }), null, "a line the ledger would skip on read");
		assert.equal(log.checkEntry({ ...good, change: { kind: "line", ledger: "secrets", line: {} } }), null);
		assert.equal(log.checkEntry({ ...good, change: { kind: "line", ledger: "chains", line: { ...chain("arg_1", [], "n_1", "chat_a") } } }), null, "an argument needs a premise");
		assert.notEqual(log.checkEntry({ ...good, change: { kind: "delete-sources", ids: ["chat_a"], mode: "delete-nodes" } }), null);
		assert.equal(log.checkEntry({ ...good, change: { kind: "delete-sources", ids: ["chat_a"], mode: "everything" } }), null);
		assert.notEqual(log.checkEntry({ ...good, change: { kind: "delete-node", id: "n_1" } }), null);
		assert.notEqual(log.checkEntry({ ...good, change: { kind: "simplify-chains" } }), null);
		assert.equal(log.checkEntry({ ...good, change: { kind: "rewrite", ledger: "nodes", remove: ["short"], replace: [] } }), null);
		assert.equal(log.checkEntry({ ...good, change: { kind: "drop-everything" } }), null);
	});

	it("an unnamed rewrite is recorded as its exact result, and replaying that gives the same ledger", () => {
		const before = [node("n_1", "chat_a"), node("n_2", "chat_a"), node("n_3", "chat_b"), node("n_1", "chat_b")];
		const after = [before[0]!, { ...before[2]!, aliases: [] }, node("n_9", "chat_c")];
		const changes = log.rewriteAsChanges("nodes", before, after);
		assert.deepEqual(changes.map((c) => c.kind), ["rewrite", "line"]);
		const replay = log.memoryGraphStore({ ...log.emptyLedgers(), nodes: before });
		for (const change of changes) log.applyChange(replay, change);
		assert.deepEqual(replay.ledgers().nodes, after);
		assert.deepEqual(log.rewriteAsChanges("nodes", before, before), [], "nothing changed, nothing recorded");
	});

	it("knows which unsent entries belong to one session only", () => {
		const of = (line: unknown, ledger: "nodes" | "chains" | "coverage" | "checkpoints" = "nodes") => ({ kind: "line" as const, ledger, line: line as never });
		assert.equal(log.belongsOnlyTo(of(node("n_1", "chat_a")), "chat_a"), true);
		assert.equal(log.belongsOnlyTo(of(node("n_1", "chat_b")), "chat_a"), false);
		assert.equal(log.belongsOnlyTo(of({ ...node("n_1", "chat_a"), provenance: [{ chatId: "chat_a", messageId: "" }, { chatId: "chat_b", messageId: "" }] }), "chat_a"), false);
		assert.equal(log.belongsOnlyTo(of(cover("chat_a", "fp"), "coverage"), "chat_a"), true);
		assert.equal(log.belongsOnlyTo({ kind: "delete-node", id: "n_1" }, "chat_a"), false);
	});
});

describe("where graph sync hasn't started, nothing is recorded", () => {
	it("the store behaves as before and no file appears", () => {
		const w = world();
		const desk = w.desktop("dev_aaaaaaaaaaaaaaaa");
		desk.app.store.appendNode(node("n_1", "chat_a"));
		desk.app.action({ kind: "delete-node", id: "n_1" }, () => deleteNodeTraces(desk.app.store, "n_1"));
		w.server.store.appendNode(node("n_2", "chat_c"));
		assert.deepEqual(desk.graph.ledgers().nodes, []);
		assert.equal(w.serverGraph.ledgers().nodes.length, 1);
		assert.equal(fs.existsSync(path.join(w.root, "dev_aaaaaaaaaaaaaaaa")), false);
		assert.equal(fs.existsSync(path.join(w.root, "server")), false);
	});
});

describe("the first sync joins both graphs", () => {
	it("every line from both sides, in one order, on both", async () => {
		const w = world();
		const desk = w.desktop("dev_aaaaaaaaaaaaaaaa");
		desk.app.store.appendNode(node("n_d1", "chat_d"));
		desk.app.store.appendNode(node("n_d2", "chat_d"));
		desk.app.store.appendChain(chain("arg_d1", ["n_d1"], "n_d2", "chat_d"));
		desk.app.store.appendCoverage(cover("chat_d", "fp1"));
		w.server.store.appendNode(node("n_c1", "chat_c"));
		w.server.store.appendCoverage(cover("chat_c", "fp9"));
		assert.deepEqual(await desk.sync.round(), { ok: true, fetched: 2, sent: 4 });
		same(desk.graph, w.serverGraph);
		assert.deepEqual(ids(w.serverGraph.ledgers()), { nodes: ["n_c1", "n_d1", "n_d2"], chains: ["arg_d1"], coverage: ["chat_c:fp9", "chat_d:fp1"] });
		assert.equal(w.serverLog.head(), 6);
		assert.deepEqual(await desk.sync.round(), { ok: true, fetched: 0, sent: 0 });
	});
});

describe("one ordered log", () => {
	async function synced() {
		const w = world();
		const desk = w.desktop("dev_aaaaaaaaaaaaaaaa");
		w.server.store.appendNode(node("n_1", "chat_c"));
		w.server.store.appendNode(node("n_2", "chat_c"));
		w.server.store.appendNode(node("n_3", "chat_c"));
		await desk.sync.round();
		return { w, desk };
	}

	it("what one side learns reaches the other", async () => {
		const { w, desk } = await synced();
		desk.app.store.appendNode(node("n_a", "chat_d"));
		assert.deepEqual(await desk.sync.round(), { ok: true, fetched: 0, sent: 1 });
		w.server.store.appendNode(node("n_4", "chat_c"));
		assert.deepEqual(await desk.sync.round(), { ok: true, fetched: 1, sent: 0 });
		same(desk.graph, w.serverGraph);
		assert.deepEqual(ids(desk.graph.ledgers()).nodes, ["n_1", "n_2", "n_3", "n_a", "n_4"]);
	});

	it("the plan's picture: the server's 4 and 5, then the desktop's a and b, the same on both", async () => {
		const { w, desk } = await synced();
		desk.setOnline(false);
		desk.app.store.appendNode(node("n_a", "chat_d"));
		desk.app.store.appendNode(node("n_b", "chat_d"));
		assert.deepEqual(await desk.sync.round(), { ok: false, reason: "offline" });
		w.server.store.appendNode(node("n_4", "chat_c"));
		w.server.store.appendNode(node("n_5", "chat_c"));
		assert.deepEqual(ids(desk.graph.ledgers()).nodes, ["n_1", "n_2", "n_3", "n_a", "n_b"], "offline, the desktop has its own on top of what it knew");
		desk.setOnline(true);
		assert.deepEqual(await desk.sync.round(), { ok: true, fetched: 2, sent: 2 });
		assert.deepEqual(ids(desk.graph.ledgers()).nodes, ["n_1", "n_2", "n_3", "n_4", "n_5", "n_a", "n_b"]);
		same(desk.graph, w.serverGraph);
		assert.equal(w.serverLog.head(), 7);
	});

	it("something new arrives on the server between fetching and sending: the desktop fetches again", async () => {
		const { w, desk } = await synced();
		desk.app.store.appendNode(node("n_a", "chat_d"));
		desk.hooks.beforePush = () => w.server.store.appendNode(node("n_4", "chat_c"));
		assert.deepEqual(await desk.sync.round(), { ok: true, fetched: 1, sent: 1 });
		assert.deepEqual(ids(w.serverGraph.ledgers()).nodes, ["n_1", "n_2", "n_3", "n_4", "n_a"]);
		same(desk.graph, w.serverGraph);
	});

	it("the server took the entries but the answer was lost: nothing is applied twice", async () => {
		const { w, desk } = await synced();
		desk.app.store.appendNode(node("n_a", "chat_d"));
		desk.hooks.loseAnswer = true;
		assert.deepEqual(await desk.sync.round(), { ok: false, reason: "offline" });
		assert.equal(w.serverGraph.ledgers().nodes.length, 4, "the server has it");
		assert.deepEqual(await desk.sync.round(), { ok: true, fetched: 1, sent: 0 });
		same(desk.graph, w.serverGraph);
		assert.deepEqual(ids(desk.graph.ledgers()).nodes, ["n_1", "n_2", "n_3", "n_a"]);
	});

	it("an entry made while a send is under way is kept and goes next time", async () => {
		const { w, desk } = await synced();
		desk.app.store.appendNode(node("n_a", "chat_d"));
		desk.hooks.afterPush = () => desk.app.store.appendNode(node("n_b", "chat_d"));
		assert.deepEqual(await desk.sync.round(), { ok: true, fetched: 0, sent: 1 });
		assert.deepEqual(ids(desk.graph.ledgers()).nodes, ["n_1", "n_2", "n_3", "n_a", "n_b"]);
		w.server.store.appendNode(node("n_4", "chat_c"));
		assert.deepEqual(await desk.sync.round(), { ok: true, fetched: 1, sent: 1 });
		same(desk.graph, w.serverGraph);
		assert.deepEqual(ids(desk.graph.ledgers()).nodes, ["n_1", "n_2", "n_3", "n_a", "n_4", "n_b"]);
	});

	it("two desktops and the phone, all changing at once, end identical", async () => {
		const { w, desk } = await synced();
		const laptop = w.desktop("dev_bbbbbbbbbbbbbbbb");
		await laptop.sync.round();
		desk.app.store.appendNode(node("n_desk", "chat_d"));
		laptop.app.store.appendNode(node("n_lap", "chat_l"));
		w.server.store.appendNode(node("n_phone", "chat_c"));
		await desk.sync.round();
		await laptop.sync.round();
		await desk.sync.round();
		same(desk.graph, w.serverGraph);
		same(laptop.graph, w.serverGraph);
		assert.deepEqual(ids(w.serverGraph.ledgers()).nodes, ["n_1", "n_2", "n_3", "n_phone", "n_desk", "n_lap"]);
	});

	it("a place in the log from another life of the server: everything is combined afresh", async () => {
		const { w, desk } = await synced();
		// The server was reset: an empty graph and a new log.
		const w2 = world();
		for (const id of ["n_new", "n_new2", "n_new3", "n_new4", "n_new5"]) w2.server.store.appendNode(node(id, "chat_z"));
		const fresh = createGraphDesktop({
			store: desk.graph,
			journal: desktopGraphJournal(desk.syncDir),
			request: async <T>(pathname: string, init: { method?: string; body?: unknown } = {}) => {
				const result = init.method === "POST" ? w2.authority.push("dev_aaaaaaaaaaaaaaaa", JSON.parse(JSON.stringify(init.body)) as unknown)
					: w2.authority.pull(Number(new URL(`http://x${pathname}`).searchParams.get("after")), new URL(`http://x${pathname}`).searchParams.get("log"));
				return (result.status === 200 ? { ok: true, body: result.body } : { ok: false, reason: "refused", status: result.status, code: result.body.code ?? null, error: "", body: result.body }) as SyncReply<T>;
			},
		});
		assert.equal((await fresh.round()).ok, true);
		assert.deepEqual(ids(w2.serverGraph.ledgers()).nodes, ["n_new", "n_new2", "n_new3", "n_new4", "n_new5", "n_1", "n_2", "n_3"], "a longer log than the desktop's place: still told apart, by the log's name");
		assert.deepEqual(desk.graph.ledgers(), w2.serverGraph.ledgers());
		void w;
	});
});

describe("a big graph goes up in pieces", () => {
	it("a first sync of 2,500 concepts: three sends, one order, nothing twice", async () => {
		const w = world();
		const desk = w.desktop("dev_aaaaaaaaaaaaaaaa");
		for (let i = 0; i < 2500; i++) desk.graph.appendNode(node(`n_${i}`, "chat_d"));
		w.server.store.appendNode(node("n_c", "chat_c"));
		assert.deepEqual(await desk.sync.round(), { ok: true, fetched: 1, sent: 2500 });
		same(desk.graph, w.serverGraph);
		assert.equal(w.serverGraph.ledgers().nodes.length, 2501);
		assert.equal(w.serverLog.head(), 2501);
		const laptop = w.desktop("dev_bbbbbbbbbbbbbbbb");
		assert.deepEqual(await laptop.sync.round(), { ok: true, fetched: 2501, sent: 0 }, "and comes down in pages");
		same(laptop.graph, w.serverGraph);
	});
});

describe("deletions are repeated as what was done", () => {
	/** Ohm's law was taught by Circuits; Kirchhoff only by Circuits. */
	async function circuits() {
		const w = world();
		const desk = w.desktop("dev_aaaaaaaaaaaaaaaa");
		desk.app.store.appendNode(node("n_ohm", "chat_circuits", "Ohm's law"));
		desk.app.store.appendNode(node("n_kirchhoff", "chat_circuits", "Kirchhoff's law"));
		desk.app.store.appendChain(chain("arg_1", ["n_ohm"], "n_kirchhoff", "chat_circuits"));
		desk.app.store.appendCoverage(cover("chat_circuits", "fp1"));
		await desk.sync.round();
		return { w, desk };
	}
	const deleteSession = (app: { store: Parameters<typeof deleteSourcesTraces>[0]; action: <T>(c: never, run: () => T) => T }, chatId: string) =>
		app.action({ kind: "delete-sources", ids: [chatId], mode: "delete-nodes" } as never, () => deleteSourcesTraces(app.store, new Set([chatId]), "delete-nodes"));

	it("a session deleted with its concepts is gone on the other side too", async () => {
		const { w, desk } = await circuits();
		deleteSession(desk.app, "chat_circuits");
		assert.deepEqual(ids(desk.graph.ledgers()), { nodes: [], chains: [], coverage: [] });
		assert.deepEqual(await desk.sync.round(), { ok: true, fetched: 0, sent: 1 }, "one entry: the deletion, not the lines it removed");
		assert.deepEqual(ids(w.serverGraph.ledgers()), { nodes: [], chains: [], coverage: [] });
		assert.deepEqual(w.serverLog.after(w.serverLog.head() - 1, 5).entries[0]!.change, { kind: "delete-sources", ids: ["chat_circuits"], mode: "delete-nodes" });
	});

	it("the owner's example: Motors taught Ohm's law on the phone meanwhile, so it stays, intact", async () => {
		const { w, desk } = await circuits();
		desk.setOnline(false);
		deleteSession(desk.app, "chat_circuits");
		assert.deepEqual(ids(desk.graph.ledgers()).nodes, [], "on the desktop, Ohm's law is gone for now");
		// On the phone, another session re-teaches Ohm's law: a link line to the same node.
		w.server.store.appendNode({ ...node("n_ohm", "chat_motors", "Ohm (as Motors put it)") });
		w.server.store.appendCoverage(cover("chat_motors", "fp7"));
		desk.setOnline(true);
		assert.deepEqual(await desk.sync.round(), { ok: true, fetched: 2, sent: 1 });
		same(desk.graph, w.serverGraph);
		const nodes = w.serverGraph.ledgers().nodes;
		assert.deepEqual(nodes.map((n) => n.id), ["n_ohm", "n_ohm"], "Kirchhoff, which only Circuits taught, is gone");
		assert.equal(nodes[0]!.name, "Ohm's law", "name and statement intact");
		assert.equal(nodes[0]!.statement, "Ohm's law is so");
		assert.deepEqual(nodes[0]!.aliases, [], "minus what only Circuits said");
		assert.deepEqual(nodes[0]!.provenance, []);
		assert.deepEqual(nodes[1]!.provenance, [{ chatId: "chat_motors", messageId: "" }]);
		assert.deepEqual(ids(w.serverGraph.ledgers()), { nodes: ["n_ohm", "n_ohm"], chains: [], coverage: ["chat_motors:fp7"] });
	});

	it("a single concept deleted on the phone is deleted on the desktop, with the arguments that used it", async () => {
		const { w, desk } = await circuits();
		w.server.action({ kind: "delete-node", id: "n_ohm" }, () => deleteNodeTraces(w.server.store, "n_ohm"));
		assert.deepEqual(await desk.sync.round(), { ok: true, fetched: 1, sent: 0 });
		assert.deepEqual(ids(desk.graph.ledgers()), { nodes: ["n_kirchhoff"], chains: [], coverage: ["chat_circuits:fp1"] });
		same(desk.graph, w.serverGraph);
	});

	it("the clean-up of redundant arguments after an extraction is recognised and repeated", async () => {
		const { w, desk } = await circuits();
		desk.app.store.appendNode(node("n_x", "chat_circuits"));
		// A leaner derivation of the same conclusion makes the wider one redundant.
		desk.app.store.appendChain(chain("arg_wide", ["n_ohm", "n_x"], "n_kirchhoff", "chat_circuits"));
		const all = desk.app.store.readChains();
		const kept = simplifyChains(all);
		assert.equal(kept.length, 1);
		desk.app.store.rewriteLedgers({ chains: kept });
		await desk.sync.round();
		same(desk.graph, w.serverGraph);
		const kinds = w.serverLog.after(4, 10).entries.map((e) => e.change.kind);
		assert.deepEqual(kinds, ["line", "line", "simplify-chains"]);
	});

	it("a rewrite the engine can't name travels as its exact result", async () => {
		const { w, desk } = await circuits();
		const nodes = desk.app.store.readNodes();
		desk.app.store.rewriteLedgers({ nodes: [{ ...nodes[0]!, aliases: ["edited by a future feature"] }] });
		await desk.sync.round();
		same(desk.graph, w.serverGraph);
		assert.equal(w.serverLog.after(w.serverLog.head() - 1, 5).entries[0]!.change.kind, "rewrite");
		assert.deepEqual(w.serverGraph.ledgers().nodes.map((n) => n.aliases), [["edited by a future feature"]]);
	});

	it("writes made inside a named deletion are not logged a second time", async () => {
		const { w, desk } = await circuits();
		const before = w.serverLog.head();
		deleteSession(desk.app, "chat_circuits");
		await desk.sync.round();
		assert.equal(w.serverLog.head(), before + 1);
	});
});

describe("a session lost to a take-over takes its unsent knowledge with it", () => {
	it("only that session's unsent entries go; everything else stays and is sent", async () => {
		const w = world();
		const desk = w.desktop("dev_aaaaaaaaaaaaaaaa");
		desk.app.store.appendNode(node("n_sent", "chat_lost"));
		await desk.sync.round();
		desk.setOnline(false);
		desk.app.store.appendNode(node("n_unsent", "chat_lost"));
		desk.app.store.appendCoverage(cover("chat_lost", "fp2"));
		desk.app.store.appendNode(node("n_other", "chat_kept"));
		desk.sync.discardSession("chat_lost");
		assert.deepEqual(ids(desk.graph.ledgers()), { nodes: ["n_sent", "n_other"], chains: [], coverage: [] });
		desk.setOnline(true);
		assert.deepEqual(await desk.sync.round(), { ok: true, fetched: 0, sent: 1 });
		same(desk.graph, w.serverGraph);
		desk.sync.discardSession("chat_lost");
		same(desk.graph, w.serverGraph);
	});
});
