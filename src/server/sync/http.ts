/**
 * Cloud sync (Phase 5, docs/cloud-sync.md): the SERVER's side of pairing.
 *
 *   POST /api/server-auth/desktops   signed-in browser: {op:"code"} makes a
 *                                    pairing code, {op:"remove", id} unpairs
 *                                    one desktop. (The list of desktops rides
 *                                    on GET /api/server-auth/account.)
 *   POST /api/sync/pair              a desktop app: {code, deviceId, name}
 *                                    → its device key. Wrong codes count
 *                                    toward the login lockout.
 *   POST /api/sync/hello             a paired desktop: the protocol check.
 *
 * Everything answers 404 outside server mode. The gate for /api/sync/* is
 * syncGate in server-auth.ts: a device key, never the login cookie.
 */

import {
	clearFailures,
	lockedFor,
	recordFailure,
	type DeviceRecord,
} from "../../core/server-auth.ts";
import {
	bearerKey,
	cleanDeviceName,
	completePairing,
	findDevice,
	isDeviceId,
	MAX_DEVICES,
	pairingCodeMatches,
	removeDevice,
	startPairing,
} from "../../core/sync/devices.ts";
import { parseProtocolHeader, protocolVerdict, SYNC_PROTOCOL_HEADER, SYNC_PROTOCOL_VERSION } from "../../core/sync/protocol.ts";
import { readServerAuthState, updateServerAuthState } from "../../store/server-auth.ts";
import { clientAddress, json, lockedMessage, notFound, readBody, serverModeEnabled, signedIn } from "../server-auth.ts";

const NOT_PAIRED = { error: "This desktop app isn't paired with this server.", code: "not_paired" } as const;

/** The paired desktop a sync request comes from, or null. */
export function deviceFromRequest(request: Request): DeviceRecord | null {
	try {
		return findDevice(readServerAuthState(), bearerKey(request.headers));
	} catch {
		return null;
	}
}

/** null when the request speaks this server's protocol; otherwise the refusal. */
export function protocolRefusal(request: Request): Response | null {
	const theirs = parseProtocolHeader(request.headers.get(SYNC_PROTOCOL_HEADER));
	if (theirs === null) return json({ error: "The sync protocol version is missing.", code: "protocol_missing" }, 400);
	const verdict = protocolVerdict(theirs, SYNC_PROTOCOL_VERSION);
	if (verdict.ok) return null;
	return json({ error: verdict.message, code: "protocol_mismatch", protocol: SYNC_PROTOCOL_VERSION }, 409);
}

/** Signed-in browser: make a pairing code, or unpair one desktop. */
export async function desktopsResponse(request: Request, now = Date.now()): Promise<Response> {
	if (!serverModeEnabled()) return notFound();
	const body = await readBody(request);
	if (!body) return json({ error: "Expected JSON." }, 400);
	type Outcome = { status: number; body: Record<string, unknown> };
	const outcome = updateServerAuthState<Outcome>((state) => {
		if (!signedIn(request, state, now)) return { state: null, result: { status: 401, body: { error: "Sign in to LearnHarness first." } } };
		if (body.op === "code") {
			if (state.devices.length >= MAX_DEVICES) {
				return { state: null, result: { status: 409, body: { error: `This server already has ${MAX_DEVICES} desktop apps paired. Remove one first.` } } };
			}
			const started = startPairing(state, now);
			return { state: started.state, result: { status: 200, body: { code: started.code, expiresAt: started.expiresAt } } };
		}
		if (body.op === "remove") {
			if (typeof body.id !== "string" || !state.devices.some((d) => d.id === body.id)) {
				return { state: null, result: { status: 404, body: { error: "That desktop app isn't paired any more." } } };
			}
			return { state: removeDevice(state, body.id), result: { status: 200, body: { ok: true } } };
		}
		return { state: null, result: { status: 400, body: { error: "Unknown action." } } };
	});
	return json(outcome.body, outcome.status);
}

/** A desktop app trades the pairing code for its own key. */
export async function pairResponse(request: Request, now = Date.now()): Promise<Response> {
	if (!serverModeEnabled()) return notFound();
	const body = await readBody(request);
	if (!body) return json({ error: "Expected JSON." }, 400);
	const name = cleanDeviceName(body.name);
	if (!isDeviceId(body.deviceId) || !name) return json({ error: "The desktop app sent a pairing request this server can't read." }, 400);
	const deviceId = body.deviceId;
	const address = clientAddress(request.headers);
	type Outcome = { status: number; body: Record<string, unknown> };
	const outcome = updateServerAuthState<Outcome>((state) => {
		if (!state.password) return { state: null, result: { status: 409, body: { error: "This server isn't set up yet. Open its site and choose a password first." } } };
		const wait = lockedFor(state, address, now);
		if (wait) return { state: null, result: { status: 429, body: { error: lockedMessage(wait) } } };
		if (!pairingCodeMatches(state, body.code, now)) {
			const next = recordFailure(state, address, now);
			const locked = lockedFor(next, address, now);
			return {
				state: next,
				result: {
					status: locked ? 429 : 401,
					body: { error: locked ? lockedMessage(locked) : "That pairing code isn't right, or it has run out. Get a new one from the server's site." },
				},
			};
		}
		const paired = completePairing(clearFailures(state, address), deviceId, name, now);
		if (!paired.ok) {
			return { state: null, result: { status: 409, body: { error: `This server already has ${MAX_DEVICES} desktop apps paired. Remove one first.` } } };
		}
		return {
			state: paired.state,
			result: { status: 200, body: { key: paired.key, device: { id: paired.device.id, name: paired.device.name }, protocol: SYNC_PROTOCOL_VERSION } },
		};
	});
	return json(outcome.body, outcome.status);
}

/** A paired desktop's first word of every sync: who am I to you, and do we speak the same protocol? */
export function helloResponse(request: Request, now = Date.now()): Response {
	if (!serverModeEnabled()) return notFound();
	const device = deviceFromRequest(request);
	if (!device) return json(NOT_PAIRED, 401);
	const refusal = protocolRefusal(request);
	if (refusal) return refusal;
	return json({ protocol: SYNC_PROTOCOL_VERSION, time: now, device: { id: device.id, name: device.name } });
}
