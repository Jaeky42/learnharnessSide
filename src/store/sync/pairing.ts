/**
 * Cloud sync (Phase 5): the desktop app's pairing file, `cloud-sync.json`
 * beside config.AUTH_FILE, mode 0600. It holds the server's address, this
 * desktop's device id and name, and the device key the server handed out
 * at pairing.
 *
 * Never synced, and the agents' file tools refuse it like the other sign-in
 * files (src/agent/tools/fs-shared.ts). Absent = this app has never been
 * paired, and then nothing in the sync engine runs.
 *
 * `key: null` means the server has unpaired this desktop: the device id and
 * address are kept, so pairing again reconnects it as the same device.
 */

import fs from "node:fs";
import path from "node:path";
import { AUTH_FILE } from "../../../config.ts";
import { isDeviceId } from "../../core/sync/devices.ts";
import { removeLeftoverTemps, writeFileAtomicSync } from "../atomic-write.ts";

export const CLOUD_PAIRING_FILENAME = "cloud-sync.json";

export interface CloudPairing {
	version: 1;
	deviceId: string;
	name: string;
	/** The server's origin, e.g. "https://learn.example.com". */
	server: string;
	key: string | null;
	pairedAt: number | null;
}

export function cloudPairingFile(authFile: string = AUTH_FILE): string {
	return path.join(/* turbopackIgnore: true */ path.dirname(authFile), CLOUD_PAIRING_FILENAME);
}

/** The pairing, or null when the app has never been paired or the file can't be used. */
export function readCloudPairing(file: string = cloudPairingFile()): CloudPairing | null {
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ file, "utf-8"));
	} catch {
		return null;
	}
	const value = raw as Partial<CloudPairing> | null;
	if (!value || typeof value !== "object" || value.version !== 1) return null;
	if (!isDeviceId(value.deviceId) || typeof value.name !== "string" || typeof value.server !== "string") return null;
	if (value.key !== null && typeof value.key !== "string") return null;
	return {
		version: 1,
		deviceId: value.deviceId,
		name: value.name,
		server: value.server,
		key: value.key,
		pairedAt: typeof value.pairedAt === "number" ? value.pairedAt : null,
	};
}

export function writeCloudPairing(pairing: CloudPairing, file: string = cloudPairingFile()): void {
	fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(file), { recursive: true });
	writeFileAtomicSync(file, `${JSON.stringify(pairing, null, "\t")}\n`, { mode: 0o600 });
}

export function removeCloudPairing(file: string = cloudPairingFile()): void {
	try { fs.unlinkSync(/* turbopackIgnore: true */ file); } catch { /* already gone */ }
	removeLeftoverTemps(file);
}
