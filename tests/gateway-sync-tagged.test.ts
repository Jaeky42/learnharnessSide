/**
 * Multi-account, slice 2, an account's copy (LH_ACCOUNT_TAG): the REAL
 * desktop client pairs with an 11-character code, gets a 46-character key and
 * syncs through a stand-in Caddy, the gateway's real /gate and /api/sync/pair
 * and the REAL copy. Paused: the client reads "offline" and keeps its key;
 * deleted: it drops it. Another account's cookie or a changed tag never
 * reaches this copy. The owner's copy is tests/gateway-sync.test.ts.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-gateway-sync-tagged-"));
process.env.LH_AUTH_FILE = path.join(TMP, "secrets", "auth.json");
process.env.LH_DATA_DIR = path.join(TMP, "data");
process.env.LH_SERVER_MODE = "1";
process.env.LH_TRUST_PROXY = "1";
process.env.LH_SYNC_LOOP = "off";

const TAG = "7KQ";
const SAM_UPSTREAM = `lh-acct-${TAG}:3000`;
const SAM_SECRET = "sams-copy-gate-secret-".padEnd(43, "s");
process.env.LH_ACCOUNT_TAG = TAG;
process.env.LH_GATE_SECRET = SAM_SECRET;

const h = await import("./helpers/gateway-sync-harness.ts");
const core = await import("../src/core/server-auth.ts");
const acc = await import("../src/core/accounts.ts");
const copyStore = await import("../src/store/server-auth.ts");
const pairingStore = await import("../src/store/sync/pairing.ts");
const client = await import("../src/server/sync/client.ts");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let world: ReturnType<typeof h.makeWorld>;
const PW = core.hashPassword("irrelevant here");

beforeEach(() => {
	fs.rmSync(path.join(TMP, "secrets"), { recursive: true, force: true });
	fs.rmSync(path.join(TMP, "data"), { recursive: true, force: true });
	fs.rmSync(path.join(TMP, "gateway"), { recursive: true, force: true });
	client.resetCloudLink();
	world = h.makeWorld(path.join(TMP, "gateway"), { upstream: SAM_UPSTREAM, secret: SAM_SECRET });
});

const member = (name: string, tag: string, upstream: string, gateSecret: string): import("../src/core/accounts.ts").AccountRecord => ({
	id: `acct_${name}`, tag, name, nameKey: name, password: PW, recoveryCodes: [], role: "member", state: "active",
	createdAt: Date.now(), lastSeenAt: null, removedAt: null, upstream, gateSecret,
});

/** The owner "boss" (the owner's copy, which this process doesn't play), "sam" (this copy), "kim" (another). Their cookies. */
function accounts(): { boss: string; sam: string; kim: string } {
	const cookies: Record<string, string> = {};
	world.deps.store.update((state) => {
		let next: import("../src/core/accounts.ts").GatewayState = {
			...state,
			accounts: [
				{ ...member("boss", TAG, h.OWNER_UPSTREAM, h.OWNER_SECRET), tag: null, role: "owner" },
				member("sam", TAG, SAM_UPSTREAM, SAM_SECRET),
				member("kim", "M9X", "lh-acct-M9X:3000", "kims-copy-gate-secret-".padEnd(43, "k")),
			],
		};
		for (const name of ["boss", "sam", "kim"]) {
			const made = acc.createAccountSession(next, `acct_${name}`, "Chrome on Windows", Date.now());
			next = made.state;
			cookies[name] = `${core.SESSION_COOKIE}=${made.token}`;
		}
		return { state: next, result: undefined };
	});
	return cookies as { boss: string; sam: string; kim: string };
}

async function pairingCode(cookie: string): Promise<Response> {
	return world.browser("/api/server-auth/desktops", { body: { op: "code" }, cookie });
}

const deps = () => ({ fetch: world.desktopFetch });
const storedKey = () => pairingStore.readCloudPairing()?.key ?? null;
const setState = (name: string, change: Partial<import("../src/core/accounts.ts").AccountRecord>) =>
	world.deps.store.update((state) => ({ state: { ...state, accounts: state.accounts.map((a) => a.name === name ? { ...a, ...change } : a) }, result: undefined }));

async function paired(): Promise<string> {
	const cookies = accounts();
	const response = await pairingCode(cookies.sam);
	assert.equal(response.status, 200);
	const { code } = await response.json() as { code: string };
	const result = await client.pairWithServer({ server: h.SERVER, code, name: "Sam's PC" }, deps());
	assert.equal(result.ok, true, JSON.stringify(result));
	return code;
}

describe("an account's copy through the gateway", () => {
	it("pairs with an 11-character code, gets a 46-character key with its tag, says hello and syncs", async () => {
		const code = await paired();
		assert.match(code, new RegExp(`^[0-9A-Z]{4}-[0-9A-Z]{4}-${TAG}$`));
		const key = storedKey()!;
		assert.equal(key.length, 46);
		assert.ok(key.startsWith(TAG));
		const hop = world.relayCalls.find((c) => c.path === "/api/sync/pair")!;
		assert.equal(hop.upstream, SAM_UPSTREAM);
		assert.equal(hop.gateSecret, SAM_SECRET);
		assert.equal(hop.clientAddress, h.DESKTOP_ADDR);
		assert.equal((await client.contactServer(deps())).sync.state, "ok");
		assert.equal((await client.syncRequest("/api/sync/sessions", { body: { cursor: 0 } }, deps())).ok, true);
	});

	it("another account's cookie never reaches this copy", async () => {
		const cookies = accounts();
		// kim's and the owner's copies aren't played here: their requests go
		// elsewhere (Caddy gets no answer: 502), never to sam's copy.
		assert.equal((await pairingCode(cookies.kim)).status, 502);
		assert.equal((await pairingCode(cookies.boss)).status, 502);
		assert.equal(copyStore.readServerAuthState().pairing, null);
		assert.equal((await pairingCode(cookies.sam)).status, 200);
	});

	it("sam's code with kim's tag goes to kim's copy, not to sam's", async () => {
		const cookies = accounts();
		const { code } = await (await pairingCode(cookies.sam)).json() as { code: string };
		const changed = `${code.slice(0, 10)}M9X`;
		const result = await client.pairWithServer({ server: h.SERVER, code: changed, name: "PC" }, deps());
		assert.equal(result.ok, false);
		assert.equal(world.relayCalls.at(-1)!.upstream, "lh-acct-M9X:3000");
		assert.equal(copyStore.readServerAuthState().devices.length, 0);
	});

	it("sam's key with its tag changed: routed to that tag's copy, never to sam's", async () => {
		await paired();
		const key = storedKey()!;
		const forged = `M9X${key.slice(3)}`;
		pairingStore.writeCloudPairing({ ...pairingStore.readCloudPairing()!, key: forged });
		assert.equal((await client.contactServer(deps())).sync.state, "offline", "kim's copy isn't played here: 502");
		// Back to the real key: sam's copy answers again.
		pairingStore.writeCloudPairing({ ...pairingStore.readCloudPairing()!, key });
		client.resetCloudLink();
		assert.equal((await client.contactServer(deps())).sync.state, "ok");
	});

	it("paused: the desktop reads offline and KEEPS its key; resumed, it carries on", async () => {
		await paired();
		const key = storedKey();
		setState("sam", { state: "paused" });
		assert.equal((await client.contactServer(deps())).sync.state, "offline");
		assert.equal(storedKey(), key);
		setState("sam", { state: "removed", removedAt: Date.now() });
		assert.equal((await client.contactServer(deps())).sync.state, "offline", "removed and kept: the same");
		assert.equal(storedKey(), key);
		setState("sam", { state: "active", removedAt: null });
		assert.equal((await client.contactServer(deps())).sync.state, "ok");
	});

	it("deleted (or being deleted): the desktop is told not_paired and drops its key", async () => {
		await paired();
		setState("sam", { state: "deleting" });
		assert.equal((await client.contactServer(deps())).sync.state, "needs-pairing");
		assert.equal(storedKey(), null);
	});

	it("erased for good: the same", async () => {
		await paired();
		world.deps.store.update((state) => ({ state: acc.eraseAccount(state, "acct_sam"), result: undefined }));
		assert.equal((await client.contactServer(deps())).sync.state, "needs-pairing");
		assert.equal(storedKey(), null);
	});

	it("pairing with a paused account's code: refused, and the copy never sees it", async () => {
		const cookies = accounts();
		const { code } = await (await pairingCode(cookies.sam)).json() as { code: string };
		setState("sam", { state: "paused" });
		const result = await client.pairWithServer({ server: h.SERVER, code, name: "PC" }, deps());
		assert.equal(result.ok, false);
		assert.equal(result.ok === false && result.status, 503);
		assert.equal(world.relayCalls.filter((c) => c.path === "/api/sync/pair").length, 0);
	});
});
