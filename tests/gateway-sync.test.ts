/**
 * Multi-account, slice 2 (docs/multi-account-build.md "Slice 2"), the
 * owner's copy: the REAL desktop client pairs and syncs through a stand-in
 * Caddy, the gateway's real /gate and /api/sync/pair, and the REAL copy's
 * gate and routes (behind the gateway: LH_GATE_SECRET set). A desktop paired
 * before the gateway carries on; a password change through the gateway
 * unpairs it at the copy; an unpair still owed keeps it "offline" with its
 * key. The tagged copy is tests/gateway-sync-tagged.test.ts (a copy's data
 * folder is fixed per process).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-gateway-sync-"));
process.env.LH_AUTH_FILE = path.join(TMP, "secrets", "auth.json");
process.env.LH_DATA_DIR = path.join(TMP, "data");
process.env.LH_SERVER_MODE = "1";
process.env.LH_TRUST_PROXY = "1";
process.env.LH_SYNC_LOOP = "off";
delete process.env.LH_ACCOUNT_TAG;

const h = await import("./gateway-sync-harness.ts");
process.env.LH_GATE_SECRET = h.OWNER_SECRET;

const core = await import("../src/core/server-auth.ts");
const acc = await import("../src/core/accounts.ts");
const copyStore = await import("../src/store/server-auth.ts");
const server = await import("../src/server/server-auth.ts");
const syncHttp = await import("../src/server/sync/http.ts");
const pairingStore = await import("../src/store/sync/pairing.ts");
const client = await import("../src/server/sync/client.ts");
const gatewayMain = await import("../gateway/main.ts");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const PASSWORD = "correct horse battery";
let world: ReturnType<typeof h.makeWorld>;

beforeEach(() => {
	fs.rmSync(path.join(TMP, "secrets"), { recursive: true, force: true });
	fs.rmSync(path.join(TMP, "data"), { recursive: true, force: true });
	fs.rmSync(path.join(TMP, "gateway"), { recursive: true, force: true });
	client.resetCloudLink();
	process.env.LH_GATE_SECRET = h.OWNER_SECRET;
	world = h.makeWorld(path.join(TMP, "gateway"), { upstream: h.OWNER_UPSTREAM, secret: h.OWNER_SECRET });
});

/** The gateway's first start, claimed through the site; the owner's cookie. */
async function claimedOwner(): Promise<string> {
	const lines: string[] = [];
	gatewayMain.announceSetupCode(world.deps.store, (l) => lines.push(l));
	const code = lines[1]!.split(": ")[1]!;
	const response = await world.browser("/api/server-auth/setup", { body: { code, name: "Boss", password: PASSWORD } });
	assert.equal(response.status, 200);
	return h.sessionCookieOf(response);
}

async function pairingCode(cookie: string): Promise<string> {
	const response = await world.browser("/api/server-auth/desktops", { body: { op: "code" }, cookie });
	assert.equal(response.status, 200, "the copy's own route, through /gate");
	return ((await response.json()) as { code: string }).code;
}

const deps = () => ({ fetch: world.desktopFetch });
const storedKey = () => pairingStore.readCloudPairing()?.key ?? null;

describe("the owner's copy through the gateway", () => {
	it("pairs with an 8-character code, gets a 43-character key, says hello and syncs", async () => {
		const cookie = await claimedOwner();
		const code = await pairingCode(cookie);
		assert.match(code, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
		const paired = await client.pairWithServer({ server: h.SERVER, code, name: "Desktop" }, deps());
		assert.equal(paired.ok, true, JSON.stringify(paired));
		assert.equal(storedKey()!.length, 43);
		// The pairing hop: the copy's secret, the desktop's address, no cookie or Origin.
		const hop = world.relayCalls.find((c) => c.path === "/api/sync/pair")!;
		assert.equal(hop.upstream, h.OWNER_UPSTREAM);
		assert.equal(hop.gateSecret, h.OWNER_SECRET);
		assert.equal(hop.clientAddress, h.DESKTOP_ADDR);
		assert.deepEqual(Object.keys(hop.headers!).sort(), ["content-type", "x-lh-sync-protocol"]);
		const status = await client.contactServer(deps());
		assert.equal(status.sync.state, "ok");
		const exchange = await client.syncRequest("/api/sync/sessions", { body: { cursor: 0 } }, deps());
		assert.equal(exchange.ok, true, JSON.stringify(exchange));
		// The copy saw the desktop's real address on its device record? It keeps the pairing in its own file.
		assert.equal(copyStore.readServerAuthState().devices.length, 1);
	});

	it("a wrong code is the copy's refusal, counted by the copy's lockout for the desktop's address", async () => {
		const cookie = await claimedOwner();
		await pairingCode(cookie);
		const wrong = await client.pairWithServer({ server: h.SERVER, code: "AAAA-AAAA", name: "Desktop" }, deps());
		assert.deepEqual(wrong, { ok: false, status: 401, error: "That pairing code isn't right, or it has run out. Get a new one from the server's site." });
		assert.equal(copyStore.readServerAuthState().lockouts[h.DESKTOP_ADDR]?.failures, 1);
		const shape = await client.pairWithServer({ server: h.SERVER, code: "AAAA", name: "Desktop" }, deps());
		assert.deepEqual(shape, wrong, "a code of no copy's shape gets the same answer from the gateway");
		assert.equal(acc.lockWait(acc.parseGatewayState(JSON.parse(fs.readFileSync(world.deps.store.file, "utf-8"))), h.DESKTOP_ADDR, Date.now()), 0);
		assert.equal(JSON.parse(fs.readFileSync(world.deps.store.file, "utf-8")).lockouts[h.DESKTOP_ADDR].failures, 1);
	});

	it("a desktop paired BEFORE the gateway keeps working, before and after the owner claims it", async () => {
		// Single-copy mode, as today.
		delete process.env.LH_GATE_SECRET;
		const setup = core.newSetupCode();
		copyStore.writeServerAuthState({ ...core.emptyServerAuthState(), setupCodeHash: core.setupCodeHash(setup) });
		const made = await server.setupResponse(new Request(`${h.SERVER}/api/server-auth/setup`, { method: "POST", headers: { host: h.HOST, origin: h.SERVER, "content-type": "application/json" }, body: JSON.stringify({ code: setup, password: PASSWORD }) }));
		const copyCookie = (made.headers.get("set-cookie") ?? "").split(";")[0]!;
		const codeResponse = await syncHttp.desktopsResponse(new Request(`${h.SERVER}/api/server-auth/desktops`, { method: "POST", headers: { host: h.HOST, origin: h.SERVER, "content-type": "application/json", cookie: copyCookie }, body: JSON.stringify({ op: "code" }) }));
		const { code } = await codeResponse.json() as { code: string };
		assert.equal((await client.pairWithServer({ server: h.SERVER, code, name: "Desktop" }, { fetch: world.directFetch })).ok, true);
		const key = storedKey();
		assert.equal((await client.contactServer({ fetch: world.directFetch })).sync.state, "ok");

		// The gateway is put in front; nobody has claimed it yet.
		process.env.LH_GATE_SECRET = h.OWNER_SECRET;
		assert.equal((await client.contactServer(deps())).sync.state, "ok");
		assert.equal((await client.syncRequest("/api/sync/sessions", { body: { cursor: 0 } }, deps())).ok, true);
		// Claimed: still the same key, still syncing.
		await claimedOwner();
		assert.equal((await client.contactServer(deps())).sync.state, "ok");
		assert.equal(storedKey(), key);
	});

	it("a password change through the gateway unpairs the desktop at the copy: it drops its key", async () => {
		const cookie = await claimedOwner();
		await client.pairWithServer({ server: h.SERVER, code: await pairingCode(cookie), name: "Desktop" }, deps());
		const changed = await world.browser("/api/server-auth/password", { body: { current: PASSWORD, next: "another passphrase" }, cookie });
		assert.equal(changed.status, 200);
		assert.ok(world.relayCalls.some((c) => c.path === "/api/internal/unpair-all" && c.upstream === h.OWNER_UPSTREAM));
		assert.equal(copyStore.readServerAuthState().devices.length, 0);
		const status = await client.contactServer(deps());
		assert.equal(status.sync.state, "needs-pairing");
		assert.equal(storedKey(), null);
	});

	it("while the copy can't be told, the desktop reads offline and KEEPS its key; once told, it is unpaired", async () => {
		const cookie = await claimedOwner();
		await client.pairWithServer({ server: h.SERVER, code: await pairingCode(cookie), name: "Desktop" }, deps());
		const key = storedKey();
		world.copyUp.value = false;
		assert.equal((await world.browser("/api/server-auth/sign-out-everywhere", { body: {}, cookie })).status, 200);
		world.copyUp.value = true;
		assert.equal((await client.contactServer(deps())).sync.state, "offline");
		assert.equal(storedKey(), key);
		// A new pairing waits too.
		assert.equal((await client.pairWithServer({ server: h.SERVER, code: "ABCD-EFGH", name: "Desktop" }, deps())).ok, false);
		await world.deps.unpairer.retryPending();
		assert.equal((await client.contactServer(deps())).sync.state, "needs-pairing");
		assert.equal(storedKey(), null);
	});

	it("a forged X-LH-Gate or X-LH-Upstream from the desktop changes nothing", async () => {
		const cookie = await claimedOwner();
		await client.pairWithServer({ server: h.SERVER, code: await pairingCode(cookie), name: "Desktop" }, deps());
		const forged: typeof fetch = (input, init) => {
			const request = new Request(input as string, init);
			const headers = new Headers(request.headers);
			headers.set("x-lh-gate", "forged".padEnd(40, "x"));
			headers.set("x-lh-upstream", "evil:3000");
			return world.desktopFetch(request.url, { method: request.method, headers, body: init?.body, redirect: "error" });
		};
		assert.equal((await client.contactServer({ fetch: forged })).sync.state, "ok");
	});
});
