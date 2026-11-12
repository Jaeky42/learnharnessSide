/**
 * Flashcards sync (docs/phone-plugins-plan.md): THE WIRING. The pure rules
 * (sync-flashcards.test.ts) run here through the real per-item exchange
 * (maps-sync.ts, the second instance), the real files (flashcards-files.ts,
 * the library under each side's data folder, the memory beside the sync
 * state) and the plugin's REAL back end on each side, which is never
 * restarted: it sees what sync wrote by reading its file again (the one
 * edit to its store.cjs).
 *
 * Pins: the first sync combines both libraries, in pages both ways, with a
 * backup on each side first; a review travels and lands in the plugin
 * without a restart; plugin writes right before and right after a sync
 * write lose nothing (a stale write would read as deletions, and card
 * deletions are final); an idle round reads, hashes and writes nothing; a
 * generation under way holds the exchange on either side; a file in a
 * newer format is neither sent nor taken; a lost memory sends everything
 * again; a PC with no library brings no settings; no backup, no sync; the
 * PC's time zone goes once, and again when it changes.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { after, afterEach, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-fc-exchange-"));
process.env.LH_AUTH_FILE = path.join(TMP, "prod", "secrets", "auth.json");
process.env.LH_DATA_DIR = path.join(TMP, "prod", "data");

const { clock, DAY, Device, MINUTE, scheduler, graphNode } = await import("./sync-flashcards-harness.ts");
const { stateFile } = await import("../src/store/sync/state-file.ts");
const { makeFlashcardsBackup } = await import("../src/store/sync/backup.ts");
const { createMapsAuthority, createMapsDesktop, isAuthorityMapsState, isDesktopMapsState } = await import("../src/server/sync/maps-sync.ts");
const { createFlashcardsFiles, flashcardsDataDir } = await import("../src/server/sync/flashcards-files.ts");
const { authorityState, desktopState, FLASHCARDS_RULES, FLASHCARDS_SYNC_PATH } = await import("../src/server/sync/flashcards-engine.ts");
import type { SyncReply } from "../src/server/sync/client.ts";
import type { FlashcardsFile } from "../src/core/sync/flashcards.ts";

Date.now = () => clock.now;
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const SERVER = "https://learn.example.com";
let worlds = 0;
const cleanups: Array<() => void> = [];
afterEach(() => { for (const fn of cleanups.splice(0)) fn(); });

type Body = { cursor: number; all: boolean; changes: Array<{ key: string }>; more?: boolean; timeZone?: string };

/** One side: a data folder, the plugin's back end on its Flashcards folder, and the sync files over it. */
function side(root: string, name: string, opts: { plugin?: boolean } = {}) {
	const dataDir = path.join(root, name, "data");
	const syncDir = path.join(dataDir, "sync");
	fs.mkdirSync(dataDir, { recursive: true });
	fs.writeFileSync(path.join(dataDir, "plugins-state.json"), JSON.stringify({ version: 1, enabled: { flashcards: true } }));
	const announced: number[] = [];
	const files = createFlashcardsFiles({ dataDir, syncDir, now: () => clock.now, announce: () => announced.push(clock.now), scheduler });
	const device = opts.plugin === false ? null : new Device(name, flashcardsDataDir(dataDir));
	if (device) cleanups.push(() => device.dispose());
	const library = (): FlashcardsFile | null => { try { return JSON.parse(fs.readFileSync(path.join(flashcardsDataDir(dataDir), "flashcards.json"), "utf8")) as FlashcardsFile; } catch { return null; } };
	return { name, dataDir, syncDir, files, device, announced, library };
}

function world(opts: { page?: { items: number; bytes: number }; serverPlugin?: boolean } = {}) {
	const root = path.join(TMP, `w${++worlds}`);
	const server = side(root, "server", { plugin: opts.serverPlugin });
	const zones: Array<[string, string]> = [];
	let backupFails = false;
	const backup = (dataDir: string) => () => { if (backupFails) throw new Error("the disk is full"); return makeFlashcardsBackup(dataDir, new Date(clock.now)); };
	const authority = createMapsAuthority({
		files: server.files,
		state: authorityState(stateFile(path.join(server.syncDir, "flashcards.json"), isAuthorityMapsState), server.files),
		now: () => clock.now, rules: FLASHCARDS_RULES, busy: () => server.files.busy(), makeBackup: backup(server.dataDir),
		onTimeZone: (deviceId, zone) => zones.push([deviceId, zone]), page: opts.page,
	});

	function desktop(name: string, deviceId: string, o: { plugin?: boolean; zone?: () => string | null } = {}) {
		const s = side(root, name, o);
		const requests: Body[] = [];
		let online = true;
		const sync = createMapsDesktop({
			files: s.files,
			state: desktopState(stateFile(path.join(s.syncDir, "flashcards-desktop.json"), isDesktopMapsState), s.files),
			identity: () => ({ server: SERVER, deviceId }),
			request: async <T>(pathname: string, init: { method?: string; body?: unknown } = {}) => {
				assert.equal(pathname, FLASHCARDS_SYNC_PATH);
				if (!online) return { ok: false, reason: "offline" } as SyncReply<T>;
				const body = JSON.parse(JSON.stringify(init.body)) as Body;
				requests.push(body);
				const result = JSON.parse(JSON.stringify(authority.exchange(deviceId, body))) as { status: number; body: Record<string, unknown> };
				return (result.status === 200 ? { ok: true, body: result.body } : { ok: false, reason: "refused", status: result.status, code: result.body.code ?? null, error: String(result.body.error), body: result.body }) as SyncReply<T>;
			},
			now: () => clock.now, clockOffset: () => 0, timeZone: o.zone ?? (() => "Europe/Stockholm"),
			rules: FLASHCARDS_RULES, path: FLASHCARDS_SYNC_PATH, busy: () => s.files.busy(), makeBackup: backup(s.dataDir), page: opts.page,
		});
		return { ...s, sync, requests, setOnline: (value: boolean) => { online = value; } };
	}
	return { root, server, authority, zones, desktop, failBackups: (value: boolean) => { backupFails = value; } };
}

/** What the learner sees, the same on both sides once synced. */
function view(file: FlashcardsFile | null) {
	assert.ok(file, "there is a library");
	const { retention, learningSteps, relearningSteps, dayStart, chunkBudget } = file.settings;
	return {
		settings: { retention, learningSteps, relearningSteps, dayStart, chunkBudget },
		decks: file.decks.map((d) => ({ id: d.id, name: d.name, newLimit: d.newLimit, members: d.propositionIds })),
		propositions: Object.fromEntries(Object.entries(file.propositions).sort(([a], [b]) => a.localeCompare(b)).map(([id, p]) => [id, {
			schedule: p.schedule, firstReviewedAt: p.firstReviewedAt, cues: p.cues.map((c) => ({ id: c.id, question: c.question, latestRating: c.latestRating })),
		}])),
		reviews: [...file.reviews].map((r) => r.id).sort(),
	};
}

async function study(d: InstanceType<typeof Device>, ratings: number[]): Promise<void> {
	for (const rating of ratings) { assert.ok(await d.grade(rating), "a card was due"); clock.now += 10 * MINUTE; }
}

/** Rounds until nothing moves (what combining made whole travels back once). */
async function settle(...pcs: Array<{ sync: { round(): Promise<unknown> } }>): Promise<void> {
	for (let i = 0; i < 6; i++) {
		let moved = 0;
		for (const pc of pcs) {
			clock.now += 1000;
			const r = await pc.sync.round() as { ok: boolean; sent?: number; applied?: number };
			assert.equal(r.ok, true, JSON.stringify(r));
			moved += (r.sent ?? 0) + (r.applied ?? 0);
		}
		if (moved === 0) return;
	}
	throw new Error("did not settle");
}

/** Every file under a folder with its inode, size and modified time. */
function stamps(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (at: string) => {
		if (!fs.existsSync(at)) return;
		for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
			const full = path.join(at, entry.name);
			if (entry.isDirectory()) walk(full);
			else { const st = fs.statSync(full); out[path.relative(dir, full)] = `${st.ino}:${st.size}:${st.mtimeMs}`; }
		}
	};
	walk(dir);
	return out;
}

const share = (a: InstanceType<typeof Device>, b: InstanceType<typeof Device>) => {
	for (const n of a.graph.propositions) if (!b.graph.propositions.some((m) => m.id === n.id)) b.graph.propositions.push(structuredClone(n));
};

describe("Flashcards sync through the exchange", () => {
	it("combines both libraries at the first sync, in pages both ways, after a backup on each side, and the plugin sees it without a restart", async () => {
		clock.now = new Date(2026, 4, 4, 9).getTime();
		const w = world({ page: { items: 7, bytes: 4 * 1024 * 1024 } });
		const pc = w.desktop("pc", "dev_aaaaaaaaaaaaaaaa");
		await pc.device!.generate([{ id: "n_a", questions: ["A?", "A again?"] }, { id: "n_b", questions: ["B?"] }]);
		await w.server.device!.generate([{ id: "n_c", questions: ["C?"], session: "session-2" }, { id: "n_d", questions: ["D?"], session: "session-2" }]);
		await study(pc.device!, [3, 4, 1]);
		await study(w.server.device!, [4, 3]);
		clock.now += DAY;
		const before = { pc: view(pc.library()), server: view(w.server.library()) };
		share(pc.device!, w.server.device!); share(w.server.device!, pc.device!);

		await settle(pc);
		assert.deepEqual(view(pc.library()), view(w.server.library()), "the same library on both sides");
		const after = view(pc.library());
		for (const side of [before.pc, before.server]) {
			for (const [id, p] of Object.entries(side.propositions)) assert.deepEqual(after.propositions[id]!.schedule, p.schedule, `${id}'s schedule didn't move`);
			for (const id of side.reviews) assert.ok(after.reviews.includes(id), "every review kept");
		}
		assert.equal(after.decks.length, 2);
		// Pages: the PC's first exchange took several requests, each way.
		const first = pc.requests.filter((r) => r.all);
		assert.ok(first.filter((r) => r.more).length >= 2, "the PC's changes went in pages");
		assert.ok(first.length > first.filter((r) => r.more).length + 1, "and the server's answer came in pages");
		assert.ok(first.every((r) => r.changes.length <= 7));
		// One backup on each side, of the Flashcards folder as it was.
		for (const s of [pc, w.server]) {
			const backups = fs.readdirSync(path.join(path.dirname(s.dataDir), "backups"));
			assert.equal(backups.length, 1, s.name);
			assert.match(backups[0]!, /^before-first-flashcards-sync \d{4}-\d{2}-\d{2}$/);
			assert.ok(fs.existsSync(path.join(path.dirname(s.dataDir), "backups", backups[0]!, "core-plugin-data", "flashcards", "flashcards.json")));
		}
		// The plugin, never restarted, shows what arrived, and its open pages were told.
		const shown = await w.server.device!.state();
		assert.deepEqual(shown.decks.map((d) => d.propositionIds.length).sort(), [2, 2]);
		assert.ok(w.server.announced.length > 0 && pc.announced.length > 0);
		assert.deepEqual(w.zones, [["dev_aaaaaaaaaaaaaaaa", "Europe/Stockholm"]], "the time zone went once");
	});

	it("a review travels, and plugin writes right before and right after a sync write lose nothing", async () => {
		clock.now = new Date(2026, 4, 4, 9).getTime();
		const w = world();
		const pc = w.desktop("pc", "dev_aaaaaaaaaaaaaaaa");
		await pc.device!.generate([{ id: "n_a", questions: ["A?"] }, { id: "n_b", questions: ["B?"] }]);
		share(pc.device!, w.server.device!);
		await settle(pc);
		// The PC adds a card by hand and reviews; the server reviews right before the PC's round lands…
		const deck = pc.library()!.decks[0]!;
		const made = await pc.device!.call<{ cueId: string }>("create-card", { deckId: deck.id, name: "By hand", question: "Hand?", answer: "Made.", requestId: randomUUID() });
		await study(pc.device!, [3]);
		await study(w.server.device!, [4]);
		await pc.sync.round();
		// …and right after it, without the plugin starting again.
		await study(w.server.device!, [2]);
		await settle(pc);
		for (const s of [pc, w.server]) {
			const lib = s.library()!;
			assert.equal(lib.reviews.length, 3, `${s.name}: every review is there`);
			assert.ok(Object.values(lib.propositions).some((p) => p.cues.some((c) => c.id === made.cueId)), `${s.name}: the hand-made card survived the plugin's next write`);
		}
		assert.deepEqual(view(pc.library()), view(w.server.library()));
	});

	it("an idle round reads, hashes and writes nothing on either side", async (t) => {
		clock.now = new Date(2026, 4, 4, 9).getTime();
		const w = world();
		const pc = w.desktop("pc", "dev_aaaaaaaaaaaaaaaa");
		await pc.device!.generate([{ id: "n_a", questions: ["A?"] }]);
		await study(pc.device!, [3]);
		await settle(pc);
		const before = { pc: stamps(path.dirname(pc.dataDir)), server: stamps(path.dirname(w.server.dataDir)) };
		const reads: string[] = [];
		const real = fs.readFileSync;
		t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => { if (String(args[0]).includes("flashcards")) reads.push(String(args[0])); return real(...args); });
		for (let i = 0; i < 3; i++) { clock.now += 10_000; assert.deepEqual(await pc.sync.round(), { ok: true, sent: 0, applied: 0 }); }
		t.mock.restoreAll();
		assert.deepEqual(reads, [], "the cached snapshot was used");
		assert.deepEqual(stamps(path.dirname(pc.dataDir)), before.pc);
		assert.deepEqual(stamps(path.dirname(w.server.dataDir)), before.server);
	});

	it("a card edited on one side and deleted on the other while apart is deleted on both", async () => {
		clock.now = new Date(2026, 4, 4, 9).getTime();
		const w = world();
		const pc = w.desktop("pc", "dev_aaaaaaaaaaaaaaaa");
		await pc.device!.generate([{ id: "n_a", questions: ["A?", "A again?"] }]);
		share(pc.device!, w.server.device!);
		await settle(pc);
		const cue = pc.library()!.propositions.n_a!.cues[0]!;
		pc.setOnline(false);
		const p = (await pc.device!.state()).propositions.find((x) => x.id === "n_a")!;
		await pc.device!.call("delete-cue", { propositionId: "n_a", cueId: cue.id, version: p.version });
		assert.equal((await pc.sync.round()).ok, false);
		clock.now += MINUTE;
		const q = (await w.server.device!.state()).propositions.find((x) => x.id === "n_a")!;
		await w.server.device!.call("save-cue", { propositionId: "n_a", cueId: cue.id, question: "Edited later?", answer: "Yes.", version: q.version });
		pc.setOnline(true);
		await settle(pc);
		for (const s of [pc, w.server]) assert.deepEqual(s.library()!.propositions.n_a!.cues.map((c) => c.id).includes(cue.id), false, s.name);
		assert.deepEqual(view(pc.library()), view(w.server.library()));
	});

	it("a generation under way holds the exchange on the side that runs it, and it goes once that is done", async () => {
		clock.now = new Date(2026, 4, 4, 9).getTime();
		const w = world();
		const pc = w.desktop("pc", "dev_aaaaaaaaaaaaaaaa");
		await pc.device!.generate([{ id: "n_a", questions: ["A?"] }]);
		await settle(pc);
		// The server starts a generation and its model hasn't answered yet.
		const server = w.server.device!;
		server.graph.propositions.push(graphNode("n_s"));
		const plan = await server.call<{ id: string }>("preflight", { propositionIds: ["n_s"] });
		await server.call("start-generation", { preflightId: plan.id, requestId: randomUUID() });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(w.server.files.busy(), true);
		await study(pc.device!, [3]);
		const pcBefore = pc.library();
		assert.deepEqual(await pc.sync.round(), { ok: false, reason: "busy" });
		assert.deepEqual(pc.library(), pcBefore, "nothing taken while the server is busy");
		// The model answers; the batch ends; the next round carries everything.
		const workers = (server as unknown as { workers: { service: { list(): Array<{ id: string; status: string; input: { targets: string[] } }> }; complete(id: string, value: unknown): void } }).workers;
		for (const task of workers.service.list().filter((x) => x.status === "running")) workers.complete(task.id, { propositions: [{ propositionId: "n_s", cards: [{ question: "S?", answer: "S." }] }] });
		for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
		assert.equal(w.server.files.busy(), false);
		await settle(pc);
		assert.ok(pc.library()!.propositions.n_s, "the generated card reached the PC");
		assert.equal(w.server.library()!.reviews.length, 1, "the PC's review reached the server");
		// The same on the PC's side: its own generation holds its round, with no request at all.
		pc.device!.graph.propositions.push(graphNode("n_p"));
		const pcPlan = await pc.device!.call<{ id: string }>("preflight", { propositionIds: ["n_p"] });
		await pc.device!.call("start-generation", { preflightId: pcPlan.id, requestId: randomUUID() });
		await new Promise((resolve) => setImmediate(resolve));
		const asked = pc.requests.length;
		assert.deepEqual(await pc.sync.round(), { ok: false, reason: "busy" });
		assert.equal(pc.requests.length, asked);
		// A switched-off plugin runs nothing, so its file's batch doesn't hold anything.
		fs.writeFileSync(path.join(pc.dataDir, "plugins-state.json"), JSON.stringify({ version: 1, enabled: { flashcards: false } }));
		assert.equal(pc.files.busy(), false);
	});

	it("a file in a newer format is neither sent nor taken, and is left exactly as it is", async () => {
		clock.now = new Date(2026, 4, 4, 9).getTime();
		const w = world();
		await w.server.device!.generate([{ id: "n_s", questions: ["S?"] }]);
		const pc = w.desktop("pc", "dev_aaaaaaaaaaaaaaaa", { plugin: false });
		const file = path.join(flashcardsDataDir(pc.dataDir), "flashcards.json");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const newer = JSON.stringify({ version: 2, revision: 3, settings: {}, decks: [{ id: "d", name: "Future", newLimit: 1, propositionIds: [] }], propositions: {}, reviews: [], batches: [] });
		fs.writeFileSync(file, newer);
		assert.deepEqual(await pc.sync.round(), { ok: true, sent: 0, applied: 0 });
		assert.equal(fs.readFileSync(file, "utf8"), newer);
		assert.deepEqual(pc.requests.flatMap((r) => r.changes), []);
		assert.equal(w.server.library()!.decks.length, 1, "nothing of it reached the server");
	});

	it("a lost memory sends everything again, and nothing is lost", async () => {
		clock.now = new Date(2026, 4, 4, 9).getTime();
		const w = world();
		const pc = w.desktop("pc", "dev_aaaaaaaaaaaaaaaa");
		await pc.device!.generate([{ id: "n_a", questions: ["A?"] }, { id: "n_b", questions: ["B?"] }]);
		await study(pc.device!, [3, 4]);
		await settle(pc);
		const before = view(pc.library());
		fs.rmSync(path.join(pc.syncDir, "flashcards-memory.json"));
		clock.now += 1000;
		const round = await pc.sync.round();
		assert.equal(round.ok, true);
		const last = pc.requests.at(-1)!;
		assert.equal(last.all, true, "everything, once");
		assert.ok(last.changes.length >= 8);
		await settle(pc);
		assert.deepEqual(view(pc.library()), before);
		assert.deepEqual(view(w.server.library()), before);
		// And the server's own lost memory makes it start its table afresh: each PC sends everything once.
		fs.rmSync(path.join(w.server.syncDir, "flashcards-memory.json"));
		const asked = pc.requests.length;
		await settle(pc);
		assert.ok(pc.requests.slice(asked).some((r) => r.all && r.changes.length >= 8));
		assert.deepEqual(view(w.server.library()), before);
	});

	it("a PC with no library brings no settings: the server's stay, and its library arrives", async () => {
		clock.now = new Date(2026, 4, 4, 9).getTime();
		const w = world();
		await w.server.device!.generate([{ id: "n_s", questions: ["S?"] }]);
		await w.server.device!.call("save-settings", { retention: 0.85, dayStart: 6 });
		const pc = w.desktop("pc", "dev_aaaaaaaaaaaaaaaa", { plugin: false });
		await settle(pc);
		assert.equal(w.server.library()!.settings.retention, 0.85);
		assert.equal(w.server.library()!.settings.dayStart, 6);
		assert.deepEqual(view(pc.library()), view(w.server.library()));
		assert.equal(pc.library()!.settings.modelOverride, null, "the model choice is the PC's own default");
	});

	it("no backup, no Flashcards sync; it starts once the backup can be made", async () => {
		clock.now = new Date(2026, 4, 4, 9).getTime();
		const w = world();
		const pc = w.desktop("pc", "dev_aaaaaaaaaaaaaaaa");
		await pc.device!.generate([{ id: "n_a", questions: ["A?"] }]);
		w.failBackups(true);
		await assert.rejects(pc.sync.round(), /the disk is full/);
		assert.equal(pc.requests.length, 0);
		assert.equal(w.server.library(), null);
		w.failBackups(false);
		await settle(pc);
		assert.deepEqual(view(pc.library()), view(w.server.library()));
		// Once per side: no further backups.
		await settle(pc);
		assert.equal(fs.readdirSync(path.join(path.dirname(pc.dataDir), "backups")).length, 1);
	});

	it("the PC's time zone goes with its first exchange, and again only when it changes", async () => {
		clock.now = new Date(2026, 4, 4, 9).getTime();
		const w = world();
		let zone = "Europe/Stockholm";
		const pc = w.desktop("pc", "dev_aaaaaaaaaaaaaaaa", { zone: () => zone });
		await settle(pc);
		await settle(pc);
		zone = "America/New_York";
		await settle(pc);
		assert.deepEqual(w.zones, [["dev_aaaaaaaaaaaaaaaa", "Europe/Stockholm"], ["dev_aaaaaaaaaaaaaaaa", "America/New_York"]]);
		assert.equal(pc.requests.filter((r) => r.timeZone).length, 2);
	});
});
