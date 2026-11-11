/**
 * Cloud sync (Phase 5, docs/cloud-sync.md): pairing a desktop app with the
 * server. Pure rules over the server's login state (core/server-auth.ts);
 * the HTTP side is src/server/sync/http.ts.
 *
 * Owner-approved rules:
 *  - The server's site, signed in, shows a pairing code that works ONCE,
 *    for 10 minutes. The desktop app sends the code and gets its own key.
 *    The server password is never typed into the desktop app.
 *  - The key opens only the sync API, and only its SHA-256 is stored.
 *  - A desktop stays paired until removed: by its own Remove, by Sign out
 *    everywhere, by a password change, or by reset-password.
 *  - Pairing again reconnects it as the SAME device: the desktop keeps its
 *    device id and sends it with the new code.
 * Proposed in the plan and approved with it: the code looks like the setup
 * code (XXXX-XXXX), wrong codes count toward the login lockout, and at most
 * 10 desktops are paired at once.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import {
	newSetupCode,
	setupCodeHash,
	setupCodeMatches,
	sha256,
	type DeviceRecord,
	type ServerAuthState,
} from "../server-auth.ts";

export const PAIRING_CODE_LIFETIME_MS = 10 * 60 * 1000;
export const MAX_DEVICES = 10;
export const DEVICE_NAME_MAX = 40;
/** lastSeenAt in the login file is refreshed at most this often (a file write). */
const DEVICE_SEEN_RESOLUTION_MS = 5 * 60 * 1000;

const DEVICE_ID = /^dev_[0-9a-f]{16}$/;

export function newDeviceId(): string {
	return `dev_${randomBytes(8).toString("hex")}`;
}

export function isDeviceId(value: unknown): value is string {
	return typeof value === "string" && DEVICE_ID.test(value);
}

/** The name as stored, or null when it can't be used. */
export function cleanDeviceName(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const name = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
	return name.length > 0 && [...name].length <= DEVICE_NAME_MAX ? name : null;
}

/** A fresh code replaces any code still waiting: only one is valid at a time. */
export function startPairing(state: ServerAuthState, now: number): { state: ServerAuthState; code: string; expiresAt: number } {
	const code = newSetupCode();
	const expiresAt = now + PAIRING_CODE_LIFETIME_MS;
	return { state: { ...state, pairing: { codeHash: setupCodeHash(code), expiresAt } }, code, expiresAt };
}

export function pairingCodeMatches(state: ServerAuthState, code: unknown, now: number): boolean {
	return !!state.pairing && state.pairing.expiresAt > now && setupCodeMatches(code, state.pairing.codeHash);
}

export type PairingOutcome =
	| { ok: true; state: ServerAuthState; key: string; device: DeviceRecord }
	| { ok: false; reason: "too_many" };

/**
 * Use up the waiting code (the caller has checked it with
 * pairingCodeMatches) and add the device. A device id that is already
 * paired gets a new key: that is the same desktop pairing again.
 */
export function completePairing(state: ServerAuthState, deviceId: string, name: string, now: number): PairingOutcome {
	const others = state.devices.filter((d) => d.id !== deviceId);
	if (others.length >= MAX_DEVICES) return { ok: false, reason: "too_many" };
	const key = randomBytes(32).toString("base64url");
	const device: DeviceRecord = { id: deviceId, name, keyHash: sha256(key), pairedAt: now, lastSeenAt: now };
	return { ok: true, state: { ...state, pairing: null, devices: [...others, device] }, key, device };
}

export function findDevice(state: ServerAuthState, key: string | null | undefined): DeviceRecord | null {
	if (!key || key.length > 256) return null;
	const wanted = Buffer.from(sha256(key), "hex");
	for (const device of state.devices) {
		const stored = Buffer.from(device.keyHash, "hex");
		if (stored.length === wanted.length && timingSafeEqual(stored, wanted)) return device;
	}
	return null;
}

/** New state with the device's lastSeenAt refreshed, or null when no write is needed. */
export function touchDevice(state: ServerAuthState, deviceId: string, now: number): ServerAuthState | null {
	const device = state.devices.find((d) => d.id === deviceId);
	if (!device || now - device.lastSeenAt < DEVICE_SEEN_RESOLUTION_MS) return null;
	return { ...state, devices: state.devices.map((d) => d.id === deviceId ? { ...d, lastSeenAt: now } : d) };
}

export function removeDevice(state: ServerAuthState, deviceId: string): ServerAuthState {
	return { ...state, devices: state.devices.filter((d) => d.id !== deviceId) };
}

/** Sign out everywhere and a password change unpair every desktop too. */
export function removeAllDevices(state: ServerAuthState): ServerAuthState {
	return { ...state, devices: [], pairing: null };
}

/** The key from an `Authorization: Bearer …` header, or null. */
export function bearerKey(headers: Headers): string | null {
	const value = headers.get("authorization");
	const match = value ? /^Bearer ([A-Za-z0-9_-]{20,128})$/.exec(value.trim()) : null;
	return match ? match[1]! : null;
}
