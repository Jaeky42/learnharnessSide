/**
 * Cloud sync Phase 5, slice 6 (docs/cloud-sync.md): the pictures in a
 * session are sent once, not with every send of the session (approved with
 * the plan), and both sides still end with the same files, byte for byte.
 *
 * A lease authority and one or two desktops over separate data folders in
 * one process; every request is recorded with its size.
 */

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sync-pictures-"));
process.env.LH_AUTH_FILE = path.join(TMP, "prod", "secrets", "auth.json");
process.env.LH_DATA_DIR = path.join(TMP, "prod", "data");

const pictures = await import("../src/core/sync/pictures.ts");
const { sessionFiles, sessionDirsUnder } = await import("../src/store/sync/session-files.ts");
const { stateFile } = await import("../src/store/sync/state-file.ts");
const { pictureStaging } = await import("../src/store/sync/picture-staging.ts");
const { createAuthority, isAuthorityState } = await import("../src/server/sync/authority.ts");
const { createDesktopSync, isDesktopState } = await import("../src/server/sync/desktop-sync.ts");
import type { SyncReply } from "../src/server/sync/client.ts";
import type { AuthorityReply } from "../src/server/sync/authority.ts";

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** A picture the way the app stores it: named by the SHA-256 of its bytes. */
function picture(bytes: number) {
	const raw = randomBytes(bytes);
	return { id: createHash("sha256").update(raw).digest("hex"), snapshot: { mimeType: "image/png", data: raw.toString("base64"), width: 640, height: 480 } };
}

const chatFile = (dataDir: string, id: string) => path.join(dataDir, "chats", `${id}.json`);
const readChat = (dataDir: string, id: string) => JSON.parse(fs.readFileSync(chatFile(dataDir, id), "utf-8")) as { messages: unknown[]; imageSnapshots?: Record<string, unknown>; title: string };
function writeChat(dataDir: string, id: string, record: unknown): void {
	fs.mkdirSync(path.dirname(chatFile(dataDir, id)), { recursive: true });
	fs.writeFileSync(chatFile(dataDir, id), JSON.stringify(record, null, "\t"));
}
/** A session on disk the way the app writes it, pictures in the middle of the record. */
function makeSession(dataDir: string, id: string, snapshots: Array<ReturnType<typeof picture>>): void {
	writeChat(dataDir, id, {
		id, title: `Session ${id}`, createdAt: "2026-11-01T10:00:00.000Z", updatedAt: "2026-11-01T10:00:00.000Z",
		messages: [{ role: "user", content: "show me" }],
		...(snapshots.length ? { imageSnapshots: Object.fromEntries(snapshots.map((p) => [p.id, p.snapshot])) } : {}),
		kind: "teach", version: 1,
	});
}
function addTurn(dataDir: string, id: string, text: string, more: Array<ReturnType<typeof picture>> = []): void {
	const record = readChat(dataDir, id);
	record.messages.push({ role: "user", content: text });
	if (more.length) record.imageSnapshots = { ...record.imageSnapshots, ...Object.fromEntries(more.map((p) => [p.id, p.snapshot])) };
	writeChat(dataDir, id, record);
}

let worlds = 0;
function world() {
	const root = path.join(TMP, `w${++worlds}`);
	const serverDir = path.join(root, "server", "data");
	let clock = 1_000_000;
	const sent: Array<{ by: string; method: string; path: string; bytes: number; status: number }> = [];
	const authority = createAuthority({
		files: sessionFiles(sessionDirsUnder(serverDir)),
		state: stateFile(path.join(serverDir, "sync", "authority.json"), isAuthorityState),
		now: () => clock,
		deviceName: () => "PC",
		makeBackup: () => null,
		staging: pictureStaging(path.join(serverDir, "sync")),
	});
	function desktop(deviceId: string) {
		const dataDir = path.join(root, deviceId, "data");
		const sync = createDesktopSync({
			files: sessionFiles(sessionDirsUnder(dataDir)),
			state: stateFile(path.join(dataDir, "sync", "desktop.json"), isDesktopState),
			identity: () => ({ server: "https://learn.example.com", deviceId }),
			request: async <T>(pathname: string, init: { method?: string; body?: unknown } = {}) => {
				const text = init.body === undefined ? "" : JSON.stringify(init.body);
				const body = text ? JSON.parse(text) as unknown : undefined;
				const method = init.method ?? (body === undefined ? "GET" : "POST");
				const one = /^\/api\/sync\/sessions\/([^/]+)$/.exec(pathname);
				const pic = /^\/api\/sync\/sessions\/([^/]+)\/pictures\/([^/]+)$/.exec(pathname);
				const take = /^\/api\/sync\/sessions\/([^/]+)\/take$/.exec(pathname);
				const result = pic ? (method === "GET" ? authority.picture(deviceId, pic[1]!, pic[2]!) : authority.storePicture(deviceId, pic[1]!, pic[2]!, body))
					: take ? authority.takeOver(deviceId, take[1]!, (body as { force?: boolean }).force === true)
					: !one ? authority.exchange(deviceId, body)
					: method === "GET" ? authority.fetch(deviceId, one[1]!)
					: method === "PUT" ? authority.store(deviceId, one[1]!, body)
					: authority.remove(deviceId, one[1]!);
				const answer = JSON.stringify(result);
				sent.push({ by: deviceId, method, path: pathname.replace(/[a-f0-9]{64}/, "<picture>"), bytes: method === "GET" ? answer.length : text.length, status: result.status });
				const copy = JSON.parse(answer) as AuthorityReply;
				return (copy.status === 200 ? { ok: true, body: copy.body } : { ok: false, reason: "refused", status: copy.status, code: typeof copy.body.code === "string" ? copy.body.code : null, error: String(copy.body.error), body: copy.body }) as SyncReply<T>;
			},
			now: () => clock,
			makeBackup: () => null,
		});
		return { dataDir, sync };
	}
	return { root, serverDir, authority, desktop, sent, tick: (ms = 1000) => { clock += ms; }, since: (from: number) => sent.slice(from).map((r) => `${r.method} ${r.path.replace("/api/sync/sessions", "")} ${r.status}`) };
}

describe("a chat file without its pictures", () => {
	const a = picture(3000), b = picture(500);
	const record = { id: "chat_1", title: "T", messages: [{ role: "user", content: "x" }], imageSnapshots: { [a.id]: a.snapshot, [b.id]: b.snapshot }, kind: "teach", version: 1 };
	const text = JSON.stringify(record, null, "\t");

	it("comes apart and goes back together into the very same file", () => {
		const slim = pictures.withoutPictures(text)!;
		assert.equal(slim.chat.includes(a.snapshot.data), false);
		assert.ok(slim.chat.length < 300);
		assert.deepEqual(slim.pictures.list.map(([id, details]) => [id, details.data, details.width]), [[a.id, "", 640], [b.id, "", 640]]);
		assert.equal(slim.pictures.at, 3);
		const back = pictures.withPictures(slim.chat, slim.pictures, (id) => slim.data.get(id) ?? null);
		assert.deepEqual(back, { text });
		assert.deepEqual(pictures.withPictures(slim.chat, slim.pictures, (id) => (id === a.id ? a.snapshot.data : null)), { missing: [b.id] });
		assert.deepEqual([...pictures.picturesIn(text).keys()], [a.id, b.id]);
	});

	it("a file that isn't in the app's own formatting travels whole instead", () => {
		assert.equal(pictures.withoutPictures(JSON.stringify(record)), null, "no indentation");
		assert.equal(pictures.withoutPictures(`${text}\n`), null, "a trailing newline");
		assert.equal(pictures.withoutPictures(JSON.stringify({ id: "chat_1", messages: [] }, null, "\t")), null, "no pictures");
		assert.equal(pictures.withoutPictures(JSON.stringify({ ...record, imageSnapshots: { "not-a-hash": a.snapshot } }, null, "\t")), null);
	});

	it("a picture list from the other side is checked", () => {
		const good = pictures.withoutPictures(text)!.pictures;
		assert.deepEqual(pictures.checkPictureList(JSON.parse(JSON.stringify(good))), good);
		assert.equal(pictures.checkPictureList({ at: 0, list: [], inline: [] }), null, "no pictures at all");
		assert.equal(pictures.checkPictureList({ at: -1, list: good.list, inline: [] }), null, "snapshots with no place");
		assert.equal(pictures.checkPictureList({ at: 0, list: good.list }), null, "no inline list (a protocol-1 sender)");
		assert.equal(pictures.checkPictureList({ at: 0, list: [["zz", { data: "" }]], inline: [] }), null);
		assert.equal(pictures.checkPictureList({ at: 0, list: [[a.id, { data: "smuggled" }]], inline: [] }), null);
		assert.equal(pictures.checkPictureList({ at: 0, list: [good.list[0], good.list[0]], inline: [] }), null, "the same picture twice");
		assert.equal(pictures.pictureMatches(a.id, a.snapshot.data), true);
		assert.equal(pictures.pictureMatches(a.id, b.snapshot.data), false);
		assert.equal(pictures.pictureMatches(a.id, `${a.snapshot.data}\n`), false, "another spelling of the same bytes");
	});
});

describe("a session with pictures", () => {
	it("goes up with each picture sent once; later sends of the session carry none", async () => {
		const w = world();
		const desk = w.desktop("dev_aaaaaaaaaaaaaaaa");
		const p1 = picture(200_000), p2 = picture(150_000);
		makeSession(desk.dataDir, "chat_d1", [p1, p2]);
		await desk.sync.tick();
		assert.deepEqual(w.since(0), ["POST  200", "PUT /chat_d1 409", "PUT /chat_d1/pictures/<picture> 200", "PUT /chat_d1/pictures/<picture> 200", "PUT /chat_d1 200"]);
		assert.equal(fs.readFileSync(chatFile(w.serverDir, "chat_d1"), "utf-8"), fs.readFileSync(chatFile(desk.dataDir, "chat_d1"), "utf-8"), "the same file, byte for byte");
		assert.equal(fs.existsSync(path.join(w.serverDir, "sync", "pictures", "chat_d1")), false, "nothing is left waiting");

		// Ten more turns: ten sends, none of them carries a picture.
		const from = w.sent.length;
		for (let i = 0; i < 10; i++) {
			w.tick();
			addTurn(desk.dataDir, "chat_d1", `turn ${i}`);
			await desk.sync.tick();
		}
		const sends = w.sent.slice(from).filter((r) => r.method === "PUT");
		assert.equal(sends.length, 10);
		assert.ok(sends.every((r) => r.status === 200 && r.path === "/api/sync/sessions/chat_d1" && r.bytes < 5000), `sizes: ${sends.map((r) => r.bytes).join(", ")}`);
		assert.ok(fs.statSync(chatFile(desk.dataDir, "chat_d1")).size > 450_000, "while the file itself holds both pictures");
		assert.equal(fs.readFileSync(chatFile(w.serverDir, "chat_d1"), "utf-8"), fs.readFileSync(chatFile(desk.dataDir, "chat_d1"), "utf-8"));

		// A new picture: only that one goes.
		const before = w.sent.length;
		w.tick();
		addTurn(desk.dataDir, "chat_d1", "one more picture", [picture(90_000)]);
		await desk.sync.tick();
		assert.deepEqual(w.since(before).filter((line) => line.startsWith("PUT")), ["PUT /chat_d1 409", "PUT /chat_d1/pictures/<picture> 200", "PUT /chat_d1 200"]);
		assert.equal(fs.readFileSync(chatFile(w.serverDir, "chat_d1"), "utf-8"), fs.readFileSync(chatFile(desk.dataDir, "chat_d1"), "utf-8"));
	});

	it("comes down with each picture fetched once; a later fetch of the session brings only the new one", async () => {
		const w = world();
		const desk = w.desktop("dev_aaaaaaaaaaaaaaaa");
		const p1 = picture(120_000), p2 = picture(80_000);
		makeSession(w.serverDir, "chat_c1", [p1, p2]);
		await desk.sync.tick();
		assert.deepEqual(w.since(0), ["POST  200", "GET /chat_c1 200", "GET /chat_c1/pictures/<picture> 200", "GET /chat_c1/pictures/<picture> 200"]);
		assert.equal(fs.readFileSync(chatFile(desk.dataDir, "chat_c1"), "utf-8"), fs.readFileSync(chatFile(w.serverDir, "chat_c1"), "utf-8"));
		assert.ok(w.sent[1]!.bytes < 5000, "the session itself arrives small");

		const from = w.sent.length;
		w.tick();
		addTurn(w.serverDir, "chat_c1", "the phone carries on", [picture(60_000)]);
		await desk.sync.tick();
		assert.deepEqual(w.since(from), ["POST  200", "GET /chat_c1 200", "GET /chat_c1/pictures/<picture> 200"]);
		assert.equal(fs.readFileSync(chatFile(desk.dataDir, "chat_c1"), "utf-8"), fs.readFileSync(chatFile(w.serverDir, "chat_c1"), "utf-8"));
		assert.equal(Object.keys(readChat(desk.dataDir, "chat_c1").imageSnapshots!).length, 3);
	});

	it("a big picture goes up in pieces and arrives whole", async () => {
		const w = world();
		const desk = w.desktop("dev_aaaaaaaaaaaaaaaa");
		const big = picture(13 * 1024 * 1024); // about 17 MB as text: three pieces
		makeSession(desk.dataDir, "chat_big", [big]);
		await desk.sync.tick();
		const pieces = w.sent.filter((r) => r.path.includes("/pictures/"));
		assert.equal(pieces.length, 3);
		assert.ok(pieces.every((r) => r.status === 200 && r.bytes < 9 * 1024 * 1024), "each piece fits in one request");
		assert.equal(fs.readFileSync(chatFile(w.serverDir, "chat_big"), "utf-8"), fs.readFileSync(chatFile(desk.dataDir, "chat_big"), "utf-8"));
	});

	it("travels to a second desktop, and through a take-over, unchanged", async () => {
		const w = world();
		const desk = w.desktop("dev_aaaaaaaaaaaaaaaa");
		const laptop = w.desktop("dev_bbbbbbbbbbbbbbbb");
		makeSession(desk.dataDir, "chat_d1", [picture(50_000)]);
		await desk.sync.tick();
		await laptop.sync.tick();
		const original = fs.readFileSync(chatFile(desk.dataDir, "chat_d1"), "utf-8");
		assert.equal(fs.readFileSync(chatFile(laptop.dataDir, "chat_d1"), "utf-8"), original);
		// The desktop hands it over to the laptop, which adds a turn and a picture.
		assert.equal((await laptop.sync.takeOver("chat_d1", false)).status, "waiting");
		await desk.sync.tick();
		assert.equal((await laptop.sync.takeOver("chat_d1", false)).status, "yours");
		w.tick();
		addTurn(laptop.dataDir, "chat_d1", "from the laptop", [picture(40_000)]);
		await laptop.sync.tick();
		await desk.sync.tick();
		assert.equal(fs.readFileSync(chatFile(desk.dataDir, "chat_d1"), "utf-8"), fs.readFileSync(chatFile(laptop.dataDir, "chat_d1"), "utf-8"));
		assert.equal(fs.readFileSync(chatFile(w.serverDir, "chat_d1"), "utf-8"), fs.readFileSync(chatFile(laptop.dataDir, "chat_d1"), "utf-8"));
		assert.equal(Object.keys(readChat(desk.dataDir, "chat_d1").imageSnapshots!).length, 2);
	});

	it("a chat file in another formatting still syncs, whole", async () => {
		const w = world();
		const desk = w.desktop("dev_aaaaaaaaaaaaaaaa");
		const p = picture(20_000);
		fs.mkdirSync(path.join(desk.dataDir, "chats"), { recursive: true });
		const text = JSON.stringify({ id: "chat_odd", title: "Odd", createdAt: "x", updatedAt: "x", messages: [], imageSnapshots: { [p.id]: p.snapshot }, version: 1 });
		fs.writeFileSync(chatFile(desk.dataDir, "chat_odd"), text);
		await desk.sync.tick();
		assert.deepEqual(w.since(0), ["POST  200", "PUT /chat_odd 200"]);
		assert.equal(fs.readFileSync(chatFile(w.serverDir, "chat_odd"), "utf-8"), text);
	});
});

describe("what the server refuses", () => {
	it("a picture whose bytes don't match its name, a piece out of order, and a device that doesn't hold the session", async () => {
		const w = world();
		const desk = w.desktop("dev_aaaaaaaaaaaaaaaa");
		const p = picture(1000), other = picture(1000);
		makeSession(desk.dataDir, "chat_d1", [p]);
		await desk.sync.tick();
		assert.equal(w.authority.storePicture("dev_aaaaaaaaaaaaaaaa", "chat_d1", other.id, { part: 0, of: 1, data: p.snapshot.data }).status, 400, "bytes that don't match the name");
		assert.equal(w.authority.storePicture("dev_aaaaaaaaaaaaaaaa", "chat_d1", other.id, { part: 1, of: 2, data: "AAAA" }).status, 400, "a second piece with no first");
		assert.equal(w.authority.storePicture("dev_aaaaaaaaaaaaaaaa", "chat_d1", other.id, { part: 0, of: 1, data: "not base64 !!" }).status, 400);
		assert.equal(w.authority.storePicture("dev_aaaaaaaaaaaaaaaa", "chat_d1", "../../escape", { part: 0, of: 1, data: "AAAA" }).status, 400);
		assert.equal(w.authority.storePicture("dev_bbbbbbbbbbbbbbbb", "chat_d1", other.id, { part: 0, of: 1, data: other.snapshot.data }).status, 409, "not the holder");
		assert.equal(w.authority.picture("dev_bbbbbbbbbbbbbbbb", "chat_d1", other.id).status, 404);
		assert.equal(w.authority.picture("dev_bbbbbbbbbbbbbbbb", "chat_nope", p.id).status, 404);
		assert.equal((w.authority.picture("dev_bbbbbbbbbbbbbbbb", "chat_d1", p.id).body as { data: string }).data, p.snapshot.data);
		// A session sent with a list that names a picture nobody sent: asked for, never stored.
		const before = fs.readFileSync(chatFile(w.serverDir, "chat_d1"), "utf-8");
		const slim = pictures.withoutPictures(before)!;
		const reply = w.authority.store("dev_aaaaaaaaaaaaaaaa", "chat_d1", { bundle: { chat: slim.chat, home: null, jobs: {}, pictures: { at: slim.pictures.at, list: [...slim.pictures.list, [other.id, { mimeType: "image/png", data: "", width: 1, height: 1 }]], inline: [] } } });
		assert.equal(reply.status, 409);
		assert.deepEqual(reply.body.ids, [other.id]);
		assert.equal(fs.readFileSync(chatFile(w.serverDir, "chat_d1"), "utf-8"), before);
	});
});

// ─── Pictures inside messages (upstream 0.6.0) ───────────────────────────────

/** An image block the way upstream keeps it inside a message: { type, mimeType, data }. */
function block(bytes: number) {
	const raw = randomBytes(bytes);
	return { id: createHash("sha256").update(raw).digest("hex"), image: { type: "image", mimeType: "image/png", data: raw.toString("base64") } };
}

/** A session whose pictures sit inside its messages: a learner's attachment, a tool's result and a practice thinking marker. */
function makeInlineSession(dataDir: string, id: string, images: Array<ReturnType<typeof block>>, snapshots: Array<ReturnType<typeof picture>> = []): void {
	const [first, second, third] = images;
	writeChat(dataDir, id, {
		id, title: `Session ${id}`, createdAt: "2026-11-01T10:00:00.000Z", updatedAt: "2026-11-01T10:00:00.000Z",
		messages: [
			{ id: "m1", role: "user", content: [{ type: "text", text: "what is this?" }, ...(first ? [first.image] : [])], timestamp: 1 },
			...(second ? [{ id: "m2", role: "toolResult", toolCallId: "call_1", toolName: "read", content: [second.image], isError: false, timestamp: 2 }] : []),
			...(third ? [{ id: "m3", role: "custom", customType: "practice-thinking", content: "", display: true, details: { problemCallId: "p", text: "", images: [third.image] }, timestamp: 3 }] : []),
		],
		...(snapshots.length ? { imageSnapshots: Object.fromEntries(snapshots.map((p) => [p.id, p.snapshot])) } : {}),
		kind: "teach", version: 2,
	});
}

describe("pictures inside messages", () => {
	const a = block(4000), b = block(3000), c = block(2500), snap = picture(2000);

	it("come apart and go back together into the very same file", () => {
		const dir = path.join(TMP, "inline-unit");
		makeInlineSession(dir, "chat_i", [a, b, c], [snap]);
		const text = fs.readFileSync(chatFile(dir, "chat_i"), "utf-8");
		const slim = pictures.withoutPictures(text)!;
		for (const p of [a, b, c]) assert.equal(slim.chat.includes(p.image.data), false);
		assert.ok(slim.chat.length < 1500, `the chat without them: ${slim.chat.length}`);
		assert.deepEqual(slim.pictures.inline, [
			[["messages", 0, "content", 1], a.id],
			[["messages", 1, "content", 0], b.id],
			[["messages", 2, "details", "images", 0], c.id],
		]);
		assert.deepEqual(slim.pictures.list.map(([id]) => id), [snap.id]);
		assert.deepEqual(pictures.withPictures(slim.chat, slim.pictures, (id) => slim.data.get(id) ?? null), { text });
		assert.deepEqual(pictures.withPictures(slim.chat, slim.pictures, (id) => (id === b.id ? null : slim.data.get(id) ?? null)), { missing: [b.id] });
		assert.deepEqual(new Set(pictures.picturesIn(text).keys()), new Set([snap.id, a.id, b.id, c.id]));
		assert.deepEqual(pictures.checkPictureList(JSON.parse(JSON.stringify(slim.pictures))), slim.pictures);
	});

	it("a picture in two places is named once; a tiny one stays in the chat; another spelling of the bytes travels whole", () => {
		const dir = path.join(TMP, "inline-unit-2");
		const tiny = block(100);
		makeInlineSession(dir, "chat_twice", [a, a, tiny]);
		const text = fs.readFileSync(chatFile(dir, "chat_twice"), "utf-8");
		const slim = pictures.withoutPictures(text)!;
		assert.deepEqual(slim.pictures.inline.map(([, id]) => id), [a.id, a.id]);
		assert.deepEqual(pictures.pictureIds(slim.pictures), [a.id]);
		assert.equal(slim.chat.includes(tiny.image.data), true, "under MIN_INLINE_CHARS it rides along");
		assert.deepEqual(pictures.withPictures(slim.chat, slim.pictures, (id) => slim.data.get(id) ?? null), { text });

		// Base64 with a line break decodes to the same bytes: such a block isn't taken out.
		makeInlineSession(dir, "chat_odd", [{ ...a, image: { ...a.image, data: `${a.image.data.slice(0, 76)}\n${a.image.data.slice(76)}` } }]);
		assert.equal(pictures.withoutPictures(fs.readFileSync(chatFile(dir, "chat_odd"), "utf-8")), null);
		assert.equal(pictures.withoutPictures(JSON.stringify(JSON.parse(text))), null, "not the app's formatting");
	});

	it("a list that doesn't fit the chat is refused", () => {
		const dir = path.join(TMP, "inline-unit-3");
		makeInlineSession(dir, "chat_i", [a]);
		const slim = pictures.withoutPictures(fs.readFileSync(chatFile(dir, "chat_i"), "utf-8"))!;
		const get = (id: string) => slim.data.get(id) ?? null;
		assert.throws(() => pictures.withPictures(slim.chat, { ...slim.pictures, inline: [[["messages", 0, "content", 0], a.id]] }, get), "a text block, not an emptied image");
		assert.throws(() => pictures.withPictures(slim.chat, { ...slim.pictures, inline: [[["messages", 9, "content", 1], a.id]] }, get));
		assert.throws(() => pictures.withPictures(slim.chat, { ...slim.pictures, inline: [[["__proto__", "x"], a.id]] }, get));
		assert.equal(pictures.checkPictureList({ at: -1, list: [], inline: [[[], a.id]] }), null, "an empty path");
		assert.equal(pictures.checkPictureList({ at: -1, list: [], inline: [[["messages", -1], a.id]] }), null);
		assert.equal(pictures.checkPictureList({ at: -1, list: [], inline: [[["messages", { x: 1 }], a.id]] }), null);
		assert.equal(pictures.checkPictureList({ at: -1, list: [], inline: [[["messages", 0], "not-a-hash"]] }), null);
	});

	it("a session with big pictures inside its messages: each goes once, in pieces, and every send of the session stays small", async () => {
		const w = world();
		const desk = w.desktop("dev_aaaaaaaaaaaaaaaa");
		const laptop = w.desktop("dev_bbbbbbbbbbbbbbbb");
		// About 26 MB of pictures as text: more than one request may carry.
		const big = [block(6_600_000), block(6_600_000), block(6_600_000)];
		makeInlineSession(desk.dataDir, "chat_big", big);
		assert.ok(fs.statSync(chatFile(desk.dataDir, "chat_big")).size > 26_000_000);
		await desk.sync.tick();
		assert.ok(w.sent.every((r) => r.bytes < 9 * 1024 * 1024), `request sizes: ${w.sent.map((r) => r.bytes).join(", ")}`);
		assert.equal(w.sent.filter((r) => r.method === "PUT" && r.path.includes("/pictures/")).length, 6, "three pictures, two pieces each");
		assert.equal(fs.readFileSync(chatFile(w.serverDir, "chat_big"), "utf-8"), fs.readFileSync(chatFile(desk.dataDir, "chat_big"), "utf-8"), "the same file, byte for byte");

		// More turns: the session goes again without its pictures.
		const from = w.sent.length;
		for (let i = 0; i < 3; i++) {
			w.tick();
			const record = readChat(desk.dataDir, "chat_big");
			record.messages.push({ id: `t${i}`, role: "user", content: `turn ${i}`, timestamp: 10 + i });
			writeChat(desk.dataDir, "chat_big", record);
			await desk.sync.tick();
		}
		const sends = w.sent.slice(from).filter((r) => r.method === "PUT");
		assert.deepEqual(sends.map((r) => r.status), [200, 200, 200]);
		assert.ok(sends.every((r) => r.bytes < 5000), `sizes: ${sends.map((r) => r.bytes).join(", ")}`);

		// Down to another desktop: the session small, each picture fetched once.
		const down = w.sent.length;
		await laptop.sync.tick();
		const fetched = w.sent.slice(down).filter((r) => r.by === "dev_bbbbbbbbbbbbbbbb" && r.method === "GET");
		assert.equal(fetched.filter((r) => r.path.includes("/pictures/")).length, 3);
		assert.ok(fetched.find((r) => r.path === "/api/sync/sessions/chat_big")!.bytes < 5000);
		assert.equal(fs.readFileSync(chatFile(laptop.dataDir, "chat_big"), "utf-8"), fs.readFileSync(chatFile(desk.dataDir, "chat_big"), "utf-8"));
	});

	it("a picture already in the record as a snapshot isn't sent again for a message", async () => {
		const w = world();
		const desk = w.desktop("dev_aaaaaaaaaaaaaaaa");
		const raw = randomBytes(30_000);
		const id = createHash("sha256").update(raw).digest("hex");
		const shared = { id, image: { type: "image", mimeType: "image/png", data: raw.toString("base64") } };
		makeInlineSession(desk.dataDir, "chat_shared", [shared], [{ id, snapshot: { mimeType: "image/png", data: raw.toString("base64"), width: 1, height: 1 } }]);
		await desk.sync.tick();
		assert.deepEqual(w.since(0), ["POST  200", "PUT /chat_shared 409", "PUT /chat_shared/pictures/<picture> 200", "PUT /chat_shared 200"]);
		assert.equal(fs.readFileSync(chatFile(w.serverDir, "chat_shared"), "utf-8"), fs.readFileSync(chatFile(desk.dataDir, "chat_shared"), "utf-8"));
	});
});
