/**
 * THE TUTOR WINDOW'S VIEW of upstream's side conversations (side-tutor fork).
 *
 * Since upstream 0.6.0 the Tutor has no engine of its own: its questions are
 * upstream's side conversations, stored in the chat record (`sideChats`), one
 * per lesson step ("segment": from one learner turn to the next). The fork's
 * window shows ALL of them in one scroll, in lesson order, each under its
 * step's first words (owner's design). This file is the pure part of that
 * view: the order, and the words for each divider. Browser-safe.
 */

import type { SideChatThread } from "./contracts.ts";
import type { LhMessage } from "./native-messages.ts";
import { sideSegmentId } from "./side-chat.ts";

/** Longest divider text handed to the window; CSS cuts it to one line. */
const STEP_LABEL_MAX_CHARS = 160;
/** A formula this far into the text ends the label; one nearer the start is spelled out roughly instead. */
const FORMULA_CUT_MIN_CHARS = 12;

const FORMULA = /\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$[^$\n]+?\$/;

/** A formula's source with its markup taken off: commands lose their backslash, grouping braces go. */
function roughFormula(source: string): string {
	return source
		.replace(/^\$\$|\$\$$|^\\\[|\\\]$|^\\\(|\\\)$|^\$|\$$/g, "")
		.replace(/\\(?:mathbf|mathrm|mathit|mathbb|mathcal|text|textbf|operatorname|vec|hat|bar|left|right)\b/g, "")
		.replace(/\\([A-Za-z]+)/g, "$1")
		.replace(/\\[,;:! ]/g, " ")
		.replace(/[{}]/g, "");
}

/**
 * The first words of a piece of teacher markdown as plain text: no formatting
 * marks and no formulas (owner's wording for the divider). One line.
 *
 * A formula ends the text there, with "…", unless it comes within the first
 * few characters; then it is spelled out roughly so the label isn't empty.
 */
export function plainFirstWords(markdown: string): string {
	let text = markdown
		.replace(/```[\s\S]*?(?:```|$)/g, " ") // code blocks
		.replace(/<[^>\n]+>/g, " "); // inline HTML
	// The first paragraph that has any words in it.
	const paragraph = text.split(/\n\s*\n/).map((part) => part.trim()).find((part) => /[\p{L}\p{N}]/u.test(part)) ?? "";
	text = paragraph;
	let cut = false;
	for (let match = FORMULA.exec(text); match; match = FORMULA.exec(text)) {
		if (match.index >= FORMULA_CUT_MIN_CHARS) {
			text = text.slice(0, match.index);
			cut = true;
			break;
		}
		text = text.slice(0, match.index) + roughFormula(match[0]) + text.slice(match.index + match[0].length);
	}
	text = text
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links
		.replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "") // headings, quotes, list marks
		.replace(/(\*\*|__|~~|`)/g, "")
		.replace(/(^|[\s(])[*_](?=\S)/g, "$1") // opening emphasis
		.replace(/(\S)[*_](?=[\s).,;:!?]|$)/g, "$1") // closing emphasis
		.replace(/\s+/g, " ")
		.trim();
	if (text.length > STEP_LABEL_MAX_CHARS) {
		text = text.slice(0, STEP_LABEL_MAX_CHARS).trimEnd();
		cut = true;
	}
	if (!text) return "";
	return cut ? `${text.replace(/[\s,;:(]+$/, "")}…` : text;
}

/**
 * The words that name a step in the Tutor's scroll: the first words the
 * teacher wrote in that step. Empty when the step has no prose (a step that
 * is only a question, for example); the divider is then a plain line.
 */
export function tutorStepLabel(messages: readonly LhMessage[], segmentId: string): string {
	const start = messages.findIndex((message) => message.id === segmentId);
	if (start < 0) return "";
	// A step ends at the learner's next turn at the latest. Walk to there, and
	// ask upstream's own rule (one scan) only about the message the words are in.
	for (let index = start; index < messages.length; index++) {
		const message = messages[index]!;
		if (message.role === "user") break;
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "text") continue;
			const label = plainFirstWords(block.text);
			if (label) return sideSegmentId(messages, message.id) === segmentId ? label : "";
		}
	}
	return "";
}

/**
 * The conversations in lesson order: by where each one's step starts in the
 * lesson. A conversation whose step is no longer in the record (it was
 * summarised away) keeps its place before the ones that are, oldest first.
 */
export function orderTutorThreads<T extends Pick<SideChatThread, "anchor" | "createdAt">>(messages: readonly LhMessage[], threads: readonly T[]): T[] {
	const position = new Map(messages.map((message, index) => [message.id, index]));
	const at = (thread: T) => position.get(thread.anchor.messageId) ?? -1;
	return [...threads].sort((a, b) => at(a) - at(b) || a.createdAt.localeCompare(b.createdAt));
}
