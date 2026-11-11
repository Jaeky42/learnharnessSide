/**
 * Cloud sync (Phase 5, docs/cloud-sync.md): the DESKTOP's side. This module
 * talks to the server the app is paired with, and keeps the facts the
 * Phase 6 screens will show (paired or not, last contact, why sync paused).
 *
 * Nothing here runs unless the app has been paired: with no pairing file,
 * cloudStatus() reads one small file and every other function refuses.
 * The desktop always starts the conversation; the server never calls it.
 */

import { normalizeServerAddress } from "../../core/sync/address.ts";
import { cleanDeviceName, newDeviceId } from "../../core/sync/devices.ts";
import {
	protocolVerdict,
	SYNC_PROTOCOL_HEADER,
	SYNC_PROTOCOL_VERSION,
	type ProtocolVerdict,
} from "../../core/sync/protocol.ts";
import { readCloudPairing, writeCloudPairing, type CloudPairing } from "../../store/sync/pairing.ts";

const REQUEST_TIMEOUT_MS = 15_000;

export interface SyncDeps {
	fetch?: typeof fetch;
	now?: () => number;
}

/** What this run of the app knows about its link to the server. */
interface LinkState {
	lastContactAt: number | null;
	/** The last attempt didn't reach the server. */
	offline: boolean;
	/** Sync is paused because the two sides speak different protocol versions. */
	pause: Extract<ProtocolVerdict, { ok: false }> | null;
	/** How far the server's clock is ahead of this PC's, in ms (for "latest change wins"). */
	clockOffsetMs: number;
	/** Has the offset been measured since the app started? */
	clockMeasured: boolean;
}

const globals = globalThis as typeof globalThis & { __lhCloudLink?: LinkState };

function link(): LinkState {
	return (globals.__lhCloudLink ??= { lastContactAt: null, offline: false, pause: null, clockOffsetMs: 0, clockMeasured: false });
}

/** Tests start from a clean slate. */
export function resetCloudLink(): void {
	delete globals.__lhCloudLink;
}

export type CloudSyncState = "off" | "starting" | "ok" | "offline" | "paused" | "needs-pairing";

export interface CloudStatus {
	role: "desktop";
	/** A device key is stored: the app is paired as far as it knows. */
	paired: boolean;
	server: string | null;
	device: { id: string; name: string } | null;
	sync: {
		state: CloudSyncState;
		/** The approved sentence when sync is paused for a version difference. */
		message: string | null;
		lastContactAt: number | null;
	};
}

export function cloudStatus(): CloudStatus {
	const pairing = readCloudPairing();
	if (!pairing) return { role: "desktop", paired: false, server: null, device: null, sync: { state: "off", message: null, lastContactAt: null } };
	const state = link();
	const syncState: CloudSyncState = !pairing.key ? "needs-pairing"
		: state.pause ? "paused"
		: state.offline ? "offline"
		: state.lastContactAt === null ? "starting"
		: "ok";
	return {
		role: "desktop",
		paired: pairing.key !== null,
		server: pairing.server,
		device: { id: pairing.deviceId, name: pairing.name },
		sync: { state: syncState, message: state.pause?.message ?? null, lastContactAt: state.lastContactAt },
	};
}

/** The pairing when this app may sync right now, or null. */
export function activePairing(): (CloudPairing & { key: string }) | null {
	const pairing = readCloudPairing();
	return pairing && pairing.key ? pairing as CloudPairing & { key: string } : null;
}

export function serverClockOffsetMs(): number {
	return link().clockOffsetMs;
}

/** The same, or null when it hasn't been measured since the app started. */
export function measuredClockOffsetMs(): number | null {
	return link().clockMeasured ? link().clockOffsetMs : null;
}

export type SyncReply<T> =
	| { ok: true; body: T }
	/** No pairing, or the server no longer knows this desktop. */
	| { ok: false; reason: "not-paired" }
	| { ok: false; reason: "offline" }
	| { ok: false; reason: "paused"; message: string }
	/** The server answered, but refused this request. */
	| { ok: false; reason: "refused"; status: number; code: string | null; error: string; body: Record<string, unknown> };

/**
 * One request to the paired server's sync API. Handles the three outcomes
 * every caller shares: the server unpaired this desktop (the key is dropped,
 * the device id kept), the protocol versions differ (sync pauses), and the
 * server can't be reached.
 */
export async function syncRequest<T = Record<string, unknown>>(
	pathname: string,
	init: { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown } = {},
	deps: SyncDeps = {},
): Promise<SyncReply<T>> {
	const pairing = activePairing();
	if (!pairing) return { ok: false, reason: "not-paired" };
	const now = deps.now ?? Date.now;
	const state = link();
	let response: Response;
	const sentAt = now();
	try {
		response = await (deps.fetch ?? fetch)(`${pairing.server}${pathname}`, {
			method: init.method ?? (init.body === undefined ? "GET" : "POST"),
			headers: {
				authorization: `Bearer ${pairing.key}`,
				[SYNC_PROTOCOL_HEADER]: String(SYNC_PROTOCOL_VERSION),
				...(init.body === undefined ? {} : { "content-type": "application/json" }),
			},
			body: init.body === undefined ? undefined : JSON.stringify(init.body),
			redirect: "error",
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch {
		state.offline = true;
		return { ok: false, reason: "offline" };
	}
	let body: Record<string, unknown> = {};
	try {
		const parsed: unknown = await response.json();
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
	} catch { /* an empty or non-JSON answer */ }
	const code = typeof body.code === "string" ? body.code : null;
	// Anything that isn't the server's own JSON (a proxy's error page, a
	// captive portal) counts as not reaching it.
	if (response.status >= 500 || (!response.ok && code === null && typeof body.error !== "string")) {
		state.offline = true;
		return { ok: false, reason: "offline" };
	}
	state.offline = false;
	state.lastContactAt = now();
	if (response.status === 401 && code === "not_paired") {
		// The server removed this desktop. Keep who we are, drop the dead key.
		const current = readCloudPairing();
		if (current && current.key === pairing.key) writeCloudPairing({ ...current, key: null });
		return { ok: false, reason: "not-paired" };
	}
	if (response.status === 409 && code === "protocol_mismatch" && typeof body.protocol === "number") {
		const verdict = protocolVerdict(SYNC_PROTOCOL_VERSION, body.protocol);
		if (!verdict.ok) {
			state.pause = verdict;
			return { ok: false, reason: "paused", message: verdict.message };
		}
	}
	if (!response.ok) {
		return { ok: false, reason: "refused", status: response.status, code, error: typeof body.error === "string" ? body.error : "The server refused the request.", body };
	}
	state.pause = null;
	if (typeof body.time === "number") {
		// Halfway through the round trip is the best guess at "the same moment".
		state.clockOffsetMs = Math.round(body.time - (sentAt + state.lastContactAt) / 2);
		state.clockMeasured = true;
	}
	return { ok: true, body: body as T };
}

/** The protocol check: is this desktop still paired, and do both sides match? */
export async function contactServer(deps: SyncDeps = {}): Promise<CloudStatus> {
	const reply = await syncRequest("/api/sync/hello", { method: "POST", body: {} }, deps);
	// A server from before sync existed has no such address: it is the side that is behind.
	if (!reply.ok && reply.reason === "refused" && (reply.status === 403 || reply.status === 404) && reply.code === null) {
		const verdict = protocolVerdict(SYNC_PROTOCOL_VERSION, 0);
		if (!verdict.ok) link().pause = verdict;
	}
	return cloudStatus();
}

export type PairResult = { ok: true; status: CloudStatus } | { ok: false; status: number; error: string };

/**
 * Pair this app with a server: the address, the code from the server's
 * site, and the name this desktop goes by. A desktop that was paired
 * before keeps its device id, so the server sees the same device again.
 */
export async function pairWithServer(input: { server: unknown; code: unknown; name: unknown }, deps: SyncDeps = {}): Promise<PairResult> {
	const address = normalizeServerAddress(input.server);
	if (!address.ok) return { ok: false, status: 400, error: address.error };
	const name = cleanDeviceName(input.name);
	if (!name) return { ok: false, status: 400, error: "Give this desktop a name of up to 40 characters." };
	if (typeof input.code !== "string" || !input.code.trim() || input.code.length > 64) return { ok: false, status: 400, error: "Enter the pairing code from the server's site." };
	const previous = readCloudPairing();
	// The same device only for the same server: another server never learns this id.
	const deviceId = previous && previous.server === address.url ? previous.deviceId : newDeviceId();
	let response: Response;
	try {
		response = await (deps.fetch ?? fetch)(`${address.url}/api/sync/pair`, {
			method: "POST",
			headers: { "content-type": "application/json", [SYNC_PROTOCOL_HEADER]: String(SYNC_PROTOCOL_VERSION) },
			body: JSON.stringify({ code: input.code, deviceId, name }),
			redirect: "error",
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch {
		return { ok: false, status: 502, error: "Couldn't reach that server. Check the address and your connection." };
	}
	let body: Record<string, unknown> = {};
	try {
		const parsed: unknown = await response.json();
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
	} catch { /* not JSON */ }
	if (!response.ok || typeof body.key !== "string") {
		const error = typeof body.error === "string" ? body.error : "That address didn't answer like a LearnHarness server.";
		return { ok: false, status: response.ok ? 502 : response.status, error };
	}
	const now = (deps.now ?? Date.now)();
	writeCloudPairing({ version: 1, deviceId, name, server: address.url, key: body.key, pairedAt: now });
	resetCloudLink();
	link().lastContactAt = now;
	return { ok: true, status: cloudStatus() };
}
