/** Compaction with pictures: the summarizer input marks drawings and never carries base64; a failure while preparing it is a quiet no-op. */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-compaction-drawings-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { ensureCompacted } = await import("../src/server/compaction.ts");
import type { CompactionDeps } from "../src/server/compaction.ts";
const { subscribe } = await import("../src/core/events.ts");
const { serializeForSummary, newUserMessage, activeCompactionOf } = await import("../src/core/index.ts");
import type { LhMessage } from "../src/core/index.ts";

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const B64 = "QUJD".repeat(500);
const img = { type: "image" as const, mimeType: "image/png", data: B64 };
const user = (content: unknown): LhMessage => ({ id: crypto.randomUUID(), role: "user", content, timestamp: Date.now() }) as LhMessage;
const toolResult = (content: unknown): LhMessage =>
	({ id: crypto.randomUUID(), role: "toolResult", toolCallId: "t1", toolName: "quiz", content, isError: false, timestamp: Date.now() }) as LhMessage;

describe("serializeForSummary with drawings", () => {
	it("string content is unchanged", () => {
		assert.equal(serializeForSummary([user("plain words")]), "[LEARNER] plain words");
	});
	it("text + one image", () => {
		assert.equal(serializeForSummary([user([{ type: "text", text: "here is my work" }, img])]), "[LEARNER] here is my work [drawing attached]");
	});
	it("two images", () => {
		assert.equal(serializeForSummary([user([{ type: "text", text: "look" }, img, img])]), "[LEARNER] look [drawing attached] [drawing attached]");
	});
	it("image only", () => {
		assert.equal(serializeForSummary([user([img])]), "[LEARNER] [drawing attached]");
	});
	it("a citation link in array text still renders as for a string", () => {
		const text = "see [the passage](lh-cite:abc \"quoted words\") ok";
		const asString = serializeForSummary([user(text)]);
		const asArray = serializeForSummary([user([{ type: "text", text }, img])]);
		assert.equal(asArray, `${asString} [drawing attached]`);
	});
	it("a tool result with text + image marks the picture, no base64", () => {
		const out = serializeForSummary([toolResult([{ type: "text", text: "my answer" }, img])]);
		assert.equal(out, "[RESULT for quiz] my answer\n[drawing attached]");
		assert.ok(!out.includes(B64));
	});
});

const big = (t: string): LhMessage => newUserMessage(`${t}: ${"x".repeat(100 * 1024)}`);
const mkDeps = (summarize: CompactionDeps["summarize"]): CompactionDeps => ({
	chatStore,
	engine: { model: { provider: "faux", id: "test", contextWindow: 1_000_000 } } as never,
	modelId: "faux:test",
	kind: "teach",
	thresholdTokens: 40_000,
	systemPromptTokens: 100,
	summarize,
});
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

describe("ensureCompacted with drawings", () => {
	it("compacts a record with a drawing inside the span", async () => {
		const chat = chatStore.createChat("drawing");
		const withDrawing = user([{ type: "text", text: "my sketch" }, img]);
		chatStore.saveMessages(chat.id, [big("m1"), withDrawing, big("m2"), big("m3"), newUserMessage("recent")]);
		let prompt = "";
		await ensureCompacted(mkDeps(async (p) => { prompt = p; return { summary: "S", usage }; }), chat.id);
		assert.ok(prompt.includes("[drawing attached]"));
		assert.ok(!prompt.includes(B64));
		assert.ok(activeCompactionOf(chatStore.getChat(chat.id)!.messages));
	});

	it("a failure in preparation neither rejects, nor changes the record, nor unbalances the events", async () => {
		const chat = chatStore.createChat("prep-fail");
		const bad = toolResult([{ type: "weird", n: 1n }]); // JSON.stringify throws on a BigInt
		chatStore.saveMessages(chat.id, [big("m1"), big("m2"), big("m3"), newUserMessage("recent")]);
		const record = chatStore.getChat(chat.id)!;
		const before = JSON.stringify(record.messages);
		const original = chatStore.getChat.bind(chatStore);
		const mutate = true;
		(chatStore as { getChat: typeof chatStore.getChat }).getChat = (id: string) => {
			const r = original(id);
			return mutate && r && id === chat.id ? { ...r, messages: [r.messages[0]!, bad, ...r.messages.slice(1)] } : r;
		};
		const flags: boolean[] = [];
		const off = subscribe((e) => {
			if (e.type === "compaction-changed" && e.chatId === chat.id) flags.push(e.running);
		});
		let called = false;
		try {
			await ensureCompacted(mkDeps(async () => { called = true; return { summary: "S", usage }; }), chat.id);
		} finally {
			off();
			(chatStore as { getChat: typeof chatStore.getChat }).getChat = original;
		}
		assert.equal(called, false);
		assert.deepEqual(flags, [true, false]);
		assert.equal(JSON.stringify(chatStore.getChat(chat.id)!.messages), before);
	});
});
