/**
 * Cloud sync: no Take over button and no warning (owner's change). The page
 * asks for a session as soon as the learner continues it; the desktop's
 * engine answers.
 *
 * Pins the owner's rules:
 *  1. A PC cut off from the server (offline, sync paused, or removed by the
 *     server) carries on anyway: that one session is provisionally its own.
 *  2. Settled at reconnect: continued here only → taken back (no warning)
 *     and sent; continued on both sides → the server's version, with a
 *     notice; deleted on the server → gone here too; a busy holder → the
 *     turns are kept and it is asked again next round.
 *  3. A take-over whose fetch never arrived: the server's newer turns are
 *     never overwritten by a copy continued from an older version.
 *  4. Take-back: a PC that lost a session it had unsent turns in takes it
 *     back when the taker added nothing, and keeps its turns.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sync-seamless-"));
process.env.LH_AUTH_FILE = path.join(TMP, "prod", "secrets", "auth.json");
process.env.LH_DATA_DIR = path.join(TMP, "prod", "data");

const { CLOUD_HOLDER } = await import("../src/core/sync/sessions.ts");
const { sessionFiles, sessionDirsUnder } = await import("../src/store/sync/session-files.ts");
const { stateFile } = await import("../src/store/sync/state-file.ts");
const { createAuthority, isAuthorityState } = await import("../src/server/sync/authority.ts");
const { createDesktopSync, isDesktopState } = await import("../src/server/sync/desktop-sync.ts");
const guards = await import("../src/server/sync/guarded-stores.ts");
import type { SyncReply } from "../src/server/sync/client.ts";
import type { AuthorityReply } from "../src/server/sync/authority.ts";

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let worlds = 0;
const SECOND = 1000;

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value, null, "\t"));
}

function makeSession(dataDir: string, id: string, title: string, turns: string[]): void {
	writeJson(path.join(dataDir, "chats", `${id}.json`), {
		id, title, createdAt: "2026-11-01T10:00:00.000Z", updatedAt: "2026-11-01T10:00:00.000Z", version: 1,
		messages: turns.map((text, i) => ({ id: `m_${id}_${i}`, role: "user", content: text })),
	});
}

function addTurn(dataDir: string, id: string, text: string, role = "user"): void {
	const file = path.join(dataDir, "chats", `${id}.json`);
	const record = JSON.parse(fs.readFileSync(file, "utf-8")) as { messages: unknown[] };
	record.messages.push({ id: `m_${text.replace(/\W+/g, "_")}`, role, content: text });
	fs.writeFileSync(file, JSON.stringify(record, null, "\t"));
}

function turnsOf(dataDir: string, id: string): string[] {
	return (JSON.parse(fs.readFileSync(path.join(dataDir, "chats", `${id}.json`), "utf-8")) as { messages: Array<{ content: string }> }).messages.map((m) => m.content);
}

function work() {
	const replying = new Set<string>();
	const stopped: string[] = [];
	return {
		replying, stopped,
		api: { replying: (id: string) => replying.has(id), stop: (id: string, options?: { turn?: boolean }) => { stopped.push(options?.turn ? `${id}+turn` : id); if (options?.turn) replying.delete(id); } },
	};
}

type Link = "online" | "offline" | "paused" | "not-paired";

function world() {
	const root = path.join(TMP, `w${++worlds}`);
	const serverDir = path.join(root, "server", "data");
	let clock = 1_000_000;
	const names: Record<string, string> = {};
	const serverWork = work();
	const authority = createAuthority({
		files: sessionFiles(sessionDirsUnder(serverDir)),
		state: stateFile(path.join(serverDir, "sync", "authority.json"), isAuthorityState),
		now: () => clock,
		deviceName: (id) => names[id] ?? null,
		makeBackup: () => null,
		localWork: serverWork.api,
	});
	const reply = <T>(result: AuthorityReply): SyncReply<T> => result.status === 200
		? { ok: true, body: result.body as T }
		: { ok: false, reason: "refused", status: result.status, code: typeof result.body.code === "string" ? result.body.code : null, error: String(result.body.error), body: result.body };

	function desktop(deviceId: string, name: string) {
		const dataDir = path.join(root, deviceId, "data");
		names[deviceId] = name;
		const local = work();
		let link: Link = "online";
		/** The next request matching this is lost after the server handled it (the answer never arrives). */
		let loseAnswer: ((pathname: string, method: string) => boolean) | null = null;
		/** Runs on the server's side just before it handles a request (another device acting in between). */
		let before: ((pathname: string, method: string) => void) | null = null;
		/** While set, every request waits for it (a slow connection). */
		let gate: Promise<void> | null = null;
		const discarded: string[] = [];
		const announced: string[] = [];
		const sent: string[] = [];
		const sync = createDesktopSync({
			files: sessionFiles(sessionDirsUnder(dataDir)),
			state: stateFile(path.join(dataDir, "sync", "desktop.json"), isDesktopState),
			identity: () => ({ server: "https://learn.example.com", deviceId }),
			request: async <T>(pathname: string, init: { method?: string; body?: unknown } = {}) => {
				if (link === "offline") return { ok: false, reason: "offline" } as SyncReply<T>;
				if (link === "paused") return { ok: false, reason: "paused", message: "Update the server to continue syncing" } as SyncReply<T>;
				if (link === "not-paired") return { ok: false, reason: "not-paired" } as SyncReply<T>;
				const body = init.body === undefined ? undefined : JSON.parse(JSON.stringify(init.body)) as { force?: boolean };
				const take = /^\/api\/sync\/sessions\/(.+)\/take$/.exec(pathname)?.[1];
				const id = /^\/api\/sync\/sessions\/([^/]+)$/.exec(pathname)?.[1];
				const method = init.method ?? (body === undefined ? "GET" : "POST");
				if (gate) await gate;
				before?.(pathname, method);
				sent.push(`${method} ${pathname}${take ? ` force=${body?.force === true}` : ""}`);
				const result = take ? authority.takeOver(deviceId, take, body?.force === true)
					: !id ? authority.exchange(deviceId, body)
					: method === "GET" ? authority.fetch(deviceId, id)
					: method === "PUT" ? authority.store(deviceId, id, body)
					: authority.remove(deviceId, id);
				if (loseAnswer?.(pathname, method)) { loseAnswer = null; return { ok: false, reason: "offline" } as SyncReply<T>; }
				return reply<T>(JSON.parse(JSON.stringify(result)) as AuthorityReply);
			},
			now: () => clock,
			makeBackup: () => null,
			localWork: local.api,
			announce: (id, what) => announced.push(`${id}:${what}`),
			onDiscard: (id) => discarded.push(id),
		});
		return {
			dataDir, sync, deviceId, work: local, discarded, announced, sent,
			setLink: (value: Link) => { link = value; },
			setOnline: (value: boolean) => { link = value ? "online" : "offline"; },
			loseAnswerOf: (match: (pathname: string, method: string) => boolean) => { loseAnswer = match; },
			beforeEach: (run: ((pathname: string, method: string) => void) | null) => { before = run; },
			hold: () => { let open!: () => void; gate = new Promise<void>((resolve) => { open = resolve; }); return () => { gate = null; open(); }; },
		};
	}
	return { root, serverDir, authority, desktop, serverWork, pass: (ms: number) => { clock += ms; }, now: () => clock };
}

/** A desktop holding "Circuits", fully synced, and the server holding "Motors". */
async function synced() {
	const w = world();
	const desk = w.desktop("dev_aaaaaaaaaaaaaaaa", "Office PC");
	makeSession(desk.dataDir, "chat_circuits", "Circuits", ["one"]);
	makeSession(w.serverDir, "chat_motors", "Motors", ["phone"]);
	await desk.sync.tick();
	desk.announced.length = 0;
	desk.sent.length = 0;
	w.pass(SECOND);
	return { w, desk };
}

/** The same, then the PC loses its link and the learner continues "Motors" there anyway. */
async function carriedOn(link: Link = "offline") {
	const all = await synced();
	all.desk.setLink(link);
	assert.equal((await all.desk.sync.takeOver("chat_motors", true)).status, "continued-offline");
	return all;
}

function sessionsOf(dataDir: string) {
	return (JSON.parse(fs.readFileSync(path.join(dataDir, "sync", "desktop.json"), "utf-8")) as { sessions: Record<string, { mine: boolean; freed?: string }> }).sessions;
}

describe("rule 1: a PC cut off from the server carries on anyway", () => {
	it("offline: the one session asked for becomes this PC's to continue, and nothing else changes", async () => {
		const { desk } = await carriedOn();
		assert.equal(desk.sync.holds("chat_motors"), true);
		assert.equal(desk.sync.holderOf("chat_motors"), null);
		assert.deepEqual(desk.sync.held(), {}, "not listed as held elsewhere");
		assert.deepEqual(sessionsOf(desk.dataDir).chat_motors, { ...sessionsOf(desk.dataDir).chat_motors, mine: true, freed: "held" }, "written to the state file");
		assert.deepEqual(desk.announced, ["chat_motors:written"], "open windows learn of it");
		assert.equal(desk.sync.holds("chat_circuits"), true);
	});

	it("writes to it are accepted by the guarded stores", async () => {
		const { desk } = await synced();
		const calls: string[] = [];
		const inner = { saveMessages: (id: string) => { calls.push(`messages:${id}`); } };
		const warn = console.warn;
		console.warn = () => {};
		try {
			const chats = guards.guardChatStore(inner as never, (id) => desk.sync.holds(id));
			chats.saveMessages("chat_motors", []);
			assert.deepEqual(calls, [], "held elsewhere: dropped");
			desk.setOnline(false);
			await desk.sync.takeOver("chat_motors", true);
			chats.saveMessages("chat_motors", []);
			assert.deepEqual(calls, ["messages:chat_motors"], "carried on: saved");
		} finally {
			console.warn = warn;
		}
	});

	it("sync paused (versions differ): the same", async () => {
		const { w, desk } = await carriedOn("paused");
		addTurn(desk.dataDir, "chat_motors", "while paused");
		assert.equal(desk.sync.holds("chat_motors"), true);
		assert.deepEqual(await desk.sync.tick(), { ok: false, reason: "paused" });
		assert.deepEqual(turnsOf(desk.dataDir, "chat_motors"), ["phone", "while paused"], "nothing is discarded while paused");
		desk.setLink("online");
		const round = await desk.sync.tick();
		assert.deepEqual(round.ok && round.sent, ["chat_motors"]);
		assert.deepEqual(turnsOf(w.serverDir, "chat_motors"), ["phone", "while paused"]);
	});

	it("removed by the server (its identity and sync state still here): the same", async () => {
		const { w, desk } = await carriedOn("not-paired");
		addTurn(desk.dataDir, "chat_motors", "after the PC was removed");
		assert.equal(desk.sync.holds("chat_motors"), true);
		// Paired again as the same device: settled like any other.
		desk.setLink("online");
		const round = await desk.sync.tick();
		assert.deepEqual(round.ok && round.sent, ["chat_motors"]);
		assert.deepEqual(turnsOf(w.serverDir, "chat_motors"), ["phone", "after the PC was removed"]);
		assert.equal(w.authority.holderOf("chat_motors")?.id, desk.deviceId);
	});

	it("the server answered no (no such session): nothing is marked", async () => {
		const { desk } = await synced();
		const answer = await desk.sync.takeOver("chat_nope", true);
		assert.equal(answer.status, "refused");
		assert.equal(typeof answer.error, "string");
		assert.deepEqual(desk.announced, []);
	});
});

describe("rule 2: settled at reconnect", () => {
	it("continued here only: taken back without a warning and sent", async () => {
		const { w, desk } = await carriedOn();
		addTurn(desk.dataDir, "chat_motors", "offline on the PC");
		w.pass(60 * SECOND);
		desk.setOnline(true);
		const round = await desk.sync.tick();
		assert.deepEqual(round, { ok: true, fetched: [], sent: ["chat_motors"], removed: [], lost: [], handed: [] });
		assert.ok(desk.sent.includes("POST /api/sync/sessions/chat_motors/take force=true"), "never waits on a warning");
		assert.deepEqual(turnsOf(w.serverDir, "chat_motors"), ["phone", "offline on the PC"]);
		assert.equal(w.authority.holderOf("chat_motors")?.id, desk.deviceId);
		assert.equal(desk.sync.holds("chat_motors"), true);
		assert.equal(sessionsOf(desk.dataDir).chat_motors!.freed, undefined);
		assert.deepEqual(desk.sync.notices(), []);
		assert.deepEqual(desk.work.stopped, []);
	});

	it("asked for but not continued: it is whose it was again", async () => {
		const { w, desk } = await carriedOn();
		desk.setOnline(true);
		const round = await desk.sync.tick();
		assert.deepEqual(round.ok && round.sent, []);
		assert.equal(desk.sync.holds("chat_motors"), false);
		assert.equal(w.authority.holds("chat_motors"), true, "the server keeps it");
	});

	it("continued on both sides: the server's version, a notice with the right count, the PC's work stopped", async () => {
		const { w, desk } = await carriedOn();
		desk.work.replying.add("chat_motors");
		addTurn(desk.dataDir, "chat_motors", "pc one");
		addTurn(desk.dataDir, "chat_motors", "the teacher's reply", "assistant");
		addTurn(desk.dataDir, "chat_motors", "pc two");
		addTurn(w.serverDir, "chat_motors", "phone again");
		desk.setOnline(true);
		const round = await desk.sync.tick();
		assert.deepEqual(round.ok && round.lost, ["chat_motors"]);
		assert.deepEqual(turnsOf(desk.dataDir, "chat_motors"), ["phone", "phone again"], "no copy");
		assert.deepEqual(turnsOf(w.serverDir, "chat_motors"), ["phone", "phone again"]);
		assert.deepEqual(desk.sync.notices(), [{ chatId: "chat_motors", title: "Motors", turns: 2, at: w.now() }]);
		assert.equal(desk.sync.holds("chat_motors"), false);
		assert.deepEqual(desk.discarded, ["chat_motors"]);
		assert.deepEqual(desk.work.stopped, ["chat_motors+turn"]);
	});

	it("deleted on the server meanwhile: it goes here too", async () => {
		const { w, desk } = await carriedOn();
		addTurn(desk.dataDir, "chat_motors", "continued on the PC");
		fs.rmSync(path.join(w.serverDir, "chats", "chat_motors.json"));
		w.authority.scan();
		desk.setOnline(true);
		const round = await desk.sync.tick();
		assert.equal(round.ok, true);
		assert.equal(fs.existsSync(path.join(desk.dataDir, "chats", "chat_motors.json")), false);
		assert.equal(sessionsOf(desk.dataDir).chat_motors, undefined);
	});

	it("the holder is busy with it: the turns are kept, and it is asked again next round", async () => {
		const { w, desk } = await carriedOn();
		addTurn(desk.dataDir, "chat_motors", "offline on the PC");
		w.serverWork.replying.add("chat_motors");
		desk.setOnline(true);
		const first = await desk.sync.tick();
		assert.equal(first.ok, true);
		assert.deepEqual(first.ok && [first.sent, first.lost], [[], []]);
		assert.deepEqual(turnsOf(desk.dataDir, "chat_motors"), ["phone", "offline on the PC"]);
		assert.equal(desk.sync.holds("chat_motors"), true, "still continued here meanwhile");
		assert.deepEqual(desk.sync.notices(), []);
		// The server's reply finishes without changing its copy; the next round takes it.
		w.serverWork.replying.delete("chat_motors");
		w.pass(10 * SECOND);
		const second = await desk.sync.tick();
		assert.deepEqual(second.ok && second.sent, ["chat_motors"]);
		assert.deepEqual(turnsOf(w.serverDir, "chat_motors"), ["phone", "offline on the PC"]);
	});

	it("the holder is busy and then adds to it: discarded with a notice", async () => {
		const { w, desk } = await carriedOn();
		addTurn(desk.dataDir, "chat_motors", "offline on the PC");
		w.serverWork.replying.add("chat_motors");
		desk.setOnline(true);
		await desk.sync.tick();
		addTurn(w.serverDir, "chat_motors", "the server's reply", "assistant");
		w.serverWork.replying.delete("chat_motors");
		w.pass(10 * SECOND);
		const second = await desk.sync.tick();
		assert.deepEqual(second.ok && second.lost, ["chat_motors"]);
		assert.deepEqual(turnsOf(desk.dataDir, "chat_motors"), ["phone", "the server's reply"]);
		assert.equal(desk.sync.notices()[0]!.turns, 1);
	});
});

describe("rule 3: the server moved it here, but its version never arrived", () => {
	it("the server had turns this PC never saw: they are kept, with a notice, and the session is this PC's", async () => {
		const { w, desk } = await synced();
		addTurn(w.serverDir, "chat_motors", "phone, never fetched by the PC");
		w.authority.scan();
		// The take-over lands on the server; the fetch of its version doesn't come back.
		desk.loseAnswerOf((pathname, method) => method === "GET" && pathname === "/api/sync/sessions/chat_motors");
		assert.equal((await desk.sync.takeOver("chat_motors", true)).status, "continued-offline");
		assert.equal(w.authority.holderOf("chat_motors")?.id, desk.deviceId, "the server names this PC");
		desk.setOnline(false);
		addTurn(desk.dataDir, "chat_motors", "on the PC, from the older copy");
		desk.setOnline(true);
		const round = await desk.sync.tick();
		assert.deepEqual(round.ok && [round.lost, round.sent], [["chat_motors"], []]);
		assert.deepEqual(turnsOf(w.serverDir, "chat_motors"), ["phone", "phone, never fetched by the PC"], "never overwritten");
		assert.deepEqual(turnsOf(desk.dataDir, "chat_motors"), ["phone", "phone, never fetched by the PC"]);
		assert.deepEqual(desk.sync.notices(), [{ chatId: "chat_motors", title: "Motors", turns: 1, at: w.now() }]);
		assert.equal(desk.sync.holds("chat_motors"), true, "the session is this PC's");
		assert.equal(sessionsOf(desk.dataDir).chat_motors!.freed, undefined);
		// And it goes on normally from there.
		addTurn(desk.dataDir, "chat_motors", "next");
		const next = await desk.sync.tick();
		assert.deepEqual(next.ok && next.sent, ["chat_motors"]);
		assert.deepEqual(turnsOf(w.serverDir, "chat_motors"), ["phone", "phone, never fetched by the PC", "next"]);
	});

	it("the server had nothing new: the PC's turns are kept and sent", async () => {
		const { w, desk } = await synced();
		desk.loseAnswerOf((pathname, method) => method === "GET" && pathname === "/api/sync/sessions/chat_motors");
		assert.equal((await desk.sync.takeOver("chat_motors", true)).status, "continued-offline");
		addTurn(desk.dataDir, "chat_motors", "on the PC");
		const round = await desk.sync.tick();
		assert.deepEqual(round.ok && [round.lost, round.sent], [[], ["chat_motors"]]);
		assert.deepEqual(turnsOf(w.serverDir, "chat_motors"), ["phone", "on the PC"]);
		assert.deepEqual(desk.sync.notices(), []);
	});

	it("not continued here: the server's version arrives and the session is this PC's", async () => {
		const { w, desk } = await synced();
		addTurn(w.serverDir, "chat_motors", "phone, never fetched by the PC");
		w.authority.scan();
		desk.loseAnswerOf((pathname, method) => method === "GET" && pathname === "/api/sync/sessions/chat_motors");
		await desk.sync.takeOver("chat_motors", true);
		const round = await desk.sync.tick();
		assert.deepEqual(round.ok && round.fetched, ["chat_motors"]);
		assert.deepEqual(turnsOf(desk.dataDir, "chat_motors"), ["phone", "phone, never fetched by the PC"]);
		assert.equal(desk.sync.holds("chat_motors"), true);
		assert.deepEqual(desk.sync.notices(), []);
	});
});

describe("rule 4: take-back", () => {
	it("the taker added nothing: the PC takes it back, keeps its turns, and sends them", async () => {
		const { w, desk } = await synced();
		desk.setOnline(false);
		addTurn(desk.dataDir, "chat_circuits", "offline one");
		addTurn(desk.dataDir, "chat_circuits", "offline two");
		w.pass(60 * SECOND);
		// The phone opens it: its page asks for it at once (last word "all sent").
		assert.equal(w.authority.takeOver(CLOUD_HOLDER, "chat_circuits", true).body.status, "moved");
		desk.setOnline(true);
		const round = await desk.sync.tick();
		assert.deepEqual(round, { ok: true, fetched: [], sent: ["chat_circuits"], removed: [], lost: [], handed: [] });
		assert.deepEqual(turnsOf(w.serverDir, "chat_circuits"), ["one", "offline one", "offline two"]);
		assert.equal(w.authority.holderOf("chat_circuits")?.id, desk.deviceId);
		assert.equal(desk.sync.holds("chat_circuits"), true);
		assert.deepEqual(desk.sync.notices(), []);
		assert.deepEqual(desk.work.stopped, [], "nothing stops when it is taken back");
		assert.deepEqual(desk.discarded, []);
	});

	it("the taker added something: discarded, with a notice", async () => {
		const { w, desk } = await synced();
		desk.setOnline(false);
		addTurn(desk.dataDir, "chat_circuits", "offline one");
		w.pass(60 * SECOND);
		w.authority.takeOver(CLOUD_HOLDER, "chat_circuits", true);
		addTurn(w.serverDir, "chat_circuits", "on the phone");
		desk.setOnline(true);
		const round = await desk.sync.tick();
		assert.deepEqual(round.ok && round.lost, ["chat_circuits"]);
		assert.deepEqual(turnsOf(desk.dataDir, "chat_circuits"), ["one", "on the phone"]);
		assert.deepEqual(desk.sync.notices(), [{ chatId: "chat_circuits", title: "Circuits", turns: 1, at: w.now() }]);
		assert.deepEqual(desk.work.stopped, ["chat_circuits+turn"]);
		assert.equal(desk.sync.holds("chat_circuits"), false);
		assert.equal(desk.sent.some((line) => line.includes("/take")), false, "no take-back asked");
	});

	it("the PC had nothing unsent: it adopts the server's version quietly", async () => {
		const { w, desk } = await synced();
		desk.setOnline(false);
		w.pass(31 * SECOND);
		assert.equal(w.authority.takeOver(CLOUD_HOLDER, "chat_circuits", true).body.status, "moved");
		desk.setOnline(true);
		const round = await desk.sync.tick();
		assert.deepEqual(round.ok && round.lost, ["chat_circuits"]);
		assert.deepEqual(desk.sync.notices(), []);
		assert.equal(desk.sync.holds("chat_circuits"), false);
		assert.equal(desk.sent.some((line) => line.includes("/take")), false);
	});

	it("the taker is busy with it: the turns are kept and it is asked again next round", async () => {
		const { w, desk } = await synced();
		desk.setOnline(false);
		addTurn(desk.dataDir, "chat_circuits", "offline one");
		w.pass(60 * SECOND);
		w.authority.takeOver(CLOUD_HOLDER, "chat_circuits", true);
		w.serverWork.replying.add("chat_circuits"); // the phone started a reply that hasn't written anything yet
		desk.setOnline(true);
		const first = await desk.sync.tick();
		assert.deepEqual(first.ok && [first.sent, first.lost], [[], []]);
		assert.equal(desk.sync.holds("chat_circuits"), true, "continued here meanwhile");
		assert.deepEqual(turnsOf(desk.dataDir, "chat_circuits"), ["one", "offline one"]);
		assert.deepEqual(desk.work.stopped, []);
		addTurn(desk.dataDir, "chat_circuits", "and another");
		w.serverWork.replying.delete("chat_circuits");
		w.pass(10 * SECOND);
		const second = await desk.sync.tick();
		assert.deepEqual(second.ok && second.sent, ["chat_circuits"]);
		assert.deepEqual(turnsOf(w.serverDir, "chat_circuits"), ["one", "offline one", "and another"]);
		assert.equal(w.authority.holderOf("chat_circuits")?.id, desk.deviceId);
	});

	it("another desktop took it and is online: it hands it back at its next round", async () => {
		const { w, desk } = await synced();
		const laptop = w.desktop("dev_bbbbbbbbbbbbbbbb", "Laptop");
		await laptop.sync.tick();
		desk.setOnline(false);
		addTurn(desk.dataDir, "chat_circuits", "offline one");
		w.pass(60 * SECOND);
		await laptop.sync.tick();
		assert.equal((await laptop.sync.takeOver("chat_circuits", true)).status, "moved");
		desk.setOnline(true);
		const first = await desk.sync.tick();
		assert.deepEqual(first.ok && [first.sent, first.lost], [[], []], "the laptop is online: it is asked to hand over");
		w.pass(SECOND);
		const handed = await laptop.sync.tick();
		assert.deepEqual(handed.ok && handed.handed, ["chat_circuits"]);
		w.pass(SECOND);
		const second = await desk.sync.tick();
		assert.deepEqual(second.ok && second.sent, ["chat_circuits"]);
		assert.deepEqual(turnsOf(w.serverDir, "chat_circuits"), ["one", "offline one"]);
		assert.equal(laptop.sync.holds("chat_circuits"), false);
	});
});

// ─── The review's cases: a take that didn't settle, races, lost answers ─────

const LAPTOP = "dev_bbbbbbbbbbbbbbbb";
const isTake = (pathname: string, method: string) => method === "POST" && pathname.endsWith("/take");

describe("a take that answered \"waiting\": the holder's later turns are never overwritten", () => {
	it("freed by Unpair (\"mine\"): the laptop adds a turn and then hands over; it survives, the PC gets the notice", async () => {
		const { w, desk } = await synced();
		const laptop = w.desktop(LAPTOP, "Laptop");
		await laptop.sync.tick();
		// The PC unpairs; the laptop takes "Circuits" and stays online.
		w.authority.releaseDevice(desk.deviceId);
		desk.sync.release();
		assert.equal((await laptop.sync.takeOver("chat_circuits", true)).status, "moved");
		addTurn(desk.dataDir, "chat_circuits", "on the PC while unpaired");
		desk.sync.rejoin();
		w.pass(SECOND);
		await laptop.sync.tick();
		const first = await desk.sync.tick();
		assert.deepEqual(first.ok && [first.sent, first.lost], [[], []], "the laptop is online: asked, waiting");
		assert.equal(sessionsOf(desk.dataDir).chat_circuits!.freed, "mine");
		// The laptop's learner adds a turn; its round sends it and hands over in the same round.
		addTurn(laptop.dataDir, "chat_circuits", "on the laptop");
		w.pass(SECOND);
		const handed = await laptop.sync.tick();
		assert.deepEqual(handed.ok && [handed.sent, handed.handed], [["chat_circuits"], ["chat_circuits"]]);
		assert.equal(w.authority.holderOf("chat_circuits")?.id, desk.deviceId);
		w.pass(SECOND);
		const second = await desk.sync.tick();
		assert.deepEqual(second.ok && [second.sent, second.lost], [[], ["chat_circuits"]]);
		assert.deepEqual(turnsOf(w.serverDir, "chat_circuits"), ["one", "on the laptop"], "the laptop's turn survives");
		assert.deepEqual(turnsOf(desk.dataDir, "chat_circuits"), ["one", "on the laptop"]);
		assert.deepEqual(desk.sync.notices(), [{ chatId: "chat_circuits", title: "Circuits", turns: 1, at: w.now() }]);
		assert.equal(desk.sync.holds("chat_circuits"), true, "the session is the PC's, with the server's version");
		// From there it goes on normally.
		addTurn(desk.dataDir, "chat_circuits", "next");
		const third = await desk.sync.tick();
		assert.deepEqual(third.ok && third.sent, ["chat_circuits"]);
		assert.deepEqual(turnsOf(w.serverDir, "chat_circuits"), ["one", "on the laptop", "next"]);
	});

	it("carried on offline (\"held\"): the same", async () => {
		const { w, desk } = await synced();
		const laptop = w.desktop(LAPTOP, "Laptop");
		await laptop.sync.tick();
		desk.setOnline(false);
		await desk.sync.takeOver("chat_motors", true);
		addTurn(desk.dataDir, "chat_motors", "offline on the PC");
		assert.equal((await laptop.sync.takeOver("chat_motors", true)).status, "moved");
		desk.setOnline(true);
		const first = await desk.sync.tick();
		assert.deepEqual(first.ok && [first.sent, first.lost], [[], []]);
		addTurn(laptop.dataDir, "chat_motors", "on the laptop");
		w.pass(SECOND);
		const handed = await laptop.sync.tick();
		assert.deepEqual(handed.ok && handed.handed, ["chat_motors"]);
		const second = await desk.sync.tick();
		assert.deepEqual(second.ok && second.lost, ["chat_motors"]);
		assert.deepEqual(turnsOf(w.serverDir, "chat_motors"), ["phone", "on the laptop"]);
		assert.equal(desk.sync.notices()[0]!.turns, 1);
		assert.equal(desk.sync.holds("chat_motors"), true);
	});

	it("a take-back the laptop answered \"waiting\": the same", async () => {
		const { w, desk } = await synced();
		const laptop = w.desktop(LAPTOP, "Laptop");
		await laptop.sync.tick();
		desk.setOnline(false);
		addTurn(desk.dataDir, "chat_circuits", "offline on the PC");
		w.pass(60 * SECOND);
		await laptop.sync.tick();
		assert.equal((await laptop.sync.takeOver("chat_circuits", true)).status, "moved");
		desk.setOnline(true);
		const first = await desk.sync.tick();
		assert.deepEqual(first.ok && [first.sent, first.lost], [[], []]);
		assert.equal(desk.sync.holds("chat_circuits"), true);
		addTurn(laptop.dataDir, "chat_circuits", "on the laptop");
		w.pass(SECOND);
		await laptop.sync.tick();
		const second = await desk.sync.tick();
		assert.deepEqual(second.ok && second.lost, ["chat_circuits"]);
		assert.deepEqual(turnsOf(w.serverDir, "chat_circuits"), ["one", "on the laptop"]);
		assert.deepEqual(turnsOf(desk.dataDir, "chat_circuits"), ["one", "on the laptop"]);
		assert.equal(desk.sync.notices()[0]!.turns, 1);
	});

	it("the laptop hands over with nothing added (its version rises, its content doesn't): the PC's turns are kept", async () => {
		const { w, desk } = await synced();
		const laptop = w.desktop(LAPTOP, "Laptop");
		await laptop.sync.tick();
		desk.setOnline(false);
		addTurn(desk.dataDir, "chat_circuits", "offline on the PC");
		w.pass(60 * SECOND);
		await laptop.sync.tick();
		await laptop.sync.takeOver("chat_circuits", true);
		desk.setOnline(true);
		await desk.sync.tick();
		const asked = sessionsOf(desk.dataDir).chat_circuits as { asked?: number };
		assert.equal(typeof asked.asked, "number");
		await laptop.sync.tick();
		const server = JSON.parse(fs.readFileSync(path.join(w.serverDir, "sync", "authority.json"), "utf-8")) as { sessions: Record<string, { version: number }> };
		assert.ok(server.sessions.chat_circuits!.version > asked.asked!, "the hand-over's send raised the version");
		const second = await desk.sync.tick();
		assert.deepEqual(second.ok && [second.sent, second.lost], [["chat_circuits"], []]);
		assert.deepEqual(turnsOf(w.serverDir, "chat_circuits"), ["one", "offline on the PC"]);
		assert.deepEqual(desk.sync.notices(), []);
	});
});

describe("the check and the take are not one step", () => {
	it("the phone writes between the PC's look and its take: its turn survives, the PC gets the notice", async () => {
		const { w, desk } = await synced();
		desk.setOnline(false);
		addTurn(desk.dataDir, "chat_circuits", "offline on the PC");
		w.pass(60 * SECOND);
		assert.equal(w.authority.takeOver(CLOUD_HOLDER, "chat_circuits", true).body.status, "moved");
		desk.setOnline(true);
		desk.beforeEach((pathname, method) => {
			if (!isTake(pathname, method)) return;
			desk.beforeEach(null);
			addTurn(w.serverDir, "chat_circuits", "on the phone, just then");
		});
		const first = await desk.sync.tick();
		assert.deepEqual(first.ok && [first.sent, first.lost], [[], []], "not kept on a version it didn't look at");
		assert.equal(w.authority.holderOf("chat_circuits")?.id, desk.deviceId, "the cloud moved it at once");
		const second = await desk.sync.tick();
		assert.deepEqual(second.ok && [second.sent, second.lost], [[], ["chat_circuits"]]);
		assert.deepEqual(turnsOf(w.serverDir, "chat_circuits"), ["one", "on the phone, just then"]);
		assert.deepEqual(turnsOf(desk.dataDir, "chat_circuits"), ["one", "on the phone, just then"]);
		assert.equal(desk.sync.notices()[0]!.turns, 1);
	});

	it("a \"waiting\" answer on the send's lease_lost path keeps the turns, and the next round takes it", async () => {
		const { w, desk } = await synced();
		addTurn(desk.dataDir, "chat_circuits", "typed here");
		const exchange = w.authority.exchange.bind(w.authority);
		w.authority.exchange = (deviceId, body) => {
			const result = exchange(deviceId, body);
			w.authority.exchange = exchange;
			w.pass(60 * SECOND);
			w.authority.takeOver(CLOUD_HOLDER, "chat_circuits", true);
			w.serverWork.replying.add("chat_circuits"); // the phone is writing a reply
			return { ...result, body: { ...result.body, changes: [] } };
		};
		const first = await desk.sync.tick();
		assert.deepEqual(first.ok && [first.sent, first.lost], [[], []]);
		assert.ok(desk.sent.includes("POST /api/sync/sessions/chat_circuits/take force=true"));
		assert.equal(desk.sync.holds("chat_circuits"), true);
		assert.deepEqual(turnsOf(desk.dataDir, "chat_circuits"), ["one", "typed here"]);
		assert.deepEqual(desk.work.stopped, []);
		w.serverWork.replying.delete("chat_circuits");
		w.pass(SECOND);
		const second = await desk.sync.tick();
		assert.deepEqual(second.ok && second.sent, ["chat_circuits"]);
		assert.deepEqual(turnsOf(w.serverDir, "chat_circuits"), ["one", "typed here"]);
		assert.deepEqual(desk.sync.notices(), []);
	});
});

describe("a take-over and a round never run at the same time", () => {
	it("a take-over asked during a round waits for it, and the reverse", async () => {
		const { desk } = await synced();
		const open = desk.hold();
		const round = desk.sync.tick();
		const take = desk.sync.takeOver("chat_motors", true);
		await new Promise((resolve) => setTimeout(resolve, 10));
		open();
		await Promise.all([round, take]);
		const takeAt = desk.sent.findIndex((line) => line.includes("/take"));
		assert.ok(takeAt > 0, "the take came after");
		assert.ok(desk.sent.slice(0, takeAt).some((line) => line === "POST /api/sync/sessions"), "the round's question went first");
		// The other order.
		desk.sent.length = 0;
		const open2 = desk.hold();
		const take2 = desk.sync.takeOver("chat_motors", true);
		const round2 = desk.sync.tick();
		await new Promise((resolve) => setTimeout(resolve, 10));
		open2();
		await Promise.all([take2, round2]);
		assert.equal(desk.sent[0]!.includes("/take"), true, "the take-over first, then the round");
	});
});

describe("a lost answer to this PC's own send", () => {
	it("the server holds what the PC sent; a take-over that adds nothing; the PC's later turns are kept", async () => {
		const { w, desk } = await synced();
		addTurn(desk.dataDir, "chat_circuits", "sent, answer lost");
		desk.loseAnswerOf((pathname, method) => method === "PUT" && pathname === "/api/sync/sessions/chat_circuits");
		assert.deepEqual(await desk.sync.tick(), { ok: false, reason: "offline" });
		assert.deepEqual(turnsOf(w.serverDir, "chat_circuits"), ["one", "sent, answer lost"], "it did arrive");
		desk.setOnline(false);
		addTurn(desk.dataDir, "chat_circuits", "after it");
		w.pass(60 * SECOND);
		assert.equal(w.authority.takeOver(CLOUD_HOLDER, "chat_circuits", true).body.status, "moved");
		desk.setOnline(true);
		const round = await desk.sync.tick();
		assert.deepEqual(round.ok && [round.sent, round.lost], [["chat_circuits"], []]);
		assert.deepEqual(turnsOf(w.serverDir, "chat_circuits"), ["one", "sent, answer lost", "after it"]);
		assert.deepEqual(desk.sync.notices(), []);
	});
});

describe("the notice counts what is on disk when the discard happens", () => {
	it("a turn written while the server's copy was being fetched is counted", async () => {
		const { w, desk } = await carriedOn();
		addTurn(desk.dataDir, "chat_motors", "pc one");
		addTurn(w.serverDir, "chat_motors", "phone again");
		desk.setOnline(true);
		desk.beforeEach((pathname, method) => {
			if (method !== "GET" || pathname !== "/api/sync/sessions/chat_motors") return;
			desk.beforeEach(null);
			addTurn(desk.dataDir, "chat_motors", "pc two, typed meanwhile");
		});
		const round = await desk.sync.tick();
		assert.deepEqual(round.ok && round.lost, ["chat_motors"]);
		assert.equal(desk.sync.notices()[0]!.turns, 2);
	});
});
