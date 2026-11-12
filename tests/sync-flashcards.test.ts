/**
 * Flashcards sync (docs/phone-plugins-plan.md, decisions S1–S6 and the
 * "Flashcards sync" smaller rules): the pure rules, with two devices that
 * each run the plugin's real back end, synced through a stand-in for the
 * per-item exchange (latest change wins per key).
 *
 * Pins: both libraries combined at the first sync, nothing deleted; every
 * review from both devices counts and each schedule is worked out again;
 * a delete always wins for a card; a deck that still has cards stays; a
 * fact deleted and made again starts fresh; two decks from the same session
 * or the same file are joined; the same question twice keeps one; the later
 * reorder wins and what it doesn't know follows; settings travel, the model
 * choice doesn't; an idle exchange writes nothing; and every device ends
 * with the same library whatever order the changes arrived in.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
	applyFlashcardsChanges, checkFlashcardsChange, combine, emptyFlashcardsFile, flashcardsFormatTooNew, readFlashcards, rebuildFlashcards,
	type FlashcardsFile, type Items,
} from "../src/core/sync/flashcards.ts";
import { clock, DAY, Device, Hub, MINUTE, scheduler } from "./sync-flashcards-harness.ts";

Date.now = () => clock.now;

const devices: Device[] = [];
const device = (name: string): Device => { const d = new Device(name); devices.push(d); return d; };
afterEach(() => { for (const d of devices.splice(0)) d.dispose(); });

/** What the learner sees of a library, the same on every device after a sync. */
function view(file: FlashcardsFile | null) {
	assert.ok(file);
	const { retention, learningSteps, relearningSteps, dayStart, chunkBudget } = file.settings;
	return {
		settings: { retention, learningSteps, relearningSteps, dayStart, chunkBudget },
		decks: file.decks.map((d) => ({ id: d.id, name: d.name, newLimit: d.newLimit, sourceId: d.sourceId, members: d.propositionIds })),
		propositions: Object.fromEntries(Object.entries(file.propositions).sort(([a], [b]) => a.localeCompare(b)).map(([id, p]) => [id, {
			name: p.name, statement: p.statement, schedule: p.schedule, firstReviewedAt: p.firstReviewedAt, learningCueId: p.learningCueId,
			cues: p.cues.map((c) => ({ id: c.id, question: c.question, answer: c.answer, latestRating: c.latestRating, lastReviewedAt: c.lastReviewedAt })),
		}])),
		reviews: [...file.reviews].sort((a, b) => a.id.localeCompare(b.id)).map((r) => ({ id: r.id, p: r.propositionId, rating: r.rating, at: r.at, before: r.before, after: r.after, introduced: r.introduced })),
		files: Object.values(file.fileSources ?? {}).map((s) => ({ id: s.id, name: s.name, fingerprint: s.fingerprint, deckId: s.deckId, deckName: s.deckName })).sort((a, b) => a.id.localeCompare(b.id)),
	};
}

const sameEverywhere = (...ds: Device[]): void => {
	const first = view(ds[0]!.file());
	for (const d of ds.slice(1)) assert.deepEqual(view(d.file()), first, `${d.name} differs from ${ds[0]!.name}`);
};

async function study(d: Device, ratings: number[], step = 10 * MINUTE): Promise<void> {
	for (const rating of ratings) { await d.grade(rating); clock.now += step; }
}

const deckNamed = (d: Device, name: string) => d.file()!.decks.find((x) => x.name === name)!;
const share = (from: Device, to: Device) => { for (const n of from.graph.propositions) if (!to.graph.propositions.some((m) => m.id === n.id)) to.graph.propositions.push(structuredClone(n)); };

describe("Flashcards sync: the first sync", () => {
	it("combines both libraries, joins the two decks of one session, deletes nothing, and keeps every schedule", async () => {
		clock.now = new Date(2026, 4, 4, 9).getTime();
		const pc = device("pc"), server = device("server");
		await pc.generate([{ id: "n_a", questions: ["A?", "A again?"] }, { id: "n_shared", questions: ["Shared?"] }]);
		await server.generate([{ id: "n_b", questions: ["B?"], session: "session-2" }, { id: "n_c", questions: ["C?"] }]);
		await study(pc, [3, 4, 1, 3]);
		await study(server, [4, 3]);
		clock.now += DAY;
		const pcBefore = view(pc.file()), serverBefore = view(server.file());
		share(pc, server); share(server, pc);
		const hub = new Hub();
		hub.settle(pc, server);
		sameEverywhere(pc, server);
		const after = view(pc.file());
		const lesson = after.decks.filter((d) => d.sourceId === "session-1");
		assert.equal(lesson.length, 1, "one deck for the session");
		assert.deepEqual([...lesson[0]!.members].sort(), ["n_a", "n_c", "n_shared"]);
		assert.ok(after.decks.some((d) => d.sourceId === "session-2" && d.members.includes("n_b")));
		// Nothing is lost, and nobody's schedule moved.
		for (const before of [pcBefore, serverBefore]) {
			for (const [id, p] of Object.entries(before.propositions)) {
				assert.deepEqual(after.propositions[id]!.schedule, p.schedule, id);
				assert.deepEqual(after.propositions[id]!.cues, p.cues, id);
			}
			for (const r of before.reviews) assert.deepEqual(after.reviews.find((x) => x.id === r.id), r);
		}
		// The plugin opens what was written and works on it.
		pc.activate(); server.activate();
		assert.ok((await pc.state()).decks.length === 2);
		await study(server, [3, 3, 3]);
		hub.settle(pc, server);
		sameEverywhere(pc, server);
	});

	it("puts the decks of a PC whose plugin was never used onto it, and the plugin starts on that file", async () => {
		clock.now = new Date(2026, 4, 6, 9).getTime();
		const pc = device("pc"), server = device("server");
		await server.generate([{ id: "n_s", questions: ["S?"] }]);
		await study(server, [3]);
		assert.equal(pc.file(), null);
		share(server, pc);
		new Hub().settle(server, pc);
		sameEverywhere(pc, server);
		pc.activate();
		assert.equal((await pc.state()).decks.length, 1);
	});
});

describe("Flashcards sync: two devices apart", () => {
	async function paired() {
		clock.now = new Date(2026, 5, 1, 9).getTime();
		const pc = device("pc"), server = device("server");
		await pc.generate([{ id: "n_1", questions: ["One?", "One more?"] }, { id: "n_2", questions: ["Two?"] }]);
		share(pc, server);
		const hub = new Hub();
		hub.settle(pc, server);
		sameEverywhere(pc, server);
		return { pc, server, hub };
	}

	it("combines a fact's decks: put in different decks on each side, it is in all of them; taken out of one, that travels", async () => {
		clock.now = new Date(2026, 5, 1, 9).getTime();
		const pc = device("pc"), server = device("server");
		await pc.generate([{ id: "n_s", questions: ["Shared?"] }]);
		share(pc, server);
		await server.generate([{ id: "n_s", questions: ["Shared, asked on the phone?"] }]);
		const put = async (d: Device, name: string) => {
			await d.call("create-deck", { name });
			const state = await d.state();
			await d.call("set-memberships", { propositionId: "n_s", deckIds: [deckNamed(d, "Lesson one").id, state.decks.find((x) => x.name === name)!.id] });
		};
		await put(pc, "PC deck"); clock.now += MINUTE;
		await put(server, "Phone deck"); clock.now += MINUTE;
		const hub = new Hub();
		hub.settle(pc, server);
		sameEverywhere(pc, server);
		const decksOf = (d: Device) => d.file()!.decks.filter((x) => x.propositionIds.includes("n_s")).map((x) => x.name).sort();
		assert.deepEqual(decksOf(pc), ["Lesson one", "PC deck", "Phone deck"], "nothing the first sync combined is dropped");
		// Taken out of two decks on the PC; put into a new one on the phone meanwhile: both stand.
		await pc.call("set-memberships", { propositionId: "n_s", deckIds: [deckNamed(pc, "PC deck").id] });
		await server.call("create-deck", { name: "Later deck" });
		await server.call("set-memberships", { propositionId: "n_s", deckIds: [...server.file()!.decks.filter((x) => x.propositionIds.includes("n_s")).map((x) => x.id), deckNamed(server, "Later deck").id] });
		hub.settle(pc, server);
		sameEverywhere(pc, server);
		assert.deepEqual(decksOf(server), ["Later deck", "PC deck"]);
	});

	it("keeps cards generated into a deck on one device and the deck's new name from the other", async () => {
		const { pc, server, hub } = await paired();
		await pc.generate([{ id: "n_3", questions: ["Three?"] }]);
		const deck = deckNamed(server, "Lesson one");
		clock.now += MINUTE;
		await server.call("save-deck", { id: deck.id, name: "Renamed", newLimit: 7 });
		share(pc, server);
		hub.settle(pc, server);
		sameEverywhere(pc, server);
		const d = pc.file()!.decks[0]!;
		assert.equal(d.name, "Renamed");
		assert.equal(d.newLimit, 7);
		assert.deepEqual(d.propositionIds, ["n_1", "n_2", "n_3"]);
	});

	for (const order of ["edit first", "delete first"] as const) {
		it(`deletes a card edited on the other device (${order})`, async () => {
			const { pc, server, hub } = await paired();
			const cue = pc.file()!.propositions.n_1!.cues[0]!;
			const edit = async () => { const p = (await server.state()).propositions.find((x) => x.id === "n_1")!; await server.call("save-cue", { propositionId: "n_1", cueId: cue.id, question: "Edited?", answer: "Edited.", version: p.version }); };
			const remove = async () => { const p = (await pc.state()).propositions.find((x) => x.id === "n_1")!; await pc.call("delete-cue", { propositionId: "n_1", cueId: cue.id, version: p.version }); };
			if (order === "edit first") { await edit(); clock.now += MINUTE; await remove(); } else { await remove(); clock.now += MINUTE; await edit(); }
			hub.settle(server, pc);
			sameEverywhere(pc, server);
			assert.ok(!pc.file()!.propositions.n_1!.cues.some((c) => c.id === cue.id));
			assert.equal(pc.file()!.propositions.n_1!.cues.length, 1);
			// And it stays deleted when the editing device edits again.
			hub.settle(pc, server);
			assert.ok(!server.file()!.propositions.n_1!.cues.some((c) => c.id === cue.id));
		});
	}

	it("counts the reviews of both devices, introduces a fact once, and works out the same schedule on both", async () => {
		const { pc, server, hub } = await paired();
		clock.now += DAY;
		await study(pc, [3, 3, 1, 4], 7 * MINUTE);
		clock.now += 3 * MINUTE;
		await study(server, [4, 2, 3], 5 * MINUTE);
		hub.settle(pc, server);
		sameEverywhere(pc, server);
		const file = pc.file()!;
		assert.ok(file.reviews.length >= 6);
		for (const id of ["n_1", "n_2"]) assert.equal(file.reviews.filter((r) => r.propositionId === id && r.introduced).length, 1, id);
		// What both devices hold is exactly the plugin's replay of the merged history.
		assert.equal(JSON.stringify(rebuildFlashcards(file, pc.memory, scheduler)), JSON.stringify(file));
		pc.activate();
		await study(pc, [3, 3], DAY);
		hub.settle(pc, server);
		sameEverywhere(pc, server);
	});

	it("keeps a deleted deck that got a new card on the other device, with that fact starting fresh", async () => {
		const { pc, server, hub } = await paired();
		clock.now += DAY;
		await study(pc, [3, 3, 3]);
		hub.settle(pc, server);
		const deck = pc.file()!.decks[0]!;
		clock.now += MINUTE;
		await pc.call("delete-deck", { id: deck.id });
		assert.equal(pc.file()!.decks.length, 0);
		clock.now += MINUTE;
		await server.call("create-cue", { requestId: "late", propositionId: "n_2", question: "Two, later?", answer: "Later." });
		hub.settle(pc, server);
		sameEverywhere(pc, server);
		const file = pc.file()!;
		assert.deepEqual(file.decks.map((d) => ({ id: d.id, members: d.propositionIds })), [{ id: deck.id, members: ["n_2"] }]);
		assert.deepEqual(file.propositions.n_2!.cues.map((c) => c.question), ["Two, later?"]);
		assert.equal(file.propositions.n_1, undefined);
		assert.equal(file.propositions.n_2!.schedule.state, 0, "starts fresh");
		assert.ok(file.reviews.some((r) => r.propositionId === "n_2"), "its old reviews are kept for the charts");
	});

	it("deletes a fact on both devices when the other one went on reviewing it, and keeps those reviews for the charts", async () => {
		const { pc, server, hub } = await paired();
		clock.now += DAY;
		await pc.call("delete-content", { revision: (await pc.state()).revision, propositionIds: ["n_1"], deleteEmptyDecks: true, requestId: "gone" });
		clock.now += MINUTE;
		assert.ok(await server.grade(3, { propositionIds: ["n_1"] }));
		hub.settle(pc, server);
		sameEverywhere(pc, server);
		assert.equal(pc.file()!.propositions.n_1, undefined);
		assert.deepEqual(pc.file()!.decks[0]!.propositionIds, ["n_2"]);
		assert.equal(pc.file()!.reviews.filter((r) => r.propositionId === "n_1").length, 1);
	});

	it("starts a fact deleted and made again afresh on both devices", async () => {
		const { pc, server, hub } = await paired();
		clock.now += DAY;
		await study(server, [3, 4, 3]);
		hub.settle(pc, server);
		await pc.call("delete-content", { revision: (await pc.state()).revision, propositionIds: ["n_1"], deleteEmptyDecks: false, requestId: "del" });
		hub.settle(pc, server);
		assert.equal(server.file()!.propositions.n_1, undefined);
		clock.now += MINUTE;
		await server.generate([{ id: "n_1", questions: ["One, anew?"] }]);
		hub.settle(pc, server);
		sameEverywhere(pc, server);
		assert.equal(pc.file()!.propositions.n_1!.schedule.state, 0);
		assert.ok(await pc.grade(3, { propositionIds: ["n_1"] }));
		hub.settle(pc, server);
		sameEverywhere(pc, server);
		assert.equal(server.file()!.propositions.n_1!.schedule.reps, 1);
	});

	it("keeps both of two same-question cards a device made itself, there and everywhere", async () => {
		const { pc, server, hub } = await paired();
		await pc.call("create-cue", { requestId: "a1", propositionId: "n_2", question: "Twice?", answer: "One." });
		await pc.call("create-cue", { requestId: "a2", propositionId: "n_2", question: "Twice? ", answer: "Two." });
		hub.settle(pc, server);
		sameEverywhere(pc, server);
		assert.equal(server.file()!.propositions.n_2!.cues.filter((c) => c.question.trim() === "Twice?").length, 2);
		// An edit that makes two questions equal keeps both too.
		const p = (await server.state()).propositions.find((x) => x.id === "n_2")!;
		const one = p.cues.find((c) => c.question === "Twice?")!;
		await server.call("save-cue", { propositionId: "n_2", cueId: p.cues[0]!.id, question: one.question, answer: "Same now.", version: p.version });
		hub.settle(pc, server);
		sameEverywhere(pc, server);
		assert.equal(pc.file()!.propositions.n_2!.cues.length, 3);
	});

	it("keeps one of two cards with the same question on one fact, made on two devices", async () => {
		const { pc, server, hub } = await paired();
		await pc.call("create-cue", { requestId: "a", propositionId: "n_2", question: "  Same?", answer: "From the PC." });
		clock.now += MINUTE;
		await server.call("create-cue", { requestId: "b", propositionId: "n_2", question: "Same?  ", answer: "From the server." });
		hub.settle(pc, server);
		sameEverywhere(pc, server);
		const cues = pc.file()!.propositions.n_2!.cues;
		assert.equal(cues.filter((c) => c.question.trim() === "Same?").length, 1);
		assert.equal(cues.find((c) => c.question.trim() === "Same?")!.answer, "From the PC.", "the earlier one stays");
	});

	it("lets the later reorder win, and adds what it doesn't know at the end", async () => {
		const { pc, server, hub } = await paired();
		await pc.call("create-deck", { name: "Second" });
		hub.settle(pc, server);
		// The PC reorders; the server, later, reorders the other way and adds a deck.
		const [first, second] = pc.file()!.decks;
		await pc.call("reorder", { kind: "deck", id: second!.id, direction: -1 });
		clock.now += MINUTE;
		await server.call("create-deck", { name: "Third" });
		hub.settle(pc, server);
		sameEverywhere(pc, server);
		assert.deepEqual(pc.file()!.decks.map((d) => d.name), ["Second", "Lesson one", "Third"], "a deck added at the end doesn't undo the reorder");
		clock.now += MINUTE;
		await pc.call("reorder", { kind: "deck", id: first!.id, direction: -1 });
		clock.now += MINUTE;
		await server.call("reorder", { kind: "deck", id: deckNamed(server, "Third").id, direction: -1 });
		await server.call("reorder", { kind: "deck", id: deckNamed(server, "Third").id, direction: -1 });
		await pc.call("create-deck", { name: "Fourth" });
		hub.settle(pc, server);
		sameEverywhere(pc, server);
		assert.deepEqual(pc.file()!.decks.map((d) => d.name), ["Third", "Second", "Lesson one", "Fourth"]);
		// Cards inside a fact the same way.
		const cues = pc.file()!.propositions.n_1!.cues;
		await server.call("reorder", { kind: "cue", propositionId: "n_1", id: cues[1]!.id, direction: -1 });
		await pc.call("create-cue", { requestId: "new", propositionId: "n_1", question: "One, third?", answer: "Third." });
		hub.settle(pc, server);
		sameEverywhere(pc, server);
		assert.deepEqual(pc.file()!.propositions.n_1!.cues.map((c) => c.question), ["One more?", "One?", "One, third?"]);
	});

	it("syncs the scheduling settings and the chunk budget, latest change wins, never the model choice", async () => {
		const { pc, server, hub } = await paired();
		await pc.call("save-settings", { retention: 0.8, modelOverride: { provider: "mock", id: "cheap" } });
		clock.now += MINUTE;
		await server.call("save-settings", { retention: 0.95, chunkBudget: 1234, dayStart: 2 });
		hub.settle(pc, server);
		sameEverywhere(pc, server);
		assert.equal(pc.file()!.settings.retention, 0.95);
		assert.equal(pc.file()!.settings.chunkBudget, 1234);
		assert.deepEqual(pc.file()!.settings.modelOverride, { provider: "mock", id: "cheap" });
		assert.equal(server.file()!.settings.modelOverride, null);
		assert.ok([...hub.table.keys()].every((key) => !JSON.stringify(hub.table.get(key)!.value ?? null).includes("modelOverride")));
	});

	it("writes nothing on an idle exchange, and raises a fact's version only when it changed", async () => {
		const { pc, server, hub } = await paired();
		await study(pc, [3]);
		hub.settle(pc, server);
		const raw = pc.raw(), writes = pc.writes, serverRaw = server.raw();
		const memory = JSON.stringify(pc.memory);
		for (let i = 0; i < 3; i++) { clock.now += 10_000; hub.round(pc); hub.round(server); }
		assert.equal(pc.raw(), raw);
		assert.equal(server.raw(), serverRaw);
		assert.equal(pc.writes, writes);
		assert.equal(JSON.stringify(pc.memory), memory);
		const versions = Object.fromEntries(Object.values(server.file()!.propositions).map((p) => [p.id, p.version]));
		await server.call("create-cue", { requestId: "v", propositionId: "n_2", question: "Two, b?", answer: "B." });
		const pcVersions = Object.fromEntries(Object.values(pc.file()!.propositions).map((p) => [p.id, p.version]));
		hub.settle(pc, server);
		const after = Object.fromEntries(Object.values(pc.file()!.propositions).map((p) => [p.id, p.version]));
		assert.equal(after.n_1, pcVersions.n_1, "an unchanged fact keeps its version, so a review open on it stays valid");
		assert.equal(after.n_2, pcVersions.n_2! + 1);
		assert.ok(versions.n_2 !== undefined);
		assert.equal(pc.file()!.revision > JSON.parse(raw!).revision, true);
	});
});

describe("Flashcards sync: the rules on their own", () => {
	const deck = (name: string, s: number, at: number, sourceId?: string) => ({ name, newLimit: 20, ...(sourceId ? { sourceId } : {}), s, at });
	const fact = (created: number) => ({ origin: "graph", name: "F", statement: "S", created });

	it("a fact taken out of every deck stays in one that isn't deleted, or, if all are, keeps that deck", () => {
		const base: Array<[string, unknown]> = [
			["d|deck-a", deck("A", 1, 10)], ["d|deck-b", deck("B", 2, 20)],
			["p|n_1", fact(1)], ["c|c1", { p: "n_1", q: "Q1", a: "A", s: 1 }],
			["m|deck-a|n_1", { in: false, s: 5 }], ["m|deck-b|n_1", { in: false, s: 9 }],
		];
		const placed = (items: Items) => combine(items).placement.decks.filter((d) => d.members.includes("n_1")).map((d) => d.id);
		assert.deepEqual(placed(new Map(base)), ["deck-b"], "the one it was put in last");
		assert.deepEqual(placed(new Map([...base, ["x|deck-b", 1]])), ["deck-a"], "never a deleted deck while another is there");
		const all = combine(new Map([...base, ["x|deck-a", 1], ["x|deck-b", 1]]));
		assert.deepEqual(all.placement.decks.map((d) => [d.id, d.members]), [["deck-b", ["n_1"]]], "all deleted: the last one stays, with the fact");
		assert.equal(all.items.has("x|deck-b"), false);
	});

	it("joins two decks made from the same uploaded file: the earliest stays, the newest name wins", () => {
		const items: Items = new Map<string, unknown>([
			["d|deck-b", deck("Old name", 2, 50)], ["d|deck-a", deck("Newest name", 3, 90)], ["d|deck-c", deck("Other", 1, 10)],
			["f|src-1", { name: "notes.md", fingerprint: "fp", deckId: "deck-b" }], ["f|src-2", { name: "notes.md", fingerprint: "fp", deckId: "deck-a" }],
			["p|file:1", { ...fact(1), origin: "file", sourceId: "src-1" }], ["m|deck-b|file:1", { in: true, s: 5 }], ["c|c1", { p: "file:1", q: "Q1", a: "A", s: 1 }],
			["p|file:2", { ...fact(1), origin: "file", sourceId: "src-2" }], ["m|deck-a|file:2", { in: true, s: 6 }], ["c|c2", { p: "file:2", q: "Q2", a: "A", s: 2 }],
		]);
		const { items: out, placement } = combine(items);
		assert.deepEqual(placement.decks.map((d) => [d.id, d.item.name, d.members]), [["deck-c", "Other", []], ["deck-b", "Newest name", ["file:1", "file:2"]]]);
		assert.equal(out.get("x|deck-a"), 1);
		assert.deepEqual([...placement.files.values()].map((f) => f.deckId), ["deck-b", "deck-b"]);
	});

	it("gives the same library whatever order and batches the changes arrive in", async () => {
		clock.now = new Date(2026, 6, 1, 9).getTime();
		const a = device("a"), b = device("b");
		await a.generate([{ id: "n_1", questions: ["1?", "1b?"] }, { id: "n_2", questions: ["2?"] }]);
		await b.generate([{ id: "n_1", questions: ["1?", "1c?"] }, { id: "n_3", questions: ["3?"], session: "session-2" }]);
		a.read(); b.read();
		await study(a, [3, 1, 3]); await study(b, [4, 3]);
		await b.call("save-settings", { retention: 0.86 });
		// Deletions and a reorder, noted by each device's own look.
		const cue = a.file()!.propositions.n_1!.cues[1]!;
		await a.call("delete-cue", { propositionId: "n_1", cueId: cue.id, version: (await a.state()).propositions.find((p) => p.id === "n_1")!.version });
		await b.call("create-deck", { name: "Spare" });
		b.read();
		await b.call("delete-deck", { id: deckNamed(b, "Spare").id });
		await b.call("reorder", { kind: "proposition", deckId: deckNamed(b, "Lesson one").id, id: "n_1", direction: 1 });
		const fromA = a.read().items, fromB = b.read().items;
		assert.equal(fromA.get(`k|${cue.id}`), 1);
		// One value per key, as the exchange delivers them: the server's settings change is the later.
		const merged = new Map(fromA);
		for (const [key, value] of fromB) if (!merged.has(key) || key.startsWith("s|")) merged.set(key, value);
		const all = [...merged];
		let seed = 7;
		const random = (): number => { seed = (seed + 0x6d2b79f5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
		const results = new Set<string>();
		for (let run = 0; run < 25; run++) {
			const shuffled = [...all];
			for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]; }
			let file: FlashcardsFile | null = null, memory = null;
			for (let i = 0; i < shuffled.length;) {
				const size = 1 + Math.floor(random() * 30);
				const out = applyFlashcardsChanges(file, memory, new Map(shuffled.slice(i, i + size)), { now: clock.now, scheduler });
				file = out.file; memory = out.memory;
				i += size;
			}
			results.add(JSON.stringify(view(file)));
		}
		// And onto the two devices that made them.
		for (const d of [a, b]) { d.apply(new Map(all)); results.add(JSON.stringify(view(d.file()))); }
		assert.equal(results.size, 1);
		const one = JSON.parse([...results][0]!) as ReturnType<typeof view>;
		// Pairing two same-question cards is the exchange's decision (who had what), not the items': none here.
		assert.equal(one.propositions.n_1!.cues.filter((c) => c.question === "1?").length, 2);
		assert.equal(one.decks.filter((d) => d.sourceId === "session-1").length, 1);
	});

	it("checks what arrives, and the format lock", () => {
		assert.ok(checkFlashcardsChange({ key: "s|retention", value: 0.9, t: 1 }));
		assert.equal(checkFlashcardsChange({ key: "s|retention", value: 2, t: 1 }), null);
		assert.equal(checkFlashcardsChange({ key: "s|modelOverride", value: null, t: 1 }), null);
		assert.equal(checkFlashcardsChange({ key: "c|x", value: { p: "n", q: " ", a: "A", s: 1 }, t: 1 }), null);
		assert.equal(checkFlashcardsChange({ key: "r|x", value: { p: "n", c: "c", rating: 5, at: 1, deckIds: [], settings: {} }, t: 1 }), null);
		assert.equal(checkFlashcardsChange({ key: "r|x", value: { p: "n", c: "c", rating: 3, at: 1, deckIds: [], settings: { modelOverride: {} } }, t: 1 }), null);
		assert.ok(checkFlashcardsChange({ key: "r|x", value: { p: "n", c: "c", rating: 3, at: 1, deckIds: [], settings: { retention: 0.9 } }, t: 1 }));
		assert.ok(checkFlashcardsChange({ key: "k|x", value: null, t: 1 }));
		assert.equal(checkFlashcardsChange({ key: "z|x", value: 1, t: 1 }), null);
		assert.equal(flashcardsFormatTooNew(1), false);
		assert.equal(flashcardsFormatTooNew(2), true);
	});

	it("never takes a deletion of a review, a fact or a deck from a missing value, and sets the memory aside for a file that lost a review", () => {
		const file = emptyFlashcardsFile();
		file.decks.push({ id: "d1", name: "D", newLimit: 20, propositionIds: ["n_1"] });
		file.propositions.n_1 = { id: "n_1", origin: "graph", name: "F", statement: "S", cues: [{ id: "c1", question: "Q?", answer: "A", latestRating: null }], schedule: scheduler.createSchedule(5), firstReviewedAt: null, learningCueId: null, version: 1 };
		const first = readFlashcards(file, null, 10);
		const nulls = new Map([...first.items.keys()].filter((key) => !key.startsWith("s|")).map((key) => [key, null]));
		const out = applyFlashcardsChanges(file, first.memory, nulls, { now: 20, scheduler });
		assert.equal(out.changed, false);
		const withReview = applyFlashcardsChanges(file, first.memory, new Map([["r|r1", { p: "n_1", c: "c1", rating: 3, at: 100, deckIds: ["d1"], settings: { retention: 0.9 } }]]), { now: 30, scheduler });
		assert.equal(withReview.file!.reviews.length, 1);
		assert.equal(withReview.file!.propositions.n_1!.schedule.reps, 1);
		// The file without that review can't follow the memory (put back, or replaced): nothing is read as deleted.
		const lost = readFlashcards(file, withReview.memory, 40);
		assert.equal(lost.stale, true);
		assert.deepEqual([...lost.items.keys()].filter((key) => /^[xke]\|/.test(key)), []);
		// An odd value in the file isn't sent (the other side would refuse the whole exchange), and isn't taken as gone.
		const odd = structuredClone(file);
		odd.settings.retention = 5;
		const read = readFlashcards(odd, first.memory, 50);
		assert.equal(read.items.has("s|retention"), false);
		assert.ok(read.missing.has("s|retention"));
		assert.equal(applyFlashcardsChanges(odd, first.memory, new Map(), { now: 60, scheduler }).changed, false);
	});
});
