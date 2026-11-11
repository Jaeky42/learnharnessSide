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
 *   POST /api/sync/sessions          a paired desktop: "what changed since
 *                                    I last asked?" (slice 2)
 *   GET | PUT | DELETE /api/sync/sessions/<id>
 *                                    fetch a session's files, send them
 *                                    (the holder only), or delete it
 *   POST /api/sync/sessions/<id>/take   ask for a session (slice 3)
 *   GET | POST /api/sync/graph       the graph log (slice 4)
 *   POST /api/sync/maps              settings and the other files that
 *                                    sync one item at a time (slice 5)
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
import { MAX_BUNDLE_BYTES } from "../../core/sync/sessions.ts";
import { clientAddress, json, lockedMessage, notFound, readBody, serverModeEnabled, signedIn } from "../server-auth.ts";
import { syncAuthority } from "./engine.ts";
import { graphAuthority } from "./graph-engine.ts";
import { mapsAuthority } from "./maps-engine.ts";

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

// ─── Sessions (slice 2) ──────────────────────────────────────────────────────

/** A sync request's JSON body. Session files can be large, so no 8 KB cap here. */
async function syncBody(request: Request): Promise<unknown> {
	const length = Number(request.headers.get("content-length") ?? "0");
	if (length > MAX_BUNDLE_BYTES * 1.2) return undefined;
	try { return await request.json(); } catch { return undefined; }
}

/** The checks every session route shares; a Response means "refused". */
function syncCaller(request: Request): DeviceRecord | Response {
	if (!serverModeEnabled()) return notFound();
	const device = deviceFromRequest(request);
	if (!device) return json(NOT_PAIRED, 401);
	return protocolRefusal(request) ?? device;
}

export async function sessionsExchangeResponse(request: Request): Promise<Response> {
	const caller = syncCaller(request);
	if (caller instanceof Response) return caller;
	const reply = syncAuthority().exchange(caller.id, await syncBody(request));
	return json(reply.body, reply.status);
}

export async function sessionBundleResponse(request: Request, chatId: string): Promise<Response> {
	const caller = syncCaller(request);
	if (caller instanceof Response) return caller;
	const authority = syncAuthority();
	const reply = request.method === "GET" ? authority.fetch(caller.id, chatId)
		: request.method === "PUT" ? authority.store(caller.id, chatId, await syncBody(request))
		: request.method === "DELETE" ? authority.remove(caller.id, chatId)
		: { status: 405, body: { error: "Method not allowed." } };
	return json(reply.body, reply.status);
}

/** A paired desktop asks for a session another device (or the server) holds. */
export async function sessionTakeResponse(request: Request, chatId: string): Promise<Response> {
	const caller = syncCaller(request);
	if (caller instanceof Response) return caller;
	const body = (await syncBody(request)) as { force?: unknown } | undefined;
	const reply = syncAuthority().takeOver(caller.id, chatId, body?.force === true);
	return json(reply.body, reply.status);
}

// ─── The graph log (slice 4) ─────────────────────────────────────────────────

/** GET ?after=<seq>: the log entries a desktop hasn't seen. POST {after, entries}: its own. */
export async function graphLogResponse(request: Request): Promise<Response> {
	const caller = syncCaller(request);
	if (caller instanceof Response) return caller;
	if (request.method === "GET") {
		const params = new URL(request.url).searchParams;
		const reply = graphAuthority().pull(Number(params.get("after") ?? "x"), params.get("log"));
		return json(reply.body, reply.status);
	}
	const reply = graphAuthority().push(caller.id, await syncBody(request));
	return json(reply.body, reply.status);
}

// ─── Settings and the other small files (slice 5) ────────────────────────────

/** POST {cursor, all, changes, vaultFolders?}: one exchange of the files that sync item by item. */
export async function mapsExchangeResponse(request: Request): Promise<Response> {
	const caller = syncCaller(request);
	if (caller instanceof Response) return caller;
	const reply = mapsAuthority().exchange(caller.id, await syncBody(request));
	return json(reply.body, reply.status);
}
