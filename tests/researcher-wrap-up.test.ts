/**
 * Researcher wrap-up: a run whose last message has no text gets ONE more
 * request to write its brief. Since upstream 0.7.0 the researcher has no turn
 * limit (owner's decision), so a run can no longer end on a capped tool call.
 * Scripted, zero network.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type AssistantMessage,
	type FauxResponseStep,
	type Usage,
} from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import type { SearchProvider } from "../src/core/search.ts";
import { RESEARCH_WRAP_UP_MESSAGE, runResearcherAgent } from "../src/agent/subagents/researcher.ts";
import { runSubagent } from "../src/agent/subagents/pi-run.ts";

const BRIEF = "## Summary\nThe brief.\n\n## Gaps\nNone.";
const WRAP_BRIEF = "## Summary\nWrap-up brief.\n\n## Gaps\nSome.";

interface Seen {
	messages: Array<{ role: string; content: unknown }>;
	tools?: unknown[];
}

function engine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

/** A step that records the request context, then answers with `message`. */
function capturing(seen: Seen[], message: AssistantMessage): FauxResponseStep {
	const factory = (context: Seen) => {
		seen.push({ messages: [...context.messages], tools: context.tools });
		return message;
	};
	return factory as unknown as FauxResponseStep;
}

function stubSearch(): SearchProvider & { queries: string[] } {
	const queries: string[] = [];
	return {
		id: "tavily",
		async search(query: string, count: number) {
			queries.push(`${query} (${count})`);
			return [{ title: "sigma.js", url: "https://www.sigmajs.org/", snippet: "v3 released" }];
		},
		queries,
	};
}

function toolTurn(n: number, text?: string): AssistantMessage {
	const blocks = [
		...(text ? [fauxText(text)] : []),
		fauxToolCall("web_search", { query: `q${n}` }, { id: `ws${n}` }),
	];
	return fauxAssistantMessage(blocks, { stopReason: "toolUse" });
}

function toolTurns(count: number): AssistantMessage[] {
	return Array.from({ length: count }, (_, i) => toolTurn(i));
}

async function run(steps: FauxResponseStep[], opts: { abortSignal?: AbortSignal } = {}) {
	const search = stubSearch();
	const calls: Usage[] = [];
	const text = await runResearcherAgent("research it", {
		engine: engine(steps),
		search: () => search,
		onUsage: (u) => calls.push(u),
		abortSignal: opts.abortSignal,
	});
	return { text, calls: calls.length, search };
}

function lastUserText(seen: Seen): string | undefined {
	const last = seen.messages[seen.messages.length - 1];
	if (!last || last.role !== "user") return undefined;
	const c = last.content;
	if (typeof c === "string") return c;
	return (c as Array<{ type: string; text?: string }>).filter((b) => b.type === "text").map((b) => b.text).join("");
}

function wrapUpSent(seen: Seen[]): boolean {
	return seen.some((s) => s.messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes(RESEARCH_WRAP_UP_MESSAGE)));
}

describe("researcher wrap-up", () => {
	it("the wrap-up text is the approved one", () => {
		assert.equal(
			RESEARCH_WRAP_UP_MESSAGE,
			"Your last message contained no brief. Do not call any more tools. Write your final brief now, in the required format, using only what you have already gathered. If something could not be established, say so under Gaps.",
		);
	});

	it("control: tool turns then a brief returns it with no extra call", async () => {
		const seen: Seen[] = [];
		const { text, calls } = await run([...toolTurns(3), capturing(seen, fauxAssistantMessage([fauxText(BRIEF)]))]);
		assert.equal(text, BRIEF);
		assert.equal(calls, 4);
		assert.equal(wrapUpSent(seen), false);
	});

	it("no turn limit: 20 tool turns, then a brief, with no wrap-up", async () => {
		const seen: Seen[] = [];
		const { text, calls, search } = await run([...toolTurns(20), capturing(seen, fauxAssistantMessage([fauxText(BRIEF)]))]);
		assert.equal(text, BRIEF);
		assert.equal(calls, 21);
		assert.equal(search.queries.length, 20);
		assert.equal(wrapUpSent(seen), false);
	});

	it("B: a thinking-only final message gets a wrap-up", async () => {
		const seen: Seen[] = [];
		const { text, calls } = await run([
			...toolTurns(2),
			fauxAssistantMessage([fauxThinking("hmm")]),
			capturing(seen, fauxAssistantMessage([fauxText(WRAP_BRIEF)])),
		]);
		assert.equal(text, WRAP_BRIEF);
		assert.equal(calls, 4);
		assert.equal(seen.length, 1);
		assert.equal(lastUserText(seen[0]!), RESEARCH_WRAP_UP_MESSAGE);
		// Tool declarations travel as system messages in the transcript.
		const sys = seen[0]!.messages as Array<{ role: string; toolsAdded?: Array<{ name: string }>; toolsRemoved?: unknown[] }>;
		const added = sys.filter((m) => m.role === "system").flatMap((m) => m.toolsAdded ?? []);
		assert.ok(added.some((t) => t.name === "web_search"), "tools are still declared");
		assert.ok(!sys.some((m) => m.toolsRemoved?.length), "no tool was removed");
	});

	it("C: brief plus a tool call, then a thinking-only closing message", async () => {
		const seen: Seen[] = [];
		const { text } = await run([
			toolTurn(0, BRIEF),
			fauxAssistantMessage([fauxThinking("done")]),
			capturing(seen, fauxAssistantMessage([fauxText(WRAP_BRIEF)])),
		]);
		assert.equal(text, WRAP_BRIEF);
		assert.equal(lastUserText(seen[0]!), RESEARCH_WRAP_UP_MESSAGE);
	});

	it("D: a final message cut by length with only thinking gets a wrap-up", async () => {
		const seen: Seen[] = [];
		const { text } = await run([
			...toolTurns(1),
			fauxAssistantMessage([fauxThinking("a long thought")], { stopReason: "length" }),
			capturing(seen, fauxAssistantMessage([fauxText(WRAP_BRIEF)])),
		]);
		assert.equal(text, WRAP_BRIEF);
		assert.equal(lastUserText(seen[0]!), RESEARCH_WRAP_UP_MESSAGE);
	});

	it("a tool call in the wrap-up reply is refused and the run ends", async () => {
		const { text, calls, search } = await run([
			...toolTurns(2),
			fauxAssistantMessage([fauxThinking("hmm")]),
			fauxAssistantMessage(
				[fauxText(WRAP_BRIEF), fauxToolCall("web_search", { query: "distinctive-wrap-up-query" }, { id: "late" })],
				{ stopReason: "toolUse" },
			),
		]);
		assert.equal(text, WRAP_BRIEF);
		assert.equal(calls, 4);
		assert.ok(!search.queries.some((q) => q.includes("distinctive-wrap-up-query")));
		assert.equal(search.queries.length, 2);
	});

	it("a wrap-up reply with no text resolves to an empty string, with one wrap-up only", async () => {
		const seen: Seen[] = [];
		const { text, calls } = await run([
			...toolTurns(2),
			fauxAssistantMessage([fauxThinking("hmm")]),
			capturing(seen, fauxAssistantMessage([fauxThinking("nothing to say")])),
		]);
		assert.equal(text, "");
		assert.equal(calls, 4);
		assert.equal(seen.length, 1);
	});

	it("an abort during the wrap-up rejects with an AbortError", async () => {
		const controller = new AbortController();
		const stuck = (_context: unknown, options: { signal?: AbortSignal } | undefined) =>
			new Promise<AssistantMessage>((resolve) => {
				const sig = options?.signal;
				const done = () => resolve(fauxAssistantMessage("late"));
				if (sig?.aborted) return done();
				sig?.addEventListener("abort", done, { once: true });
				setTimeout(() => controller.abort(), 20);
			});
		await assert.rejects(
			run([...toolTurns(2), fauxAssistantMessage([fauxThinking("hmm")]), stuck as unknown as FauxResponseStep], { abortSignal: controller.signal }),
			(err: Error) => err.name === "AbortError",
		);
	});

	it("a provider error in the normal run rejects and sends no wrap-up", async () => {
		const seen: Seen[] = [];
		await assert.rejects(
			run([
				...toolTurns(1),
				fauxAssistantMessage([fauxToolCall("web_search", { query: "x" }, { id: "e" })], {
					stopReason: "error",
					errorMessage: "provider exploded",
				}),
				capturing(seen, fauxAssistantMessage([fauxText(WRAP_BRIEF)])),
			]),
			/provider exploded/,
		);
		assert.equal(seen.length, 0);
	});

	it("runSubagent without wrapUp ends on the capped tool call with empty text and no extra call", async () => {
		const noop: AgentTool<any, any> = {
			name: "noop",
			label: "noop",
			description: "does nothing",
			parameters: { type: "object", properties: {} } as never,
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};
		const steps: FauxResponseStep[] = [
			...Array.from({ length: 3 }, (_, i) =>
				fauxAssistantMessage([fauxToolCall("noop", {}, { id: `n${i}` })], { stopReason: "toolUse" }),
			),
			fauxAssistantMessage([fauxText("never reached")]),
		];
		let calls = 0;
		const result = await runSubagent([noop], {
			engine: engine(steps),
			systemPrompt: "x",
			prompt: "go",
			maxTurns: 3,
			onUsage: () => {
				calls++;
			},
		});
		assert.equal(result.text, "");
		assert.equal(calls, 3);
	});
});
