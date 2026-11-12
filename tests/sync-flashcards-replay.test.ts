/**
 * Flashcards sync (docs/phone-plugins-plan.md): schedules never travel; each
 * device works them out again from the reviews with the plugin's own
 * scheduler. These tests drive the plugin's real back end through a long
 * single-device history (every rating, learning and relearning steps,
 * changed settings on the way, many days, a card deleted, a fact deleted
 * and made again) and check that the replay writes back exactly what the
 * plugin itself wrote: the whole file, byte for byte.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { rebuildFlashcards, readFlashcards, replayProposition, FLASHCARDS_DEFAULT_SETTINGS, type FlashcardsMemory } from "../src/core/sync/flashcards.ts";
import { clock, DAY, Device, MINUTE, pluginDefaults, scheduler } from "./sync-flashcards-harness.ts";

Date.now = () => clock.now;

const devices: Device[] = [];
const device = (name: string): Device => { const d = new Device(name); devices.push(d); return d; };
afterEach(() => { for (const d of devices.splice(0)) d.dispose(); });

/** Review whatever is due, a rating for each, then move the clock on. */
async function study(d: Device, ratings: number[], step = MINUTE): Promise<number> {
	let done = 0;
	for (const rating of ratings) {
		if (await d.grade(rating)) done++;
		clock.now += step;
	}
	return done;
}

describe("the replay equals the plugin's own schedule", () => {
	it("keeps the plugin's defaults", () => {
		assert.deepEqual(FLASHCARDS_DEFAULT_SETTINGS, pluginDefaults());
	});

	it("over many days of reviews, every rating, learning and relearning steps, and settings changed on the way", async () => {
		clock.now = new Date(2026, 0, 5, 9, 0).getTime();
		const d = device("pc");
		await d.generate([
			{ id: "n_a", questions: ["What is A?", "Why A?"] },
			{ id: "n_b", questions: ["What is B?"] },
			{ id: "n_c", questions: ["What is C?", "Where C?", "When C?"] },
		]);
		const state = await d.state();
		await d.call("save-deck", { id: state.decks[0]!.id, newLimit: 3 });
		const manualDeck = (await d.call<{ decks: Array<{ id: string; name: string }> }>("create-deck", { name: "Mine" })).decks.find((x) => x.name === "Mine")!;
		await d.call("create-card", { requestId: "m1", deckId: manualDeck.id, name: "Own fact", question: "Own question?", answer: "Own answer." });
		const pattern = [1, 3, 3, 2, 4, 1, 1, 3, 4, 2, 3, 3, 1, 4, 2];
		let reviewed = 0;
		for (let day = 0; day < 40; day++) {
			reviewed += await study(d, pattern.slice(day % 5, day % 5 + 8), 7 * MINUTE);
			if (day === 6) await d.call("save-settings", { retention: 0.85, learningSteps: [2, 15, 60] });
			if (day === 13) await d.call("save-settings", { relearningSteps: [5, 30], dayStart: 6 });
			if (day === 20) {
				const p = (await d.state()).propositions.find((x) => x.id === "n_c")!;
				await d.call("delete-cue", { propositionId: "n_c", cueId: p.cues[1]!.id, version: p.version });
			}
			if (day === 25) await d.call("save-settings", { retention: 0.93, learningSteps: [1] });
			clock.now += DAY - 8 * 7 * MINUTE + 37 * MINUTE;
		}
		const file = d.file()!;
		assert.ok(reviewed > 60, `only ${reviewed} reviews`);
		assert.ok(file.reviews.some((r) => r.before?.state === 2 && r.rating === 1), "a lapse into relearning");
		assert.ok(file.reviews.some((r) => r.before?.state === 3), "a relearning step");
		assert.ok(new Set(file.reviews.map((r) => r.rating)).size === 4, "all four ratings");
		const rebuilt = rebuildFlashcards(file, null, scheduler);
		assert.equal(JSON.stringify(rebuilt), JSON.stringify(file));
		// And one fact at a time, field by field.
		for (const p of Object.values(file.propositions)) {
			const reviews = file.reviews.filter((r) => r.propositionId === p.id);
			const created = reviews.length ? reviews[0]!.before!.due : p.schedule.due;
			const result = replayProposition(created, reviews.map((r) => ({ id: r.id, cueId: r.cueId, rating: r.rating, at: r.at, settings: r.settings })), scheduler);
			assert.deepEqual(result.schedule, p.schedule);
			assert.equal(result.firstReviewedAt, p.firstReviewedAt);
			assert.equal(result.learningCueId === null || p.cues.some((c) => c.id === result.learningCueId) ? result.learningCueId : null, p.learningCueId);
			for (const r of reviews) assert.deepEqual(result.reviews.get(r.id), { before: r.before, after: r.after, introduced: r.introduced });
		}
	});

	it("when a fact is deleted and made again, seen by the sync between the two", async () => {
		clock.now = new Date(2026, 2, 2, 8).getTime();
		const d = device("pc");
		let memory: FlashcardsMemory | null = null;
		const look = () => { memory = readFlashcards(d.file(), memory, clock.now).memory; };
		await d.generate([{ id: "n_x", questions: ["X one?", "X two?"] }, { id: "n_y", questions: ["Y?"] }]);
		look();
		for (let day = 0; day < 6; day++) { await study(d, [3, 3, 4, 1, 3], 11 * MINUTE); look(); clock.now += DAY; }
		const p = (await d.state()).propositions.find((x) => x.id === "n_x")!;
		await d.call("delete-content", { revision: (await d.state()).revision, propositionIds: ["n_x"], deleteEmptyDecks: false, requestId: "del" });
		clock.now += 5 * MINUTE;
		look();
		assert.ok(memory!.items["e|n_x"], "the deletion is noted");
		await d.generate([{ id: "n_x", questions: ["X again?"] }]);
		look();
		for (let day = 0; day < 4; day++) { await study(d, [3, 1, 3, 4], 9 * MINUTE); look(); clock.now += DAY; }
		const file = d.file()!;
		assert.ok(file.reviews.filter((r) => r.propositionId === "n_x").length > file.reviews.filter((r) => r.propositionId === "n_x" && r.at > (memory!.items["e|n_x"] as number)).length, "old reviews are kept");
		assert.notEqual(file.propositions.n_x!.cues[0]!.id, p.cues[0]!.id);
		assert.equal(JSON.stringify(rebuildFlashcards(file, memory, scheduler)), JSON.stringify(file));
	});

	it("when a fact is deleted and made again between two looks of the sync", async () => {
		clock.now = new Date(2026, 3, 1, 8).getTime();
		const d = device("pc");
		await d.generate([{ id: "n_x", questions: ["X one?", "X two?"] }]);
		for (let day = 0; day < 3; day++) { await study(d, [3, 4, 1], 13 * MINUTE); clock.now += DAY; }
		const memory = readFlashcards(d.file(), null, clock.now).memory;
		await study(d, [3], MINUTE);
		await d.call("delete-content", { revision: (await d.state()).revision, propositionIds: ["n_x"], deleteEmptyDecks: false, requestId: "del" });
		clock.now += MINUTE;
		await d.generate([{ id: "n_x", questions: ["X anew?"] }]);
		clock.now += MINUTE;
		await study(d, [1, 3, 3], 12 * MINUTE);
		const read = readFlashcards(d.file(), memory, clock.now);
		assert.equal(typeof read.memory.items["e|n_x"], "number");
		const file = d.file()!;
		assert.ok(file.reviews.some((r) => r.propositionId === "n_x" && r.at <= (read.memory.items["e|n_x"] as number)));
		assert.equal(JSON.stringify(rebuildFlashcards(file, read.memory, scheduler)), JSON.stringify(file));
	});

	it("across a daylight-saving change in the process's time zone", async () => {
		// The sandbox's zone may have no DST; the replay runs in the same zone as the plugin either way.
		clock.now = new Date(2026, 2, 25, 20).getTime();
		const d = device("pc");
		await d.generate([{ id: "n_d", questions: ["D?"] }, { id: "n_e", questions: ["E?"] }]);
		for (let day = 0; day < 12; day++) { await study(d, [3, 4, 2, 3], 3 * 60 * MINUTE); clock.now += DAY / 2; }
		const file = d.file()!;
		assert.equal(JSON.stringify(rebuildFlashcards(file, null, scheduler)), JSON.stringify(file));
	});
});
