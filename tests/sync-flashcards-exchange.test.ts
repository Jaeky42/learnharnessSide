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
const { authorityState, desktopState, FLASHCARDS_RULES, FLASHCARDS_SYNC_PATH, watchFlashcardsChanges } = await import("../src/server/sync/flashcards-engine.ts");
const { takeTimeZone } = await import("../src/server/sync/flashcards-zone.ts");
import type { SyncReply } from "../src/server/sync/client.ts";
import type { FlashcardsFile } from "../src/core/sync/flashcards.ts";
import type { ServerEvent } from "../src/core/events.ts";

Date.now = () => clock.now;
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const SERVER = "https://learn.example.com";
let worlds = 0;
const cleanups: Array<() => void> = [];
afterEach(() => { for (const fn of cleanups.splice(0)) fn(); });

type Body = { cursor: number; all: boolean; changes: Array<{ key: string; value?: unknown }>; more?: boolean; probe?: boolean; timeZone?: string };

/** One side: a data folder, the plugin's back end on its Flashcards folder, and the sync files over it. */
function side(root: string, name: string, opts: { plugin?: boolean } = {}) {
	const dataDir = path.join(root, name, "data");
	const syncDir = path.join(dataDir, "sync");
	fs.mkdirSync(dataDir, { recursive: true });
	fs.writeFileSync(path.join(dataDir, "plugins-state.json"), JSON.stringify({ version: 1, enabled: { flashcards: true } }));
	const announced: number[] = [];
	const logged: string[] = [];
	const files = createFlashcardsFiles({ dataDir, syncDir, now: () => clock.now, announce: () => announced.push(clock.now), scheduler, log: (line) => logged.push(line) });
	const device = opts.plugin === false ? null : new Device(name, flashcardsDataDir(dataDir));
	if (device) cleanups.push(() => device.dispose());
	const library = (): FlashcardsFile | null => { try { return JSON.parse(fs.readFileSync(path.join(flashcardsDataDir(dataDir), "flashcards.json"), "utf8")) as FlashcardsFile; } catch { return null; } };
	/** The snapshot this side keeps is what a fresh read of its files gives (nothing cached is wrong). */
	const assertCacheSound = (): void => {
		const kept = files.read();
		const fresh = createFlashcardsFiles({ dataDir, syncDir, now: () => clock.now, announce: () => {}, scheduler, log: () => {} }).read();
		const hashes = (s: typeof kept) => Object.fromEntries([...s.items].map(([key, item]) => [key, item.h]).sort(([a], [b]) => String(a).localeCompare(String(b))));
		assert.deepEqual(hashes(kept), hashes(fresh), `${name}: the kept snapshot is a fresh read's`);
	};
	return { name, dataDir, syncDir, files, device, announced, library, logged, assertCacheSound };
}

function world(opts: { page?: { items: number; bytes: number }; serverPlugin?: boolean; realZone?: boolean } = {}) {
	const root = path.join(TMP, `w${++worlds}`);
	const server = side(root, "server", { plugin: opts.serverPlugin });
	const zones: Array<[string, string]> = [];
	let backupFails = false;
	const backup = (dataDir: string) => () => { if (backupFails) throw new Error("the disk is full"); return makeFlashcardsBackup(dataDir, new Date(clock.now)); };
	const authority = createMapsAuthority({
		files: server.files,
		state: authorityState(stateFile(path.join(server.syncDir, "flashcards.json"), isAuthorityMapsState), server.files),
		now: () => clock.now, rules: FLASHCARDS_RULES, busy: () => server.files.busy(), locked: () => server.files.locked(), makeBackup: backup(server.dataDir),
		onTimeZone: (deviceId, zone) => {
			zones.push([deviceId, zone]);
			// As flashcards-engine.ts does: this process takes the zone, and works every schedule out again in it.
			if (opts.realZone && takeTimeZone(deviceId, zone, { syncDir: server.syncDir, now: clock.now })) server.files.rebuild();
		},
		page: opts.page,
	});

	function desktop(name: string, deviceId: string, o: { plugin?: boolean; zone?: () => string | null; hold?: (body: Body) => Promise<void>; offset?: number } = {}) {
		const s = side(root, name, o);
		const requests: Body[] = [];
		let online = true;
		let zoneChanges = 0;
		/** The next answer is lost on the way back (the server did its part). */
		let dropNext = false;
		const sync = createMapsDesktop({
			files: s.files,
			state: desktopState(stateFile(path.join(s.syncDir, "flashcards-desktop.json"), isDesktopMapsState), s.files),
			identity: () => ({ server: SERVER, deviceId }),
			request: async <T>(pathname: string, init: { method?: string; body?: unknown } = {}) => {
				assert.equal(pathname, FLASHCARDS_SYNC_PATH);
				if (!online) return { ok: false, reason: "offline" } as SyncReply<T>;
				const body = JSON.parse(JSON.stringify(init.body)) as Body;
				await o.hold?.(body);
				requests.push(body);
				const result = JSON.parse(JSON.stringify(authority.exchange(deviceId, body))) as { status: number; body: Record<string, unknown> };
				if (dropNext) { dropNext = false; return { ok: false, reason: "offline" } as SyncReply<T>; }
				return (result.status === 200 ? { ok: true, body: result.body } : { ok: false, reason: "refused", status: result.status, code: result.body.code ?? null, error: String(result.body.error), body: result.body }) as SyncReply<T>;
			},
			now: () => clock.now, clockOffset: () => o.offset ?? 0, timeZone: o.zone ?? (() => "Europe/Stockholm"), onTimeZoneChange: () => {
				// One process plays both sides: the PC works its schedules out in its own zone.
				if (opts.realZone) process.env.TZ = (o.zone ?? (() => "Europe/Stockholm"))()!;
				zoneChanges++;
				s.files.rebuild();
			},
			rules: FLASHCARDS_RULES, path: FLASHCARDS_SYNC_PATH, busy: () => s.files.busy(), locked: () => s.files.locked(), makeBackup: backup(s.dataDir), page: opts.page,
		});
		return { ...s, sync, requests, setOnline: (value: boolean) => { online = value; }, zoneChanges: () => zoneChanges, dropNextReply: () => { dropNext = true; } };
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
		// Nothing to send or take: no request at all, and nothing written.
		assert.deepEqual(await pc.sync.round(), { ok: false, reason: "busy" });
		assert.equal(fs.readFileSync(file, "utf8"), newer);
		assert.deepEqual(pc.requests, []);
		assert.equal(fs.existsSync(pc.syncDir), false);
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

	it("schedules agree across time zones: the server works every schedule out again in the PC's zone, and the PC in its own when it moves", async () => {
		const before = process.env.TZ;
		cleanups.push(() => { process.env.TZ = before; });
		// 06:00 UTC: already the 5th's study day in UTC (day start 4:00), still the 4th's in New York (02:00).
		clock.now = Date.UTC(2026, 4, 5, 6);
		const w = world({ realZone: true });
		let zone = "America/New_York";
		const pc = w.desktop("pc", "dev_aaaaaaaaaaaaaaaa", { zone: () => zone });
		process.env.TZ = "America/New_York";
		await pc.device!.generate([{ id: "n_p", questions: ["P?"] }]);
		await study(pc.device!, [4]);
		// The server was used from a phone while it still ran in the zone it was started with.
		process.env.TZ = "UTC";
		await w.server.device!.generate([{ id: "n_s", questions: ["S?"] }]);
		await study(w.server.device!, [4]);
		const serverDue = w.server.library()!.propositions.n_s!.schedule;
		await settle(pc);
		assert.equal(process.env.TZ, "America/New_York", "the server's process follows the PC");
		assert.notDeepEqual(w.server.library()!.propositions.n_s!.schedule, serverDue, "its own fact was worked out again in the PC's zone");
		assert.deepEqual(view(pc.library()), view(w.server.library()), "the same schedules on both sides");
		// The PC moves to Tokyo: it works its own schedules out again, the server takes the zone and does the same.
		zone = "Asia/Tokyo";
		process.env.TZ = "Asia/Tokyo";
		clock.now += DAY;
		await settle(pc);
		assert.equal(process.env.TZ, "Asia/Tokyo");
		assert.deepEqual(view(pc.library()), view(w.server.library()));
		assert.deepEqual(w.zones.map(([, z]) => z), ["America/New_York", "Asia/Tokyo"]);
	});
});

describe("Flashcards sync: what a review of the wiring found", () => {
	const facts = (lib: FlashcardsFile | null) => Object.keys(lib?.propositions ?? {}).sort();
	const cards = (lib: FlashcardsFile | null) => Object.values(lib?.propositions ?? {}).flatMap((p) => p.cues.map((c) => c.id)).sort();

	it("a library put back from its backup after the first sync deletes nothing anywhere, and gets everything back", async () => {
		clock.now = new Date(2026, 4, 4, 9).getTime();
		const w = world();
		await w.server.device!.generate([{ id: "s1", questions: ["Phone card 1?"] }, { id: "s2", questions: ["Phone card 2?"] }]);
		const pc = w.desktop("pc", "dev_aaaaaaaaaaaaaaaa");
		await pc.device!.generate([{ id: "p1", questions: ["PC card 1?"], session: "session-2" }]);
		await settle(pc);
		const before = { server: cards(w.server.library()), pc: cards(pc.library()) };
		assert.deepEqual(facts(w.server.library()), ["p1", "s1", "s2"]);
		// The owner restores the PC's "before-first-flashcards-sync" copy of its library.
		const backup = fs.readdirSync(path.join(path.dirname(pc.dataDir), "backups")).find((b) => b.startsWith("before-first-flashcards-sync"))!;
		fs.copyFileSync(path.join(path.dirname(pc.dataDir), "backups", backup, "core-plugin-data", "flashcards", "flashcards.json"), path.join(flashcardsDataDir(pc.dataDir), "flashcards.json"));
		await settle(pc);
		assert.deepEqual(cards(w.server.library()), before.server, "nothing deleted on the server");
		assert.deepEqual(cards(pc.library()), before.pc, "and the PC has it all again");
		assert.equal(pc.logged.filter((line) => line.includes("put back or replaced")).length, 1, "said once in the log");
		assert.deepEqual(view(pc.library()), view(w.server.library()));
		// The plugin, still running on the old copy in memory, reads the file again and shows it all.
		assert.equal((await pc.device!.state()).propositions.length, 3);
	});

	it("a crash between writing the library and its memory never deletes anything", async () => {
		clock.now = new Date(2026, 4, 4, 9).getTime();
		const w = world();
		const pc = w.desktop("pc", "dev_aaaaaaaaaaaaaaaa");
		await pc.device!.generate([{ id: "p1", questions: ["PC card?"] }]);
		await settle(pc);
		// The library written, its memory not: the memory from before is put back.
		const memoryFiles = ["flashcards-memory.json", "flashcards-memory-reviews.json"].map((name) => path.join(pc.syncDir, name));
		const old = memoryFiles.map((file) => fs.readFileSync(file));
		await w.server.device!.generate([{ id: "s1", questions: ["Phone card?"] }]);
		clock.now += 1000;
		await pc.sync.round();
		assert.deepEqual(facts(pc.library()), ["p1", "s1"]);
		memoryFiles.forEach((file, i) => fs.writeFileSync(file, old[i]!));
		await settle(pc);
		assert.deepEqual(facts(pc.library()), ["p1", "s1"]);
		assert.deepEqual(facts(w.server.library()), ["p1", "s1"]);
		// The memory written, the library not (the library from before is back): the same as a library put back.
		const libraryBefore = fs.readFileSync(path.join(flashcardsDataDir(pc.dataDir), "flashcards.json"));
		await w.server.device!.generate([{ id: "s2", questions: ["Another phone card?"] }]);
		clock.now += 1000;
		await pc.sync.round();
		fs.writeFileSync(path.join(flashcardsDataDir(pc.dataDir), "flashcards.json"), libraryBefore);
		await settle(pc);
		assert.deepEqual(facts(pc.library()), ["p1", "s1", "s2"]);
		assert.deepEqual(facts(w.server.library()), ["p1", "s1", "s2"]);
	});

	it("the backups keep Flashcards sync's own files with the library", () => {
		const dir = path.join(TMP, "backup-parts", "data");
		fs.mkdirSync(path.join(dir, "core-plugin-data", "flashcards"), { recursive: true });
		fs.mkdirSync(path.join(dir, "sync"), { recursive: true });
		fs.writeFileSync(path.join(dir, "core-plugin-data", "flashcards", "flashcards.json"), "{}");
		for (const name of ["flashcards-memory.json", "flashcards-memory-reviews.json", "flashcards-desktop.json", "maps-desktop.json"]) fs.writeFileSync(path.join(dir, "sync", name), "{}");
		const target = makeFlashcardsBackup(dir, new Date(2026, 4, 4))!;
		assert.deepEqual(fs.readdirSync(path.join(target, "sync")).sort(), ["flashcards-desktop.json", "flashcards-memory-reviews.json", "flashcards-memory.json"]);
	});

	it("a library that can't be read for a while: nothing is passed over, and the server's cards made meanwhile arrive after", async () => {
		clock.now = new Date(2026, 4, 4, 9).getTime();
		const w = world();
		await w.server.device!.generate([{ id: "a1", questions: ["A?"] }]);
		const pc = w.desktop("pc", "dev_aaaaaaaaaaaaaaaa", { plugin: false });
		await settle(pc);
		const file = path.join(flashcardsDataDir(pc.dataDir), "flashcards.json");
		const keep = fs.readFileSync(file, "utf8");
		fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(keep), version: 2 }));
		clock.now += 60_000;
		await w.server.device!.generate([{ id: "b1", questions: ["B?"] }]);
		const asked = pc.requests.length;
		const stamps0 = stamps(pc.syncDir);
		for (let i = 0; i < 3; i++) { clock.now += 10_000; assert.deepEqual(await pc.sync.round(), { ok: false, reason: "busy" }); }
		assert.equal(pc.requests.length, asked, "no request while it can't be read");
		assert.deepEqual(stamps(pc.syncDir), stamps0, "and nothing written");
		fs.writeFileSync(file, keep);
		await settle(pc);
		assert.deepEqual(facts(pc.library()), ["a1", "b1"]);
	});

	it("a library locked from the start costs no request, saves no memory, and syncs whole once it can be read", async () => {
		clock.now = new Date(2026, 4, 4, 9).getTime();
		const w = world({ page: { items: 50, bytes: 1 << 20 } });
		await w.server.device!.generate(Array.from({ length: 20 }, (_, i) => ({ id: `n${i}`, questions: [`q${i}a?`, `q${i}b?`] })));
		const pc = w.desktop("pc", "dev_aaaaaaaaaaaaaaaa", { plugin: false });
		const file = path.join(flashcardsDataDir(pc.dataDir), "flashcards.json");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify({ version: 2, revision: 3, settings: {}, decks: [], propositions: {}, reviews: [], batches: [] }));
		for (let i = 0; i < 3; i++) { clock.now += 10_000; assert.deepEqual(await pc.sync.round(), { ok: false, reason: "busy" }); }
		assert.equal(pc.requests.length, 0);
		assert.equal(fs.existsSync(path.join(pc.syncDir, "flashcards-memory.json")), false);
		fs.rmSync(file);
		await settle(pc);
		assert.equal(facts(pc.library()).length, 20);
	});

	it("a server whose library can't be read: one backup, one cheap request a round, nothing written there", async () => {
		clock.now = new Date(2026, 4, 4, 9).getTime();
		const w = world({ serverPlugin: false });
		const file = path.join(flashcardsDataDir(w.server.dataDir), "flashcards.json");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "{\"version\":1, \"revision\": 3, \"decks\": [");
		const pc = w.desktop("pc", "dev_aaaaaaaaaaaaaaaa");
		await pc.device!.generate([{ id: "a1", questions: ["A?"] }]);
		const server0 = stamps(path.dirname(w.server.dataDir));
		for (let i = 0; i < 4; i++) { clock.now += 10_000; assert.deepEqual(await pc.sync.round(), { ok: false, reason: "busy" }); }
		assert.deepEqual(stamps(path.dirname(w.server.dataDir)), server0, "no backup, no state, no memory on the server");
		assert.equal(pc.requests.length, 4);
		assert.deepEqual(pc.requests.slice(1).map((r) => [r.probe, r.changes.length]), [[true, 0], [true, 0], [true, 0]], "after the first, a probe with nothing in it");
		fs.rmSync(file);
		await settle(pc);
		assert.deepEqual(facts(w.server.library()), ["a1"]);
		assert.equal(fs.readdirSync(path.join(path.dirname(w.server.dataDir), "backups")).length, 1, "one backup, once it could start");
	});

	it("while every PC is away, the phone's changes keep their own time: a later change on the PC still wins", async () => {
		clock.now = new Date(2026, 4, 4, 9).getTime();
		const w = world();
		const phone = w.server.device!;
		await phone.generate([{ id: "a1", questions: ["A?"] }, { id: "a2", questions: ["B?"] }]);
		const pc = w.desktop("pc", "dev_aaaaaaaaaaaaaaaa");
		await settle(pc);
		const deckId = (await phone.state()).decks[0]!.id;
		pc.setOnline(false);
		clock.now += DAY;
		await phone.call("save-deck", { id: deckId, name: "Renamed on the phone (day 1)" });
		// What the server's watcher does a moment after the plugin says it changed its library.
		clock.now += 2000; w.authority.detect();
		clock.now += DAY;
		await pc.device!.call("save-deck", { id: deckId, name: "Renamed on the PC (day 2)" });
		pc.sync.detect();
		clock.now += DAY;
		assert.ok(await phone.grade(3));
		clock.now += 2000; w.authority.detect();
		pc.setOnline(true);
		await settle(pc);
		assert.equal(w.server.library()!.decks[0]!.name, "Renamed on the PC (day 2)");
		assert.equal(pc.library()!.decks[0]!.name, "Renamed on the PC (day 2)");
	});

	it("the watcher notes changes 20 s after the last one, at most 50 s after the first, only where Flashcards sync has run", () => {
		let listener: ((event: ServerEvent) => void) | null = null;
		let now = 1_000_000;
		let pending: { run: () => void; at: number; id: number } | null = null;
		let ids = 0;
		let active = false;
		const detected: number[] = [];
		watchFlashcardsChanges({
			subscribe: (fn) => { listener = fn; return () => {}; },
			setTimer: (run, ms) => { pending = { run, at: now + ms, id: ++ids }; return ids; },
			clearTimer: (handle) => { if (pending?.id === handle) pending = null; },
			now: () => now, active: () => active, detect: (since) => { detected.push(since); },
		});
		const say = (topic: string, data?: unknown) => listener!({ type: "plugin-message", pluginId: "flashcards", topic, data } as never);
		const pass = (ms: number) => { now += ms; if (pending && pending.at <= now) { const p = pending; pending = null; p.run(); } };
		say("changed");
		assert.equal(pending, null, "no timer where Flashcards sync never ran");
		active = true;
		say("changed", { by: "sync" });
		assert.equal(pending, null, "what sync wrote isn't a change made here");
		// A review session: a rating every 10 s.
		const start = now;
		for (let i = 0; i < 10; i++) { say("changed"); pass(10_000); }
		assert.deepEqual(detected, [start, start + 50_000], "noted at the ceiling, then again 50 s after the next first change");
		pass(60_000);
		assert.equal(detected.length, 2, "nothing while nothing changes");
		// One change: noted 20 s later.
		say("changed");
		pass(19_000);
		assert.equal(detected.length, 2);
		pass(1_000);
		assert.equal(detected.length, 3);
	});

	it("the server's own noting: skipped when an exchange has looked since, and a review alone rewrites no table", async () => {
		clock.now = new Date(2026, 4, 4, 9).getTime();
		const w = world();
		const pc = w.desktop("pc", "dev_aaaaaaaaaaaaaaaa");
		await w.server.device!.generate([{ id: "s1", questions: ["S?"] }]);
		await settle(pc);
		const table = path.join(w.server.syncDir, "flashcards.json");
		const stamp = () => fs.statSync(table).mtimeMs + ":" + fs.statSync(table).size;
		const before = stamp();
		assert.ok(await w.server.device!.grade(3));
		clock.now += 1000;
		w.authority.detect(clock.now - 1000);
		assert.equal(stamp(), before, "a new review alone: no table written");
		// A rename is noted, unless an exchange has looked since it was announced.
		await w.server.device!.call("save-deck", { id: w.server.library()!.decks[0]!.id, name: "Renamed" });
		const announced = clock.now;
		clock.now += 1000;
		await pc.sync.round();
		const after = stamp();
		clock.now += 1000;
		w.authority.detect(announced);
		assert.equal(stamp(), after, "the exchange noted it already");
	});

	it("two PCs whose first exchanges overlap in pages: only the first brings its settings", async () => {
		clock.now = new Date(2026, 4, 4, 9).getTime();
		const w = world({ page: { items: 3, bytes: 1 << 20 } });
		await w.server.device!.generate([{ id: "s1", questions: ["S?"] }]);
		let release: () => void = () => {};
		let held = false;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const one = w.desktop("one", "dev_aaaaaaaaaaaaaaaa", { hold: async (body) => { if (body.all && !held && body.cursor === 0 && body.changes.length > 0 && one.requests.length === 1) { held = true; await gate; } } });
		const two = w.desktop("two", "dev_bbbbbbbbbbbbbbbb");
		await one.device!.generate([{ id: "o1", questions: ["O1?", "O2?", "O3?"] }]);
		await one.device!.call("save-settings", { retention: 0.8 });
		await two.device!.generate([{ id: "t1", questions: ["T?"] }]);
		await two.device!.call("save-settings", { retention: 0.95 });
		const first = one.sync.round();
		while (!held) await new Promise((resolve) => setImmediate(resolve));
		assert.equal((await two.sync.round()).ok, true, "the second PC's first exchange runs while the first one's is part way");
		release();
		assert.equal((await first).ok, true);
		await settle(one, two);
		for (const s of [w.server, one, two]) assert.equal(s.library()!.settings.retention, 0.8, `${s.name}: the first PC's value`);
		assert.deepEqual(facts(w.server.library()), ["o1", "s1", "t1"]);
	});

	it("same-question cards: one of a pair from two devices goes, a device's own two both stay", async () => {
		clock.now = new Date(2026, 4, 4, 9).getTime();
		const w = world();
		await w.server.device!.generate([{ id: "n1", questions: ["Same?", "Phone's own?"] }]);
		clock.now += MINUTE;
		const pc = w.desktop("pc", "dev_aaaaaaaaaaaaaaaa");
		await pc.device!.generate([{ id: "n1", questions: ["Same?", "PC's own?"] }]);
		await pc.device!.call("create-cue", { requestId: "twice", propositionId: "n1", question: "PC's own? ", answer: "On purpose." });
		await settle(pc);
		const qs = (lib: FlashcardsFile | null) => lib!.propositions.n1!.cues.map((c) => c.question.trim()).sort();
		assert.deepEqual(qs(w.server.library()), ["PC's own?", "PC's own?", "Phone's own?", "Same?"]);
		assert.deepEqual(view(pc.library()), view(w.server.library()));
		w.server.assertCacheSound(); pc.assertCacheSound();
	});

	it("a generation stuck for 15 minutes holds the exchange no longer", async () => {
		clock.now = new Date(2026, 4, 4, 9).getTime();
		const w = world();
		const pc = w.desktop("pc", "dev_aaaaaaaaaaaaaaaa");
		await settle(pc);
		const server = w.server.device!;
		server.graph.propositions.push(graphNode("n_s"));
		const plan = await server.call<{ id: string }>("preflight", { propositionIds: ["n_s"] });
		await server.call("start-generation", { preflightId: plan.id, requestId: randomUUID() });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(w.server.files.busy(), true);
		clock.now += 14 * MINUTE;
		assert.equal(w.server.files.busy(), true);
		clock.now += 2 * MINUTE;
		assert.equal(w.server.files.busy(), false);
		assert.equal(w.server.logged.filter((line) => line.includes("no progress for 15 minutes")).length, 1);
		assert.equal((await pc.sync.round()).ok, true);
	});

	it("the PC works its schedules out again once per zone, also while the server keeps answering busy", async () => {
		clock.now = new Date(2026, 4, 4, 9).getTime();
		const w = world();
		const pc = w.desktop("pc", "dev_aaaaaaaaaaaaaaaa");
		await pc.device!.generate([{ id: "p1", questions: ["P?"] }]);
		const server = w.server.device!;
		server.graph.propositions.push(graphNode("n_s"));
		const plan = await server.call<{ id: string }>("preflight", { propositionIds: ["n_s"] });
		await server.call("start-generation", { preflightId: plan.id, requestId: randomUUID() });
		await new Promise((resolve) => setImmediate(resolve));
		for (let i = 0; i < 3; i++) { clock.now += 10_000; assert.deepEqual(await pc.sync.round(), { ok: false, reason: "busy" }); }
		assert.equal(pc.zoneChanges(), 1);
	});

	it("after an exchange the kept snapshot is what a fresh read gives (the apply's own, not read again)", async (t) => {
		clock.now = new Date(2026, 4, 4, 9).getTime();
		const w = world();
		const pc = w.desktop("pc", "dev_aaaaaaaaaaaaaaaa");
		await pc.device!.generate([{ id: "p1", questions: ["P?", "P2?"] }, { id: "p2", questions: ["Q?"] }]);
		await w.server.device!.generate([{ id: "s1", questions: ["S?"] }]);
		await study(pc.device!, [3, 4]);
		await settle(pc);
		w.server.assertCacheSound(); pc.assertCacheSound();
		await study(w.server.device!, [3]);
		clock.now += 1000;
		await pc.sync.round();
		const reads: string[] = [];
		const real = fs.readFileSync;
		t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => { if (String(args[0]).endsWith("flashcards.json")) reads.push(String(args[0])); return real(...args); });
		pc.files.read();
		t.mock.restoreAll();
		assert.deepEqual(reads, [], "the library the apply wrote isn't parsed again");
		w.server.assertCacheSound(); pc.assertCacheSound();
	});

	for (const offset of [-5_000, -300_000, 300_000]) {
		it(`a library put back on a PC whose clock is ${offset < 0 ? "ahead of" : "behind"} the server's by ${Math.abs(offset) / 1000} s still syncs, and deletes nothing`, async () => {
			clock.now = new Date(2026, 4, 4, 9).getTime();
			const w = world();
			await w.server.device!.generate([{ id: "s1", questions: ["Phone card?"] }]);
			const pc = w.desktop("pc", "dev_aaaaaaaaaaaaaaaa", { offset });
			await pc.device!.generate([{ id: "p1", questions: ["PC card?"], session: "session-2" }]);
			await settle(pc);
			const backup = fs.readdirSync(path.join(path.dirname(pc.dataDir), "backups")).find((b) => b.startsWith("before-first-flashcards-sync"))!;
			fs.copyFileSync(path.join(path.dirname(pc.dataDir), "backups", backup, "core-plugin-data", "flashcards", "flashcards.json"), path.join(flashcardsDataDir(pc.dataDir), "flashcards.json"));
			await settle(pc);
			assert.ok(pc.requests.every((r) => r.changes.every((c) => (c as { t?: number }).t! >= 0)), "no time before 1970 ever leaves the PC");
			assert.deepEqual(facts(pc.library()), ["p1", "s1"]);
			assert.deepEqual(facts(w.server.library()), ["p1", "s1"]);
		});
	}

	it("the server takes a time before 1970 as the oldest time, not as a broken page", () => {
		clock.now = new Date(2026, 4, 4, 9).getTime();
		const w = world();
		const reply = w.authority.exchange("dev_aaaaaaaaaaaaaaaa", { cursor: 0, all: true, changes: [{ key: "s|retention", value: 0.85, t: -4000 }] });
		assert.equal(reply.status, 200);
	});

	it("the same fact made on both sides, reviewed on both: after a card is deleted every review still counts on both", async () => {
		clock.now = new Date(2026, 0, 5, 9).getTime();
		const w = world();
		const phone = w.server.device!;
		await phone.generate([{ id: "n1", questions: ["Phone question?"] }]);
		for (let i = 0; i < 3; i++) { assert.ok(await phone.grade(3)); clock.now += 2 * DAY; }
		const pc = w.desktop("pc", "dev_aaaaaaaaaaaaaaaa");
		await pc.device!.generate([{ id: "n1", questions: ["PC question?"] }]);
		assert.ok(await pc.device!.grade(3));
		clock.now += 10 * MINUTE;
		await settle(pc);
		// Writes by the plugin on both sides: the files are read for real again.
		await phone.call("save-settings", { chunkBudget: 4001 });
		await pc.device!.call("save-settings", { chunkBudget: 4002 });
		await settle(pc);
		const st = await phone.state();
		const p = st.propositions.find((x) => x.id === "n1")!;
		await phone.call("delete-cue", { propositionId: "n1", cueId: p.cues.find((c) => c.question === "Phone question?")!.id, version: p.version });
		await settle(pc);
		for (const s of [pc, w.server]) {
			const fact = s.library()!.propositions.n1!;
			assert.equal(fact.schedule.reps, 4, `${s.name}: all four reviews count`);
		}
		assert.deepEqual(view(pc.library()), view(w.server.library()));
	});

	it("a PC whose memory is lost sends everything again, and the phone's newer changes stand", async () => {
		clock.now = new Date(2026, 4, 4, 9).getTime();
		const w = world();
		await w.server.device!.generate([{ id: "s1", questions: ["S?"] }]);
		const pc = w.desktop("pc", "dev_aaaaaaaaaaaaaaaa");
		await settle(pc);
		const deck = w.server.library()!.decks[0]!;
		clock.now += MINUTE;
		await w.server.device!.call("save-deck", { id: deck.id, name: "Renamed on the phone" });
		w.authority.detect();
		for (const name of ["flashcards-memory.json", "flashcards-memory-reviews.json"]) fs.rmSync(path.join(pc.syncDir, name));
		clock.now += MINUTE;
		await settle(pc);
		for (const s of [pc, w.server]) assert.equal(s.library()!.decks[0]!.name, "Renamed on the phone", s.name);
		// A first save of the memory cut between its two files is the same case (a lost memory).
		fs.rmSync(path.join(pc.syncDir, "flashcards-memory-reviews.json"));
		clock.now += MINUTE;
		await w.server.device!.call("save-deck", { id: deck.id, name: "Renamed again" });
		w.authority.detect();
		clock.now += MINUTE;
		await settle(pc);
		for (const s of [pc, w.server]) assert.equal(s.library()!.decks[0]!.name, "Renamed again", s.name);
	});

	it("a card the PC made, taken by the server before its answer was lost, is never paired with the PC's next same-question card", async () => {
		clock.now = new Date(2026, 4, 4, 9).getTime();
		const w = world();
		const pc = w.desktop("pc", "dev_aaaaaaaaaaaaaaaa");
		await pc.device!.generate([{ id: "n1", questions: ["First?"] }]);
		await settle(pc);
		await pc.device!.call("create-cue", { requestId: "x", propositionId: "n1", question: "Twice?", answer: "One." });
		pc.dropNextReply();
		clock.now += 1000;
		assert.deepEqual(await pc.sync.round(), { ok: false, reason: "offline" });
		assert.ok(w.server.library()!.propositions.n1!.cues.some((c) => c.question === "Twice?"), "the server took it");
		await pc.device!.call("create-cue", { requestId: "y", propositionId: "n1", question: "Twice?", answer: "Two." });
		await settle(pc);
		for (const s of [pc, w.server]) assert.equal(s.library()!.propositions.n1!.cues.filter((c) => c.question === "Twice?").length, 2, s.name);
	});
});
