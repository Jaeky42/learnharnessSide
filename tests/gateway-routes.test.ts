/**
 * Multi-account, slices 1b and 2b: the gateway's routes, with the real state
 * file on disk, a moved clock and a stand-in for Caddy's relay. Sign-in and
 * the first start, sessions extended by use (30 idle days, 180 in all), the
 * lockout, a wrong name and a wrong password told apart by nothing, the
 * paused and removed sentences, sign-out, the password change and the
 * unpairing it owes, the owner marker, the account route's shape, the pages
 * and the manifest in the standard dark colours, a damaged file, the file's
 * mode and contents, an outside change, and the listener itself.
 *
 * LH_AUTH_FILE / LH_DATA_DIR are redirected before the copy's modules load.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-gateway-routes-"));
process.env.LH_AUTH_FILE = path.join(TMP, "secrets", "auth.json");
process.env.LH_DATA_DIR = path.join(TMP, "data");
delete process.env.LH_GATE_SECRET;

const acc = await import("../src/core/accounts.ts");
const words = await import("../src/core/account-screens.ts");
const core = await import("../src/core/server-auth.ts");
const { loadConfig, ConfigError } = await import("../gateway/config.ts");
const { createStore, writeStateFile, readStateFile } = await import("../gateway/state.ts");
const { createUnpairer } = await import("../gateway/copies.ts");
const routes = await import("../gateway/routes.ts");
const pages = await import("../gateway/pages.ts");
const gatewayMain = await import("../gateway/main.ts");
const copyAuth = await import("../src/server/server-auth.ts");
const { DEFAULT_AUTH_PAGE_PALETTE, authPagePalette } = await import("../src/server/server-auth-theme.ts");
const copyStore = await import("../src/store/server-auth.ts");
const { default: appManifest } = await import("../app/manifest.ts");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

type GatewayState = import("../src/core/accounts.ts").GatewayState;
type RouteDeps = import("../gateway/routes.ts").RouteDeps;
type RelayRequest = import("../gateway/copies.ts").RelayRequest;

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const T0 = Date.UTC(2026, 10, 15, 12, 0);
const HOST = "learn.example.com";
const ORIGIN = `https://${HOST}`;
const ADDR = "203.0.113.7";
const OWNER_SECRET = "owner-gate-secret-".padEnd(40, "q");
const RELAY_TOKEN = "relay-token-".padEnd(40, "r");
const PASSWORD = "correct horse battery";
const SAM_PASSWORD = "sams own passphrase";
const UA = "Mozilla/5.0 (iPhone) Safari/605.1";

let dir: string;
let clock: number;
let relayCalls: RelayRequest[];
let relayAnswer: (req: RelayRequest) => Response | Promise<Response>;
let logs: string[];
let deps: RouteDeps;

function config(file: string) {
	return {
		port: 0, stateFile: file, maxAccounts: 4, ownerUpstream: "lh:3000", ownerGateSecret: OWNER_SECRET,
		relayUrl: "http://caddy:9200", relayToken: RELAY_TOKEN, makerUrl: null, makerToken: null, trustProxy: true,
	};
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(TMP, "g-"));
	clock = T0;
	relayCalls = [];
	relayAnswer = () => Response.json({ ok: true });
	logs = [];
	const store = createStore(path.join(dir, "accounts.json"));
	const relay = { send: async (req: RelayRequest) => { relayCalls.push(req); return relayAnswer(req); } };
	const cfg = config(store.file);
	deps = { store, config: cfg, relay, unpairer: createUnpairer({ store, relay, config: cfg, log: (l) => logs.push(l) }), now: () => clock, log: (l) => logs.push(l) };
});

const call = (request: Request) => routes.handleRequest(request, deps);

function post(pathname: string, body: unknown, headers: Record<string, string> = {}): Request {
	return new Request(`http://gateway.invalid${pathname}`, {
		method: "POST",
		headers: { host: HOST, origin: ORIGIN, "content-type": "application/json", "x-forwarded-for": ADDR, "x-forwarded-proto": "https", "user-agent": UA, ...headers },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

function get(pathname: string, headers: Record<string, string> = {}): Request {
	return new Request(`http://gateway.invalid${pathname}`, { headers: { host: HOST, "x-forwarded-for": ADDR, "x-forwarded-proto": "https", "user-agent": UA, ...headers } });
}

function gateAsk(uri: string, cookie?: string, extra: Record<string, string> = {}): Request {
	return get("/gate", { "x-forwarded-method": "GET", "x-forwarded-uri": uri, ...(cookie ? { cookie } : {}), ...extra });
}

const cookiesOf = (response: Response): string[] => response.headers.getSetCookie();
const sessionFrom = (response: Response): string => cookiesOf(response).find((c) => c.startsWith(`${core.SESSION_COOKIE}=`))!.split(";")[0]!;

/** The setup code the gateway prints at its first start. */
function firstStartCode(): string {
	const lines: string[] = [];
	gatewayMain.announceSetupCode(deps.store, (l) => lines.push(l));
	const line = lines.find((l) => l.startsWith("[LearnHarness] Setup code: "))!;
	return line.slice("[LearnHarness] Setup code: ".length);
}

/** First start, claimed as "Boss"; the owner's session cookie. */
async function claimed(): Promise<{ cookie: string; code: string }> {
	const code = firstStartCode();
	const response = await call(post("/api/server-auth/setup", { code, name: "Boss", password: PASSWORD }));
	assert.equal(response.status, 200);
	return { cookie: sessionFrom(response), code };
}

/** Adds an active member with a ready copy, straight into the file. */
function addMember(name: string, tag: string, password = SAM_PASSWORD, over: Partial<import("../src/core/accounts.ts").AccountRecord> = {}): void {
	deps.store.update((state) => ({
		state: {
			...state,
			accounts: [...state.accounts, {
				id: `acct_${name}`, tag, name, nameKey: name.toLowerCase(), password: core.hashPassword(password), recoveryCodes: [],
				role: "member" as const, state: "active" as const, createdAt: clock, lastSeenAt: null, removedAt: null,
				upstream: `lh-acct-${tag}:3000`, gateSecret: `secret-of-${name}`.padEnd(40, "s"), ...over,
			}],
		},
		result: undefined,
	}));
}

const state = (): GatewayState => readStateFile(deps.store.file);

describe("the first start", () => {
	it("prints today's three lines with a fresh code, and the code's hash only is stored", () => {
		const lines: string[] = [];
		gatewayMain.announceSetupCode(deps.store, (l) => lines.push(l));
		assert.equal(lines[0], "[LearnHarness] No password is set yet.");
		assert.match(lines[1]!, /^\[LearnHarness\] Setup code: [0-9A-Z]{4}-[0-9A-Z]{4}$/);
		assert.equal(lines[2], "[LearnHarness] Open the site, enter this code and choose a password.");
		const code = lines[1]!.split(": ")[1]!;
		assert.equal(state().setupCodeHash, core.setupCodeHash(code));
		assert.ok(!fs.readFileSync(deps.store.file, "utf-8").includes(code));
	});

	it("/login goes to /setup; the setup page shows the approved words", async () => {
		const login = await call(get("/login"));
		assert.equal(login.status, 303);
		assert.equal(login.headers.get("location"), `${ORIGIN}/setup`);
		const setup = await call(get("/setup"));
		assert.equal(setup.status, 200);
		const html = await setup.text();
		for (const text of [words.SETUP_TEXT.title, words.SETUP_TEXT.intro, words.SETUP_TEXT.codeLabel, words.SETUP_TEXT.nameLabel, words.SETUP_TEXT.nameHelp, words.SETUP_TEXT.passwordLabel, words.SETUP_TEXT.confirmLabel, words.SETUP_TEXT.submit]) {
			assert.ok(html.includes(pages.escapeHtml(text)), text);
		}
		assert.ok(html.includes(JSON.stringify(words.PASSWORDS_DONT_MATCH)));
		assert.ok(html.includes(JSON.stringify(words.USE_AT_LEAST)));
		// After the claim: the same recovery-codes page as after an invite.
		assert.ok(html.includes(pages.recoveryCodesView()));
		for (const text of [words.RECOVERY_PAGE_TEXT.title, words.RECOVERY_PAGE_TEXT.body, words.RECOVERY_PAGE_TEXT.copy, words.RECOVERY_PAGE_TEXT.continue]) assert.ok(html.includes(pages.jsString(text)), text);
		for (const forbidden of ["localStorage", "sessionStorage", "document.cookie", "history.pushState"]) assert.ok(!html.includes(forbidden), forbidden);
	});

	it("the claim works once, with the right code; a wrong code and a bad name are refused in the approved words", async () => {
		const code = firstStartCode();
		const wrong = await call(post("/api/server-auth/setup", { code: "AAAA-AAAA", name: "Boss", password: PASSWORD }));
		assert.equal(wrong.status, 401);
		assert.deepEqual(await wrong.json(), { error: words.SETUP_CODE_WRONG });
		for (const name of ["ab", "has space", "admin", "o-w-n-e-r"]) {
			const bad = await call(post("/api/server-auth/setup", { code, name, password: PASSWORD }));
			assert.equal(bad.status, 400, name);
			assert.deepEqual(await bad.json(), { error: words.SETUP_TEXT.nameNotAllowed });
		}
		const short = await call(post("/api/server-auth/setup", { code, name: "Boss", password: "short" }));
		assert.deepEqual(await short.json(), { error: words.USE_AT_LEAST });
		const ok = await call(post("/api/server-auth/setup", { code, name: "Boss", password: PASSWORD }));
		assert.equal(ok.status, 200);
		// Changed with the real stack's finding: the owner gets four recovery codes at the claim, once.
		const claimBody = await ok.json() as { codes: string[] };
		assert.deepEqual(Object.keys(claimBody), ["codes"]);
		assert.equal(claimBody.codes.length, 4);
		assert.deepEqual(acc.ownerAccount(state())!.recoveryCodes, claimBody.codes.map((c) => core.setupCodeHash(c)));
		for (const c of claimBody.codes) assert.ok(!fs.readFileSync(deps.store.file, "utf-8").includes(c));
		const cookies = cookiesOf(ok);
		assert.match(cookies[0]!, new RegExp(`^${core.SESSION_COOKIE}=[A-Za-z0-9_-]{43}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=15552000$`));
		assert.equal(cookies[1], "lh_owner=1; Path=/; Secure; SameSite=Lax; Max-Age=15552000");
		const owner = acc.ownerAccount(state())!;
		assert.equal(owner.name, "Boss");
		assert.equal(owner.upstream, "lh:3000");
		assert.equal(state().setupCodeHash, null);
		const again = await call(post("/api/server-auth/setup", { code, name: "Other", password: PASSWORD }));
		assert.equal(again.status, 409);
		assert.deepEqual(await again.json(), { error: "A password is already set. Sign in instead." });
		assert.equal((await call(get("/setup"))).headers.get("location"), `${ORIGIN}/login`);
		assert.equal((await call(get("/setup", { cookie: sessionFrom(ok) }))).headers.get("location"), `${ORIGIN}/`);
		const lines: string[] = [];
		gatewayMain.announceSetupCode(deps.store, (l) => lines.push(l));
		assert.deepEqual(lines, []);
	});

	it("the claim's wrong codes count toward the lockout", async () => {
		firstStartCode();
		for (let i = 0; i < 4; i += 1) assert.equal((await call(post("/api/server-auth/setup", { code: "AAAA-AAAA", name: "Boss", password: PASSWORD }))).status, 401);
		const fifth = await call(post("/api/server-auth/setup", { code: "AAAA-AAAA", name: "Boss", password: PASSWORD }));
		assert.equal(fifth.status, 429);
		assert.deepEqual(await fifth.json(), { error: words.tooManyAttempts(15 * MIN) });
	});
});

describe("signing in", () => {
	it("the sign-in page: the approved words, the two links, the standard dark palette and today's headers", async () => {
		await claimed();
		const response = await call(get("/login"));
		assert.equal(response.status, 200);
		const html = await response.text();
		for (const text of [words.SIGN_IN_TEXT.title, words.SIGN_IN_TEXT.nameLabel, words.SIGN_IN_TEXT.passwordLabel, words.SIGN_IN_TEXT.submit, words.SIGN_IN_TEXT.inviteLink, words.SIGN_IN_TEXT.forgotLink]) {
			assert.ok(html.includes(pages.escapeHtml(text)), text);
		}
		assert.ok(html.includes(`href="/invite"`) && html.includes(`href="/reset"`));
		const p = DEFAULT_AUTH_PAGE_PALETTE;
		assert.ok(html.includes(`--bg: ${p.background}; --card: ${p.surface}; --fg: ${p.text}; --muted: ${p.textMuted}; --border: ${p.border}; --error: ${p.error};`));
		// Today's single-copy pages, for their headers.
		copyStore.writeServerAuthState({ ...core.emptyServerAuthState(), password: acc.ownerAccount(state())!.password });
		const previous = process.env.LH_SERVER_MODE;
		process.env.LH_SERVER_MODE = "1";
		let today: Response;
		try { today = copyAuth.loginPageResponse(new Request(`${ORIGIN}/login`, { headers: { host: HOST } })); } finally {
			if (previous === undefined) delete process.env.LH_SERVER_MODE; else process.env.LH_SERVER_MODE = previous;
		}
		for (const name of ["content-security-policy", "referrer-policy", "content-type", "cache-control", "x-content-type-options"]) {
			assert.equal(response.headers.get(name), today.headers.get(name), name);
		}
	});

	it("the standard dark palette is what a single-copy server shows with no saved theme", () => {
		assert.deepEqual(pages.STANDARD_DARK_PALETTE, DEFAULT_AUTH_PAGE_PALETTE);
		assert.deepEqual(pages.STANDARD_DARK_PALETTE, authPagePalette());
	});

	it("a signed-in visitor to /login goes to /", async () => {
		const { cookie } = await claimed();
		const response = await call(get("/login", { cookie }));
		assert.equal(response.status, 303);
		assert.equal(response.headers.get("location"), `${ORIGIN}/`);
	});

	it("name and password sign in, names without regard to capitals", async () => {
		await claimed();
		const response = await call(post("/api/server-auth/login", { name: "boss", password: PASSWORD }));
		assert.equal(response.status, 200);
		const gated = await call(gateAsk("/chat/1", sessionFrom(response)));
		assert.equal(gated.status, 200);
		assert.equal(gated.headers.get("x-lh-upstream"), "lh:3000");
		assert.equal(gated.headers.get("x-lh-gate"), OWNER_SECRET);
	});

	it("a wrong name and a wrong password: the same answer, the same state, comparable time", async () => {
		await claimed();
		const timed = async (body: unknown) => {
			const start = performance.now();
			const response = await call(post("/api/server-auth/login", body, { "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200)}` }));
			return { ms: performance.now() - start, status: response.status, body: await response.json() };
		};
		const wrongName = await timed({ name: "nobody", password: PASSWORD });
		const wrongPassword = await timed({ name: "Boss", password: "not the password" });
		assert.equal(wrongName.status, 401);
		assert.deepEqual(wrongName.body, { error: words.SIGN_IN_TEXT.wrong });
		assert.deepEqual([wrongPassword.status, wrongPassword.body], [wrongName.status, wrongName.body]);
		const a = [wrongName.ms, (await timed({ name: "nobody2", password: PASSWORD })).ms];
		const b = [wrongPassword.ms, (await timed({ name: "Boss", password: "still wrong" })).ms];
		const ratio = Math.max(...a, ...b) / Math.min(...a, ...b);
		assert.ok(ratio < 4, `wrong name ${a} ms vs wrong password ${b} ms`);
		assert.ok(Math.min(...a) > 2, "a wrong name still costs a scrypt verification");
	});

	it("the lockout: 5 wrong tries pause the address for 15 minutes, the right password too; others keep working", async () => {
		await claimed();
		for (let i = 0; i < 4; i += 1) assert.equal((await call(post("/api/server-auth/login", { name: "Boss", password: "nope" }))).status, 401);
		const fifth = await call(post("/api/server-auth/login", { name: "Boss", password: "nope" }));
		assert.equal(fifth.status, 429);
		assert.deepEqual(await fifth.json(), { error: words.tooManyAttempts(15 * MIN) });
		assert.equal((await call(post("/api/server-auth/login", { name: "Boss", password: PASSWORD }))).status, 429);
		assert.equal((await call(post("/api/server-auth/login", { name: "Boss", password: PASSWORD }, { "x-forwarded-for": "198.51.100.1" }))).status, 200);
		clock += 15 * MIN;
		assert.equal((await call(post("/api/server-auth/login", { name: "Boss", password: PASSWORD }))).status, 200);
	});

	it("paused and removed accounts are told so only after the right password", async () => {
		await claimed();
		addMember("lee", "P2P", SAM_PASSWORD, { state: "paused" });
		addMember("rob", "R0B", SAM_PASSWORD, { state: "removed", removedAt: clock });
		const paused = await call(post("/api/server-auth/login", { name: "lee", password: SAM_PASSWORD }));
		assert.equal(paused.status, 403);
		assert.deepEqual(await paused.json(), { error: words.SIGN_IN_TEXT.paused });
		const removed = await call(post("/api/server-auth/login", { name: "rob", password: SAM_PASSWORD }));
		assert.deepEqual(await removed.json(), { error: words.SIGN_IN_TEXT.removed });
		assert.equal(cookiesOf(removed).length, 0);
		for (const name of ["lee", "rob"]) {
			const wrong = await call(post("/api/server-auth/login", { name, password: "wrong one!" }, { "x-forwarded-for": "198.51.100.9" }));
			assert.deepEqual(await wrong.json(), { error: words.SIGN_IN_TEXT.wrong });
		}
	});

	it("the owner marker: set for the owner, cleared when a member signs in on the same browser, and at sign-out", async () => {
		const { cookie } = await claimed();
		addMember("sam", "7KQ");
		const member = await call(post("/api/server-auth/login", { name: "sam", password: SAM_PASSWORD }, { cookie: `${cookie}; lh_owner=1` }));
		assert.equal(member.status, 200);
		assert.deepEqual(cookiesOf(member).slice(1), ["lh_owner=; Path=/; Secure; SameSite=Lax; Max-Age=0"]);
		// One browser, one account: the owner's session it carried is gone.
		assert.equal((await call(gateAsk("/", cookie))).status, 303);
		const samCookie = sessionFrom(member);
		const gated = await call(gateAsk("/", samCookie));
		assert.equal(gated.headers.get("x-lh-upstream"), "lh-acct-7KQ:3000");
		const out = await call(post("/api/server-auth/logout", {}, { cookie: samCookie }));
		assert.deepEqual(cookiesOf(out), [`${core.SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`, "lh_owner=; Path=/; Secure; SameSite=Lax; Max-Age=0"]);
		assert.equal((await call(gateAsk("/", samCookie))).status, 303);
	});

	it("writes from another site are refused on every POST", async () => {
		await claimed();
		for (const pathname of ["/api/server-auth/login", "/api/server-auth/setup", "/api/server-auth/logout", "/api/server-auth/password", "/api/server-auth/sign-out-everywhere"]) {
			const response = await call(post(pathname, { name: "Boss", password: PASSWORD }, { origin: "https://evil.example" }));
			assert.equal(response.status, 403, pathname);
			assert.deepEqual(await response.json(), { error: "This request must come from the LearnHarness site itself." });
		}
	});
});

describe("a session is extended by use", () => {
	it("lasts 30 days from its last use, stamped at most every 5 minutes", async () => {
		const { cookie } = await claimed();
		const before = fs.statSync(deps.store.file).mtimeMs;
		clock += 4 * MIN;
		assert.equal((await call(gateAsk("/", cookie))).status, 200);
		assert.equal(fs.statSync(deps.store.file).mtimeMs, before, "no write within 5 minutes");
		clock = T0 + 29 * DAY;
		assert.equal((await call(gateAsk("/", cookie))).status, 200);
		assert.equal(acc.ownerAccount(state())!.lastSeenAt, clock);
		clock = T0 + 58 * DAY;
		assert.equal((await call(gateAsk("/", cookie))).status, 200, "used within 30 days: still valid");
		clock += 30 * DAY;
		const ended = await call(gateAsk("/chat/1", cookie));
		assert.equal(ended.status, 303);
		assert.equal(ended.headers.get("location"), `${ORIGIN}/login`);
		assert.equal((await call(get("/api/server-auth/account", { cookie }))).status, 401);
	});

	it("never longer than 6 months from the sign-in", async () => {
		const { cookie } = await claimed();
		for (clock = T0; clock < T0 + 180 * DAY; clock += 20 * DAY) assert.equal((await call(gateAsk("/", cookie))).status, 200, String((clock - T0) / DAY));
		clock = T0 + 180 * DAY;
		assert.equal((await call(gateAsk("/", cookie))).status, 303);
	});

	it("a touch that can't be written doesn't change the answer", async () => {
		const { cookie } = await claimed();
		clock += 10 * MIN;
		const store = deps.store;
		deps = { ...deps, store: { file: store.file, read: () => store.read(), update: () => { throw new Error("disk full"); } } };
		const response = await call(gateAsk("/", cookie));
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("x-lh-gate"), OWNER_SECRET);
	});
});

describe("Settings → Account", () => {
	it("today's shape plus the name, the owner flag and the codes left", async () => {
		const { cookie } = await claimed();
		const response = await call(get("/api/server-auth/account", { cookie }));
		assert.equal(response.status, 200);
		const body = await response.json() as Record<string, unknown>;
		assert.deepEqual(Object.keys(body).sort(), ["devices", "name", "owner", "recoveryCodesLeft"]);
		assert.equal(body.name, "Boss");
		assert.equal(body.owner, true);
		assert.equal(body.recoveryCodesLeft, 4, "the owner's codes from the claim");
		const devices = body.devices as Array<Record<string, unknown>>;
		assert.equal(devices.length, 1);
		assert.deepEqual(Object.keys(devices[0]!).sort(), ["createdAt", "current", "expiresAt", "id", "label", "lastSeenAt"]);
		assert.equal(devices[0]!.label, "Safari on iPhone");
		assert.equal(devices[0]!.current, true);
		assert.equal((await call(get("/api/server-auth/account"))).status, 401);
	});

	it("a password change ends the other sessions, keeps this one, and unpairs the copy's desktop apps", async () => {
		const { cookie } = await claimed();
		const other = sessionFrom(await call(post("/api/server-auth/login", { name: "Boss", password: PASSWORD })));
		const wrong = await call(post("/api/server-auth/password", { current: "nope", next: "a new password" }, { cookie }));
		assert.equal(wrong.status, 401);
		assert.deepEqual(await wrong.json(), { error: "Your current password is wrong." });
		const short = await call(post("/api/server-auth/password", { current: PASSWORD, next: "short" }, { cookie }));
		assert.deepEqual(await short.json(), { error: words.USE_AT_LEAST });
		assert.equal(relayCalls.length, 0);
		const ok = await call(post("/api/server-auth/password", { current: PASSWORD, next: "a new password" }, { cookie }));
		assert.equal(ok.status, 200);
		assert.deepEqual(await ok.json(), { ok: true });
		assert.equal((await call(gateAsk("/", cookie))).status, 200);
		assert.equal((await call(gateAsk("/", other))).status, 303);
		assert.equal(relayCalls.length, 1);
		assert.deepEqual({ ...relayCalls[0], body: undefined, headers: undefined }, { upstream: "lh:3000", gateSecret: OWNER_SECRET, method: "POST", scope: "internal", path: "/api/internal/unpair-all", body: undefined, headers: undefined });
		assert.equal(acc.ownerAccount(state())!.unpairPending, undefined);
		assert.equal((await call(post("/api/server-auth/login", { name: "Boss", password: "a new password" }))).status, 200);
	});

	it("a copy that can't be reached: the change stands, sync answers 503 until a retry gets through", async () => {
		const { cookie } = await claimed();
		addMember("sam", "7KQ");
		const samCookie = sessionFrom(await call(post("/api/server-auth/login", { name: "sam", password: SAM_PASSWORD })));
		relayAnswer = () => { throw new TypeError("fetch failed"); };
		const ok = await call(post("/api/server-auth/password", { current: SAM_PASSWORD, next: "sams second phrase" }, { cookie: samCookie }));
		assert.equal(ok.status, 200);
		const sam = acc.findAccountByName(state(), "sam")!;
		assert.equal(sam.unpairPending, true);
		assert.equal(logs.length, 1);
		// The account's id only (random in real use), never its name.
		assert.equal(logs[0], `[LearnHarness gateway] The copy of account ${sam.id} couldn't be told to unpair its desktop apps; trying again.`);
		const samKey = `7KQ${"k".repeat(43)}`;
		assert.equal((await call(gateAsk("/api/sync/hello", undefined, { authorization: `Bearer ${samKey}`, "x-forwarded-method": "POST" }))).status, 503);
		assert.equal((await call(gateAsk("/api/sync/hello", undefined, { authorization: `Bearer ${"A".repeat(43)}`, "x-forwarded-method": "POST" }))).status, 200, "the owner's copy is unaffected");
		// The answer still works for pages.
		assert.equal((await call(gateAsk("/", samCookie))).status, 200);
		await deps.unpairer.retryPending();
		assert.equal(acc.findAccountByName(state(), "sam")!.unpairPending, true, "still unreachable");
		relayAnswer = () => new Response(null, { status: 503 });
		await deps.unpairer.retryPending();
		assert.equal(acc.findAccountByName(state(), "sam")!.unpairPending, true, "a 5xx is no confirmation");
		relayAnswer = () => Response.json({ ok: true });
		await deps.unpairer.retryPending();
		assert.equal(acc.findAccountByName(state(), "sam")!.unpairPending, undefined);
		assert.equal(relayCalls.at(-1)!.upstream, "lh-acct-7KQ:3000");
		assert.equal(relayCalls.at(-1)!.gateSecret, sam.gateSecret);
		assert.equal((await call(gateAsk("/api/sync/hello", undefined, { authorization: `Bearer ${samKey}`, "x-forwarded-method": "POST" }))).headers.get("x-lh-upstream"), "lh-acct-7KQ:3000");
		assert.equal((await call(gateAsk("/", cookie))).status, 200, "the owner was never touched");
	});

	it("Sign out everywhere ends every session of the account only, and unpairs", async () => {
		const { cookie } = await claimed();
		addMember("sam", "7KQ");
		const samCookie = sessionFrom(await call(post("/api/server-auth/login", { name: "sam", password: SAM_PASSWORD })));
		const second = sessionFrom(await call(post("/api/server-auth/login", { name: "Boss", password: PASSWORD })));
		const response = await call(post("/api/server-auth/sign-out-everywhere", {}, { cookie }));
		assert.equal(response.status, 200);
		assert.equal(cookiesOf(response).length, 2);
		assert.equal((await call(gateAsk("/", cookie))).status, 303);
		assert.equal((await call(gateAsk("/", second))).status, 303);
		assert.equal((await call(gateAsk("/", samCookie))).status, 200);
		assert.equal(relayCalls.length, 1);
		assert.equal(relayCalls[0]!.path, "/api/internal/unpair-all");
		assert.equal((await call(post("/api/server-auth/sign-out-everywhere", {}, { cookie }))).status, 401);
	});

	it("a pending unpair from before a restart is retried at start", async () => {
		await claimed();
		deps.store.update((s) => ({ state: acc.markUnpairPending(s, acc.ownerAccount(s)!.id), result: undefined }));
		const stop = deps.unpairer.start(60_000);
		await new Promise((resolve) => setTimeout(resolve, 20));
		stop();
		assert.equal(relayCalls.length, 1);
		assert.equal(acc.ownerAccount(state())!.unpairPending, undefined);
	});
});

describe("the pairing request (slice 2b)", () => {
	const pairBody = (code: string) => JSON.stringify({ code, deviceId: "dev_0123456789abcdef", name: "Desktop" });
	const pair = (code: string, headers: Record<string, string> = {}) => new Request("http://gateway.invalid/api/sync/pair", {
		method: "POST",
		headers: { host: HOST, "content-type": "application/json", "x-lh-sync-protocol": "3", "user-agent": "node", "x-forwarded-for": ADDR, cookie: "lh_server=1", ...headers },
		body: pairBody(code),
	});

	it("an 8-character code goes to the owner's copy, an 11-character one to its tag's; the body and the desktop's headers only", async () => {
		await claimed();
		addMember("sam", "7KQ");
		relayAnswer = () => new Response(JSON.stringify({ key: "k", protocol: 3 }), { status: 200, headers: { "content-type": "application/json", "x-other": "1" } });
		const owner = await call(pair("abcd-efgh"));
		assert.equal(owner.status, 200);
		assert.deepEqual(await owner.json(), { key: "k", protocol: 3 });
		assert.equal(owner.headers.get("content-type"), "application/json");
		assert.equal(owner.headers.get("x-other"), null);
		assert.equal(relayCalls[0]!.upstream, "lh:3000");
		assert.equal(relayCalls[0]!.gateSecret, OWNER_SECRET);
		assert.equal(relayCalls[0]!.clientAddress, ADDR);
		assert.equal(relayCalls[0]!.path, "/api/sync/pair");
		assert.deepEqual(relayCalls[0]!.headers, { "content-type": "application/json", "x-lh-sync-protocol": "3", "user-agent": "node" });
		assert.equal(new TextDecoder().decode(relayCalls[0]!.body as Uint8Array), pairBody("abcd-efgh"));
		await call(pair("ABCD-EFGH-7KQ"));
		assert.equal(relayCalls[1]!.upstream, "lh-acct-7KQ:3000");
		// The copy's own answer, a refusal included, comes back unchanged.
		relayAnswer = () => Response.json({ error: "copy says no" }, { status: 401 });
		const refused = await call(pair("ABCD-EFGH-7KQ"));
		assert.equal(refused.status, 401);
		assert.deepEqual(await refused.json(), { error: "copy says no" });
	});

	it("paused, removed, not-made and unpair-pending accounts: 503", async () => {
		await claimed();
		addMember("lee", "P2P", SAM_PASSWORD, { state: "paused" });
		addMember("rob", "R0B", SAM_PASSWORD, { state: "removed", removedAt: clock });
		addMember("new", "N3W", SAM_PASSWORD, { upstream: null, gateSecret: null });
		addMember("sam", "7KQ");
		deps.store.update((s) => ({ state: acc.markUnpairPending(s, "acct_sam"), result: undefined }));
		for (const code of ["ABCD-EFGH-P2P", "ABCD-EFGH-R0B", "ABCD-EFGH-N3W", "ABCD-EFGH-7KQ"]) assert.equal((await call(pair(code))).status, 503, code);
		assert.equal(relayCalls.filter((c) => c.path === "/api/sync/pair").length, 0);
	});

	it("a code of no copy's shape or tag: the copy's own refusal, counted in the lockout", async () => {
		await claimed();
		addMember("dan", "D4N", SAM_PASSWORD, { state: "deleting" });
		for (const code of ["ABC", "ABCD-EFGH-ZZZ", "ABCD-EFGH-D4N"]) {
			const response = await call(pair(code, { "x-forwarded-for": `198.51.100.${code.length}` }));
			assert.equal(response.status, 401, code);
			assert.deepEqual(await response.json(), { error: routes.WRONG_PAIRING_CODE });
		}
		for (let i = 0; i < 4; i += 1) assert.equal((await call(pair("ABCD-EFGH-ZZZ"))).status, 401);
		const locked = await call(pair("ABCD-EFGH-ZZZ"));
		assert.equal(locked.status, 429);
		assert.deepEqual(await locked.json(), { error: words.tooManyAttempts(15 * MIN) });
		// While locked, a right-shaped code isn't forwarded either.
		assert.equal((await call(pair("ABCD-EFGH"))).status, 429);
		assert.equal(relayCalls.length, 0);
	});

	it("a browser on another site, a body that isn't JSON, or a relay that can't be reached", async () => {
		await claimed();
		assert.equal((await call(pair("ABCD-EFGH", { origin: "https://evil.example" }))).status, 403);
		assert.equal((await call(pair("ABCD-EFGH", { "sec-fetch-site": "cross-site" }))).status, 403);
		const notJson = await call(new Request("http://gateway.invalid/api/sync/pair", { method: "POST", headers: { host: HOST, "content-type": "application/json" }, body: "nope" }));
		assert.equal(notJson.status, 400);
		relayAnswer = () => { throw new TypeError("fetch failed"); };
		assert.equal((await call(pair("ABCD-EFGH"))).status, 503);
	});
});

describe("the home-screen app's manifest", () => {
	it("is app/manifest.ts's, in the standard dark colours", async () => {
		const response = await call(get("/manifest.webmanifest"));
		assert.equal(response.status, 200);
		assert.match(response.headers.get("content-type")!, /^application\/manifest\+json/);
		const ours = await response.json() as Record<string, unknown>;
		const theirs = appManifest() as unknown as Record<string, unknown>;
		const without = (m: Record<string, unknown>) => { const { background_color: _b, theme_color: _t, ...rest } = m; return rest; };
		assert.deepEqual(without(ours), without(JSON.parse(JSON.stringify(theirs))));
		assert.equal(ours.background_color, DEFAULT_AUTH_PAGE_PALETTE.background);
		assert.equal(ours.theme_color, DEFAULT_AUTH_PAGE_PALETTE.background);
	});
});

describe("the state file", () => {
	it("is mode 0600 and holds no password, token or code in clear", async () => {
		const { cookie, code } = await claimed();
		addMember("sam", "7KQ");
		const login = await call(post("/api/server-auth/login", { name: "sam", password: SAM_PASSWORD }));
		const token = sessionFrom(login).split("=")[1]!;
		assert.equal(fs.statSync(deps.store.file).mode & 0o777, 0o600);
		const text = fs.readFileSync(deps.store.file, "utf-8");
		for (const clear of [PASSWORD, SAM_PASSWORD, code, core.normalizeSetupCode(code), cookie.split("=")[1]!, token]) assert.ok(!text.includes(clear), "a clear value leaked into the file");
		assert.deepEqual(fs.readdirSync(dir).filter((f) => f !== "accounts.json.bak"), ["accounts.json"], "no temp file left beside it");
	});

	it("a damaged file closes the site: every route answers 503, and nothing overwrites it", async () => {
		await claimed();
		fs.writeFileSync(deps.store.file, "{ not json");
		for (const request of [gateAsk("/"), gateAsk("/api/chats"), gateAsk("/api/sync/hello", undefined, { authorization: `Bearer ${"A".repeat(43)}` }), get("/login"), get("/setup"), get("/api/server-auth/account"),
			post("/api/server-auth/login", { name: "Boss", password: PASSWORD }), post("/api/server-auth/setup", { code: "x", name: "Boss", password: PASSWORD }), post("/api/server-auth/logout", {}),
			post("/api/server-auth/password", { current: "a", next: "b" }), post("/api/server-auth/sign-out-everywhere", {})]) {
			assert.equal((await call(request)).status, 503, new URL(request.url).pathname);
		}
		fs.writeFileSync(deps.store.file, JSON.stringify({ ...acc.emptyGatewayState(), version: 2 }));
		assert.equal((await call(gateAsk("/"))).status, 503, "a wrong version too");
		assert.equal(fs.readFileSync(deps.store.file, "utf-8"), JSON.stringify({ ...acc.emptyGatewayState(), version: 2 }));
		const lines: string[] = [];
		gatewayMain.announceSetupCode(deps.store, (l) => lines.push(l));
		assert.equal(lines.length, 1);
		assert.match(lines[0]!, /^\[LearnHarness gateway\] The accounts file is damaged\. Nothing was changed\. /);
	});

	it("a change made by another process is picked up", async () => {
		const { cookie } = await claimed();
		assert.equal((await call(gateAsk("/", cookie))).status, 200);
		// e.g. `lh-gateway reset-owner`: every session ends.
		writeStateFile(deps.store.file, acc.removeAccountSessions(readStateFile(deps.store.file), acc.ownerAccount(state())!.id));
		assert.equal((await call(gateAsk("/", cookie))).status, 303);
	});
});

describe("the listener and the program", () => {
	it("routes, 404 and 405", async () => {
		assert.equal(await (await call(get("/healthz"))).text(), "ok");
		assert.equal((await call(get("/api/accounts"))).status, 404);
		assert.equal((await call(get("/api/internal/unpair-all"))).status, 404);
		assert.equal((await call(get("/api/server-auth/login"))).status, 405);
	});

	it("serves over HTTP, with the gate's headers, and refuses a body over the limit with 413", async () => {
		const cfg = config(path.join(dir, "accounts.json"));
		const gateway = await gatewayMain.startGateway(cfg, { relay: { send: async () => Response.json({ ok: true }) }, log: () => {} });
		try {
			const port = (gateway.server.address() as import("node:net").AddressInfo).port;
			const base = `http://127.0.0.1:${port}`;
			assert.equal(await (await fetch(`${base}/healthz`)).text(), "ok");
			const big = await fetch(`${base}/api/server-auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` }, body: "x".repeat(gatewayMain.BODY_LIMIT_BYTES + 1) });
			assert.equal(big.status, 413);
			const pub = await fetch(`${base}/gate`, { headers: { "x-forwarded-method": "GET", "x-forwarded-uri": "/favicon.ico", "x-lh-upstream": "evil:1" } });
			assert.equal(pub.status, 200);
			assert.equal(pub.headers.get("x-lh-upstream"), "lh:3000");
			assert.equal(pub.headers.get("x-lh-gate"), OWNER_SECRET);
			const page = await fetch(`${base}/gate`, { headers: { "x-forwarded-method": "GET", "x-forwarded-uri": "/" }, redirect: "manual" });
			assert.equal(page.status, 303);
			assert.equal(page.headers.get("x-lh-upstream"), null);
		} finally {
			await gateway.stop();
		}
	});

	it("refuses to start without its settings, naming the variable and never its value", () => {
		const full = { LH_GATEWAY_FILE: "/gateway/accounts.json", LH_OWNER_UPSTREAM: "lh:3000", LH_OWNER_GATE_SECRET: OWNER_SECRET, LH_RELAY_URL: "http://caddy:9200", LH_RELAY_TOKEN: RELAY_TOKEN, PORT: "9000" };
		const cfg = loadConfig(full);
		assert.equal(cfg.port, 9000);
		assert.equal(cfg.maxAccounts, 4);
		assert.equal(cfg.trustProxy, false);
		assert.equal(loadConfig({ ...full, LH_MAX_ACCOUNTS: "2", LH_TRUST_PROXY: "1", PORT: undefined }).port, 9000);
		for (const name of ["LH_GATEWAY_FILE", "LH_OWNER_UPSTREAM", "LH_OWNER_GATE_SECRET", "LH_RELAY_URL", "LH_RELAY_TOKEN"]) {
			assert.throws(() => loadConfig({ ...full, [name]: undefined }), (e: unknown) => e instanceof ConfigError && e.message.includes(name));
		}
		assert.throws(() => loadConfig({ ...full, LH_OWNER_GATE_SECRET: "short-secret-value" }), (e: unknown) => e instanceof ConfigError && !e.message.includes("short-secret-value"));
		assert.throws(() => loadConfig({ ...full, LH_MAX_ACCOUNTS: "0" }), ConfigError);
		assert.throws(() => loadConfig({ ...full, PORT: "x" }), ConfigError);
	});

	it("sub-commands: unknown → 2", async () => {
		const original = console.error;
		console.error = () => {};
		try {
			assert.equal(await gatewayMain.main(["nope"]), 2);
			assert.equal(await gatewayMain.main(["reset-owner"]), 1);
		} finally {
			console.error = original;
		}
	});
});
