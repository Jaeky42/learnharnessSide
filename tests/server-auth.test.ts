/**
 * Server-mode login (side-tutor fork, cloud sync Phase 1; docs/cloud-sync.md).
 *
 * Pins the approved rules: 8+ character passwords, a fixed 30-day login,
 * 5 wrong attempts → 15 min pause doubling to 24 h, the one-time setup code,
 * password change signing out other devices, Sign out everywhere, the gate
 * (pages redirect, APIs 401, cross-site writes refused), the reset script's
 * parity with the core, and that nothing changes without LH_SERVER_MODE.
 *
 * LH_AUTH_FILE is redirected to a temp dir BEFORE the first config import.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-server-auth-"));
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");

const core = await import("../src/core/server-auth.ts");
const store = await import("../src/store/server-auth.ts");
const server = await import("../src/server/server-auth.ts");
const reset = await import("../scripts/server-reset-password.mjs");
const { isSensitivePath, resolveSourcePath } = await import("../src/agent/tools/fs-shared.ts");
const { proxy } = await import("../proxy.ts");
const { NextRequest } = await import("next/server");

const FILE = store.serverLoginFile();
const ORIGIN = "https://learn.example.com";
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function withServerMode<T>(run: () => T): T {
	const previous = process.env.LH_SERVER_MODE;
	process.env.LH_SERVER_MODE = "1";
	try { return run(); } finally {
		if (previous === undefined) delete process.env.LH_SERVER_MODE; else process.env.LH_SERVER_MODE = previous;
	}
}

async function withServerModeAsync<T>(run: () => Promise<T>): Promise<T> {
	const previous = process.env.LH_SERVER_MODE;
	process.env.LH_SERVER_MODE = "1";
	try { return await run(); } finally {
		if (previous === undefined) delete process.env.LH_SERVER_MODE; else process.env.LH_SERVER_MODE = previous;
	}
}

function post(pathname: string, body: unknown, cookie?: string, extra: Record<string, string> = {}): Request {
	return new Request(ORIGIN + pathname, {
		method: "POST",
		headers: { "content-type": "application/json", origin: ORIGIN, host: "learn.example.com", "user-agent": "Mozilla/5.0 (iPhone) Safari/605.1", ...(cookie ? { cookie } : {}), ...extra },
		body: JSON.stringify(body),
	});
}

function cookieFrom(response: Response): string {
	const header = response.headers.get("set-cookie") ?? "";
	return header.split(";")[0] ?? "";
}

/** Fresh server with a known setup code. */
function freshWithCode(): string {
	const code = core.newSetupCode();
	store.writeServerAuthState({ ...core.emptyServerAuthState(), setupCodeHash: core.setupCodeHash(code) });
	return code;
}

describe("core rules", () => {
	it("passwords: at least 8 characters, hashed with scrypt, verified exactly", () => {
		assert.equal(core.passwordProblem("short12"), "Use at least 8 characters.");
		assert.equal(core.passwordProblem("12345678"), null);
		assert.equal(core.passwordProblem(42), "Enter a password.");
		const hash = core.hashPassword("correct horse");
		assert.equal(hash.algorithm, "scrypt");
		assert.ok(!JSON.stringify(hash).includes("correct horse"));
		assert.ok(core.verifyPassword("correct horse", hash));
		assert.ok(!core.verifyPassword("correct horsE", hash));
	});

	it("a login lasts a fixed 30 days; using it never extends that", () => {
		const t0 = 1_000_000_000_000;
		const { state, token, session } = core.createSession(core.emptyServerAuthState(), "Safari on iPhone", t0);
		assert.equal(session.expiresAt - session.createdAt, 30 * DAY);
		assert.ok(!JSON.stringify(state).includes(token), "the token itself is never stored");
		const touched = core.touchSession(state, session.id, t0 + 29 * DAY)!;
		assert.equal(touched.sessions[0]?.expiresAt, t0 + 30 * DAY, "use does not extend the login");
		assert.ok(core.findSession(touched, token, t0 + 30 * DAY - 1));
		assert.equal(core.findSession(touched, token, t0 + 30 * DAY), null);
	});

	it("lockout: 5 wrong attempts pause 15 min, then 30, 1 h … capped at 24 h; a quiet day forgets", () => {
		let state = core.emptyServerAuthState();
		let now = 2_000_000_000_000;
		const waits: number[] = [];
		for (let round = 0; round < 9; round++) {
			for (let i = 0; i < 4; i++) {
				state = core.recordFailure(state, "1.2.3.4", now);
				assert.equal(core.lockedFor(state, "1.2.3.4", now), 0, "attempts 1–4 are not paused");
			}
			state = core.recordFailure(state, "1.2.3.4", now);
			const wait = core.lockedFor(state, "1.2.3.4", now);
			waits.push(wait);
			assert.equal(core.lockedFor(state, "5.6.7.8", now), 0, "other addresses are unaffected");
			now += wait; // wait it out, then fail again (within a day)
		}
		assert.deepEqual(waits.slice(0, 4), [15 * MIN, 30 * MIN, HOUR, 2 * HOUR]);
		assert.equal(Math.max(...waits), 24 * HOUR);
		// A full day without failures starts over at 15 minutes.
		now += 24 * HOUR;
		for (let i = 0; i < 5; i++) state = core.recordFailure(state, "1.2.3.4", now);
		assert.equal(core.lockedFor(state, "1.2.3.4", now), 15 * MIN);
		assert.equal(core.formatWait(15 * MIN), "15 min");
		assert.equal(core.formatWait(90 * MIN), "1 h 30 min");
	});

	it("setup codes: XXXX-XXXX, typed back in any case or spacing", () => {
		const code = core.newSetupCode();
		assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
		const hash = core.setupCodeHash(code);
		assert.ok(core.setupCodeMatches(code.toLowerCase().replace("-", " "), hash));
		assert.ok(!core.setupCodeMatches("0000-0000", hash));
		assert.ok(!core.setupCodeMatches(code, null));
	});

	it("reset-password script uses the same setup-code rules as the server", () => {
		const code = reset.newSetupCode();
		assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
		assert.equal(reset.setupCodeHash(code), core.setupCodeHash(code));
		assert.equal(reset.setupCodeHash("ab cd-ef12"), core.setupCodeHash("ABCDEF12"));
		assert.equal(reset.serverLoginFile(process.env), FILE);
	});

	it("device labels read like a person would name them", () => {
		assert.equal(core.deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit Version/18.0 Mobile Safari/604.1"), "Safari on iPhone");
		assert.equal(core.deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36"), "Chrome on Windows");
		assert.equal(core.deviceLabel("Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36 Edg/130.0"), "Edge on Windows");
		assert.equal(core.deviceLabel(null), "Unknown device");
	});
});

describe("store", () => {
	beforeEach(() => fs.rmSync(FILE, { force: true }));

	it("absent = no password yet; written at mode 0600 next to auth.json", () => {
		assert.deepEqual(store.readServerAuthState(), core.emptyServerAuthState());
		store.writeServerAuthState(core.emptyServerAuthState());
		assert.equal(path.dirname(FILE), TMP);
		if (process.platform !== "win32") assert.equal(fs.statSync(FILE).mode & 0o777, 0o600);
	});

	it("a damaged file throws (fail closed) instead of reading as empty", () => {
		fs.writeFileSync(FILE, "{not json");
		assert.throws(() => store.readServerAuthState());
		fs.writeFileSync(FILE, JSON.stringify({ version: 99 }));
		assert.throws(() => store.readServerAuthState());
	});

	it("agents' file tools refuse the login file and its temp files", () => {
		store.writeServerAuthState(core.emptyServerAuthState());
		assert.equal(isSensitivePath(FILE), true);
		assert.equal(isSensitivePath(`${FILE}.tmp-123e4567-e89b-42d3-a456-426614174000`), true);
		assert.throws(() => resolveSourcePath(FILE));
	});
});

describe("HTTP flow (server mode)", () => {
	beforeEach(() => fs.rmSync(FILE, { force: true }));

	it("startup prints a setup code that the setup page accepts once", async () => {
		await withServerModeAsync(async () => {
			const lines: string[] = [];
			server.announceSetupCode((line) => lines.push(line));
			const code = /Setup code: (\S+)/.exec(lines.join("\n"))?.[1];
			assert.ok(code, "a setup code is printed");
			const wrong = await server.setupResponse(post("/api/server-auth/setup", { code: "0000-0000", password: "longenough" }));
			assert.equal(wrong.status, 401);
			const tooShort = await server.setupResponse(post("/api/server-auth/setup", { code, password: "short" }));
			assert.equal(tooShort.status, 400);
			const ok = await server.setupResponse(post("/api/server-auth/setup", { code, password: "longenough" }));
			assert.equal(ok.status, 200);
			const cookie = ok.headers.get("set-cookie") ?? "";
			assert.match(cookie, /^__Host-lh_session=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000$/);
			const again = await server.setupResponse(post("/api/server-auth/setup", { code, password: "longenough" }));
			assert.equal(again.status, 409, "setup works only once");
			const restarted: string[] = [];
			server.announceSetupCode((line) => restarted.push(line));
			assert.deepEqual(restarted, [], "no code is printed once a password exists");
		});
	});

	it("login: wrong password counts toward the pause; right password signs in", async () => {
		await withServerModeAsync(async () => {
			const code = freshWithCode();
			await server.setupResponse(post("/api/server-auth/setup", { code, password: "longenough" }));
			const ip = { "x-forwarded-for": "9.9.9.9" };
			process.env.LH_TRUST_PROXY = "1";
			try {
				for (let i = 0; i < 4; i++) assert.equal((await server.loginResponse(post("/api/server-auth/login", { password: "nope-nope" }, undefined, ip))).status, 401);
				const fifth = await server.loginResponse(post("/api/server-auth/login", { password: "nope-nope" }, undefined, ip));
				assert.equal(fifth.status, 429);
				assert.match((await fifth.json()).error, /Try again in 15 min/);
				const blocked = await server.loginResponse(post("/api/server-auth/login", { password: "longenough" }, undefined, ip));
				assert.equal(blocked.status, 429, "even the right password waits out the pause");
				const elsewhere = await server.loginResponse(post("/api/server-auth/login", { password: "longenough" }, undefined, { "x-forwarded-for": "8.8.8.8" }));
				assert.equal(elsewhere.status, 200, "other addresses can still sign in");
			} finally {
				delete process.env.LH_TRUST_PROXY;
			}
		});
	});

	it("changing the password signs out every other device; sign out everywhere ends all", async () => {
		await withServerModeAsync(async () => {
			const code = freshWithCode();
			const phone = cookieFrom(await server.setupResponse(post("/api/server-auth/setup", { code, password: "longenough" })));
			const laptop = cookieFrom(await server.loginResponse(post("/api/server-auth/login", { password: "longenough" })));
			const account = server.accountResponse(new Request(ORIGIN + "/api/server-auth/account", { headers: { cookie: phone } }));
			assert.equal((await account.json()).devices.length, 2);

			const wrong = await server.changePasswordResponse(post("/api/server-auth/password", { current: "bad-bad-bad", next: "brand-new-pass" }, phone));
			assert.equal(wrong.status, 401);
			const changed = await server.changePasswordResponse(post("/api/server-auth/password", { current: "longenough", next: "brand-new-pass" }, phone));
			assert.equal(changed.status, 200);
			const state = store.readServerAuthState();
			assert.equal(state.sessions.length, 1, "only the device that changed it stays signed in");
			assert.equal(core.findSession(state, laptop.split("=")[1], Date.now()), null);
			assert.ok(core.findSession(state, phone.split("=")[1], Date.now()));
			assert.equal((await server.loginResponse(post("/api/server-auth/login", { password: "longenough" }))).status, 401);

			const out = await server.signOutEverywhereResponse(post("/api/server-auth/sign-out-everywhere", {}, phone));
			assert.equal(out.status, 200);
			assert.match(out.headers.get("set-cookie") ?? "", /Max-Age=0/);
			assert.equal(store.readServerAuthState().sessions.length, 0);
		});
	});

	it("sign out ends only this device's login", async () => {
		await withServerModeAsync(async () => {
			const code = freshWithCode();
			const phone = cookieFrom(await server.setupResponse(post("/api/server-auth/setup", { code, password: "longenough" })));
			const laptop = cookieFrom(await server.loginResponse(post("/api/server-auth/login", { password: "longenough" })));
			const out = await server.logoutResponse(post("/api/server-auth/logout", {}, phone));
			assert.equal(out.status, 200);
			assert.match(out.headers.get("set-cookie") ?? "", /Max-Age=0/);
			const state = store.readServerAuthState();
			assert.equal(core.findSession(state, phone.split("=")[1], Date.now()), null);
			assert.ok(core.findSession(state, laptop.split("=")[1], Date.now()), "other devices stay signed in");
		});
	});

	it("reset-password removes the password and every login, and issues a working code", async () => {
		await withServerModeAsync(async () => {
			const code = freshWithCode();
			await server.setupResponse(post("/api/server-auth/setup", { code, password: "longenough" }));
			const fresh = reset.resetServerPassword(FILE);
			const state = store.readServerAuthState();
			assert.equal(state.password, null);
			assert.equal(state.sessions.length, 0);
			const ok = await server.setupResponse(post("/api/server-auth/setup", { code: fresh, password: "another-pass" }));
			assert.equal(ok.status, 200);
		});
	});
});

describe("gate", () => {
	beforeEach(() => fs.rmSync(FILE, { force: true }));

	const gate = (pathname: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
		server.serverGate({ method: init.method ?? "GET", pathname, headers: new Headers({ host: "learn.example.com", ...init.headers }), env: { LH_SERVER_MODE: "1" }, touch: () => {} });

	it("before setup: pages go to /setup; APIs answer 401; login pages and static files are open", () => {
		assert.equal(gate("/chat/new")?.headers.get("location"), "/setup");
		assert.equal(gate("/api/settings")?.status, 401);
		for (const open of ["/setup", "/login", "/_next/static/chunks/a.js", "/_next/hmr", "/fonts/x.woff2", "/favicon.ico"]) assert.equal(gate(open), null, open);
	});

	it("after setup: no cookie → /login; a valid cookie passes; an expired one doesn't", () => {
		const t0 = Date.now();
		const base = { ...core.emptyServerAuthState(), password: core.hashPassword("longenough") };
		const { state, token } = core.createSession(base, "Chrome on Windows", t0);
		store.writeServerAuthState(state);
		assert.equal(gate("/")?.headers.get("location"), "/login");
		assert.equal(gate("/", { headers: { cookie: `${core.SESSION_COOKIE}=${token}` } }), null);
		assert.equal(gate("/api/settings", { headers: { cookie: `${core.SESSION_COOKIE}=${token}` } }), null);
		const later = server.serverGate({ method: "GET", pathname: "/", headers: new Headers({ cookie: `${core.SESSION_COOKIE}=${token}` }), env: { LH_SERVER_MODE: "1" }, now: t0 + 30 * DAY, touch: () => {} });
		assert.equal(later?.headers.get("location"), "/login");
	});

	it("writes must come from this site, signed in or not", () => {
		assert.equal(gate("/api/server-auth/login", { method: "POST", headers: { origin: "https://evil.example" } })?.status, 403);
		assert.equal(gate("/api/server-auth/login", { method: "POST" })?.status, 403, "no Origin header");
		assert.equal(gate("/api/server-auth/login", { method: "POST", headers: { origin: ORIGIN, "sec-fetch-site": "cross-site" } })?.status, 403);
		assert.equal(gate("/api/server-auth/login", { method: "POST", headers: { origin: ORIGIN } }), null);
	});

	it("a damaged login file closes the site instead of opening it", () => {
		fs.writeFileSync(FILE, "{broken");
		assert.equal(gate("/")?.status, 503);
		assert.equal(gate("/api/chats")?.status, 503);
	});

	it("without server mode nothing changes: no gate, routes 404, pages pass the proxy", async () => {
		assert.equal(server.serverGate({ method: "POST", pathname: "/chat/new", headers: new Headers(), env: {} }), null);
		assert.equal((await server.loginResponse(post("/api/server-auth/login", { password: "x" }))).status, 404);
		assert.equal(server.accountResponse(new Request(ORIGIN + "/api/server-auth/account")).status, 404);
		assert.equal(proxy(new NextRequest("http://127.0.0.1:3000/chat/new")).headers.get("x-middleware-next"), "1");
	});

	it("redirects use the address the visitor used (https behind Caddy)", () => {
		const headers = new Headers({ host: "learn.example.com", "x-forwarded-proto": "https" });
		assert.equal(server.publicUrl("http://0.0.0.0:3000/chat/new", headers, { LH_TRUST_PROXY: "1" }), "https://learn.example.com/chat/new");
		assert.equal(server.publicUrl("http://0.0.0.0:3000/chat/new", headers, {}), "http://learn.example.com/chat/new", "forwarded scheme ignored unless trusted");
	});

	it("the proxy applies the gate in server mode", () => {
		withServerMode(() => {
			const response = proxy(new NextRequest("https://learn.example.com/chat/new", { headers: { host: "learn.example.com" } }));
			assert.equal(response.status, 303);
			assert.equal(response.headers.get("location"), "https://learn.example.com/setup");
		});
	});
});
