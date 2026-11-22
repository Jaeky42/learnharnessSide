/**
 * Multi-account, slice 5b: the reset page (a recovery code, the owner's
 * reset code: once each, 24 hours, every session ended, the desktop apps
 * unpaired, a paused account staying paused, a removed one refused), new
 * recovery codes, Delete my account (the owner refused; the order of its
 * effects; the maker failing at each step; its cookie and device key
 * afterwards), and `lh-gateway reset-owner` through the running gateway's
 * loopback-only control route and, with nothing listening, through the file.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import * as acc from "../src/core/accounts.ts";
import * as words from "../src/core/account-screens.ts";
import * as core from "../src/core/server-auth.ts";
import * as control from "../gateway/control.ts";
import * as gatewayMain from "../gateway/main.ts";
import * as pages from "../gateway/pages.ts";
import { config, cookiesOf, DAY, harness, PASSWORD, SAM_PASSWORD, type Harness } from "./helpers/gateway-fakes.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-gateway-reset-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const NEW = "the brand new password";

let h: Harness;
let owner: string;
beforeEach(async () => {
	h = harness(TMP);
	owner = await h.claimOwner();
});

const reset = (name: string, code: string, password = NEW) => h.call(h.post("/api/server-auth/reset", { name, code, password }));
const ownerResetCode = async (id: string): Promise<string> => (await (await h.ownerOp(owner, { op: "reset", id })).json() as { code: string }).code;

/** A member with four recovery codes made through the route. */
async function memberWithCodes(): Promise<{ cookie: string; codes: string[] }> {
	h.addMember("sam", "ABC");
	const cookie = await h.signIn("sam");
	const response = await h.call(h.post("/api/server-auth/recovery-codes", { password: SAM_PASSWORD }, { cookie }));
	assert.equal(response.status, 200);
	return { cookie, codes: (await response.json() as { codes: string[] }).codes };
}

describe("the reset page", () => {
	it("one box for either code, in the approved words; success goes to the sign-in page", async () => {
		const page = await h.call(h.get("/reset"));
		assert.equal(page.status, 200);
		const html = await page.text();
		for (const text of Object.values(words.RESET_PAGE_TEXT).filter((t) => t !== words.RESET_PAGE_TEXT.invalid)) assert.ok(html.includes(pages.escapeHtml(text)), text);
		assert.ok(html.includes("Enter one of your recovery codes, or a reset code from this server&#39;s owner."));
		assert.equal((html.match(/<input /g) ?? []).length, 4, "name, one code box, two passwords");
		assert.ok(html.includes(`window.location.replace("/login")`));
	});
});

describe("resetting a password", () => {
	it("with a recovery code: once; every session ends; the desktop apps are unpaired; the new password works", async () => {
		const { cookie, codes } = await memberWithCodes();
		h.relayCalls.length = 0;
		const ok = await reset("SAM", codes[1]!);
		assert.equal(ok.status, 200);
		assert.deepEqual(await ok.json(), { ok: true });
		assert.equal(ok.headers.get("clear-site-data"), `"cache"`);
		assert.deepEqual(cookiesOf(ok), [], "not signed in by it");
		assert.equal((await h.call(h.gateAsk("/", cookie))).status, 303, "signed out");
		assert.deepEqual(h.relayCalls.map((c) => `${c.scope} ${c.upstream} ${c.path}`), ["internal lh-acct-ABC:3000 /api/internal/unpair-all"]);
		assert.equal(acc.findAccount(h.state(), "acct_sam")!.unpairPending, undefined);
		assert.equal(acc.findAccount(h.state(), "acct_sam")!.recoveryCodes.length, 3);
		const again = await reset("sam", codes[1]!, "yet another password");
		assert.equal(again.status, 401);
		assert.deepEqual(await again.json(), { error: words.RESET_PAGE_TEXT.invalid });
		await h.signIn("sam", NEW);
		assert.equal((await reset("sam", codes[2]!, "third password!")).status, 200, "another code still works");
	});

	it("with the owner's reset code: once, for 24 hours", async () => {
		h.addMember("sam", "ABC");
		const code = await ownerResetCode("acct_sam");
		h.clock.now += DAY + 1;
		assert.equal((await reset("sam", code)).status, 401, "expired");
		const fresh = await ownerResetCode("acct_sam");
		h.clock.now += DAY - 1000;
		assert.equal((await reset("sam", fresh)).status, 200);
		assert.equal((await reset("sam", fresh, "and again again")).status, 401, "used");
	});

	it("a wrong name and a wrong code are one answer; a paused account stays paused; a removed one can't", async () => {
		h.addMember("sam", "ABC");
		const code = await ownerResetCode("acct_sam");
		for (const [name, c] of [["kim", code], ["sam", "AAAA-AAAA"], ["", ""]]) {
			const r = await reset(name!, c!);
			assert.equal(r.status, 401);
			assert.deepEqual(await r.json(), { error: words.RESET_PAGE_TEXT.invalid });
		}
		assert.equal((await h.ownerOp(owner, { op: "pause", id: "acct_sam" })).status, 200);
		assert.equal((await reset("sam", code)).status, 200);
		assert.equal(acc.findAccount(h.state(), "acct_sam")!.state, "paused");
		const login = await h.call(h.post("/api/server-auth/login", { name: "sam", password: NEW }));
		assert.deepEqual(await login.json(), { error: words.SIGN_IN_TEXT.paused });

		h.addMember("kim", "DEF");
		const kimCode = await ownerResetCode("acct_kim");
		await h.ownerOp(owner, { op: "remove", id: "acct_kim" });
		assert.equal((await reset("kim", kimCode)).status, 401);
	});

	it("a short password is refused with today's sentence", async () => {
		const { codes } = await memberWithCodes();
		const r = await reset("sam", codes[0]!, "short");
		assert.deepEqual(await r.json(), { error: words.USE_AT_LEAST });
	});
});

describe("new recovery codes", () => {
	it("four new ones, once; the old ones stop; a wrong password answers as the password route's", async () => {
		const { cookie, codes } = await memberWithCodes();
		const fresh = await h.call(h.post("/api/server-auth/recovery-codes", { password: SAM_PASSWORD }, { cookie }));
		const body = await fresh.json() as { codes: string[]; recoveryCodesLeft: number };
		assert.deepEqual(Object.keys(body).sort(), ["codes", "recoveryCodesLeft"]);
		assert.equal(body.codes.length, 4);
		assert.equal(body.recoveryCodesLeft, 4);
		for (const c of body.codes) assert.ok(!h.fileText().includes(c));
		assert.equal((await reset("sam", codes[0]!)).status, 401, "an old code");

		const wrongCodes = await h.call(h.post("/api/server-auth/recovery-codes", { password: "not my password" }, { cookie }));
		const wrongPassword = await h.call(h.post("/api/server-auth/password", { current: "not my password", next: "whatever whatever" }, { cookie }));
		assert.equal(wrongCodes.status, wrongPassword.status);
		assert.deepEqual(await wrongCodes.json(), await wrongPassword.json());
		const signedOut = await h.call(h.post("/api/server-auth/recovery-codes", { password: SAM_PASSWORD }));
		assert.equal(signedOut.status, 401);
	});
});

describe("Delete my account", () => {
	it("the owner can't; a wrong password answers as the password route's", async () => {
		const ownerTry = await h.call(h.post("/api/server-auth/delete-account", { password: PASSWORD }, { cookie: owner }));
		assert.equal(ownerTry.status, 409);
		assert.deepEqual(await ownerTry.json(), { code: "is-owner" });
		assert.ok(acc.ownerAccount(h.state()));
		h.addMember("sam", "ABC");
		const sam = await h.signIn("sam");
		const wrong = await h.call(h.post("/api/server-auth/delete-account", { password: "nope nope nope" }, { cookie: sam }));
		const asPassword = await h.call(h.post("/api/server-auth/password", { current: "nope nope nope", next: "whatever whatever" }, { cookie: sam }));
		assert.equal(wrong.status, asPassword.status);
		assert.deepEqual(await wrong.json(), await asPassword.json());
		assert.equal(acc.findAccount(h.state(), "acct_sam")!.state, "active");
	});

	it("at once: marked and signed out, then the copy, then the volume, then the record; afterwards 401 and not_paired", async () => {
		h.addMember("sam", "ABC");
		const sam = await h.signIn("sam");
		await h.signIn("sam");
		// The state at the moment of each maker call: proves the order of effects.
		const seen: string[] = [];
		const original = h.maker.fetch;
		(h.maker as { fetch: typeof fetch }).fetch = async (input, init) => {
			const a = acc.findAccount(h.state(), "acct_sam");
			seen.push(`${init?.method} ${new URL(String(input)).pathname} while ${a ? a.state : "erased"} (${a ? acc.liveSessionsOf(h.state(), a.id, h.clock.now).length : 0} sessions)`);
			return original(input, init);
		};
		const r = await h.call(h.post("/api/server-auth/delete-account", { password: SAM_PASSWORD }, { cookie: sam }));
		assert.equal(r.status, 200);
		assert.deepEqual(await r.json(), { ok: true });
		assert.equal(r.headers.get("clear-site-data"), `"cache"`);
		assert.deepEqual(cookiesOf(r).map((c) => c.split(";")[0]), [`${core.SESSION_COOKIE}=`, "lh_owner="]);
		await h.deps.lifecycle.idle();
		assert.deepEqual(seen, [
			"DELETE /copies/ABC while deleting (0 sessions)",
			"DELETE /volumes/ABC while deleting (0 sessions)",
		]);
		assert.equal(acc.findAccount(h.state(), "acct_sam"), null);
		assert.ok(!h.maker.volumes.has("ABC"));
		assert.equal((await h.call(h.gateAsk("/api/chats", sam))).status, 401);
		const key = await h.call(h.get("/gate", { "x-forwarded-method": "POST", "x-forwarded-uri": "/api/sync/hello", authorization: `Bearer ABC${"k".repeat(43)}` }));
		assert.equal(key.status, 401);
		assert.equal((await key.json() as { code: string }).code, "not_paired");
		assert.equal(acc.checkName(h.state(), "sam"), null, "the name is free");
	});

	for (const failing of ["DELETE /copies/ABC", "DELETE /volumes/ABC"]) {
		it(`the maker failing at ${failing}: stays \`deleting\` (no sign-in, no slot, not_paired), never erased early; the loop finishes`, async () => {
			h.addMember("sam", "ABC");
			const sam = await h.signIn("sam");
			h.maker.fail(new RegExp(`^${failing}$`), "503");
			const r = await h.call(h.post("/api/server-auth/delete-account", { password: SAM_PASSWORD }, { cookie: sam }));
			assert.equal(r.status, 200);
			await h.deps.lifecycle.idle();
			const a = acc.findAccount(h.state(), "acct_sam")!;
			assert.equal(a.state, "deleting");
			assert.ok(h.maker.volumes.has("ABC"), "its volume is still there, so its record is too");
			assert.equal(acc.usedSlots(h.state()), 1);
			assert.equal(acc.checkName(h.state(), "sam"), "taken");
			assert.equal((await h.call(h.post("/api/server-auth/login", { name: "sam", password: SAM_PASSWORD }))).status, 401);
			assert.equal((await h.call(h.gateAsk("/", sam))).status, 303);
			const key = await h.call(h.get("/gate", { "x-forwarded-method": "POST", "x-forwarded-uri": "/api/sync/hello", authorization: `Bearer ABC${"k".repeat(43)}` }));
			assert.equal(key.status, 401);
			await h.deps.lifecycle.pass();
			assert.equal(acc.findAccount(h.state(), "acct_sam"), null);
			assert.ok(!h.maker.volumes.has("ABC"));
		});
	}

	it("a volume still in use (a swap's leftover): waits, erases only once it is gone", async () => {
		h.addMember("sam", "ABC");
		const sam = await h.signIn("sam");
		// The leftover reappears after the delete (it was an -old-* container): the volume answers 409.
		const original = h.maker.fetch;
		let leftover = true;
		(h.maker as { fetch: typeof fetch }).fetch = async (input, init) => {
			const answer = await original(input, init);
			if (leftover && String(input).endsWith("/copies/ABC") && init?.method === "DELETE") h.maker.copies.set("ABC", { state: "exited", secret: "x".repeat(43), image: "img-0" });
			return answer;
		};
		await h.call(h.post("/api/server-auth/delete-account", { password: SAM_PASSWORD }, { cookie: sam }));
		await h.deps.lifecycle.idle();
		assert.equal(acc.findAccount(h.state(), "acct_sam")!.state, "deleting");
		leftover = false;
		await h.deps.lifecycle.pass();
		assert.equal(acc.findAccount(h.state(), "acct_sam"), null);
		assert.ok(!h.maker.volumes.has("ABC"));
	});
});

describe("lh-gateway reset-owner", () => {
	async function freePort(): Promise<number> {
		const server = net.createServer();
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as net.AddressInfo).port;
		await new Promise<void>((resolve) => server.close(() => resolve()));
		return port;
	}

	it("through the running gateway: the owner's sessions end, a reset code (24 hours) works once at the reset page; nothing in the gateway's log", async () => {
		const logs: string[] = [];
		const gateway = await gatewayMain.startGateway(config(h.deps.store.file, { port: await freePort(), makerUrl: null, makerToken: null }), { relay: { send: async () => Response.json({ ok: true }) }, log: (l) => logs.push(l), loop: false });
		try {
			const port = (gateway.server.address() as net.AddressInfo).port;
			const out: string[] = [];
			const code = await control.resetOwnerCommand({ env: { LH_GATEWAY_FILE: h.deps.store.file, PORT: String(port) }, out: (l) => out.push(l), err: (l) => out.push(`ERR ${l}`) });
			assert.equal(code, 0, out.join("\n"));
			assert.equal(out[0], "Every device of Boss signed out.");
			assert.match(out[1]!, /^Reset code: [0-9A-Z]{4}-[0-9A-Z]{4}$/);
			assert.equal(out[2], `Open the site's "Forgot your password?" page and enter Boss, this code and a new password. The code works once, for 24 hours.`);
			const resetCode = out[1]!.slice("Reset code: ".length);
			assert.ok(!logs.join("\n").includes(resetCode));
			assert.ok(!h.fileText().includes(resetCode));
			assert.equal((await h.call(h.gateAsk("/", owner))).status, 303, "the owner's sessions ended");
			const used = await reset("Boss", resetCode);
			assert.equal(used.status, 200);
			assert.equal((await reset("Boss", resetCode, "once more please")).status, 401);
			assert.equal(acc.ownerAccount(h.state())!.state, "active");
		} finally {
			await gateway.stop();
		}
	});

	it("with nothing listening: the file directly; with no owner yet: a setup code", async () => {
		const port = await freePort();
		const out: string[] = [];
		assert.equal(await control.resetOwnerCommand({ env: { LH_GATEWAY_FILE: h.deps.store.file, PORT: String(port) }, out: (l) => out.push(l), err: (l) => out.push(`ERR ${l}`) }), 0);
		assert.equal(out[0], "Every device of Boss signed out.");
		const c = out[1]!.slice("Reset code: ".length);
		assert.equal(h.state().resets.length, 1);
		assert.equal(h.state().resets[0]!.codeHash, core.setupCodeHash(c));

		const fresh = path.join(TMP, `empty-${Date.now()}.json`);
		const lines: string[] = [];
		assert.equal(await control.resetOwnerCommand({ env: { LH_GATEWAY_FILE: fresh, PORT: String(port) }, out: (l) => lines.push(l) }), 0);
		assert.equal(lines[0], "No password is set yet.");
		assert.match(lines[1]!, /^Setup code: [0-9A-Z]{4}-[0-9A-Z]{4}$/);
		assert.equal(lines[2], "Open the site, enter this code and choose a password.");
	});

	it("refuses without LH_GATEWAY_FILE; changes nothing in a damaged file", async () => {
		const err: string[] = [];
		assert.equal(await control.resetOwnerCommand({ env: {}, err: (l) => err.push(l) }), 1);
		const damaged = path.join(TMP, `damaged-${Date.now()}.json`);
		fs.writeFileSync(damaged, "{nope");
		assert.equal(await control.resetOwnerCommand({ env: { LH_GATEWAY_FILE: damaged, PORT: String(await freePort()) }, err: (l) => err.push(l) }), 1);
		assert.equal(fs.readFileSync(damaged, "utf-8"), "{nope");
	});

	it("the control route: loopback only, never with a forwarding header, POST with its header only", async () => {
		const ask = (headers: Record<string, string> = {}, method = "POST") => new Request("http://gateway.invalid/control/reset-owner", { method, headers: { [control.CONTROL_HEADER]: "1", ...headers } });
		for (const address of ["203.0.113.7", "10.0.0.5", "172.18.0.3", undefined, "::ffff:10.0.0.5", "fe80::1"]) {
			assert.equal((await control.controlRoute(ask(), h.deps, address)).status, 404, String(address));
		}
		for (const header of ["x-forwarded-for", "forwarded", "x-real-ip", "x-forwarded-proto"]) {
			assert.equal((await control.controlRoute(ask({ [header]: "127.0.0.1" }), h.deps, "127.0.0.1")).status, 404, header);
		}
		assert.equal((await control.controlRoute(ask({}, "GET"), h.deps, "127.0.0.1")).status, 404);
		assert.equal((await control.controlRoute(new Request("http://gateway.invalid/control/reset-owner", { method: "POST" }), h.deps, "127.0.0.1")).status, 404);
		assert.equal(h.state().resets.length, 0, "nothing changed");
		for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) assert.equal((await control.controlRoute(ask(), h.deps, address)).status, 200, address);

		// Over real HTTP with X-Forwarded-For from loopback (as if a proxy ran on the same host).
		const gateway = await gatewayMain.startGateway(config(h.deps.store.file, { port: await freePort(), makerUrl: null, makerToken: null }), { relay: { send: async () => Response.json({ ok: true }) }, log: () => {}, loop: false });
		try {
			const port = (gateway.server.address() as net.AddressInfo).port;
			const forwarded = await fetch(`http://127.0.0.1:${port}/control/reset-owner`, { method: "POST", headers: { [control.CONTROL_HEADER]: "1", "x-forwarded-for": "203.0.113.7" } });
			assert.equal(forwarded.status, 404);
			// The control path is not in the route table either: Caddy can't reach it as a gateway path.
			assert.equal((await h.call(h.post("/control/reset-owner", {}))).status, 404);
		} finally {
			await gateway.stop();
		}
	});
});
