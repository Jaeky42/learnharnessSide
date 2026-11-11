/**
 * Cloud sync Phase 4 (side-tutor fork; docs/cloud-sync.md): the Obsidian
 * vault on the cloud server.
 *
 *  - The rules and wording (src/core/obsidian-sync.ts), checked against what
 *    obsidian-headless 0.0.14 really prints.
 *  - The record and vault files (src/store/obsidian-sync.ts).
 *  - The routes: 404 outside server mode, the app's own header, no secrets
 *    echoed back.
 *  - The sync manager driving the REAL `ob` program end to end, with a
 *    stand-in for Obsidian's servers loaded into it
 *    (tests/fixtures/obsidian-fake/preload.cjs): sign-in over its input,
 *    vault setup, the first download, folders left out as they appear,
 *    uploads, a crash, an expired sign-in, the safety check, Disconnect.
 *
 * The end-to-end part needs the real program. Point LH_TEST_OB_CLI at its
 * cli.js (the server-image workflow installs the pinned version for this);
 * without it those tests are skipped.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { isSensitivePath } from "../src/agent/tools/fs-shared.ts";
import {
	OB_DEVICE_NAME,
	OB_VERSION,
	OBSIDIAN_SYNC_LABEL,
	OBSIDIAN_TEXT,
	checkSignInInput,
	checkVaultPassword,
	connectOutcome,
	excludedFoldersArgument,
	folderToLeaveOut,
	foldersToLeaveOut,
	parseObLine,
	parseVaultList,
	restartDelayMs,
	signInOutcome,
	syncIsRunning,
	topLevelCandidate,
	validVaultId,
	vaultLooksEmptied,
} from "../src/core/obsidian-sync.ts";
import { createObsidianSync, type ObsidianSyncDeps } from "../src/server/obsidian-sync.ts";
import { obsidianControlResponse, obsidianStatusResponse } from "../src/server/obsidian-sync-http.ts";
import { notesActionResponse } from "../src/server/notes.ts";
import { EMPTY_OBSIDIAN_RECORD, obConfigDir, obsidianSyncFiles } from "../src/store/obsidian-sync.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-obsidian-sync-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, what: string, ms = 20_000) {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await sleep(25);
	}
}

describe("Obsidian sync rules", () => {
	it("reads what ob 0.0.14 prints while syncing", () => {
		assert.deepEqual(parseObLine("Downloading LearnHarness/Inbox/Electricity.md"), { kind: "downloading", path: "LearnHarness/Inbox/Electricity.md" });
		assert.deepEqual(parseObLine("Downloaded Projects, old\r"), { kind: "downloaded", path: "Projects, old" });
		assert.deepEqual(parseObLine("Fully synced"), { kind: "synced" });
		assert.deepEqual(parseObLine("Connecting..."), { kind: "connecting" });
		assert.deepEqual(parseObLine("Connection successful. Detecting changes..."), { kind: "connected" });
		for (const line of ["Accepted Welcome.md", "Uploading file LearnHarness/New.md", "Upload complete LearnHarness/New.md", "Deleting LearnHarness/Old.md", "Merging conflicted file LearnHarness/A.md"]) {
			assert.equal(parseObLine(line).kind, "working", line);
		}
		for (const line of ["Error: Unable to connect to server.", "Error: The connection to the server has encountered an error.", "Disconnected from server", "Waiting to connect to server", "Error: Disconnected. Code: 1001 going away"]) {
			assert.equal(parseObLine(line).kind, "offline", line);
		}
		assert.equal(parseObLine("Error: Failed to authenticate: Not logged in").kind, "auth");
		// The subscription and missing-vault messages arrive inside the same error.
		assert.equal(parseObLine("Error: Failed to authenticate: Your subscription to Obsidian Sync has expired").kind, "subscription");
		assert.equal(parseObLine("The connected remote vault no longer exists.").kind, "vault-gone");
		assert.equal(parseObLine("Another sync instance is already running for this vault.").kind, "locked");
		assert.equal(parseObLine("  Vault: Obsidian Vault (vault1)").kind, "other");
		assert.equal(parseObLine("").kind, "other");
	});

	it("leaves out every top-level folder except LearnHarness", () => {
		assert.equal(folderToLeaveOut("Journal/2026-11-10.md", []), "Journal");
		assert.equal(folderToLeaveOut("Journal/deep/er/x.md", ["Work"]), "Journal");
		assert.equal(folderToLeaveOut("LearnHarness/Inbox/Electricity.md", []), null, "the notes folder is kept");
		assert.equal(folderToLeaveOut("Welcome.md", []), null, "a loose top-level file");
		assert.equal(folderToLeaveOut("Journal/x.md", ["Journal"]), null, "already left out");
		assert.equal(folderToLeaveOut(".obsidian/app.json", []), null, "ob never syncs dot-folders itself");
		assert.equal(folderToLeaveOut("learnharness/x.md", []), "learnharness", "only the exact folder name is kept");

		assert.equal(topLevelCandidate("Untitled", []), "Untitled");
		assert.equal(topLevelCandidate("Untitled", ["Untitled"]), null);
		assert.equal(topLevelCandidate("LearnHarness", []), null);
		assert.equal(topLevelCandidate("Untitled/Note.md", []), null);

		assert.deepEqual(foldersToLeaveOut(["LearnHarness", ".obsidian", "Untitled", "Journal"], ["Journal"]), ["Untitled"]);
	});

	it("knows which folder names ob's command can take", () => {
		assert.equal(excludedFoldersArgument(["Journal", "Work stuff"]), "Journal,Work stuff");
		assert.equal(excludedFoldersArgument([]), "");
		assert.equal(excludedFoldersArgument(["Projects, old"]), null, "ob splits the value on commas");
		assert.equal(excludedFoldersArgument([" Padded"]), null, "ob trims each entry");
	});

	it("trips the safety check when the notes are missing, gone or more than half gone", () => {
		assert.equal(vaultLooksEmptied(0, 0), false, "nothing was ever there");
		assert.equal(vaultLooksEmptied(42, 42), false);
		assert.equal(vaultLooksEmptied(42, 21), false, "exactly half is not more than half");
		assert.equal(vaultLooksEmptied(42, 20), true);
		assert.equal(vaultLooksEmptied(42, 0), true);
		assert.equal(vaultLooksEmptied(1, 0), true);
		assert.equal(vaultLooksEmptied(1, 1), false);
		assert.equal(vaultLooksEmptied(3, 5), false, "more notes than before");
	});

	it("waits 5 seconds, doubling, at most 5 minutes between restarts", () => {
		assert.deepEqual([1, 2, 3, 4, 7, 50].map((n) => restartDelayMs(n)), [5_000, 10_000, 20_000, 40_000, 300_000, 300_000]);
	});

	it("checks what the forms send", () => {
		assert.deepEqual(checkSignInInput(" me@example.com ", " pass word ", "123 456"), { email: "me@example.com", password: " pass word ", code: "123456" });
		assert.ok("error" in checkSignInInput("", "x", ""));
		assert.ok("error" in checkSignInInput("not-an-email", "x", ""));
		assert.ok("error" in checkSignInInput("--password@x.y", "x", ""), "never an option for ob's command line");
		assert.ok("error" in checkSignInInput("me@example.com", "", ""));
		assert.ok("error" in checkSignInInput("me@example.com", "two\nlines", ""));
		assert.deepEqual(checkSignInInput("me@example.com", "x", "12ab"), { error: OBSIDIAN_TEXT.twoStepWrong });
		assert.equal(validVaultId("0f3a9c2e"), true);
		assert.equal(validVaultId("--path"), false);
		assert.equal(validVaultId("My Vault"), false, "an id, never a name");
		assert.equal(validVaultId(7), false);
		assert.equal(checkVaultPassword(undefined), "", "a standard vault has none");
		assert.equal(checkVaultPassword("a b"), "a b");
		assert.equal(checkVaultPassword("x\0y"), null);
	});

	it("turns ob's sign-in results into the approved messages", () => {
		assert.deepEqual(signInOutcome(0, "Logged in as Test Learner (learner@example.invalid)\n", false), { ok: true, account: { name: "Test Learner", email: "learner@example.invalid" } });
		// ob exits 0 and prints nothing when it wanted a code it couldn't ask for.
		assert.deepEqual(signInOutcome(0, "", false), { ok: false, error: OBSIDIAN_TEXT.twoStepNeeded, detail: null });
		assert.deepEqual(signInOutcome(0, "", true), { ok: false, error: OBSIDIAN_TEXT.twoStepWrong, detail: null });
		const wrongCode = "Login failed: s [Error]: Your 2FA code is incorrect.\n    at z (cli.js:141:832) {\n  response: { error: 'Your 2FA code is incorrect.' },\n  error: 'Your 2FA code is incorrect.'\n}\n";
		assert.deepEqual(signInOutcome(2, wrongCode, true), { ok: false, error: OBSIDIAN_TEXT.twoStepWrong, detail: null });
		const refused = "Login failed: s [Error]: Login failed, please double check your email and password.\n    at z (cli.js:141:832) {\n  error: 'Login failed, please double check your email and password.'\n}\n";
		assert.deepEqual(signInOutcome(2, refused, false), { ok: false, error: OBSIDIAN_TEXT.wrongCredentials, detail: "Login failed, please double check your email and password." });
		assert.deepEqual(signInOutcome(2, "Login failed: TypeError: fetch failed\n    at node:internal/deps/undici/undici:1:1\n", false), { ok: false, error: OBSIDIAN_TEXT.unreachable, detail: null });
		assert.deepEqual(signInOutcome(null, "", false), { ok: false, error: OBSIDIAN_TEXT.wrongCredentials, detail: null });
	});

	it("turns ob's vault setup results into the approved messages", () => {
		assert.deepEqual(connectOutcome(0, "Fetching vault info...\nSetting up...\n\nVault configured successfully!\n"), { ok: true });
		assert.deepEqual(connectOutcome(2, "Fetching vault info...\nPassword not provided.\n"), { ok: false, error: OBSIDIAN_TEXT.vaultPasswordNeeded });
		assert.deepEqual(connectOutcome(2, "Failed to validate password. s [Error]: Vault password is incorrect\n  error: 'Vault password is incorrect'\n"), { ok: false, error: OBSIDIAN_TEXT.wrongVaultPassword });
		assert.deepEqual(connectOutcome(1, "Setup failed: TypeError: fetch failed\n"), { ok: false, error: OBSIDIAN_TEXT.unreachable });
		assert.equal(connectOutcome(2, 'No account logged in. Run "ob login" first.\n').ok, false);
	});

	it("lists own and shared vaults by id", () => {
		const listed = parseVaultList(JSON.stringify({ vaults: [{ id: "vault1", name: "Obsidian Vault", region: "test" }, { id: "bad id", name: "x" }], shared: [{ id: "shared9", name: "Team" }] }));
		assert.deepEqual(listed, [{ id: "vault1", name: "Obsidian Vault" }, { id: "shared9", name: "Team" }]);
		assert.equal(parseVaultList("Fetching vaults..."), null);
	});

	it("pins the approved wording and the installed version", () => {
		assert.equal(OB_DEVICE_NAME, "LearnHarness server");
		assert.equal(OBSIDIAN_SYNC_LABEL["first-sync"], "Downloading your notes…");
		assert.equal(OBSIDIAN_SYNC_LABEL["up-to-date"], "Up to date");
		assert.equal(OBSIDIAN_SYNC_LABEL.offline, "Can't reach Obsidian. Trying again.");
		assert.equal(OBSIDIAN_TEXT.wrongCredentials, "Obsidian didn't accept that email and password.");
		assert.equal(OBSIDIAN_TEXT.unsynced, "Some changes made here haven't reached Obsidian yet. Disconnecting now loses them.");
		assert.equal(syncIsRunning("syncing"), true);
		assert.equal(syncIsRunning("paused"), false);
		assert.equal(syncIsRunning("offline"), false);
		// The container installs exactly the version the manager was tested with.
		const entrypoint = fs.readFileSync(path.join(ROOT, "deploy", "docker-entrypoint.sh"), "utf8");
		assert.match(entrypoint, new RegExp(`OB_VERSION="?${OB_VERSION.replaceAll(".", "\\.")}"?`));
	});
});

describe("Obsidian sync files", () => {
	it("keeps the record, and reads a damaged one as empty", () => {
		const file = path.join(TMP, "record", "obsidian-sync.json");
		assert.deepEqual(obsidianSyncFiles.readRecord(file), EMPTY_OBSIDIAN_RECORD);
		obsidianSyncFiles.writeRecord({ notesSeen: 42, firstSyncDone: true, lastSyncedAt: 1_800_000_000_000, connectedAt: 1_799_000_000_000 }, file);
		assert.deepEqual(obsidianSyncFiles.readRecord(file), { notesSeen: 42, firstSyncDone: true, lastSyncedAt: 1_800_000_000_000, connectedAt: 1_799_000_000_000 });
		fs.writeFileSync(file, "{ not json");
		assert.deepEqual(obsidianSyncFiles.readRecord(file), EMPTY_OBSIDIAN_RECORD);
	});

	it("counts notes, finds folders and empties the vault folder", () => {
		const vault = path.join(TMP, "files-vault");
		fs.mkdirSync(path.join(vault, "LearnHarness", "Inbox"), { recursive: true });
		fs.mkdirSync(path.join(vault, "LearnHarness", "attachments"), { recursive: true });
		fs.mkdirSync(path.join(vault, "Untitled"), { recursive: true });
		fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
		fs.writeFileSync(path.join(vault, "LearnHarness", "Calculus.md"), "# c");
		fs.writeFileSync(path.join(vault, "LearnHarness", "Inbox", "Electricity.md"), "# e");
		fs.writeFileSync(path.join(vault, "LearnHarness", "attachments", "Pasted image 1.png"), "png");
		fs.writeFileSync(path.join(vault, "Untitled", "Diary.md"), "outside the notes folder");
		fs.writeFileSync(path.join(vault, "Welcome.md"), "loose");
		assert.equal(obsidianSyncFiles.countNotes(vault), 2, "only notes under LearnHarness count");
		assert.deepEqual(obsidianSyncFiles.topLevelFolders(vault).sort(), [".obsidian", "LearnHarness", "Untitled"]);
		assert.equal(obsidianSyncFiles.isFolder(vault, "Untitled"), true);
		assert.equal(obsidianSyncFiles.isFolder(vault, "Welcome.md"), false);
		const stamp = new Date("2030-01-01T00:00:00Z");
		fs.utimesSync(path.join(vault, "LearnHarness", "attachments", "Pasted image 1.png"), stamp, stamp);
		assert.equal(obsidianSyncFiles.newestChange(vault), stamp.getTime(), "pictures count as changes too");
		assert.equal(obsidianSyncFiles.countNotes(path.join(TMP, "no-such-vault")), 0);
		obsidianSyncFiles.emptyVault(vault);
		assert.deepEqual(fs.readdirSync(vault), [], "the folder itself stays");
	});

	it("writes excluded folders into ob's own settings only for the right vault", () => {
		const config = path.join(TMP, "ob-config");
		const file = path.join(config, "sync", "vault1", "config.json");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify({ vaultId: "vault1", vaultName: "V", encryptionKey: "keep-me", conflictStrategy: "merge" }));
		assert.equal(obsidianSyncFiles.writeExcludedFolders(config, "vault1", ["Projects, old", "Untitled"]), true);
		const written = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
		assert.deepEqual(written.ignoreFolders, ["Projects, old", "Untitled"]);
		assert.equal(written.encryptionKey, "keep-me", "nothing else changes");
		assert.equal(obsidianSyncFiles.writeExcludedFolders(config, "../vault1", []), false);
		assert.equal(obsidianSyncFiles.writeExcludedFolders(config, "missing", ["x"]), false);
	});

	it("finds ob's folder by ob's own rule, and the file tools refuse it", () => {
		assert.equal(obConfigDir({ XDG_CONFIG_HOME: "/x/cfg" }, "/home/u", "linux"), path.join("/x/cfg", "obsidian-headless"));
		assert.equal(obConfigDir({}, "/home/u", "linux"), path.join("/home/u", ".config", "obsidian-headless"));
		assert.equal(obConfigDir({}, "/Users/u", "darwin"), path.join("/Users/u", ".obsidian-headless"));
		for (const home of ["/data/home", "/Users/u"]) {
			assert.equal(isSensitivePath(path.join(home, ".config", "obsidian-headless", "auth_token"), home), true);
			assert.equal(isSensitivePath(path.join(home, ".config", "obsidian-headless", "sync", "vault1", "config.json"), home), true);
			assert.equal(isSensitivePath(path.join(home, ".obsidian-headless", "auth_token"), home), true);
		}
	});
});

describe("Obsidian sync routes", () => {
	const app = { "x-learnharness-obsidian": "1", "content-type": "application/json" };
	const post = (body: unknown, headers: Record<string, string> = app) => obsidianControlResponse(new Request("http://localhost/api/obsidian", { method: "POST", headers, body: JSON.stringify(body) }));

	it("answer 404 outside server mode", async () => {
		const before = process.env.LH_SERVER_MODE;
		delete process.env.LH_SERVER_MODE;
		try {
			assert.equal(obsidianStatusResponse(new Request("http://localhost/api/obsidian", { headers: app })).status, 404);
			assert.equal((await post({ op: "sign-in", email: "me@example.com", password: "x" })).status, 404);
		} finally {
			if (before !== undefined) process.env.LH_SERVER_MODE = before;
		}
	});

	it("need the app's own header and a JSON body", async () => {
		const before = process.env.LH_SERVER_MODE;
		process.env.LH_SERVER_MODE = "1";
		try {
			assert.equal(obsidianStatusResponse(new Request("http://localhost/api/obsidian")).status, 403);
			assert.equal(obsidianStatusResponse(new Request("http://localhost/api/obsidian", { headers: { ...app, "sec-fetch-site": "cross-site" } })).status, 403);
			assert.equal((await post({ op: "retry" }, { "content-type": "application/json" })).status, 403);
			assert.equal((await post({ op: "retry" }, { "x-learnharness-obsidian": "1", "content-type": "text/plain" })).status, 415);
			const unsupported = await post({ op: "format-disk" });
			assert.equal(unsupported.status, 400);
			const bad = await post({ op: "sign-in", email: "not an email", password: "hunter2-secret" });
			assert.equal(bad.status, 400);
			assert.equal((await bad.text()).includes("hunter2-secret"), false, "a password is never echoed back");
			assert.equal(bad.headers.get("cache-control"), "no-store");
		} finally {
			if (before === undefined) delete process.env.LH_SERVER_MODE; else process.env.LH_SERVER_MODE = before;
		}
	});
});

describe("notes routes on the cloud server", () => {
	it("refuse to point the notes drawer at a typed folder path", async () => {
		const before = process.env.LH_SERVER_MODE;
		process.env.LH_SERVER_MODE = "1";
		try {
			const res = await notesActionResponse(new Request("http://localhost/api/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "vault", path: os.tmpdir() }) }));
			assert.equal(res.status, 403);
			assert.deepEqual(await res.json(), { error: "Connect your Obsidian vault in Settings." });
		} finally {
			if (before === undefined) delete process.env.LH_SERVER_MODE; else process.env.LH_SERVER_MODE = before;
		}
	});
});

// ─── The manager with the real ob program ────────────────────────────────────

const OB_CLI = process.env.LH_TEST_OB_CLI ?? "";
const realOb = OB_CLI && fs.existsSync(OB_CLI) ? OB_CLI : null;
const PRELOAD = path.join(ROOT, "tests", "fixtures", "obsidian-fake", "preload.cjs");

interface RemoteRecord { uid: number; path: string; folder: boolean; deleted: boolean; hash: string; size: number; ctime: number; mtime: number; device: string; data: string }
interface Remote {
	account: { email: string; password: string; name: string; twoStep: string };
	tokens: string[];
	vaults: { id: string; name: string; password: string; salt: string; standard: boolean }[];
	version: number;
	records: RemoteRecord[];
	offline: boolean;
	initError: string;
	pullDelayMs: number;
}

/** One isolated "server": its own ob folder, vault folder, record and remote. */
function world(name: string) {
	const dir = path.join(TMP, name);
	const remoteFile = path.join(dir, "remote.json");
	const vaultDir = path.join(dir, "vault");
	const xdg = path.join(dir, "xdg");
	const recordFile = path.join(dir, "data", "obsidian-sync.json");
	fs.mkdirSync(dir, { recursive: true });

	const readRemote = (): Remote => JSON.parse(fs.readFileSync(remoteFile, "utf8")) as Remote;
	const writeRemote = (remote: Remote) => {
		const tmp = `${remoteFile}.test.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(remote, null, 1));
		fs.renameSync(tmp, remoteFile);
	};
	/** Another device changes the vault. null text = a folder. */
	const addRemote = (...entries: [string, string | null][]) => {
		const remote = fs.existsSync(remoteFile) ? readRemote() : {
			account: { email: "learner@example.invalid", password: "right password", name: "Test Learner", twoStep: "" },
			tokens: [], vaults: [{ id: "vault1", name: "Obsidian Vault", password: "vault password", salt: "saltsalt", standard: false }],
			version: 0, records: [], offline: false, initError: "", pullDelayMs: 15,
		};
		for (const [file, text] of entries) {
			const data = text === null ? null : Buffer.from(text, "utf8");
			remote.version += 1;
			remote.records.push({
				uid: remote.version, path: file, folder: data === null, deleted: false,
				hash: data ? createHash("sha256").update(data).digest("hex") : "", size: data?.length ?? 0,
				ctime: 1_760_000_000_000 + remote.version, mtime: 1_760_000_000_000 + remote.version, device: "My-PC", data: data?.toString("base64") ?? "",
			});
		}
		writeRemote(remote);
	};
	const editRemote = (change: (remote: Remote) => void) => { const remote = readRemote(); change(remote); writeRemote(remote); };

	const spawned: string[][] = [];
	const notesPointer: { dir: string | null } = { dir: null };
	const flags = { installed: true, crash: false };
	const log: string[] = [];
	const deps: ObsidianSyncDeps = {
		binary: () => (flags.installed ? realOb : null),
		spawn: (binary, args) => {
			spawned.push(args);
			const env = { ...process.env, LH_FAKE_OBSIDIAN: remoteFile, XDG_CONFIG_HOME: xdg, HOME: dir };
			if (flags.crash && args[0] === "sync") return spawn(process.execPath, ["-e", "process.exit(1)"], { stdio: "pipe" }) as ChildProcessWithoutNullStreams;
			return spawn(process.execPath, ["--require", PRELOAD, binary, ...args], { env, stdio: "pipe" }) as ChildProcessWithoutNullStreams;
		},
		vaultDir,
		configDir: path.join(xdg, "obsidian-headless"),
		files: { ...obsidianSyncFiles, readRecord: () => obsidianSyncFiles.readRecord(recordFile), writeRecord: (record) => obsidianSyncFiles.writeRecord(record, recordFile) },
		notes: { setVault: (target) => { notesPointer.dir = target; }, clearVault: () => { notesPointer.dir = null; } },
		now: Date.now,
		log: (message) => { log.push(message); },
		timing: { restartBaseMs: 80, restartMaxMs: 400, scanMs: 150, commandMs: 30_000, stopMs: 8_000, installPollMs: 80, lockMs: 5_200, offlineGraceMs: 300 },
	};
	const inVault = (...parts: string[]) => path.join(vaultDir, ...parts);
	return { dir, vaultDir, xdg, deps, spawned, notesPointer, flags, log, addRemote, editRemote, readRemote, inVault };
}

const SEED: [string, string | null][] = [
	["LearnHarness", null],
	["LearnHarness/Inbox", null],
	["LearnHarness/Inbox/Electricity.md", "# Electricity\n\nNotes about circuits.\n"],
	["Untitled", null],
	["Untitled/Private diary.md", "nobody's business\n"],
	["Untitled/Second.md", "two\n"],
	["Projects, old", null],
	["Projects, old/Plan.md", "plan\n"],
	["Welcome.md", "This is your new vault.\n"],
	["Pasted image 20261110191934.png", "PNGDATA"],
	["LearnHarness/Calculus.md", "# Calculus\n"],
];

describe("Obsidian sync manager with the real ob program", { skip: realOb ? false : "set LH_TEST_OB_CLI to obsidian-headless's cli.js" }, () => {
	const managers: ReturnType<typeof createObsidianSync>[] = [];
	const start = (w: ReturnType<typeof world>) => { const m = createObsidianSync(w.deps); managers.push(m); return m; };
	after(async () => { for (const m of managers) await m.shutdown(); });

	it("waits while ob is still being installed", async () => {
		const w = world("installing");
		w.addRemote(...SEED);
		w.flags.installed = false;
		const m = start(w);
		await m.boot();
		assert.equal(m.view().phase, "installing");
		assert.deepEqual(await m.signIn("learner@example.invalid", "right password", ""), { ok: false, error: OBSIDIAN_TEXT.installing });
		w.flags.installed = true;
		await until(() => m.view().phase === "signed-out", "ob to be noticed");
	});

	it("signs in over ob's input, with and without a two-step code", async () => {
		const w = world("sign-in");
		w.addRemote(...SEED);
		const m = start(w);
		await m.boot();
		assert.equal(m.view().phase, "signed-out");

		const wrong = await m.signIn("learner@example.invalid", "wrong password", "");
		assert.deepEqual(wrong, { ok: false, error: OBSIDIAN_TEXT.wrongCredentials, detail: "Login failed, please double check your email and password." });
		assert.equal(m.view().phase, "signed-out");

		w.editRemote((r) => { r.account.twoStep = "246810"; });
		assert.deepEqual(await m.signIn("learner@example.invalid", "right password", ""), { ok: false, error: OBSIDIAN_TEXT.twoStepNeeded, detail: null });
		assert.deepEqual(await m.signIn("learner@example.invalid", "right password", "000000"), { ok: false, error: OBSIDIAN_TEXT.twoStepWrong, detail: null });
		assert.deepEqual(await m.signIn("learner@example.invalid", "right password", "246 810"), { ok: true });
		assert.deepEqual(m.view().account, { name: "Test Learner", email: "learner@example.invalid" });
		assert.equal(m.view().phase, "signed-in");

		// The password reached ob only through its input.
		const everything = JSON.stringify(w.spawned) + w.log.join("\n");
		assert.equal(everything.includes("right password"), false);
		assert.equal(everything.includes("wrong password"), false);
		assert.ok(w.spawned.some((args) => args[0] === "login" && args.includes("--mfa") && args.includes("246810")));
		// ob keeps a token; no password is on disk anywhere in its folder.
		const stored = fs.readdirSync(path.join(w.xdg, "obsidian-headless"), { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => fs.readFileSync(path.join(e.parentPath, e.name), "utf8")).join("\n");
		assert.equal(stored.includes("right password"), false);
		assert.equal((fs.statSync(path.join(w.xdg, "obsidian-headless", "auth_token")).mode & 0o077), 0, "only its owner can read the token");

		assert.deepEqual(await m.vaults(), { ok: true, vaults: [{ id: "vault1", name: "Obsidian Vault" }] });
		assert.deepEqual(await m.signOut(), { ok: true });
		assert.equal(m.view().phase, "signed-out");
		assert.equal((await m.vaults()).ok, false);
	});

	it("says so when the account has no vaults or Obsidian can't be reached", async () => {
		const w = world("no-vaults");
		w.addRemote(...SEED);
		w.editRemote((r) => { r.vaults = []; });
		const m = start(w);
		await m.boot();
		assert.deepEqual(await m.signIn("learner@example.invalid", "right password", ""), { ok: true });
		assert.deepEqual(await m.vaults(), { ok: false, error: OBSIDIAN_TEXT.noVaults });
		w.editRemote((r) => { r.offline = true; });
		assert.deepEqual(await m.vaults(), { ok: false, error: OBSIDIAN_TEXT.unreachable });
		assert.equal(m.view().phase, "signed-in", "an unreachable Obsidian doesn't sign you out");
		await m.signOut();
		assert.deepEqual(await m.signIn("learner@example.invalid", "right password", ""), { ok: false, error: OBSIDIAN_TEXT.unreachable, detail: null });
	});

	it("connects, downloads only LearnHarness and loose files, and keeps syncing", async () => {
		const w = world("connect");
		w.addRemote(...SEED);
		const m = start(w);
		await m.boot();
		await m.signIn("learner@example.invalid", "right password", "");

		assert.deepEqual(await m.connect("vault1", ""), { ok: false, error: OBSIDIAN_TEXT.vaultPasswordNeeded });
		assert.deepEqual(await m.connect("vault1", "not it"), { ok: false, error: OBSIDIAN_TEXT.wrongVaultPassword });
		assert.equal(m.view().phase, "signed-in");
		assert.equal(w.notesPointer.dir, null);

		assert.deepEqual(await m.connect("vault1", "vault password"), { ok: true });
		assert.equal(m.view().phase, "connected");
		assert.deepEqual(m.view().vault, { id: "vault1", name: "Obsidian Vault" });
		assert.equal(w.notesPointer.dir, w.vaultDir, "the notes drawer is pointed at the vault folder");
		assert.equal(JSON.stringify(w.spawned).includes("vault password"), false, "the vault password went through ob's input");

		await until(() => m.view().sync === "up-to-date", "the first download");
		const view = m.view();
		assert.deepEqual([...view.leftOut].sort(), ["Projects, old", "Untitled"], "a name with a comma is left out too");
		assert.ok(view.lastSyncedAt);
		assert.equal(view.unsynced, false);
		assert.equal(m.notesSync(), "ok");

		// The notes folder and the loose top-level files are there…
		assert.equal(fs.readFileSync(w.inVault("LearnHarness", "Inbox", "Electricity.md"), "utf8"), "# Electricity\n\nNotes about circuits.\n");
		assert.equal(fs.readFileSync(w.inVault("LearnHarness", "Calculus.md"), "utf8"), "# Calculus\n");
		assert.equal(fs.readFileSync(w.inVault("Welcome.md"), "utf8"), "This is your new vault.\n");
		assert.equal(fs.readFileSync(w.inVault("Pasted image 20261110191934.png"), "utf8"), "PNGDATA");
		// …and nothing from the other folders, whose folder record arrived first.
		assert.equal(fs.existsSync(w.inVault("Untitled", "Private diary.md")), false);
		assert.equal(fs.existsSync(w.inVault("Untitled", "Second.md")), false);
		assert.equal(fs.existsSync(w.inVault("Projects, old", "Plan.md")), false);
		assert.deepEqual(fs.readdirSync(w.inVault(".obsidian")).filter((name) => name !== ".sync.lock"), [], "none of Obsidian's settings are copied");

		// ob's own settings: the owner's choices.
		const config = JSON.parse(fs.readFileSync(path.join(w.xdg, "obsidian-headless", "sync", "vault1", "config.json"), "utf8")) as Record<string, unknown>;
		assert.equal(config.deviceName, "LearnHarness server");
		assert.equal(config.conflictStrategy, "merge");
		assert.equal(config.allowSpecialFiles, undefined);
		assert.deepEqual(config.ignoreFolders, ["Untitled", "Projects, old"]);

		// Another device adds a folder and a note: the folder is left out, the note arrives.
		w.addRemote(["Recipes", null], ["Recipes/Soup.md", "soup\n"], ["LearnHarness/Chemistry.md", "# Chemistry\n"]);
		await until(() => m.view().leftOut.includes("Recipes") && fs.existsSync(w.inVault("LearnHarness", "Chemistry.md")) && m.view().sync === "up-to-date", "the new folder to be left out");
		assert.equal(fs.existsSync(w.inVault("Recipes", "Soup.md")), false);

		// A note written here (the notes drawer) reaches Obsidian.
		fs.writeFileSync(w.inVault("LearnHarness", "From the phone.md"), "written on the phone\n");
		await until(() => w.readRemote().records.some((r) => r.path === "LearnHarness/From the phone.md" && !r.deleted), "the upload", 60_000);
		const uploaded = w.readRemote().records.find((r) => r.path === "LearnHarness/From the phone.md");
		assert.equal(Buffer.from(uploaded!.data, "base64").toString("utf8"), "written on the phone\n");
		assert.equal(uploaded!.device, "LearnHarness server");
		await until(() => m.view().sync === "up-to-date" && !m.view().unsynced, "sync to settle after the upload");
		// Nothing outside LearnHarness was ever uploaded or deleted by the server.
		assert.deepEqual(w.readRemote().records.filter((r) => r.device === "LearnHarness server").map((r) => r.path), ["LearnHarness/From the phone.md"]);
		assert.equal(w.readRemote().records.some((r) => r.deleted), false);

		// A second connect is refused; a restart of the server picks sync up again.
		assert.equal((await m.connect("vault1", "vault password")).ok, false);
		await m.shutdown();
		const again = start(w);
		await again.boot();
		assert.equal(again.view().phase, "connected");
		await until(() => again.view().sync === "up-to-date", "sync after a restart");
		await until(() => again.view().account?.email === "learner@example.invalid", "the account name");
		assert.deepEqual([...again.view().leftOut].sort(), ["Projects, old", "Recipes", "Untitled"]);
	});

	it("restarts ob after a crash and reports a crash loop", async () => {
		const w = world("crash");
		w.addRemote(...SEED);
		const m = start(w);
		await m.boot();
		await m.signIn("learner@example.invalid", "right password", "");
		await m.connect("vault1", "vault password");
		await until(() => m.view().sync === "up-to-date", "the first download");

		// Killed outright, ob leaves its lock behind for 5 seconds: the manager
		// waits that out instead of counting crashes.
		const startsBefore = w.spawned.filter((args) => args[0] === "sync").length;
		process.kill(childPid(w), "SIGKILL");
		await until(() => m.view().sync === "starting", "the kill to be noticed");
		await until(() => m.view().sync === "up-to-date", "sync after the lock cleared");
		assert.equal(w.spawned.filter((args) => args[0] === "sync").length, startsBefore + 2, "one refused start, then one that worked");

		w.flags.crash = true;
		process.kill(childPid(w), "SIGTERM");
		await until(() => m.view().sync === "failing", "the crash loop to be reported");
		assert.equal(m.notesSync(), "stopped");
		w.flags.crash = false;
		assert.deepEqual(await m.retry(), { ok: true });
		await until(() => m.view().sync === "up-to-date", "sync after Try again");
		assert.equal(m.notesSync(), "ok");
	});

	it("stops for an expired sign-in, an ended subscription and a missing vault", async () => {
		const w = world("stopped");
		w.addRemote(...SEED);
		const m = start(w);
		await m.boot();
		await m.signIn("learner@example.invalid", "right password", "");
		await m.connect("vault1", "vault password");
		await until(() => m.view().sync === "up-to-date", "the first download");

		// The sign-in stops being valid (a changed password signs devices out).
		w.editRemote((r) => { r.tokens = []; });
		process.kill(childPid(w), "SIGTERM");
		await until(() => m.view().sync === "needs-sign-in", "the expired sign-in to be noticed");
		assert.equal(m.view().phase, "connected", "the vault and the notes stay");
		assert.equal(m.notesSync(), "stopped");
		assert.ok(fs.existsSync(w.inVault("LearnHarness", "Calculus.md")));
		const syncStarts = w.spawned.filter((args) => args[0] === "sync").length;
		await sleep(400);
		assert.equal(w.spawned.filter((args) => args[0] === "sync").length, syncStarts, "no restart loop while signed out");
		assert.deepEqual(await m.signIn("learner@example.invalid", "right password", ""), { ok: true });
		await until(() => m.view().sync === "up-to-date", "sync after signing in again");

		w.editRemote((r) => { r.initError = "Your subscription to Obsidian Sync has expired"; });
		process.kill(childPid(w), "SIGTERM");
		await until(() => m.view().sync === "subscription", "the ended subscription to be noticed");
		w.editRemote((r) => { r.initError = ""; });
		await m.retry();
		await until(() => m.view().sync === "up-to-date", "sync after the subscription is back");

		w.editRemote((r) => { r.initError = "Vault not found"; });
		process.kill(childPid(w), "SIGTERM");
		await until(() => m.view().sync === "vault-gone", "the missing vault to be noticed");
		assert.deepEqual(await m.disconnect(false), { ok: true });
		assert.equal(m.view().phase, "signed-out");
	});

	it("pauses instead of syncing when the server's notes are gone, and never deletes them remotely", async () => {
		const w = world("safety");
		w.addRemote(...SEED, ["LearnHarness/Third.md", "3\n"], ["LearnHarness/Fourth.md", "4\n"]);
		const m = start(w);
		await m.boot();
		await m.signIn("learner@example.invalid", "right password", "");
		await m.connect("vault1", "vault password");
		await until(() => m.view().sync === "up-to-date", "the first download");
		await m.shutdown();

		// The server's copy is emptied while sync is off (a restore gone wrong).
		fs.rmSync(w.inVault("LearnHarness"), { recursive: true, force: true });
		const restarted = start(w);
		await restarted.boot();
		assert.equal(restarted.view().sync, "paused");
		assert.equal(restarted.notesSync(), "stopped");
		assert.ok(w.log.some((line) => line.startsWith("paused")));
		await restarted.retry();
		assert.equal(restarted.view().sync, "paused", "Try again doesn't get past the safety check");
		await sleep(300);
		assert.equal(w.readRemote().records.some((r) => r.deleted), false, "nothing was deleted from Obsidian");

		// The fix: disconnect, then connect again for a fresh copy.
		assert.deepEqual(await restarted.disconnect(false), { ok: true });
		await restarted.signIn("learner@example.invalid", "right password", "");
		assert.deepEqual(await restarted.connect("vault1", "vault password"), { ok: true });
		await until(() => restarted.view().sync === "up-to-date", "the fresh download");
		assert.equal(fs.readFileSync(w.inVault("LearnHarness", "Fourth.md"), "utf8"), "4\n");
		assert.equal(w.readRemote().records.some((r) => r.deleted), false);

		// Losing more than half trips it too; losing one note of five doesn't.
		await restarted.shutdown();
		fs.rmSync(w.inVault("LearnHarness", "Third.md"));
		const fine = start(w);
		await fine.boot();
		await until(() => fine.view().sync === "up-to-date", "sync with one note deleted here");
		await until(() => w.readRemote().records.some((r) => r.path === "LearnHarness/Third.md" && r.deleted), "that one deletion to sync, as any deletion does");
		await fine.shutdown();
	});

	it("disconnects only after ob has let go of the folder, warning about unsynced changes", async () => {
		const w = world("disconnect");
		w.addRemote(...SEED);
		const m = start(w);
		await m.boot();
		await m.signIn("learner@example.invalid", "right password", "");
		await m.connect("vault1", "vault password");
		await until(() => m.view().sync === "up-to-date", "the first download");

		// Something written here that hasn't synced yet: Disconnect asks first.
		w.editRemote((r) => { r.offline = true; });
		process.kill(childPid(w), "SIGTERM");
		await until(() => m.view().sync === "offline", "Obsidian to be unreachable");
		assert.equal(m.notesSync(), "ok", "a short offline spell isn't shown in the notes drawer");
		await until(() => m.notesSync() === "stopped", "a long offline spell to show");
		fs.writeFileSync(w.inVault("LearnHarness", "Unsent.md"), "not in Obsidian yet\n");
		await until(() => m.view().unsynced, "the unsynced change to be noticed");
		assert.deepEqual(await m.disconnect(false), { ok: false, error: OBSIDIAN_TEXT.unsynced, unsynced: true });
		assert.equal(m.view().phase, "connected", "nothing was removed");
		assert.ok(fs.existsSync(w.inVault("LearnHarness", "Unsent.md")));

		w.editRemote((r) => { r.offline = false; });
		assert.deepEqual(await m.disconnect(true), { ok: true });
		const view = m.view();
		assert.equal(view.phase, "signed-out");
		assert.equal(view.vault, null);
		assert.deepEqual(view.leftOut, []);
		assert.equal(m.notesSync(), null);
		assert.equal(w.notesPointer.dir, null, "the notes drawer goes back to its connect prompt");
		assert.deepEqual(fs.readdirSync(w.vaultDir), [], "the server's copy is removed");
		assert.equal(fs.existsSync(path.join(w.xdg, "obsidian-headless", "auth_token")), false, "the server is signed out of Obsidian");
		assert.equal(fs.existsSync(path.join(w.xdg, "obsidian-headless", "sync", "vault1")), false, "the vault key is gone");
		assert.deepEqual(w.readRemote().tokens, []);
		assert.equal(w.readRemote().records.some((r) => r.deleted), false, "Obsidian's copy is untouched");
		// The order: stop syncing, unlink, and only then remove files.
		const commands = w.spawned.map((args) => args[0]);
		assert.ok(commands.lastIndexOf("sync-unlink") > commands.lastIndexOf("sync"));
		assert.ok(commands.lastIndexOf("logout") > commands.lastIndexOf("sync-unlink"));
	});

	/** The running `ob sync` process, found by its lock folder's owner being alive. */
	function childPid(w: ReturnType<typeof world>): number {
		const pids = fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name));
		for (const pid of pids) {
			try {
				const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
				if (cmd.includes("sync") && cmd.includes("--continuous") && cmd.includes(w.vaultDir)) return Number(pid);
			} catch { /* gone */ }
		}
		throw new Error(`no running ob sync process (commands: ${w.spawned.map((args) => args[0]).join(" ")}; log: ${w.log.join(" | ")})`);
	}
});
