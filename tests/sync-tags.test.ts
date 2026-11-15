/**
 * Multi-account, slice 2a (docs/multi-account-build.md, "Tags in codes and
 * keys"): a copy that knows its account tag (LH_ACCOUNT_TAG) appends it to
 * its pairing codes (XXXX-XXXX-TTT) and puts it before its device keys (46
 * characters); a copy without the variable issues exactly today's 8 / 43.
 * A bad tag fails closed. Behind the gateway (LH_GATE_SECRET) a copy with no
 * password of its own still pairs.
 *
 * One process plays both sides, as in tests/sync-pairing.test.ts: the real
 * desktop client gets a fetch that delivers to the server's gate and routes.
 * LH_AUTH_FILE is redirected BEFORE the first config import.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sync-tags-"));
process.env.LH_AUTH_FILE = path.join(TMP, "secrets", "auth.json");
process.env.LH_DATA_DIR = path.join(TMP, "data");
delete process.env.LH_GATE_SECRET;
delete process.env.LH_ACCOUNT_TAG;
delete process.env.LH_TRUST_PROXY;
process.env.LH_SYNC_LOOP = "off";

const core = await import("../src/core/server-auth.ts");
const devices = await import("../src/core/sync/devices.ts");
const accounts = await import("../src/core/accounts.ts");
const store = await import("../src/store/server-auth.ts");
const pairingStore = await import("../src/store/sync/pairing.ts");
const server = await import("../src/server/server-auth.ts");
const syncHttp = await import("../src/server/sync/http.ts");
const client = await import("../src/server/sync/client.ts");

const SERVER = "https://learn.example.com";
const HOST = "learn.example.com";
const PASSWORD = "correct horse battery";
const SECRET = "k3Jq9XvT0pLw8ZrB2mN5sY7dF1gH4cE6aQ-uViOtRe_";
const TAG = "K7Q";
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SYMBOL = "[0-9A-HJKMNP-TV-Z]";

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

beforeEach(() => {
	fs.rmSync(path.join(TMP, "secrets"), { recursive: true, force: true });
	fs.rmSync(path.join(TMP, "data"), { recursive: true, force: true });
	client.resetCloudLink();
});

type Vars = Record<string, string | undefined>;

/** Server mode plus these variables in process.env while `run` runs. */
async function withEnv<T>(vars: Vars, run: () => T | Promise<T>): Promise<T> {
	const all: Vars = { LH_SERVER_MODE: "1", ...vars };
	const previous = Object.fromEntries(Object.keys(all).map((key) => [key, process.env[key]]));
	for (const [key, value] of Object.entries(all)) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
	try { return await run(); } finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
	}
}

const TAGGED: Vars = { LH_ACCOUNT_TAG: TAG };
const GATEWAY: Vars = { LH_GATE_SECRET: SECRET, LH_ACCOUNT_TAG: TAG };

function browserPost(pathname: string, body: unknown, headers: Record<string, string> = {}): Request {
	return new Request(SERVER + pathname, {
		method: "POST",
		headers: { "content-type": "application/json", origin: SERVER, host: HOST, "user-agent": "Mozilla/5.0 (iPhone) Safari/605.1", ...headers },
		body: JSON.stringify(body),
	});
}

/** A server with a password, and a signed-in browser's cookie. */
async function serverWithLogin(): Promise<string> {
	const code = core.newSetupCode();
	store.writeServerAuthState({ ...core.emptyServerAuthState(), setupCodeHash: core.setupCodeHash(code) });
	const response = await withEnv({}, () => server.setupResponse(browserPost("/api/server-auth/setup", { code, password: PASSWORD })));
	assert.equal(response.status, 200);
	return (response.headers.get("set-cookie") ?? "").split(";")[0]!;
}

async function codeFrom(vars: Vars, headers: Record<string, string>): Promise<string> {
	const response = await withEnv(vars, () => syncHttp.desktopsResponse(browserPost("/api/server-auth/desktops", { op: "code" }, headers)));
	assert.equal(response.status, 200);
	return ((await response.json()) as { code: string }).code;
}

/** The desktop's fetch: the server's gate, then its routes, under `vars`. With
 *  `gate`, every request gets X-LH-Gate (what the gateway hop adds). */
function serverFetch(vars: Vars, extra: Record<string, string> = {}): typeof fetch {
	return async (input, init) => {
		const original = new Request(input as string, init);
		const headers = new Headers(original.headers);
		headers.set("host", HOST);
		for (const [name, value] of Object.entries(extra)) headers.set(name, value);
		const body = original.method === "GET" ? undefined : await original.text();
		const request = new Request(original.url, { method: original.method, headers, body });
		const url = new URL(request.url);
		return withEnv(vars, async () => {
			const gated = server.serverGate({ method: request.method, pathname: url.pathname, headers: request.headers, url: request.url });
			if (gated) return gated;
			if (url.pathname === "/api/sync/pair") return syncHttp.pairResponse(request);
			if (url.pathname === "/api/sync/hello") return syncHttp.helloResponse(request);
			if (url.pathname === "/api/sync/sessions") return syncHttp.sessionsExchangeResponse(request);
			return Response.json({ error: "Not found." }, { status: 404 });
		});
	};
}

function pairRequest(code: unknown, headers: Record<string, string> = {}): Request {
	return new Request(SERVER + "/api/sync/pair", {
		method: "POST",
		headers: { "content-type": "application/json", host: HOST, ...headers },
		body: JSON.stringify({ code, deviceId: devices.newDeviceId(), name: "Desktop" }),
	});
}

function helloStatus(vars: Vars, key: string, extra: Record<string, string> = {}): number {
	const headers = new Headers({ host: HOST, authorization: `Bearer ${key}`, "x-lh-sync-protocol": "3", ...extra });
	return withEnvSync(vars, () => {
		const gated = server.serverGate({ method: "POST", pathname: "/api/sync/hello", headers, url: SERVER + "/api/sync/hello", touch: () => {} });
		if (gated) return gated.status;
		return syncHttp.helloResponse(new Request(SERVER + "/api/sync/hello", { method: "POST", headers })).status;
	});
}

function withEnvSync<T>(vars: Vars, run: () => T): T {
	const all: Vars = { LH_SERVER_MODE: "1", ...vars };
	const previous = Object.fromEntries(Object.keys(all).map((key) => [key, process.env[key]]));
	for (const [key, value] of Object.entries(all)) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
	try { return run(); } finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
	}
}

/** Flip one symbol of the tag to another symbol of the alphabet. */
function otherTag(tag: string): string {
	const next = ALPHABET[(ALPHABET.indexOf(tag[0]!) + 1) % ALPHABET.length]!;
	return next + tag.slice(1);
}

describe("the tag's alphabet", () => {
	it("is the setup code's alphabet, the gateway's isTag agrees, and every symbol is base64url", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 2000; i += 1) for (const c of core.normalizeSetupCode(core.newSetupCode())) seen.add(c);
		assert.deepEqual([...seen].sort().join(""), ALPHABET, "devices.ts's copy equals CODE_ALPHABET");
		for (const c of ALPHABET) {
			assert.equal(devices.isAccountTag(`${c}${c}${c}`), true);
			assert.equal(accounts.isTag(`${c}${c}${c}`), true);
		}
		for (const bad of ["", "K7", "K7QX", "k7q", "K7I", "K7L", "K7O", "K7U", "K-Q", " K7Q", "K7Q\n", 123, null]) {
			assert.equal(devices.isAccountTag(bad), false, String(bad));
			assert.equal(accounts.isTag(bad), false, String(bad));
		}
		assert.match(ALPHABET, /^[A-Za-z0-9_-]+$/);
	});

	it("an invalid tag passed to the rules throws: never an untagged code or key", () => {
		const state = core.emptyServerAuthState();
		assert.throws(() => devices.startPairing(state, 0, "k7q"));
		assert.throws(() => devices.completePairing(state, devices.newDeviceId(), "Desktop", 0, "K7QQ"));
	});
});

describe("no tag: exactly today's shapes", () => {
	it("an 8-symbol code shown XXXX-XXXX and a 43-character key", async () => {
		const cookie = await serverWithLogin();
		const code = await codeFrom({}, { cookie });
		assert.match(code, new RegExp(`^${SYMBOL}{4}-${SYMBOL}{4}$`));
		assert.equal(core.normalizeSetupCode(code).length, 8);
		const paired = await client.pairWithServer({ server: SERVER, code, name: "Desktop" }, { fetch: serverFetch({}) });
		assert.equal(paired.ok, true);
		const key = pairingStore.readCloudPairing()!.key!;
		assert.match(key, /^[A-Za-z0-9_-]{43}$/);
		assert.deepEqual(accounts.tagFromDeviceKey(key), { ok: true, tag: null });
		assert.deepEqual(accounts.tagFromPairingCode(code), { ok: true, tag: null });
	});
});

describe("with a tag", () => {
	it("an 11-symbol code ending in the tag, shown with two dashes, and a 46-character key starting with it", async () => {
		const cookie = await serverWithLogin();
		const code = await codeFrom(TAGGED, { cookie });
		assert.match(code, new RegExp(`^${SYMBOL}{4}-${SYMBOL}{4}-${TAG}$`));
		const normalized = core.normalizeSetupCode(code);
		assert.equal(normalized.length, 11);
		assert.equal(normalized.slice(-3), TAG);
		assert.deepEqual(accounts.tagFromPairingCode(code), { ok: true, tag: TAG });
		assert.equal(store.readServerAuthState().pairing!.codeHash, core.setupCodeHash(normalized), "the hash covers the whole code");

		const response = await withEnv(TAGGED, () => syncHttp.pairResponse(pairRequest(code)));
		assert.equal(response.status, 200);
		const { key } = (await response.json()) as { key: string };
		assert.equal(key.length, 46);
		assert.ok(key.startsWith(TAG));
		assert.match(key, /^[A-Za-z0-9_-]{46}$/);
		assert.deepEqual(accounts.tagFromDeviceKey(key), { ok: true, tag: TAG });
		assert.equal(store.readServerAuthState().devices[0]!.keyHash, core.sha256(key), "the hash covers all 46 characters");
		assert.equal(devices.bearerKey(new Headers({ authorization: `Bearer ${key}` })), key);
	});

	it("the real client pairs end to end, then passes hello and a sessions round through the gate", async () => {
		const cookie = await serverWithLogin();
		const code = await codeFrom(TAGGED, { cookie });
		const fetchIt = serverFetch(TAGGED);
		const paired = await client.pairWithServer({ server: SERVER, code, name: "Desktop" }, { fetch: fetchIt });
		assert.equal(paired.ok, true);
		const key = pairingStore.readCloudPairing()!.key!;
		assert.equal(key.length, 46);
		assert.ok(key.startsWith(TAG));
		const status = await withEnv(TAGGED, () => client.contactServer({ fetch: fetchIt }));
		assert.equal(status.sync.state, "ok");
		const round = await withEnv(TAGGED, () => client.syncRequest("/api/sync/sessions", { method: "POST", body: { cursor: 0 } }, { fetch: fetchIt }));
		assert.equal(round.ok, true, JSON.stringify(round));
		assert.equal(pairingStore.readCloudPairing()!.key, key, "still paired");
	});

	it("refuses its own code with the tag cut off, with another tag, and an 8-symbol code; each counts as a wrong try", async () => {
		const cookie = await serverWithLogin();
		const code = await codeFrom(TAGGED, { cookie });
		const plain = code.slice(0, 9);
		const tries = [plain, `${plain}-${otherTag(TAG)}`, core.newSetupCode()];
		for (const attempt of tries) {
			const response = await withEnv(TAGGED, () => syncHttp.pairResponse(pairRequest(attempt)));
			assert.equal(response.status, 401, attempt);
			assert.equal(((await response.json()) as { error: string }).error, "That pairing code isn't right, or it has run out. Get a new one from the server's site.");
		}
		assert.equal(store.readServerAuthState().lockouts.unknown!.failures, tries.length);
		assert.equal(store.readServerAuthState().devices.length, 0);
		const right = await withEnv(TAGGED, () => syncHttp.pairResponse(pairRequest(code.toLowerCase().replaceAll("-", " "))));
		assert.equal(right.status, 200, "case, spaces and dashes still don't matter");
	});

	it("a tagged key with its tag changed or removed is refused as not paired", async () => {
		const cookie = await serverWithLogin();
		const code = await codeFrom(TAGGED, { cookie });
		const { key } = (await (await withEnv(TAGGED, () => syncHttp.pairResponse(pairRequest(code)))).json()) as { key: string };
		assert.equal(helloStatus(TAGGED, key), 200);
		for (const wrong of [key.slice(3), otherTag(TAG) + key.slice(3), key.slice(0, 3).toLowerCase() + key.slice(3)]) {
			assert.equal(helloStatus(TAGGED, wrong), 401, wrong);
			const headers = new Headers({ host: HOST, authorization: `Bearer ${wrong}` });
			const gated = withEnvSync(TAGGED, () => server.serverGate({ method: "POST", pathname: "/api/sync/hello", headers }));
			assert.equal(((await gated!.json()) as { code: string }).code, "not_paired");
		}
	});

	it("wrong tagged codes count toward the lockout of the client's address (LH_TRUST_PROXY, last X-Forwarded-For entry)", async () => {
		const cookie = await serverWithLogin();
		const code = await codeFrom(TAGGED, { cookie });
		const vars = { ...TAGGED, LH_TRUST_PROXY: "1" };
		const from = (address: string) => ({ "x-forwarded-for": `198.51.100.9, ${address}` });
		const wrong = `${code.slice(0, 9)}-${otherTag(TAG)}`;
		for (let i = 1; i < core.LOCKOUT_FAILURES; i += 1) {
			assert.equal((await withEnv(vars, () => syncHttp.pairResponse(pairRequest(wrong, from("203.0.113.7"))))).status, 401);
		}
		assert.equal((await withEnv(vars, () => syncHttp.pairResponse(pairRequest(wrong, from("203.0.113.7"))))).status, 429);
		assert.equal((await withEnv(vars, () => syncHttp.pairResponse(pairRequest(code, from("203.0.113.7"))))).status, 429, "locked out, even with the right code");
		assert.equal(store.readServerAuthState().lockouts["198.51.100.9"], undefined, "only the last entry counts");
		assert.equal((await withEnv(vars, () => syncHttp.pairResponse(pairRequest(code, from("203.0.113.8"))))).status, 200, "another address isn't locked");
	});
});

describe("an invalid LH_ACCOUNT_TAG fails closed", () => {
	for (const bad of ["", "k7q", "K7", "K7QX", "K7O", " K7Q"]) {
		it(`"${bad}": no code is made and pairing is refused with a 5xx`, async () => {
			const cookie = await serverWithLogin();
			const good = await codeFrom({}, { cookie });
			const before = fs.readFileSync(store.serverLoginFile(), "utf8");
			const errors: unknown[] = [];
			const original = console.error;
			console.error = (...args: unknown[]) => { errors.push(args); };
			try {
				const made = await withEnv({ LH_ACCOUNT_TAG: bad }, () => syncHttp.desktopsResponse(browserPost("/api/server-auth/desktops", { op: "code" }, { cookie })));
				assert.equal(made.status, 500);
				const body = (await made.json()) as Record<string, unknown>;
				assert.equal(body.code, "account_tag_invalid");
				assert.equal("error" in body, false, "no new words: the screen shows its own generic line");
				assert.equal(fs.readFileSync(store.serverLoginFile(), "utf8"), before, "the waiting code stays as it was; nothing written");
				const paired = await withEnv({ LH_ACCOUNT_TAG: bad }, () => syncHttp.pairResponse(pairRequest(good)));
				assert.ok(paired.status >= 500, String(paired.status));
				assert.equal(store.readServerAuthState().devices.length, 0);
				assert.equal(Object.keys(store.readServerAuthState().lockouts).length, 0, "not counted as a wrong try");
			} finally {
				console.error = original;
			}
		});
	}
});

describe("behind the gateway", () => {
	const gateHeader = { [server.GATE_HEADER]: SECRET };

	it("a tagged copy with no password makes a code with the secret and no cookie, pairs the real client, and removes the PC", async () => {
		assert.equal(fs.existsSync(store.serverLoginFile()), false, "no login file, no password");
		const code = await codeFrom(GATEWAY, { ...gateHeader });
		assert.match(code, new RegExp(`^${SYMBOL}{4}-${SYMBOL}{4}-${TAG}$`));
		const noSecret = await withEnv(GATEWAY, () => syncHttp.desktopsResponse(browserPost("/api/server-auth/desktops", { op: "code" })));
		assert.equal(noSecret.status, 401);

		const fetchIt = serverFetch(GATEWAY, gateHeader);
		const paired = await client.pairWithServer({ server: SERVER, code, name: "Desktop" }, { fetch: fetchIt });
		assert.equal(paired.ok, true, JSON.stringify(paired));
		const key = pairingStore.readCloudPairing()!.key!;
		assert.ok(key.startsWith(TAG));
		assert.equal((await withEnv(GATEWAY, () => client.contactServer({ fetch: fetchIt }))).sync.state, "ok");
		assert.equal(store.readServerAuthState().password, null, "still no password of its own");

		const id = store.readServerAuthState().devices[0]!.id;
		const removed = await withEnv(GATEWAY, () => syncHttp.desktopsResponse(browserPost("/api/server-auth/desktops", { op: "remove", id }, gateHeader)));
		assert.equal(removed.status, 200);
		assert.equal(store.readServerAuthState().devices.length, 0);
		assert.equal(helloStatus(GATEWAY, key, gateHeader), 401, "the removed PC's key no longer opens sync");
	});

	it("without the secret the pairing request never reaches the route (503, the desktop's 'offline')", async () => {
		const code = await codeFrom(GATEWAY, { ...gateHeader });
		const paired = await client.pairWithServer({ server: SERVER, code, name: "Desktop" }, { fetch: serverFetch(GATEWAY) });
		assert.equal(paired.ok, false);
		assert.equal(paired.ok === false && paired.status, 503);
		assert.equal(store.readServerAuthState().devices.length, 0);
	});

	it("an Origin naming another site is refused at the sync gate", async () => {
		const code = await codeFrom(GATEWAY, { ...gateHeader });
		const paired = await client.pairWithServer({ server: SERVER, code, name: "Desktop" }, { fetch: serverFetch(GATEWAY, { ...gateHeader, origin: "https://elsewhere.example" }) });
		assert.equal(paired.ok === false && paired.status, 403);
	});

	it("without the mode a password-less server still answers today's 409", async () => {
		const state = devices.startPairing(core.emptyServerAuthState(), Date.now());
		store.writeServerAuthState(state.state);
		for (const vars of [{}, TAGGED]) {
			const response = await withEnv(vars, () => syncHttp.pairResponse(pairRequest(state.code)));
			assert.equal(response.status, 409);
			assert.deepEqual(await response.json(), { error: "This server isn't set up yet. Open its site and choose a password first." });
		}
	});

	it("a desktop paired with the untagged copy before the mode was switched on keeps working after", async () => {
		const cookie = await serverWithLogin();
		const code = await codeFrom({}, { cookie });
		const paired = await client.pairWithServer({ server: SERVER, code, name: "Desktop" }, { fetch: serverFetch({}) });
		assert.equal(paired.ok, true);
		const key = pairingStore.readCloudPairing()!.key!;
		assert.equal(key.length, 43);
		const owner: Vars = { LH_GATE_SECRET: SECRET };
		assert.equal(helloStatus(owner, key, gateHeader), 200);
		const fetchIt = serverFetch(owner, gateHeader);
		assert.equal((await withEnv(owner, () => client.contactServer({ fetch: fetchIt }))).sync.state, "ok");
		const round = await withEnv(owner, () => client.syncRequest("/api/sync/sessions", { method: "POST", body: { cursor: 0 } }, { fetch: fetchIt }));
		assert.equal(round.ok, true, JSON.stringify(round));
		const next = await codeFrom(owner, gateHeader);
		assert.match(next, new RegExp(`^${SYMBOL}{4}-${SYMBOL}{4}$`), "the owner's copy (no tag) still makes 8-symbol codes behind the gateway");
	});
});
