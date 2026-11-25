/**
 * FORK (empty reply): what an empty reply is (docs/fork/models-and-agents.md,
 * "ChatGPT and OpenAI: an empty reply is asked again"). One definition for
 * the agent's guard (src/agent/empty-reply-guard.ts) and the page, which
 * hides a dropped empty attempt from the live view (components/session-core.ts).
 * Pure and browser-safe: no imports.
 */

/** ChatGPT (plan sign-in) and OpenAI (API key) only. */
export const EMPTY_REPLY_PROVIDERS: readonly string[] = ["chatgpt", "openai"];

export function emptyReplyProviderApplies(provider: unknown): boolean {
	return typeof provider === "string" && EMPTY_REPLY_PROVIDERS.includes(provider);
}

type ReplyBlock = { type?: string; text?: unknown };
type Reply = { role?: string; stopReason?: string; content?: unknown };

function replyBlocks(message: Reply): ReplyBlock[] {
	return Array.isArray(message.content) ? (message.content as ReplyBlock[]) : [];
}

/** An assistant message with a tool call, or a text block with non-whitespace text. */
export function replyHasOutput(message: Reply): boolean {
	if (message.role !== "assistant") return false;
	return replyBlocks(message).some((b) => b.type === "toolCall" || (b.type === "text" && typeof b.text === "string" && b.text.trim().length > 0));
}

/** An assistant reply that ended normally with no tool call and no text
 * (thinking blocks may or may not be there). Never for error, aborted,
 * length or toolUse stops. Any provider. */
export function isEmptyReply(message: Reply): boolean {
	return message.role === "assistant" && message.stopReason === "stop" && !replyHasOutput(message);
}

/** An empty reply from a ChatGPT or OpenAI model: the kind the guard drops. */
export function isGuardedEmptyReply(message: Reply & { provider?: unknown }): boolean {
	return isEmptyReply(message) && emptyReplyProviderApplies(message.provider);
}
