/**
 * Cloud sync Phase 5, slice 2 (docs/cloud-sync.md): sessions and leases.
 *
 * Pins the owner's decisions: a session travels whole (chat record,
 * side-tutor thread, notes home folder, helper jobs); only its holder may
 * change or send it; a held session is read-only everywhere else; the first
 * sync combines both libraries after a backup on each side and deletes
 * nothing; and where no desktop has synced, nothing happens at all.
 *
 * Two data folders in one process: a lease authority (the server) and one
 * or two desktops, whose requests are delivered straight to the authority.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sync-sessions-"));
process.env.LH_AUTH_FILE = path.join(TMP, "prod", "secrets", "auth.json");
process.env.LH_DATA_DIR = path.join(TMP, "prod", "data");

const sessions = await import("../src/core/sync/sessions.ts");
const { sessionFiles, sessionDirsUnder } = await import("../src/store/sync/session-files.ts");
const { stateFile } = await import("../src/store/sync/state-file.ts");
const { makeFirstSyncBackup } = await import("../src/store/sync/backup.ts");
const { createAuthority, isAuthorityState } = await import("../src/server/sync/authority.ts");
const { createDesktopSync, isDesktopState } = await import("../src/server/sync/desktop-sync.ts");
const guards = await import("../src/server/sync/guarded-stores.ts");
const engine = await import("../src/server/sync/engine.ts");
import type { SyncReply } from "../src/server/sync/client.ts";
import type { AuthorityReply } from "../src/server/sync/authority.ts";

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let worlds = 0;

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value, null, "\t"));
}

/** A session on disk the way the app writes it. */
function makeSession(dataDir: string, id: string, turns: string[], extras: { tutor?: boolean; home?: string; jobs?: string[] } = {}): void {
	writeJson(path.join(dataDir, "chats", `${id}.json`), {
		id, title: `Session ${id}`, createdAt: "2026-11-01T10:00:00.000Z", updatedAt: "2026-11-01T10:00:00.000Z", version: 1,
		messages: turns.map((text, i) => ({ role: i % 2 ? "assistant" : "user", content: text })),
	});
	if (extras.tutor) writeJson(path.join(dataDir, "side-tutor", `${id}.json`), { version: 1, chatId: id, entries: [{ id: "q1", question: "why?", answer: "because", status: "done", askedAt: 1 }] });
	if (extras.home) writeJson(path.join(dataDir, "notes", "sessions", `${id}.json`), { homeFolder: extras.home });
	for (const jobId of extras.jobs ?? []) writeJson(path.join(dataDir, "jobs", `${jobId}.json`), { id: jobId, kind: "research", chatId: id, toolCallId: `t_${jobId}`, status: "done", activity: "done", createdAt: "x", updatedAt: "x", result: { text: "found" } });
}

function addTurn(dataDir: string, id: string, text: string): void {
	const file = path.join(dataDir, "chats", `${id}.json`);
	const record = JSON.parse(fs.readFileSync(file, "utf-8")) as { messages: unknown[] };
	record.messages.push({ role: "user", content: text });
	fs.writeFileSync(file, JSON.stringify(record, null, "\t"));
}

function turnsOf(dataDir: string, id: string): string[] {
	const record = JSON.parse(fs.readFileSync(path.join(dataDir, "chats", `${id}.json`), "utf-8")) as { messages: Array<{ content: string }> };
	return record.messages.map((m) => m.content);
}

/** Every synced file under a data folder, with its text. */
function library(dataDir: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of ["chats", "side-tutor", path.join("notes", "sessions"), "jobs"]) {
		const dir = path.join(dataDir, part);
		if (!fs.existsSync(dir)) continue;
		for (const name of fs.readdirSync(dir).sort()) out[path.join(part, name)] = fs.readFileSync(path.join(dir, name), "utf-8");
	}
	return out;
}

function world() {
	const root = path.join(TMP, `w${++worlds}`);
	const serverDir = path.join(root, "server", "data");
	let clock = 1_000_000;
	let online = true;
	const names: Record<string, string> = {};
	const backups: Record<string, string[]> = { server: [] };
	const announced: string[] = [];
	const authority = createAuthority({
		files: sessionFiles(sessionDirsUnder(serverDir)),
		state: stateFile(path.join(serverDir, "sync", "authority.json"), isAuthorityState),
		now: () => clock,
		deviceName: (id) => names[id] ?? null,
		makeBackup: () => { const dir = makeFirstSyncBackup(serverDir, new Date(2026, 10, 20)); backups.server!.push(dir); return dir; },
		announce: (chatId, what) => announced.push(`server:${what}:${chatId}`),
	});
	const reply = <T>(result: AuthorityReply): SyncReply<T> => result.status === 200
		? { ok: true, body: result.body as T }
		: { ok: false, reason: "refused", status: result.status, code: typeof result.body.code === "string" ? result.body.code : null, error: String(result.body.error), body: result.body };

	function desktop(deviceId: string, name: string) {
		const dataDir = path.join(root, deviceId, "data");
		names[deviceId] = name;
		backups[deviceId] = [];
		let paired = true;
		const sync = createDesktopSync({
			files: sessionFiles(sessionDirsUnder(dataDir)),
			state: stateFile(path.join(dataDir, "sync", "desktop.json"), isDesktopState),
			identity: () => ({ server: "https://learn.example.com", deviceId }),
			request: async <T>(pathname: string, init: { method?: string; body?: unknown } = {}) => {
				if (!paired) return { ok: false, reason: "not-paired" } as SyncReply<T>;
				if (!online) return { ok: false, reason: "offline" } as SyncReply<T>;
				// What travels is JSON, as over HTTP.
				const body = init.body === undefined ? undefined : JSON.parse(JSON.stringify(init.body)) as unknown;
				const id = /^\/api\/sync\/sessions\/(.+)$/.exec(pathname)?.[1];
				const method = init.method ?? (body === undefined ? "GET" : "POST");
				const result = !id ? authority.exchange(deviceId, body)
					: method === "GET" ? authority.fetch(deviceId, decodeURIComponent(id))
					: method === "PUT" ? authority.store(deviceId, decodeURIComponent(id), body)
					: authority.remove(deviceId, decodeURIComponent(id));
				return reply<T>(JSON.parse(JSON.stringify(result)) as AuthorityReply);
			},
			now: () => clock,
			makeBackup: () => { const dir = makeFirstSyncBackup(dataDir, new Date(2026, 10, 20)); backups[deviceId]!.push(dir); return dir; },
			announce: (chatId, what) => announced.push(`${deviceId}:${what}:${chatId}`),
		});
		return { dataDir, sync, deviceId, unpair: () => { paired = false; }, pair: () => { paired = true; } };
	}
	return { root, serverDir, authority, desktop, backups, announced, tick: (ms = 1000) => { clock += ms; }, setOnline: (value: boolean) => { online = value; } };
}

describe("where no desktop has synced, nothing happens", () => {
	it("the server holds everything, records nothing, and makes no folder", () => {
		const w = world();
		makeSession(w.serverDir, "chat_c1", ["hello"]);
		assert.equal(w.authority.active(), false);
		assert.equal(w.authority.holds("chat_c1"), true);
		assert.equal(w.authority.holderOf("chat_c1"), null);
		w.authority.scan();
		assert.equal(fs.existsSync(path.join(w.serverDir, "sync")), false);
		assert.equal(fs.existsSync(path.join(path.dirname(w.serverDir), "backups")), false);
		assert.deepEqual(w.backups.server, []);
	});

	it("a desktop that isn't paired makes no request and no file", async () => {
		const w = world();
		const dataDir = path.join(w.root, "lonely", "data");
		makeSession(dataDir, "chat_d1", ["hello"]);
		let asked = false;
		const sync = createDesktopSync({
			files: sessionFiles(sessionDirsUnder(dataDir)),
			state: stateFile(path.join(dataDir, "sync", "desktop.json"), isDesktopState),
			identity: () => null,
			request: async () => { asked = true; return { ok: false, reason: "offline" }; },
			now: () => 1,
			makeBackup: () => { throw new Error("no backup without pairing"); },
		});
		assert.equal(sync.holds("chat_d1"), true);
		assert.deepEqual(await sync.tick(), { ok: false, reason: "not-paired" });
		assert.equal(asked, false);
		assert.equal(fs.existsSync(path.join(dataDir, "sync")), false);
	});

	it("this copy's own engine: no state file means every session may be changed", () => {
		assert.equal(engine.holdsSession("chat_anything"), true);
		assert.equal(engine.heldElsewhereResponse("chat_anything"), null);
		assert.equal(fs.existsSync(path.join(TMP, "prod", "data")), false, "asking wrote nothing");
	});
});

describe("the first sync combines both libraries", () => {
	it("everything goes both ways, held by the side it came from, after one backup each", async () => {
		const w = world();
		const desk = w.desktop("dev_aaaaaaaaaaaaaaaa", "Office PC");
		makeSession(desk.dataDir, "chat_d1", ["one", "two"], { tutor: true, home: "LearnHarness/Physics", jobs: ["job_1", "job_2"] });
		makeSession(desk.dataDir, "chat_d2", ["alpha"]);
		makeSession(w.serverDir, "chat_c1", ["from the phone"], { tutor: true, jobs: ["job_9"] });
		const before = { ...library(desk.dataDir), ...library(w.serverDir) };

		const round = await desk.sync.tick();
		assert.deepEqual(round, { ok: true, fetched: ["chat_c1"], sent: ["chat_d1", "chat_d2"], removed: [], lost: [], handed: [] });
		assert.deepEqual(library(desk.dataDir), before, "the desktop has both libraries, byte for byte");
		assert.deepEqual(library(w.serverDir), before, "and so has the server");

		assert.equal(desk.sync.holds("chat_d1"), true);
		assert.equal(desk.sync.holds("chat_d2"), true);
		assert.equal(desk.sync.holds("chat_c1"), false);
		assert.deepEqual(desk.sync.holderOf("chat_c1"), { id: "cloud", name: null });
		assert.equal(w.authority.holds("chat_c1"), true);
		assert.equal(w.authority.holds("chat_d1"), false);
		assert.deepEqual(w.authority.holderOf("chat_d1"), { id: "dev_aaaaaaaaaaaaaaaa", name: "Office PC" });

		// One backup per side, made before anything moved, holding that side's own library.
		assert.equal(w.backups.server!.length, 1);
		assert.equal(w.backups[desk.deviceId]!.length, 1);
		assert.equal(path.basename(w.backups.server![0]!), "before-first-sync 2026-11-20");
		assert.equal(path.dirname(w.backups.server![0]!), path.join(path.dirname(w.serverDir), "backups"));
		assert.deepEqual(fs.readdirSync(path.join(w.backups.server![0]!, "chats")), ["chat_c1.json"]);
		assert.deepEqual(fs.readdirSync(path.join(w.backups[desk.deviceId]![0]!, "chats")).sort(), ["chat_d1.json", "chat_d2.json"]);

		// Nothing more to do, and no second backup, ever.
		w.tick();
		assert.deepEqual(await desk.sync.tick(), { ok: true, fetched: [], sent: [], removed: [], lost: [], handed: [] });
		assert.equal(w.backups.server!.length, 1);
		assert.equal(w.backups[desk.deviceId]!.length, 1);
	});

	it("the backup holds the synced parts of the data folder and nothing private", () => {
		const dataDir = path.join(TMP, "backup-src", "data");
		makeSession(dataDir, "chat_x", ["hi"], { tutor: true, home: "LearnHarness/A", jobs: ["job_x"] });
		writeJson(path.join(dataDir, "graph", "sources.json"), {});
		fs.writeFileSync(path.join(dataDir, "graph", "nodes.jsonl"), "{}\n");
		writeJson(path.join(dataDir, "settings.json"), { version: 1 });
		writeJson(path.join(dataDir, "prompts", "system-prompt.md"), "mine");
		writeJson(path.join(dataDir, "notes", "settings.json"), { vaultPath: "/vault" });
		writeJson(path.join(dataDir, "notes", "pending", "x.json"), { body: "private note text" });
		writeJson(path.join(dataDir, "obsidian-sync.json"), {});
		const first = makeFirstSyncBackup(dataDir, new Date(2026, 10, 20));
		const listed = (dir: string, prefix = ""): string[] => fs.readdirSync(dir, { withFileTypes: true })
			.flatMap((e) => e.isDirectory() ? listed(path.join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]).sort();
		assert.deepEqual(listed(first), [
			"chats/chat_x.json", "graph/nodes.jsonl", "graph/sources.json", "jobs/job_x.json", "notes/sessions/chat_x.json",
			"prompts/system-prompt.md", "settings.json", "side-tutor/chat_x.json",
		]);
		const second = makeFirstSyncBackup(dataDir, new Date(2026, 10, 20));
		assert.equal(path.basename(second), "before-first-sync 2026-11-20 (2)", "an existing backup is never overwritten");
	});

	it("the same id on both sides before the first sync: equal is adopted, different is left alone on both", async () => {
		const w = world();
		const desk = w.desktop("dev_aaaaaaaaaaaaaaaa", "Office PC");
		makeSession(desk.dataDir, "chat_same", ["copied"]);
		fs.mkdirSync(path.join(w.serverDir, "chats"), { recursive: true });
		fs.copyFileSync(path.join(desk.dataDir, "chats", "chat_same.json"), path.join(w.serverDir, "chats", "chat_same.json"));
		makeSession(desk.dataDir, "chat_split", ["the desktop's"]);
		makeSession(w.serverDir, "chat_split", ["the phone's"]);
		const round = await desk.sync.tick();
		assert.equal(round.ok, true);
		assert.deepEqual(turnsOf(desk.dataDir, "chat_split"), ["the desktop's"], "not overwritten");
		assert.deepEqual(turnsOf(w.serverDir, "chat_split"), ["the phone's"], "not overwritten");
		assert.equal(desk.sync.holds("chat_same"), false, "one session, held by the cloud");
		assert.equal(desk.sync.holds("chat_split"), true, "the desktop keeps working on its own");
		addTurn(desk.dataDir, "chat_split", "more");
		w.tick();
		await desk.sync.tick();
		assert.deepEqual(turnsOf(w.serverDir, "chat_split"), ["the phone's"], "and it is never sent over the other");
	});
});

describe("only the holder's version travels", () => {
	async function synced() {
		const w = world();
		const desk = w.desktop("dev_aaaaaaaaaaaaaaaa", "Office PC");
		makeSession(desk.dataDir, "chat_d1", ["one"], { tutor: true, jobs: ["job_1"] });
		makeSession(w.serverDir, "chat_c1", ["phone"]);
		await desk.sync.tick();
		w.tick();
		return { w, desk };
	}

	it("a turn made on the holding desktop reaches the server", async () => {
		const { w, desk } = await synced();
		addTurn(desk.dataDir, "chat_d1", "two");
		assert.deepEqual(await desk.sync.tick(), { ok: true, fetched: [], sent: ["chat_d1"], removed: [], lost: [], handed: [] });
		assert.deepEqual(turnsOf(w.serverDir, "chat_d1"), ["one", "two"]);
		assert.equal(w.announced.includes("server:written:chat_d1"), true, "open pages on the server are told");
	});

	it("a turn made on the phone reaches the desktop", async () => {
		const { w, desk } = await synced();
		addTurn(w.serverDir, "chat_c1", "more from the phone");
		assert.deepEqual(await desk.sync.tick(), { ok: true, fetched: ["chat_c1"], sent: [], removed: [], lost: [], handed: [] });
		assert.deepEqual(turnsOf(desk.dataDir, "chat_c1"), ["phone", "more from the phone"]);
		assert.equal(w.announced.includes("dev_aaaaaaaaaaaaaaaa:written:chat_c1"), true);
	});

	it("the side-tutor thread, the home folder and the helper jobs ride along, removals too", async () => {
		const { w, desk } = await synced();
		makeSession(desk.dataDir, "chat_d1", ["one", "two"], { tutor: false, home: "LearnHarness/Maths", jobs: ["job_2"] });
		fs.rmSync(path.join(desk.dataDir, "side-tutor", "chat_d1.json"));
		fs.rmSync(path.join(desk.dataDir, "jobs", "job_1.json"));
		await desk.sync.tick();
		assert.deepEqual(library(w.serverDir), { ...library(desk.dataDir) });
		assert.equal(fs.existsSync(path.join(w.serverDir, "side-tutor", "chat_d1.json")), false);
		assert.deepEqual(fs.readdirSync(path.join(w.serverDir, "jobs")), ["job_2.json"]);
	});

	it("a session rewritten with the same content is not sent again", async () => {
		const { w, desk } = await synced();
		const file = path.join(desk.dataDir, "chats", "chat_d1.json");
		fs.writeFileSync(file, fs.readFileSync(file));
		fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
		assert.deepEqual(await desk.sync.tick(), { ok: true, fetched: [], sent: [], removed: [], lost: [], handed: [] });
		void w;
	});

	it("a second desktop gets every session read-only, and can't send one it doesn't hold", async () => {
		const { w, desk } = await synced();
		const laptop = w.desktop("dev_bbbbbbbbbbbbbbbb", "Laptop");
		assert.deepEqual(await laptop.sync.tick(), { ok: true, fetched: ["chat_c1", "chat_d1"], sent: [], removed: [], lost: [], handed: [] });
		assert.equal(laptop.sync.holds("chat_d1"), false);
		assert.deepEqual(laptop.sync.holderOf("chat_d1"), { id: desk.deviceId, name: "Office PC" });
		// Something on the laptop changes the held session anyway.
		addTurn(laptop.dataDir, "chat_d1", "written where it shouldn't be");
		w.tick();
		await laptop.sync.tick();
		assert.deepEqual(turnsOf(laptop.dataDir, "chat_d1"), ["one"], "the server's version is put back");
		assert.deepEqual(turnsOf(w.serverDir, "chat_d1"), ["one"]);
		// And the server refuses a send from a device that doesn't hold it.
		const bundle = sessionFiles(sessionDirsUnder(laptop.dataDir)).read("chat_d1")!;
		const refused = w.authority.store(laptop.deviceId, "chat_d1", { baseVersion: 1, bundle });
		assert.equal(refused.status, 409);
		assert.equal(refused.body.code, "lease_lost");
		assert.equal(refused.body.holder, desk.deviceId);
	});

	it("a session made on the phone appears on the desktop; one made offline goes up at reconnect", async () => {
		const { w, desk } = await synced();
		makeSession(w.serverDir, "chat_c2", ["new on the phone"]);
		w.setOnline(false);
		makeSession(desk.dataDir, "chat_d2", ["made offline"]);
		assert.deepEqual(await desk.sync.tick(), { ok: false, reason: "offline" });
		assert.equal(desk.sync.holds("chat_d2"), true, "offline, the desktop works on what it holds");
		assert.equal(desk.sync.holds("chat_c1"), false, "and what it doesn't hold stays read-only");
		w.setOnline(true);
		assert.deepEqual(await desk.sync.tick(), { ok: true, fetched: ["chat_c2"], sent: ["chat_d2"], removed: [], lost: [], handed: [] });
		assert.deepEqual(turnsOf(w.serverDir, "chat_d2"), ["made offline"]);
		assert.deepEqual(w.authority.holderOf("chat_d2"), { id: desk.deviceId, name: "Office PC" });
	});

	it("while unpaired, held sessions stay read-only and nothing is discarded", async () => {
		const { w, desk } = await synced();
		desk.unpair();
		addTurn(desk.dataDir, "chat_d1", "made while unpaired");
		assert.deepEqual(await desk.sync.tick(), { ok: false, reason: "not-paired" });
		assert.equal(desk.sync.holds("chat_c1"), false);
		assert.equal(desk.sync.holds("chat_d1"), true);
		desk.pair();
		assert.deepEqual(await desk.sync.tick(), { ok: true, fetched: [], sent: ["chat_d1"], removed: [], lost: [], handed: [] });
		assert.deepEqual(turnsOf(w.serverDir, "chat_d1"), ["one", "made while unpaired"]);
	});
});

describe("deleting a session", () => {
	it("the holder's delete removes it everywhere", async () => {
		const w = world();
		const desk = w.desktop("dev_aaaaaaaaaaaaaaaa", "Office PC");
		const laptop = w.desktop("dev_bbbbbbbbbbbbbbbb", "Laptop");
		makeSession(desk.dataDir, "chat_d1", ["one"], { tutor: true, home: "LearnHarness/A", jobs: ["job_1"] });
		await desk.sync.tick();
		await laptop.sync.tick();
		desk.sync; // the desktop deletes it (the app removes all four kinds of file)
		sessionFiles(sessionDirsUnder(desk.dataDir)).remove("chat_d1");
		w.tick();
		assert.deepEqual(await desk.sync.tick(), { ok: true, fetched: [], sent: [], removed: ["chat_d1"], lost: [], handed: [] });
		assert.deepEqual(library(w.serverDir), {});
		assert.deepEqual(await laptop.sync.tick(), { ok: true, fetched: [], sent: [], removed: ["chat_d1"], lost: [], handed: [] });
		assert.deepEqual(library(laptop.dataDir), {});
		assert.equal(laptop.sync.holds("chat_d1"), true, "a deleted id is nobody's");
	});

	it("a session deleted on the phone disappears from the desktop", async () => {
		const w = world();
		const desk = w.desktop("dev_aaaaaaaaaaaaaaaa", "Office PC");
		makeSession(w.serverDir, "chat_c1", ["phone"], { jobs: ["job_c"] });
		await desk.sync.tick();
		sessionFiles(sessionDirsUnder(w.serverDir)).remove("chat_c1");
		w.tick();
		assert.deepEqual(await desk.sync.tick(), { ok: true, fetched: [], sent: [], removed: ["chat_c1"], lost: [], handed: [] });
		assert.deepEqual(library(desk.dataDir), {});
	});

	it("a device that doesn't hold a session can't delete it; its files come back", async () => {
		const w = world();
		const desk = w.desktop("dev_aaaaaaaaaaaaaaaa", "Office PC");
		makeSession(w.serverDir, "chat_c1", ["phone"]);
		await desk.sync.tick();
		assert.equal(w.authority.remove(desk.deviceId, "chat_c1").status, 409);
		fs.rmSync(path.join(desk.dataDir, "chats", "chat_c1.json"));
		w.tick();
		await desk.sync.tick();
		assert.deepEqual(turnsOf(desk.dataDir, "chat_c1"), ["phone"]);
		assert.deepEqual(turnsOf(w.serverDir, "chat_c1"), ["phone"]);
	});

	it("a deleted session can't be sent back", async () => {
		const w = world();
		const desk = w.desktop("dev_aaaaaaaaaaaaaaaa", "Office PC");
		makeSession(desk.dataDir, "chat_d1", ["one"]);
		await desk.sync.tick();
		const bundle = sessionFiles(sessionDirsUnder(desk.dataDir)).read("chat_d1")!;
		assert.equal(w.authority.remove(desk.deviceId, "chat_d1").status, 200);
		const again = w.authority.store(desk.deviceId, "chat_d1", { baseVersion: 1, bundle });
		assert.equal(again.status, 410);
		assert.deepEqual(library(w.serverDir), {});
	});
});

describe("what the server accepts", () => {
	it("only files that are what they claim to be", () => {
		const chat = JSON.stringify({ id: "chat_a", messages: [] });
		const good = { chat, sideTutor: null, home: null, jobs: {} };
		assert.notEqual(sessions.checkBundle("chat_a", good), null);
		assert.equal(sessions.checkBundle("chat_b", good), null, "another session's record");
		assert.equal(sessions.checkBundle("../chat_a", good), null);
		assert.equal(sessions.checkBundle("chat_a", { ...good, chat: "not json" }), null);
		assert.equal(sessions.checkBundle("chat_a", { ...good, chat: JSON.stringify({ id: "chat_a" }) }), null, "no messages");
		assert.equal(sessions.checkBundle("chat_a", { ...good, sideTutor: "[]" }), null);
		assert.equal(sessions.checkBundle("chat_a", { ...good, jobs: { job_1: JSON.stringify({ id: "job_1", chatId: "chat_other" }) } }), null, "another session's job");
		assert.equal(sessions.checkBundle("chat_a", { ...good, jobs: { "../x": JSON.stringify({ id: "../x", chatId: "chat_a" }) } }), null);
		assert.equal(sessions.checkBundle("chat_a", { ...good, jobs: { job_1: JSON.stringify({ id: "job_2", chatId: "chat_a" }) } }), null);
		assert.equal(sessions.checkBundle("chat_a", null), null);
	});

	it("a send that didn't arrive whole changes nothing", async () => {
		const w = world();
		const desk = w.desktop("dev_aaaaaaaaaaaaaaaa", "Office PC");
		makeSession(desk.dataDir, "chat_d1", ["one"]);
		await desk.sync.tick();
		const refused = w.authority.store(desk.deviceId, "chat_d1", { baseVersion: 1, bundle: { chat: "{", sideTutor: null, home: null, jobs: {} } });
		assert.equal(refused.status, 400);
		assert.deepEqual(turnsOf(w.serverDir, "chat_d1"), ["one"]);
	});

	it("a desktop whose place in the list is from another life of the server gets everything again", async () => {
		const w = world();
		const desk = w.desktop("dev_aaaaaaaaaaaaaaaa", "Office PC");
		makeSession(w.serverDir, "chat_c1", ["phone"]);
		await desk.sync.tick();
		const reply = w.authority.exchange(desk.deviceId, { cursor: 9999 });
		assert.equal((reply.body.changes as unknown[]).length, 1);
		assert.equal(w.authority.exchange(desk.deviceId, { cursor: -1 }).status, 400);
		assert.equal(w.authority.exchange(desk.deviceId, {}).status, 400);
	});

	it("remembers the holder's last word and when it was heard from", async () => {
		const w = world();
		const desk = w.desktop("dev_aaaaaaaaaaaaaaaa", "Office PC");
		makeSession(desk.dataDir, "chat_d1", ["one"]);
		makeSession(w.serverDir, "chat_c1", ["phone"]);
		await desk.sync.tick();
		w.authority.exchange(desk.deviceId, { cursor: 0, reports: { chat_d1: "busy", chat_c1: "busy", chat_d1x: "busy", chat_d1y: 7 } });
		const state = JSON.parse(fs.readFileSync(path.join(w.serverDir, "sync", "authority.json"), "utf-8")) as { sessions: Record<string, { report?: { word: string } }>; seen: Record<string, number> };
		assert.equal(state.sessions.chat_d1!.report!.word, "busy");
		assert.equal(state.sessions.chat_c1!.report, undefined, "only the holder's word about its own sessions counts");
		assert.equal(typeof state.seen[desk.deviceId], "number");
	});
});

describe("a held session is read-only here", () => {
	it("the stores drop writes to it and pass everything else", () => {
		const calls: string[] = [];
		const record = { id: "chat_held", title: "T", createdAt: "", updatedAt: "", messages: [] };
		const inner = {
			createChat: () => { calls.push("create"); return record; },
			getChat: () => record,
			listChats: () => [],
			saveMessages: (id: string) => { calls.push(`messages:${id}`); },
			saveImageSnapshot: (id: string) => { calls.push(`image:${id}`); },
			saveTree: (id: string) => { calls.push(`tree:${id}`); },
			appendTurnUsage: (id: string) => { calls.push(`turn:${id}`); },
			appendExtractionUsage: (id: string) => { calls.push(`extraction:${id}`); },
			saveSettings: (id: string) => { calls.push(`settings:${id}`); },
			renameChat: (id: string) => { calls.push(`rename:${id}`); return record; },
			deleteChat: (id: string) => { calls.push(`delete:${id}`); return true; },
		};
		const warn = console.warn;
		console.warn = () => {};
		try {
			const chats = guards.guardChatStore(inner as never, (id) => id !== "chat_held");
			chats.saveMessages("chat_held", []);
			chats.saveImageSnapshot("chat_held", "x", {} as never);
			chats.saveTree("chat_held", {} as never);
			chats.appendTurnUsage("chat_held", {} as never);
			chats.appendExtractionUsage("chat_held", {} as never);
			chats.saveSettings("chat_held", {});
			assert.equal(chats.renameChat("chat_held", "New").title, "T");
			assert.equal(chats.deleteChat("chat_held"), false);
			assert.deepEqual(calls, []);
			chats.saveMessages("chat_mine", []);
			assert.equal(chats.deleteChat("chat_mine"), true);
			chats.createChat("x");
			assert.deepEqual(calls, ["messages:chat_mine", "delete:chat_mine", "create"]);

			const thread = { version: 1 as const, chatId: "chat_held", entries: [] };
			const tutorCalls: string[] = [];
			const tutor = guards.guardSideTutorStore({ read: () => thread, append: (id) => { tutorCalls.push(`append:${id}`); return thread; }, clear: (id) => { tutorCalls.push(`clear:${id}`); } }, (id) => id !== "chat_held");
			assert.equal(tutor.append("chat_held", {} as never), thread);
			tutor.clear("chat_held");
			tutor.clear("chat_mine");
			assert.deepEqual(tutorCalls, ["clear:chat_mine"]);

			const job = { id: "job_1", chatId: "chat_held" };
			const jobCalls: string[] = [];
			const jobs = guards.guardJobStore({
				createJob: () => job as never, getJob: (id) => (id === "job_1" ? job : { id, chatId: "chat_mine" }) as never, listJobs: () => [], findJobByToolCallId: () => null,
				updateJob: (id) => { jobCalls.push(`update:${id}`); return null; }, deleteJobsForChat: (id) => { jobCalls.push(`delete:${id}`); return 1; },
			}, (id) => id !== "chat_held");
			assert.equal(jobs.updateJob("job_1", { activity: "late" }), job);
			assert.equal(jobs.deleteJobsForChat("chat_held"), 0);
			jobs.updateJob("job_2", {});
			assert.deepEqual(jobCalls, ["update:job_2"]);
		} finally {
			console.warn = warn;
		}
	});

	it("every write under /api/chats/<id> is a session write, except the notes home folder", () => {
		const id = "chat_abc_123";
		assert.equal(engine.sessionWritePath("PUT", `/api/chats/${id}`), id);
		assert.equal(engine.sessionWritePath("DELETE", `/api/chats/${id}`), id);
		assert.equal(engine.sessionWritePath("PUT", `/api/chats/${id}/settings`), id);
		assert.equal(engine.sessionWritePath("POST", `/api/chats/${id}/dismiss`), id);
		assert.equal(engine.sessionWritePath("POST", `/api/chats/${id}/artifact-ui`), id);
		assert.equal(engine.sessionWritePath("POST", `/api/chats/${id}/steer`), id);
		assert.equal(engine.sessionWritePath("POST", `/api/chats/${id}/side-tutor`), id);
		assert.equal(engine.sessionWritePath("DELETE", `/api/chats/${id}/side-tutor`), id);
		assert.equal(engine.sessionWritePath("PUT", `/api/chats/${id}/notes`), null, "the drawer keeps working");
		assert.equal(engine.sessionWritePath("GET", `/api/chats/${id}`), null);
		assert.equal(engine.sessionWritePath("GET", `/api/chats/${id}/stream`), null);
		assert.equal(engine.sessionWritePath("POST", "/api/chats"), null, "a new session is always allowed");
		assert.equal(engine.sessionWritePath("POST", "/api/chat"), null, "the turn route checks inside, where it knows the session");
	});
});

describe("a round in which nothing changed", () => {
	it("writes no file on either side, and the server still knows the desktop is there", async () => {
		const w = world();
		const desk = w.desktop("dev_aaaaaaaaaaaaaaaa", "Office PC");
		makeSession(desk.dataDir, "chat_d1", ["hello"]);
		makeSession(w.serverDir, "chat_c1", ["from the phone"]);
		await desk.sync.tick();
		await desk.sync.tick();
		// Files are replaced whole when written, so an untouched file keeps its identity.
		const identity = () => [path.join(desk.dataDir, "sync", "desktop.json"), path.join(w.serverDir, "sync", "authority.json")].map((file) => fs.statSync(file).ino);
		const before = identity();
		for (let i = 0; i < 5; i++) {
			w.tick(10_000);
			assert.deepEqual(await desk.sync.tick(), { ok: true, fetched: [], sent: [], removed: [], lost: [], handed: [] });
		}
		assert.deepEqual(identity(), before, "fifty idle seconds: nothing rewritten");
		assert.equal(w.authority.held().chat_d1!.online, true);
		// The record on disk follows about once a minute, for "offline since …" after a restart.
		w.tick(60_000);
		await desk.sync.tick();
		assert.notEqual(identity()[1], before[1]);
		w.tick(45_000);
		assert.equal(w.authority.held().chat_d1!.online, false, "45 silent seconds later it counts as offline");
	});
});
