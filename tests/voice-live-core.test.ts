/**
 * The GPT-Live trial's pure rules (src/core/voice/live.ts; voice plan, Phase 0):
 * which option was said, the captions, the cost, the session's startup config.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	addCaption,
	CAPTION_LINE_GAP_MS,
	CAPTION_MAX_LINES,
	isLiveModel,
	isLiveVoice,
	LIVE_DEFAULT_MODEL,
	LIVE_DEFAULT_VOICE,
	LIVE_VOICES,
	liveUsageCost,
	questionCommentary,
	spokenChoice,
	trialSessionConfig,
	verdictCommentary,
	VOICE_TRIAL_IDLE_TIMEOUT_S,
	VOICE_TRIAL_INSTRUCTIONS,
	VOICE_TRIAL_QUESTION,
} from "../src/core/index.ts";

const OPTIONS = VOICE_TRIAL_QUESTION.options;

describe("spokenChoice", () => {
	const table: Array<[string, number | "dont-know" | null]> = [
		// Letters.
		["B", 1],
		["b.", 1],
		["A", 0],
		["A.", 0],
		["a", 0],
		["option B", 1],
		["Option C, please.", 2],
		["answer a", 0],
		["I think it's A because electrons bump into atoms.", 0],
		["I think it's A", 0],
		["It's a.", 0],
		["I'd say C", 2],
		["um, b", 1],
		["I'll go with A.", 0],
		["Is it A?", 0],
		["Maybe it's B because the voltage drops", 1],
		// Ordinals.
		["the second one", 1],
		["The first one.", 0],
		["number two", 1],
		["number 3", 2],
		["the last one", 2],
		["the third", 2],
		["second", 1],
		["the middle one", 1],
		// Don't know.
		["I don't know", "dont-know"],
		["I don’t know.", "dont-know"],
		["no idea", "dont-know"],
		["Honestly, I'm not sure.", "dont-know"],
		["I'm not sure, but I think it's B", 1],
		// Its own words.
		["because electrons collide with the atoms", 0],
		["the voltage drops to zero", 1],
		["the current speeds up", 2],
		// Not answers.
		["what is a wire?", null],
		["What is a resistor, again?", null],
		["Can you say that again?", null],
		["a longer wire has more resistance", null],
		["first I want to ask something", null],
		["is it a or b", null],
		["A or B?", null],
		["not B, it's A", null],
		["the first or the second one", null],
		["the current goes up and the voltage drops", null],
		["B, because the electrons collide with atoms", null],
		["", null],
		["hmm", null],
	];
	for (const [text, expected] of table) {
		it(`"${text}" → ${expected}`, () => assert.equal(spokenChoice(text, OPTIONS), expected));
	}

	it("ignores letters and positions past the options", () => {
		assert.equal(spokenChoice("option D", OPTIONS), null);
		assert.equal(spokenChoice("the fourth one", OPTIONS), null);
		assert.equal(spokenChoice("option D", [...OPTIONS, "Resistance is a myth"]), 3);
	});

	it("never reads the pronoun I as an option", () => {
		assert.equal(spokenChoice("I think so", OPTIONS), null);
	});
});

describe("captions", () => {
	it("joins a speaker's fragments into one line and starts a line at a change of speaker", () => {
		let lines = addCaption([], { speaker: "tutor", delta: "Hello", startMs: 0, endMs: 300 });
		lines = addCaption(lines, { speaker: "tutor", delta: " there.", startMs: 300, endMs: 600 });
		lines = addCaption(lines, { speaker: "learner", delta: " Hi!", startMs: 900, endMs: 1100 });
		lines = addCaption(lines, { speaker: "tutor", delta: "So,", startMs: 1200, endMs: 1300 });
		assert.deepEqual(lines.map((l) => [l.speaker, l.text]), [["tutor", "Hello there."], ["learner", "Hi!"], ["tutor", "So,"]]);
	});

	it("starts a new line for the same speaker after a long pause", () => {
		let lines = addCaption([], { speaker: "tutor", delta: "One.", startMs: 0, endMs: 500 });
		lines = addCaption(lines, { speaker: "tutor", delta: " Two.", startMs: 500 + CAPTION_LINE_GAP_MS + 1, endMs: 3000 });
		assert.deepEqual(lines.map((l) => l.text), ["One.", "Two."]);
	});

	it("joins fragments without times, leaves the input alone, drops empty deltas and keeps the last lines", () => {
		const first = addCaption([], { speaker: "learner", delta: "a" });
		const second = addCaption(first, { speaker: "learner", delta: "b" });
		assert.deepEqual(first, [{ speaker: "learner", text: "a" }]);
		assert.deepEqual(second, [{ speaker: "learner", text: "ab" }]);
		assert.equal(addCaption(second, { speaker: "tutor", delta: "" }).length, 1);
		let many: ReturnType<typeof addCaption> = [];
		for (let i = 0; i < CAPTION_MAX_LINES + 5; i++) many = addCaption(many, { speaker: i % 2 ? "tutor" : "learner", delta: `${i}` });
		assert.equal(many.length, CAPTION_MAX_LINES);
		assert.equal(many.at(-1)?.text, `${CAPTION_MAX_LINES + 4}`);
	});
});

describe("cost", () => {
	it("prices active and paused minutes as listed", () => {
		assert.equal(liveUsageCost({ seconds: 120, active_seconds: 60, paused_seconds: 60 }), 0.05 + 0.02);
		assert.ok(Math.abs(liveUsageCost({ seconds: 30, active_seconds: 30 }) - 0.025) < 1e-12);
	});
	it("counts every second as active without a breakdown", () => {
		assert.equal(liveUsageCost({ seconds: 600 }), 0.5);
		assert.equal(liveUsageCost({ seconds: -5 }), 0);
	});
});

describe("the trial's session config", () => {
	it("is client delegation, a 60 s idle pause with a speech wake, not stored", () => {
		assert.deepEqual(trialSessionConfig({ model: "gpt-live-1", voice: "cedar" }), {
			model: "gpt-live-1",
			audio: { output: { voice: "cedar" } },
			instructions: VOICE_TRIAL_INSTRUCTIONS,
			delegation: { type: "client" },
			idle_timeout_s: VOICE_TRIAL_IDLE_TIMEOUT_S,
			wake_policy: { type: "speech" },
			store: false,
		});
		assert.equal(VOICE_TRIAL_IDLE_TIMEOUT_S, 60);
	});

	it("allows only the listed models and voices", () => {
		assert.equal(LIVE_DEFAULT_MODEL, "gpt-live-1.1");
		assert.equal(LIVE_DEFAULT_VOICE, "marin");
		assert.equal(LIVE_VOICES.length, 23);
		assert.ok(isLiveModel("gpt-live-1") && isLiveModel("gpt-live-1.1"));
		assert.ok(!isLiveModel("gpt-realtime") && !isLiveModel(undefined));
		assert.ok(isLiveVoice("marin") && !isLiveVoice("Marin") && !isLiveVoice({ id: "x" }));
	});

	it("the question's commentary never carries the answer; the verdict does", () => {
		const read = questionCommentary();
		assert.match(read, /A: Electrons collide/);
		assert.match(read, /C: The current speeds up/);
		assert.doesNotMatch(read, /correct|right answer is/i);
		assert.match(verdictCommentary(0), /That is correct/);
		assert.match(verdictCommentary(2), /not right; the right answer is A/);
		assert.match(verdictCommentary("dont-know"), /don't know.*the answer is A/);
	});
});
