/**
 * Cloud sync Phase 5, slice 1 (docs/cloud-sync.md): pairing a desktop app
 * with the server, device keys, and the protocol version rule.
 *
 * Pins the owner's decisions: a pairing code that works once for 10 minutes;
 * a device key that opens the sync API and nothing else; pairing that lasts
 * until removed (Remove, Sign out everywhere, a password change,
 * reset-password); re-pairing as the same device; versions equal or paused,
 * with the two approved sentences; https only; and that nothing happens in
 * an app that was never paired.
 *
 * One process plays both sides: the server's routes are called through the
 * same gate the proxy uses, and the desktop's client gets a fetch that
 * delivers to them. LH_AUTH_FILE is redirected BEFORE the first config import.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sync-pairing-"));
process.env.LH_AUTH_FILE = path.join(TMP, "secrets", "auth.json");
process.env.LH_DATA_DIR = path.join(TMP, "data");

const core = await import("../src/core/server-auth.ts");
const devices = await import("../src/core/sync/devices.ts");
const protocol = await import("../src/core/sync/protocol.ts");
const { normalizeServerAddress } = await import("../src/core/sync/address.ts");
const store = await import("../src/store/server-auth.ts");
const pairingStore = await import("../src/store/sync/pairing.ts");
const server = await import("../src/server/server-auth.ts");
const syncHttp = await import("../src/server/sync/http.ts");
const client = await import("../src/server/sync/client.ts");
const cloudHttp = await import("../src/server/sync/cloud-http.ts");
const reset = await import("../scripts/server-reset-password.mjs");
const { isSensitivePath } = await import("../src/agent/tools/fs-shared.ts");

const SERVER = "https://learn.example.com";
const HOST = "learn.example.com";
const MIN = 60 * 1000;
const PASSWORD = "correct horse battery";

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

async function asServer<T>(run: () => T | Promise<T>): Promise<T> {
	const previous = process.env.LH_SERVER_MODE;
	process.env.LH_SERVER_MODE = "1";
	try { return await run(); } finally {
		if (previous === undefined) delete process.env.LH_SERVER_MODE; else process.env.LH_SERVER_MODE = previous;
	}
}

function browserPost(pathname: string, body: unknown, cookie?: string): Request {
	return new Request(SERVER + pathname, {
		method: "POST",
		headers: { "content-type": "application/json", origin: SERVER, host: HOST, "user-agent": "Mozilla/5.0 (iPhone) Safari/605.1", ...(cookie ? { cookie } : {}) },
		body: JSON.stringify(body),
	});
}

/** A server with a password, and a signed-in browser's cookie. */
async function serverWithLogin(): Promise<string> {
	const code = core.newSetupCode();
	store.writeServerAuthState({ ...core.emptyServerAuthState(), setupCodeHash: core.setupCodeHash(code) });
	const response = await asServer(() => server.setupResponse(browserPost("/api/server-auth/setup", { code, password: PASSWORD })));
	assert.equal(response.status, 200);
	return (response.headers.get("set-cookie") ?? "").split(";")[0]!;
}

async function pairingCode(cookie: string): Promise<string> {
	const response = await asServer(() => syncHttp.desktopsResponse(browserPost("/api/server-auth/desktops", { op: "code" }, cookie)));
	assert.equal(response.status, 200);
	return ((await response.json()) as { code: string }).code;
}

/** What the desktop's fetch reaches: the server's gate, then its routes. */
const serverFetch: typeof fetch = async (input, init) => {
	const request = new Request(input as string, init);
	const url = new URL(request.url);
	return asServer(async () => {
		const gated = server.serverGate({ method: request.method, pathname: url.pathname, headers: request.headers, url: request.url });
		if (gated) return gated;
		if (url.pathname === "/api/sync/pair") return syncHttp.pairResponse(request);
		if (url.pathname === "/api/sync/hello") return syncHttp.helloResponse(request);
		return Response.json({ error: "Not found." }, { status: 404 });
	});
};

function desktopFiles(): string[] {
	const dir = path.dirname(process.env.LH_AUTH_FILE!);
	return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.startsWith("cloud-sync")) : [];
}

beforeEach(() => {
	fs.rmSync(path.join(TMP, "secrets"), { recursive: true, force: true });
	fs.rmSync(path.join(TMP, "data"), { recursive: true, force: true });
	client.resetCloudLink();
});

describe("the protocol version rule", () => {
	it("starts at 1, and names the side that is behind in the approved words", () => {
		assert.equal(protocol.SYNC_PROTOCOL_VERSION, 1);
		assert.deepEqual(protocol.protocolVerdict(1, 1), { ok: true });
		assert.deepEqual(protocol.protocolVerdict(2, 1), { ok: false, behind: "server", message: "Update the server to continue syncing" });
		assert.deepEqual(protocol.protocolVerdict(1, 2), { ok: false, behind: "app", message: "Update LearnHarness to continue syncing" });
	});

	it("the server refuses a request that speaks another version, and says its own", async () => {
		const cookie = await serverWithLogin();
		const code = await pairingCode(cookie);
		const paired = await client.pairWithServer({ server: SERVER, code, name: "Desk" }, { fetch: serverFetch });
		assert.equal(paired.ok, true);
		const key = pairingStore.readCloudPairing()!.key!;
		const request = (version: string | null) => new Request(`${SERVER}/api/sync/hello`, {
			method: "POST",
			headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(version === null ? {} : { [protocol.SYNC_PROTOCOL_HEADER]: version }) },
			body: "{}",
		});
		const same = await asServer(() => syncHttp.helloResponse(request("1")));
		assert.equal(same.status, 200);
		const newer = await asServer(() => syncHttp.helloResponse(request("2")));
		assert.equal(newer.status, 409);
		assert.deepEqual(await newer.json(), { error: "Update the server to continue syncing", code: "protocol_mismatch", protocol: 1 });
		assert.equal((await asServer(() => syncHttp.helloResponse(request(null)))).status, 400);
	});
});

describe("the server address", () => {
	it("must be https, except on this machine", () => {
		assert.deepEqual(normalizeServerAddress("learn.example.com"), { ok: true, url: "https://learn.example.com" });
		assert.deepEqual(normalizeServerAddress(" https://learn.example.com/some/page?x=1 "), { ok: true, url: "https://learn.example.com" });
		assert.deepEqual(normalizeServerAddress("http://127.0.0.1:3100"), { ok: true, url: "http://127.0.0.1:3100" });
		assert.deepEqual(normalizeServerAddress("http://localhost:3100/"), { ok: true, url: "http://localhost:3100" });
		assert.equal(normalizeServerAddress("http://learn.example.com").ok, false);
		assert.equal(normalizeServerAddress("ftp://learn.example.com").ok, false);
		assert.equal(normalizeServerAddress("https://me:secret@learn.example.com").ok, false);
		assert.equal(normalizeServerAddress("").ok, false);
		assert.equal(normalizeServerAddress(42).ok, false);
	});
});

describe("pairing codes", () => {
	it("look like the setup code, work once, and run out after 10 minutes", () => {
		const t0 = 1_000_000;
		const started = devices.startPairing(core.emptyServerAuthState(), t0);
		assert.match(started.code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
		assert.equal(started.expiresAt, t0 + 10 * MIN);
		assert.equal(devices.pairingCodeMatches(started.state, started.code, t0 + 10 * MIN - 1), true);
		assert.equal(devices.pairingCodeMatches(started.state, started.code.toLowerCase().replace("-", " "), t0), true, "typed loosely");
		assert.equal(devices.pairingCodeMatches(started.state, started.code, t0 + 10 * MIN), false, "run out");
		assert.equal(devices.pairingCodeMatches(started.state, "AAAA-AAAA", t0), false);
		const paired = devices.completePairing(started.state, devices.newDeviceId(), "Desk", t0);
		assert.equal(paired.ok, true);
		if (!paired.ok) return;
		assert.equal(paired.state.pairing, null, "used up");
		assert.equal(devices.pairingCodeMatches(paired.state, started.code, t0), false);
		assert.equal(paired.state.devices[0]!.keyHash, core.sha256(paired.key), "only the key's hash is stored");
		assert.equal(JSON.stringify(paired.state).includes(paired.key), false);
	});

	it("a new code replaces the one still waiting", () => {
		const first = devices.startPairing(core.emptyServerAuthState(), 0);
		const second = devices.startPairing(first.state, 1);
		assert.equal(devices.pairingCodeMatches(second.state, first.code, 2), false);
		assert.equal(devices.pairingCodeMatches(second.state, second.code, 2), true);
	});

	it("at most 10 desktops, and the same device pairing again takes its old place", () => {
		let state = core.emptyServerAuthState();
		const ids: string[] = [];
		for (let i = 0; i < 10; i++) {
			const id = devices.newDeviceId();
			ids.push(id);
			const paired = devices.completePairing(state, id, `PC ${i}`, i);
			assert.equal(paired.ok, true);
			if (paired.ok) state = paired.state;
		}
		assert.deepEqual(devices.completePairing(state, devices.newDeviceId(), "One too many", 99), { ok: false, reason: "too_many" });
		const again = devices.completePairing(state, ids[3]!, "PC 3 renamed", 100);
		assert.equal(again.ok, true);
		if (!again.ok) return;
		assert.equal(again.state.devices.length, 10);
		assert.equal(again.state.devices.filter((d) => d.id === ids[3]).length, 1);
		assert.equal(devices.findDevice(again.state, again.key)?.name, "PC 3 renamed");
	});

	it("device ids and names are checked", () => {
		assert.equal(devices.isDeviceId(devices.newDeviceId()), true);
		assert.equal(devices.isDeviceId("dev_123"), false);
		assert.equal(devices.isDeviceId("../../etc"), false);
		assert.equal(devices.cleanDeviceName("  Office\n PC  "), "Office PC");
		assert.equal(devices.cleanDeviceName(""), null);
		assert.equal(devices.cleanDeviceName("x".repeat(41)), null);
		assert.equal(devices.cleanDeviceName(7), null);
	});
});

describe("pairing over HTTP", () => {
	it("only a signed-in browser gets a code", async () => {
		await serverWithLogin();
		const response = await asServer(() => syncHttp.desktopsResponse(browserPost("/api/server-auth/desktops", { op: "code" })));
		assert.equal(response.status, 401);
		assert.equal(store.readServerAuthState().pairing, null);
	});

	it("a desktop pairs with the code and gets a key the server keeps only as a hash", async () => {
		const cookie = await serverWithLogin();
		const code = await pairingCode(cookie);
		const result = await client.pairWithServer({ server: "learn.example.com", code, name: "Office PC" }, { fetch: serverFetch });
		assert.equal(result.ok, true);
		const pairing = pairingStore.readCloudPairing()!;
		assert.equal(pairing.server, SERVER);
		assert.equal(pairing.name, "Office PC");
		assert.match(pairing.deviceId, /^dev_[0-9a-f]{16}$/);
		const state = store.readServerAuthState();
		assert.equal(state.devices.length, 1);
		assert.equal(state.devices[0]!.id, pairing.deviceId);
		assert.equal(state.devices[0]!.keyHash, core.sha256(pairing.key!));
		assert.equal(fs.readFileSync(store.serverLoginFile(), "utf-8").includes(pairing.key!), false);
		assert.equal(state.pairing, null);
		// The code is spent.
		const second = await client.pairWithServer({ server: SERVER, code, name: "Another" }, { fetch: serverFetch });
		assert.deepEqual(second.ok, false);
		if (!second.ok) assert.equal(second.status, 401);
	});

	it("the key file on the PC is private and closed to the agents' file tools", async () => {
		const cookie = await serverWithLogin();
		await client.pairWithServer({ server: SERVER, code: await pairingCode(cookie), name: "Desk" }, { fetch: serverFetch });
		const file = pairingStore.cloudPairingFile();
		assert.equal(path.basename(file), "cloud-sync.json");
		assert.equal(path.dirname(file), path.dirname(process.env.LH_AUTH_FILE!));
		if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		assert.equal(isSensitivePath(file), true);
		assert.equal(isSensitivePath(`${file}.tmp-3f2504e0-4f89-41d3-9a0c-0305e82c3301`), true);
	});

	it("wrong codes count toward the login lockout", async () => {
		const cookie = await serverWithLogin();
		const code = await pairingCode(cookie);
		for (let i = 0; i < 4; i++) {
			const wrong = await client.pairWithServer({ server: SERVER, code: "AAAA-AAAA", name: "Desk" }, { fetch: serverFetch });
			assert.equal(!wrong.ok && wrong.status, 401);
		}
		const fifth = await client.pairWithServer({ server: SERVER, code: "AAAA-AAAA", name: "Desk" }, { fetch: serverFetch });
		assert.equal(!fifth.ok && fifth.status, 429);
		if (!fifth.ok) assert.match(fifth.error, /^Too many attempts\. Try again in 15 min\.$/);
		const right = await client.pairWithServer({ server: SERVER, code, name: "Desk" }, { fetch: serverFetch });
		assert.equal(!right.ok && right.status, 429, "the right code waits out the pause too");
		assert.deepEqual(desktopFiles(), [], "nothing was stored on the desktop");
	});

	it("refuses a request it can't read, before anything is stored", async () => {
		const cookie = await serverWithLogin();
		const code = await pairingCode(cookie);
		const bad = await asServer(() => syncHttp.pairResponse(new Request(`${SERVER}/api/sync/pair`, {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceId: "../../x", name: "Desk" }),
		})));
		assert.equal(bad.status, 400);
		assert.equal(store.readServerAuthState().devices.length, 0);
		assert.notEqual(store.readServerAuthState().pairing, null, "the code is still good");
	});

	it("the desktop refuses a plain http server, an empty code and an empty name itself", async () => {
		let called = false;
		const spy: typeof fetch = async () => { called = true; return Response.json({}); };
		assert.equal((await client.pairWithServer({ server: "http://learn.example.com", code: "AAAA-AAAA", name: "Desk" }, { fetch: spy })).ok, false);
		assert.equal((await client.pairWithServer({ server: SERVER, code: "", name: "Desk" }, { fetch: spy })).ok, false);
		assert.equal((await client.pairWithServer({ server: SERVER, code: "AAAA-AAAA", name: " " }, { fetch: spy })).ok, false);
		assert.equal(called, false);
		assert.deepEqual(desktopFiles(), []);
	});
});

describe("what a device key opens", () => {
	async function pairedKey(): Promise<{ key: string; cookie: string }> {
		const cookie = await serverWithLogin();
		await client.pairWithServer({ server: SERVER, code: await pairingCode(cookie), name: "Desk" }, { fetch: serverFetch });
		return { key: pairingStore.readCloudPairing()!.key!, cookie };
	}
	const gate = (pathname: string, headers: Record<string, string>, method = "POST") =>
		asServer(() => server.serverGate({ method, pathname, headers: new Headers(headers), url: SERVER + pathname }));

	it("the sync API, and nothing else", async () => {
		const { key } = await pairedKey();
		const auth = { authorization: `Bearer ${key}` };
		assert.equal(await gate("/api/sync/hello", auth), null);
		assert.equal((await gate("/api/chats", auth, "GET"))?.status, 401);
		assert.equal((await gate("/api/settings", { ...auth, origin: SERVER, host: HOST }))?.status, 401);
		assert.equal((await gate("/api/server-auth/desktops", { ...auth, origin: SERVER, host: HOST }))?.status, 401);
		assert.equal((await gate("/", auth, "GET"))?.status, 303, "pages still go to the login page");
	});

	it("a browser's login does not open the sync API", async () => {
		const { cookie } = await pairedKey();
		const refused = await gate("/api/sync/hello", { cookie, origin: SERVER, host: HOST });
		assert.equal(refused?.status, 401);
		assert.equal(((await refused!.json()) as { code: string }).code, "not_paired");
	});

	it("another site's page is refused, and a wrong key too", async () => {
		const { key } = await pairedKey();
		assert.equal((await gate("/api/sync/hello", { authorization: `Bearer ${key}`, origin: "https://evil.example", host: HOST }))?.status, 403);
		assert.equal((await gate("/api/sync/pair", { origin: "https://evil.example", host: HOST }))?.status, 403);
		assert.equal((await gate("/api/sync/hello", { authorization: `Bearer ${key}`, "sec-fetch-site": "cross-site" }))?.status, 403);
		assert.equal((await gate("/api/sync/hello", { authorization: `Bearer ${"x".repeat(43)}` }))?.status, 401);
		assert.equal((await gate("/api/sync/hello", {}))?.status, 401);
		assert.equal(await gate("/api/sync/pair", {}), null, "pairing has no key yet; its route checks the code");
	});

	it("a damaged login file closes the sync API", async () => {
		const { key } = await pairedKey();
		fs.writeFileSync(store.serverLoginFile(), "{not json");
		assert.equal((await gate("/api/sync/hello", { authorization: `Bearer ${key}` }))?.status, 503);
	});
});

describe("a desktop stays paired until removed", () => {
	async function paired(): Promise<{ cookie: string; deviceId: string }> {
		const cookie = await serverWithLogin();
		await client.pairWithServer({ server: SERVER, code: await pairingCode(cookie), name: "Office PC" }, { fetch: serverFetch });
		return { cookie, deviceId: pairingStore.readCloudPairing()!.deviceId };
	}

	it("no time limit: the key still works a year later", async () => {
		await paired();
		const key = pairingStore.readCloudPairing()!.key!;
		const year = Date.now() + 365 * 24 * 60 * MIN;
		const gated = await asServer(() => server.serverGate({ method: "POST", pathname: "/api/sync/hello", headers: new Headers({ authorization: `Bearer ${key}` }), now: year }));
		assert.equal(gated, null);
	});

	it("the Account data lists it, without its key", async () => {
		const { cookie, deviceId } = await paired();
		const response = await asServer(() => server.accountResponse(new Request(`${SERVER}/api/server-auth/account`, { headers: { cookie } })));
		const body = (await response.json()) as { devices: unknown[]; desktops: Array<Record<string, unknown>> };
		assert.equal(body.devices.length, 1, "the browser login is still listed as before");
		assert.equal(body.desktops.length, 1);
		assert.deepEqual(Object.keys(body.desktops[0]!).sort(), ["id", "lastSeenAt", "name", "pairedAt"]);
		assert.equal(body.desktops[0]!.id, deviceId);
		assert.equal(body.desktops[0]!.name, "Office PC");
	});

	it("Remove unpairs that desktop: it keeps its identity and says it needs pairing again", async () => {
		const { cookie, deviceId } = await paired();
		assert.equal((await client.contactServer({ fetch: serverFetch })).sync.state, "ok");
		const removed = await asServer(() => syncHttp.desktopsResponse(browserPost("/api/server-auth/desktops", { op: "remove", id: deviceId }, cookie)));
		assert.equal(removed.status, 200);
		const status = await client.contactServer({ fetch: serverFetch });
		assert.equal(status.sync.state, "needs-pairing");
		assert.equal(status.paired, false);
		assert.deepEqual(status.device, { id: deviceId, name: "Office PC" });
		assert.equal(pairingStore.readCloudPairing()!.key, null);
		// A new code reconnects it as the same device.
		const again = await client.pairWithServer({ server: SERVER, code: await pairingCode(cookie), name: "Office PC" }, { fetch: serverFetch });
		assert.equal(again.ok, true);
		assert.equal(pairingStore.readCloudPairing()!.deviceId, deviceId);
		assert.deepEqual(store.readServerAuthState().devices.map((d) => d.id), [deviceId]);
		assert.equal((await client.contactServer({ fetch: serverFetch })).sync.state, "ok");
	});

	it("removing a desktop that is already gone says so", async () => {
		const { cookie } = await paired();
		const response = await asServer(() => syncHttp.desktopsResponse(browserPost("/api/server-auth/desktops", { op: "remove", id: "dev_0000000000000000" }, cookie)));
		assert.equal(response.status, 404);
		assert.equal(store.readServerAuthState().devices.length, 1);
	});

	it("Sign out everywhere unpairs it", async () => {
		const { cookie } = await paired();
		await asServer(() => server.signOutEverywhereResponse(browserPost("/api/server-auth/sign-out-everywhere", {}, cookie)));
		assert.deepEqual(store.readServerAuthState().devices, []);
		assert.equal((await client.contactServer({ fetch: serverFetch })).sync.state, "needs-pairing");
	});

	it("a password change unpairs it, and drops a code that was waiting", async () => {
		const { cookie } = await paired();
		await pairingCode(cookie);
		const response = await asServer(() => server.changePasswordResponse(browserPost("/api/server-auth/password", { current: PASSWORD, next: "another long password" }, cookie)));
		assert.equal(response.status, 200);
		const state = store.readServerAuthState();
		assert.deepEqual(state.devices, []);
		assert.equal(state.pairing, null);
		assert.equal(state.sessions.length, 1, "the browser that changed it stays signed in, as before");
	});

	it("reset-password unpairs it", async () => {
		await paired();
		reset.resetServerPassword(store.serverLoginFile());
		const state = store.readServerAuthState();
		assert.deepEqual(state.devices, []);
		assert.equal(state.pairing, null);
	});

	it("a different server never learns this desktop's id", async () => {
		const { deviceId } = await paired();
		let sent: { deviceId?: string } = {};
		const other: typeof fetch = async (_input, init) => {
			sent = JSON.parse(String(init?.body)) as { deviceId?: string };
			return Response.json({ error: "no" }, { status: 401 });
		};
		await client.pairWithServer({ server: "https://other.example.org", code: "AAAA-AAAA", name: "Office PC" }, { fetch: other });
		assert.match(sent.deviceId ?? "", /^dev_[0-9a-f]{16}$/);
		assert.notEqual(sent.deviceId, deviceId);
	});
});

describe("the desktop's view of its link", () => {
	async function paired(): Promise<void> {
		const cookie = await serverWithLogin();
		await client.pairWithServer({ server: SERVER, code: await pairingCode(cookie), name: "Desk" }, { fetch: serverFetch });
		client.resetCloudLink();
	}

	it("starting, then ok after the first contact", async () => {
		await paired();
		assert.equal(client.cloudStatus().sync.state, "starting");
		const status = await client.contactServer({ fetch: serverFetch, now: () => 5000 });
		assert.equal(status.sync.state, "ok");
		assert.equal(status.sync.lastContactAt, 5000);
		assert.equal(status.sync.message, null);
	});

	it("offline when the server can't be reached, and back to ok afterwards", async () => {
		await paired();
		const down: typeof fetch = async () => { throw new TypeError("fetch failed"); };
		assert.equal((await client.contactServer({ fetch: down })).sync.state, "offline");
		const proxyPage: typeof fetch = async () => new Response("<html>Bad gateway</html>", { status: 502 });
		assert.equal((await client.contactServer({ fetch: proxyPage })).sync.state, "offline");
		assert.equal(pairingStore.readCloudPairing()!.key !== null, true, "being offline never unpairs");
		assert.equal((await client.contactServer({ fetch: serverFetch })).sync.state, "ok");
	});

	it("paused with the approved sentence when the versions differ, and resumes when they match", async () => {
		await paired();
		const serverAt = (version: number): typeof fetch => async () =>
			Response.json({ error: "x", code: "protocol_mismatch", protocol: version }, { status: 409 });
		let status = await client.contactServer({ fetch: serverAt(2) });
		assert.equal(status.sync.state, "paused");
		assert.equal(status.sync.message, "Update LearnHarness to continue syncing");
		status = await client.contactServer({ fetch: serverAt(0) });
		assert.equal(status.sync.message, "Update the server to continue syncing");
		assert.equal(status.paired, true, "a pause never unpairs");
		status = await client.contactServer({ fetch: serverFetch });
		assert.equal(status.sync.state, "ok");
		assert.equal(status.sync.message, null);
	});

	it("a server from before sync existed is the side that is behind", async () => {
		await paired();
		const old: typeof fetch = async () => Response.json({ error: "This request must come from the LearnHarness site itself." }, { status: 403 });
		const status = await client.contactServer({ fetch: old });
		assert.equal(status.sync.state, "paused");
		assert.equal(status.sync.message, "Update the server to continue syncing");
	});

	it("measures how far the server's clock is from the PC's", async () => {
		await paired();
		let tick = 0;
		const times = [10_000, 10_200];
		const ahead: typeof fetch = async () => Response.json({ protocol: 1, time: 70_100, device: { id: "x", name: "Desk" } });
		await client.syncRequest("/api/sync/hello", { method: "POST", body: {} }, { fetch: ahead, now: () => times[Math.min(tick++, 1)]! });
		assert.equal(client.serverClockOffsetMs(), 60_000);
	});
});

describe("Phase 6: since when the server can't be reached, and telling the open windows", () => {
	async function paired(): Promise<void> {
		const cookie = await serverWithLogin();
		await client.pairWithServer({ server: SERVER, code: await pairingCode(cookie), name: "Desk" }, { fetch: serverFetch });
		client.resetCloudLink();
	}

	it("remembers the first failure of an offline spell, and forgets it when the server answers", async () => {
		await paired();
		const down: typeof fetch = async () => { throw new Error("no route"); };
		assert.equal(client.cloudStatus().sync.offlineSince, null);
		await client.syncRequest("/api/sync/hello", { method: "POST", body: {} }, { fetch: down, now: () => 50_000 });
		assert.deepEqual([client.cloudStatus().sync.state, client.cloudStatus().sync.offlineSince], ["offline", 50_000]);
		await client.syncRequest("/api/sync/hello", { method: "POST", body: {} }, { fetch: down, now: () => 61_000 });
		assert.equal(client.cloudStatus().sync.offlineSince, 50_000, "a second failure is the same spell");
		// A proxy's error page counts as not reaching the server, too.
		const page: typeof fetch = async () => new Response("<html>Bad gateway</html>", { status: 502 });
		await client.syncRequest("/api/sync/hello", { method: "POST", body: {} }, { fetch: page, now: () => 70_000 });
		assert.equal(client.cloudStatus().sync.offlineSince, 50_000);
		await client.syncRequest("/api/sync/hello", { method: "POST", body: {} }, { fetch: serverFetch, now: () => 80_000 });
		assert.deepEqual([client.cloudStatus().sync.state, client.cloudStatus().sync.offlineSince], ["ok", null]);
		await client.syncRequest("/api/sync/hello", { method: "POST", body: {} }, { fetch: down, now: () => 90_000 });
		assert.equal(client.cloudStatus().sync.offlineSince, 90_000, "a new spell has its own start");
	});

	it("announces a changed sync state once, and nothing while it stays the same", async () => {
		const { subscribe } = await import("../src/core/events.ts");
		const { announceCloudState } = await import("../src/server/sync/round.ts");
		await paired();
		let heard = 0;
		const off = subscribe((event) => { if (event.type === "cloud-changed") heard += 1; });
		try {
			await client.syncRequest("/api/sync/hello", { method: "POST", body: {} }, { fetch: serverFetch });
			announceCloudState();
			const start = heard;
			announceCloudState();
			announceCloudState();
			assert.equal(heard, start, "the same state again says nothing");
			const down: typeof fetch = async () => { throw new Error("no route"); };
			await client.syncRequest("/api/sync/hello", { method: "POST", body: {} }, { fetch: down });
			announceCloudState();
			assert.equal(heard, start + 1, "offline is said once");
			announceCloudState();
			assert.equal(heard, start + 1);
			await client.syncRequest("/api/sync/hello", { method: "POST", body: {} }, { fetch: serverFetch });
			announceCloudState();
			assert.equal(heard, start + 2, "and so is being back");
		} finally { off(); }
	});

	it("an app that was never paired announces nothing", async () => {
		const { subscribe } = await import("../src/core/events.ts");
		const { announceCloudState } = await import("../src/server/sync/round.ts");
		let heard = 0;
		const off = subscribe((event) => { if (event.type === "cloud-changed") heard += 1; });
		try {
			announceCloudState();
			assert.equal(heard, 0);
			assert.deepEqual(desktopFiles(), []);
		} finally { off(); }
	});
});

describe("where nothing is paired, nothing happens", () => {
	it("an app that was never paired reads as off and writes no file", async () => {
		assert.deepEqual(client.cloudStatus(), { role: "desktop", paired: false, server: null, device: null, sync: { state: "off", message: null, lastContactAt: null, offlineSince: null } });
		let called = false;
		const spy: typeof fetch = async () => { called = true; return Response.json({}); };
		assert.equal((await client.contactServer({ fetch: spy })).sync.state, "off");
		assert.deepEqual(await client.syncRequest("/api/sync/hello", {}, { fetch: spy }), { ok: false, reason: "not-paired" });
		assert.equal(called, false, "no request leaves an unpaired app");
		assert.deepEqual(desktopFiles(), []);
		assert.equal(fs.existsSync(path.join(TMP, "data")), false);
		const response = cloudHttp.cloudStatusResponse();
		assert.equal(((await response.json()) as { sync: { state: string } }).sync.state, "off");
	});

	it("the server's routes answer 404 outside server mode", async () => {
		const request = () => new Request(`${SERVER}/api/sync/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
		assert.equal((await syncHttp.pairResponse(request())).status, 404);
		assert.equal(syncHttp.helloResponse(request()).status, 404);
		assert.equal((await syncHttp.desktopsResponse(request())).status, 404);
		assert.equal(server.serverGate({ method: "POST", pathname: "/api/sync/hello", headers: new Headers() }), null, "the gate is inert without server mode, as before");
	});

	it("the cloud server never pairs itself", async () => {
		const status = await asServer(() => cloudHttp.cloudStatusResponse());
		assert.deepEqual(await status.json(), { role: "server", held: {}, desktops: [] });
		const action = await asServer(() => cloudHttp.cloudActionResponse(browserPost("/api/cloud", { op: "pair", server: SERVER, code: "AAAA-AAAA", name: "x" })));
		assert.equal(action.status, 404);
	});

	it("a login file from before Phase 5 still reads, with no desktops", () => {
		fs.mkdirSync(path.dirname(store.serverLoginFile()), { recursive: true });
		fs.writeFileSync(store.serverLoginFile(), JSON.stringify({ version: 1, password: null, setupCodeHash: null, sessions: [], lockouts: {} }));
		const state = store.readServerAuthState();
		assert.deepEqual(state.devices, []);
		assert.equal(state.pairing, null);
	});

	it("a damaged device record closes the file instead of being guessed at", () => {
		fs.mkdirSync(path.dirname(store.serverLoginFile()), { recursive: true });
		fs.writeFileSync(store.serverLoginFile(), JSON.stringify({ version: 1, password: null, setupCodeHash: null, sessions: [], lockouts: {}, devices: [{ id: "dev_x", name: "PC", keyHash: "nope", pairedAt: 1, lastSeenAt: 1 }] }));
		assert.throws(() => store.readServerAuthState());
	});
});
