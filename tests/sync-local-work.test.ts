/**
 * Cloud sync Phase 5, slice 3: take-over against this copy's REAL turn and
 * job machinery (owner's decision: the reply being written finishes first;
 * helpers and extraction stop here and start again on the new holder). A
 * side question's answer being written counts as a reply (upstream 0.6.0).
 *
 * This process plays the cloud server. LH_DATA_DIR and LH_AUTH_FILE are
 * redirected BEFORE the first config import.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createAssistantMessageEventStream, createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import type { SideChatService } from "../src/server/side-chat.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sync-work-"));
process.env.LH_AUTH_FILE = path.join(TMP, "secrets", "auth.json");
process.env.LH_DATA_DIR = path.join(TMP, "data");
process.env.LH_SERVER_MODE = "1";

// The app's side-question service, with a stand-in model: the one sync's
// local work reads is the process-wide instance, so it is put in place first.
let sideService: SideChatService | undefined;
(globalThis as { __lhSideChatService?: unknown }).__lhSideChatService = new Proxy({}, { get: (_target, name) => (sideService as unknown as Record<string | symbol, unknown>)[name] });
const { stores } = await import("../src/server/stores.ts");
const { createSideChatService } = await import("../src/server/side-chat.ts");
let stream: ReturnType<typeof createAssistantMessageEventStream> | undefined;
const faux = createFauxCore({});
const sideEngine: PiEngine = { model: faux.getModel(), streamFn: (_model, _context, options) => {
	const own = createAssistantMessageEventStream();
	stream = own;
	own.push({ type: "text_delta", contentIndex: 0, delta: "Because", partial: fauxAssistantMessage("Because") });
	// Like a provider's stream: an abort ends it.
	options?.signal?.addEventListener("abort", () => own.push({ type: "error", reason: "aborted", error: fauxAssistantMessage("Because", { stopReason: "aborted" }) }));
	return own;
} };
sideService = createSideChatService({ chatStore: stores.chatStore, engineFor: async () => sideEngine, instructions: () => "Side helper" });
await import("../src/server/sync/local-work.ts");
const engine = await import("../src/server/sync/engine.ts");
const { beginTurn, endTurn } = await import("../src/server/turn-liveness.ts");
const { registerJobAbort, isJobLive } = await import("../src/agent/subagents/aborts.ts");
const { recoverStaleJobs } = await import("../src/server/jobs.ts");

after(() => {
	delete process.env.LH_SERVER_MODE;
	fs.rmSync(TMP, { recursive: true, force: true });
});

const DESK = "dev_aaaaaaaaaaaaaaaa";

describe("a desktop asks the cloud for a session", () => {
	const chat = stores.chatStore.createChat("Motors");
	const job = stores.jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "tool_1", input: { question: "q" } });
	const controller = new AbortController();
	registerJobAbort(job.id, controller);

	it("the first sync starts the record and makes the backup", () => {
		assert.equal(engine.syncAuthority().active(), false);
		const reply = engine.syncAuthority().exchange(DESK, { cursor: 0 });
		assert.equal(reply.status, 200);
		assert.equal(engine.syncAuthority().active(), true);
		assert.equal(fs.readdirSync(path.join(TMP, "backups")).length, 1);
		assert.equal(engine.holdsSession(chat.id), true);
	});

	it("while a reply is being written it waits, and nothing is stopped", () => {
		assert.equal(beginTurn(chat.id), true);
		const reply = engine.syncAuthority().takeOver(DESK, chat.id, false);
		assert.equal(reply.body.status, "waiting");
		assert.equal(reply.body.reason, "reply");
		assert.equal(controller.signal.aborted, false);
		assert.equal(engine.holdsSession(chat.id), true);
		endTurn(chat.id);
	});

	it("then it moves: the helper stops here, its record stays \"running\" for the new holder", () => {
		const reply = engine.syncAuthority().takeOver(DESK, chat.id, false);
		assert.equal(reply.body.status, "moved");
		assert.equal(controller.signal.aborted, true);
		assert.equal(isJobLive(job.id), false);
		assert.equal(stores.jobStore.getJob(job.id)?.status, "running");
		assert.equal(engine.holdsSession(chat.id), false);
		assert.deepEqual(engine.sessionHolder(chat.id), { id: DESK, name: null });
	});

	it("and the helper is not restarted here, where the session is no longer held", () => {
		const warn = console.warn;
		console.warn = () => {};
		try { recoverStaleJobs(); } finally { console.warn = warn; }
		const record = stores.jobStore.getJob(job.id)!;
		assert.equal(record.activity, "starting", "untouched: no \"recovering: re-running\"");
	});
});

const { newUserMessage } = await import("../src/core/native-messages.ts");

describe("a side question being answered counts as a reply being written", () => {
	function lesson(title: string): { chatId: string; anchor: { messageId: string; partId: string; blockIndex: number; blockText: string } } {
		const chat = stores.chatStore.createChat(title);
		const explanation = { ...fauxAssistantMessage("Ohm's law relates voltage and current."), id: `explanation_${chat.id}` };
		stores.chatStore.saveMessages(chat.id, [newUserMessage("Teach me"), explanation] as never);
		engine.syncAuthority().scan(); // the server's record learns of it, as at a desktop's next question
		return { chatId: chat.id, anchor: { messageId: explanation.id, partId: `${explanation.id}-t0`, blockIndex: 0, blockText: "Ohm" } };
	}
	const threadOf = (chatId: string) => stores.chatStore.getChat(chatId)!.sideChats![0]!;

	it("the cloud waits while the side answer is written, then hands the session over", async () => {
		const { chatId, anchor } = lesson("Circuits");
		const response = await sideService!.ask(chatId, { anchor, text: "Why?", quotes: [], requestId: "ask_1" });
		assert.equal(response.status, 200);
		const waiting = engine.syncAuthority().takeOver(DESK, chatId, false);
		assert.deepEqual([waiting.body.status, waiting.body.reason], ["waiting", "reply"]);
		assert.equal(engine.holdsSession(chatId), true);

		stream!.push({ type: "done", reason: "stop", message: fauxAssistantMessage("Because the resistance is fixed.") });
		await sideService!.settled(chatId, threadOf(chatId).id);
		await response.text();
		const moved = engine.syncAuthority().takeOver(DESK, chatId, false);
		assert.equal(moved.body.status, "moved");
		assert.equal(threadOf(chatId).messages.at(-1)!.text, "Because the resistance is fixed.", "the answer was finished and saved first");
	});

	it("a session given up stops its side answer with the other work", async () => {
		const { chatId, anchor } = lesson("Motors");
		const response = await sideService!.ask(chatId, { anchor, text: "How?", quotes: [], requestId: "ask_2" });
		const work = (globalThis as { __lhSyncEngine?: { localWork?: { replying(id: string): boolean; stop(id: string, options?: { turn?: boolean }): void } } }).__lhSyncEngine!.localWork!;
		assert.equal(work.replying(chatId), true);
		work.stop(chatId, { turn: true });
		await sideService!.settled(chatId, threadOf(chatId).id);
		await response.text();
		assert.equal(work.replying(chatId), false);
		assert.equal(threadOf(chatId).messages.at(-1)!.stopped, true);
	});
});
