/** FORK (empty reply): the real handleChatInput through the real ChatGPT
 * stream, with a faked desktop IPC and a scripted Responses backend
 * (modelled on chatgpt-request-cycle.test.ts). Synthetic fixtures only. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { type Model, createFauxCore, fauxAssistantMessage, fauxThinking } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { piModels } from "../src/agent/models.ts";
import { refreshChatGPTModels } from "../src/agent/chatgpt-bridge.ts";
import { bareQuestionTools, createTeacherAgent } from "../src/agent/teacher-agent.ts";
import { EMPTY_REPLY_NUDGE_TEXT, EMPTY_REPLY_TEXT } from "../src/agent/empty-reply-guard.ts";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-empty-reply-"));
process.env.LH_DATA_DIR = path.join(scratch, "data");
process.env.LH_AUTH_FILE = path.join(scratch, "auth.json");
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
import { newUserMessage, needsContinuation, type LhMessage } from "../src/core/native-messages.ts";
import { retryDrops } from "../src/core/input-events.ts";
import { SessionModel } from "../components/session-core.ts";

const model = piModels().getModel("openai", "gpt-5") as Model<"openai-responses">;
let epoch = 1, revision = 1;
type Shape = "text" | "empty" | "tool";
let script: Shape[] = [];
let leases: boolean[] = [], bodies: string[] = [];
const status = () => ({ available: true, pending: false, allowBackgroundUse: true, activeId: "scratch", accounts: [{ id: "scratch", registration: "oaiapp_scratch", email: "dummy@example.invalid", connected: true, planEnabled: true, background: false }], error: null });
const ipc = (m: unknown) => (process.emit as (name: string, m: unknown) => boolean)("message", m);
const realFetch = globalThis.fetch;
const realWarn = console.warn;
const originalSend = Object.getOwnPropertyDescriptor(process, "send");
const originalConnected = Object.getOwnPropertyDescriptor(process, "connected");
const desktopMarker = process.env.LH_DESKTOP_SERVER, desktopSecret = process.env.LH_DESKTOP_API_SECRET;
let logs: string[] = [];
before(() => {
	process.env.LH_DESKTOP_SERVER = "1"; process.env.LH_DESKTOP_API_SECRET = "d".repeat(64);
	console.warn = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
	Object.defineProperty(process, "connected", { configurable: true, value: true });
	Object.defineProperty(process, "send", { configurable: true, value: (m: any, callback?: () => void) => {
		if (m.op === "lease") leases.push(m.background);
		const value = { epoch: 1, authorityRevision: epoch, revision, ...(m.op === "lease" ? { accountId: "scratch", accessToken: "dummy-oauth-native" } : { status: status(), accountId: "scratch", models: [{ id: model.id, name: "Scratch" }] }) };
		queueMicrotask(() => ipc({ channel: "lh:chatgpt", id: m.id, op: m.op, ok: true, value })); callback?.(); return true;
	} });
	globalThis.fetch = async (input: any, init: any) => {
		bodies.push(await new Request(input, init).text());
		const n = bodies.length;
		const shape = script.shift() ?? "text";
		const reasoning = { id: `rs_${n}`, type: "reasoning", summary: [{ type: "summary_text", text: `Thought ${n}.` }], encrypted_content: `enc-${n}` };
		const item = { id: `msg_${n}`, type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: `Reply ${n}.`, annotations: [] }] };
		const call = { type: "function_call", id: `fc_again_${n}`, call_id: `call_again_${n}`, name: "again", namespace: "learnharness", arguments: "{}", status: "completed" };
		const out = shape === "empty" ? [reasoning] : shape === "tool" ? [reasoning, call] : [reasoning, item];
		const events: unknown[] = [{ type: "response.created", response: { id: `resp_${n}` } }];
		out.forEach((o, i) => {
			events.push({ type: "response.output_item.added", output_index: i, item: o.type === "message" ? { ...o, content: [] } : o });
			events.push({ type: "response.output_item.done", output_index: i, item: o });
		});
		events.push({ type: "response.completed", response: { status: "completed", output: out, usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } } });
		return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
	};
});
after(() => {
	globalThis.fetch = realFetch;
	console.warn = realWarn;
	if (desktopMarker === undefined) delete process.env.LH_DESKTOP_SERVER; else process.env.LH_DESKTOP_SERVER = desktopMarker;
	if (desktopSecret === undefined) delete process.env.LH_DESKTOP_API_SECRET; else process.env.LH_DESKTOP_API_SECRET = desktopSecret;
	if (originalSend) Object.defineProperty(process, "send", originalSend); else delete (process as { send?: unknown }).send;
	if (originalConnected) Object.defineProperty(process, "connected", originalConnected); else delete (process as { connected?: boolean }).connected;
	fs.rmSync(scratch, { recursive: true, force: true });
});

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const QUESTION_TEXT = "Which planet is closest to the sun?";
const question = (provider: string) => ({ role: "assistant", id: "q_teacher", api: "openai-responses", provider, model: model.id,
	content: [{ type: "text", text: "Here is the idea." }, { type: "toolCall", id: "call_q|fc_q", name: "quiz", arguments: { question: QUESTION_TEXT, options: [{ label: "Venus" }, { label: "Mercury" }, { label: "Mars" }], correctAnswer: "Mercury", explanation: "Mercury is the innermost planet.", type: "check", nodeId: "planet-order" } }],
	stopReason: "toolUse", timestamp: 1, usage } as unknown as LhMessage);
const answer = { type: "answer", toolCallId: "call_q|fc_q", answer: { kind: "quiz", questionText: QUESTION_TEXT, dontKnow: false, answers: [{ label: "Mercury", value: "mercury", index: 2 }], answeredAt: "2026-11-25T00:00:00Z" } };
const againTool = { again: { name: "again", label: "again", description: "scratch", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text" as const, text: "Done" }], details: {} }) } };

type Build = Parameters<typeof import("../src/server/chat-handler.ts")["handleChatInput"]>[2];
const chatGPTBuild: Build = (opts) => createTeacherAgent(undefined, { ...opts });

async function runTurn(chatId: string, input: unknown, build: Build) {
	const { handleChatInput } = await import("../src/server/chat-handler.ts");
	const { runningTurn } = await import("../src/server/turn-runs.ts");
	const response = await handleChatInput(chatId, input as never, build);
	assert.equal(response.status, 200, await response.clone().text());
	const turn = runningTurn(chatId);
	const wire = turn ? await new Response(turn.subscribe()).text() : "";
	await new Promise((r) => setTimeout(r, 50));
	const events = wire.split("\n\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)));
	return { events };
}

async function setup(name: string, shapes: Shape[], settingsModel = { provider: "chatgpt", id: model.id }, extra: LhMessage[] = []) {
	epoch++; revision++; leases = []; bodies = []; logs = []; script = [...shapes];
	await refreshChatGPTModels([model]);
	const { chatStore } = await import("../src/store/chats.ts");
	const chat = chatStore.createChat(name);
	chatStore.saveSettings(chat.id, { model: settingsModel });
	const original = [newUserMessage("Teach me"), question(settingsModel.provider), ...extra];
	chatStore.saveMessages(chat.id, original);
	return { chatStore, chatId: chat.id, base: original.length };
}
const brief = (m: any) => ({ role: m.role, stopReason: m.stopReason, errorMessage: m.errorMessage, blocks: Array.isArray(m.content) ? m.content.map((b: any) => b.type) : undefined });

/** The request body's last input item, if it is a plain user message: its text. */
const lastUserText = (body: string): string | undefined => {
	const last = (JSON.parse(body) as { input: any[] }).input.at(-1);
	if (last?.role !== "user") return undefined;
	return Array.isArray(last.content) ? last.content.map((c: any) => c.text ?? "").join("") : String(last.content);
};
const carriesNudge = (body: string) => body.includes("Your previous reply was empty");

test("(a) answer -> empty -> nudged request -> normal reply: the lesson goes on, nothing of it is kept", async () => {
	const { chatStore, chatId, base } = await setup("a", ["empty", "text"]);
	const { events } = await runTurn(chatId, answer, chatGPTBuild);
	assert.equal(bodies.length, 2);
	assert.deepEqual(leases, [false, false], "each request takes its own lease");
	assert.equal(carriesNudge(bodies[0]!), false);
	assert.equal(lastUserText(bodies[1]!), EMPTY_REPLY_NUDGE_TEXT, "the nudged request ends with the instruction as a user input");
	assert.ok(!bodies[1]!.includes("enc-1") && !bodies[1]!.includes("rs_1"), "the dropped reply is not in the nudged request");
	assert.equal(JSON.parse(bodies[1]!).input.length, JSON.parse(bodies[0]!).input.length + 1, "the same request plus the one instruction");
	const saved = chatStore.getChat(chatId)!;
	assert.deepEqual(saved.messages.slice(base).map(brief), [
		{ role: "toolResult", stopReason: undefined, errorMessage: undefined, blocks: ["text"] },
		{ role: "assistant", stopReason: "stop", errorMessage: undefined, blocks: ["thinking", "text"] },
	]);
	assert.ok(JSON.stringify(saved.messages).includes("Reply 2.") && !JSON.stringify(saved.messages).includes("Thought 1."));
	const file = fs.readFileSync(path.join((await import("../config.ts")).PATHS.chats, `${chatId}.json`), "utf8");
	assert.ok(!carriesNudge(file) && !file.includes("Continue."), "no nudge text anywhere in the saved file");
	assert.ok(!events.some((e) => carriesNudge(JSON.stringify(e))), "no wire event carries the instruction");
	assert.equal(events.filter((e) => e.type === "turn_start").length, 2, "the nudged request's events reach the wire");
	// The page, fed this very wire, never shows the dropped attempt beside the reply.
	const page = new SessionModel({ chatId, initialMessages: [] });
	const counts: number[] = [];
	for (const e of events) { page.applyWireEvent(e); counts.push(page.getState().nativeMessages.filter((x) => x.role === "assistant").length); }
	assert.equal(Math.max(...counts), 1, "at most one assistant message on the page at any moment");
	assert.ok(JSON.stringify(page.getState().nativeMessages).includes("Reply 2.") && !JSON.stringify(page.getState().nativeMessages).includes("Thought 1."));
	assert.ok(events.some((e) => e.type === "message_end" && e.message.role === "assistant" && JSON.stringify(e.message).includes("Reply 2.")));
	assert.equal(saved.turns?.at(-1)?.steps.length, 2, "(e) usage for both requests");
	assert.deepEqual(logs, ["[LearnHarness] Empty reply: chatgpt:gpt-5; teacher; empty reply 1; nudging; thinking: yes; phases before: none"]);
});

test("(b) answer -> empty -> nudged reply empty: a failed reply with the approved sentence, and Retry works without the nudge", async () => {
	const { chatStore, chatId, base } = await setup("b", ["empty", "empty"]);
	const { events } = await runTurn(chatId, answer, chatGPTBuild);
	assert.equal(bodies.length, 2);
	assert.deepEqual(leases, [false, false]);
	assert.equal(lastUserText(bodies[1]!), EMPTY_REPLY_NUDGE_TEXT);
	assert.ok(!bodies[1]!.includes("enc-1"));
	const saved = chatStore.getChat(chatId)!;
	const tail = saved.messages.slice(base);
	assert.deepEqual(tail.map(brief), [
		{ role: "toolResult", stopReason: undefined, errorMessage: undefined, blocks: ["text"] },
		{ role: "assistant", stopReason: "error", errorMessage: EMPTY_REPLY_TEXT, blocks: ["thinking"] },
	]);
	assert.ok(JSON.stringify(tail.at(-1)).includes("Thought 2."), "the nudged empty reply is the one saved");
	assert.ok(!carriesNudge(JSON.stringify(saved)), "no nudge in the record");
	assert.equal(retryDrops(saved.messages).size, 1);
	assert.equal(needsContinuation(saved.messages), false);
	assert.equal(events.filter((e) => e.type === "turn_start").length, 2);
	assert.ok(!events.some((e) => carriesNudge(JSON.stringify(e))));
	assert.ok(events.some((e) => e.type === "turn_end" && e.message.stopReason === "error" && e.message.errorMessage === EMPTY_REPLY_TEXT));
	assert.equal(saved.turns?.at(-1)?.steps.length, 2, "(e) usage for both requests");
	assert.deepEqual(logs.map((l) => l.split("; ").slice(2, 4).join("; ")), ["empty reply 1; nudging", "empty reply 2; giving up"]);
	for (const line of logs) assert.ok(!line.includes("Mercury") && !line.includes("planet") && !line.includes("Thought") && !line.includes("q_teacher"));
	// Retry: a normal turn from the saved answer, whose first request has no nudge.
	bodies = []; leases = []; logs = []; script = ["text"];
	await runTurn(chatId, { type: "retry" }, chatGPTBuild);
	assert.equal(bodies.length, 1);
	assert.equal(carriesNudge(bodies[0]!), false, "Retry's first request does not carry the instruction");
	const after = chatStore.getChat(chatId)!.messages.slice(base);
	assert.deepEqual(after.map(brief).slice(-2), [
		{ role: "assistant", stopReason: "error", errorMessage: EMPTY_REPLY_TEXT, blocks: ["thinking"] },
		{ role: "assistant", stopReason: "stop", errorMessage: undefined, blocks: ["thinking", "text"] },
	]);
	assert.deepEqual(logs, []);
});

test("(c) a nudged reply that makes a tool call: the request after the tool result has no nudge", async () => {
	const { chatStore, chatId, base } = await setup("c-tool", ["empty", "tool", "text"]);
	const { events } = await runTurn(chatId, answer, (opts) => createTeacherAgent(undefined, { ...opts, tools: { ...bareQuestionTools(), ...againTool } }));
	assert.equal(bodies.length, 3);
	assert.equal(lastUserText(bodies[1]!), EMPTY_REPLY_NUDGE_TEXT);
	assert.equal(carriesNudge(bodies[0]!), false);
	assert.equal(carriesNudge(bodies[2]!), false, "the request after the tool result does not carry the instruction");
	const saved = chatStore.getChat(chatId)!;
	assert.deepEqual(saved.messages.slice(base).map(brief), [
		{ role: "toolResult", stopReason: undefined, errorMessage: undefined, blocks: ["text"] },
		{ role: "assistant", stopReason: "toolUse", errorMessage: undefined, blocks: ["thinking", "toolCall"] },
		{ role: "toolResult", stopReason: undefined, errorMessage: undefined, blocks: ["text"] },
		{ role: "assistant", stopReason: "stop", errorMessage: undefined, blocks: ["thinking", "text"] },
	]);
	assert.ok(!carriesNudge(JSON.stringify(saved)));
	assert.ok(!events.some((e) => carriesNudge(JSON.stringify(e))));
	assert.equal(saved.turns?.at(-1)?.steps.length, 3, "(e) usage for every request");
	assert.deepEqual(logs.map((l) => l.split("; ").slice(2, 4).join("; ")), ["empty reply 1; nudging"]);
});

test("(d) an automatic wake whose reply is empty: one request, no nudge, saved as before, no error", async () => {
	const { chatStore, chatId, base } = await setup("c", ["empty"]);
	const steer = { id: "auto_steer", role: "custom", customType: "subagent-steer", content: "Automatic result", details: { jobId: "dummy-job" }, display: true, timestamp: 2 } as unknown as LhMessage;
	// A normal answer turn first; then the wake carries a helper's result.
	await runTurn(chatId, answer, chatGPTBuild);
	const afterAnswer = chatStore.getChat(chatId)!.messages.length;
	bodies = []; leases = []; logs = []; script = ["empty"];
	await runTurn(chatId, { type: "steers", steers: [steer] }, chatGPTBuild);
	assert.equal(bodies.length, 1);
	assert.equal(carriesNudge(bodies[0]!), false);
	assert.deepEqual(leases, [true], "an automatic request");
	const tail = chatStore.getChat(chatId)!.messages.slice(afterAnswer);
	assert.deepEqual(tail.map(brief), [
		{ role: "custom", stopReason: undefined, errorMessage: undefined, blocks: undefined },
		{ role: "assistant", stopReason: "stop", errorMessage: undefined, blocks: ["thinking"] },
	]);
	assert.ok(base < afterAnswer);
	assert.deepEqual(logs, [], "automatic empties are not logged");
});

test("(d) a tool call, then an empty reply: not nudged, saved as before, logged", async () => {
	const { chatStore, chatId, base } = await setup("d", ["tool", "empty"]);
	await runTurn(chatId, answer, (opts) => createTeacherAgent(undefined, { ...opts, tools: { ...bareQuestionTools(), ...againTool } }));
	assert.equal(bodies.length, 2);
	assert.ok(!bodies.some(carriesNudge));
	const saved = chatStore.getChat(chatId)!;
	assert.deepEqual(saved.messages.slice(base).map(brief), [
		{ role: "toolResult", stopReason: undefined, errorMessage: undefined, blocks: ["text"] },
		{ role: "assistant", stopReason: "toolUse", errorMessage: undefined, blocks: ["thinking", "toolCall"] },
		{ role: "toolResult", stopReason: undefined, errorMessage: undefined, blocks: ["text"] },
		{ role: "assistant", stopReason: "stop", errorMessage: undefined, blocks: ["thinking"] },
	]);
	assert.equal(saved.turns?.at(-1)?.steps.length, 2, "(e) usage for both requests");
	assert.deepEqual(logs, ["[LearnHarness] Empty reply: chatgpt:gpt-5; teacher; empty reply 1; not retried: follows other output in this turn; thinking: yes; phases before: none"]);
});

test("(d) the same empty reply from another provider's engine is not nudged (scripted engine)", async () => {
	// Driven through the handler with a scripted (faux) engine labelled as
	// Anthropic, not through the ChatGPT path: the guard reads the engine's provider.
	for (const [provider, id, calls, retried] of [["anthropic", "claude-sonnet-5-5", 1, false], ["openai", "gpt-5", 2, true]] as const) {
		const { chatStore, chatId, base } = await setup(`e-${provider}`, [], { provider: "openrouter", id: "z-ai/glm-5.3-flash" });
		const faux = createFauxCore({ provider, models: [{ id, reasoning: true }] });
		let made = 0;
		const lastSeen: string[] = [];
		const seen = (context: { messages: { role: string; content: unknown }[] }) => { lastSeen.push(JSON.stringify(context.messages.at(-1))); };
		faux.setResponses([
			(context) => { made++; seen(context as never); return fauxAssistantMessage([fauxThinking("Only thinking.")]); },
			(context) => { made++; seen(context as never); return fauxAssistantMessage([{ type: "text", text: "Spoken." }]); },
		]);
		const engine = { model: faux.getModel(), streamFn: faux.streamSimple, level: "off" as const };
		await runTurn(chatId, answer, (opts) => createTeacherAgent(undefined, { ...opts, engine, requestCycle: undefined }));
		assert.equal(made, calls, provider);
		const tail = chatStore.getChat(chatId)!.messages.slice(base);
		assert.deepEqual(tail.map(brief).at(-1), retried
			? { role: "assistant", stopReason: "stop", errorMessage: undefined, blocks: ["text"] }
			: { role: "assistant", stopReason: "stop", errorMessage: undefined, blocks: ["thinking"] }, provider);
		assert.equal(tail.length, 2, provider);
		assert.equal(logs.length, retried ? 1 : 0, provider);
		assert.equal(carriesNudge(lastSeen[0]!), false, provider);
		if (retried) assert.ok(lastSeen[1]!.includes(EMPTY_REPLY_NUDGE_TEXT.slice(0, 40)) && JSON.parse(lastSeen[1]!).role === "user", "the nudge is the engine's last message");
		assert.ok(!carriesNudge(JSON.stringify(chatStore.getChat(chatId))), provider);
		assert.equal(chatStore.getChat(chatId)!.turns?.at(-1)?.steps.length, calls, `(e) usage for every request, ${provider}`);
	}
});
