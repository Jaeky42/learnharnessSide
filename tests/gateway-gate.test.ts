/**
 * Multi-account, slices 1b and 2b (docs/multi-account-build.md "What /gate
 * decides"): the gateway's `/gate` decision, a pure function, in its six
 * steps and every branch. The point of it all: one person's cookie or key
 * never yields another person's copy or secret, and nothing a client sends
 * in an X-LH-* header is ever read.
 *
 * The small rules the gateway repeats from the copy (sync, public and
 * internal paths, the same-site write rule, the client's address) are
 * checked against the copy's own functions on tables of cases.
 *
 * LH_AUTH_FILE / LH_DATA_DIR are redirected before the copy's modules load.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-gateway-gate-"));
process.env.LH_AUTH_FILE = path.join(TMP, "secrets", "auth.json");
process.env.LH_DATA_DIR = path.join(TMP, "data");
delete process.env.LH_GATE_SECRET;

const acc = await import("../src/core/accounts.ts");
const core = await import("../src/core/server-auth.ts");
const gate = await import("../gateway/gate.ts");
const copyAuth = await import("../src/server/server-auth.ts");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const NOW = Date.UTC(2026, 10, 15, 12, 0);
const HOST = "learn.example.com";
const ORIGIN = `https://${HOST}`;
const OWNER_UP = "lh:3000";
const OWNER_SECRET = "o".repeat(40);
const CONFIG = { ownerUpstream: OWNER_UP, ownerGateSecret: OWNER_SECRET, trustProxy: true };
// The gate never verifies a password; a placeholder record keeps scrypt out of this file.
const PW: import("../src/core/server-auth.ts").PasswordHash = { algorithm: "scrypt", N: 16384, r: 8, p: 1, salt: "c2FsdA", hash: "aGFzaA" };
const OWNER_KEY = "A".repeat(43);
const keyFor = (tag: string) => `${tag}${"b".repeat(43)}`;

function account(over: Partial<import("../src/core/accounts.ts").AccountRecord> & { name: string }): import("../src/core/accounts.ts").AccountRecord {
	return {
		id: `acct_${over.name}`, tag: null, nameKey: over.name.toLowerCase(), password: PW, recoveryCodes: [],
		role: "member", state: "active", createdAt: NOW - 10 * DAY, lastSeenAt: null, removedAt: null,
		upstream: `lh-acct-${over.tag ?? "x"}:3000`, gateSecret: `secret-of-${over.name}-${"z".repeat(24)}`, ...over,
	};
}

/** Owner "boss" (no tag), members "sam" (7KQ), "kim" (M9X), "lee" (paused, P2P), "rob" (removed, R0B), "dan" (deleting, D4N), "new" (no copy yet, N3W). */
function fixture() {
	let state: import("../src/core/accounts.ts").GatewayState = {
		...acc.emptyGatewayState(),
		accounts: [
			account({ name: "boss", role: "owner", tag: null, upstream: "stale:3000", gateSecret: "stale-secret" }),
			account({ name: "sam", tag: "7KQ" }),
			account({ name: "kim", tag: "M9X" }),
			account({ name: "lee", tag: "P2P", state: "paused" }),
			account({ name: "rob", tag: "R0B", state: "removed", removedAt: NOW - DAY }),
			account({ name: "dan", tag: "D4N", state: "deleting" }),
			account({ name: "new", tag: "N3W", upstream: null, gateSecret: null }),
		],
	};
	const tokens: Record<string, string> = {};
	for (const name of ["boss", "sam", "kim"]) {
		const made = acc.createAccountSession(state, `acct_${name}`, "Chrome on Windows", NOW - MIN);
		state = made.state;
		tokens[name] = made.token;
	}
	return { state, tokens };
}

const cookieOf = (token: string) => `${core.SESSION_COOKIE}=${token}`;

function input(over: Partial<import("../gateway/gate.ts").GateInput> = {}): import("../gateway/gate.ts").GateInput {
	return { method: "GET", uri: "/", host: HOST, cookie: null, authorization: null, origin: null, fetchSite: null, proto: "https", ...over };
}

function decide(over: Partial<import("../gateway/gate.ts").GateInput>, state: import("../src/core/accounts.ts").GatewayState | null = fixture().state, now = NOW) {
	return gate.decideGate(input(over), state, CONFIG, now);
}

function routed(decision: import("../gateway/gate.ts").GateDecision): { upstream: string; gateSecret: string } {
	assert.equal(decision.status, 200);
	assert.ok("upstream" in decision);
	return { upstream: decision.upstream, gateSecret: decision.gateSecret };
}

function refused(decision: import("../gateway/gate.ts").GateDecision, status: number): { headers: Record<string, string>; body: string } {
	assert.equal(decision.status, status);
	assert.ok(!("upstream" in decision), "a refusal never names a copy");
	return decision as { headers: Record<string, string>; body: string };
}

const sam = () => fixture().state.accounts.find((a) => a.name === "sam")!;
const kim = () => fixture().state.accounts.find((a) => a.name === "kim")!;

describe("step 1: /api/internal/* is never reachable", () => {
	it("answers 404, signed in or with a key", () => {
		const { tokens } = fixture();
		for (const uri of ["/api/internal", "/api/internal/unpair-all", "/api/internal/x?y=1"]) {
			const r = refused(decide({ uri }), 404);
			assert.deepEqual(JSON.parse(r.body), { error: "Not found." });
			refused(decide({ uri, method: "POST", origin: ORIGIN, cookie: cookieOf(tokens.boss!) }), 404);
			refused(decide({ uri, authorization: `Bearer ${OWNER_KEY}` }), 404);
		}
	});
});

describe("step 2: sync paths are sorted by the key's tag", () => {
	const sync = (authorization: string | null, extra: Partial<import("../gateway/gate.ts").GateInput> = {}, state?: import("../src/core/accounts.ts").GatewayState | null) =>
		decide({ uri: "/api/sync/hello", method: "POST", authorization, ...extra }, state === undefined ? fixture().state : state);

	it("a 43-character key goes to the owner's copy, with the secret from the settings (not a stored one)", () => {
		assert.deepEqual(routed(sync(`Bearer ${OWNER_KEY}`)), { upstream: OWNER_UP, gateSecret: OWNER_SECRET });
	});

	it("an older key keeps working before the owner has claimed the gateway (the PC paired before the switch)", () => {
		assert.deepEqual(routed(sync(`Bearer ${OWNER_KEY}`, {}, acc.emptyGatewayState())), { upstream: OWNER_UP, gateSecret: OWNER_SECRET });
	});

	it("a 46-character key goes to its tag's copy, and only there", () => {
		assert.deepEqual(routed(sync(`Bearer ${keyFor("7KQ")}`)), { upstream: sam().upstream, gateSecret: sam().gateSecret });
		assert.deepEqual(routed(sync(`Bearer ${keyFor("M9X")}`)), { upstream: kim().upstream, gateSecret: kim().gateSecret });
	});

	it("a key with its tag changed to another account's goes to THAT account's copy, never to the first one's", () => {
		// sam's key with kim's tag: routed to kim's copy, whose own device-key
		// check refuses it (the hash covers all 46 characters). sam's secret is
		// never handed out for it.
		const samKey = keyFor("7KQ");
		const changed = `M9X${samKey.slice(3)}`;
		const r = routed(sync(`Bearer ${changed}`));
		assert.equal(r.upstream, kim().upstream);
		assert.notEqual(r.gateSecret, sam().gateSecret);
		assert.notEqual(r.upstream, sam().upstream);
	});

	it("a paused, removed-and-kept, not-yet-made or unpair-pending account answers 503 (the app keeps its key)", () => {
		for (const tag of ["P2P", "R0B", "N3W"]) refused(sync(`Bearer ${keyFor(tag)}`), 503);
		const pending = acc.markUnpairPending(fixture().state, "acct_sam");
		refused(sync(`Bearer ${keyFor("7KQ")}`, {}, pending), 503);
		const ownerPending = acc.markUnpairPending(fixture().state, "acct_boss");
		refused(sync(`Bearer ${OWNER_KEY}`, {}, ownerPending), 503);
		assert.equal(routed(sync(`Bearer ${keyFor("M9X")}`, {}, pending)).upstream, kim().upstream, "another account is unaffected");
	});

	it("no key, another shape, an unknown tag or an account being deleted: 401 not_paired, the copy's own body", async () => {
		const copyBody = await (copyAuth.serverGate({ method: "POST", pathname: "/api/sync/hello", headers: new Headers({ host: HOST, authorization: `Bearer ${OWNER_KEY}` }), env: { LH_SERVER_MODE: "1" }, readState: () => core.emptyServerAuthState() }) as Response).json();
		assert.deepEqual(JSON.parse(JSON.stringify(gate.NOT_PAIRED_BODY)), copyBody);
		for (const authorization of [null, "Bearer ", `Bearer ${"A".repeat(44)}`, `Bearer ${"A".repeat(42)}`, `Bearer ${"A".repeat(20)}`, `Bearer ${keyFor("ZZZ")}`, `Bearer ${keyFor("D4N")}`, `Bearer ${keyFor("7kq")}`, `Basic ${OWNER_KEY}`, OWNER_KEY, `Bearer ${"!".repeat(43)}`]) {
			const r = refused(sync(authorization), 401);
			assert.deepEqual(JSON.parse(r.body), copyBody, String(authorization));
		}
	});

	it("reads no cookie and applies no same-site rule there", () => {
		const { tokens } = fixture();
		refused(sync(null, { cookie: cookieOf(tokens.sam!) }), 401);
		assert.equal(routed(sync(`Bearer ${keyFor("7KQ")}`, { cookie: cookieOf(tokens.kim!) })).upstream, sam().upstream);
		assert.equal(routed(sync(`Bearer ${OWNER_KEY}`, { origin: "https://evil.example", fetchSite: "cross-site" })).upstream, OWNER_UP);
	});

	it("a damaged state file: 503", () => {
		refused(sync(`Bearer ${OWNER_KEY}`, {}, null), 503);
	});
});

describe("step 3: icons and build files", () => {
	it("go to the owner's copy signed out; the manifest is not among them", () => {
		for (const uri of ["/favicon.ico", "/robots.txt", "/_next/static/chunks/app/chat/%5Bid%5D/page.js", "/fonts/a.woff2", "/icons/icon-192.png?v=2"]) {
			assert.deepEqual(routed(decide({ uri })), { upstream: OWNER_UP, gateSecret: OWNER_SECRET }, uri);
		}
		assert.equal(decide({ uri: "/manifest.webmanifest" }).status, 303);
	});

	it("are served while the state file is damaged, as the copy serves them (they hold nothing)", () => {
		assert.equal(routed(decide({ uri: "/favicon.ico" }, null)).upstream, OWNER_UP);
	});
});

describe("step 4: writes from another site", () => {
	it("are refused with the copy's words, signed in or not", () => {
		const { tokens } = fixture();
		for (const over of [{ origin: "https://evil.example" }, { origin: null }, { origin: ORIGIN, fetchSite: "cross-site" }, { origin: "not a url" }]) {
			const r = refused(decide({ uri: "/api/chats/x", method: "POST", cookie: cookieOf(tokens.sam!), ...over }), 403);
			assert.deepEqual(JSON.parse(r.body), { error: "This request must come from the LearnHarness site itself." });
		}
		assert.equal(routed(decide({ uri: "/api/chats/x", method: "PATCH", origin: ORIGIN, cookie: cookieOf(tokens.sam!) })).upstream, sam().upstream);
	});
});

describe("step 5: a signed-in browser reaches its own account's copy only", () => {
	it("each cookie yields its own copy and secret, and never another's", () => {
		const { state, tokens } = fixture();
		const samR = routed(decide({ uri: "/chat/1", cookie: cookieOf(tokens.sam!) }, state));
		assert.deepEqual(samR, { upstream: sam().upstream, gateSecret: sam().gateSecret });
		const kimR = routed(decide({ uri: "/chat/1", cookie: cookieOf(tokens.kim!) }, state));
		assert.deepEqual(kimR, { upstream: kim().upstream, gateSecret: kim().gateSecret });
		assert.deepEqual(routed(decide({ uri: "/", cookie: cookieOf(tokens.boss!) }, state)), { upstream: OWNER_UP, gateSecret: OWNER_SECRET });
		// The cookie is read by name; another cookie of the same value elsewhere doesn't count.
		assert.equal(decide({ uri: "/", cookie: `x=${tokens.sam}; lh_server=1` }, state).status, 303);
		assert.deepEqual(routed(decide({ uri: "/", cookie: `lh_server=1; ${cookieOf(tokens.sam!)}; lh_owner=1` }, state)).upstream, sam().upstream);
	});

	it("asks for the session to be touched (the route writes it at most every 5 minutes)", () => {
		const { state, tokens } = fixture();
		const d = decide({ uri: "/", cookie: cookieOf(tokens.sam!) }, state);
		assert.ok("touch" in d && d.touch === state.sessions.find((s) => s.accountId === "acct_sam")!.id);
		assert.equal(acc.touchSession(state, (d as { touch: string }).touch, NOW), null, "within 5 minutes: nothing to write");
		assert.ok(acc.touchSession(state, (d as { touch: string }).touch, NOW + 5 * MIN));
	});

	it("30 idle days, 180 days in all, an ended session, a paused or removed account: not signed in", () => {
		const { state, tokens } = fixture();
		const id = state.sessions.find((s) => s.accountId === "acct_sam")!.id;
		const samSession = (s: import("../src/core/accounts.ts").GatewayState) => decide({ uri: "/", cookie: cookieOf(tokens.sam!) }, s, NOW);
		assert.equal(decide({ uri: "/", cookie: cookieOf(tokens.sam!) }, state, NOW - MIN + 30 * DAY).status, 303, "30 days idle");
		// In constant use for 180 days, then no longer.
		let used = state;
		for (let t = NOW; t < NOW + 179 * DAY; t += 20 * DAY) used = acc.touchSession(used, id, t) ?? used;
		assert.equal(decide({ uri: "/", cookie: cookieOf(tokens.sam!) }, used, NOW + 175 * DAY).status, 200);
		assert.equal(decide({ uri: "/", cookie: cookieOf(tokens.sam!) }, used, NOW - MIN + 180 * DAY).status, 303, "180 days");
		assert.equal(samSession(acc.removeSession(state, id)).status, 303, "ended");
		for (const status of ["paused", "removed", "deleting"] as const) {
			const changed = { ...state, accounts: state.accounts.map((a) => a.name === "sam" ? { ...a, state: status } : a) };
			assert.equal(samSession(changed).status, 303, status);
		}
		const notReady = { ...state, accounts: state.accounts.map((a) => a.name === "sam" ? { ...a, upstream: null } : a) };
		assert.equal(samSession(notReady).status, 303, "no copy yet");
	});
});

describe("step 6: sign in first", () => {
	it("an API gets the copy's 401; a page a 303 to the sign-in page at the address used", () => {
		const r = refused(decide({ uri: "/api/chats" }), 401);
		assert.deepEqual(JSON.parse(r.body), { error: "Sign in to LearnHarness first." });
		const page = refused(decide({ uri: "/chat/1?x=1" }), 303);
		assert.equal(page.headers.Location, `${ORIGIN}/login`);
		assert.equal(gate.decideGate(input({ uri: "/", proto: "https" }), fixture().state, { ...CONFIG, trustProxy: false }, NOW).status, 303);
		assert.equal((gate.decideGate(input({ uri: "/", proto: "https" }), fixture().state, { ...CONFIG, trustProxy: false }, NOW) as { headers: Record<string, string> }).headers.Location, `http://${HOST}/login`);
	});

	it("goes to /setup while no owner exists", () => {
		assert.equal(refused(decide({ uri: "/" }, acc.emptyGatewayState()), 303).headers.Location, `${ORIGIN}/setup`);
	});

	it("a damaged state file closes the site", () => {
		assert.equal(refused(decide({ uri: "/" }, null), 503).body, gate.DAMAGED_TEXT);
		assert.deepEqual(JSON.parse(refused(decide({ uri: "/api/chats" }, null), 503).body), { error: gate.DAMAGED_TEXT });
	});
});

describe("what a client can't do", () => {
	it("choose a copy with an X-LH-* header: the decision never reads one", () => {
		const { tokens } = fixture();
		const base = { "x-forwarded-method": "GET", "x-forwarded-uri": "/chat/1", host: HOST, cookie: cookieOf(tokens.sam!), "x-forwarded-proto": "https" };
		const plain = gate.gateInputFrom(new Headers(base));
		const forged = gate.gateInputFrom(new Headers({ ...base, "x-lh-upstream": OWNER_UP, "x-lh-gate": OWNER_SECRET, "x-lh-relay": "t", "x-lh-client-addr": "1.2.3.4" }));
		assert.deepEqual(forged, plain);
		assert.equal(routed(gate.decideGate(forged, fixture().state, CONFIG, NOW)).upstream, sam().upstream);
	});

	it("send a path the copy would read differently: refused", () => {
		for (const uri of ["/_next/../api/chats", "/icons/%2e%2e/api/chats", "/icons/%2E%2E/api/chats", "/api/sync/../chats", "/api/sync/%2e%2e/chats", "/api/sync/..%2Fchats",
			"/api/sync%2Fhello", "//api/chats", "/api//sync/x", "/icons/..\\api", "/a/./b", "/a b", "api/chats", "", null, "/api/chats\u0000"]) {
			refused(decide({ uri, authorization: `Bearer ${OWNER_KEY}` }), 400);
		}
		refused(decide({ method: null }), 400);
	});

	it("get a decision from paths that are fine", () => {
		for (const uri of ["/", "/chat/abc?x=../y", "/api/chats/c_1/side-chats/t_2", "/_next/static/chunks/%5Bid%5D.js"]) assert.notEqual(decide({ uri }).status, 400, uri);
	});
});

describe("the rules repeated from the copy agree with the copy's own", () => {
	const PATHS = ["/", "/login", "/setup", "/invite", "/favicon.ico", "/favicon.icox", "/robots.txt", "/manifest.webmanifest", "/_next/static/x.js", "/_next", "/fonts/a", "/fontsx",
		"/icons/i.png", "/icons", "/api/server-auth/login", "/api/server-auth/setup", "/api/server-auth/account", "/api/chats", "/api/sync", "/api/sync/hello", "/api/sync/pair",
		"/api/syncx", "/api/internal", "/api/internal/unpair-all", "/api/internalx", "/chat/1"];
	// The copy's pages and APIs that the gateway answers itself, and the manifest it serves in dark.
	const GATEWAY_OWN = new Set(["/login", "/setup", "/api/server-auth/login", "/api/server-auth/setup", "/manifest.webmanifest"]);

	it("public files: the copy's list without the gateway's own paths", () => {
		for (const pathname of PATHS) {
			if (copyAuth.isSyncPath(pathname) || copyAuth.isInternalPath(pathname)) continue;
			const passes = copyAuth.serverGate({ method: "GET", pathname, headers: new Headers({ host: HOST }), env: { LH_SERVER_MODE: "1" }, readState: () => ({ ...core.emptyServerAuthState(), password: PW }), touch: () => {} }) === null;
			assert.equal(gate.isPublicFile(pathname), passes && !GATEWAY_OWN.has(pathname), pathname);
		}
	});

	it("sync and internal paths", () => {
		for (const pathname of PATHS) {
			assert.equal(gate.isSyncPath(pathname), copyAuth.isSyncPath(pathname), pathname);
			assert.equal(gate.isInternalPath(pathname), copyAuth.isInternalPath(pathname), pathname);
		}
	});

	const ORIGINS = [
		{}, { origin: ORIGIN }, { origin: "https://evil.example" }, { origin: "http://learn.example.com" }, { origin: "https://learn.example.com:444" }, { origin: "nonsense" },
		{ origin: ORIGIN, "sec-fetch-site": "cross-site" }, { origin: ORIGIN, "sec-fetch-site": "same-origin" }, { "sec-fetch-site": "cross-site" }, { origin: "null" },
	];
	const toInput = (h: Record<string, string>, host: string | null) => ({ origin: h.origin ?? null, host, fetchSite: h["sec-fetch-site"] ?? null });

	it("the same-site write rule", () => {
		for (const method of ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE", "post"]) {
			for (const h of ORIGINS) {
				for (const host of [HOST, null]) {
					const headers = new Headers({ ...h, ...(host ? { host } : {}) });
					assert.equal(gate.sameOrigin(method, toInput(h, host)), copyAuth.sameOrigin(method, headers), `${method} ${JSON.stringify(h)} ${host}`);
				}
			}
		}
	});

	it("the sync paths' foreign-request rule (the pairing request)", () => {
		for (const h of ORIGINS) {
			const copy = copyAuth.serverGate({ method: "POST", pathname: "/api/sync/pair", headers: new Headers({ ...h, host: HOST }), env: { LH_SERVER_MODE: "1" }, readState: () => core.emptyServerAuthState() });
			assert.equal(gate.foreignRequest(toInput(h, HOST)), copy !== null && copy.status === 403, JSON.stringify(h));
		}
	});

	it("the client's address", () => {
		for (const forwarded of [null, "", "203.0.113.7", "1.1.1.1, 203.0.113.7", "1.1.1.1,203.0.113.7 , ", " , ", "x".repeat(65), "2001:db8::1"]) {
			for (const trust of [true, false]) {
				const headers = new Headers(forwarded === null ? {} : { "x-forwarded-for": forwarded });
				assert.equal(gate.clientAddress(forwarded, trust), copyAuth.clientAddress(headers, trust ? { LH_TRUST_PROXY: "1" } : {}), `${forwarded} ${trust}`);
			}
		}
	});

	it("the session cookie's reading", () => {
		for (const cookie of [null, "", `${core.SESSION_COOKIE}=abc`, `a=1; ${core.SESSION_COOKIE}=abc; b=2`, `${core.SESSION_COOKIE}=`, `x${core.SESSION_COOKIE}=abc`, ` ${core.SESSION_COOKIE} = abc `]) {
			assert.equal(gate.findSessionCookie(cookie), copyAuth.readSessionCookie(new Headers(cookie === null ? {} : { cookie })), String(cookie));
		}
	});
});
