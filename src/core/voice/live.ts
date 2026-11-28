/**
 * VOICE (fork, Phase 0 of docs/fork/plans/voice-session-plan.md): the pure
 * rules of the GPT-Live trial page. Browser-safe, no imports.
 *
 * What the trial knows about OpenAI's GPT-Live comes from the type
 * definitions of OpenAI's own Node library (resources/live/), not from the
 * live service: the model ids, the 23 built-in voices, the session's startup
 * config (MediaSessionConfig), and the listed prices. Every word the trial
 * says is the builder's trial wording, not approved product wording.
 */

// ─── Models, voices, prices ──────────────────────────────────────────────────

export const LIVE_MODELS = ["gpt-live-1.1", "gpt-live-1"] as const;
export type LiveModel = (typeof LIVE_MODELS)[number];
export const LIVE_DEFAULT_MODEL: LiveModel = "gpt-live-1.1";

/** BuiltInVoice in the library's types. */
export const LIVE_VOICES = [
	"alloy", "ash", "ballad", "beacon", "bossa", "cedar", "cinder", "coral", "delta", "echo", "gleam", "marin",
	"meridian", "quartz", "ripple", "sage", "shida", "shimmer", "stone", "tempo", "verse", "vesper", "willow",
] as const;
export type LiveVoice = (typeof LIVE_VOICES)[number];
export const LIVE_DEFAULT_VOICE: LiveVoice = "marin";

export function isLiveModel(value: unknown): value is LiveModel {
	return typeof value === "string" && (LIVE_MODELS as readonly string[]).includes(value);
}

export function isLiveVoice(value: unknown): value is LiveVoice {
	return typeof value === "string" && (LIVE_VOICES as readonly string[]).includes(value);
}

/** The listed prices, in US dollars per minute of session. */
export const LIVE_PRICE_PER_MINUTE = { active: 0.05, paused: 0.02 } as const;

/** session.usage.updated's usage: cumulative whole seconds; the breakdown only where the session reports it. */
export interface LiveUsage {
	seconds: number;
	active_seconds?: number;
	paused_seconds?: number;
}

/**
 * The cost of a session's usage so far, in US dollars, at the listed prices.
 * With no active/paused breakdown every second is counted as active (the
 * higher price), so the figure never reads low.
 */
export function liveUsageCost(usage: LiveUsage): number {
	const active = usage.active_seconds;
	const paused = usage.paused_seconds;
	if (typeof active === "number" || typeof paused === "number") {
		return ((active ?? 0) / 60) * LIVE_PRICE_PER_MINUTE.active + ((paused ?? 0) / 60) * LIVE_PRICE_PER_MINUTE.paused;
	}
	return (Math.max(0, usage.seconds) / 60) * LIVE_PRICE_PER_MINUTE.active;
}

/** "$0.0125": four decimals, because a short trial costs cents. */
export function formatUsd(amount: number): string {
	return `$${amount.toFixed(4)}`;
}

// ─── The trial's numbers ─────────────────────────────────────────────────────

/** Seconds of silence after which the session pauses inference (it wakes on speech). */
export const VOICE_TRIAL_IDLE_TIMEOUT_S = 60;
/** The cost guard: a call ends by itself after this long. */
export const VOICE_TRIAL_MAX_MS = 10 * 60 * 1000;
/** A spoken answer is read this long after the learner's last words. */
export const VOICE_TRIAL_ANSWER_QUIET_MS = 700;
/** A delegation is answered this long after it arrives. */
export const VOICE_TRIAL_DELEGATION_REPLY_MS = 2000;
/** The question shows once the tutor has been quiet this long after its explanation. */
export const VOICE_TRIAL_EXPLANATION_QUIET_MS = 1500;

// ─── The trial's words (the builder's, for the trial only) ───────────────────

export const VOICE_TRIAL_INSTRUCTIONS = [
	"You are a friendly tutor in a short voice trial of a learning app.",
	"Speak naturally and briefly, in short sentences, in the language the learner speaks.",
	"The app will give you things to tell the learner: say them in your own words, and do not add facts of your own.",
	"When the learner asks something the app has not given you, do not answer it from your own knowledge: hand it over (delegate it) and tell the learner you are checking.",
	"When the app shows the learner a question, never say which answer is right until the app tells you what the learner answered.",
].join(" ");

export const VOICE_TRIAL_EXPLANATION = [
	"Explain this to the learner in your own words, then stop and wait:",
	"a longer wire has more electrical resistance because the electrons that carry the current have further to travel through the metal.",
	"On the way they keep bumping into the metal's atoms, and every collision gets in the way of the current.",
	"Twice the length means about twice as many collisions, so about twice the resistance.",
	"That is one reason long cables are made thicker.",
].join(" ");

export interface TrialQuestion {
	prompt: string;
	options: readonly string[];
	correct: number;
	explanation: string;
}

export const VOICE_TRIAL_QUESTION: TrialQuestion = {
	prompt: "Why does a longer wire have more resistance?",
	options: ["Electrons collide with more atoms along the way", "The voltage drops to zero", "The current speeds up"],
	correct: 0,
	explanation: "Over a longer distance the electrons collide with more of the metal's atoms, and each collision gets in the way of the current.",
};

export const VOICE_TRIAL_DONT_KNOW_LABEL = "I don't know";

export function optionLetter(index: number): string {
	return String.fromCharCode(65 + index);
}

/** The commentary that asks the tutor to read the question aloud. It never carries the answer. */
export function questionCommentary(question: TrialQuestion = VOICE_TRIAL_QUESTION): string {
	const options = question.options.map((option, i) => `${optionLetter(i)}: ${option}.`).join(" ");
	return [
		"The app now shows the learner a question. Read it aloud with its lettered options, then wait for their answer.",
		"Do not say which option is right.",
		`Question: ${question.prompt} ${options}`,
		"They can also say they don't know.",
	].join(" ");
}

export type TrialChoice = number | "dont-know";

/** The commentary with the verdict, once the app has graded the answer. */
export function verdictCommentary(choice: TrialChoice, question: TrialQuestion = VOICE_TRIAL_QUESTION): string {
	const right = `${optionLetter(question.correct)}: "${question.options[question.correct]}"`;
	const after = "That is the end of the trial's script; chat briefly if the learner wants to.";
	if (choice === "dont-know") {
		return `The learner said they don't know. Tell them that's fine: the answer is ${right}. Explain in one sentence: ${question.explanation} ${after}`;
	}
	const said = `${optionLetter(choice)}: "${question.options[choice]}"`;
	if (choice === question.correct) {
		return `The learner answered ${said}. That is correct. Tell them so, and add in one sentence: ${question.explanation} ${after}`;
	}
	return `The learner answered ${said}. That is not right; the right answer is ${right}. Tell them kindly, and explain in one sentence: ${question.explanation} ${after}`;
}

export const VOICE_TRIAL_DELEGATION_REPLY =
	"In the real lesson the learner's own model would answer this. This is only the trial, so tell the learner that briefly, and offer to carry on.";

/** Plain words for the page. */
export const VOICE_TRIAL_TEXT = {
	title: "Voice trial",
	intro: "A short spoken conversation with OpenAI's GPT-Live, to try on this device. Nothing is saved.",
	noKey: "This server has no OpenAI API key. Add one in Settings → Providers, then try again.",
	micRefused: "The microphone was refused. Allow it for this site, then try again.",
	callFailed: "The call failed.",
	callDropped: "The call dropped.",
	timeLimit: "The call ended after 10 minutes, the trial's limit.",
	sayHello: "Waiting for the tutor. If nothing happens, say hello.",
} as const;

// ─── The session's startup config ────────────────────────────────────────────

/** The subset of the library's MediaSessionConfig the trial sends. */
export interface LiveSessionConfig {
	model: LiveModel;
	audio: { output: { voice: LiveVoice } };
	instructions: string;
	delegation: { type: "client" };
	idle_timeout_s: number;
	wake_policy: { type: "speech" };
	store: false;
}

export function trialSessionConfig({ model, voice }: { model: LiveModel; voice: LiveVoice }): LiveSessionConfig {
	return {
		model,
		audio: { output: { voice } },
		instructions: VOICE_TRIAL_INSTRUCTIONS,
		delegation: { type: "client" },
		idle_timeout_s: VOICE_TRIAL_IDLE_TIMEOUT_S,
		wake_policy: { type: "speech" },
		store: false,
	};
}

// ─── Captions ────────────────────────────────────────────────────────────────

export type LiveSpeaker = "learner" | "tutor";
export const LIVE_SPEAKER_LABEL: Record<LiveSpeaker, string> = { learner: "You", tutor: "Tutor" };

export interface CaptionLine {
	speaker: LiveSpeaker;
	text: string;
	/** The session timeline's end of the line's last fragment, when the event gave one. */
	endMs?: number;
}

/** A pause longer than this, on the session's timeline, starts a new line for the same speaker. */
export const CAPTION_LINE_GAP_MS = 1500;
export const CAPTION_MAX_LINES = 200;

/**
 * One transcript delta into the captions. A fragment joins the last line when
 * that line is the same speaker's and no long pause came between; otherwise
 * it starts a line. The fragments are joined as they come (they carry their
 * own spacing). Returns a new array; the input is not changed.
 */
export function addCaption(
	lines: readonly CaptionLine[],
	fragment: { speaker: LiveSpeaker; delta: string; startMs?: number; endMs?: number },
): CaptionLine[] {
	if (!fragment.delta) return [...lines];
	const last = lines[lines.length - 1];
	const gap = last?.endMs !== undefined && fragment.startMs !== undefined ? fragment.startMs - last.endMs : 0;
	if (last && last.speaker === fragment.speaker && gap <= CAPTION_LINE_GAP_MS) {
		const joined: CaptionLine = { speaker: last.speaker, text: last.text + fragment.delta };
		const endMs = fragment.endMs ?? last.endMs;
		if (endMs !== undefined) joined.endMs = endMs;
		return [...lines.slice(0, -1), joined];
	}
	const line: CaptionLine = { speaker: fragment.speaker, text: fragment.delta.replace(/^\s+/, "") };
	if (fragment.endMs !== undefined) line.endMs = fragment.endMs;
	const next = [...lines, line];
	return next.length > CAPTION_MAX_LINES ? next.slice(next.length - CAPTION_MAX_LINES) : next;
}

// ─── Which option was said ───────────────────────────────────────────────────

const ORDINALS: Record<string, number> = {
	first: 0, second: 1, third: 2, fourth: 3, fifth: 4, sixth: 5,
	one: 0, two: 1, three: 2, four: 3, five: 4, six: 5,
	"1": 0, "2": 1, "3": 2, "4": 3, "5": 4, "6": 5,
	"1st": 0, "2nd": 1, "3rd": 2, "4th": 3, "5th": 4, "6th": 5,
};
/** Ordinal words that mean a position only with a cue around them ("the second one", "number two"). */
const ORDINAL_WORDS = new Set(["first", "second", "third", "fourth", "fifth", "sixth", "1st", "2nd", "3rd", "4th", "5th", "6th"]);
const OPTION_NOUNS = new Set(["option", "answer", "choice", "letter", "number"]);
const AFTER_ORDINAL = new Set(["one", "option", "answer", "choice"]);
/** Words before a bare "a" that make it a choice, when nothing but a boundary follows it. */
const A_CUES = new Set(["its", "is", "it", "say", "pick", "choose", "with", "go", "guess", "maybe", "probably", "think", "be"]);
/** Words that can follow a chosen letter ("A because…"); an article is followed by a noun instead. */
const BOUNDARY = new Set(["because", "since", "as", "so", "then", "i", "im", "id", "please", "right", "final", "cause", "cuz", "and", "or"]);
const FILLERS = new Set(["um", "uh", "er", "erm", "hmm", "mm", "well", "ok", "okay", "so", "like", "oh", "ah", "yeah", "yes"]);
const STOPWORDS = new Set([
	"the", "a", "an", "to", "of", "and", "or", "with", "in", "on", "at", "by", "for", "from", "up", "down", "it", "its",
	"is", "are", "was", "be", "that", "this", "they", "them", "their", "there", "more", "less", "way", "along", "i", "think",
]);

interface Token {
	word: string;
	/** The token as it was written (for the capital "A"). */
	raw: string;
	/** Punctuation came straight after it. */
	stop: boolean;
	/** It starts the text or a sentence. */
	start: boolean;
}

function tokenize(text: string): Token[] {
	const tokens: Token[] = [];
	const re = /[A-Za-z0-9À-ɏ'’]+|[.,!?;:]/g;
	let sentenceStart = true;
	for (const match of text.matchAll(re)) {
		const piece = match[0];
		if (/^[.,!?;:]$/.test(piece)) {
			const last = tokens[tokens.length - 1];
			if (last) last.stop = true;
			if (/[.!?]/.test(piece)) sentenceStart = true;
			continue;
		}
		const word = piece.toLowerCase().replace(/['’]/g, "");
		if (!word) continue;
		tokens.push({ word, raw: piece, stop: false, start: sentenceStart });
		sentenceStart = false;
	}
	return tokens;
}

function stem(word: string): string {
	let w = word;
	for (const suffix of ["ing", "ed", "es", "s"]) {
		if (w.length > suffix.length + 2 && w.endsWith(suffix)) { w = w.slice(0, -suffix.length); break; }
	}
	if (w.length > 3 && /([b-df-hj-np-tv-z])\1$/.test(w)) w = w.slice(0, -1);
	if (w.length > 3 && w.endsWith("e")) w = w.slice(0, -1);
	return w;
}

function contentWords(text: string): string[] {
	return [...new Set(tokenize(text).map((t) => t.word).filter((w) => !STOPWORDS.has(w) && w.length > 1).map(stem))];
}

const DONT_KNOW = [
	/\b(i )?(dont|do not|dunno) know\b/, /\bdunno\b/, /\bno idea\b/, /\bnot sure\b/, /\bno clue\b/, /\bnot a clue\b/, /\bpass\b/, /\bskip\b/,
];

/** Which option indices the tokens name by letter or by position. */
function namedOptions(tokens: Token[], count: number): Set<number> {
	const named = new Set<number>();
	const meaningful = tokens.filter((t) => !FILLERS.has(t.word));
	tokens.forEach((token, i) => {
		const prev = tokens[i - 1]?.word;
		const next = tokens[i + 1]?.word;
		// A letter.
		if (/^[a-z]$/.test(token.word)) {
			const index = token.word.charCodeAt(0) - 97;
			if (index >= count) return;
			const cued = prev !== undefined && OPTION_NOUNS.has(prev);
			if (token.word !== "a") {
				// "I" never reaches here (it isn't an option letter past the first few); b, c, d… are not English words.
				named.add(index);
				return;
			}
			const alone = meaningful.length === 1;
			const capitalInside = token.raw === "A" && !token.start;
			const ends = token.stop || next === undefined || BOUNDARY.has(next);
			if (cued || alone || capitalInside || (ends && (token.stop || (prev !== undefined && A_CUES.has(prev))))) named.add(index);
			return;
		}
		// A position.
		const position = ORDINALS[token.word];
		if (position === undefined) {
			if (token.word === "last" && (prev === "the" || prev === "one") && (next === undefined || AFTER_ORDINAL.has(next) || token.stop)) named.add(count - 1);
			if (token.word === "middle" && count % 2 === 1 && (next === undefined || AFTER_ORDINAL.has(next) || token.stop)) named.add((count - 1) / 2);
			return;
		}
		if (position >= count) return;
		const afterNoun = prev !== undefined && OPTION_NOUNS.has(prev);
		const ordinalCue = ORDINAL_WORDS.has(token.word) && (prev === "the" || next === undefined || (next !== undefined && AFTER_ORDINAL.has(next)) || token.stop || meaningful.length === 1);
		if (afterNoun || ordinalCue) named.add(position);
	});
	return named;
}

/** The option whose own words the text clearly repeats, or nothing. */
function overlapOption(text: string, options: readonly string[]): number | null {
	const said = new Set(contentWords(text));
	const scores = options.map((option) => {
		const words = contentWords(option);
		const matched = words.filter((w) => said.has(w)).length;
		return { matched, share: words.length ? matched / words.length : 0 };
	});
	const best = scores.reduce((top, s, i) => (s.matched > scores[top]!.matched ? i : top), 0);
	const top = scores[best];
	if (!top || top.matched < 2 || top.share < 0.3) return null;
	const rival = scores.some((s, i) => i !== best && s.matched >= 2);
	return rival ? null : best;
}

/**
 * What a learner said, read as an answer to a multiple-choice question:
 * an option's index, "dont-know", or null when it isn't a clear answer.
 *
 * Reads a letter ("B", "b.", "option B", "I think it's A because…"), a
 * position ("the second one", "number two", "the last one"), "I don't
 * know" / "no idea" / "not sure", and a clear repeat of one option's own
 * words. The article "a" is not option A ("what is a wire?"). Two options
 * named is no answer. A named option wins over "not sure" ("not sure, but
 * B"). `options` are the options' texts, without "I don't know".
 */
export function spokenChoice(text: string, options: readonly string[]): TrialChoice | null {
	if (!text.trim() || options.length === 0) return null;
	const tokens = tokenize(text);
	const named = namedOptions(tokens, options.length);
	const overlap = overlapOption(text, options);
	if (named.size > 1) return null;
	if (named.size === 1) {
		const [index] = [...named];
		if (overlap !== null && overlap !== index) return null;
		return index!;
	}
	if (overlap !== null) return overlap;
	const flat = tokens.map((t) => t.word).join(" ");
	if (DONT_KNOW.some((re) => re.test(flat))) return "dont-know";
	return null;
}
