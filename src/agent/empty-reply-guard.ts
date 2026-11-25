import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * FORK (empty reply): an empty reply is asked again (docs/fork/models-and-agents.md,
 * "ChatGPT and OpenAI: an empty reply is asked again"). A ChatGPT or OpenAI
 * reply that ended normally with only thinking (no text, no tool call) ends
 * the agent loop, and the lesson would wait for the learner. For the
 * lesson's own agents (prober, teacher, practice) the reply is dropped and the
 * same request is sent again in the same turn, up to EMPTY_REPLY_MAX_RETRIES
 * times; still empty after that, the last one is saved as a failed reply.
 * Nothing new is stored. Agent layer only: no server imports.
 */

export const EMPTY_REPLY_MAX_RETRIES = 2;

/** The owner's approved sentence, word for word. */
export const EMPTY_REPLY_TEXT = "The teacher returned an empty reply. Retry when ready.";

const EMPTY_REPLY_PROVIDERS: readonly string[] = ["chatgpt", "openai"];

/** ChatGPT (plan sign-in) and OpenAI (API key) only. */
export function emptyReplyGuardApplies(model: { provider: string }): boolean {
	return EMPTY_REPLY_PROVIDERS.includes(model.provider);
}

type Block = { type: string; text?: string; textSignature?: string };
type Reply = { role?: string; stopReason?: string; content?: unknown };

function blocksOf(message: Reply): Block[] {
	return Array.isArray(message.content) ? (message.content as Block[]) : [];
}

/** A tool call, or a text block with non-whitespace text. */
export function hasOutput(message: Reply): boolean {
	if (message.role !== "assistant") return false;
	return blocksOf(message).some((b) => b.type === "toolCall" || (b.type === "text" && typeof b.text === "string" && b.text.trim().length > 0));
}

/** An assistant reply that ended normally with no tool call and no text
 * (thinking blocks may or may not be there). Never for error, aborted,
 * length or toolUse stops. */
export function isEmptyReply(message: Reply): boolean {
	return message.role === "assistant" && message.stopReason === "stop" && !hasOutput(message);
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

export type EmptyReplyAction = "retrying" | "giving up" | "not retried: follows other output in this turn";

export interface EmptyReplyLogFacts {
	provider: string;
	modelId: string;
	kind: string;
	/** Which empty reply of the run this is (1, 2 or 3). */
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
	/** The request's purpose at this moment; true = automatic (not retried, not logged). */
	isBackground: () => boolean;
	log?: (line: string) => void;
}

/**
 * Per-run state and decision. `finishTurn` returns `{ action: "continue" }`
 * after dropping the empty reply (the loop sends one more request with the
 * current context), `{ action: "end" }` after marking the last one failed
 * (as the loop does for a provider error), and undefined otherwise.
 * `agent` is the run's Agent: its state.messages is what the turn persists.
 */
export function makeEmptyReplyGuard(options: EmptyReplyGuardOptions) {
	const log = options.log ?? ((line: string) => console.warn(line));
	let earlierOutput = false;
	let empties = 0;
	return {
		finishTurn(turn: EmptyReplyTurn, agent: { state: { messages: AgentMessage[] } }): { action: "continue" | "end" } | undefined {
			const message = turn.message;
			if (!isEmptyReply(message)) {
				if (hasOutput(message)) earlierOutput = true;
				return undefined;
			}
			if (options.isBackground()) return undefined;
			empties++;
			const index = turn.context.messages.indexOf(message);
			const before = turn.context.messages.slice(0, index < 0 ? turn.context.messages.length : index).findLast((m) => m.role === "assistant");
			const action: EmptyReplyAction = earlierOutput
				? "not retried: follows other output in this turn"
				: empties <= EMPTY_REPLY_MAX_RETRIES ? "retrying" : "giving up";
			log(emptyReplyLogLine({
				provider: options.model.provider,
				modelId: options.model.id,
				kind: options.kind,
				count: empties,
				action,
				thinking: blocksOf(message).some((b) => b.type === "thinking"),
				phasesBefore: textPhases(before),
			}));
			if (action === "retrying") {
				// Drop the reply from everything that would send or save it.
				const drop = (list: AgentMessage[]) => {
					const at = list.indexOf(message);
					if (at >= 0) list.splice(at, 1);
				};
				drop(turn.context.messages);
				drop(turn.newMessages);
				agent.state.messages = agent.state.messages.filter((m) => m !== message);
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
