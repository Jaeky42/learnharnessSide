/**
 * Multi-account slice 5c: "Download my data". The copy's data folder as one
 * .zip: only the allowed parts, byte for byte, in the folder's own layout;
 * never the sync records, backups, secrets, vault or links; streamed; a file
 * changing under it never breaks the archive. The archive is read back by a
 * reader written here (central directory, inflate, CRC) and by unzip /
 * python's zipfile when they exist.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import v8 from "node:v8";
import vm from "node:vm";
import zlib from "node:zlib";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-export-"));
process.env.LH_DATA_DIR = path.join(TMP, "unused-data");
process.env.LH_AUTH_FILE = path.join(TMP, "unused-secrets", "auth.json");

const { accountExportResponse, exportFileName, listExportFiles, resetExportLock, EXPORT_PARTS } = await import("../src/server/account-export.ts");
const { zipChunks, crc32, isSafeEntryName } = await import("../src/server/zip-writer.ts");
const route = await import("../app/api/account/export/route.ts");

const SECRET = "k3Jq9XvT0pLw8ZrB2mN5sY7dF1gH4cE6aQ-uViOtRe_";
const saved = { mode: process.env.LH_SERVER_MODE, secret: process.env.LH_GATE_SECRET };
const gateOn = () => { process.env.LH_SERVER_MODE = "1"; process.env.LH_GATE_SECRET = SECRET; };
const gateOff = () => { delete process.env.LH_SERVER_MODE; delete process.env.LH_GATE_SECRET; };
after(() => {
	if (saved.mode === undefined) delete process.env.LH_SERVER_MODE; else process.env.LH_SERVER_MODE = saved.mode;
	if (saved.secret === undefined) delete process.env.LH_GATE_SECRET; else process.env.LH_GATE_SECRET = saved.secret;
	fs.rmSync(TMP, { recursive: true, force: true });
});

// ─── An independent reader ───────────────────────────────────────────────────

interface ReadEntry { name: string; data: Buffer; flags: number; method: number }

function readZip(zip: Buffer): ReadEntry[] {
	const end = zip.length - 22;
	assert.equal(zip.readUInt32LE(end), 0x06054b50, "the end record is last");
	const count = zip.readUInt16LE(end + 10);
	const size = zip.readUInt32LE(end + 12);
	const start = zip.readUInt32LE(end + 16);
	assert.equal(start + size, end, "the central directory runs up to the end record");
	const entries: ReadEntry[] = [];
	let at = start;
	for (let i = 0; i < count; i++) {
		assert.equal(zip.readUInt32LE(at), 0x02014b50);
		const flags = zip.readUInt16LE(at + 8);
		const method = zip.readUInt16LE(at + 10);
		const crc = zip.readUInt32LE(at + 16);
		const csize = zip.readUInt32LE(at + 20);
		const usize = zip.readUInt32LE(at + 24);
		const nameLen = zip.readUInt16LE(at + 28);
		const extraLen = zip.readUInt16LE(at + 30);
		const commentLen = zip.readUInt16LE(at + 32);
		const local = zip.readUInt32LE(at + 42);
		const name = zip.subarray(at + 46, at + 46 + nameLen).toString("utf8");
		assert.equal(zip.readUInt32LE(local), 0x04034b50, `${name}: local header`);
		assert.equal(zip.subarray(local + 30, local + 30 + zip.readUInt16LE(local + 26)).toString("utf8"), name);
		const dataAt = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
		const raw = zip.subarray(dataAt, dataAt + csize);
		assert.equal(zip.readUInt32LE(dataAt + csize), 0x08074b50, `${name}: data descriptor`);
		assert.equal(zip.readUInt32LE(dataAt + csize + 4), crc);
		assert.equal(zip.readUInt32LE(dataAt + csize + 8), csize);
		assert.equal(zip.readUInt32LE(dataAt + csize + 12), usize);
		assert.equal(method, 8);
		const data = zlib.inflateRawSync(raw);
		assert.equal(data.length, usize, `${name}: size`);
		assert.equal(zlib.crc32(data), crc, `${name}: crc`);
		entries.push({ name, data, flags, method });
		at += 46 + nameLen + extraLen + commentLen;
	}
	assert.equal(at, end);
	return entries;
}

async function collect(response: Response): Promise<Buffer> {
	return Buffer.from(await response.arrayBuffer());
}

const have = (cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: "ignore" }).status !== null && !spawnSync(cmd, args).error;
function externalCheck(zip: Buffer, dir: string): void {
	const file = path.join(dir, "check.zip");
	fs.writeFileSync(file, zip);
	if (have("unzip", ["-v"])) {
		const r = spawnSync("unzip", ["-t", file], { encoding: "utf8" });
		assert.equal(r.status, 0, `unzip -t: ${r.stdout}${r.stderr}`);
	}
	if (have("python3", ["-I", "-c", "pass"])) {
		const r = spawnSync("python3", ["-I", "-m", "zipfile", "-t", file], { encoding: "utf8" });
		assert.equal(r.status, 0, `python zipfile -t: ${r.stdout}${r.stderr}`);
	}
}

// ─── A data folder with everything in it ─────────────────────────────────────

let n = 0;
let root: string;
let data: string;
const write = (rel: string, body: string | Buffer, base = data) => {
	const full = path.join(base, ...rel.split("/"));
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, body);
	return full;
};

/** Every allowed kind of file, by path. */
const ALLOWED: Record<string, string | Buffer> = {
	"chats/chat_1.json": JSON.stringify({ id: "chat_1", title: "Circuits" }),
	"chats/séssion ✓ naïve.json": "{\"unicode\":true}",
	"chats/with space.json": "{\"space\":true}",
	"graph/nodes.jsonl": "{\"id\":\"n_1\"}\n{\"id\":\"n_2\"}\n",
	"jobs/job_1.json": "{\"chatId\":\"chat_1\"}",
	"settings.json": "{\"version\":1}",
	"prompts/teacher/system.md": "# Prompt\n",
	"themes/mine.json": "{\"id\":\"mine\"}",
	"notes/sessions/chat_1.json": "{\"folder\":\"Physics\"}",
	"plugins-state.json": "{\"enabled\":[\"flashcards\"]}",
	"core-plugin-data/flashcards/flashcards.json": "{\"decks\":[]}",
	"core-plugin-data/other/empty.bin": "",
	"core-plugin-data/other/binary.bin": crypto.randomBytes(5000),
};

/** Things that must never be in the archive. */
function addDecoys(): void {
	write("sync/authority.json", "{\"secret\":1}");
	write("sync/flashcards.json", "{}");
	write("sync/flashcards-memory.json", "{}");
	write("backups/before-first-sync 2026-11-20/chats/x.json", "{}", path.dirname(data));
	write("backups/inside.json", "{}");
	write("notes/settings.json", "{\"vault\":\"/data/vault\"}");
	write("notes/pending/p.json", "{\"pending\":true}");
	write("notes/other.json", "{}");
	write("obsidian-sync.json", "{\"ob\":1}");
	write("side-tutor/old.json", "{}");
	write("auth.json", "{\"apiKey\":\"sk-nope\"}");
	write("server-login.json", "{\"password\":\"hash\"}");
	write("cloud-sync.json", "{\"key\":\"nope\"}");
	write("chats/chat_1.json.tmp-1234", "half written");
	write("subscriptions/claude.json", "{\"token\":\"nope\"}");
	// Siblings of the data folder: the secrets folder, the home folder, the vault.
	write("secrets/auth.json", "{\"apiKey\":\"sk-outside\"}", root);
	write("secrets/server-login.json", "{\"password\":\"hash\"}", root);
	write("home/.claude/credentials.json", "{\"token\":\"nope\"}", root);
	write("vault/LearnHarness/note.md", "private", root);
	// Links that point out of the folder.
	fs.symlinkSync(path.join(root, "secrets", "auth.json"), path.join(data, "chats", "leak.json"));
	fs.symlinkSync(path.join(root, "secrets"), path.join(data, "graph", "leak-dir"));
	fs.symlinkSync(path.join(root, "vault"), path.join(data, "core-plugin-data", "vault-link"));
	fs.symlinkSync(path.join(root, "secrets", "auth.json"), path.join(data, "settings-link.json"));
}

beforeEach(() => {
	n += 1;
	root = path.join(TMP, `case-${n}`);
	data = path.join(root, "data");
	fs.mkdirSync(data, { recursive: true });
	gateOn();
});
afterEach(() => {
	resetExportLock();
	gateOff();
	fs.rmSync(root, { recursive: true, force: true });
});

const request = (name?: string) => new Request(`https://learn.example.com/api/account/export${name === undefined ? "" : `?name=${encodeURIComponent(name)}`}`);

describe("Download my data: the archive", () => {
	it("holds every allowed file, byte for byte, at its data-folder path, and nothing else", async () => {
		for (const [rel, body] of Object.entries(ALLOWED)) write(rel, body);
		addDecoys();
		const response = await accountExportResponse(request("sam"), { dataDir: data, now: new Date(2026, 10, 15, 12) });
		assert.equal(response.status, 200);
		const zip = await collect(response);
		const entries = readZip(zip);
		assert.deepEqual(entries.map((e) => e.name).sort(), Object.keys(ALLOWED).sort());
		for (const entry of entries) assert.ok(entry.data.equals(Buffer.from(ALLOWED[entry.name]!)), `${entry.name} is identical`);
		for (const entry of entries) assert.ok(entry.flags & 0x800, "names are marked UTF-8");
		for (const forbidden of ["sync", "backups", "auth.json", "server-login", "cloud-sync", "notes/settings", "notes/pending", "notes/other", "obsidian", "side-tutor", "subscriptions", ".tmp-", "leak", "vault", "home/", "secrets"]) {
			assert.ok(!entries.some((e) => e.name.includes(forbidden)), `no ${forbidden} in the archive`);
		}
		assert.ok(!zip.includes(Buffer.from("sk-nope")) && !zip.includes(Buffer.from("sk-outside")), "no secret value appears anywhere in the bytes");
		externalCheck(zip, root);
	});

	it("an empty folder set still gives a valid, empty archive", async () => {
		const zip = await collect(await accountExportResponse(request("sam"), { dataDir: data }));
		assert.equal(readZip(zip).length, 0);
		assert.equal(zip.length, 22);
		if (have("python3", ["-I", "-c", "pass"])) {
			fs.writeFileSync(path.join(root, "empty.zip"), zip);
			const r = spawnSync("python3", ["-I", "-c", "import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); assert z.namelist() == []", path.join(root, "empty.zip")]);
			assert.equal(r.status, 0);
		}
	});

	it("only the listed parts: a missing part is skipped and a stray top-level file never goes in", async () => {
		write("chats/a.json", "{}");
		write("README.txt", "stray");
		write("notes/sessions/s.json", "{}");
		const { files } = await listExportFiles(data);
		assert.deepEqual(files.map((f) => f.name), ["chats/a.json", "notes/sessions/s.json"]);
	});

	it("the allow-list is what the first-sync backup keeps, less Flashcards sync's own files", () => {
		const source = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "store", "sync", "backup.ts"), "utf8");
		const parts = source.match(/const PARTS = \[(.*)\];/)![1]!;
		for (const part of EXPORT_PARTS) {
			const expected = part === "notes/sessions" ? 'path.join("notes", "sessions")' : `"${part}"`;
			assert.ok(parts.includes(expected), `${part} is in the backup's list`);
		}
		assert.ok(parts.includes("...FLASHCARDS_SYNC_PARTS"), "the backup's one extra is the Flashcards sync files, which stay out here");
	});

	it("the download headers and the file name", async () => {
		write("chats/a.json", "{}");
		const response = await accountExportResponse(request("sam"), { dataDir: data, now: new Date(2026, 10, 5, 9) });
		assert.equal(response.headers.get("content-type"), "application/zip");
		assert.equal(response.headers.get("content-disposition"), 'attachment; filename="learnharness-sam-2026-11-05.zip"');
		assert.equal(response.headers.get("cache-control"), "no-store");
		await response.arrayBuffer();
	});

	it("the name in the file name only when it has an account name's shape", () => {
		const day = new Date(2026, 10, 15, 12);
		assert.equal(exportFileName("sam", day), "learnharness-sam-2026-11-15.zip");
		assert.equal(exportFileName("a-b-9", day), "learnharness-a-b-9-2026-11-15.zip");
		for (const bad of [null, "", "ab", "x".repeat(21), "../x", 'sam"; x', "sa\nm", "sam.zip", "sa m", "sam/lee", "séb", "a\r\nSet-Cookie: x"]) {
			assert.equal(exportFileName(bad, day), "learnharness-2026-11-15.zip", String(bad));
		}
	});

	it("a hostile name in the query never reaches the header", async () => {
		write("chats/a.json", "{}");
		for (const bad of ["../x", 'sam"\r\nX: y', "x".repeat(30)]) {
			const response = await accountExportResponse(request(bad), { dataDir: data, now: new Date(2026, 10, 15, 12) });
			assert.equal(response.headers.get("content-disposition"), 'attachment; filename="learnharness-2026-11-15.zip"');
			await response.arrayBuffer();
		}
		const missing = await accountExportResponse(request(), { dataDir: data, now: new Date(2026, 10, 15, 12) });
		assert.equal(missing.headers.get("content-disposition"), 'attachment; filename="learnharness-2026-11-15.zip"');
		await missing.arrayBuffer();
	});
});

describe("Download my data: modes and limits", () => {
	it("404 unless the copy stands behind a gateway", async () => {
		write("chats/a.json", "{}");
		gateOff();
		assert.equal((await accountExportResponse(request("sam"), { dataDir: data })).status, 404);
		assert.equal((await route.GET(request("sam"))).status, 404);
		process.env.LH_SERVER_MODE = "1"; // server mode, no gateway: a single-copy server
		assert.equal((await accountExportResponse(request("sam"), { dataDir: data })).status, 404);
		delete process.env.LH_SERVER_MODE;
		process.env.LH_GATE_SECRET = SECRET; // the desktop app ignores the variable
		assert.equal((await accountExportResponse(request("sam"), { dataDir: data })).status, 404);
	});

	it("one export at a time: a second request is refused until the first has ended", async () => {
		write("chats/a.json", "{}");
		const first = await accountExportResponse(request("sam"), { dataDir: data });
		assert.equal(first.status, 200);
		const second = await accountExportResponse(request("sam"), { dataDir: data });
		assert.equal(second.status, 429);
		assert.deepEqual(await second.json(), { error: "Something went wrong. Try again." });
		await first.body!.cancel(); // the browser went away
		assert.equal((await accountExportResponse(request("sam"), { dataDir: data })).status, 200);
	});

	it("413 before streaming when the archive would pass what a plain .zip holds (too many files)", async () => {
		fs.mkdirSync(path.join(data, "chats"), { recursive: true });
		for (let i = 0; i < 65_100; i++) fs.writeFileSync(path.join(data, "chats", `f${i}`), "");
		const response = await accountExportResponse(request("sam"), { dataDir: data });
		assert.equal(response.status, 413);
		// the lock was released
		fs.rmSync(path.join(data, "chats"), { recursive: true });
		write("chats/a.json", "{}");
		assert.equal((await accountExportResponse(request("sam"), { dataDir: data })).status, 200);
	});

	it("413 before streaming when the files add up to more than 3.5 GiB (a sparse file)", async () => {
		const file = write("chats/huge.json", "");
		fs.truncateSync(file, 4 * 1024 ** 3);
		assert.equal((await accountExportResponse(request("sam"), { dataDir: data })).status, 413);
	});
});

describe("Download my data: streaming and changing files", () => {
	it("a large file streams: memory stays far below its size", async () => {
		const file = write("chats/big.jsonl", "");
		const fd = fs.openSync(file, "w");
		const block = crypto.randomBytes(512 * 1024).toString("hex"); // 1 MiB of text that compresses about 2:1
		for (let i = 0; i < 80; i++) fs.writeSync(fd, block.slice(0, 1024 * 1024 - 1) + String.fromCharCode(97 + (i % 26)) + "\n");
		fs.closeSync(fd);
		const size = fs.statSync(file).size;
		assert.ok(size >= 80 * 1024 * 1024);
		const response = await accountExportResponse(request("sam"), { dataDir: data });
		const reader = response.body!.getReader();
		// Measure what the writer RETAINS, not garbage the collector hasn't reached
		// yet: collect before each reading. (Without it the reading depends on the
		// machine's load: 61 MiB on a busy CI runner, with nothing retained.)
		v8.setFlagsFromString("--expose-gc");
		const collect = vm.runInNewContext("gc") as () => void;
		collect();
		const baseline = process.memoryUsage().arrayBuffers;
		let peak = 0;
		let sinceReading = 0;
		// Keep the archive on disk, not in memory, so the check measures the writer.
		const out = path.join(root, "big.zip");
		const handle = fs.openSync(out, "w");
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			fs.writeSync(handle, value);
			sinceReading += value.byteLength;
			if (sinceReading >= 4 * 1024 * 1024) {
				sinceReading = 0;
				collect();
				peak = Math.max(peak, process.memoryUsage().arrayBuffers - baseline);
			}
		}
		fs.closeSync(handle);
		// A writer that kept the file would retain 80 MiB; a streaming one a few buffers.
		assert.ok(peak < 24 * 1024 * 1024, `peak ${(peak / 1048576).toFixed(1)} MiB retained against a ${(size / 1048576).toFixed(0)} MiB file`);
		const zip = fs.readFileSync(out);
		const entries = readZip(zip);
		assert.equal(entries.length, 1);
		assert.ok(entries[0]!.data.equals(fs.readFileSync(file)));
		externalCheck(zip, root);
	});

	it("a file that grows during the export still gives a valid archive", async () => {
		const original = crypto.randomBytes(256 * 1024).toString("hex") + "\n";
		const big = write("chats/aaa-live.jsonl", Buffer.from(original.repeat(40)));
		write("chats/zzz.json", "{\"last\":true}");
		const response = await accountExportResponse(request("sam"), { dataDir: data });
		const reader = response.body!.getReader();
		const parts: Buffer[] = [];
		let got = 0;
		let grown = false;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			parts.push(Buffer.from(value));
			got += value.length;
			if (!grown && got > 300 * 1024) { fs.appendFileSync(big, "appended-while-exporting\n".repeat(4000)); grown = true; }
		}
		assert.ok(grown);
		const zip = Buffer.concat(parts);
		const entries = readZip(zip);
		const live = entries.find((e) => e.name === "chats/aaa-live.jsonl")!;
		assert.ok(live.data.length >= Buffer.byteLength(original.repeat(40)), "what was read is at least what was there");
		assert.ok(live.data.equals(fs.readFileSync(big)), "what the archive holds is what was read, with its own size and CRC");
		assert.ok(entries.some((e) => e.name === "chats/zzz.json"));
		externalCheck(zip, root);
	});

	it("a file that is deleted or truncated after the list was made leaves a valid archive", async () => {
		write("chats/aaa.jsonl", Buffer.from(crypto.randomBytes(200 * 1024).toString("hex")));
		const gone = write("chats/mmm.json", "{\"gone\":true}");
		const cut = write("chats/zzz.json", "{\"long\":\"" + "x".repeat(1000) + "\"}");
		const response = await accountExportResponse(request("sam"), { dataDir: data });
		const reader = response.body!.getReader();
		const first = await reader.read(); // the listing is done, the first file is being read
		assert.ok(!first.done);
		fs.unlinkSync(gone);
		fs.truncateSync(cut, 10);
		const parts: Buffer[] = [Buffer.from(first.value!)];
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			parts.push(Buffer.from(value));
		}
		const zip = Buffer.concat(parts);
		const entries = readZip(zip);
		assert.deepEqual(entries.map((e) => e.name), ["chats/aaa.jsonl", "chats/zzz.json"], "the vanished file is left out");
		assert.equal(entries[1]!.data.length, 10, "the shortened file is what was read");
		externalCheck(zip, root);
	});

	it("a file swapped for a link after the list was made is not followed", async () => {
		write("chats/aaa.jsonl", Buffer.from(crypto.randomBytes(200 * 1024).toString("hex")));
		const swap = write("chats/zzz.json", "{\"mine\":true}");
		write("secrets/auth.json", "{\"apiKey\":\"sk-outside\"}", root);
		const response = await accountExportResponse(request("sam"), { dataDir: data });
		const reader = response.body!.getReader();
		const first = await reader.read();
		fs.unlinkSync(swap);
		fs.symlinkSync(path.join(root, "secrets", "auth.json"), swap);
		const parts: Buffer[] = [Buffer.from(first.value!)];
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			parts.push(Buffer.from(value));
		}
		const zip = Buffer.concat(parts);
		assert.deepEqual(readZip(zip).map((e) => e.name), ["chats/aaa.jsonl"]);
		assert.ok(!zip.includes(Buffer.from("sk-outside")));
	});

	it("cancelling the download closes every file", async () => {
		write("chats/aaa.jsonl", Buffer.from(crypto.randomBytes(4 * 1024 * 1024).toString("hex")));
		const response = await accountExportResponse(request("sam"), { dataDir: data });
		const reader = response.body!.getReader();
		await reader.read();
		await reader.cancel();
		// the lock is free again at once
		assert.equal((await accountExportResponse(request("sam"), { dataDir: data })).status, 200);
	});
});

describe("zip writer", () => {
	it("crc32 continues across pieces like zlib's", () => {
		const a = crypto.randomBytes(1000);
		const b = crypto.randomBytes(777);
		assert.equal(crc32(b, crc32(a, 0)), zlib.crc32(Buffer.concat([a, b])));
	});

	it("names with unicode, spaces and slashes come back as given; an empty file is fine", async () => {
		const file = path.join(root, "x.txt");
		fs.writeFileSync(file, "hello");
		const empty = path.join(root, "e.txt");
		fs.writeFileSync(empty, "");
		const parts: Buffer[] = [];
		for await (const chunk of zipChunks([{ name: "dir/é ü ✓/x y.txt", path: file }, { name: "e.txt", path: empty }, { name: "missing.txt", path: path.join(root, "nope") }])) parts.push(Buffer.from(chunk));
		const entries = readZip(Buffer.concat(parts));
		assert.deepEqual(entries.map((e) => [e.name, e.data.toString()]), [["dir/é ü ✓/x y.txt", "hello"], ["e.txt", ""]]);
	});
});

describe("entry names are safe to unzip anywhere", () => {
	const BAD = [
		"back\\slash.json", "colon:name.json", "lt<name.json", "gt>name.json", 'quote".json', "pipe|name.json", "what?.json", "star*.json",
		"new\nline.json", "tab\tname.json", "del\u007f.json", "trailing-dot.", "trailing-space ", "CON", "con.json", "Aux.txt", "nul", "COM1.json", "lpt9.x.y", "PRN",
	];

	it("the rule, class by class; good unicode names and spaces pass", () => {
		for (const name of ["chats/chat_1.json", "chats/séssion ✓ naïve.json", "chats/with space.json", "a/b/c.d", "chats/console.json", "chats/COM10.json", "chats/.hidden", "chats/日本語.json"]) assert.ok(isSafeEntryName(name), name);
		for (const name of [...BAD.map((b) => `chats/${b}`), "", "/abs.json", "C:/x.json", "chats/../x", "../x", "chats/./x", "chats//x", "chats/x/", ".", "..", "a\\b/c", "chats/\ud800.json", "x".repeat(256)]) assert.ok(!isSafeEntryName(name), JSON.stringify(name));
	});

	it("bad names in the data folder are skipped with their subtrees, never renamed; a note says how many", async () => {
		write("chats/good é.json", "{}");
		let skipped = 0;
		for (const bad of BAD) {
			try { write(`chats/${bad}`, "planted"); skipped += 1; } catch { /* the file system refused the name */ }
			try { write(`graph/${bad}/inside.json`, "planted"); skipped += 1; } catch { /* the same */ }
		}
		assert.ok(skipped > 20);
		write("graph/fine.jsonl", "{}");
		const zip = await collect(await accountExportResponse(request("sam"), { dataDir: data }));
		const entries = readZip(zip);
		const names = entries.map((e) => e.name).sort();
		assert.deepEqual(names, ["chats/good é.json", "graph/fine.jsonl", "skipped-files.txt"]);
		const note = entries.find((e) => e.name === "skipped-files.txt")!.data.toString();
		assert.match(note, new RegExp(`^${skipped} files or folders were left out`));
		assert.ok(!note.includes("planted") && !note.includes("slash") && !note.includes("CON"), "the note never names them");
		assert.ok(!zip.includes(Buffer.from("planted")));
		externalCheck(zip, root);
	});

	it("no skipped-files.txt when nothing was skipped", async () => {
		write("chats/a.json", "{}");
		const entries = readZip(await collect(await accountExportResponse(request("sam"), { dataDir: data })));
		assert.deepEqual(entries.map((e) => e.name), ["chats/a.json"]);
	});

	it("the writer itself refuses names it is handed (leading slash, .., drive letter), and counts them", async () => {
		const file = path.join(root, "x.txt");
		fs.writeFileSync(file, "hello");
		const parts: Buffer[] = [];
		for await (const chunk of zipChunks([{ name: "ok.txt", path: file }, { name: "/abs.txt", path: file }, { name: "a/../../escape.txt", path: file }, { name: "C:/win.txt", path: file }])) parts.push(Buffer.from(chunk));
		const zip = Buffer.concat(parts);
		const entries = readZip(zip);
		assert.deepEqual(entries.map((e) => e.name), ["ok.txt", "skipped-files.txt"]);
		assert.match(entries[1]!.data.toString(), /^3 files or folders were left out/);
		externalCheck(zip, root);
	});

	it("a folder swapped for a link out of the data folder after the list was made is not followed", async () => {
		write("chats/aaa.jsonl", Buffer.from(crypto.randomBytes(200 * 1024).toString("hex")));
		write("graph/g.jsonl", "{\"mine\":true}");
		write("outside/g.jsonl", "{\"outside\":true}", root);
		const response = await accountExportResponse(request("sam"), { dataDir: data });
		const reader = response.body!.getReader();
		const first = await reader.read();
		fs.rmSync(path.join(data, "graph"), { recursive: true });
		fs.symlinkSync(path.join(root, "outside"), path.join(data, "graph"));
		const parts: Buffer[] = [Buffer.from(first.value!)];
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			parts.push(Buffer.from(value));
		}
		const zip = Buffer.concat(parts);
		assert.deepEqual(readZip(zip).map((e) => e.name), ["chats/aaa.jsonl"]);
		assert.ok(!zip.includes(Buffer.from("outside")));
	});
});
