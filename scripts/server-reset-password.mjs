#!/usr/bin/env node
/**
 * server-reset-password.mjs: the "forgot my password" path for server mode
 * (docs/cloud-sync.md, Phase 1). In the Docker image it is on PATH as
 * `reset-password`:
 *
 *   docker compose exec lh reset-password
 *
 * Removes the password, signs out every device, clears lockouts, and
 * prints a new one-time setup code for the /setup page. Learning data,
 * provider keys and subscription logins are not touched.
 *
 * Plain .mjs on purpose: the standalone server image has no TypeScript
 * runner. The setup-code rules below must match src/core/server-auth.ts
 * (normalizeSetupCode / setupCodeHash / newSetupCode); a test pins parity.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function newSetupCode() {
	let code = "";
	for (const byte of randomBytes(8)) code += ALPHABET[byte % 32];
	return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function setupCodeHash(code) {
	return createHash("sha256").update(code.toUpperCase().replace(/[^0-9A-Z]/g, ""), "utf8").digest("hex");
}

export function serverLoginFile(env = process.env) {
	const authFile = env.LH_AUTH_FILE
		? path.resolve(env.LH_AUTH_FILE)
		: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "auth.json");
	return path.join(path.dirname(authFile), "server-login.json");
}

/** Write the reset state atomically at 0600 and return the new code. */
export function resetServerPassword(file) {
	const code = newSetupCode();
	const state = { version: 1, password: null, setupCodeHash: setupCodeHash(code), sessions: [], lockouts: {} };
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${randomUUID()}`;
	const fd = fs.openSync(tmp, "wx", 0o600);
	try {
		fs.fchmodSync(fd, 0o600);
		fs.writeFileSync(fd, `${JSON.stringify(state, null, "\t")}\n`, "utf-8");
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	fs.renameSync(tmp, file);
	return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const code = resetServerPassword(serverLoginFile());
	console.log("Password removed and every device signed out.");
	console.log(`Setup code: ${code}`);
	console.log("Open the site, enter this code and choose a new password.");
}
