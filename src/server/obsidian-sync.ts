/**
 * The Obsidian sync manager on the cloud server (side-tutor fork, cloud sync
 * Phase 4; docs/cloud-sync.md). Server mode only.
 *
 * Obsidian's official headless client (`ob`, obsidian-headless) does the
 * syncing as one more Obsidian Sync device. This module drives it over
 * plain pipes:
 *
 *   sign in      `ob login --email <email> [--mfa <code>]`, the password
 *                written to its input (never an argument, never stored)
 *   list vaults  `ob sync-list-remote --json`
 *   connect      `ob sync-setup --vault <id> --path <vault> --device-name …`,
 *                the vault's encryption password written to its input
 *   sync         `ob sync --path <vault> --continuous`, kept running:
 *                restarted after a crash, started again after a restart
 *   leave out    every top-level folder except LearnHarness/ is added to
 *                ob's excluded folders the moment ob starts on a file in it
 *   disconnect   stop, `ob sync-unlink`, `ob logout`, then (and only then)
 *                remove the server's copy
 *
 * ob owns its credentials (a sign-in token and the vault key in its own
 * folder, which the agents' file tools refuse). LearnHarness keeps only
 * <data>/obsidian-sync.json: how many notes the last healthy sync saw.
 *
 * Before ob starts, the safety check runs: with the LearnHarness folder
 * missing, empty or more than half gone, ob would delete those notes from
 * Obsidian on every device, so sync stays off until the owner acts.
 *
 * State lives on globalThis so every route bundle shares one manager.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { externalCliEnv } from "../core/auth-env.ts";
import {
	OB_CONFLICT_STRATEGY,
	OB_DEVICE_NAME,
	OB_FAILING_AFTER,
	OB_LOCK_WAIT_MS,
	OB_RESTART_BASE_MS,
	OB_RESTART_MAX_MS,
	OB_VERSION,
	OBSIDIAN_TEXT,
	checkSignInInput,
	checkVaultPassword,
	connectOutcome,
	excludedFoldersArgument,
	folderToLeaveOut,
	foldersToLeaveOut,
	looksUnreachable,
	obsidianErrorText,
	parseLoggedIn,
	parseObLine,
	parseVaultList,
	restartDelayMs,
	signInOutcome,
	syncIsRunning,
	topLevelCandidate,
	validVaultId,
	vaultLooksEmptied,
	type ObsidianSyncState,
	type ObsidianVault,
	type ObsidianView,
} from "../core/obsidian-sync.ts";
import { EMPTY_OBSIDIAN_RECORD, obConfigDir, obsidianSyncFiles, obsidianVaultDir, type ObsidianSyncFiles, type ObsidianSyncRecord } from "../store/obsidian-sync.ts";
import { notesStore } from "../store/notes.ts";

const MAX_OUTPUT = 256 * 1024;
const SIGN_IN_AGAIN = "Sign in to Obsidian again.";
const NO_ANSWER = "Obsidian's sync program didn't answer. Try again.";

export interface ObsidianSyncDeps {
	/** The installed `ob`, or null while it isn't there yet. */
	binary: () => string | null;
	spawn: (binary: string, args: string[]) => ChildProcessWithoutNullStreams;
	vaultDir: string;
	/** obsidian-headless's own folder (token, vault key, sync state). */
	configDir: string;
	files: ObsidianSyncFiles;
	/** Points the notes drawer at the vault, or away from it. */
	notes: { setVault: (dir: string) => void; clearVault: () => void };
	now: () => number;
	log: (message: string) => void;
	timing: {
		restartBaseMs: number;
		restartMaxMs: number;
		/** How often the vault's top level is checked for new folders. */
		scanMs: number;
		commandMs: number;
		/** How long ob gets to stop before it's killed. */
		stopMs: number;
		installPollMs: number;
		/** How long to wait when ob says its lock is still held. */
		lockMs: number;
		/** An offline spell shorter than this isn't shown in the notes drawer. */
		offlineGraceMs: number;
	};
}

function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
	if (env.LH_OB_BINARY) return env.LH_OB_BINARY;
	for (const dir of (env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(/* turbopackIgnore: true */ dir, name);
		try {
			fs.accessSync(/* turbopackIgnore: true */ candidate, fs.constants.X_OK);
			if (fs.statSync(/* turbopackIgnore: true */ candidate).isFile()) return candidate;
		} catch { /* not here */ }
	}
	return null;
}

function defaultDeps(): ObsidianSyncDeps {
	return {
		binary: () => findOnPath("ob"),
		spawn: (binary, args) => spawn(binary, args, { cwd: os.tmpdir(), env: externalCliEnv(), stdio: "pipe", windowsHide: true }),
		vaultDir: obsidianVaultDir(),
		configDir: obConfigDir(),
		files: obsidianSyncFiles,
		notes: { setVault: (dir) => { notesStore.setVault(dir); }, clearVault: () => notesStore.clearVault() },
		now: Date.now,
		log: (message) => console.log(`[LearnHarness] Obsidian sync: ${message}`),
		timing: { restartBaseMs: OB_RESTART_BASE_MS, restartMaxMs: OB_RESTART_MAX_MS, scanMs: 10_000, commandMs: 120_000, stopMs: 10_000, installPollMs: 15_000, lockMs: OB_LOCK_WAIT_MS, offlineGraceMs: 60_000 },
	};
}

interface RunResult {
	code: number | null;
	stdout: string;
	/** stdout and stderr together, in arrival order. */
	output: string;
}

type StopReason = "leave-out" | "halt" | "manual";

export type ObsidianActionResult = { ok: true } | { ok: false; error: string; detail?: string | null; unsynced?: boolean };
export type ObsidianVaultsResult = { ok: true; vaults: ObsidianVault[] } | { ok: false; error: string };

const STOP_KEY = Symbol.for("lh.obsidianSync.stop");
/** Runs `pass` when the server process is told to stop. Next's own handler
 *  ends the process; this only passes the signal on to ob. One pair of
 *  process listeners, however many managers exist. */
function onServerStop(pass: () => void): void {
	const g = globalThis as typeof globalThis & { [STOP_KEY]?: Set<() => void> };
	if (!g[STOP_KEY]) {
		const all = new Set<() => void>();
		g[STOP_KEY] = all;
		const run = () => { for (const each of all) each(); };
		process.on("SIGTERM", run);
		process.on("SIGINT", run);
	}
	g[STOP_KEY].add(pass);
}

export function createObsidianSync(deps: ObsidianSyncDeps = defaultDeps()) {
	/** ob is installed at the pinned version. */
	let ready = false;
	let hasToken = false;
	/** Obsidian refused the stored sign-in. */
	let tokenRefused = false;
	let account: { name: string; email: string } | null = null;
	let vault: ObsidianVault | null = null;
	let leftOut: string[] = [];
	let sync: ObsidianSyncState | null = null;
	let offlineSince: number | null = null;
	let busy: ObsidianView["busy"] = null;
	let record: ObsidianSyncRecord = { ...EMPTY_OBSIDIAN_RECORD };
	let recordLoaded = false;

	let child: ChildProcessWithoutNullStreams | null = null;
	let childDone: Promise<void> = Promise.resolve();
	let stopReason: StopReason | null = null;
	const waitingToLeaveOut = new Set<string>();
	let failures = 0;
	/** ob said its lock was still held (it was killed moments ago). */
	let lockedStarts = 0;
	let sawLocked = false;
	let restartTimer: ReturnType<typeof setTimeout> | null = null;
	let scanTimer: ReturnType<typeof setInterval> | null = null;
	let installTimer: ReturnType<typeof setTimeout> | null = null;
	let unsyncedCache: { at: number; value: boolean } | null = null;
	let booted = false;
	/** ob's last answer about the vault setup was unusable (see readVaultSetup). */
	let setupUnknown = false;

	// One operation at a time: sign-in, connect, disconnect, (re)starts.
	let chain: Promise<unknown> = Promise.resolve();
	function exclusive<T>(work: () => Promise<T>): Promise<T> {
		const run = chain.then(work, work);
		chain = run.catch(() => undefined);
		return run;
	}

	/** Runs one ob command to its end. `input` is written to its input and
	 *  is never logged, stored or put on the command line. */
	function run(args: string[], input?: string): Promise<RunResult> {
		return new Promise((resolve) => {
			const binary = deps.binary();
			if (!binary) return resolve({ code: null, stdout: "", output: "" });
			let proc: ChildProcessWithoutNullStreams;
			try { proc = deps.spawn(binary, args); } catch { return resolve({ code: null, stdout: "", output: "" }); }
			let stdout = "";
			let output = "";
			let settled = false;
			const finish = (code: number | null) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve({ code, stdout, output });
			};
			const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* gone */ } finish(null); }, deps.timing.commandMs);
			proc.stdout.on("data", (chunk: Buffer) => { const text = chunk.toString("utf8"); stdout = (stdout + text).slice(-MAX_OUTPUT); output = (output + text).slice(-MAX_OUTPUT); });
			proc.stderr.on("data", (chunk: Buffer) => { output = (output + chunk.toString("utf8")).slice(-MAX_OUTPUT); });
			proc.on("error", () => finish(null));
			proc.on("close", (code) => finish(code));
			proc.stdin.on("error", () => { /* ob closed its input first */ });
			// ob reads a prompt's answer up to the end of its input.
			proc.stdin.end(input ?? "");
		});
	}

	function saveRecord(): void {
		try { deps.files.writeRecord(record); } catch (error) { deps.log(`couldn't save its record (${error instanceof Error ? error.message : "unknown error"})`); }
	}

	function sameDir(a: string, b: string): boolean {
		return path.resolve(/* turbopackIgnore: true */ a) === path.resolve(/* turbopackIgnore: true */ b);
	}

	/** Whether ob has this server's vault folder set up, and with what.
	 *  null = it certainly hasn't. undefined = ob didn't give a usable
	 *  answer: nothing may be concluded, and above all nothing removed. */
	async function readVaultSetup(): Promise<{ vault: ObsidianVault; leftOut: string[] } | null | undefined> {
		const local = await run(["sync-list-local", "--json"]);
		let listed: boolean;
		try {
			const parsed = JSON.parse(local.stdout) as { vaults?: { path?: unknown }[] };
			if (local.code !== 0 || !Array.isArray(parsed.vaults)) return undefined;
			listed = parsed.vaults.some((v) => typeof v.path === "string" && sameDir(v.path, deps.vaultDir));
		} catch {
			return undefined;
		}
		if (!listed) return null;
		const status = await run(["sync-status", "--path", deps.vaultDir, "--json"]);
		try {
			const parsed = JSON.parse(status.stdout) as { vaultId?: unknown; vaultName?: unknown; excludedFolders?: unknown };
			if (status.code !== 0 || !validVaultId(parsed.vaultId)) return undefined;
			return {
				vault: { id: parsed.vaultId, name: typeof parsed.vaultName === "string" ? parsed.vaultName : "" },
				leftOut: Array.isArray(parsed.excludedFolders) ? parsed.excludedFolders.filter((f): f is string => typeof f === "string") : [],
			};
		} catch {
			return undefined;
		}
	}

	/** Who is signed in. Asks Obsidian, so it is never awaited on a page load. */
	async function loadAccount(): Promise<void> {
		if (!hasToken) { account = null; return; }
		const result = await run(["login"]);
		const found = parseLoggedIn(result.output);
		if (found) { account = found; tokenRefused = false; return; }
		// Only Obsidian's own refusal counts; a hiccup or no network doesn't.
		if (result.code !== 0 && result.code !== null && obsidianErrorText(result.output)) {
			tokenRefused = true;
			if (vault) await haltSync("needs-sign-in");
		}
	}

	/** Reads where things stand from ob itself (no network). */
	async function refresh(): Promise<void> {
		const binary = deps.binary();
		if (!binary) { ready = false; return; }
		if (!ready) {
			const version = await run(["--version"]);
			if (version.stdout.trim() !== OB_VERSION) { ready = false; return; }
			ready = true;
		}
		hasToken = deps.files.hasToken(deps.configDir);
		if (!hasToken) { account = null; tokenRefused = false; }
		if (!recordLoaded) { record = deps.files.readRecord(); recordLoaded = true; }
		const setup = await readVaultSetup();
		setupUnknown = setup === undefined;
		if (setup === undefined) return; // keep what was known
		vault = setup?.vault ?? null;
		leftOut = setup?.leftOut ?? [];
		if (!vault) sync = null;
	}

	/** The notes drawer reads and writes the vault folder while a vault is
	 *  connected, and shows its connect prompt otherwise. */
	function pointNotes(): void {
		try {
			if (vault) deps.notes.setVault(deps.vaultDir);
			else deps.notes.clearVault();
		} catch (error) {
			deps.log(`the notes drawer couldn't use the vault folder (${error instanceof Error ? error.message : "unknown error"})`);
		}
	}

	/** After a (re)start: who is signed in, asked once things are running. */
	function queueAccount(): void {
		void exclusive(loadAccount);
	}

	function clearRestart(): void {
		if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
	}

	function stopScan(): void {
		if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
	}

	/** Asks ob to stop and resolves when it has. ob finishes the file it is
	 *  writing on SIGTERM; it is killed only if it won't stop. */
	function stopChild(reason: StopReason): Promise<void> {
		const running = child;
		if (!running) return Promise.resolve();
		stopReason ??= reason;
		try { running.kill("SIGTERM"); } catch { /* gone */ }
		const force = setTimeout(() => { try { running.kill("SIGKILL"); } catch { /* gone */ } }, deps.timing.stopMs);
		return childDone.finally(() => clearTimeout(force));
	}

	const HALT_REASON: Partial<Record<ObsidianSyncState, string>> = {
		"needs-sign-in": "Obsidian refused the stored sign-in",
		subscription: "the Obsidian Sync subscription has expired",
		"vault-gone": "the vault no longer exists in Obsidian Sync",
	};

	async function haltSync(state: ObsidianSyncState, obsidianSaid = ""): Promise<void> {
		clearRestart();
		if (sync !== state) deps.log(`stopped: ${HALT_REASON[state] ?? state}${obsidianSaid ? ` (Obsidian said: ${obsidianSaid})` : ""}`);
		sync = state;
		await stopChild("halt");
		sync = state;
	}

	/** Adds folders to ob's excluded list. ob must be stopped. */
	async function leaveOut(folders: readonly string[]): Promise<boolean> {
		const next = [...new Set([...leftOut, ...folders])];
		if (next.length === leftOut.length) return true;
		if (!vault) return false;
		const argument = excludedFoldersArgument(next);
		if (argument === null) {
			if (!deps.files.writeExcludedFolders(deps.configDir, vault.id, next)) return false;
			leftOut = next;
			return true;
		}
		const result = await run(["sync-config", "--path", deps.vaultDir, "--excluded-folders", argument, "--json"]);
		try {
			const parsed = JSON.parse(result.stdout) as { excludedFolders?: unknown };
			if (result.code !== 0 || !Array.isArray(parsed.excludedFolders)) return false;
			leftOut = parsed.excludedFolders.filter((f): f is string => typeof f === "string");
			return next.every((name) => leftOut.includes(name));
		} catch {
			return false;
		}
	}

	function markWorking(): void {
		offlineSince = null;
		if (sync === "starting" || sync === "up-to-date" || sync === "offline" || sync === "failing") sync = record.firstSyncDone ? "syncing" : "first-sync";
	}

	function onLine(line: string): void {
		const parsed = parseObLine(line);
		switch (parsed.kind) {
			case "downloading": {
				const folder = folderToLeaveOut(parsed.path, [...leftOut, ...waitingToLeaveOut]);
				if (folder) {
					waitingToLeaveOut.add(folder);
					void stopChild("leave-out");
				} else if (!stopReason) markWorking();
				break;
			}
			case "downloaded": {
				// A top-level folder just arrived: leave it out before its files do.
				const folder = stopReason ? null : topLevelCandidate(parsed.path, [...leftOut, ...waitingToLeaveOut]);
				if (folder && deps.files.isFolder(deps.vaultDir, folder)) {
					waitingToLeaveOut.add(folder);
					void stopChild("leave-out");
				} else if (!stopReason) markWorking();
				break;
			}
			case "working":
				if (!stopReason) markWorking();
				break;
			case "synced": {
				if (stopReason) break;
				const now = deps.now();
				const notes = deps.files.countNotes(deps.vaultDir);
				const changed = !record.firstSyncDone || record.notesSeen !== notes || !record.lastSyncedAt || now - record.lastSyncedAt > 60_000;
				if (!record.firstSyncDone) deps.log(`the first download finished (${notes} ${notes === 1 ? "note" : "notes"} under LearnHarness)`);
				else if (sync !== "up-to-date" && sync !== "syncing") deps.log("up to date");
				record = { ...record, firstSyncDone: true, notesSeen: notes, lastSyncedAt: now };
				if (changed) saveRecord();
				sync = "up-to-date";
				offlineSince = null;
				failures = 0;
				lockedStarts = 0;
				unsyncedCache = null;
				break;
			}
			case "connected":
				if (!stopReason && sync === "offline") { sync = record.firstSyncDone ? "syncing" : "first-sync"; offlineSince = null; }
				break;
			case "offline":
				if (!stopReason && syncIsRunning(sync)) { sync = "offline"; offlineSince ??= deps.now(); deps.log("can't reach Obsidian; ob keeps trying"); }
				break;
			case "auth":
				tokenRefused = true;
				void haltSync("needs-sign-in", parsed.detail);
				break;
			case "subscription":
				void haltSync("subscription");
				break;
			case "vault-gone":
				void haltSync("vault-gone");
				break;
			case "locked":
				sawLocked = true;
				break;
			default:
				break;
		}
	}

	/** New top-level folders on disk (a folder record arrives without a
	 *  "Downloading <folder>/…" line of its own). */
	function scanForFolders(): void {
		if (!child || stopReason) return;
		// The safety check's baseline follows what ob itself adds and removes.
		const notes = deps.files.countNotes(deps.vaultDir);
		if (notes !== record.notesSeen) { record = { ...record, notesSeen: notes }; saveRecord(); }
		const found = foldersToLeaveOut(deps.files.topLevelFolders(deps.vaultDir), [...leftOut, ...waitingToLeaveOut]);
		if (!found.length) return;
		for (const name of found) waitingToLeaveOut.add(name);
		void stopChild("leave-out");
	}

	function scheduleRestart(lockHeld = false): void {
		clearRestart();
		// A held lock clears by itself in seconds; it isn't a crash (unless it never clears).
		const waitForLock = lockHeld && lockedStarts < 10;
		if (waitForLock) lockedStarts += 1;
		else failures += 1;
		if (failures >= OB_FAILING_AFTER) sync = "failing";
		else if (sync !== "offline") sync = "starting";
		const wait = waitForLock ? deps.timing.lockMs : restartDelayMs(failures, deps.timing.restartBaseMs, deps.timing.restartMaxMs);
		deps.log(waitForLock ? "ob's lock is still held; starting again shortly" : `ob stopped unexpectedly (${failures} in a row); starting again in ${Math.round(wait / 1000)}s`);
		restartTimer = setTimeout(() => {
			restartTimer = null;
			void exclusive(startSync);
		}, wait);
		restartTimer.unref?.();
	}

	function onExit(): void {
		const reason = stopReason;
		stopReason = null;
		child = null;
		stopScan();
		if (reason === "halt" || reason === "manual") return;
		if (reason === "leave-out") {
			void exclusive(async () => {
				const folders = [...waitingToLeaveOut];
				if (!vault) { waitingToLeaveOut.clear(); return; } // disconnected meanwhile
				if (await leaveOut(folders)) {
					waitingToLeaveOut.clear();
					deps.log(`left out ${folders.length === 1 ? "a folder" : `${folders.length} folders`}`);
					await startSync();
				} else {
					waitingToLeaveOut.clear();
					deps.log("couldn't update the excluded folders; trying again shortly");
					scheduleRestart();
				}
			});
			return;
		}
		if (!vault || sync === "needs-sign-in" || sync === "subscription" || sync === "vault-gone" || sync === "paused") return;
		const lockHeld = sawLocked;
		sawLocked = false;
		scheduleRestart(lockHeld);
	}

	/** Starts `ob sync --continuous` when it is safe to. Call inside exclusive(). */
	async function startSync(): Promise<void> {
		clearRestart();
		if (child || !ready || !vault) return;
		const binary = deps.binary();
		if (!binary) { ready = false; watchInstall(); return; }
		if (!hasToken || tokenRefused) { sync = "needs-sign-in"; return; }
		// The safety check (owner-approved): never start with the notes gone.
		const notesNow = deps.files.countNotes(deps.vaultDir);
		// LearnHarness's own record is gone (or ob was set up over SSH), so there
		// is no count to compare with. ob's memory decides: with one, an empty
		// notes folder means the notes went missing.
		const noRecord = record.connectedAt === null;
		const remembered = deps.files.hasSyncState(deps.configDir, vault.id);
		if (vaultLooksEmptied(record.notesSeen, notesNow) || (noRecord && remembered && notesNow === 0)) {
			sync = "paused";
			deps.log("paused: the server's copy of the notes is missing or much smaller than before");
			return;
		}
		if (noRecord) {
			record = { ...record, connectedAt: deps.now(), notesSeen: notesNow, firstSyncDone: remembered && notesNow > 0 };
			saveRecord();
		}
		if (!(await leaveOut(foldersToLeaveOut(deps.files.topLevelFolders(deps.vaultDir), leftOut)))) {
			deps.log("couldn't update the excluded folders; trying again shortly");
			scheduleRestart();
			return;
		}
		let proc: ChildProcessWithoutNullStreams;
		try {
			proc = deps.spawn(binary, ["sync", "--path", deps.vaultDir, "--continuous"]);
		} catch {
			scheduleRestart();
			return;
		}
		child = proc;
		stopReason = null;
		sawLocked = false;
		deps.log(record.firstSyncDone ? "ob started" : "ob started; downloading the notes for the first time");
		if (sync !== "failing" && sync !== "offline") sync = record.firstSyncDone ? "starting" : "first-sync";
		let pending = "";
		const onData = (chunk: Buffer) => {
			if (child !== proc) return;
			pending += chunk.toString("utf8");
			const lines = pending.split("\n");
			pending = lines.pop() ?? "";
			if (pending.length > MAX_OUTPUT) pending = "";
			for (const line of lines) onLine(line);
		};
		proc.stdout.on("data", onData);
		proc.stderr.on("data", onData);
		proc.stdin.on("error", () => { /* ob doesn't read its input while syncing */ });
		proc.stdin.end();
		childDone = new Promise<void>((resolve) => {
			let done = false;
			const finish = () => {
				if (done) return;
				done = true;
				if (child === proc) onExit();
				resolve();
			};
			proc.on("error", finish);
			proc.on("close", finish);
		});
		stopScan();
		scanTimer = setInterval(scanForFolders, deps.timing.scanMs);
		scanTimer.unref?.();
	}

	function watchInstall(): void {
		if (installTimer || ready) return;
		installTimer = setTimeout(() => {
			installTimer = null;
			void exclusive(async () => {
				await refresh();
				if (!ready) { watchInstall(); return; }
				pointNotes();
				await startSync();
				queueAccount();
			});
		}, deps.timing.installPollMs);
		installTimer.unref?.();
	}

	/** Server start (instrumentation.ts): pick up where things were. */
	function boot(): Promise<void> {
		if (booted) return chain.then(() => undefined);
		booted = true;
		// The server is stopping: let ob finish the file it is writing.
		onServerStop(() => { if (child) { stopReason ??= "manual"; try { child.kill("SIGTERM"); } catch { /* gone */ } } });
		return exclusive(async () => {
			await refresh();
			if (!ready) { watchInstall(); return; }
			pointNotes();
			await startSync();
			queueAccount();
		});
	}

	function unsyncedNow(): boolean {
		if (!vault) return false;
		const now = deps.now();
		if (unsyncedCache && now - unsyncedCache.at < 3_000) return unsyncedCache.value;
		const since = record.lastSyncedAt ?? record.connectedAt ?? 0;
		const value = deps.files.newestChange(deps.vaultDir) > since;
		unsyncedCache = { at: now, value };
		return value;
	}

	function view(): ObsidianView {
		const signedIn = hasToken && !tokenRefused;
		const phase = !ready ? "installing" : vault ? "connected" : signedIn ? "signed-in" : "signed-out";
		return {
			phase,
			account: signedIn ? account : null,
			vault: phase === "connected" ? vault : null,
			sync: phase === "connected" ? (signedIn ? sync ?? "starting" : "needs-sign-in") : null,
			lastSyncedAt: phase === "connected" ? record.lastSyncedAt : null,
			leftOut: phase === "connected" ? [...leftOut] : [],
			unsynced: phase === "connected" ? unsyncedNow() : false,
			busy,
		};
	}

	/** For the notes drawer: null (no vault), "ok", or "stopped". A short
	 *  offline spell counts as ok; ob reconnects on its own. */
	function notesSync(): "ok" | "stopped" | null {
		if (!ready || !vault) return null;
		const state = hasToken && !tokenRefused ? sync ?? "starting" : "needs-sign-in";
		if (syncIsRunning(state)) return "ok";
		if (state === "offline") return offlineSince !== null && deps.now() - offlineSince < deps.timing.offlineGraceMs ? "ok" : "stopped";
		return "stopped";
	}

	async function during<T>(what: NonNullable<ObsidianView["busy"]>, work: () => Promise<T>): Promise<T> {
		busy = what;
		try { return await work(); } finally { busy = null; }
	}

	function signIn(email: unknown, password: unknown, code: unknown): Promise<ObsidianActionResult> {
		const input = checkSignInInput(email, password, code);
		if ("error" in input) return Promise.resolve({ ok: false, error: input.error });
		return exclusive(() => during("sign-in", async (): Promise<ObsidianActionResult> => {
			await refresh();
			if (!ready) return { ok: false, error: OBSIDIAN_TEXT.installing };
			// ob replaces the stored sign-in; never while it is syncing with the old one.
			if (child) await stopChild("manual");
			const result = await run(["login", "--email", input.email, ...(input.code ? ["--mfa", input.code] : [])], input.password);
			const outcome = signInOutcome(result.code, result.output, !!input.code);
			hasToken = deps.files.hasToken(deps.configDir);
			if (!outcome.ok) {
				if (!hasToken) account = null;
				if (vault) sync = "needs-sign-in";
				return { ok: false, error: outcome.error, detail: outcome.detail };
			}
			account = outcome.account;
			tokenRefused = false;
			failures = 0;
			if (vault) await startSync();
			return { ok: true };
		}));
	}

	/** Signed in but no vault connected: forget the sign-in. */
	function signOut(): Promise<ObsidianActionResult> {
		return exclusive(async (): Promise<ObsidianActionResult> => {
			await refresh();
			if (vault) return { ok: false, error: "Disconnect the vault first." };
			if (ready) await run(["logout"]);
			hasToken = deps.files.hasToken(deps.configDir);
			account = null;
			tokenRefused = false;
			return hasToken ? { ok: false, error: "Obsidian's sync program couldn't sign out. Try again." } : { ok: true };
		});
	}

	function vaults(): Promise<ObsidianVaultsResult> {
		return exclusive(async (): Promise<ObsidianVaultsResult> => {
			if (!ready) return { ok: false, error: OBSIDIAN_TEXT.installing };
			const result = await run(["sync-list-remote", "--json"]);
			const list = result.code === 0 ? parseVaultList(result.stdout) : null;
			if (list) return list.length ? { ok: true, vaults: list } : { ok: false, error: OBSIDIAN_TEXT.noVaults };
			if (result.output.includes("No account logged in")) { hasToken = false; account = null; return { ok: false, error: SIGN_IN_AGAIN }; }
			if (!obsidianErrorText(result.output)) return { ok: false, error: OBSIDIAN_TEXT.unreachable };
			tokenRefused = true;
			return { ok: false, error: SIGN_IN_AGAIN };
		});
	}

	function connect(vaultId: unknown, password: unknown): Promise<ObsidianActionResult> {
		const secret = checkVaultPassword(password);
		if (!validVaultId(vaultId)) return Promise.resolve({ ok: false, error: "Choose a vault." });
		if (secret === null) return Promise.resolve({ ok: false, error: OBSIDIAN_TEXT.wrongVaultPassword });
		return exclusive(() => during("connect", async (): Promise<ObsidianActionResult> => {
			await refresh();
			if (!ready) return { ok: false, error: OBSIDIAN_TEXT.installing };
			if (setupUnknown) return { ok: false, error: NO_ANSWER };
			if (vault) return { ok: false, error: "A vault is already connected. Disconnect it first." };
			if (!hasToken) return { ok: false, error: SIGN_IN_AGAIN };
			// ob has no setup for this folder, so nothing in it is synced. Start
			// clean on both sides: no memory of an earlier sync in ob (it would
			// delete every remembered file from Obsidian), and no leftover files
			// here (they would be merged into the fresh download).
			deps.files.removeStaleSyncState(deps.configDir, deps.vaultDir, vaultId);
			fs.mkdirSync(/* turbopackIgnore: true */ deps.vaultDir, { recursive: true });
			if (!deps.files.isEmptyDir(deps.vaultDir)) deps.files.emptyVault(deps.vaultDir);
			const result = await run(["sync-setup", "--vault", vaultId, "--path", deps.vaultDir, "--device-name", OB_DEVICE_NAME], secret);
			const outcome = connectOutcome(result.code, result.output);
			if (!outcome.ok) {
				if (outcome.signedOut) { hasToken = deps.files.hasToken(deps.configDir); if (!hasToken) account = null; }
				return { ok: false, error: outcome.error };
			}
			await run(["sync-config", "--path", deps.vaultDir, "--conflict-strategy", OB_CONFLICT_STRATEGY, "--json"]);
			const setup = await readVaultSetup();
			setupUnknown = setup === undefined;
			if (!setup) return { ok: false, error: "The vault couldn't be connected. Try again." };
			vault = setup.vault;
			leftOut = setup.leftOut;
			record = { ...EMPTY_OBSIDIAN_RECORD, connectedAt: deps.now() };
			saveRecord();
			failures = 0;
			offlineSince = null;
			unsyncedCache = null;
			sync = "first-sync";
			deps.log("vault connected");
			pointNotes();
			await startSync();
			return { ok: true };
		}));
	}

	/** Stops syncing, signs ob out, and only then removes the server's copy. */
	function disconnect(force: unknown): Promise<ObsidianActionResult> {
		return exclusive(() => during("disconnect", async (): Promise<ObsidianActionResult> => {
			await refresh();
			if (!ready) return { ok: false, error: OBSIDIAN_TEXT.installing };
			if (setupUnknown) return { ok: false, error: NO_ANSWER };
			if (vault) {
				unsyncedCache = null;
				if (force !== true && unsyncedNow()) return { ok: false, error: OBSIDIAN_TEXT.unsynced, unsynced: true };
				clearRestart();
				await stopChild("manual");
				await run(["sync-unlink", "--path", deps.vaultDir]);
				// The copy is removed only once ob no longer syncs this folder:
				// a removal ob could still see would delete the notes everywhere.
				if ((await readVaultSetup()) !== null) return { ok: false, error: "Obsidian's sync program couldn't be disconnected, so nothing was removed. Try again." };
				vault = null;
				pointNotes();
				deps.files.emptyVault(deps.vaultDir);
				leftOut = [];
				sync = null;
				waitingToLeaveOut.clear();
				record = { ...EMPTY_OBSIDIAN_RECORD };
				saveRecord();
				deps.log("vault disconnected; the server's copy was removed");
			}
			await run(["logout"]);
			hasToken = deps.files.hasToken(deps.configDir);
			account = null;
			tokenRefused = false;
			failures = 0;
			offlineSince = null;
			unsyncedCache = null;
			return { ok: true };
		}));
	}

	/** "Try again" / "Check again": re-read everything and start if it's safe. */
	function retry(): Promise<ObsidianActionResult> {
		return exclusive(async (): Promise<ObsidianActionResult> => {
			await refresh();
			if (!ready) { watchInstall(); return { ok: true }; }
			if (hasToken && !account) queueAccount();
			failures = 0;
			if (vault && !child) {
				if (sync === "subscription" || sync === "vault-gone" || sync === "failing" || sync === "paused") sync = "starting";
				await startSync();
			}
			return { ok: true };
		});
	}

	/** Tests: stop everything this manager started. */
	async function shutdown(): Promise<void> {
		clearRestart();
		if (installTimer) { clearTimeout(installTimer); installTimer = null; }
		await stopChild("manual");
		stopScan();
	}

	/** The learner changed the notes here on purpose (a delete in the notes
	 *  drawer): the safety check's baseline follows, whether ob is running or
	 *  not, so a deliberate clear-out is never taken for the notes going missing. */
	function notesChangedHere(): void {
		if (!ready || !vault || !recordLoaded) return;
		const notes = deps.files.countNotes(deps.vaultDir);
		if (notes === record.notesSeen) return;
		record = { ...record, notesSeen: notes };
		saveRecord();
	}

	/** The connected vault's name in Obsidian (what obsidian:// links address). */
	function vaultName(): string | null {
		return ready && vault?.name ? vault.name : null;
	}

	return { boot, view, notesSync, vaultName, notesChangedHere, signIn, signOut, vaults, connect, disconnect, retry, shutdown, settled: () => chain.then(() => undefined) };
}

export type ObsidianSync = ReturnType<typeof createObsidianSync>;

const KEY = Symbol.for("lh.obsidianSync");
export function obsidianSync(): ObsidianSync {
	const g = globalThis as typeof globalThis & { [KEY]?: ObsidianSync };
	return g[KEY] ??= createObsidianSync();
}
