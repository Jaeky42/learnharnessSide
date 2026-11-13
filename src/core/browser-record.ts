/**
 * What the browser receives of a chat record (perf round, owner's decision):
 * the reasoning blocks' `thinkingSignature` is provider-opaque replay data —
 * no browser code reads it, and it was about a quarter of a long session's
 * bytes. The stored record keeps it (the next model request replays it);
 * only the copies sent to the browser leave it out.
 */

import type { LhMessage } from "./native-messages.ts";

type ContentBlock = { type?: unknown; thinkingSignature?: unknown } & Record<string, unknown>;

/** Messages for the browser: thinking blocks without `thinkingSignature`.
 *  New message and block objects only where a signature was found; every other
 *  object is reused as is. Never mutates its input (the stored record, or what
 *  a store returned). Returns the same array when nothing carried a signature. */
export function withoutThinkingSignatures(messages: readonly LhMessage[]): LhMessage[] {
	let out: LhMessage[] | null = null;
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		const content = (message as { content?: unknown }).content;
		if (!Array.isArray(content) || !content.some(hasSignature)) continue;
		out ??= messages.slice();
		out[i] = {
			...message,
			content: content.map((block: ContentBlock) => {
				if (!hasSignature(block)) return block;
				const { thinkingSignature: _signature, ...rest } = block;
				return rest;
			}),
		} as unknown as LhMessage;
	}
	return out ?? (messages as LhMessage[]);
}

function hasSignature(block: unknown): block is ContentBlock {
	return typeof block === "object" && block !== null && (block as ContentBlock).type === "thinking" && "thinkingSignature" in block;
}
