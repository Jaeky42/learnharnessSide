/** FORK (empty reply): the guard's pure rules. Synthetic fixtures only. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	EMPTY_REPLY_NUDGE_TEXT, EMPTY_REPLY_TEXT, emptyReplyGuardApplies, emptyReplyLogLine, hasOutput, isEmptyReply,
	makeEmptyReplyGuard, textPhases,
} from "../src/agent/empty-reply-guard.ts";
import { isGuardedEmptyReply } from "../src/core/index.ts";

const thinking = { type: "thinking", thinking: "Private reasoning about Mercury." };
const text = (t: string, textSignature?: string) => ({ type: "text", text: t, ...(textSignature ? { textSignature } : {}) });
const call = { type: "toolCall", id: "c1", name: "quiz", arguments: {} };
const reply = (content: unknown[], stopReason = "stop") => ({ role: "assistant", content, stopReason }) as unknown as AgentMessage;
const sig = (phase?: string) => JSON.stringify({ v: 1, id: "msg_x", ...(phase ? { phase } : {}) });

describe("which models", () => {
	for (const [provider, applies] of [["chatgpt", true], ["openai", true], ["anthropic", false], ["claude-code", false], ["openrouter", false], ["openai-codex", false], ["custom-endpoint", false], ["faux", false]] as const) {
		it(`${provider}: ${applies}`, () => assert.equal(emptyReplyGuardApplies({ provider }), applies));
	}
});

describe("what an empty reply is", () => {
	it("thinking only, or nothing at all", () => {
		assert.equal(isEmptyReply(reply([thinking])), true);
		assert.equal(isEmptyReply(reply([])), true);
	});
	it("whitespace-only text counts as empty", () => {
		assert.equal(isEmptyReply(reply([thinking, text("  \n\t ")])), true);
		assert.equal(isEmptyReply(reply([text("")])), true);
	});
	it("text or a tool call is output", () => {
		assert.equal(isEmptyReply(reply([thinking, text("Hello.")])), false);
		assert.equal(isEmptyReply(reply([call])), false);
		assert.equal(hasOutput(reply([text(" x ")])), true);
		assert.equal(hasOutput(reply([thinking])), false);
	});
	for (const stop of ["error", "aborted", "length", "toolUse"]) {
		it(`never for stopReason ${stop}`, () => assert.equal(isEmptyReply(reply([thinking], stop)), false));
	}
	it("never for a non-assistant message", () => {
		assert.equal(isEmptyReply({ role: "user", content: [] } as unknown as AgentMessage), false);
		assert.equal(isEmptyReply({ role: "toolResult", content: [], stopReason: "stop" } as unknown as AgentMessage), false);
	});
});

describe("phase labels", () => {
	it("reads each text block's phase, none where absent", () => {
		assert.equal(textPhases(reply([text("a", sig("commentary")), text("b", sig("final_answer"))])), "commentary, final_answer");
		assert.equal(textPhases(reply([text("a"), text("b", sig()), text("c", "legacy-id"), text("d", "{broken")])), "none, none, none, none");
		assert.equal(textPhases(reply([thinking, call])), "none");
		assert.equal(textPhases(undefined), "none");
	});
});

describe("the log line", () => {
	it("has exactly the agreed facts", () => {
		assert.equal(
			emptyReplyLogLine({ provider: "chatgpt", modelId: "gpt-6.2-astra", kind: "teacher", count: 1, action: "nudging", thinking: false, phasesBefore: "commentary" }),
			"[LearnHarness] Empty reply: chatgpt:gpt-6.2-astra; teacher; empty reply 1; nudging; thinking: no; phases before: commentary",
		);
	});
});

/** A minimal run: one context, the loop's newMessages and the agent state. */
function run(options: { provider?: string; background?: () => boolean } = {}) {
	const lines: string[] = [];
	const guard = makeEmptyReplyGuard({ model: { provider: options.provider ?? "chatgpt", id: "gpt-6.2-astra" }, kind: "teacher", isBackground: options.background ?? (() => false), log: (l) => lines.push(l) });
	const before = { role: "assistant", content: [text("Here is the idea about Mercury.", sig("final_answer")), call], stopReason: "toolUse" } as unknown as AgentMessage;
	const answer = { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "Learner said Mercury" }] } as unknown as AgentMessage;
	const context = { messages: [before, answer] };
	const newMessages: AgentMessage[] = [];
	const agent = { state: { messages: [before, answer] } };
	const turn = (message: AgentMessage) => {
		context.messages.push(message); newMessages.push(message); agent.state.messages = [...agent.state.messages, message];
		return guard.finishTurn({ message, context, newMessages }, agent);
	};
	return { lines, turn, context, newMessages, agent, guard };
}

describe("the decision", () => {
	it("drops the first empty reply, arms the nudge for one request, then marks the nudged empty reply failed", () => {
		const r = run();
		const first = reply([thinking]);
		assert.equal(r.guard.nudgePending, false);
		assert.deepEqual(r.turn(first), { action: "continue" });
		assert.ok(!r.context.messages.includes(first) && !r.newMessages.includes(first) && !r.agent.state.messages.includes(first), "dropped everywhere");
		assert.equal(r.guard.nudgePending, true, "the next request carries the nudge");
		const second = reply([]);
		assert.deepEqual(r.turn(second), { action: "end" });
		assert.equal(r.guard.nudgePending, false);
		assert.equal((second as { stopReason: string }).stopReason, "error");
		assert.equal((second as { errorMessage: string }).errorMessage, EMPTY_REPLY_TEXT);
		assert.ok(r.context.messages.includes(second) && r.agent.state.messages.includes(second), "the nudged one stays, failed");
		assert.deepEqual(r.lines.map((l) => l.split("; ").slice(2, 4).join("; ")), ["empty reply 1; nudging", "empty reply 2; giving up"]);
		assert.ok(r.lines[0]!.endsWith("; thinking: yes; phases before: final_answer"), r.lines[0]);
		assert.ok(r.lines[1]!.endsWith("; thinking: no; phases before: final_answer"), r.lines[1]);
		for (const line of r.lines) {
			assert.ok(line.startsWith("[LearnHarness] Empty reply: chatgpt:gpt-6.2-astra; teacher; "));
			assert.ok(!/Mercury|idea|Learner|c1|msg_x|Private|Continue/.test(line), "no message text, ids or the nudge");
		}
	});

	it("the instruction, word for word", () => {
		assert.equal(EMPTY_REPLY_NUDGE_TEXT, "Continue. (Your previous reply was empty; respond to the learner's last input now and do not mention this note.)");
	});

	it("the nudge joins exactly one conversion, at the end, as a user message, and never the input", () => {
		const r = run();
		const convert = r.guard.withNudge((messages) => messages.map((m) => ({ role: "user", content: [{ type: "text", text: String((m as { role: string }).role) }], timestamp: 0 })) as never);
		const input = [{ role: "user", content: "Teach me", timestamp: 0 }] as unknown as AgentMessage[];
		assert.equal(convert(input).length, 1, "not armed: unchanged");
		r.turn(reply([thinking]));
		const nudged = convert(input);
		assert.equal(nudged.length, 2);
		assert.deepEqual({ ...nudged[1], timestamp: 0 }, { role: "user", content: [{ type: "text", text: EMPTY_REPLY_NUDGE_TEXT }], timestamp: 0 });
		assert.equal(input.length, 1, "the context is never changed");
		assert.equal(r.guard.nudgePending, false, "used up by its request");
		assert.equal(convert(input).length, 1, "no later request carries it");
	});

	it("any reply clears an armed nudge (it can never ride a later request)", () => {
		const r = run();
		r.turn(reply([thinking]));
		assert.equal(r.guard.nudgePending, true);
		assert.equal(r.turn(reply([call], "toolUse")), undefined, "a nudged reply with a tool call");
		assert.equal(r.guard.nudgePending, false);
		const convert = r.guard.withNudge(() => []);
		assert.deepEqual(convert([]), []);
		const after = reply([]);
		assert.equal(r.turn(after), undefined, "an empty reply after it follows output: not nudged");
		assert.equal(r.lines.at(-1)!.split("; ")[3], "not retried: follows other output in this turn");
		const errored = run();
		errored.turn(reply([thinking]));
		errored.turn(reply([thinking], "error"));
		assert.equal(errored.guard.nudgePending, false);
	});

	it("the agent guard and the page agree on what is empty", () => {
		const samples = [reply([thinking]), reply([]), reply([text("  ")]), reply([text("Hi.")]), reply([call]), reply([thinking], "error"), reply([thinking], "toolUse"), reply([thinking], "length"), reply([thinking], "aborted"),
			{ role: "user", content: [] } as unknown as AgentMessage];
		for (const sample of samples) {
			for (const provider of ["chatgpt", "openai", "anthropic", "openrouter", "faux"]) {
				const m = { ...sample, provider } as unknown as AgentMessage;
				assert.equal(isGuardedEmptyReply(m as never), isEmptyReply(m) && emptyReplyGuardApplies({ provider }), `${provider} ${JSON.stringify(sample)}`);
			}
		}
	});

	it("an empty reply after a reply with output in this run is not nudged", () => {
		for (const earlier of [reply([call], "toolUse"), reply([text("Some words.")])]) {
			const r = run();
			assert.equal(r.turn(earlier), undefined);
			const empty = reply([]);
			assert.equal(r.turn(empty), undefined);
			assert.equal((empty as { stopReason: string }).stopReason, "stop");
			assert.ok(r.agent.state.messages.includes(empty));
			assert.deepEqual(r.lines, ["[LearnHarness] Empty reply: chatgpt:gpt-6.2-astra; teacher; empty reply 1; not retried: follows other output in this turn; thinking: no; phases before: none"]);
		}
	});

	it("earlier empty replies are not output", () => {
		const r = run();
		assert.deepEqual(r.turn(reply([thinking])), { action: "continue" });
		assert.equal(r.turn(reply([text("Now real words.")])), undefined);
		assert.equal(r.lines.length, 1);
		assert.equal(r.guard.nudgePending, false);
	});

	it("an automatic (background) request: not nudged, not logged", () => {
		const r = run({ background: () => true });
		const empty = reply([thinking]);
		assert.equal(r.turn(empty), undefined);
		assert.ok(r.agent.state.messages.includes(empty));
		assert.equal((empty as { stopReason: string }).stopReason, "stop");
		assert.deepEqual(r.lines, []);
		assert.equal(r.guard.nudgePending, false);
	});

	it("the purpose is read at each reply", () => {
		let background = false;
		const r = run({ background: () => background });
		assert.deepEqual(r.turn(reply([thinking])), { action: "continue" });
		background = true;
		assert.equal(r.turn(reply([thinking])), undefined);
		assert.equal(r.lines.length, 1);
	});

	it("never for stops other than stop", () => {
		for (const stop of ["error", "aborted", "length", "toolUse"]) {
			const r = run();
			const m = reply([thinking], stop);
			assert.equal(r.turn(m), undefined);
			assert.equal((m as { stopReason: string }).stopReason, stop);
			assert.deepEqual(r.lines, []);
		}
	});
});
