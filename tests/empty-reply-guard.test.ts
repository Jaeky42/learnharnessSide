/** FORK (empty reply): the guard's pure rules. Synthetic fixtures only. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	EMPTY_REPLY_MAX_RETRIES, EMPTY_REPLY_TEXT, emptyReplyGuardApplies, emptyReplyLogLine, hasOutput, isEmptyReply,
	makeEmptyReplyGuard, textPhases,
} from "../src/agent/empty-reply-guard.ts";

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
			emptyReplyLogLine({ provider: "chatgpt", modelId: "gpt-6.2-astra", kind: "teacher", count: 2, action: "retrying", thinking: true, phasesBefore: "final_answer" }),
			"[LearnHarness] Empty reply: chatgpt:gpt-6.2-astra; teacher; empty reply 2; retrying; thinking: yes; phases before: final_answer",
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
	return { lines, turn, context, newMessages, agent };
}

describe("the decision", () => {
	it("drops an empty reply and continues, up to the limit, then marks the last one failed", () => {
		const r = run();
		const replies = Array.from({ length: EMPTY_REPLY_MAX_RETRIES + 1 }, () => reply([thinking]));
		for (const [i, m] of replies.entries()) {
			const decision = r.turn(m);
			if (i < EMPTY_REPLY_MAX_RETRIES) {
				assert.deepEqual(decision, { action: "continue" });
				assert.ok(!r.context.messages.includes(m) && !r.newMessages.includes(m) && !r.agent.state.messages.includes(m), "dropped everywhere");
			} else {
				assert.deepEqual(decision, { action: "end" });
				assert.equal((m as { stopReason: string }).stopReason, "error");
				assert.equal((m as { errorMessage: string }).errorMessage, EMPTY_REPLY_TEXT);
				assert.ok(r.context.messages.includes(m) && r.agent.state.messages.includes(m), "the last one stays, failed");
			}
		}
		assert.equal(EMPTY_REPLY_MAX_RETRIES, 2);
		assert.deepEqual(r.lines.map((l) => l.split("; ").slice(2, 4).join("; ")), ["empty reply 1; retrying", "empty reply 2; retrying", "empty reply 3; giving up"]);
		for (const line of r.lines) {
			assert.ok(line.startsWith("[LearnHarness] Empty reply: chatgpt:gpt-6.2-astra; teacher; "));
			assert.ok(line.endsWith("; thinking: yes; phases before: final_answer"), line);
			assert.ok(!/Mercury|idea|Learner|c1|msg_x|Private/.test(line), "no message text or ids");
		}
	});

	it("an empty reply after a reply with output in this run is not retried", () => {
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
	});

	it("an automatic (background) request: not retried, not logged", () => {
		const r = run({ background: () => true });
		const empty = reply([thinking]);
		assert.equal(r.turn(empty), undefined);
		assert.ok(r.agent.state.messages.includes(empty));
		assert.equal((empty as { stopReason: string }).stopReason, "stop");
		assert.deepEqual(r.lines, []);
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
