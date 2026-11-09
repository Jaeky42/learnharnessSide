import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { PiEngine } from "../models.ts";
import { runSubagent } from "./pi-run.ts";

/**
 * THE SIDE-TUTOR AGENT: a stateless, tool-less pi Agent built per
 * question. It sees the lesson through a read-only snapshot (core
 * lessonSnapshot) and the earlier side exchanges as text; it never sees
 * or touches the main teacher's live context, and nothing it says is
 * written into the session record (src/core/side-tutor.ts).
 *
 * Prompt layout is cache-friendly: instructions → lesson → side history
 * in the system prompt (stable prefix first), the new question as the
 * only user message.
 */

export const SIDE_TUTOR_INSTRUCTIONS = `You are the side tutor in a learning app. A learner is in the middle of a lesson with a main teacher (another AI). The learner has opened a small side window to ask you quick questions without interrupting the lesson. You can read the lesson transcript below; the main teacher cannot see this side conversation.

How to help:
- Answer the question directly and briefly — usually a few sentences, a short worked example, or a small table. The window is small.
- Ground your answer in the lesson: use the same terms, notation and examples the teacher is using, and connect back to where the lesson is.
- Clarify vocabulary, restate an explanation another way, fill in a prerequisite, or check a calculation.
- Be accurate. If you are not sure, say so. If the lesson itself seems to contain a mistake, point it out plainly and suggest the learner raise it with the teacher.

Boundaries:
- Do not take over the lesson: don't start new topics, don't quiz the learner, and don't move ahead of the plan.
- If a question is waiting for the learner right now, do NOT give away its answer, eliminate options, or say which option is right — even if asked directly. You may clarify what the question is asking, define terms, or give a hint that leaves the reasoning to the learner. Say kindly that answering it is his job and the teacher will go through it.
- If the learner wants something the side window can't do well (a long explanation, changing the lesson, a new topic), suggest asking the main teacher in the main window.

Format: Markdown. Math in $...$ inline or $$...$$ on their own lines. No preamble, no sign-off.`;

export interface SideTutorRunOptions {
	engine: PiEngine;
	lesson: string;
	history: string | null;
	question: string;
	abortSignal?: AbortSignal;
	onText?: (text: string) => void;
	onUsage?: (usage: Usage) => void;
	chatId?: string;
}

export function sideTutorSystemPrompt(lesson: string, history: string | null): string {
	const parts = [SIDE_TUTOR_INSTRUCTIONS, `<lesson>\n${lesson}\n</lesson>`];
	if (history) parts.push(`<earlier_side_questions>\n${history}\n</earlier_side_questions>`);
	return parts.join("\n\n");
}

function textOf(message: AssistantMessage): string {
	return message.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("");
}

/** Run one side question to completion; resolves with the final answer text.
 *  Throws (AbortError on abort) exactly like every other sub-agent. */
export async function runSideTutor(opts: SideTutorRunOptions): Promise<string> {
	const { text } = await runSubagent([], {
		// The side tutor runs on the SESSION's own model (the engine is always
		// injected); the role only labels opt-in debug captures.
		role: "teacher",
		engine: opts.engine,
		systemPrompt: sideTutorSystemPrompt(opts.lesson, opts.history),
		prompt: opts.question,
		maxTurns: 1,
		abortSignal: opts.abortSignal,
		onUsage: opts.onUsage,
		onAssistantUpdate: opts.onText ? (m) => opts.onText!(textOf(m)) : undefined,
		chatId: opts.chatId,
	});
	return text;
}
