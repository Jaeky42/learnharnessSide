/**
 * THE SIDE TUTOR — pure core (contracts + the lesson snapshot).
 *
 * The side tutor is a SECOND agent that answers quick questions in a small
 * persistent window beside a teaching session. Two laws shape everything
 * here:
 *
 *  1. ISOLATION. Side questions and answers never enter the session's
 *     ChatRecord. They live in their own per-chat file (store/side-tutor.ts),
 *     so `toLlmMessages` — the main teacher's only view of history — never
 *     sees them, compaction never counts them, and extraction never reads
 *     them. The main context window is untouched by construction.
 *
 *  2. READ-ONLY SIGHT OF THE LESSON. The side agent sees the lesson as a
 *     rendered snapshot of the record (the session-markdown engine plus the
 *     extras below), rebuilt fresh per question. It reads; it never writes
 *     to the lesson.
 *
 * The snapshot adds what the plain markdown export omits but a tutor
 * needs: the session phase, the current plan, the reveal text of questions
 * the learner has ALREADY answered, and the question that is open RIGHT
 * NOW — rendered WITHOUT its committed answer or explanation, so the side
 * window can never be used to peek at the solution.
 */

import type { Usage } from "@earendil-works/pi-ai";
import type { LhMessage } from "./native-messages.ts";
import { danglingQuestionOf } from "./native-messages.ts";
import { messageMarkdown } from "./session-markdown.ts";
import { phaseAt3Lh } from "./phases.ts";

// ─── contracts ──────────────────────────────────────────────────────────────

export const SIDE_TUTOR_FORMAT_VERSION = 1;

/** Longest question the window accepts (characters). */
export const SIDE_TUTOR_MAX_QUESTION_CHARS = 4000;

/** Lesson snapshot budget (characters, ≈ 4 chars/token → ~40k tokens).
 *  Older lesson content past this is dropped from the HEAD — the recent
 *  lesson is what quick questions are about. */
export const SIDE_TUTOR_LESSON_BUDGET_CHARS = 160_000;

/** How many earlier side exchanges ride along as conversational context. */
export const SIDE_TUTOR_HISTORY_LIMIT = 12;

export type SideTutorStatus = "done" | "aborted" | "error";

export interface SideTutorEntry {
	id: string;
	question: string;
	/** The answer text (partial when aborted, empty on error). */
	answer: string;
	status: SideTutorStatus;
	/** Human-readable failure (status "error" only). */
	error?: string;
	askedAt: string;
	/** provider:id of the model that answered. */
	model?: string;
	/** Provider usage for this answer — kept here, NOT in the session's
	 *  usage log (the session record is never written by the side tutor). */
	usage?: Usage;
}

export interface SideTutorThread {
	version: number;
	chatId: string;
	entries: SideTutorEntry[];
}

/** The storage port (adapter: src/store/side-tutor.ts). */
export interface SideTutorStore {
	read(chatId: string): SideTutorThread;
	append(chatId: string, entry: SideTutorEntry): SideTutorThread;
	clear(chatId: string): void;
}

/** The POST stream's wire events (newline-delimited JSON). */
export type SideTutorWireEvent =
	| { type: "text"; text: string }
	| { type: "done"; entry: SideTutorEntry }
	| { type: "error"; error: string; entry?: SideTutorEntry };

export function emptySideTutorThread(chatId: string): SideTutorThread {
	return { version: SIDE_TUTOR_FORMAT_VERSION, chatId, entries: [] };
}

/** Validate a question body. Returns the trimmed question or an error. */
export function parseSideTutorQuestion(raw: unknown): { question: string } | { error: string } {
	if (typeof raw !== "string") return { error: "question must be a string" };
	const question = raw.trim();
	if (question.length === 0) return { error: "question is empty" };
	if (question.length > SIDE_TUTOR_MAX_QUESTION_CHARS) {
		return { error: `question is longer than ${SIDE_TUTOR_MAX_QUESTION_CHARS} characters` };
	}
	return { question };
}

// ─── the lesson snapshot ────────────────────────────────────────────────────

const QUIZ_LIKE = new Set(["quiz", "probe", "explain", "recall"]);

interface CallInfo {
	name: string;
	args: Record<string, unknown> | undefined;
}

function callMap(messages: readonly LhMessage[]): Map<string, CallInfo> {
	const calls = new Map<string, CallInfo>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall") {
				calls.set(block.id, {
					name: block.name,
					args: (block.arguments ?? undefined) as Record<string, unknown> | undefined,
				});
			}
		}
	}
	return calls;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Options as the learner sees them: labels only (values can name the
 *  answer key; the learner's display is shuffled anyway). */
function optionLabels(raw: unknown): string[] {
	let options = raw;
	if (typeof options === "string") {
		try {
			options = JSON.parse(options);
		} catch {
			return [];
		}
	}
	if (!Array.isArray(options)) return [];
	return options
		.map((o) => (o && typeof o === "object" ? str((o as { label?: unknown }).label) : str(o)))
		.filter((l): l is string => l !== undefined);
}

/** What the learner was shown AFTER answering a quiz-like check — safe to
 *  share because the answer is already revealed. Null when the check was
 *  skipped (nothing was revealed) or nothing reveal-shaped exists. */
function revealedAfterAnswer(result: LhMessage, calls: Map<string, CallInfo>): string | null {
	if (result.role !== "toolResult" || result.isError || !QUIZ_LIKE.has(result.toolName)) return null;
	const details = result.details as { dismissed?: unknown; correct?: unknown; dontKnow?: unknown; text?: unknown } | null | undefined;
	if (!details || details.dismissed === true) return null;
	const answered =
		details.correct === true || details.correct === false || details.dontKnow === true || typeof details.text === "string";
	if (!answered) return null;
	const args = calls.get(result.toolCallId)?.args;
	if (!args) return null;
	const lines: string[] = [];
	const options = optionLabels(args.options);
	if (options.length > 0) lines.push(`Options shown: ${options.map((o) => `“${o}”`).join(" · ")}`);
	const correct = args.correctAnswer;
	if (typeof correct === "string" && correct.trim()) {
		// For explain/recall this is the full committed answer; for quiz it is
		// an option value — still revealed to the learner on submit.
		lines.push(`Revealed answer: ${correct.trim()}`);
	} else if (Array.isArray(correct) && correct.length > 0) {
		lines.push(`Revealed answer: ${correct.map(String).join(", ")}`);
	}
	const explanation = str(args.explanation);
	if (explanation) lines.push(`Revealed explanation: ${explanation}`);
	return lines.length > 0 ? lines.join("\n\n") : null;
}

/** The newest successfully-recorded plan (plan_init's Mermaid source). */
function latestPlan(messages: readonly LhMessage[], calls: Map<string, CallInfo>): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role !== "toolResult" || m.toolName !== "plan_init" || m.isError) continue;
		const mermaid = str(calls.get(m.toolCallId)?.args?.mermaid);
		if (mermaid) return mermaid;
	}
	return null;
}

/** The open question as the learner sees it — NEVER its committed answer,
 *  explanation, or option values. */
function openQuestionBlock(messages: readonly LhMessage[]): string | null {
	const open = danglingQuestionOf(messages);
	if (!open) return null;
	const input = (open.input ?? {}) as Record<string, unknown>;
	const question = str(input.question) ?? "(no question text)";
	const lines = [`**Open ${open.tool === "ask_user_question" ? "question" : "check"} (${open.tool}):** ${question}`];
	const details = str(input.details);
	if (details) lines.push(`Details shown: ${details}`);
	const options = optionLabels(input.options);
	if (options.length > 0) {
		lines.push(`Options shown (order shuffled for the learner):\n${options.map((o) => `- ${o}`).join("\n")}`);
		if (input.multiSelect === true) lines.push("More than one option may be correct.");
	} else if (open.tool === "explain" || open.tool === "recall") {
		lines.push("The learner answers this one in his own words.");
	}
	return lines.join("\n\n");
}

export interface LessonSnapshot {
	/** The whole snapshot text (budgeted). */
	text: string;
	/** True when older lesson content was dropped to fit the budget. */
	truncated: boolean;
	/** True when a question is waiting for the learner's answer. */
	hasOpenQuestion: boolean;
}

/**
 * Render the lesson for the side tutor. Pure: native record in, text out.
 * Never includes the committed answer of the OPEN question.
 */
export function lessonSnapshot(
	messages: readonly LhMessage[],
	opts: { title?: string; budgetChars?: number } = {},
): LessonSnapshot {
	const budget = opts.budgetChars ?? SIDE_TUTOR_LESSON_BUDGET_CHARS;
	const calls = callMap(messages);
	const blocks: string[] = [];
	for (const message of messages) {
		const block = messageMarkdown(message, message.id, false);
		if (block === null) continue;
		const reveal = revealedAfterAnswer(message, calls);
		blocks.push(reveal ? `${block}\n\n${reveal}` : block);
	}

	// Keep the NEWEST blocks that fit; drop from the head.
	const kept: string[] = [];
	let used = 0;
	let truncated = false;
	for (let i = blocks.length - 1; i >= 0; i--) {
		const size = blocks[i]!.length + 2;
		if (used + size > budget && kept.length > 0) {
			truncated = true;
			break;
		}
		kept.unshift(blocks[i]!);
		used += size;
	}

	const phase = phaseAt3Lh(messages);
	const plan = latestPlan(messages, calls);
	const open = openQuestionBlock(messages);

	const sections: string[] = [];
	sections.push(`Session: ${opts.title?.trim() || "Untitled session"}`);
	sections.push(
		`Phase: ${phase === "probe" ? "probing (the teacher is finding out what the learner already knows)" : phase === "plan" ? "planning the lesson" : "teaching"}`,
	);
	if (plan) sections.push(`Current lesson plan (Mermaid):\n\`\`\`mermaid\n${plan}\n\`\`\``);
	sections.push(
		kept.length > 0
			? `Lesson transcript${truncated ? " (earlier part omitted for length)" : ""}:\n\n${kept.join("\n\n")}`
			: "Lesson transcript: (nothing has been taught yet)",
	);
	sections.push(open ? `What is on the learner's screen right now:\n\n${open}` : "No question is currently waiting for the learner.");

	return { text: sections.join("\n\n---\n\n"), truncated, hasOpenQuestion: open !== null };
}

/** Earlier side exchanges as plain text (provider-neutral — no synthetic
 *  assistant messages). Errors are skipped; aborted partials are marked. */
export function sideHistoryText(entries: readonly SideTutorEntry[], limit = SIDE_TUTOR_HISTORY_LIMIT): string | null {
	const usable = entries.filter((e) => e.status !== "error" && e.answer.trim().length > 0).slice(-limit);
	if (usable.length === 0) return null;
	return usable
		.map(
			(e) =>
				`Learner asked: ${e.question}\n\nYou answered${e.status === "aborted" ? " (cut off by the learner)" : ""}: ${e.answer.trim()}`,
		)
		.join("\n\n---\n\n");
}
