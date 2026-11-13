/**
 * Perf round: GET /api/chats/<id> and its ?only= answers, the session stamp,
 * and the browser copy's reasoning signatures. Runs the real route against
 * the real store in a scratch data folder.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-browser-route-"));
process.env.LH_DATA_DIR = scratch;
process.env.LH_AUTH_FILE = path.join(scratch, "empty-auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}", { mode: 0o600 });
const { chatStore, chatStamp } = await import("../src/store/chats.ts");
const { stores } = await import("../src/server/stores.ts");
const { GET } = await import("../app/api/chats/[id]/route.ts");
const { withoutThinkingSignatures } = await import("../src/core/browser-record.ts");
const { readBrowserState } = await import("../src/server/browser-stamp.ts");
const { rememberTurnFailure, clearTurnFailure } = await import("../src/server/turn-runs.ts");
const { fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai");
const { Type } = await import("typebox");
const { activeProblemOf, PRACTICE_CONCLUDE_TOOL } = await import("../src/core/native-messages.ts");
const { preparePluginProblemType } = await import("../src/core/plugin-problems.ts");
const globals = globalThis as typeof globalThis & { __lhPlugins?: unknown };
const previousRuntime = globals.__lhPlugins;
let resolveQuestion: (...args: unknown[]) => unknown = () => ({ status: "unavailable" });
globals.__lhPlugins = { host: { resolveQuestionType: (...args: unknown[]) => resolveQuestion(...args) }, ready: Promise.resolve() };
after(() => { globals.__lhPlugins = previousRuntime; });
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const get = (id: string, query = "") => GET(new Request(`http://localhost/api/chats/${id}${query}`), { params: Promise.resolve({ id }) });
const fileOf = (id: string) => path.join(scratch, "chats", `${id}.json`);
const dirListing = () => fs.readdirSync(scratch, { recursive: true }).map(String).sort();

/** Counts reads of chat files while `fn` runs (the real fs, observed). */
async function chatReads<T>(fn: () => Promise<T>): Promise<{ result: T; reads: number }> {
	const real = fs.readFileSync;
	let reads = 0;
	(fs as { readFileSync: unknown }).readFileSync = function (p: unknown, ...rest: unknown[]) {
		if (String(p).includes(`${path.sep}chats${path.sep}`)) reads++;
		return (real as (...a: unknown[]) => unknown)(p, ...rest);
	};
	syncBuiltinESMExports();
	try { return { result: await fn(), reads }; } finally {
		(fs as { readFileSync: unknown }).readFileSync = real;
		syncBuiltinESMExports();
	}
}

const signature = "c2lnbmF0dXJlLWJ5dGVz".repeat(40);
function thinkingAssistant(id: string, withSignature = true) {
	return {
		id, role: "assistant", api: "faux", provider: "faux", model: "faux", stopReason: "stop", timestamp: 2,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		content: [
			{ type: "thinking", thinking: "Considering the question.", ...(withSignature ? { thinkingSignature: signature } : {}) },
			{ type: "text", text: "An answer.", textSignature: "keep-me" },
		],
	};
}
function seed(title = "route fixture") {
	const record = chatStore.createChat(title);
	chatStore.saveMessages(record.id, [
		{ id: "u1", role: "user", content: "hello", timestamp: 1 },
		thinkingAssistant("a1"),
		{ id: "u2", role: "user", content: "again", timestamp: 3 },
		thinkingAssistant("a2"),
	] as never);
	chatStore.saveSettings(record.id, { thinkingLevel: "high" });
	chatStore.appendTurnUsage(record.id, { id: "t1", messageId: "a1", at: "x", model: "missing:fixture", steps: [{ inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }] });
	return record.id;
}

describe("?only= answers", () => {
	const id = seed();
	it("each one equals the same field of the full GET", async () => {
		const full = await (await get(id)).json();
		const stamp = await (await get(id, "?only=stamp")).json();
		const coverage = await (await get(id, "?only=coverage")).json();
		const settings = await (await get(id, "?only=settings")).json();
		const turns = await (await get(id, "?only=turns")).json();
		assert.deepEqual(stamp, { stamp: full.stamp });
		assert.equal(typeof full.stamp, "string");
		assert.deepEqual(coverage, { coverage: full.coverage });
		assert.deepEqual(settings, { settings: full.settings });
		assert.deepEqual(settings.settings, { thinkingLevel: "high" });
		assert.deepEqual(turns, { turns: full.turns, pricing: full.pricing });
		assert.equal(turns.turns.length, 1);
	});
	it("a session with no settings gives an empty settings answer, like the full GET's absent field", async () => {
		const bare = chatStore.createChat("bare").id;
		const full = await (await get(bare)).json();
		assert.equal("settings" in full, false);
		assert.deepEqual(await (await get(bare, "?only=settings")).json(), {});
	});
	it("only=stamp reads the record exactly once (the composite needs its values) and writes nothing", async () => {
		const before = fs.readFileSync(fileOf(id), "utf8");
		const listing = dirListing();
		const { result, reads } = await chatReads(async () => get(id, "?only=stamp"));
		assert.equal(result.status, 200);
		assert.equal(reads, 1);
		const original = stores.chatStore.getChat;
		let calls = 0;
		(stores.chatStore as { getChat: unknown }).getChat = (...a: unknown[]) => { calls++; return (original as (...x: unknown[]) => unknown)(...a); };
		try { assert.equal((await get(id, "?only=stamp")).status, 200); } finally { (stores.chatStore as { getChat: unknown }).getChat = original; }
		assert.equal(calls, 1);
		assert.equal(fs.readFileSync(fileOf(id), "utf8"), before);
		assert.deepEqual(dirListing(), listing);
	});
	it("an unknown value is a 400 in the app's error shape", async () => {
		for (const q of ["?only=messages", "?only=", "?only=STAMP"]) {
			const res = await get(id, q);
			assert.equal(res.status, 400, q);
			const body = await res.json();
			assert.equal(typeof body.error, "string");
			assert.equal(body.code, "bad_only");
		}
	});
	it("a missing session is the same 404 as the full GET", async () => {
		const full = await get("chat_missing_0000");
		assert.equal(full.status, 404);
		for (const only of ["stamp", "coverage", "settings", "turns"]) {
			const res = await get("chat_missing_0000", `?only=${only}`);
			assert.equal(res.status, 404, only);
			assert.deepEqual(await res.json(), await full.clone().json());
		}
		assert.equal((await get("bad id!", "?only=stamp")).status, 404);
	});
	it("the only answers write nothing", async () => {
		const before = fs.readFileSync(fileOf(id), "utf8");
		const listing = dirListing();
		for (const only of ["stamp", "coverage", "settings", "turns"]) await get(id, `?only=${only}`);
		assert.equal(fs.readFileSync(fileOf(id), "utf8"), before);
		assert.deepEqual(dirListing(), listing);
	});
});

describe("the full GET reads the record once", () => {
	it("one read of the chat file for a session with no pending plugin question", async () => {
		const id = seed("one read");
		const { result, reads } = await chatReads(async () => get(id));
		assert.equal(result.status, 200);
		assert.equal(reads, 1);
	});
});

describe("the session stamp", () => {
	const id = seed("stamps");
	const wait = () => new Promise((resolve) => setTimeout(resolve, 5));
	it("is stable across reads with no write, and null for a missing session", () => {
		assert.equal(chatStamp(id), chatStamp(id));
		assert.equal(chatStamp("chat_missing_0000"), null);
		assert.equal(chatStamp("not a valid id"), null);
	});
	const writes: [string, () => void][] = [
		["saveMessages", () => chatStore.saveMessages(id, [{ id: "u9", role: "user", content: "more", timestamp: 9 }] as never)],
		["saveSettings", () => chatStore.saveSettings(id, { thinkingLevel: "low" })],
		["saveTree", () => chatStore.saveTree(id, { nodes: [] } as never)],
		["renameChat", () => { chatStore.renameChat(id, "renamed"); }],
		["appendTurnUsage", () => chatStore.appendTurnUsage(id, { id: "t2", messageId: "u9", at: "x", model: "m:m", steps: [] })],
		["appendExtractionUsage", () => chatStore.appendExtractionUsage(id, { startedAt: "2026-01-01T00:00:00Z" } as never)],
		["saveImageSnapshot", () => {
			const data = Buffer.from("pixels").toString("base64");
			const hash = createHash("sha256").update(Buffer.from(data, "base64")).digest("hex");
			chatStore.saveImageSnapshot(id, hash, { mimeType: "image/png", data, width: 1, height: 1 });
		}],
		["updateSideChats", () => { chatStore.updateSideChats(id, () => [{ id: "s1", anchor: { kind: "free" }, open: true, createdAt: "x", messages: [] } as never]); }],
		["a replacement from outside the store", () => {
			const file = fileOf(id);
			fs.writeFileSync(file + ".other", fs.readFileSync(file, "utf8")); // same bytes, as cloud sync's rewrite would be
			fs.renameSync(file + ".other", file);
		}],
	];
	for (const [name, write] of writes) {
		it(`changes after ${name}`, async () => {
			const before = chatStamp(id);
			await wait();
			write();
			assert.notEqual(chatStamp(id), before);
			assert.equal(chatStamp(id), chatStamp(id));
		});
	}
});

describe("reasoning signatures in what the browser gets", () => {
	it("are left out of the GET body, everything else equal, and the file is untouched", async () => {
		const id = seed("signatures");
		const record = chatStore.getChat(id)!;
		const frozenCopy = structuredClone(record);
		const bytes = fs.readFileSync(fileOf(id), "utf8");
		const listing = dirListing();
		assert.ok(bytes.includes(signature));
		const res = await get(id);
		const text = await res.text();
		assert.equal(text.includes(signature), false);
		assert.equal(text.includes("thinkingSignature"), false);
		const body = JSON.parse(text);
		const expected = JSON.parse(JSON.stringify(record.messages));
		for (const message of expected) for (const block of message.content ?? []) if (block && typeof block === "object") delete block.thinkingSignature;
		assert.deepEqual(body.messages, expected);
		assert.equal(body.messages[1].content[0].thinking, "Considering the question.");
		assert.equal(body.messages[1].content[1].textSignature, "keep-me");
		assert.equal(fs.readFileSync(fileOf(id), "utf8"), bytes, "a GET never rewrites the file");
		assert.deepEqual(dirListing(), listing);
		assert.deepEqual(record, frozenCopy, "the store's own object is not mutated");
		assert.equal(chatStore.getChat(id)!.messages[1] && JSON.stringify(chatStore.getChat(id)!.messages).includes(signature), true, "the stored record keeps its signatures");
	});
	it("withoutThinkingSignatures reuses every object it doesn't change and returns the same array when nothing carries one", () => {
		const plain = { id: "p", role: "assistant", content: [{ type: "text", text: "x" }] };
		const user = { id: "u", role: "user", content: "hi" };
		const unsigned = thinkingAssistant("n", false);
		const signed = thinkingAssistant("s");
		const clean = [user, plain, unsigned] as never[];
		assert.equal(withoutThinkingSignatures(clean), clean);
		const input = Object.freeze([user, plain, signed, unsigned]) as never[];
		const out = withoutThinkingSignatures(input) as unknown as Record<string, unknown>[];
		assert.equal(out[0], user);
		assert.equal(out[1], plain);
		assert.equal(out[3], unsigned);
		assert.notEqual(out[2], signed);
		const blocks = out[2]!.content as Record<string, unknown>[];
		assert.equal("thinkingSignature" in blocks[0]!, false);
		assert.equal(blocks[1], (signed.content as unknown[])[1], "untouched blocks are reused");
		assert.equal((signed.content[0] as Record<string, unknown>).thinkingSignature, signature, "the input is not mutated");
	});
	it("side threads carry plain text only, so they pass through unchanged", async () => {
		const id = seed("side");
		chatStore.updateSideChats(id, () => [{ id: "s1", anchor: { kind: "free" }, open: true, createdAt: "x", messages: [{ id: "m1", role: "user", text: "why?", at: "x" }] } as never]);
		const body = await (await get(id)).json();
		assert.deepEqual(body.sideChats, chatStore.getChat(id)!.sideChats);
	});
});

describe("the composite stamp covers what is not in the file", () => {
	const stampOf = async (id: string) => (await (await get(id, "?only=stamp")).json()).stamp as string;
	const wait = () => new Promise((resolve) => setTimeout(resolve, 5));
	const filePart = (stamp: string) => stamp.slice(0, stamp.lastIndexOf("."));

	it("is equal between the full GET, ?only=stamp and the page's helper, and stable with no change", async () => {
		const id = seed("composite equal");
		const full = (await (await get(id)).json()).stamp;
		assert.equal(await stampOf(id), full);
		assert.equal((await readBrowserState(id))!.stamp, full);
		assert.equal(await stampOf(id), await stampOf(id));
		assert.equal((await readBrowserState(id))!.stamp, (await readBrowserState(id))!.stamp);
		assert.equal(filePart(full), chatStamp(id));
		assert.equal(await readBrowserState("chat_missing_0000"), null);
	});
	it("changes when only turnError changes (no file write)", async () => {
		const id = seed("composite turn error");
		const bytes = fs.readFileSync(fileOf(id), "utf8");
		const before = await stampOf(id);
		rememberTurnFailure(id, "the model said no");
		try {
			const during = await stampOf(id);
			assert.notEqual(during, before);
			assert.equal(filePart(during), filePart(before), "the file part is unchanged");
			assert.equal((await (await get(id)).json()).turnError, "the model said no");
			assert.equal((await (await get(id)).json()).stamp, during);
		} finally { clearTurnFailure(id); }
		assert.equal(await stampOf(id), before, "clearing it returns to the old value");
		assert.equal(fs.readFileSync(fileOf(id), "utf8"), bytes);
	});
	const pendingQuestionMessage = () => {
		const occurrence = { messageId: "q-pose", contentIndex: 0, toolCallId: "q-call", toolName: "plugin_code" };
		const snapshot = {
			protocolVersion: 1, pluginId: "fixture", typeId: "code", label: "Code", variant: "probe", questionId: "q-question", occurrence, contractVersion: 1,
			input: { question: "Write code", payload: {} }, questionSchema: { type: "object" }, answerSchema: { type: "string" }, showThinking: false, requiresAnswerRefinement: false,
		};
		return { ...fauxAssistantMessage([fauxToolCall(occurrence.toolName, { question: "Write code", payload: {} }, { id: occurrence.toolCallId })], { stopReason: "toolUse" }), id: occurrence.messageId, lhQuestions: { "0": snapshot } };
	};
	const definition = preparePluginProblemType({ id: "code", label: "Coding problem", contractVersion: 1,
		tool: { toolName: "coding_problem", description: "Pose code" }, problemSchema: Type.Object({ starter: Type.String() }), submissionSchema: Type.String() });
	const problemInput = { statement: "Implement f", mode: "composition", modelSolution: "The solution", payload: { starter: "function f() {}" } };
	const problemMessages = (): unknown[] => [
		{ id: "a-pp", role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "pp", name: "coding_problem", arguments: problemInput }] },
		{ id: "r-pp", role: "toolResult", toolCallId: "pp", toolName: "coding_problem", content: [], isError: false, details: { pluginProblem: {
			protocolVersion: 1, problemId: "p-pp", pluginId: "coding", typeId: "code", label: "Coding problem", contractVersion: 1, input: problemInput,
			problemSchema: definition.problemSchema, submissionSchema: definition.submissionSchema, requiresSubmissionRefinement: false, requiresProcessing: true } } },
	];
	const threeStamps = async (id: string) => [
		(await (await get(id)).json()).stamp, (await (await get(id, "?only=stamp")).json()).stamp, (await readBrowserState(id))!.stamp,
	];

	it("is null in all three places while a plugin question is pending, and a string again once it is gone", async () => {
		const id = chatStore.createChat("composite plugin question").id;
		chatStore.saveMessages(id, [pendingQuestionMessage()] as never);
		const bytes = fs.readFileSync(fileOf(id), "utf8");
		const onlyStamp = await get(id, "?only=stamp");
		assert.equal(onlyStamp.status, 200);
		assert.deepEqual(await onlyStamp.json(), { stamp: null });
		for (const status of ["unavailable", "available"] as const) {
			resolveQuestion = status === "unavailable"
				? (() => ({ status: "unavailable" }))
				: (() => ({ status: "available", definition: { id: "code", contractVersion: 1 }, signal: new AbortController().signal, requireActive() {} }));
			assert.deepEqual(await threeStamps(id), [null, null, null]);
			assert.equal((await (await get(id)).json()).pluginQuestionAvailability.status, status, "the full GET still reports availability");
		}
		assert.equal(fs.readFileSync(fileOf(id), "utf8"), bytes, "neither read wrote the file");
		resolveQuestion = () => ({ status: "unavailable" });
		chatStore.saveMessages(id, [{ id: "u1", role: "user", content: "dismissed, moving on", timestamp: 1 }] as never);
		const after = await threeStamps(id);
		assert.equal(typeof after[0], "string");
		assert.deepEqual(after, [after[0], after[0], after[0]]);
	});
	it("is null in all three places while a plugin problem is active, and a string again once it is concluded", async () => {
		const id = chatStore.createChat("composite plugin problem").id;
		chatStore.saveMessages(id, problemMessages() as never);
		assert.ok(activeProblemOf(chatStore.getChat(id)!.messages)?.pluginProblem, "the fixture is an active plugin problem");
		assert.deepEqual(await threeStamps(id), [null, null, null]);
		assert.deepEqual(await (await get(id, "?only=stamp")).json(), { stamp: null });
		chatStore.saveMessages(id, [...problemMessages(),
			{ id: "a-c", role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "c1", name: PRACTICE_CONCLUDE_TOOL, arguments: { outcome: "solved" } }] },
			{ id: "r-c", role: "toolResult", toolCallId: "c1", toolName: PRACTICE_CONCLUDE_TOOL, content: [], isError: false },
		] as never);
		assert.equal(activeProblemOf(chatStore.getChat(id)!.messages), null);
		const after = await threeStamps(id);
		assert.equal(typeof after[0], "string");
		assert.deepEqual(after, [after[0], after[0], after[0]]);
	});
	it("changes when the file changes", async () => {
		const id = seed("composite file");
		const before = await stampOf(id);
		await wait();
		chatStore.renameChat(id, "renamed again");
		const after = await stampOf(id);
		assert.notEqual(after, before);
		assert.notEqual(filePart(after), filePart(before));
		assert.equal((await readBrowserState(id))!.stamp, after);
	});
});
