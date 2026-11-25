import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { emptyReplyProviderApplies, isEmptyReply, replyHasOutput } from "../core/empty-reply.ts";

/**
 * FORK (empty reply): an empty reply is asked again with a nudge
 * (docs/fork/models-and-agents.md, "ChatGPT and OpenAI: an empty reply is
 * asked again"). A ChatGPT or OpenAI reply that ended normally with no text
 * and no tool call ends the agent loop, and the lesson would wait for the
 * learner. For the lesson's own agents (prober, teacher, practice) the reply
 * is dropped and ONE more request is sent in the same turn, with
 * EMPTY_REPLY_NUDGE_TEXT added as a user message at the end of that one
 * request only (withNudge wraps the model-facing conversion). Still empty,
 * that reply is saved as a failed reply. Nothing new is stored: the nudge is
 * never in the agent's state, the record or the wire. Agent layer only: no
 * server imports. What "empty" means lives in src/core/empty-reply.ts, which
 * the page shares.
 */

/** The owner's approved sentence, word for word. */
export const EMPTY_REPLY_TEXT = "The teacher returned an empty reply. Retry when ready.";

/** The hidden instruction the one nudged request carries, word for word. */
export const EMPTY_REPLY_NUDGE_TEXT = "Continue. (Your previous reply was empty; respond to the learner's last input now and do not mention this note.)";

export { isEmptyReply, replyHasOutput as hasOutput };

/** ChatGPT (plan sign-in) and OpenAI (API key) only. */
export function emptyReplyGuardApplies(model: { provider: string }): boolean {
	return emptyReplyProviderApplies(model.provider);
}

type Block = { type: string; text?: string; textSignature?: string };
type Reply = { role?: string; stopReason?: string; content?: unknown };

function blocksOf(message: Reply): Block[] {
	return Array.isArray(message.content) ? (message.content as Block[]) : [];
}

/** The phase label of each text block (from its OpenAI text signature,
 * `{"v":1,"id":…,"phase":…}`), "none" where it has none. "none" when the
 * message has no text block. Labels only, never the text. */
export function textPhases(message: Reply | undefined): string {
	const phases = (message ? blocksOf(message) : []).filter((b) => b.type === "text").map((b) => {
		if (typeof b.textSignature !== "string" || !b.textSignature.startsWith("{")) return "none";
		try {
			const parsed = JSON.parse(b.textSignature) as { phase?: unknown };
			return parsed.phase === "commentary" || parsed.phase === "final_answer" ? parsed.phase : "none";
		} catch {
			return "none";
		}
	});
	return phases.length ? phases.join(", ") : "none";
}

export type EmptyReplyAction = "nudging" | "giving up" | "not retried: follows other output in this turn";

export interface EmptyReplyLogFacts {
	provider: string;
	modelId: string;
	kind: string;
	/** Which empty reply of the run this is (1 or 2). */
	count: number;
	action: EmptyReplyAction;
	thinking: boolean;
	/** textPhases() of the assistant message before the empty reply. */
	phasesBefore: string;
}

/** The one log line. It carries no lesson text and no ids. */
export function emptyReplyLogLine(f: EmptyReplyLogFacts): string {
	return `[LearnHarness] Empty reply: ${f.provider}:${f.modelId}; ${f.kind}; empty reply ${f.count}; ${f.action}; thinking: ${f.thinking ? "yes" : "no"}; phases before: ${f.phasesBefore}`;
}

/** What finishTurn hands the guard (the loop's completed turn). */
export interface EmptyReplyTurn {
	message: AgentMessage;
	context: { messages: AgentMessage[] };
	newMessages: AgentMessage[];
}

export interface EmptyReplyGuardOptions {
	model: { provider: string; id: string };
	kind: string;
	/** The request's purpose at this moment; true = automatic (not nudged, not logged). */
	isBackground: () => boolean;
	log?: (line: string) => void;
}

/**
 * Per-run state and decision. `finishTurn` returns `{ action: "continue" }`
 * after dropping the first empty reply and arming the nudge (the loop sends
 * one more request; `withNudge` adds the instruction to that request alone),
 * `{ action: "end" }` after marking the nudged reply failed when it was empty
 * too (as the loop does for a provider error), and undefined otherwise.
 * `agent` is the run's Agent: its state.messages is what the turn persists.
 */
export function makeEmptyReplyGuard(options: EmptyReplyGuardOptions) {
	const log = options.log ?? ((line: string) => console.warn(line));
	let earlierOutput = false;
	let empties = 0;
	/** The next model request carries the nudge. Taken by that request's
	 * conversion, and cleared by any reply that arrives, so it can never
	 * ride a later request. */
	let nudgeNext = false;
	return {
		/** True while the next request is to carry the nudge (tests read it). */
		get nudgePending(): boolean {
			return nudgeNext;
		},
		/** Wraps the model-facing conversion: only while the nudge is armed,
		 * one user message with the instruction is appended to the converted
		 * messages, and the nudge is used up. Never touches the input. */
		withNudge(convert: (messages: AgentMessage[]) => Message[]): (messages: AgentMessage[]) => Message[] {
			return (messages) => {
				const converted = convert(messages);
				if (!nudgeNext) return converted;
				nudgeNext = false;
				return [...converted, { role: "user", content: [{ type: "text", text: EMPTY_REPLY_NUDGE_TEXT }], timestamp: Date.now() }];
			};
		},
		finishTurn(turn: EmptyReplyTurn, agent: { state: { messages: AgentMessage[] } }): { action: "continue" | "end" } | undefined {
			nudgeNext = false; // a reply has arrived: the nudge was for its request at most
			const message = turn.message;
			if (!isEmptyReply(message)) {
				if (replyHasOutput(message)) earlierOutput = true;
				return undefined;
			}
			if (options.isBackground()) return undefined;
			empties++;
			const index = turn.context.messages.indexOf(message);
			const before = turn.context.messages.slice(0, index < 0 ? turn.context.messages.length : index).findLast((m) => m.role === "assistant");
			const action: EmptyReplyAction = earlierOutput
				? "not retried: follows other output in this turn"
				: empties === 1 ? "nudging" : "giving up";
			log(emptyReplyLogLine({
				provider: options.model.provider,
				modelId: options.model.id,
				kind: options.kind,
				count: empties,
				action,
				thinking: blocksOf(message).some((b) => b.type === "thinking"),
				phasesBefore: textPhases(before),
			}));
			if (action === "nudging") {
				// Drop the reply from everything that would send or save it.
				const drop = (list: AgentMessage[]) => {
					const at = list.indexOf(message);
					if (at >= 0) list.splice(at, 1);
				};
				drop(turn.context.messages);
				drop(turn.newMessages);
				agent.state.messages = agent.state.messages.filter((m) => m !== message);
				nudgeNext = true;
				return { action: "continue" };
			}
			if (action === "giving up") {
				// Saved as a failed reply: the existing red line and its Retry.
				Object.assign(message, { stopReason: "error", errorMessage: EMPTY_REPLY_TEXT });
				return { action: "end" };
			}
			return undefined;
		},
	};
}
