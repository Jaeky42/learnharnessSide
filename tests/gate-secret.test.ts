/**
 * Multi-account, slice 1c (docs/multi-account-build.md): a copy behind the
 * gateway. With server mode and LH_GATE_SECRET set, the copy's whole gate is
 * "does X-LH-Gate equal the secret" (constant time), sync paths then run the
 * device-key gate as before, the copy's own account routes and pages answer
 * 404, no setup code is printed, server-login.json is left as it is, and
 * POST /api/internal/unpair-all exists only in this mode.
 *
 * Mode off is today's behaviour; the full proof of that is
 * tests/server-auth.test.ts passing untouched. LH_AUTH_FILE is redirected to
 * a temp dir BEFORE the first config import.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-gate-secret-"));
process.env.LH_AUTH_FILE = path.join(TMP, "secrets", "auth.json");
process.env.LH_DATA_DIR = path.join(TMP, "data");
delete process.env.LH_GATE_SECRET;

const core = await import("../src/core/server-auth.ts");
const devices = await import("../src/core/sync/devices.ts");
const store = await import("../src/store/server-auth.ts");
const server = await import("../src/server/server-auth.ts");
const syncHttp = await import("../src/server/sync/http.ts");
const { SYNC_PROTOCOL_HEADER, SYNC_PROTOCOL_VERSION } = await import("../src/core/sync/protocol.ts");
const unpairAllRoute = await import("../app/api/internal/unpair-all/route.ts");
const { proxy } = await import("../proxy.ts");
const { NextRequest } = await import("next/server");

const FILE = store.serverLoginFile();
const ORIGIN = "https://learn.example.com";
const HOST = "learn.example.com";
const SECRET = "k3Jq9XvT0pLw8ZrB2mN5sY7dF1gH4cE6aQ-uViOtRe_";
const MODE_ON = { LH_SERVER_MODE: "1", LH_GATE_SECRET: SECRET };

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

beforeEach(() => fs.rmSync(path.join(TMP, "secrets"), { recursive: true, force: true }));

/** Runs with these variables in process.env (for the routes, which read it). */
async function withEnv<T>(vars: Record<string, string | undefined>, run: () => T | Promise<T>): Promise<T> {
	const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
	for (const [key, value] of Object.entries(vars)) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
	try { return await run(); } finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
	}
}

const gated = (headers: Record<string, string> = {}) => ({ host: HOST, [server.GATE_HEADER]: SECRET, ...headers });

function gate(pathname: string, init: { method?: string; headers?: Record<string, string>; env?: Record<string, string> } = {}) {
	return server.serverGate({ method: init.method ?? "GET", pathname, headers: new Headers({ host: HOST, ...init.headers }), env: init.env ?? MODE_ON, touch: () => {} });
}

function request(pathname: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Request {
	const method = init.method ?? (init.body === undefined ? "GET" : "POST");
	return new Request(ORIGIN + pathname, {
		method,
		headers: { host: HOST, ...(init.body === undefined ? {} : { "content-type": "application/json", origin: ORIGIN }), ...init.headers },
		body: init.body === undefined ? undefined : JSON.stringify(init.body),
	});
}

/** A server-login file with a password, one signed-in browser and one paired desktop. */
function stateWithLoginAndDesktop(now = Date.now()): { token: string; key: string } {
	const base = { ...core.emptyServerAuthState(), password: core.hashPassword("longenough") };
	const { state, token } = core.createSession(base, "Chrome on Windows", now);
	const paired = devices.completePairing(state, devices.newDeviceId(), "Desktop", now);
	assert.ok(paired.ok);
	store.writeServerAuthState(paired.state);
	return { token, key: paired.key };
}

const fileText = () => (fs.existsSync(FILE) ? fs.readFileSync(FILE, "utf8") : null);

const PAGE = "/chat/abc";
const CASES: { name: string; pathname: string; method?: string; headers?: Record<string, string> }[] = [
	{ name: "a page", pathname: PAGE },
	{ name: "the home page", pathname: "/" },
	{ name: "an API read", pathname: "/api/settings" },
	{ name: "an API write", pathname: "/api/chats", method: "POST", headers: { origin: ORIGIN } },
	{ name: "a public file", pathname: "/favicon.ico" },
	{ name: "the manifest", pathname: "/manifest.webmanifest" },
	{ name: "an icon", pathname: "/icons/icon-192.png" },
	{ name: "a static file", pathname: "/_next/static/chunks/a.js" },
	{ name: "the login page", pathname: "/login" },
	{ name: "the login API", pathname: "/api/server-auth/login", method: "POST", headers: { origin: ORIGIN } },
];

describe("which mode", () => {
	it("on only with server mode and a non-empty secret; the desktop app ignores the variable", () => {
		assert.equal(server.behindGateway(MODE_ON), true);
		assert.equal(server.behindGateway({ LH_SERVER_MODE: "1", LH_GATE_SECRET: "short" }), true, "a short secret is still the mode (and refuses everything)");
		assert.equal(server.behindGateway({ LH_SERVER_MODE: "1", LH_GATE_SECRET: "" }), false);
		assert.equal(server.behindGateway({ LH_SERVER_MODE: "1" }), false);
		assert.equal(server.behindGateway({ LH_GATE_SECRET: SECRET }), false);
		assert.equal(gate(PAGE, { env: { LH_GATE_SECRET: SECRET } }), null, "no server mode: no gate, as before");
	});

	it("mode off: the header changes nothing and the old login gate decides", () => {
		const off = { LH_SERVER_MODE: "1" };
		assert.equal(gate(PAGE, { env: off, headers: gated() })?.headers.get("location"), "/setup");
		assert.equal(gate("/api/settings", { env: off, headers: gated() })?.status, 401);
		const empty = { LH_SERVER_MODE: "1", LH_GATE_SECRET: "" };
		assert.equal(gate(PAGE, { env: empty, headers: { [server.GATE_HEADER]: "" } })?.headers.get("location"), "/setup");
		const { token } = stateWithLoginAndDesktop();
		assert.equal(gate(PAGE, { env: off, headers: { cookie: `${core.SESSION_COOKIE}=${token}` } }), null, "a cookie still signs in");
	});
});

describe("mode on: the gate", () => {
	it("the right secret passes every kind of request, with no login file at all", () => {
		for (const c of CASES) assert.equal(gate(c.pathname, { method: c.method, headers: gated(c.headers) }), null, c.name);
		assert.equal(fileText(), null, "the gate neither reads a session nor writes the login file");
	});

	it("a missing, wrong, empty, prefix, longer or re-cased secret is refused everywhere", () => {
		const wrong: [string, Record<string, string>][] = [
			["missing", {}],
			["empty", { [server.GATE_HEADER]: "" }],
			["wrong", { [server.GATE_HEADER]: "x".repeat(SECRET.length) }],
			["a prefix", { [server.GATE_HEADER]: SECRET.slice(0, -1) }],
			["longer", { [server.GATE_HEADER]: `${SECRET}x` }],
			["re-cased", { [server.GATE_HEADER]: SECRET.toUpperCase() }],
			["two values", { [server.GATE_HEADER]: `${SECRET}, ${SECRET}` }],
		];
		for (const [label, headers] of wrong) {
			for (const c of CASES) {
				const refused = gate(c.pathname, { method: c.method, headers: { ...c.headers, ...headers } });
				assert.ok(refused, `${label}: ${c.name}`);
				if (c.pathname.startsWith("/api/")) assert.equal(refused.status, 401, `${label}: ${c.name}`);
				else {
					assert.equal(refused.status, 403, `${label}: ${c.name}`);
					assert.equal(refused.headers.get("location"), null, "never a redirect to /login: the gateway owns it");
				}
			}
		}
	});

	it("an API refusal is today's JSON; a page refusal is a bare 403; neither echoes the secret", async () => {
		const api = gate("/api/settings", { headers: { [server.GATE_HEADER]: "nope" } })!;
		assert.deepEqual(await api.json(), { error: "Sign in to LearnHarness first." });
		const page = gate(PAGE, { headers: { [server.GATE_HEADER]: "nope" } })!;
		assert.equal(await page.text(), "");
		const passed = await withEnv(MODE_ON, () => proxy(new NextRequest(ORIGIN + PAGE, { headers: gated() })));
		for (const [, value] of passed.headers) assert.ok(!value.includes(SECRET), "no response header carries the secret");
	});

	it("a configured secret shorter than 32 characters refuses every request, even with that value", () => {
		const short = SECRET.slice(0, 31);
		const env = { LH_SERVER_MODE: "1", LH_GATE_SECRET: short };
		for (const c of CASES) {
			assert.equal(gate(c.pathname, { method: c.method, env, headers: { ...c.headers, [server.GATE_HEADER]: short } })?.status, 503, c.name);
		}
		assert.equal(gate("/api/sync/hello", { env, headers: { [server.GATE_HEADER]: short } })?.status, 503);
		assert.equal(gate("/api/internal/unpair-all", { method: "POST", env, headers: { [server.GATE_HEADER]: short } })?.status, 503);
		assert.equal(server.gatePasses(new Headers({ [server.GATE_HEADER]: short }), env), false);
		const exact = { LH_SERVER_MODE: "1", LH_GATE_SECRET: SECRET.slice(0, 32) };
		assert.equal(gate(PAGE, { env: exact, headers: { [server.GATE_HEADER]: SECRET.slice(0, 32) } }), null, "32 characters is enough");
	});

	it("a valid session cookie without the secret is refused", () => {
		const { token } = stateWithLoginAndDesktop();
		const cookie = { cookie: `${core.SESSION_COOKIE}=${token}` };
		assert.equal(gate(PAGE, { headers: cookie })?.status, 403);
		assert.equal(gate("/api/settings", { headers: cookie })?.status, 401);
	});

	it("the same-site write rule stays as a second lock; the gateway's internal calls carry no Origin", () => {
		assert.equal(gate("/api/chats", { method: "POST", headers: gated({ origin: "https://evil.example" }) })?.status, 403);
		assert.equal(gate("/api/chats", { method: "POST", headers: gated() })?.status, 403, "no Origin on a write");
		assert.equal(gate("/api/internal/unpair-all", { method: "POST", headers: gated() }), null);
	});

	it("sync paths: the secret first, then today's device-key gate", async () => {
		const { key } = stateWithLoginAndDesktop();
		const noKey = gate("/api/sync/hello", { method: "POST", headers: gated() })!;
		assert.equal(noKey.status, 401);
		assert.equal((await noKey.json()).code, "not_paired", "today's refusal, which the desktop app understands");
		assert.equal(gate("/api/sync/hello", { method: "POST", headers: gated({ authorization: `Bearer ${key}` }) }), null);
		const noSecret = gate("/api/sync/hello", { method: "POST", headers: { authorization: `Bearer ${key}` } })!;
		assert.equal(noSecret.status, 503, "a 5xx: the desktop app reads it as offline and keeps its key");
		assert.equal(gate("/api/sync/pair", { method: "POST", headers: gated() }), null, "pairing still needs no key at the gate");
		assert.equal(gate("/api/sync/pair", { method: "POST" })?.status, 503);
		assert.equal(gate("/api/sync/hello", { method: "POST", headers: gated({ authorization: `Bearer ${key}`, origin: "https://evil.example" }) })?.status, 403, "the sync gate's own cross-site rule");
	});

	it("through the proxy: the secret passes and the marker cookie is set as today; without it, refused", async () => {
		await withEnv(MODE_ON, () => {
			const ok = proxy(new NextRequest(ORIGIN + PAGE, { headers: gated() }));
			assert.equal(ok.headers.get("x-middleware-next"), "1");
			assert.match(ok.headers.get("set-cookie") ?? "", /lh_server=1/);
			const refused = proxy(new NextRequest(ORIGIN + PAGE, { headers: { host: HOST } }));
			assert.equal(refused.status, 403);
			assert.equal(proxy(new NextRequest(ORIGIN + "/api/settings", { headers: { host: HOST } })).status, 401);
		});
	});
});

describe("mode on: the copy's own account routes", () => {
	it("answer 404 (the gateway owns those paths), with the secret, and leave the login file as it is", async () => {
		const { token } = stateWithLoginAndDesktop();
		const before = fileText();
		const headers = gated({ cookie: `${core.SESSION_COOKIE}=${token}` });
		await withEnv(MODE_ON, async () => {
			const answers = [
				await server.setupResponse(request("/api/server-auth/setup", { headers, body: { code: "0000-0000", password: "longenough" } })),
				await server.loginResponse(request("/api/server-auth/login", { headers, body: { password: "longenough" } })),
				await server.logoutResponse(request("/api/server-auth/logout", { headers, body: {} })),
				server.accountResponse(request("/api/server-auth/account", { headers })),
				await server.changePasswordResponse(request("/api/server-auth/password", { headers, body: { current: "longenough", next: "brand-new-pass" } })),
				await server.signOutEverywhereResponse(request("/api/server-auth/sign-out-everywhere", { headers, body: {} })),
				server.loginPageResponse(request("/login", { headers })),
				server.setupPageResponse(request("/setup", { headers })),
			];
			assert.deepEqual(answers.map((a) => a.status), Array(8).fill(404));
			for (const a of answers) assert.equal(a.headers.get("set-cookie"), null);
		});
		assert.equal(fileText(), before, "password, sessions and desktops untouched");
	});

	it("no setup code is printed and no login file is created", async () => {
		await withEnv(MODE_ON, () => {
			const lines: string[] = [];
			server.announceSetupCode((line) => lines.push(line));
			assert.deepEqual(lines, []);
		});
		assert.equal(fileText(), null);
		await withEnv({ LH_SERVER_MODE: "1", LH_GATE_SECRET: "short" }, () => {
			const lines: string[] = [];
			server.announceSetupCode((line) => lines.push(line));
			assert.deepEqual(lines, []);
		});
		assert.equal(fileText(), null);
	});
});

describe("mode on: signedIn", () => {
	it("the secret is the proof; a cookie alone is not", async () => {
		const { token } = stateWithLoginAndDesktop();
		const state = store.readServerAuthState();
		const now = Date.now();
		await withEnv(MODE_ON, () => {
			assert.equal(server.signedIn(request(PAGE, { headers: gated() }), core.emptyServerAuthState(), now), true);
			assert.equal(server.signedIn(request(PAGE, { headers: { cookie: `${core.SESSION_COOKIE}=${token}` } }), state, now), false);
			assert.equal(server.signedIn(request(PAGE, { headers: { [server.GATE_HEADER]: "nope" } }), state, now), false);
		});
		await withEnv({ LH_SERVER_MODE: "1", LH_GATE_SECRET: undefined }, () => {
			assert.equal(server.signedIn(request(PAGE, { headers: { cookie: `${core.SESSION_COOKIE}=${token}` } }), state, now), true, "mode off: the cookie, as today");
			assert.equal(server.signedIn(request(PAGE, { headers: gated() }), state, now), false);
		});
	});

	it("pairing codes and Remove work with the secret and no cookie, on a copy with no password of its own", async () => {
		await withEnv(MODE_ON, async () => {
			const made = await syncHttp.desktopsResponse(request("/api/server-auth/desktops", { headers: gated(), body: { op: "code" } }));
			assert.equal(made.status, 200);
			assert.match((await made.json()).code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
			const refused = await syncHttp.desktopsResponse(request("/api/server-auth/desktops", { body: { op: "code" } }));
			assert.equal(refused.status, 401);
		});
		assert.equal(store.readServerAuthState().password, null, "no password was made for it");
	});

	it("a desktop pairs through the gate on the owner's copy (which has its password) and then syncs", async () => {
		stateWithLoginAndDesktop();
		await withEnv(MODE_ON, async () => {
			const made = await syncHttp.desktopsResponse(request("/api/server-auth/desktops", { headers: gated(), body: { op: "code" } }));
			const { code } = await made.json();
			const pairHeaders = gated({ "content-type": "application/json" });
			assert.equal(gate("/api/sync/pair", { method: "POST", headers: pairHeaders }), null);
			const paired = await syncHttp.pairResponse(new Request(ORIGIN + "/api/sync/pair", { method: "POST", headers: pairHeaders, body: JSON.stringify({ code, deviceId: devices.newDeviceId(), name: "Laptop" }) }));
			assert.equal(paired.status, 200);
			const { key } = await paired.json();
			const hello = gated({ authorization: `Bearer ${key}`, [SYNC_PROTOCOL_HEADER]: String(SYNC_PROTOCOL_VERSION) });
			assert.equal(gate("/api/sync/hello", { method: "POST", headers: hello }), null);
			assert.equal(syncHttp.helloResponse(new Request(ORIGIN + "/api/sync/hello", { method: "POST", headers: hello })).status, 200);
		});
	});
});

describe("POST /api/internal/unpair-all", () => {
	const call = (headers: Record<string, string>) => unpairAllRoute.POST(new Request(ORIGIN + "/api/internal/unpair-all", { method: "POST", headers: { host: HOST, ...headers } }));

	it("with the secret: every paired desktop and a waiting code are gone; sessions and password stay", async () => {
		const { token } = stateWithLoginAndDesktop();
		await withEnv(MODE_ON, async () => {
			const made = await syncHttp.desktopsResponse(request("/api/server-auth/desktops", { headers: gated(), body: { op: "code" } }));
			assert.equal(made.status, 200);
			assert.equal(gate("/api/internal/unpair-all", { method: "POST", headers: gated() }), null);
			const answer = await call(gated());
			assert.equal(answer.status, 200);
			assert.deepEqual(await answer.json(), { ok: true });
		});
		const state = store.readServerAuthState();
		assert.deepEqual(state.devices, []);
		assert.equal(state.pairing, null);
		assert.ok(state.password, "the copy's own password is left as it is");
		assert.ok(core.findSession(state, token, Date.now()), "its own sessions too");
		await withEnv(MODE_ON, async () => assert.equal((await call(gated())).status, 200, "nothing to remove is fine"));
	});

	it("refused without the secret, at the gate and inside the route", async () => {
		stateWithLoginAndDesktop();
		const before = fileText();
		assert.equal(gate("/api/internal/unpair-all", { method: "POST" })?.status, 401);
		await withEnv(MODE_ON, async () => {
			assert.equal((await call({})).status, 404);
			assert.equal((await call({ [server.GATE_HEADER]: "nope" })).status, 404);
		});
		assert.equal(fileText(), before);
	});

	it("404 when the mode is off: a single-copy server, even signed in, and the desktop app", async () => {
		const { token } = stateWithLoginAndDesktop();
		const before = fileText();
		const cookie = { cookie: `${core.SESSION_COOKIE}=${token}`, origin: ORIGIN };
		const single = { LH_SERVER_MODE: "1" };
		assert.equal(gate("/api/internal/unpair-all", { method: "POST", env: single, headers: cookie })?.status, 404);
		assert.equal(gate("/api/internal/anything-else", { env: single, headers: cookie })?.status, 404);
		assert.equal(gate("/api/internal/unpair-all", { method: "POST", env: {}, headers: gated() })?.status, 404, "the desktop app");
		await withEnv({ LH_SERVER_MODE: "1", LH_GATE_SECRET: undefined }, async () => {
			assert.equal((await call({ ...cookie, [server.GATE_HEADER]: SECRET })).status, 404);
			assert.equal(proxy(new NextRequest(ORIGIN + "/api/internal/unpair-all", { method: "POST", headers: { host: HOST, ...cookie } })).status, 404);
		});
		await withEnv({ LH_SERVER_MODE: undefined, LH_GATE_SECRET: SECRET }, async () => {
			assert.equal((await call(gated())).status, 404);
		});
		assert.equal(fileText(), before);
		assert.equal(store.readServerAuthState().devices.length, 1);
	});
});
