/**
 * Cloud sync and upstream 0.6.0's plugin system: the read-only rule for a
 * session another device holds (owner's decision: what would change the
 * session waits for Take over; plugin question and problem boxes, plugin
 * top-bar actions and the highlight toolbar are refused or greyed).
 *
 * The server side, at the real entry points. This process plays a paired
 * DESKTOP whose sync state says one session is held by the cloud. Plugins
 * reach a session's files only through native routes (layer 1, proxy.ts),
 * handleChatInput (layer 2) and the guarded stores (layer 3); these tests
 * pin each, plus the one plugin write reached from a READ (the question
 * compatibility reconcile on GET /api/chats/<id>).
 *
 * LH_DATA_DIR and LH_AUTH_FILE are redirected BEFORE the first config import.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { Type } from "typebox";
import type { ChatStore } from "../src/core/ports.ts";
import type { PluginTaskOutcome, PluginTaskRecord, PluginWorkerService } from "../src/core/plugin-workers.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sync-plugins-gate-"));
process.env.LH_AUTH_FILE = path.join(TMP, "secrets", "auth.json");
process.env.LH_DATA_DIR = path.join(TMP, "data");

const { stores } = await import("../src/server/stores.ts");
const { handleChatInput } = await import("../src/server/chat-handler.ts");
const { reconcilePluginQuestionCompatibility } = await import("../src/server/plugin-questions.ts");
const { createPluginBackgroundTool } = await import("../src/server/plugin-background-tools.ts");
const { subscribe } = await import("../src/core/events.ts");
const engine = await import("../src/server/sync/engine.ts");
const { writeCloudPairing } = await import("../src/store/sync/pairing.ts");
const { proxy } = await import("../proxy.ts");
const { NextRequest } = await import("next/server");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const DEVICE = "dev_aaaaaaaaaaaaaaaa";
const SERVER = "https://learn.example.com";

const mine = stores.chatStore.createChat("Mine");
const held = stores.chatStore.createChat("Held by the cloud", "practice");
// Starts as this desktop's own; the cloud takes it over mid-test.
const moving = stores.chatStore.createChat("Taken over while a plugin worker runs");
stores.chatStore.saveMessages(held.id, [{ role: "user", content: "from the phone", timestamp: 1 } as never]);
const chatFile = (id: string) => path.join(TMP, "data", "chats", `${id}.json`);
const heldBytes = () => fs.readFileSync(chatFile(held.id), "utf-8");
const before = heldBytes();

function record(sessions: Record<string, boolean>): void {
	writeCloudPairing({ version: 1, deviceId: DEVICE, name: "Office PC", server: SERVER, key: "k".repeat(43), pairedAt: 1 });
	fs.mkdirSync(path.join(TMP, "data", "sync"), { recursive: true });
	fs.writeFileSync(path.join(TMP, "data", "sync", "desktop.json"), JSON.stringify({
		version: 1, server: SERVER, deviceId: DEVICE, startedAt: 1, backup: null, cursor: 5,
		sessions: Object.fromEntries(Object.entries(sessions).map(([id, own]) => [id, own
			? { mine: true, holder: DEVICE, holderName: "Office PC", serverVersion: 1, stamp: null, digest: null }
			: { mine: false, holder: "cloud", holderName: null, serverVersion: 3, stamp: null, digest: null }])),
	}));
}

const call = (method: string, pathname: string) => proxy(new NextRequest(`http://localhost${pathname}`, { method }));
async function quietly<T>(run: () => Promise<T> | T): Promise<T> {
	const warn = console.warn;
	console.warn = () => {};
	try { return await run(); } finally { console.warn = warn; }
}

describe("a plugin's way into a session the cloud holds", () => {
	it("the session is known as held", () => {
		record({ [mine.id]: true, [held.id]: false, [moving.id]: true });
		assert.equal(engine.holdsSession(held.id), false);
		assert.equal(engine.holdsSession(mine.id), true);
		assert.equal(engine.holdsSession(moving.id), true);
	});

	it("a plugin question answer and a plugin problem submission are refused before anything runs", async () => {
		for (const input of [
			{ type: "plugin-question-answer", questionId: "q_1", occurrence: { messageId: "m", contentIndex: 0, toolCallId: "t", toolName: "plugin_code" }, answer: "42" },
			{ type: "plugin-problem-submission", problemId: "p_1", occurrence: { messageId: "m", contentIndex: 0, toolCallId: "t", toolName: "plugin_draw" }, submission: { strokes: [] } },
		]) {
			const response = await handleChatInput(held.id, input as never);
			assert.equal(response.status, 409, input.type);
			assert.equal(((await response.json()) as { code: string }).code, "session_held_elsewhere");
		}
		assert.equal(heldBytes(), before);
	});

	it("dismissing a plugin question, steering and a side question are refused at the door", async () => {
		for (const suffix of ["/dismiss", "/steer", "/side-chats"]) {
			const response = call("POST", `/api/chats/${held.id}${suffix}`);
			assert.equal(response.status, 409, suffix);
			assert.equal(((await response.json()) as { code: string }).code, "session_held_elsewhere");
		}
	});

	it("a plugin's own operations aren't session writes: they pass the door (plugin data, per device)", () => {
		assert.notEqual(call("POST", "/api/plugins/drawing-pad/call").status, 409);
		assert.notEqual(call("POST", "/api/plugins/flashcards/documents/markdown").status, 409);
	});

	it("the question compatibility reconcile (run by GET /api/chats/<id>) leaves a held session alone", async () => {
		const touched: string[] = [];
		const events: string[] = [];
		const spy = new Proxy({} as ChatStore, {
			get: (_target, name: string) => (...args: unknown[]) => {
				touched.push(name);
				return name === "getChat" ? stores.chatStore.getChat(args[0] as string) : undefined;
			},
		});
		const off = subscribe((event) => { if (event.type === "record-changed") events.push(event.chatId); });
		try {
			await reconcilePluginQuestionCompatibility(spy, held.id);
			// No read, no write and no record-changed: the open page's reload of
			// that event would land here again, a loop with nothing saved.
			assert.deepEqual(touched, []);
			assert.deepEqual(events, []);
			// A session this desktop holds is still reconciled (nothing pending
			// here, so it only reads).
			await reconcilePluginQuestionCompatibility(spy, mine.id);
			assert.deepEqual(touched, ["getChat"]);
		} finally { off(); }
		assert.equal(heldBytes(), before);
	});

	it("a plugin background worker whose session moved away writes nothing and delivers nothing", async () => {
		let task: PluginTaskRecord | undefined;
		const listeners = new Set<(snapshot: PluginTaskRecord) => void>();
		const waiters = new Set<(outcome: PluginTaskOutcome) => void>();
		const workers: PluginWorkerService = {
			register: () => () => {},
			start(definitionId, options) {
				task = { ...options, definitionId, version: 1, id: "task_1", status: "running", createdAt: "now", updatedAt: "now", messages: [], turns: 0 };
				return structuredClone(task);
			},
			list: () => task ? [structuredClone(task)] : [],
			get: () => structuredClone(task!),
			subscribe(_id, listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
			wait: () => new Promise((resolve) => { waiters.add(resolve); }),
			cancel() {},
			dispose: async () => {},
		};
		const deliveries: unknown[] = [];
		const tool = createPluginBackgroundTool({
			pluginId: "fixture", context: { chatId: moving.id, agent: "teacher" }, workers, signal: new AbortController().signal,
			isActive: () => true, jobStore: stores.jobStore,
			deliver: async (steer) => { deliveries.push(steer); },
			registerAbort: () => {}, unregisterAbort: () => {},
			definition: {
				name: "fixture_research", label: "Research", description: "Research in the background.",
				parameters: Type.Object({ query: Type.String() }), workerId: "research",
				prepare: (input) => ({ input, prompt: "Research.", model: { provider: "fixture", id: "model" }, maxTurns: 1 }),
				format: (outcome) => ({ text: `Done: ${JSON.stringify(outcome)}` }),
			},
		});
		const ack = await tool.execute("call_1", { query: "ohm" }, undefined, undefined);
		const jobId = (ack.details as { jobId: string }).jobId;
		const jobFile = path.join(TMP, "data", "jobs", `${jobId}.json`);
		const started = fs.readFileSync(jobFile, "utf-8");
		assert.equal(JSON.parse(started).status, "running");

		// The cloud takes the session over; then the worker finishes here.
		record({ [mine.id]: true, [held.id]: false, [moving.id]: false });
		assert.equal(engine.holdsSession(moving.id), false);
		await quietly(async () => {
			task = { ...task!, status: "succeeded", result: { answer: "V = IR" } };
			for (const listener of listeners) listener(structuredClone(task));
			for (const resolve of waiters) resolve({ id: task.id, status: "succeeded", result: task.result });
			for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
		});
		// The job file still travels as "running" (its new holder decides), and
		// nothing was steered into the session here.
		assert.equal(fs.readFileSync(jobFile, "utf-8"), started);
		assert.deepEqual(deliveries, []);
	});
});
