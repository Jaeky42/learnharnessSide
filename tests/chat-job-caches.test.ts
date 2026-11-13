/**
 * Perf round: the session list's summary cache, the job store's file-to-chat
 * map, and the stale-job sweep that reads each job file once and never parses
 * a chat file per job.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-caches-"));
process.env.LH_DATA_DIR = scratch;
process.env.LH_AUTH_FILE = path.join(scratch, "empty-auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}", { mode: 0o600 });
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
const { stores } = await import("../src/server/stores.ts");
const { recoverStaleJobs, setJobRespawn } = await import("../src/server/jobs.ts");
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const chatsDir = path.join(scratch, "chats");
const jobsDir = path.join(scratch, "jobs");
const wait = () => new Promise((resolve) => setTimeout(resolve, 5));

/** What the list was before the cache: every file parsed in full, every time. Each
 *  import with its own query string is a fresh module, so its list is never cached. */
let fresh = 0;
async function uncachedList() {
	const store = await import(`../src/store/chats.ts?uncached=${++fresh}`);
	return store.chatStore.listChats();
}

async function reads<T>(match: string, fn: () => T | Promise<T>): Promise<{ result: T; files: string[] }> {
	const real = fs.readFileSync;
	const files: string[] = [];
	(fs as { readFileSync: unknown }).readFileSync = function (p: unknown, ...rest: unknown[]) {
		if (String(p).includes(match)) files.push(String(p));
		return (real as (...a: unknown[]) => unknown)(p, ...rest);
	};
	syncBuiltinESMExports();
	try { return { result: await fn(), files }; } finally {
		(fs as { readFileSync: unknown }).readFileSync = real;
		syncBuiltinESMExports();
	}
}

/** Makes the first read of a file whose path contains `match` throw (a transient EBUSY), then behaves normally. */
async function failFirstRead<T>(match: string, fn: () => T | Promise<T>): Promise<T> {
	const real = fs.readFileSync;
	let failed = false;
	(fs as { readFileSync: unknown }).readFileSync = function (p: unknown, ...rest: unknown[]) {
		if (!failed && String(p).includes(match)) { failed = true; throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" }); }
		return (real as (...a: unknown[]) => unknown)(p, ...rest);
	};
	syncBuiltinESMExports();
	try { return await fn(); } finally {
		(fs as { readFileSync: unknown }).readFileSync = real;
		syncBuiltinESMExports();
	}
}

describe("the session list's summary cache", () => {
	it("equals an uncached reference after add, save, rename, external replacement, delete and a corrupt file", async () => {
		const check = async (what: string) => assert.deepEqual(chatStore.listChats(), await uncachedList(), what);
		await check("empty");
		const a = chatStore.createChat("Alpha");
		await wait();
		const b = chatStore.createChat("Beta", "practice");
		await check("after add");
		chatStore.saveMessages(a.id, [{ id: "u1", role: "user", content: "hello", timestamp: 1 }] as never);
		await check("after save");
		chatStore.renameChat(b.id, "Beta renamed");
		await check("after rename");
		// replaced from outside the store, as cloud sync or the official app does
		const file = path.join(chatsDir, `${a.id}.json`);
		const record = JSON.parse(fs.readFileSync(file, "utf8"));
		record.title = "Alpha from elsewhere";
		record.updatedAt = "2099-01-01T00:00:00.000Z";
		fs.writeFileSync(file + ".x", JSON.stringify(record));
		fs.renameSync(file + ".x", file);
		await check("after an external replacement");
		assert.equal(chatStore.listChats()[0]!.title, "Alpha from elsewhere");
		fs.writeFileSync(path.join(chatsDir, "chat_corrupt_0000.json"), "{ not json");
		await check("with a corrupt file");
		assert.equal(chatStore.listChats().some((c) => c.id === "chat_corrupt_0000"), false);
		fs.writeFileSync(path.join(chatsDir, "chat_future_0000.json"), JSON.stringify({ id: "chat_future_0000", title: "f", createdAt: "x", updatedAt: "x", messages: [], version: 99 }));
		await check("with a newer-format file");
		fs.writeFileSync(path.join(chatsDir, "chat_corrupt_0000.json"), JSON.stringify({ id: "chat_corrupt_0000", title: "Fixed", createdAt: "x", updatedAt: "2000", messages: [] }));
		await check("after the corrupt file is fixed");
		assert.equal(chatStore.listChats().some((c) => c.id === "chat_corrupt_0000"), true);
		chatStore.deleteChat(b.id);
		fs.unlinkSync(path.join(chatsDir, "chat_corrupt_0000.json"));
		fs.unlinkSync(path.join(chatsDir, "chat_future_0000.json")); // files that can't be listed are re-read each call, so clean up
		await check("after deletes");
		assert.equal(chatStore.listChats().some((c) => c.id === b.id), false);
	});
	it("parses a file again only when its stamp changed", async () => {
		const ids = chatStore.listChats().map((c) => c.id);
		assert.ok(ids.length >= 1);
		const second = await reads(`${path.sep}chats${path.sep}`, () => chatStore.listChats());
		assert.deepEqual(second.files, [], "an unchanged library is not read at all");
		const target = ids[0]!;
		await wait();
		chatStore.renameChat(target, "Changed once");
		const third = await reads(`${path.sep}chats${path.sep}`, () => chatStore.listChats());
		assert.deepEqual(third.files, [path.join(chatsDir, `${target}.json`)], "only the changed file is read");
	});
	it("never caches a failed read: a file that couldn't be read once is listed next call with its stat unchanged", async () => {
		const chat = chatStore.createChat("flaky read");
		const file = path.join(chatsDir, `${chat.id}.json`);
		chatStore.listChats(); // cached
		await wait();
		chatStore.renameChat(chat.id, "flaky read, renamed"); // new stamp: the next list must re-read it
		const statBefore = fs.statSync(file);
		const during = await failFirstRead(`${chat.id}.json`, () => chatStore.listChats());
		assert.equal(during.some((c) => c.id === chat.id), false, "the failed read drops it from that one list");
		const statAfter = fs.statSync(file);
		assert.equal(statAfter.mtimeMs, statBefore.mtimeMs);
		assert.equal(statAfter.ino, statBefore.ino);
		const next = chatStore.listChats();
		assert.equal(next.find((c) => c.id === chat.id)?.title, "flaky read, renamed");
		assert.deepEqual(next, await uncachedList());
	});
	it("hands out fresh objects: changing a result never changes the next one", () => {
		const first = chatStore.listChats();
		first[0]!.title = "tampered";
		(first[0] as { settings?: unknown }).settings = { thinkingLevel: "max" };
		first.pop();
		const second = chatStore.listChats();
		assert.notEqual(second[0]!.title, "tampered");
		assert.equal(second.length, first.length + 1);
		assert.notEqual(second[0], chatStore.listChats()[0]);
	});
});

function writeJobFile(id: string, chatId: string, patch: Record<string, unknown> = {}) {
	fs.mkdirSync(jobsDir, { recursive: true });
	fs.writeFileSync(path.join(jobsDir, `${id}.json`), JSON.stringify({ id, kind: "research", chatId, toolCallId: `tc_${id}`, status: "done", activity: "done", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...patch }));
}

describe("the job store's file-to-chat map", () => {
	it("lists what is on disk after creates, updates, outside writes and deletes", async () => {
		const chat = chatStore.createChat("jobs a");
		const other = chatStore.createChat("jobs b");
		const j1 = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "t1" });
		assert.deepEqual(jobStore.listJobs(chat.id).map((j) => j.id), [j1.id]);
		await wait();
		jobStore.updateJob(j1.id, { activity: "second" });
		assert.equal(jobStore.listJobs(chat.id)[0]!.activity, "second");
		writeJobFile("job_outside_1", chat.id, { updatedAt: "2099-01-01T00:00:00.000Z" });
		assert.deepEqual(jobStore.listJobs(chat.id).map((j) => j.id), ["job_outside_1", j1.id]);
		assert.deepEqual(jobStore.listJobs(other.id), []);
		// fresh records: tampering with one doesn't reach the next listing
		jobStore.listJobs(chat.id)[0]!.activity = "tampered";
		assert.equal(jobStore.listJobs(chat.id)[0]!.activity, "done");
		fs.writeFileSync(path.join(jobsDir, "job_corrupt.json"), "{ nope");
		assert.equal(jobStore.listJobs(chat.id).length, 2);
		fs.unlinkSync(path.join(jobsDir, "job_corrupt.json")); // an unreadable file is re-read each call; clean up
		assert.equal(jobStore.deleteJobsForChat(chat.id), 2);
		assert.deepEqual(jobStore.listJobs(chat.id), []);
	});
	it("a job rewritten in place with the same size and the same mtime is seen fresh", () => {
		writeJobFile("job_inplace", "chat_inplace_0000", { activity: "aaaa" });
		const file = path.join(jobsDir, "job_inplace.json");
		assert.equal(jobStore.listJobs("chat_inplace_0000")[0]!.activity, "aaaa");
		const { atime, mtime } = fs.statSync(file);
		const text = fs.readFileSync(file, "utf8");
		fs.writeFileSync(file, text.replace("aaaa", "bbbb")); // same length
		fs.utimesSync(file, atime, mtime);
		assert.equal(fs.statSync(file).size, Buffer.byteLength(text));
		assert.equal(jobStore.listJobs("chat_inplace_0000")[0]!.activity, "bbbb");
	});
	it("a read that fails once is retried next call", async () => {
		writeJobFile("job_flaky", "chat_flaky_0000");
		const during = await failFirstRead("job_flaky.json", () => jobStore.listJobs("chat_flaky_0000"));
		assert.deepEqual(during, []);
		assert.deepEqual(jobStore.listJobs("chat_flaky_0000").map((j) => j.id), ["job_flaky"]);
		// also once the file is known: a failed read drops it from that call only
		const again = await failFirstRead("job_flaky.json", () => jobStore.listJobs("chat_flaky_0000"));
		assert.deepEqual(again, []);
		assert.deepEqual(jobStore.listJobs("chat_flaky_0000").map((j) => j.id), ["job_flaky"]);
	});
	it("a deleted job file is forgotten: its name can come back under another chat", () => {
		writeJobFile("job_reborn", "chat_old_0000");
		assert.equal(jobStore.listJobs("chat_old_0000").length, 1); // mapped to chat_old
		fs.unlinkSync(path.join(jobsDir, "job_reborn.json"));
		assert.deepEqual(jobStore.listJobs("chat_new_0000"), []); // the listing drops the entry
		writeJobFile("job_reborn", "chat_new_0000");
		assert.deepEqual(jobStore.listJobs("chat_new_0000").map((j) => j.id), ["job_reborn"]);
		assert.deepEqual(jobStore.listJobs("chat_old_0000"), []);
	});
	it("a file of another chat is not read once it is known", async () => {
		writeJobFile("job_known", "chat_known_0000");
		jobStore.listJobs("chat_known_0000");
		const { files } = await reads(`${path.sep}jobs${path.sep}`, () => jobStore.listJobs("chat_somebody_else"));
		assert.equal(files.includes(path.join(jobsDir, "job_known.json")), false);
	});
});

describe("the stale-job sweep", () => {
	const sweep = () => { (globalThis as { __lhWakePipeline?: { lastSweepAt: number } }).__lhWakePipeline!.lastSweepAt = 0; recoverStaleJobs(); };
	const chats = Array.from({ length: 4 }, (_, i) => chatStore.createChat(`sweep ${i}`).id);
	const respawned: string[] = [];
	setJobRespawn((id) => { respawned.push(id); });
	// Finished jobs with nothing owed: the sweep only looks at them (a recovered job is
	// rewritten by the sweep itself, which is its own, separate read).
	const ids = Array.from({ length: 12 }, (_, i) => `job_sweep_${i}`);
	ids.forEach((id, i) => writeJobFile(id, chats[i % chats.length]!));
	recoverStaleJobs(); // makes the wake state exist (the throttle may skip this one)

	it("never parses a chat per job and reads each job file at most once per sweep", async () => {
		sweep(); // warm: every file's chat is known (a cold first listing reads unseen files once more)
		let getChatCalls = 0;
		const originalGet = stores.chatStore.getChat;
		(stores.chatStore as { getChat: unknown }).getChat = (id: string) => { getChatCalls++; return originalGet(id); };
		try {
			const jobReads = await reads(`${path.sep}jobs${path.sep}`, () => { sweep(); });
			assert.equal(getChatCalls, 0, "no getChat per job");
			const perFile = new Map<string, number>();
			for (const f of jobReads.files) perFile.set(f, (perFile.get(f) ?? 0) + 1);
			assert.ok([...perFile.values()].every((n) => n <= 1), `each job file read at most once: ${JSON.stringify([...perFile])}`);
			for (const id of ids) assert.equal(perFile.get(path.join(jobsDir, `${id}.json`)), 1, "and every job file of an existing chat is read");
			const chatReadsDuringSweep = await reads(`${path.sep}chats${path.sep}`, () => { sweep(); });
			assert.equal(chatReadsDuringSweep.files.length, 0, "no chat file is parsed during a sweep");
		} finally {
			(stores.chatStore as { getChat: unknown }).getChat = originalGet;
		}
	});
	it("still re-runs a running orphan whose chat exists, in any chat, and skips one whose chat is gone", () => {
		writeJobFile("job_orphan_a", chats[0]!, { status: "running" });
		writeJobFile("job_orphan_b", chats[3]!, { status: "running" });
		writeJobFile("job_orphan_gone", "chat_deleted_0000", { status: "running" });
		respawned.length = 0;
		sweep();
		assert.deepEqual([...respawned].sort(), ["job_orphan_a", "job_orphan_b"]);
	});
});
