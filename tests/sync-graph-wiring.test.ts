/**
 * Cloud sync Phase 5, slice 4: the graph log at the app's REAL entry points,
 * over the real ledger files. This process plays the cloud server.
 *
 * Pins: nothing is written for sync before a desktop first asks; that first
 * ask turns the server's graph as it stands into the start of the log; from
 * then on every ledger change made through the app is logged, and a session
 * or concept deleted through the app is logged as that deletion, once.
 *
 * LH_DATA_DIR and LH_AUTH_FILE are redirected BEFORE the first config import.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sync-graph-wiring-"));
process.env.LH_AUTH_FILE = path.join(TMP, "secrets", "auth.json");
process.env.LH_DATA_DIR = path.join(TMP, "data");
process.env.LH_SERVER_MODE = "1";

const { stores } = await import("../src/server/stores.ts");
const { deleteChatSession } = await import("../src/server/chats.ts");
const { deleteGraphNode } = await import("../src/server/graph.ts");
const { graphAuthority } = await import("../src/server/sync/graph-engine.ts");
const { simplifyChains } = await import("../src/core/graph.ts");
import type { GraphChain, GraphNode } from "../src/core/contracts.ts";
import type { LoggedEntry } from "../src/store/sync/graph-journal.ts";

after(() => {
	delete process.env.LH_SERVER_MODE;
	fs.rmSync(TMP, { recursive: true, force: true });
});

const SYNC_DIR = path.join(TMP, "data", "sync");
const node = (id: string, chatId: string): GraphNode => ({ id, name: id, statement: `${id} is so`, aliases: [], createdAt: "2026-11-01T10:00:00.000Z", provenance: [{ chatId, messageId: "" }] });
const chain = (id: string, premises: string[], conclusion: string, chatId: string): GraphChain => ({ id, premises, conclusion, createdAt: "2026-11-01T10:00:00.000Z", provenance: [{ chatId, messageId: "" }] });
const pulled = (after: number) => (graphAuthority().pull(after).body as { entries: LoggedEntry[]; head: number });

const circuits = stores.chatStore.createChat("Circuits");
const motors = stores.chatStore.createChat("Motors");

describe("the server's graph and the log", () => {
	it("before any desktop asks, the graph is written as ever and nothing else is", () => {
		stores.graphStore.appendNode(node("n_ohm", circuits.id));
		stores.graphStore.appendNode(node("n_kirchhoff", circuits.id));
		stores.graphStore.appendChain(chain("arg_1", ["n_ohm"], "n_kirchhoff", circuits.id));
		stores.graphStore.appendCoverage({ chatId: circuits.id, fp: "fp1", tokens: 5, foldedAt: "2026-11-01T10:00:00.000Z" });
		assert.equal(stores.graphStore.readNodes().length, 2);
		assert.equal(fs.existsSync(SYNC_DIR), false);
	});

	it("the first ask turns the graph as it stands into the start of the log", () => {
		const first = pulled(0);
		assert.equal(first.head, 4);
		assert.deepEqual(first.entries.map((e) => [e.seq, e.by, e.change.kind, e.change.kind === "line" ? e.change.ledger : ""]), [
			[1, "cloud", "line", "nodes"], [2, "cloud", "line", "nodes"], [3, "cloud", "line", "chains"], [4, "cloud", "line", "coverage"],
		]);
		assert.deepEqual(pulled(0).entries.map((e) => e.eid), first.entries.map((e) => e.eid), "asked again: the same log");
	});

	it("from then on, what the app writes is logged as it is written", () => {
		stores.graphStore.appendNode(node("n_torque", motors.id));
		stores.graphStore.appendNode({ ...node("n_ohm", motors.id), aliases: ["V = IR"] });
		const news = pulled(4);
		assert.deepEqual(news.entries.map((e) => (e.change as unknown as { line: { id: string } }).line.id), ["n_torque", "n_ohm"]);
		assert.equal(stores.graphStore.readNodes().length, 4);
	});

	it("the clean-up of redundant arguments is logged by name", () => {
		stores.graphStore.appendChain(chain("arg_wide", ["n_ohm", "n_torque"], "n_kirchhoff", motors.id));
		const kept = simplifyChains(stores.graphStore.readChains());
		assert.equal(kept.length, 1);
		stores.graphStore.rewriteLedgers({ chains: kept });
		assert.deepEqual(pulled(6).entries.map((e) => e.change.kind), ["line", "simplify-chains"]);
		assert.deepEqual(stores.graphStore.readChains().map((c) => c.id), ["arg_1"]);
	});

	it("a concept deleted in the app is one entry: the deletion", () => {
		const outcome = deleteGraphNode("n_torque");
		assert.equal(outcome.ok, true);
		const news = pulled(8);
		assert.deepEqual(news.entries.map((e) => e.change), [{ kind: "delete-node", id: "n_torque" }]);
	});

	it("a session deleted with its concepts is one entry, and Ohm's law (Motors taught it too) stays", async () => {
		const outcome = await deleteChatSession(circuits.id, "delete-nodes");
		assert.equal(outcome.ok, true);
		const news = pulled(9);
		assert.deepEqual(news.entries.map((e) => e.change), [{ kind: "delete-sources", ids: [circuits.id], mode: "delete-nodes" }]);
		assert.deepEqual([...new Set(stores.graphStore.readNodes().map((n) => n.id))], ["n_ohm"]);
		assert.equal(stores.chatStore.getChat(circuits.id), null);
	});

	it("a desktop's entries land in the real ledgers and in the log, once", () => {
		const head = pulled(0).head;
		const entry = { eid: `ge_${"a".repeat(18)}`, change: { kind: "line", ledger: "nodes", line: node("n_desk", "chat_desk") } };
		const log = (graphAuthority().pull(0).body as { log: string }).log;
		const push = () => graphAuthority().push("dev_aaaaaaaaaaaaaaaa", { after: pulled(0).head, log, entries: [entry] });
		assert.equal(push().status, 200);
		assert.equal(push().status, 200, "sent again after a lost answer");
		assert.equal(pulled(0).head, head + 1);
		assert.equal(stores.graphStore.readNodes().filter((n) => n.id === "n_desk").length, 1);
		assert.equal(graphAuthority().push("dev_aaaaaaaaaaaaaaaa", { after: 0, log, entries: [] }).status, 409, "not on top of everything: fetch first");
	});
});
