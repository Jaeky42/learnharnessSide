/**
 * The gateway's state file (accounts, sessions, codes, the lockout), written
 * like src/store/server-auth.ts: mode 0600, a temp file in the same folder
 * renamed over the target, hashes only (src/core/accounts.ts). An absent file
 * is the empty state; a damaged or wrong-version file is NOT: every read
 * reports it and every update refuses, so the site closes (503) and nothing
 * ever overwrites it as empty.
 *
 * One process writes it, but `lh-gateway reset-owner` may change it from a
 * second process while the gateway runs: every read stats the file and parses
 * it again only when its identity, size or times changed.
 *
 * `update` is synchronous end to end (read, change, write), so two requests in
 * this process can never interleave and lose each other's write.
 *
 * The file is the only record of who owns which copy, so a copy of it is kept
 * beside it (`<file>.bak`, same folder: the only writable one): before a
 * write, when the backup is a day old or absent, the current file, only if it
 * parses, becomes the backup. A missing file with a backup beside it is
 * damaged, not empty: reading it as "no accounts" would reopen first-start setup.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { emptyGatewayState, parseGatewayState, type GatewayState } from "../src/core/accounts.ts";

export type StateRead = { ok: true; state: GatewayState } | { ok: false };

export class StateDamagedError extends Error {
	constructor() { super("The gateway's state file is damaged."); }
}

export interface GatewayStore {
	/** The current state, or `{ok: false}` when the file is damaged. */
	read(): StateRead;
	/**
	 * Read-modify-write. `change` gets a fresh state and returns the next one
	 * (null: no write) and a result. Throws StateDamagedError on a damaged
	 * file, and the write's own error when the disk refuses.
	 */
	update<T>(change: (state: GatewayState) => { state: GatewayState | null; result: T }): T;
	readonly file: string;
}

/** What identifies one version of the file without reading it. */
function stamp(stat: fs.Stats | null): string {
	return stat ? `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` : "absent";
}

/** The backup is refreshed at most this often. */
export const BACKUP_EVERY_MS = 24 * 60 * 60 * 1000;
export const backupFileOf = (file: string): string => `${file}.bak`;

function statOrNull(file: string): fs.Stats | null {
	try {
		return fs.statSync(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

export function writeStateFile(file: string, state: GatewayState): void {
	writeAtomic(file, `${JSON.stringify(state, null, "\t")}\n`);
}

function writeAtomic(file: string, text: string): void {
	const dir = path.dirname(file);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	// The temp file sits beside the target: the container's root is read-only
	// and only the state folder is writable.
	const tmp = path.join(dir, `.${path.basename(file)}.tmp-${randomBytes(6).toString("hex")}`);
	const fd = fs.openSync(tmp, "wx", 0o600);
	try {
		try {
			fs.fchmodSync(fd, 0o600);
			fs.writeFileSync(fd, text, "utf-8");
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		fs.renameSync(tmp, file);
	} catch (error) {
		try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
		throw error;
	}
}

/**
 * Before a write: the current file becomes the backup when the backup is
 * `BACKUP_EVERY_MS` old or absent, and only if it parses (a damaged file is
 * never copied over a good backup). Best effort: it never blocks the write.
 */
export function backupIfDue(file: string, now: number = Date.now()): void {
	try {
		const old = statOrNull(backupFileOf(file));
		if (old && Math.abs(now - old.mtimeMs) < BACKUP_EVERY_MS) return;
		const text = fs.readFileSync(file, "utf-8");
		parseGatewayState(JSON.parse(text));
		writeAtomic(backupFileOf(file), text);
	} catch { /* absent, damaged, or the disk refused: no backup this time */ }
}

/** The backup's time, or null when there is none. */
export function backupTime(file: string): number | null {
	try { return statOrNull(backupFileOf(file))?.mtimeMs ?? null; } catch { return null; }
}

/** The one terminal line for a damaged file: what to put back, if anything. */
export function damagedLine(file: string): string {
	const at = backupTime(file);
	if (at === null) return "The accounts file is damaged. Nothing was changed. There is no backup beside it.";
	const when = `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
	return `The accounts file is damaged. Nothing was changed. ${backupFileOf(file)} (from ${when}) can be put back.`;
}

/** Strict read: absent → empty (damaged when a backup is beside it); anything unreadable or malformed throws StateDamagedError. */
export function readStateFile(file: string): GatewayState {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new StateDamagedError();
		let backup: fs.Stats | null;
		try { backup = statOrNull(backupFileOf(file)); } catch { throw new StateDamagedError(); }
		if (backup) throw new StateDamagedError();
		return emptyGatewayState();
	}
	try {
		return parseGatewayState(JSON.parse(text));
	} catch {
		throw new StateDamagedError();
	}
}

export function createStore(file: string): GatewayStore {
	let cachedStamp: string | null = null;
	let cached: StateRead = { ok: false };

	function load(): StateRead {
		// An absent file's reading depends on whether a backup is beside it.
		const look = (): string => {
			const stat = statOrNull(file);
			return stat ? stamp(stat) : `absent:${statOrNull(backupFileOf(file)) ? "bak" : ""}`;
		};
		let current: string;
		try {
			current = look();
		} catch {
			cachedStamp = null;
			return { ok: false };
		}
		if (current === cachedStamp) return cached;
		try {
			cached = { ok: true, state: readStateFile(file) };
		} catch {
			cached = { ok: false };
		}
		// A file that changed while it was read is read again next time.
		try { cachedStamp = look() === current ? current : null; } catch { cachedStamp = null; }
		return cached;
	}

	return {
		file,
		read: load,
		update<T>(change: (state: GatewayState) => { state: GatewayState | null; result: T }): T {
			const now = load();
			if (!now.ok) throw new StateDamagedError();
			const { state, result } = change(now.state);
			if (state && state !== now.state) {
				backupIfDue(file);
				writeStateFile(file, state);
				cached = { ok: true, state };
				try { cachedStamp = stamp(statOrNull(file)); } catch { cachedStamp = null; }
			}
			return result;
		},
	};
}
