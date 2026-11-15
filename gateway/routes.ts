/**
 * The gateway's routes (docs/multi-account-build.md "The gateway's own
 * routes"): each one `(Request, deps) => Promise<Response>`, so tests drive
 * them with a stand-in store, clock and relay. Shapes, statuses and refusal
 * texts follow today's single-copy routes (src/server/server-auth.ts), so
 * Settings → Account works against them unchanged; the new words come from
 * src/core/account-screens.ts.
 *
 * Every POST checks the same-site rule itself. A damaged state file answers
 * 503 everywhere it is needed (the site closes; it is never read as empty).
 *
 * The account lifecycle's routes (/invite, /reset, recovery codes,
 * delete-account, /api/accounts) are in ./account-routes.ts and
 * ./owner-routes.ts; ./main.ts serves them all (`ALL_ROUTES`).
 */

import {
	accountView,
	changePassword,
	claimOwner,
	createAccountSession,
	findAccountByTag,
	hasOwner,
	lockWait,
	markUnpairPending,
	recordWrongAttempt,
	removeSession,
	resolveSession,
	signIn,
	signOutEverywhere,
	tagFromPairingCode,
	touchSession,
	type AccountRecord,
	type GatewayState,
} from "../src/core/accounts.ts";
import { INVITE_TEXT, SETUP_TEXT, SIGN_IN_TEXT, tooManyAttempts } from "../src/core/account-screens.ts";
import { deviceLabel, SESSION_COOKIE } from "../src/core/server-auth.ts";
import { SYNC_PROTOCOL_HEADER } from "../src/core/sync/protocol.ts";
import type { GatewayConfig } from "./config.ts";
import { AnswerTooLarge, readCapped, type Relay, type Unpairer } from "./copies.ts";
import {
	clientAddress,
	copyOf,
	DAMAGED_TEXT,
	decideGate,
	findSessionCookie,
	foreignRequest,
	gateInputFrom,
	NO_STORE,
	publicBase,
	SAME_SITE_REFUSAL,
	sameOrigin,
	SIGN_IN_FIRST,
} from "./gate.ts";
import { htmlResponse, loginPageHtml, manifestResponse, setupPageHtml } from "./pages.ts";
import { StateDamagedError, type GatewayStore } from "./state.ts";

export interface RouteDeps {
	store: GatewayStore;
	config: GatewayConfig;
	now: () => number;
	relay: Relay;
	unpairer: Unpairer;
	log: (line: string) => void;
}

export type Handler<D extends RouteDeps = RouteDeps> = (request: Request, deps: D) => Promise<Response>;
export type RouteTable<D extends RouteDeps = RouteDeps> = Record<string, Partial<Record<"GET" | "POST", Handler<D>>>>;

// ─── Cookies ─────────────────────────────────────────────────────────────────

/** The cookie is set once, for 180 days; the gateway decides how long it counts (30 idle days, 180 in all). */
export const COOKIE_MAX_AGE_S = 180 * 24 * 60 * 60;
/** Plain marker: the page shows the owner's controls. Not a credential (the gateway checks the role). */
export const OWNER_MARKER_COOKIE = "lh_owner";

export const sessionCookie = (token: string): string => `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_S}`;
export const clearedSessionCookie = (): string => `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
export const ownerMarkerCookie = (): string => `${OWNER_MARKER_COOKIE}=1; Path=/; Secure; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_S}`;
export const clearedOwnerMarker = (): string => `${OWNER_MARKER_COOKIE}=; Path=/; Secure; SameSite=Lax; Max-Age=0`;

/** The cookies a sign-in sets: the session, and the owner marker set or cleared. */
export function signedInCookies(token: string, account: Pick<AccountRecord, "role">): string[] {
	return [sessionCookie(token), account.role === "owner" ? ownerMarkerCookie() : clearedOwnerMarker()];
}

export const signedOutCookies = (): string[] => [clearedSessionCookie(), clearedOwnerMarker()];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * On every answer that starts or ends a sign-in: a shared browser must not
 * show pages cached from the previous person's copy to the next one.
 */
export const CLEAR_SITE_CACHE: Record<string, string> = { "Clear-Site-Data": "\"cache\"" };

export function json(body: unknown, status = 200, cookies: string[] = [], extra: Record<string, string> = {}): Response {
	const headers = new Headers({ ...NO_STORE, "Content-Type": "application/json", ...extra });
	for (const cookie of cookies) headers.append("Set-Cookie", cookie);
	return new Response(JSON.stringify(body), { status, headers });
}

export const notFound = (): Response => json({ error: "Not found." }, 404);
const damaged = (): Response => json({ error: DAMAGED_TEXT }, 503);
const damagedPage = (): Response => new Response(DAMAGED_TEXT, { status: 503, headers: { ...NO_STORE, "Content-Type": "text/plain; charset=utf-8" } });

export function redirect(request: Request, to: string, config: Pick<GatewayConfig, "trustProxy">): Response {
	const base = publicBase(request.headers.get("host"), request.headers.get("x-forwarded-proto"), config.trustProxy);
	return new Response(null, { status: 303, headers: { ...NO_STORE, Location: base ? new URL(to, base).href : to } });
}

export const addressOf = (request: Request, config: Pick<GatewayConfig, "trustProxy">): string =>
	clientAddress(request.headers.get("x-forwarded-for"), config.trustProxy);

const originHeaders = (request: Request) => ({
	origin: request.headers.get("origin"),
	host: request.headers.get("host"),
	fetchSite: request.headers.get("sec-fetch-site"),
});

/** null when the write comes from this site; otherwise the copy's 403. */
export function sameSiteRefusal(request: Request): Response | null {
	return sameOrigin(request.method, originHeaders(request)) ? null : json({ error: SAME_SITE_REFUSAL }, 403);
}

/** Today's `readBody`: JSON objects of at most 8 KB. */
export async function readBody(request: Request): Promise<Record<string, unknown> | null> {
	if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return null;
	const text = await request.text();
	if (text.length > 8192) return null;
	try {
		const value = JSON.parse(text) as unknown;
		return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
	} catch {
		return null;
	}
}

/** The live session of an active account this request's cookie names, with the state it was read from. */
export function currentSession(request: Request, state: GatewayState, now: number) {
	return resolveSession(state, findSessionCookie(request.headers.get("cookie")), now);
}

const lockedReply = (waitMs: number) => ({ status: 429, error: tooManyAttempts(waitMs) });

type Outcome = { status: number; error: string; cookies?: string[] } | { status: 200; cookies: string[]; body?: Record<string, unknown>; clearSite?: true };

const reply = (outcome: Outcome): Response =>
	"error" in outcome ? json({ error: outcome.error }, outcome.status, outcome.cookies ?? []) : json(outcome.body ?? { ok: true }, 200, outcome.cookies, outcome.clearSite ? CLEAR_SITE_CACHE : {});

/** Runs a route body, closing the site on a damaged state file. */
async function guarded(run: () => Promise<Response>): Promise<Response> {
	try {
		return await run();
	} catch (error) {
		if (error instanceof StateDamagedError) return damaged();
		throw error;
	}
}

// ─── /gate ───────────────────────────────────────────────────────────────────

export const gateRoute: Handler = async (request, deps) => {
	const now = deps.now();
	const read = deps.store.read();
	const decision = decideGate(gateInputFrom(request.headers), read.ok ? read.state : null, deps.config, now);
	if (!("upstream" in decision)) return new Response(decision.body || null, { status: decision.status, headers: decision.headers });
	if (decision.touch) {
		const sessionId = decision.touch;
		// The answer stands on the state already validated; a failed write changes nothing about it.
		try { deps.store.update((state) => ({ state: touchSession(state, sessionId, now), result: undefined })); } catch { /* cosmetic */ }
	}
	return new Response(null, { status: 200, headers: { ...NO_STORE, "X-LH-Upstream": decision.upstream, "X-LH-Gate": decision.gateSecret, "X-LH-Scope": decision.scope } });
};

// ─── Pages ───────────────────────────────────────────────────────────────────

const isSignedIn = (request: Request, state: GatewayState, deps: RouteDeps): boolean => {
	const found = currentSession(request, state, deps.now());
	return !!found && copyOf(found.account, deps.config) !== null;
};

export const loginPage: Handler = async (request, deps) => {
	const read = deps.store.read();
	if (!read.ok) return damagedPage();
	if (!hasOwner(read.state)) return redirect(request, "/setup", deps.config);
	if (isSignedIn(request, read.state, deps)) return redirect(request, "/", deps.config);
	return htmlResponse(loginPageHtml());
};

export const setupPage: Handler = async (request, deps) => {
	const read = deps.store.read();
	if (!read.ok) return damagedPage();
	if (hasOwner(read.state)) return redirect(request, isSignedIn(request, read.state, deps) ? "/" : "/login", deps.config);
	return htmlResponse(setupPageHtml());
};

export const manifestRoute: Handler = async () => manifestResponse();

// ─── Signing in and out ──────────────────────────────────────────────────────

/** POST {code, name, password}: the first start, once. */
export const setupRoute: Handler = (request, deps) => guarded(async () => {
	const refused = sameSiteRefusal(request);
	if (refused) return refused;
	const body = await readBody(request);
	if (!body) return json({ error: "Expected JSON." }, 400);
	const now = deps.now();
	const address = addressOf(request, deps.config);
	const label = deviceLabel(request.headers.get("user-agent"));
	const outcome = deps.store.update<Outcome>((state) => {
		const claimed = claimOwner(state, { code: body.code, name: body.name, password: body.password, upstream: deps.config.ownerUpstream, gateSecret: deps.config.ownerGateSecret }, address, now);
		if (claimed.ok) {
			const created = createAccountSession(claimed.state, claimed.account.id, label, now);
			// The recovery codes, once: the setup page shows them (as the invite page does).
			return { state: created.state, result: { status: 200, cookies: signedInCookies(created.token, claimed.account), body: { codes: claimed.codes }, clearSite: true } };
		}
		const keep = claimed.state === state ? null : claimed.state;
		switch (claimed.code) {
			case "already-set-up": return { state: null, result: { status: 409, error: "A password is already set. Sign in instead." } };
			case "locked": return { state: keep, result: lockedReply(claimed.waitMs ?? 0) };
			case "setup-code-invalid": return { state: keep, result: { status: 401, error: SETUP_TEXT.wrongCode } };
			case "taken": return { state: keep, result: { status: 400, error: INVITE_TEXT.taken } };
			case "not-allowed":
			case "reserved": return { state: keep, result: { status: 400, error: SETUP_TEXT.nameNotAllowed } };
			case "password-problem": return { state: keep, result: { status: 400, error: claimed.message ?? "Enter a password." } };
		}
	});
	return reply(outcome);
});

/** POST {name, password}: sign in. One browser holds one account: a session it had goes. */
export const loginRoute: Handler = (request, deps) => guarded(async () => {
	const refused = sameSiteRefusal(request);
	if (refused) return refused;
	const body = await readBody(request);
	if (!body) return json({ error: "Expected JSON." }, 400);
	const now = deps.now();
	const address = addressOf(request, deps.config);
	const label = deviceLabel(request.headers.get("user-agent"));
	const previous = findSessionCookie(request.headers.get("cookie"));
	const outcome = deps.store.update<Outcome>((state) => {
		if (!hasOwner(state)) return { state: null, result: { status: 409, error: "No password is set yet. Use the setup page." } };
		const result = signIn(state, { name: body.name, password: body.password }, label, address, now);
		if (result.ok) {
			const old = resolveSession(state, previous, now) ?? null;
			const next = old && old.session.id !== result.session.id ? removeSession(result.state, old.session.id) : result.state;
			return { state: next, result: { status: 200, cookies: signedInCookies(result.token, result.account), clearSite: true } };
		}
		const keep = result.state === state ? null : result.state;
		switch (result.code) {
			case "locked": return { state: keep, result: lockedReply(result.waitMs ?? 0) };
			case "wrong": return { state: keep, result: { status: 401, error: SIGN_IN_TEXT.wrong } };
			case "paused": return { state: keep, result: { status: 403, error: SIGN_IN_TEXT.paused } };
			case "removed": return { state: keep, result: { status: 403, error: SIGN_IN_TEXT.removed } };
		}
	});
	return reply(outcome);
});

/** POST: sign out this browser. */
export const logoutRoute: Handler = (request, deps) => guarded(async () => {
	const refused = sameSiteRefusal(request);
	if (refused) return refused;
	const token = findSessionCookie(request.headers.get("cookie"));
	const now = deps.now();
	deps.store.update((state) => {
		const found = resolveSession(state, token, now);
		return { state: found ? removeSession(state, found.session.id) : null, result: undefined };
	});
	return json({ ok: true }, 200, signedOutCookies(), CLEAR_SITE_CACHE);
});

/** GET: Settings → Account. Today's `devices`, plus the name, the owner flag and the codes left. */
export const accountRoute: Handler = (request, deps) => guarded(async () => {
	const read = deps.store.read();
	if (!read.ok) return damaged();
	const now = deps.now();
	const found = currentSession(request, read.state, now);
	if (!found) return json({ error: SIGN_IN_FIRST }, 401);
	const view = accountView(read.state, found.account.id, found.session.id, now);
	if (!view) return json({ error: SIGN_IN_FIRST }, 401);
	return json({ devices: view.devices, name: view.name, owner: view.owner, recoveryCodesLeft: view.recoveryCodesLeft });
});

/** POST {current, next}: other devices are signed out and the desktop apps unpaired. */
export const passwordRoute: Handler = (request, deps) => guarded(async () => {
	const refused = sameSiteRefusal(request);
	if (refused) return refused;
	const body = await readBody(request);
	if (!body) return json({ error: "Expected JSON." }, 400);
	const now = deps.now();
	const address = addressOf(request, deps.config);
	const token = findSessionCookie(request.headers.get("cookie"));
	let unpair: string | null = null;
	const outcome = deps.store.update<Outcome>((state) => {
		const found = resolveSession(state, token, now);
		if (!found) return { state: null, result: { status: 401, error: SIGN_IN_FIRST } };
		const changed = changePassword(state, found.account.id, found.session.id, { current: body.current, next: body.next }, address, now);
		if (changed.ok) {
			unpair = found.account.id;
			return { state: markUnpairPending(changed.state, found.account.id), result: { status: 200, cookies: [] } };
		}
		const keep = changed.state === state ? null : changed.state;
		switch (changed.code) {
			case "locked": return { state: keep, result: lockedReply(changed.waitMs ?? 0) };
			case "wrong-password": return { state: keep, result: { status: 401, error: "Your current password is wrong." } };
			case "password-problem": return { state: keep, result: { status: 400, error: changed.message ?? "Enter a password." } };
			case "not-found": return { state: keep, result: { status: 401, error: SIGN_IN_FIRST } };
		}
	});
	if (unpair) await deps.unpairer.attempt(unpair);
	return reply(outcome);
});

/** POST: every session of this account ends, this one too; its desktop apps are unpaired. */
export const signOutEverywhereRoute: Handler = (request, deps) => guarded(async () => {
	const refused = sameSiteRefusal(request);
	if (refused) return refused;
	const token = findSessionCookie(request.headers.get("cookie"));
	const now = deps.now();
	const accountId = deps.store.update<string | null>((state) => {
		const found = resolveSession(state, token, now);
		if (!found) return { state: null, result: null };
		return { state: markUnpairPending(signOutEverywhere(state, found.account.id), found.account.id), result: found.account.id };
	});
	if (!accountId) return json({ error: SIGN_IN_FIRST }, 401);
	await deps.unpairer.attempt(accountId);
	return json({ ok: true }, 200, signedOutCookies(), CLEAR_SITE_CACHE);
});

// ─── Pairing a desktop app (slice 2b) ────────────────────────────────────────

/** The copy's own words for a wrong pairing code (src/server/sync/http.ts `pairResponse`). */
export const WRONG_PAIRING_CODE = "That pairing code isn't right, or it has run out. Get a new one from the server's site.";
export const PAIR_BODY_LIMIT = 8192;
/** The desktop app's headers the copy reads; never a cookie, never an Origin. */
const PAIR_FORWARDED_HEADERS = ["content-type", SYNC_PROTOCOL_HEADER, "user-agent"];

/**
 * POST {code, deviceId, name} from a desktop app: the code's tag names the
 * copy (8 characters: the owner's; 11: an account's). The body goes on to
 * that copy unchanged, through the relay with its secret and the client's
 * address, and the copy's answer comes back unchanged; the copy checks the
 * code and counts a wrong one in its own lockout. A code of no copy's shape
 * gets the copy's own refusal here, counted in the gateway's lockout.
 */
export const pairRoute: Handler = (request, deps) => guarded(async () => {
	if (foreignRequest(originHeaders(request))) return json({ error: "This request must come from a paired LearnHarness desktop app." }, 403);
	const bytes = new Uint8Array(await request.arrayBuffer());
	if (bytes.byteLength > PAIR_BODY_LIMIT) return json({ error: "Expected JSON." }, 400);
	let code: unknown;
	try {
		const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value)) return json({ error: "Expected JSON." }, 400);
		code = (value as Record<string, unknown>).code;
	} catch {
		return json({ error: "Expected JSON." }, 400);
	}
	const now = deps.now();
	const address = addressOf(request, deps.config);
	const read = deps.store.read();
	if (!read.ok) return damaged();
	const wait = lockWait(read.state, address, now);
	if (wait) return json({ error: tooManyAttempts(wait) }, 429);

	const tag = tagFromPairingCode(code);
	// No owner: the file is new or was lost. A tagged code may be an account
	// this file has forgotten; 503 (not counted) rather than "wrong code".
	if (tag.ok && tag.tag !== null && !hasOwner(read.state)) return new Response(null, { status: 503, headers: NO_STORE });
	const account = tag.ok ? findAccountByTag(read.state, tag.tag) : null;
	const known = tag.ok && (tag.tag === null || (!!account && account.role !== "owner" && account.state !== "deleting"));
	if (!known) {
		const waitMs = deps.store.update((state) => {
			const recorded = recordWrongAttempt(state, address, now);
			return { state: recorded.state, result: recorded.waitMs };
		});
		return waitMs ? json({ error: tooManyAttempts(waitMs) }, 429) : json({ error: WRONG_PAIRING_CODE }, 401);
	}

	let copy: { upstream: string; gateSecret: string } | null;
	if (tag.ok && tag.tag === null) {
		copy = account?.unpairPending ? null : { upstream: deps.config.ownerUpstream, gateSecret: deps.config.ownerGateSecret };
	} else {
		copy = account && account.state === "active" && !account.unpairPending ? copyOf(account, deps.config) : null;
	}
	if (!copy) return new Response(null, { status: 503, headers: NO_STORE });

	const headers: Record<string, string> = {};
	for (const name of PAIR_FORWARDED_HEADERS) {
		const value = request.headers.get(name);
		if (value !== null) headers[name] = value;
	}
	// Counted from the state read above with no await in between, so an
	// unpair-all asked for after that read waits for this forward to end.
	const endPairing = deps.unpairer.beginPairing(account?.id ?? "owner");
	try {
		let answer: Response;
		try {
			answer = await deps.relay.send({ ...copy, scope: "sync", clientAddress: address, method: "POST", path: "/api/sync/pair", headers, body: bytes });
		} catch {
			return new Response(null, { status: 503, headers: NO_STORE });
		}
		let data: Uint8Array<ArrayBuffer>;
		try {
			data = await readCapped(answer);
		} catch (error) {
			if (error instanceof AnswerTooLarge) return new Response(null, { status: 502, headers: NO_STORE });
			return new Response(null, { status: 503, headers: NO_STORE });
		}
		const out = new Headers(NO_STORE);
		const type = answer.headers.get("content-type");
		if (type) out.set("Content-Type", type);
		return new Response(data, { status: answer.status, headers: out });
	} finally {
		endPairing();
	}
});

// ─── The table ───────────────────────────────────────────────────────────────

export const healthRoute: Handler = async () => new Response("ok", { headers: { ...NO_STORE, "Content-Type": "text/plain; charset=utf-8" } });

export const BASE_ROUTES: RouteTable = {
	"/gate": { GET: gateRoute },
	"/healthz": { GET: healthRoute },
	"/login": { GET: loginPage },
	"/setup": { GET: setupPage },
	"/manifest.webmanifest": { GET: manifestRoute },
	"/api/server-auth/setup": { POST: setupRoute },
	"/api/server-auth/login": { POST: loginRoute },
	"/api/server-auth/logout": { POST: logoutRoute },
	"/api/server-auth/account": { GET: accountRoute },
	"/api/server-auth/password": { POST: passwordRoute },
	"/api/server-auth/sign-out-everywhere": { POST: signOutEverywhereRoute },
	"/api/sync/pair": { POST: pairRoute },
};

/** Picks the route by exact path and method; anything else is 404 (405 for a known path). */
export async function handleRequest<D extends RouteDeps>(request: Request, deps: D, routes: RouteTable<D> = BASE_ROUTES): Promise<Response> {
	const pathname = new URL(request.url).pathname;
	const route = Object.hasOwn(routes, pathname) ? routes[pathname] : undefined;
	if (!route) return notFound();
	const method = request.method === "HEAD" ? "GET" : request.method;
	const handler = method === "GET" || method === "POST" ? route[method] : undefined;
	if (!handler) return json({ error: "Method not allowed." }, 405);
	try {
		return await handler(request, deps);
	} catch (error) {
		if (error instanceof StateDamagedError) return damaged();
		deps.log(`[LearnHarness gateway] ${request.method} ${pathname} failed.`);
		return json({ error: "Something went wrong. Try again." }, 500);
	}
}
