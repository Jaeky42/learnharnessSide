/** FORK (empty reply): the page hides an empty ChatGPT/OpenAI attempt the
 * server dropped and asked again (components/session-core.ts, applyWireEvent).
 * Synthetic fixtures only. */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { SessionModel } from "../components/session-core.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const usage = { input: 0, output: 0, total: 0, cacheReads: 0, cacheWrites: 0 };
const assistant = (content: unknown[], opts: { provider?: string; stopReason?: string } = {}) => ({
	role: "assistant", content, usage, provider: opts.provider ?? "chatgpt", model: "gpt-6.2-astra", api: "openai-responses",
	...(opts.stopReason ? { stopReason: opts.stopReason } : {}),
});
const thinking = { type: "thinking", thinking: "Hidden thought." };

/** One streamed assistant message: start, update, end (pi's full partials). */
function streamed(content: unknown[], opts: { provider?: string; stopReason?: string } = {}): Record<string, unknown>[] {
	return [
		{ type: "message_start", message: assistant([], { provider: opts.provider }) },
		{ type: "message_update", message: assistant(content, { provider: opts.provider }), assistantMessageEvent: { type: "text_delta" } },
		{ type: "message_end", message: assistant(content, { provider: opts.provider, stopReason: opts.stopReason ?? "stop" }) },
	];
}
const turnEnd = (toolResults: unknown[] = []) => ({ type: "turn_end", message: {}, toolResults });
const turnStart = { type: "turn_start" };

const model = (initialMessages: LhMessage[] = []) => new SessionModel({ chatId: "chat_x", initialMessages });
const assistants = (m: SessionModel) => m.getState().nativeMessages.filter((x) => x.role === "assistant");
const texts = (m: SessionModel) => assistants(m).map((x) => JSON.stringify((x as { content: unknown }).content));

describe("an empty ChatGPT/OpenAI attempt followed by another message (live stream)", () => {
	for (const provider of ["chatgpt", "openai"]) {
		it(`${provider}: one assistant message while streaming and after`, () => {
			const m = model();
			for (const e of [{ type: "agent_start" }, turnStart, ...streamed([thinking], { provider }), turnEnd(), turnStart]) m.applyWireEvent(e);
			assert.equal(assistants(m).length, 1, "the empty attempt is there until the next message starts");
			const next = streamed([{ type: "text", text: "Mercury is closest." }], { provider });
			m.applyWireEvent(next[0]!);
			assert.equal(assistants(m).length, 1, "the new message takes its place at its start");
			m.applyWireEvent(next[1]!);
			assert.equal(assistants(m).length, 1);
			m.applyWireEvent(next[2]!);
			assert.deepEqual(texts(m), [JSON.stringify([{ type: "text", text: "Mercury is closest." }])]);
			assert.equal(m.getState().messages.filter((v) => v.role === "assistant").length, 1, "one view message");
		});
	}

	it("a completely empty attempt (no thinking either) is hidden too", () => {
		const m = model();
		for (const e of [...streamed([]), turnEnd(), ...streamed([{ type: "text", text: "Hi." }])]) m.applyWireEvent(e);
		assert.equal(assistants(m).length, 1);
	});
});

describe("what is never hidden", () => {
	it("an empty reply from another provider is kept", () => {
		for (const provider of ["anthropic", "openrouter", "claude-code"]) {
			const m = model();
			for (const e of [...streamed([thinking], { provider }), turnEnd(), ...streamed([{ type: "text", text: "Hi." }], { provider })]) m.applyWireEvent(e);
			assert.equal(assistants(m).length, 2, provider);
		}
	});

	it("a failed reply is kept", () => {
		const m = model();
		for (const e of [...streamed([thinking], { stopReason: "error" }), ...streamed([{ type: "text", text: "Hi." }])]) m.applyWireEvent(e);
		assert.equal(assistants(m).length, 2);
	});

	it("a tool-call reply followed by another reply keeps both", () => {
		const m = model();
		const call = { type: "toolCall", id: "c1", name: "again", arguments: {} };
		for (const e of [...streamed([thinking, call], { stopReason: "toolUse" }),
			turnEnd([{ role: "toolResult", toolCallId: "c1", toolName: "again", content: [{ type: "text", text: "Done" }], isError: false, timestamp: 0 }]),
			...streamed([{ type: "text", text: "Hi." }])]) m.applyWireEvent(e);
		assert.equal(assistants(m).length, 2);
	});

	it("a reply with text is kept", () => {
		const m = model();
		for (const e of [...streamed([{ type: "text", text: "First." }]), turnEnd(), ...streamed([{ type: "text", text: "Second." }])]) m.applyWireEvent(e);
		assert.equal(assistants(m).length, 2);
	});

	it("a message already in the record is never removed", () => {
		const saved = { ...assistant([thinking], { stopReason: "stop" }), id: "saved_empty", timestamp: 0 } as unknown as LhMessage;
		const m = model([saved]);
		for (const e of streamed([{ type: "text", text: "Hi." }])) m.applyWireEvent(e);
		assert.equal(assistants(m).length, 2);
		assert.equal(m.getState().canonicalMessages.length, 1);
	});
});

describe("a reattach replay", () => {
	it("replays the same events: one assistant message during the replay and after", async () => {
		const frames = [{ type: "agent_start" }, turnStart, ...streamed([thinking]), turnEnd(), turnStart, ...streamed([{ type: "text", text: "Mercury is closest." }])];
		let push!: (text: string) => void, close!: () => void;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				const enc = new TextEncoder();
				push = (text) => controller.enqueue(enc.encode(text));
				close = () => controller.close();
			},
		});
		const settled = [{ ...assistant([{ type: "text", text: "Mercury is closest." }], { stopReason: "stop" }), id: "saved_reply", timestamp: 1 }];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === "/api/chats/chat_x/stream") return new Response(body, { status: 200 });
			if (url === "/api/chats/chat_x") return Response.json({ messages: settled });
			throw new Error(`unexpected fetch: ${url}`);
		}) as typeof globalThis.fetch;
		const counts: number[] = [];
		const m: SessionModel = new SessionModel({ chatId: "chat_x", initialMessages: [], onChange: () => counts.push(assistants(m).length) });
		const attached = m.resumeStream(false);
		for (const frame of frames) push(`data: ${JSON.stringify(frame)}\n\n`);
		await new Promise((r) => setTimeout(r, 20));
		assert.equal(m.getState().status, "streaming");
		assert.equal(assistants(m).length, 1, "during the replay");
		assert.equal(Math.max(...counts), 1, "never two assistant messages at once");
		assert.ok(!JSON.stringify(m.getState().nativeMessages).includes("Hidden thought."));
		push("data: [DONE]\n\n");
		close();
		await attached;
		assert.equal(assistants(m).length, 1, "after the settle");
		assert.equal(m.getState().status, "ready");
	});
});
