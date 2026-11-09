/**
 * SIDE TUTOR PINS — the side-window Q&A agent.
 *
 *  1. The lesson snapshot shows the open question as the learner sees it,
 *     and NEVER its committed answer or explanation.
 *  2. Answers already revealed to the learner ride along.
 *  3. The budget drops the oldest lesson content first.
 *  4. Isolation: a side question streams, saves to its OWN thread, and
 *     leaves the session record (the main teacher's whole context)
 *     byte-for-byte untouched.
 *  5. Session deletion discards the side thread.
 *
 * Runs under an isolated LH_DATA_DIR with a scripted faux engine — zero
 * tokens, no network.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-side-tutor-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { sideTutorStore } = await import("../src/store/side-tutor.ts");
const { lessonSnapshot, sideHistoryText } = await import("../src/core/side-tutor.ts");
const { toLlmMessages } = await import("../src/core/native-messages.ts");
const { sideTutorPostResponse, sideTutorThreadResponse, clearSideTutorResponse } = await import("../src/server/side-tutor.ts");
const { deleteChatSession } = await import("../src/server/chats.ts");
type LhMessage = import("../src/core/native-messages.ts").LhMessage;

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

let seq = 0;
function teacher(text: string, calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = []): LhMessage {
	return {
		id: `m_${++seq}`,
		role: "assistant",
		content: [{ type: "text", text }, ...calls.map((c) => ({ type: "toolCall" as const, ...c }))],
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage: USAGE,
		stopReason: calls.length > 0 ? "toolUse" : "stop",
		timestamp: Date.now(),
	} as LhMessage;
}

function learner(text: string): LhMessage {
	return { id: `m_${++seq}`, role: "user", content: text, timestamp: Date.now() } as LhMessage;
}

function quizResult(toolCallId: string, details: Record<string, unknown>): LhMessage {
	return {
		id: `m_${++seq}`,
		role: "toolResult",
		toolCallId,
		toolName: "quiz",
		content: [{ type: "text", text: "answered" }],
		details,
		isError: false,
		timestamp: Date.now(),
	} as LhMessage;
}

const SECRET_EXPLANATION = "SECRET_EXPLANATION_accrual-matching";
function quizCall(id: string) {
	return {
		id,
		name: "quiz",
		arguments: {
			type: "check",
			nodeId: "revenue-recognition",
			question: "When is revenue recognized under ASC 606?",
			options: [
				{ label: "When cash is received", value: "SECRET_VALUE_cash" },
				{ label: "When a performance obligation is satisfied", value: "SECRET_VALUE_po" },
			],
			explanation: SECRET_EXPLANATION,
			correctAnswer: "SECRET_VALUE_po",
		},
	};
}

describe("lesson snapshot", () => {
	it("shows the open question without its answer, explanation, or option values", () => {
		const messages = [learner("teach me ASC 606"), teacher("Revenue follows the five-step model.", [quizCall("q_open")])];
		const snap = lessonSnapshot(messages, { title: "FAR — revenue" });
		assert.equal(snap.hasOpenQuestion, true);
		assert.match(snap.text, /When is revenue recognized under ASC 606\?/);
		assert.match(snap.text, /When a performance obligation is satisfied/);
		assert.match(snap.text, /five-step model/);
		assert.doesNotMatch(snap.text, /SECRET_/);
	});

	it("includes what was revealed after the learner answered", () => {
		const messages = [teacher("Check:", [quizCall("q_done")]), quizResult("q_done", { questionText: "When…?", correct: false })];
		const snap = lessonSnapshot(messages);
		assert.equal(snap.hasOpenQuestion, false);
		assert.match(snap.text, new RegExp(SECRET_EXPLANATION));
		assert.match(snap.text, /answered incorrectly/);
	});

	it("does not reveal a skipped check", () => {
		const messages = [teacher("Check:", [quizCall("q_skip")]), quizResult("q_skip", { questionText: "When…?", dismissed: true })];
		assert.doesNotMatch(lessonSnapshot(messages).text, /SECRET_/);
	});

	it("drops the oldest lesson content first when over budget", () => {
		const messages = [teacher(`OLDEST ${"a".repeat(400)}`), teacher(`MIDDLE ${"b".repeat(400)}`), teacher(`NEWEST ${"c".repeat(400)}`)];
		const snap = lessonSnapshot(messages, { budgetChars: 900 });
		assert.equal(snap.truncated, true);
		assert.doesNotMatch(snap.text, /OLDEST/);
		assert.match(snap.text, /NEWEST/);
	});

	it("history text skips errors and marks aborted partials", () => {
		const text = sideHistoryText([
			{ id: "1", question: "q1", answer: "a1", status: "done", askedAt: "" },
			{ id: "2", question: "q2", answer: "", status: "error", error: "x", askedAt: "" },
			{ id: "3", question: "q3", answer: "partial", status: "aborted", askedAt: "" },
		]);
		assert.ok(text);
		assert.match(text, /q1/);
		assert.doesNotMatch(text, /q2/);
		assert.match(text, /cut off/);
	});
});

/** pi seeds the system prompt as a leading system-role message. */
function systemOf(context: { systemPrompt?: string; messages: unknown[] }): string {
	const seeded = context.messages
		.filter((m) => (m as { role?: string }).role === "system")
		.map((m) => JSON.stringify((m as { content?: unknown }).content))
		.join("\n");
	return [context.systemPrompt ?? "", seeded].join("\n");
}

async function readStream(res: Response): Promise<Array<{ type: string; [k: string]: unknown }>> {
	const raw = await res.text();
	return raw
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));
}

describe("side tutor service", () => {
	it("answers from the lesson and leaves the session record untouched", async () => {
		const chat = chatStore.createChat("FAR — revenue");
		const messages = [learner("teach me ASC 606"), teacher("Revenue follows the five-step model.", [quizCall("q_live")])];
		chatStore.saveMessages(chat.id, messages);
		const before = fs.readFileSync(path.join(TMP_DATA, "chats", `${chat.id}.json`), "utf-8");
		const llmBefore = JSON.stringify(toLlmMessages(chatStore.getChat(chat.id)!.messages));

		const seenSystemPrompts: string[] = [];
		const seenUserTurns: string[] = [];
		const faux = createFauxCore({});
		faux.setResponses([
			(context) => {
				seenSystemPrompts.push(systemOf(context));
				seenUserTurns.push(JSON.stringify(context.messages.filter((m) => (m as { role: string }).role === "user")));
				return fauxAssistantMessage([fauxText("A performance obligation is a promise to transfer a good or service.")]);
			},
			(context) => {
				seenSystemPrompts.push(systemOf(context));
				return fauxAssistantMessage([fauxText("Step one is identifying the contract.")]);
			},
		]);
		const engine = { model: faux.getModel(), streamFn: faux.streamSimple, level: "off" as const };

		const res = await sideTutorPostResponse(
			chat.id,
			new Request("http://x", { method: "POST", body: JSON.stringify({ question: "What is a performance obligation?" }) }),
			{ engine },
		);
		assert.equal(res.status, 200);
		const events = await readStream(res);
		const done = events.find((e) => e.type === "done") as { entry: { answer: string; status: string } } | undefined;
		assert.ok(done, "a done event");
		assert.equal(done.entry.status, "done");
		assert.match(done.entry.answer, /performance obligation is a promise/);

		// The side agent saw the lesson — but not the open check's answer key.
		assert.match(seenSystemPrompts[0]!, /five-step model/);
		assert.match(seenSystemPrompts[0]!, /When is revenue recognized/);
		assert.doesNotMatch(seenSystemPrompts[0]!, /SECRET_/);
		assert.match(seenUserTurns[0]!, /What is a performance obligation\?/);

		// ISOLATION: the session record — and so the teacher's context — is unchanged.
		const afterRaw = fs.readFileSync(path.join(TMP_DATA, "chats", `${chat.id}.json`), "utf-8");
		assert.equal(afterRaw, before);
		const llmAfter = JSON.stringify(toLlmMessages(chatStore.getChat(chat.id)!.messages));
		assert.equal(llmAfter, llmBefore);
		assert.doesNotMatch(llmAfter, /performance obligation is a promise/);

		// The side thread holds the exchange, and the next question carries it.
		assert.equal(sideTutorStore.read(chat.id).entries.length, 1);
		const res2 = await sideTutorPostResponse(
			chat.id,
			new Request("http://x", { method: "POST", body: JSON.stringify({ question: "And step one?" }) }),
			{ engine },
		);
		await readStream(res2);
		assert.match(seenSystemPrompts[1]!, /What is a performance obligation\?/);
		const thread = (await sideTutorThreadResponse(chat.id).json()) as { entries: unknown[]; running: boolean };
		assert.equal(thread.entries.length, 2);
		assert.equal(thread.running, false);

		// Clearing empties the thread without touching the session.
		assert.equal(clearSideTutorResponse(chat.id).status, 200);
		assert.equal(sideTutorStore.read(chat.id).entries.length, 0);
		assert.equal(fs.readFileSync(path.join(TMP_DATA, "chats", `${chat.id}.json`), "utf-8"), before);
	});

	it("refuses empty questions and unknown chats", async () => {
		const chat = chatStore.createChat("empty");
		const empty = await sideTutorPostResponse(chat.id, new Request("http://x", { method: "POST", body: JSON.stringify({ question: "   " }) }));
		assert.equal(empty.status, 400);
		const unknown = await sideTutorPostResponse(
			"chat_nope",
			new Request("http://x", { method: "POST", body: JSON.stringify({ question: "hi" }) }),
		);
		assert.equal(unknown.status, 404);
	});

	it("session deletion discards the side thread", async () => {
		const chat = chatStore.createChat("doomed");
		sideTutorStore.append(chat.id, { id: "e1", question: "q", answer: "a", status: "done", askedAt: new Date().toISOString() });
		const file = path.join(TMP_DATA, "side-tutor", `${chat.id}.json`);
		assert.ok(fs.existsSync(file));
		const outcome = await deleteChatSession(chat.id, "preserve-graph");
		assert.equal(outcome.ok, true);
		assert.equal(fs.existsSync(file), false);
	});
});
