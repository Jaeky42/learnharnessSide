/**
 * Side-tutor fork (performance): the active-problem fold reads a per-history
 * index instead of scanning per tool call. These pin the new results to a
 * straightforward reference (the previous implementation, copied here), for
 * mutable arrays (the server's) and deep-frozen ones (the browser's, which
 * are cached), and pin that a mutable array is never answered from a cache.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import {
	activeProblemOccurrenceOf, activeProblemOf, newProblemDismissedMarker, pendingProblemDismissalOf,
	practiceProblemForCall, problemInputForConclude, PRACTICE_CONCLUDE_TOOL, PRACTICE_PROBLEM_TOOL, type LhMessage,
} from "../src/core/native-messages.ts";
import { copyImmutableData } from "../src/core/immutable-data.ts";
import { pluginProblemForCall, preparePluginProblemType } from "../src/core/plugin-problems.ts";
import type { PluginSubmissionOccurrence } from "../src/core/plugin-submissions.ts";

// ── the previous implementation, verbatim in behaviour ──────────────────────
type Msgs = readonly LhMessage[];
const cleanIds = (messages: Msgs) => {
	const ids = new Set<string>();
	for (const m of messages) if ((m as { role?: string }).role === "toolResult" && !(m as { isError?: boolean }).isError) ids.add((m as unknown as { toolCallId: string }).toolCallId);
	return ids;
};
function refProblemForCall(messages: Msgs, occurrence: PluginSubmissionOccurrence) {
	const owner = messages.find(message => message.id === occurrence.messageId && message.role === "assistant") as any;
	const call = owner?.content[occurrence.contentIndex];
	if (call?.type !== "toolCall" || call.id !== occurrence.toolCallId || call.name !== occurrence.toolName) return null;
	if (call.name === PRACTICE_PROBLEM_TOOL) return { input: call.arguments };
	const pluginProblem = pluginProblemForCall(messages, occurrence);
	return pluginProblem ? { input: pluginProblem.input, pluginProblem } : null;
}
function refActive(messages: Msgs) {
	const clean = cleanIds(messages);
	for (let mi = messages.length - 1; mi >= 0; mi--) {
		const m = messages[mi]! as any;
		if (m.role === "custom") { if (m.customType === "problem-dismissed") return null; continue; }
		if (m.role === "assistant") {
			for (let bi = m.content.length - 1; bi >= 0; bi--) {
				const block = m.content[bi];
				if (block.type !== "toolCall") continue;
				if (block.name === PRACTICE_CONCLUDE_TOOL) { if (clean.has(block.id)) return null; continue; }
				const occurrence = { messageId: m.id, contentIndex: bi, toolCallId: block.id, toolName: block.name };
				const problem = refProblemForCall(messages, occurrence);
				if (problem && clean.has(block.id)) return { occurrence, ...problem };
			}
		}
	}
	return null;
}
const refActiveOf = (messages: Msgs) => {
	const a = refActive(messages);
	return a ? { toolCallId: a.occurrence.toolCallId, input: a.input, ...(a.pluginProblem ? { pluginProblem: a.pluginProblem } : {}) } : null;
};
function refDismissal(messages: Msgs): string | null {
	const clean = cleanIds(messages);
	for (let mi = messages.length - 1; mi >= 0; mi--) {
		const m = messages[mi]! as any;
		if (m.role === "custom") { if (m.customType === "problem-dismissed") return m.details.problemCallId; continue; }
		if (m.role === "assistant") {
			for (let bi = m.content.length - 1; bi >= 0; bi--) {
				const block = m.content[bi];
				if (block.type !== "toolCall" && block.type !== "text") continue;
				if (block.type === "toolCall" && block.name === PRACTICE_CONCLUDE_TOOL) { if (clean.has(block.id)) return null; continue; }
				if (block.type === "toolCall" && clean.has(block.id) && refProblemForCall(messages, { messageId: m.id, contentIndex: bi, toolCallId: block.id, toolName: block.name })) return null;
			}
		}
	}
	return null;
}
function refInputForConclude(messages: Msgs, concludeCallId: string) {
	let mi = messages.findIndex(m => (m as any).role === "assistant" && (m as any).content.some((b: any) => b.type === "toolCall" && b.id === concludeCallId));
	if (mi < 0) return undefined;
	const at = mi, clean = cleanIds(messages);
	for (; mi >= 0; mi--) {
		const m = messages[mi]! as any;
		if (m.role !== "assistant") continue;
		const last = mi === at ? m.content.findIndex((b: any) => b.type === "toolCall" && b.id === concludeCallId) - 1 : m.content.length - 1;
		for (let bi = last; bi >= 0; bi--) {
			const block = m.content[bi];
			if (block.type !== "toolCall" || !clean.has(block.id)) continue;
			const problem = refProblemForCall(messages, { messageId: m.id, contentIndex: bi, toolCallId: block.id, toolName: block.name });
			if (!problem) continue;
			return problem.input ?? undefined;
		}
	}
	return undefined;
}

// ── fixtures ─────────────────────────────────────────────────────────────────
const definition = preparePluginProblemType({ id: "code", label: "Coding problem", contractVersion: 1,
	tool: { toolName: "coding_problem", description: "Pose code" }, problemSchema: Type.Object({ starter: Type.String() }), submissionSchema: Type.String() });
const input = { statement: "Implement f", mode: "composition", modelSolution: "The solution", payload: { starter: "function f() {}" } };
const snapshot = (problemId: string) => ({ protocolVersion: 1, problemId, pluginId: "coding", typeId: "code", label: "Coding problem", contractVersion: 1,
	input, problemSchema: definition.problemSchema, submissionSchema: definition.submissionSchema, requiresSubmissionRefinement: false, requiresProcessing: true });
const asst = (id: string, blocks: unknown[]) => ({ id, role: "assistant", content: blocks, stopReason: "toolUse" }) as unknown as LhMessage;
const result = (callId: string, toolName: string, error = false, details?: unknown) =>
	({ id: "r-" + callId, role: "toolResult", toolCallId: callId, toolName, content: [], isError: error, ...(details ? { details } : {}) }) as unknown as LhMessage;
const user = (text: string) => ({ id: "u-" + text, role: "user", content: text, timestamp: 0 }) as unknown as LhMessage;
const text = (t: string) => ({ type: "text", text: t });
const call = (id: string, name: string, args: unknown = {}) => ({ type: "toolCall", id, name, arguments: args });
const nativePose = (id: string, error = false) => [asst("a-" + id, [call(id, PRACTICE_PROBLEM_TOOL, { statement: "s " + id })]), result(id, PRACTICE_PROBLEM_TOOL, error)];
const pluginPose = (id: string, error = false) => [asst("a-" + id, [call(id, "coding_problem", input)]), result(id, "coding_problem", error, { pluginProblem: snapshot("p-" + id) })];
const conclude = (id: string, error = false) => [asst("a-" + id, [call(id, PRACTICE_CONCLUDE_TOOL, { outcome: "solved" })]), result(id, PRACTICE_CONCLUDE_TOOL, error)];
const plain = (id: string) => [asst("a-" + id, [text("hello"), call(id, "web_search", { q: "x" })]), result(id, "web_search")];

const histories: Record<string, LhMessage[]> = {
	empty: [],
	"no problem": [user("hi"), ...plain("t1"), ...plain("t2")],
	"open native problem": [user("hi"), ...plain("t1"), ...nativePose("p1")],
	"open plugin problem": [user("hi"), ...pluginPose("pp1"), ...plain("t1")],
	"concluded native": [...nativePose("p1"), ...conclude("c1")],
	"concluded plugin": [...pluginPose("pp1"), ...conclude("c1")],
	"dismissed": [...nativePose("p1"), newProblemDismissedMarker("p1")],
	"dismissed then new problem": [...nativePose("p1"), newProblemDismissedMarker("p1"), ...nativePose("p2")],
	"several problems": [...nativePose("p1"), ...conclude("c1"), ...pluginPose("pp2"), ...conclude("c2"), ...nativePose("p3"), ...plain("t")],
	"errored pose falls back to the older one": [...nativePose("p1"), ...nativePose("p2", true)],
	"errored conclude does not free": [...nativePose("p1"), ...conclude("c1", true)],
	"dangling pose (no result)": [...nativePose("p1"), asst("a-dangling", [call("d", PRACTICE_PROBLEM_TOOL, {})])],
	"plugin pose whose result sits in another batch": [...pluginPose("pp1").slice(0, 1), asst("a-between", [text("x")]), pluginPose("pp1")[1]!],
	"plugin result with a different tool name": [asst("a-x", [call("x", "coding_problem", input)]), result("x", "other", false, { pluginProblem: snapshot("p-x") })],
	"two assistants sharing an id": [asst("dup", [text("a")]), asst("dup", [call("pc", PRACTICE_PROBLEM_TOOL, {})]), result("pc", PRACTICE_PROBLEM_TOOL)],
	"batch with pose then conclude": [asst("batch", [call("p", PRACTICE_PROBLEM_TOOL, {}), call("c", PRACTICE_CONCLUDE_TOOL, {})]), result("p", PRACTICE_PROBLEM_TOOL), result("c", PRACTICE_CONCLUDE_TOOL)],
	"batch with conclude then pose": [asst("batch", [call("c", PRACTICE_CONCLUDE_TOOL, {}), call("p", PRACTICE_PROBLEM_TOOL, {})]), result("c", PRACTICE_CONCLUDE_TOOL), result("p", PRACTICE_PROBLEM_TOOL)],
};

/** Everything the fold exposes for one history. */
function observe(messages: Msgs) {
	const concludeIds = messages.flatMap(m => m.role === "assistant" ? (m as any).content.filter((b: any) => b.type === "toolCall" && b.name === PRACTICE_CONCLUDE_TOOL).map((b: any) => b.id as string) : []);
	const occurrences = messages.flatMap(m => m.role === "assistant" ? (m as any).content.map((b: any, i: number) => ({ messageId: m.id, contentIndex: i, toolCallId: b.id, toolName: b.name })) : []);
	return {
		active: activeProblemOf(messages), occurrence: activeProblemOccurrenceOf(messages), dismissal: pendingProblemDismissalOf(messages),
		forCall: occurrences.map(o => practiceProblemForCall(messages, o)),
		inputs: concludeIds.map(id => problemInputForConclude(messages, id)),
	};
}
function expected(messages: Msgs) {
	const concludeIds = messages.flatMap(m => m.role === "assistant" ? (m as any).content.filter((b: any) => b.type === "toolCall" && b.name === PRACTICE_CONCLUDE_TOOL).map((b: any) => b.id as string) : []);
	const occurrences = messages.flatMap(m => m.role === "assistant" ? (m as any).content.map((b: any, i: number) => ({ messageId: m.id, contentIndex: i, toolCallId: b.id, toolName: b.name })) : []);
	return {
		active: refActiveOf(messages), occurrence: refActive(messages)?.occurrence ?? null, dismissal: refDismissal(messages),
		forCall: occurrences.map(o => refProblemForCall(messages, o)),
		inputs: concludeIds.map(id => refInputForConclude(messages, id)),
	};
}

test("activeProblemOf and its neighbours equal the reference on every history shape, mutable and frozen", () => {
	for (const [name, messages] of Object.entries(histories)) {
		const want = expected(messages);
		assert.deepEqual(observe(messages), want, `${name} (mutable)`);
		const frozen = copyImmutableData(messages);
		assert.ok(Object.isFrozen(frozen), name);
		assert.deepEqual(observe(frozen), want, `${name} (frozen, first)`);
		assert.deepEqual(observe(frozen), want, `${name} (frozen, repeated)`);
	}
});

test("the shapes cover the cases they claim to", () => {
	assert.equal(activeProblemOf(histories["no problem"]!), null);
	assert.equal(activeProblemOf(histories["open native problem"]!)?.toolCallId, "p1");
	assert.equal(activeProblemOf(histories["open plugin problem"]!)?.pluginProblem?.problemId, "p-pp1");
	assert.equal(activeProblemOf(histories["concluded native"]!), null);
	assert.equal(activeProblemOf(histories.dismissed!), null);
	assert.equal(activeProblemOf(histories["dismissed then new problem"]!)?.toolCallId, "p2");
	assert.equal(activeProblemOf(histories["several problems"]!)?.toolCallId, "p3");
	assert.equal(activeProblemOf(histories["errored pose falls back to the older one"]!)?.toolCallId, "p1");
	assert.equal(activeProblemOf(histories["plugin pose whose result sits in another batch"]!), null);
	assert.equal(activeProblemOf(histories["two assistants sharing an id"]!), null);
});

test("random histories equal the reference (mutable and frozen)", () => {
	let seed = 12345;
	const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
	for (let run = 0; run < 250; run++) {
		const messages: LhMessage[] = [];
		const length = 1 + rnd(9);
		for (let i = 0; i < length; i++) {
			const id = `x${run}-${i}`;
			switch (rnd(9)) {
				case 0: messages.push(...nativePose(id)); break;
				case 1: messages.push(...pluginPose(id)); break;
				case 2: messages.push(...nativePose(id, true)); break;
				case 3: messages.push(...conclude(id)); break;
				case 4: messages.push(...conclude(id, true)); break;
				case 5: messages.push(newProblemDismissedMarker(id)); break;
				case 6: messages.push(...plain(id)); break;
				case 7: messages.push(user(id)); break;
				default: messages.push(asst("a-" + id, [call(id, PRACTICE_PROBLEM_TOOL, {})])); // dangling
			}
		}
		const want = expected(messages);
		assert.deepEqual(observe(messages), want, `run ${run} mutable`);
		assert.deepEqual(observe(copyImmutableData(messages)), want, `run ${run} frozen`);
	}
});

test("a mutable history is never answered from a cache: pushing messages changes the answer", () => {
	const messages: LhMessage[] = [user("hi"), ...plain("t1")];
	assert.equal(activeProblemOf(messages), null);
	assert.equal(activeProblemOccurrenceOf(messages), null);
	messages.push(...nativePose("p1"));
	assert.equal(activeProblemOf(messages)?.toolCallId, "p1");
	assert.equal(activeProblemOccurrenceOf(messages)?.toolCallId, "p1");
	messages.push(...conclude("c1"));
	assert.equal(activeProblemOf(messages), null);
	// in place: flip a result from errored to clean, and edit a block
	const posed = nativePose("p2", true); messages.push(...posed);
	assert.equal(activeProblemOf(messages), null);
	(posed[1] as { isError: boolean }).isError = false;
	assert.equal(activeProblemOf(messages)?.toolCallId, "p2");
	assert.equal(pendingProblemDismissalOf([...messages, newProblemDismissedMarker("p2")]), "p2");
});

test("a frozen history's repeated calls return equal answers, and the occurrence is a fresh object each time", () => {
	const frozen = copyImmutableData([...pluginPose("pp1")]);
	const a = activeProblemOccurrenceOf(frozen), b = activeProblemOccurrenceOf(frozen);
	assert.deepEqual(a, b); assert.notEqual(a, b);
	assert.equal(Object.isFrozen(a), false);
	assert.equal(activeProblemOf(frozen)?.pluginProblem, activeProblemOf(frozen)?.pluginProblem);
});
