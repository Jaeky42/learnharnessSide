/**
 * Server-mode login: the HTTP side (cloud sync Phase 1, docs/cloud-sync.md).
 *
 * Active only with LH_SERVER_MODE=1 (the Docker image sets it). Without it,
 * every export here is inert: the gate allows everything and the routes
 * answer 404, so the desktop app and local dev behave exactly as before.
 *
 *   gate        proxy.ts calls serverGate() for every request except
 *               static build files. No valid session → pages redirect to
 *               /login (or /setup before a password exists), APIs get 401.
 *               Every state-changing request must come from this site
 *               (Origin host = Host), the CSRF guard.
 *   routes      app/api/server-auth/{setup,login,logout,account,password,
 *               sign-out-everywhere} and the HTML pages app/{login,setup}.
 *   startup     instrumentation.ts → announceSetupCode() prints a fresh
 *               one-time setup code while no password is set.
 *
 * Client address for the lockout: with LH_TRUST_PROXY=1 (set in
 * deploy/compose.yaml, where Caddy is the only way in) the LAST
 * X-Forwarded-For entry, which Caddy writes; otherwise one shared bucket.
 */

import {
	clearFailures,
	createSession,
	deviceLabel,
	findSession,
	formatWait,
	hashPassword,
	liveSessions,
	lockedFor,
	newSetupCode,
	passwordProblem,
	recordFailure,
	removeOtherSessions,
	removeSession,
	SESSION_COOKIE,
	SESSION_LIFETIME_MS,
	setupCodeHash,
	setupCodeMatches,
	touchSession,
	verifyPassword,
	type ServerAuthState,
	type SessionRecord,
} from "../core/server-auth.ts";
import { readServerAuthState, updateServerAuthState } from "../store/server-auth.ts";
import { loginPageHtml, setupPageHtml } from "./server-auth-pages.ts";
import { bearerKey, findDevice, removeAllDevices, touchDevice } from "../core/sync/devices.ts";

type Env = Record<string, string | undefined>;

/** Readable by page scripts: says "this is the cloud server" so settings can
 *  show server-only controls. Carries no secret; the session cookie is separate. */
export const SERVER_MARKER_COOKIE = "lh_server";

export function serverModeEnabled(env: Env = process.env): boolean {
	return env.LH_SERVER_MODE === "1";
}

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const;

/** Paths reachable without a session. Everything else needs one. */
const PUBLIC_PAGES = new Set(["/login", "/setup"]);
const PUBLIC_APIS = new Set(["/api/server-auth/login", "/api/server-auth/setup"]);
// /_next/ is Next's own build output and dev live-reload socket: no user
// data. Gating the dev socket made every page reload in a loop.
const PUBLIC_PREFIXES = ["/_next/", "/fonts/", "/icons/"];
// The home-screen app's manifest and icons (cloud sync Phase 3): phones
// fetch them without the login cookie. They hold only the name and icon.
const PUBLIC_FILES = new Set(["/favicon.ico", "/robots.txt", "/manifest.webmanifest"]);

// ─── Request helpers ─────────────────────────────────────────────────────────

export function readSessionCookie(headers: Headers): string | null {
	const cookie = headers.get("cookie");
	if (!cookie) return null;
	for (const part of cookie.split(";")) {
		const index = part.indexOf("=");
		if (index > 0 && part.slice(0, index).trim() === SESSION_COOKIE) return part.slice(index + 1).trim() || null;
	}
	return null;
}

export function clientAddress(headers: Headers, env: Env = process.env): string {
	if (env.LH_TRUST_PROXY === "1") {
		const forwarded = headers.get("x-forwarded-for");
		const last = forwarded?.split(",").map((s) => s.trim()).filter(Boolean).pop();
		if (last && last.length <= 64) return last;
	}
	return "unknown";
}

/** The address the visitor actually used, for redirects. Behind Caddy
 *  (LH_TRUST_PROXY=1) the scheme comes from X-Forwarded-Proto, since the
 *  hop from Caddy to the container is plain HTTP. */
export function publicUrl(requestUrl: string, headers: Headers, env: Env = process.env): string {
	const url = new URL(requestUrl);
	const host = headers.get("host");
	// Setting host alone keeps the old port, so clear it first.
	if (host && /^[A-Za-z0-9.:[\]-]+$/.test(host)) { url.port = ""; url.host = host; }
	const proto = env.LH_TRUST_PROXY === "1" ? headers.get("x-forwarded-proto") : null;
	if (proto === "https" || proto === "http") url.protocol = `${proto}:`;
	return url.href;
}

/** Same-site write check: the request's Origin must name this host. */
export function sameOrigin(method: string, headers: Headers): boolean {
	if (["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) return true;
	if (headers.get("sec-fetch-site") === "cross-site") return false;
	const origin = headers.get("origin");
	const host = headers.get("host");
	if (!origin || !host) return false;
	try { return new URL(origin).host === host; } catch { return false; }
}

function sessionCookie(token: string): string {
	return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(SESSION_LIFETIME_MS / 1000)}`;
}

function clearedCookie(): string {
	return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
	return Response.json(body, { status, headers: { ...NO_STORE, ...extra } });
}

/** Next's proxy refuses relative redirects, so resolve against the request URL when given. */
function redirect(to: string, base?: string): Response {
	return new Response(null, { status: 303, headers: { ...NO_STORE, Location: base ? new URL(to, base).href : to } });
}

function html(body: string): Response {
	return new Response(body, {
		headers: {
			...NO_STORE,
			"Content-Type": "text/html; charset=utf-8",
			"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; manifest-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
			"Referrer-Policy": "no-referrer",
		},
	});
}

// ─── The gate ────────────────────────────────────────────────────────────────

function isPublic(pathname: string): boolean {
	return PUBLIC_PAGES.has(pathname) || PUBLIC_APIS.has(pathname) || PUBLIC_FILES.has(pathname) ||
		PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export interface GateInput {
	method: string;
	pathname: string;
	headers: Headers;
	/** The full request URL, for absolute redirects. */
	url?: string;
	now?: number;
	env?: Env;
	readState?: () => ServerAuthState;
	touch?: (sessionId: string, now: number) => void;
}

/** null = let the request through; otherwise the response to send instead. */
export function serverGate(input: GateInput): Response | null {
	const env = input.env ?? process.env;
	if (!serverModeEnabled(env)) return null;
	const now = input.now ?? Date.now();
	const isApi = input.pathname.startsWith("/api/");
	// The desktop app's sync API (cloud sync Phase 5) has its own door: a
	// device key, never the login cookie. Checked before the same-site rule,
	// because the desktop's requests come from a program, not from a page.
	if (isSyncPath(input.pathname)) return syncGate(input, now);
	if (!sameOrigin(input.method, input.headers)) {
		return json({ error: "This request must come from the LearnHarness site itself." }, 403);
	}
	if (isPublic(input.pathname)) return null;
	let state: ServerAuthState;
	try {
		state = (input.readState ?? readServerAuthState)();
	} catch {
		// Fail closed: a damaged login file never opens the site.
		return isApi
			? json({ error: "The server login file is damaged. Run reset-password on the server." }, 503)
			: new Response("The server login file is damaged. Run reset-password on the server.", { status: 503, headers: NO_STORE });
	}
	const session = findSession(state, readSessionCookie(input.headers), now);
	if (session) {
		(input.touch ?? touchStored)(session.id, now);
		return null;
	}
	if (isApi) return json({ error: "Sign in to LearnHarness first." }, 401);
	return redirect(state.password ? "/login" : "/setup", input.url && publicUrl(input.url, input.headers, env));
}

export function isSyncPath(pathname: string): boolean {
	return pathname === "/api/sync" || pathname.startsWith("/api/sync/");
}

/** Where a desktop app trades its pairing code for a key: no key yet. */
const SYNC_PAIR_PATH = "/api/sync/pair";

/**
 * The sync API's gate. A paired desktop's key opens these paths and nothing
 * else; a signed-in browser's cookie does NOT open them, so no page (ours or
 * anyone's) can drive sync through the learner's login.
 */
function syncGate(input: GateInput, now: number): Response | null {
	// A browser always names the site a cross-site request comes from.
	const origin = input.headers.get("origin");
	const host = input.headers.get("host");
	let foreign = input.headers.get("sec-fetch-site") === "cross-site";
	if (origin) {
		try { foreign ||= new URL(origin).host !== host; } catch { foreign = true; }
	}
	if (foreign) return json({ error: "This request must come from a paired LearnHarness desktop app." }, 403);
	if (input.pathname === SYNC_PAIR_PATH) return null;
	let state: ServerAuthState;
	try {
		state = (input.readState ?? readServerAuthState)();
	} catch {
		return json({ error: "The server login file is damaged. Run reset-password on the server." }, 503);
	}
	const device = findDevice(state, bearerKey(input.headers));
	if (!device) return json({ error: "This desktop app isn't paired with this server.", code: "not_paired" }, 401);
	try {
		updateServerAuthState((current) => ({ state: touchDevice(current, device.id, now), result: undefined }));
	} catch { /* last-seen time is cosmetic */ }
	return null;
}

function touchStored(sessionId: string, now: number): void {
	try {
		updateServerAuthState((state) => ({ state: touchSession(state, sessionId, now), result: undefined }));
	} catch { /* last-used time is cosmetic; never fail a request over it */ }
}

// ─── Pages ───────────────────────────────────────────────────────────────────

export function signedIn(request: Request, state: ServerAuthState, now: number): SessionRecord | null {
	return findSession(state, readSessionCookie(request.headers), now);
}

export function loginPageResponse(request: Request): Response {
	if (!serverModeEnabled()) return new Response("Not found", { status: 404 });
	const state = readServerAuthState();
	if (!state.password) return redirect("/setup", publicUrl(request.url, request.headers));
	if (signedIn(request, state, Date.now())) return redirect("/", publicUrl(request.url, request.headers));
	return html(loginPageHtml());
}

export function setupPageResponse(request: Request): Response {
	if (!serverModeEnabled()) return new Response("Not found", { status: 404 });
	const state = readServerAuthState();
	if (state.password) return redirect(signedIn(request, state, Date.now()) ? "/" : "/login", publicUrl(request.url, request.headers));
	return html(setupPageHtml());
}

// ─── API routes ──────────────────────────────────────────────────────────────

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

/** A login-type request ends with a new session token or an error to show. */
type Outcome = { status: number; error: string } | { status: 200; token: string };

export function lockedMessage(ms: number): string {
	return `Too many attempts. Try again in ${formatWait(ms)}.`;
}

export function notFound(): Response {
	return json({ error: "Not found." }, 404);
}

/** POST {code, password}: first-time setup. */
export async function setupResponse(request: Request, now = Date.now()): Promise<Response> {
	if (!serverModeEnabled()) return notFound();
	const body = await readBody(request);
	if (!body) return json({ error: "Expected JSON." }, 400);
	const address = clientAddress(request.headers);
	const label = deviceLabel(request.headers.get("user-agent"));
	const outcome = updateServerAuthState<Outcome>((state) => {
		if (state.password) return { state: null, result: { status: 409, error: "A password is already set. Sign in instead." } };
		const wait = lockedFor(state, address, now);
		if (wait) return { state: null, result: { status: 429, error: lockedMessage(wait) } };
		if (!setupCodeMatches(body.code, state.setupCodeHash)) {
			const next = recordFailure(state, address, now);
			const locked = lockedFor(next, address, now);
			return { state: next, result: { status: locked ? 429 : 401, error: locked ? lockedMessage(locked) : "That setup code isn't right. Check the server log for the current code." } };
		}
		const problem = passwordProblem(body.password);
		if (problem) return { state: null, result: { status: 400, error: problem } };
		const { state: withSession, token } = createSession(
			{ ...clearFailures(state, address), password: hashPassword(body.password as string), setupCodeHash: null },
			label, now,
		);
		return { state: withSession, result: { status: 200, token } };
	});
	if ("token" in outcome) return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(outcome.token) });
	return json({ error: outcome.error }, outcome.status);
}

/** POST {password}: sign in. */
export async function loginResponse(request: Request, now = Date.now()): Promise<Response> {
	if (!serverModeEnabled()) return notFound();
	const body = await readBody(request);
	if (!body) return json({ error: "Expected JSON." }, 400);
	const address = clientAddress(request.headers);
	const label = deviceLabel(request.headers.get("user-agent"));
	const outcome = updateServerAuthState<Outcome>((state) => {
		if (!state.password) return { state: null, result: { status: 409, error: "No password is set yet. Use the setup page." } };
		const wait = lockedFor(state, address, now);
		if (wait) return { state: null, result: { status: 429, error: lockedMessage(wait) } };
		if (typeof body.password !== "string" || !verifyPassword(body.password, state.password)) {
			const next = recordFailure(state, address, now);
			const locked = lockedFor(next, address, now);
			return { state: next, result: { status: locked ? 429 : 401, error: locked ? lockedMessage(locked) : "Wrong password." } };
		}
		const { state: withSession, token } = createSession(clearFailures(state, address), label, now);
		return { state: withSession, result: { status: 200, token } };
	});
	if ("token" in outcome) return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(outcome.token) });
	return json({ error: outcome.error }, outcome.status);
}

/** POST: sign out this device. */
export async function logoutResponse(request: Request, now = Date.now()): Promise<Response> {
	if (!serverModeEnabled()) return notFound();
	const token = readSessionCookie(request.headers);
	updateServerAuthState((state) => {
		const session = findSession(state, token, now);
		return { state: session ? removeSession(state, session.id) : null, result: undefined };
	});
	return json({ ok: true }, 200, { "Set-Cookie": clearedCookie() });
}

/** GET: the Account tab's data. 404 outside server mode (the tab hides). */
export function accountResponse(request: Request, now = Date.now()): Response {
	if (!serverModeEnabled()) return notFound();
	const state = readServerAuthState();
	const current = signedIn(request, state, now);
	if (!current) return json({ error: "Sign in to LearnHarness first." }, 401);
	const devices = liveSessions(state, now)
		.sort((a, b) => b.lastSeenAt - a.lastSeenAt)
		.map((s) => ({ id: s.id, label: s.label, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, expiresAt: s.expiresAt, current: s.id === current.id }));
	// Paired desktop apps (cloud sync Phase 5). The key itself is never sent.
	const desktops = state.devices
		.slice()
		.sort((a, b) => b.pairedAt - a.pairedAt)
		.map((d) => ({ id: d.id, name: d.name, pairedAt: d.pairedAt, lastSeenAt: d.lastSeenAt }));
	return json({ devices, desktops });
}

/** POST {current, next}: change the password; other devices are signed out. */
export async function changePasswordResponse(request: Request, now = Date.now()): Promise<Response> {
	if (!serverModeEnabled()) return notFound();
	const body = await readBody(request);
	if (!body) return json({ error: "Expected JSON." }, 400);
	const address = clientAddress(request.headers);
	const token = readSessionCookie(request.headers);
	const outcome = updateServerAuthState<{ status: number; error: string }>((state) => {
		const session = findSession(state, token, now);
		if (!session || !state.password) return { state: null, result: { status: 401, error: "Sign in to LearnHarness first." } };
		const wait = lockedFor(state, address, now);
		if (wait) return { state: null, result: { status: 429, error: lockedMessage(wait) } };
		if (typeof body.current !== "string" || !verifyPassword(body.current, state.password)) {
			const next = recordFailure(state, address, now);
			const locked = lockedFor(next, address, now);
			return { state: next, result: { status: locked ? 429 : 401, error: locked ? lockedMessage(locked) : "Your current password is wrong." } };
		}
		const problem = passwordProblem(body.next);
		if (problem) return { state: null, result: { status: 400, error: problem } };
		// Other devices are signed out, paired desktop apps included (owner's rule).
		const next = removeAllDevices(removeOtherSessions({ ...clearFailures(state, address), password: hashPassword(body.next as string) }, session.id));
		return { state: next, result: { status: 200, error: "" } };
	});
	return outcome.status === 200 ? json({ ok: true }) : json({ error: outcome.error }, outcome.status);
}

/** POST: end every login, this device included. */
export async function signOutEverywhereResponse(request: Request, now = Date.now()): Promise<Response> {
	if (!serverModeEnabled()) return notFound();
	const token = readSessionCookie(request.headers);
	const ok = updateServerAuthState((state) => {
		if (!findSession(state, token, now)) return { state: null, result: false };
		return { state: removeAllDevices(removeOtherSessions(state, null)), result: true };
	});
	if (!ok) return json({ error: "Sign in to LearnHarness first." }, 401);
	return json({ ok: true }, 200, { "Set-Cookie": clearedCookie() });
}

// ─── Startup ─────────────────────────────────────────────────────────────────

/** While no password is set, store a fresh setup code and print it. */
export function announceSetupCode(log: (line: string) => void = console.log): void {
	if (!serverModeEnabled()) return;
	try {
		const code = updateServerAuthState((state) => {
			if (state.password) return { state: null, result: null };
			const fresh = newSetupCode();
			return { state: { ...state, setupCodeHash: setupCodeHash(fresh) }, result: fresh };
		});
		if (code) {
			log("[LearnHarness] No password is set yet.");
			log(`[LearnHarness] Setup code: ${code}`);
			log("[LearnHarness] Open the site, enter this code and choose a password.");
		}
	} catch {
		log("[LearnHarness] The server login file is damaged. Run reset-password on the server.");
	}
}
