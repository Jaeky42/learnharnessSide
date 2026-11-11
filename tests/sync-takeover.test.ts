/**
 * Cloud sync Phase 5, slice 3 (docs/cloud-sync.md): take-over.
 *
 * Pins the owner's decisions:
 *  - Take over warns only on evidence: the offline holder's last word was
 *    "busy" or "unsent". After "all sent" there is no warning.
 *  - An online holder is asked to hand over: it finishes the reply it is
 *    writing, sends what it has, and its helpers and extraction stop there
 *    (they start again on the new holder).
 *  - No copies: a desktop that lost a session discards what it hadn't sent,
 *    shows the server's version, and keeps a notice with the session and
 *    the number of turns.
 *  - An offline desktop can only continue what it already held.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sync-takeover-"));
process.env.LH_AUTH_FILE = path.join(TMP, "prod", "secrets", "auth.json");
process.env.LH_DATA_DIR = path.join(TMP, "prod", "data");

const { CLOUD_HOLDER } = await import("../src/core/sync/sessions.ts");
const { sessionFiles, sessionDirsUnder } = await import("../src/store/sync/session-files.ts");
const { stateFile } = await import("../src/store/sync/state-file.ts");
const { createAuthority, isAuthorityState } = await import("../src/server/sync/authority.ts");
const { createDesktopSync, isDesktopState } = await import("../src/server/sync/desktop-sync.ts");
import type { SyncReply } from "../src/server/sync/client.ts";
import type { AuthorityReply } from "../src/server/sync/authority.ts";

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let worlds = 0;
const SECOND = 1000;

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value, null, "\t"));
}

function makeSession(dataDir: string, id: string, title: string, turns: string[], jobs: Array<{ id: string; status: string }> = []): void {
	writeJson(path.join(dataDir, "chats", `${id}.json`), {
		id, title, createdAt: "2026-11-01T10:00:00.000Z", updatedAt: "2026-11-01T10:00:00.000Z", version: 1,
		messages: turns.map((text, i) => ({ id: `m_${id}_${i}`, role: "user", content: text })),
	});
	for (const job of jobs) writeJson(path.join(dataDir, "jobs", `${job.id}.json`), { id: job.id, kind: "research", chatId: id, toolCallId: `t_${job.id}`, status: job.status, activity: "working", createdAt: "x", updatedAt: "x", input: { question: "q" } });
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
		let online = true;
		const sync = createDesktopSync({
			files: sessionFiles(sessionDirsUnder(dataDir)),
			state: stateFile(path.join(dataDir, "sync", "desktop.json"), isDesktopState),
			identity: () => ({ server: "https://learn.example.com", deviceId }),
			request: async <T>(pathname: string, init: { method?: string; body?: unknown } = {}) => {
				if (!online) return { ok: false, reason: "offline" } as SyncReply<T>;
				const body = init.body === undefined ? undefined : JSON.parse(JSON.stringify(init.body)) as { force?: boolean };
				const take = /^\/api\/sync\/sessions\/(.+)\/take$/.exec(pathname)?.[1];
				const id = /^\/api\/sync\/sessions\/([^/]+)$/.exec(pathname)?.[1];
				const method = init.method ?? (body === undefined ? "GET" : "POST");
				const result = take ? authority.takeOver(deviceId, take, body?.force === true)
					: !id ? authority.exchange(deviceId, body)
					: method === "GET" ? authority.fetch(deviceId, id)
					: method === "PUT" ? authority.store(deviceId, id, body)
					: authority.remove(deviceId, id);
				return reply<T>(JSON.parse(JSON.stringify(result)) as AuthorityReply);
			},
			now: () => clock,
			makeBackup: () => null,
			localWork: local.api,
		});
		return { dataDir, sync, deviceId, work: local, setOnline: (value: boolean) => { online = value; } };
	}
	return { root, serverDir, authority, desktop, serverWork, pass: (ms: number) => { clock += ms; }, now: () => clock };
}

const quiet = { ok: true, fetched: [], sent: [], removed: [], lost: [], handed: [] };

/** A desktop holding "Circuits", fully synced, and the server holding "Motors". */
async function synced() {
	const w = world();
	const desk = w.desktop("dev_aaaaaaaaaaaaaaaa", "Office PC");
	makeSession(desk.dataDir, "chat_circuits", "Circuits", ["one"], [{ id: "job_run", status: "running" }]);
	makeSession(w.serverDir, "chat_motors", "Motors", ["phone"]);
	await desk.sync.tick();
	w.pass(SECOND);
	return { w, desk };
}

describe("the phone takes a session from an offline desktop", () => {
	it("after \"all sent\": no warning, it moves at once, and nothing is lost", async () => {
		const { w, desk } = await synced();
		desk.setOnline(false);
		w.pass(90 * 60 * SECOND);
		const taken = w.authority.takeOver(CLOUD_HOLDER, "chat_circuits", false);
		assert.equal(taken.body.status, "moved");
		assert.equal(w.authority.holds("chat_circuits"), true);
		// The desktop comes back with nothing unsent: it just becomes read-only there.
		desk.setOnline(true);
		assert.deepEqual(await desk.sync.tick(), { ...quiet, lost: ["chat_circuits"] });
		assert.equal(desk.sync.holds("chat_circuits"), false);
		assert.deepEqual(desk.sync.notices(), [], "nothing was discarded, so nothing to tell");
		assert.deepEqual(desk.work.stopped, ["chat_circuits+turn"], "its helper stops there");
	});

	it("after \"busy\": a warning with the facts, and only Take over anyway moves it", async () => {
		const { w, desk } = await synced();
		desk.work.replying.add("chat_circuits");
		await desk.sync.tick(); // tells the server a reply is being written
		desk.setOnline(false);
		const lastSeen = w.now();
		w.pass(89 * 60 * SECOND);
		const asked = w.authority.takeOver(CLOUD_HOLDER, "chat_circuits", false);
		assert.equal(asked.body.status, "warning");
		assert.deepEqual(asked.body.heldBy, { id: desk.deviceId, name: "Office PC", online: false, lastSeenAt: lastSeen, word: "busy" });
		assert.equal(w.authority.holds("chat_circuits"), false, "a warning moves nothing");
		assert.equal(w.authority.takeOver(CLOUD_HOLDER, "chat_circuits", false).body.status, "warning", "asking again still warns");
		assert.equal(w.authority.takeOver(CLOUD_HOLDER, "chat_circuits", true).body.status, "moved");
		assert.equal(w.authority.holds("chat_circuits"), true);
	});

	it("after \"unsent\": the same warning", async () => {
		const { w, desk } = await synced();
		addTurn(desk.dataDir, "chat_circuits", "typed just before the Wi-Fi dropped");
		// The round reaches the server with its report, then the connection dies before the send.
		const state = () => JSON.parse(fs.readFileSync(path.join(w.serverDir, "sync", "authority.json"), "utf-8")) as { sessions: Record<string, { report?: { word: string } }> };
		w.authority.exchange(desk.deviceId, { cursor: 0, reports: { chat_circuits: "unsent" } });
		assert.equal(state().sessions.chat_circuits!.report!.word, "unsent");
		w.pass(60 * SECOND);
		assert.equal(w.authority.takeOver(CLOUD_HOLDER, "chat_circuits", false).body.status, "warning");
	});

	it("the desktop's own round reports unsent changes before it sends them", async () => {
		const { w, desk } = await synced();
		addTurn(desk.dataDir, "chat_circuits", "two");
		const seen: unknown[] = [];
		const exchange = w.authority.exchange.bind(w.authority);
		w.authority.exchange = (deviceId, body) => { seen.push((body as { reports: unknown }).reports); return exchange(deviceId, body); };
		await desk.sync.tick();
		assert.deepEqual(seen, [{ chat_circuits: "unsent" }]);
		// And once sent, the server's last word for it is "all sent" again.
		w.pass(60 * SECOND);
		assert.equal(w.authority.takeOver(CLOUD_HOLDER, "chat_circuits", false).body.status, "moved");
	});
});

describe("no copies: what the losing desktop hadn't sent is discarded", () => {
	it("its offline turns are dropped, the server's version shows, and a notice says how many", async () => {
		const { w, desk } = await synced();
		desk.setOnline(false);
		addTurn(desk.dataDir, "chat_circuits", "offline one");
		addTurn(desk.dataDir, "chat_circuits", "the teacher's reply", "assistant");
		addTurn(desk.dataDir, "chat_circuits", "offline two");
		// Meanwhile the phone takes it (no warning: the last word was "all sent") and continues.
		w.pass(60 * SECOND);
		assert.equal(w.authority.takeOver(CLOUD_HOLDER, "chat_circuits", false).body.status, "moved");
		addTurn(w.serverDir, "chat_circuits", "continued on the phone");
		w.pass(3 * 60 * 60 * SECOND);
		desk.setOnline(true);
		const round = await desk.sync.tick();
		assert.deepEqual(round, { ...quiet, lost: ["chat_circuits"] });
		assert.deepEqual(turnsOf(desk.dataDir, "chat_circuits"), ["one", "continued on the phone"], "the cloud's version, no copy");
		assert.deepEqual(turnsOf(w.serverDir, "chat_circuits"), ["one", "continued on the phone"], "the server never got the offline turns");
		assert.deepEqual(fs.readdirSync(path.join(desk.dataDir, "chats")).sort(), ["chat_circuits.json", "chat_motors.json"], "no extra session appears");
		assert.deepEqual(desk.sync.notices(), [{ chatId: "chat_circuits", title: "Circuits", turns: 2, at: w.now() }]);
		assert.equal(desk.sync.holds("chat_circuits"), false);
		assert.deepEqual(desk.work.stopped, ["chat_circuits+turn"], "a reply and helpers still running there are stopped");
		// The notice stays until it has been read.
		await desk.sync.tick();
		assert.equal(desk.sync.notices().length, 1);
		desk.sync.dismissNotice("chat_circuits", w.now());
		assert.deepEqual(desk.sync.notices(), []);
	});

	it("a send that arrives after the take-over is refused and discarded the same way", async () => {
		const { w, desk } = await synced();
		addTurn(desk.dataDir, "chat_circuits", "too late");
		const exchange = w.authority.exchange.bind(w.authority);
		// The take-over lands between the desktop's question and its send.
		w.authority.exchange = (deviceId, body) => {
			const result = exchange(deviceId, body);
			w.pass(60 * SECOND);
			w.authority.takeOver(CLOUD_HOLDER, "chat_circuits", true);
			return { ...result, body: { ...result.body, changes: [] } };
		};
		const round = await desk.sync.tick();
		assert.deepEqual(round, { ...quiet, lost: ["chat_circuits"] });
		assert.deepEqual(turnsOf(w.serverDir, "chat_circuits"), ["one"]);
		assert.deepEqual(turnsOf(desk.dataDir, "chat_circuits"), ["one"]);
		assert.equal(desk.sync.notices()[0]!.turns, 1);
	});
});

describe("an online desktop hands over", () => {
	it("idle: the phone waits, the desktop's next round hands it over, helpers stop there", async () => {
		const { w, desk } = await synced();
		const asked = w.authority.takeOver(CLOUD_HOLDER, "chat_circuits", false);
		assert.equal(asked.body.status, "waiting");
		assert.equal(asked.body.reason, "handing-over");
		assert.equal(w.authority.holds("chat_circuits"), false);
		w.pass(10 * SECOND);
		assert.deepEqual(await desk.sync.tick(), { ...quiet, handed: ["chat_circuits"] });
		assert.deepEqual(desk.work.stopped, ["chat_circuits"], "helpers and extraction stop; no reply is cut");
		assert.equal(desk.sync.holds("chat_circuits"), false);
		assert.equal(w.authority.takeOver(CLOUD_HOLDER, "chat_circuits", false).body.status, "yours");
		assert.equal(w.authority.holds("chat_circuits"), true);
		// The helper's record arrived still "running": the new holder starts it again.
		const job = JSON.parse(fs.readFileSync(path.join(w.serverDir, "jobs", "job_run.json"), "utf-8")) as { status: string };
		assert.equal(job.status, "running");
		assert.deepEqual(desk.sync.notices(), []);
	});

	it("while it is writing a reply: the reply finishes and is sent first", async () => {
		const { w, desk } = await synced();
		desk.work.replying.add("chat_circuits");
		await desk.sync.tick();
		w.pass(SECOND);
		const asked = w.authority.takeOver(CLOUD_HOLDER, "chat_circuits", false);
		assert.equal(asked.body.status, "waiting");
		assert.equal(asked.body.reason, "reply");
		w.pass(5 * SECOND);
		assert.deepEqual(await desk.sync.tick(), quiet, "not while the reply is being written");
		assert.deepEqual(desk.work.stopped, []);
		assert.equal(desk.sync.holds("chat_circuits"), true);
		// The reply lands.
		addTurn(desk.dataDir, "chat_circuits", "the finished reply", "assistant");
		desk.work.replying.delete("chat_circuits");
		w.pass(5 * SECOND);
		assert.deepEqual(await desk.sync.tick(), { ...quiet, sent: ["chat_circuits"], handed: ["chat_circuits"] });
		assert.deepEqual(turnsOf(w.serverDir, "chat_circuits"), ["one", "the finished reply"]);
		assert.equal(w.authority.holds("chat_circuits"), true);
	});

	it("a request nobody repeats is forgotten after a minute", async () => {
		const { w, desk } = await synced();
		w.authority.takeOver(CLOUD_HOLDER, "chat_circuits", false);
		w.pass(20 * SECOND);
		await w.authority.exchange(desk.deviceId, { cursor: 0 }); // the desktop stays online without handing over
		w.pass(50 * SECOND);
		assert.deepEqual(await desk.sync.tick(), quiet);
		assert.equal(desk.sync.holds("chat_circuits"), true);
	});

	it("if it goes offline before handing over, the evidence rule decides", async () => {
		const { w, desk } = await synced();
		assert.equal(w.authority.takeOver(CLOUD_HOLDER, "chat_circuits", false).body.status, "waiting");
		desk.setOnline(false);
		w.pass(45 * SECOND);
		assert.equal(w.authority.takeOver(CLOUD_HOLDER, "chat_circuits", false).body.status, "moved", "its last word was \"all sent\"");
	});
});

describe("a desktop takes a session over", () => {
	it("from the cloud: never a warning, the server's version arrives, its helpers stop there", async () => {
		const { w, desk } = await synced();
		addTurn(w.serverDir, "chat_motors", "more on the phone");
		const taken = await desk.sync.takeOver("chat_motors", false);
		assert.equal(taken.status, "moved");
		assert.equal(desk.sync.holds("chat_motors"), true);
		assert.equal(w.authority.holds("chat_motors"), false);
		assert.deepEqual(turnsOf(desk.dataDir, "chat_motors"), ["phone", "more on the phone"]);
		assert.deepEqual(w.serverWork.stopped, ["chat_motors"]);
		// And it can continue it: the next change goes up.
		addTurn(desk.dataDir, "chat_motors", "continued on the desktop");
		w.pass(SECOND);
		assert.deepEqual(await desk.sync.tick(), { ...quiet, sent: ["chat_motors"] });
		assert.deepEqual(turnsOf(w.serverDir, "chat_motors"), ["phone", "more on the phone", "continued on the desktop"]);
	});

	it("waits while the cloud is writing a reply for it", async () => {
		const { w, desk } = await synced();
		w.serverWork.replying.add("chat_motors");
		const waiting = await desk.sync.takeOver("chat_motors", false);
		assert.equal(waiting.status, "waiting");
		assert.equal(waiting.reason, "reply");
		assert.equal(desk.sync.holds("chat_motors"), false);
		assert.deepEqual(w.serverWork.stopped, []);
		w.serverWork.replying.delete("chat_motors");
		assert.equal((await desk.sync.takeOver("chat_motors", false)).status, "moved");
	});

	it("needs the server: offline, a desktop can only continue what it already held", async () => {
		const { desk } = await synced();
		desk.setOnline(false);
		assert.equal((await desk.sync.takeOver("chat_motors", false)).status, "offline");
		assert.equal(desk.sync.holds("chat_motors"), false);
		assert.equal(desk.sync.holds("chat_circuits"), true);
	});

	it("from another desktop, by the same rules", async () => {
		const { w, desk } = await synced();
		const laptop = w.desktop("dev_bbbbbbbbbbbbbbbb", "Laptop");
		await laptop.sync.tick();
		assert.deepEqual(laptop.sync.held(), { chat_circuits: { id: desk.deviceId, name: "Office PC" }, chat_motors: { id: "cloud", name: null } });
		assert.equal((await laptop.sync.takeOver("chat_circuits", false)).status, "waiting", "the office PC is online");
		w.pass(10 * SECOND);
		assert.deepEqual(await desk.sync.tick(), { ...quiet, handed: ["chat_circuits"] });
		assert.equal((await laptop.sync.takeOver("chat_circuits", false)).status, "yours");
		assert.equal(laptop.sync.holds("chat_circuits"), true);
		assert.equal(desk.sync.holds("chat_circuits"), false);
		assert.deepEqual(w.authority.held().chat_circuits, { id: laptop.deviceId, name: "Laptop", online: true, lastSeenAt: w.now(), word: "all-sent" });
	});

	it("a session that doesn't exist, or was deleted, can't be taken", async () => {
		const { w, desk } = await synced();
		assert.equal(w.authority.takeOver(CLOUD_HOLDER, "chat_nope", false).status, 404);
		assert.equal((await desk.sync.takeOver("chat_nope", false)).status, "refused");
	});
});

describe("what the screens will be told", () => {
	it("the server lists every session it doesn't hold, with the holder's state", async () => {
		const { w, desk } = await synced();
		assert.deepEqual(w.authority.held(), { chat_circuits: { id: desk.deviceId, name: "Office PC", online: true, lastSeenAt: w.now() - SECOND, word: "all-sent" } });
		w.pass(31 * SECOND);
		assert.equal(w.authority.held().chat_circuits!.online, false, "offline after 30 seconds of silence");
	});
});
