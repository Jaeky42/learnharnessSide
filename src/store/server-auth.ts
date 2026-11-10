/**
 * Server-mode login file (cloud sync Phase 1): `server-login.json` beside
 * config.AUTH_FILE, mode 0600. Holds the password hash, the setup code
 * hash, hashed session tokens and lockout counters (src/core/server-auth.ts).
 *
 * Never synced between devices (docs/cloud-sync.md: credentials stay per
 * device), and the agents' file tools refuse it like auth.json
 * (src/agent/tools/fs-shared.ts SUBSCRIPTION_FILES).
 *
 * Reads are strict: an absent file is "no password yet", but a corrupt or
 * unknown-version file THROWS so the gate fails closed and nothing ever
 * overwrites it as empty. scripts/server-reset-password.mjs is the only
 * other writer and uses the same atomic-rename pattern.
 */

import fs from "node:fs";
import path from "node:path";
import { AUTH_FILE } from "../../config.ts";
import { emptyServerAuthState, parseServerAuthState, type ServerAuthState } from "../core/server-auth.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

export const SERVER_LOGIN_FILENAME = "server-login.json";

export function serverLoginFile(authFile: string = AUTH_FILE): string {
	return path.join(/* turbopackIgnore: true */ path.dirname(authFile), SERVER_LOGIN_FILENAME);
}

export function readServerAuthState(file: string = serverLoginFile()): ServerAuthState {
	let text: string;
	try {
		text = fs.readFileSync(/* turbopackIgnore: true */ file, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyServerAuthState();
		throw new Error("The server login file could not be read.");
	}
	return parseServerAuthState(JSON.parse(text));
}

export function writeServerAuthState(state: ServerAuthState, file: string = serverLoginFile()): void {
	fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(file), { recursive: true });
	writeFileAtomicSync(file, `${JSON.stringify(state, null, "\t")}\n`, { mode: 0o600 });
}

/** Read-modify-write. `change` returns the next state, or null for no write.
 *  Synchronous end to end, so requests in this process never interleave. */
export function updateServerAuthState<T>(
	change: (state: ServerAuthState) => { state: ServerAuthState | null; result: T },
	file: string = serverLoginFile(),
): T {
	const { state, result } = change(readServerAuthState(file));
	if (state) writeServerAuthState(state, file);
	return result;
}
