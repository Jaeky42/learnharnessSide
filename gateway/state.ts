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

function statOrNull(file: string): fs.Stats | null {
	try {
		return fs.statSync(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

export function writeStateFile(file: string, state: GatewayState): void {
	const dir = path.dirname(file);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	// The temp file sits beside the target: the container's root is read-only
	// and only the state folder is writable.
	const tmp = path.join(dir, `.${path.basename(file)}.tmp-${randomBytes(6).toString("hex")}`);
	const fd = fs.openSync(tmp, "wx", 0o600);
	try {
		try {
			fs.fchmodSync(fd, 0o600);
			fs.writeFileSync(fd, `${JSON.stringify(state, null, "\t")}\n`, "utf-8");
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

/** Strict read: absent → empty; anything unreadable or malformed throws StateDamagedError. */
export function readStateFile(file: string): GatewayState {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyGatewayState();
		throw new StateDamagedError();
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
		let current: string;
		try {
			current = stamp(statOrNull(file));
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
		try { cachedStamp = stamp(statOrNull(file)) === current ? current : null; } catch { cachedStamp = null; }
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
				writeStateFile(file, state);
				cached = { ok: true, state };
				try { cachedStamp = stamp(statOrNull(file)); } catch { cachedStamp = null; }
			}
			return result;
		},
	};
}
