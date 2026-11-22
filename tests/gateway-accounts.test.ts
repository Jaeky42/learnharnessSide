/**
 * Multi-account, slice 4: Settings → Accounts at the gateway. GET and POST
 * /api/accounts for the owner only (404 for a member and for a signed-out
 * caller), every op's answer shape, what is written and the maker calls in
 * order; the cap (paused counts, removed doesn't); Pause before the copy
 * stops (the copy told first; an unreachable copy keeps the unpair owed);
 * Resume on a missing container; Remove, Restore inside the 30 days on the
 * same tag and volume, Delete now; the owner's own account refused.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import * as acc from "../src/core/accounts.ts";
import * as words from "../src/core/account-screens.ts";
import { DAY, harness, ORIGIN, PASSWORD, type Harness } from "./helpers/gateway-fakes.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-gateway-accounts-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let h: Harness;
let owner: string;
beforeEach(async () => {
	h = harness(TMP);
	owner = await h.claimOwner();
});

const op = async (body: Record<string, unknown>) => {
	const response = await h.ownerOp(owner, body);
	return { status: response.status, body: await response.json() as Record<string, unknown> };
};
const view = () => acc.accountsView(h.state(), 4, h.clock.now);

describe("who may use it", () => {
	it("the owner gets the view; a member and a signed-out caller get 404 on both verbs", async () => {
		const list = await h.call(h.get("/api/accounts", { cookie: owner }));
		assert.equal(list.status, 200);
		assert.deepEqual(await list.json(), view());
		h.addMember("sam", "ABC");
		const sam = await h.signIn("sam");
		for (const cookie of [sam, undefined, "__Host-lh_session=forged"]) {
			const headers: Record<string, string> = cookie ? { cookie } : {};
			const g = await h.call(h.get("/api/accounts", headers));
			assert.equal(g.status, 404);
			assert.deepEqual(await g.json(), { error: "Not found." });
			const p = await h.call(h.post("/api/accounts", { op: "invite" }, headers));
			assert.equal(p.status, 404);
			assert.deepEqual(await p.json(), { error: "Not found." });
		}
		assert.equal(h.state().invites.length, 0);
	});

	it("a write from another site is refused; unknown ops, ids and bodies have codes and no sentence", async () => {
		const cross = await h.call(h.post("/api/accounts", { op: "invite" }, { cookie: owner, origin: "https://evil.example" }));
		assert.equal(cross.status, 403);
		assert.deepEqual(await op({ op: "nope" }), { status: 400, body: { code: "bad_op" } });
		assert.deepEqual(await op({ op: "pause" }), { status: 400, body: { code: "bad_request" } });
		assert.deepEqual(await op({ op: "pause", id: "acct_nobody" }), { status: 404, body: { code: "not-found" } });
		assert.deepEqual(await op({ op: "cancel-invite", id: "inv_nobody" }), { status: 404, body: { code: "not-found" } });
		const ownerId = acc.ownerAccount(h.state())!.id;
		for (const o of ["pause", "remove", "delete-now", "reset", "resume", "restore"]) {
			const r = await op({ op: o, id: ownerId });
			assert.equal(r.status, 409, o);
			assert.equal(r.body.error, undefined, o);
			assert.equal(typeof r.body.code, "string", o);
		}
		assert.equal(acc.ownerAccount(h.state())!.state, "active");
		assert.deepEqual(h.maker.calls, []);
	});
});

describe("invite codes and the cap", () => {
	it("invite: the code once, its hash only stored; refused at the cap with the approved sentence", async () => {
		const first = await op({ op: "invite" });
		assert.equal(first.status, 200);
		assert.match(first.body.code as string, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
		assert.equal(first.body.expiresAt, h.clock.now + acc.INVITE_LIFETIME_MS);
		assert.deepEqual(first.body.view, view());
		assert.ok(!h.fileText().includes(first.body.code as string));
		assert.ok(!h.fileText().includes((first.body.code as string).replace("-", "")));
		// Owner + 3 free slots: 3 invites, the fourth refused.
		assert.equal((await op({ op: "invite" })).status, 200);
		assert.equal((await op({ op: "invite" })).status, 200);
		assert.deepEqual(await op({ op: "invite" }), { status: 409, body: { error: words.serverFullText(4), code: "full" } });
		assert.equal(h.state().invites.length, 3);
		// Cancel frees one.
		const id = view().invites[0]!.id;
		const cancelled = await op({ op: "cancel-invite", id });
		assert.deepEqual(cancelled, { status: 200, body: { view: view() } });
		assert.equal(view().invites.length, 2);
		assert.equal((await op({ op: "invite" })).status, 200);
	});

	it("paused accounts hold a slot; removed ones don't", async () => {
		h.addMember("sam", "ABC");
		h.addMember("kim", "DEF", { state: "paused" });
		assert.equal(view().used, 3);
		assert.equal((await op({ op: "invite" })).status, 200);
		assert.equal((await op({ op: "invite" })).status, 409);
		assert.equal((await op({ op: "remove", id: "acct_kim" })).status, 200);
		assert.equal(view().used, 2);
		assert.equal((await op({ op: "invite" })).status, 200);
	});
});

describe("Reset password", () => {
	it("a code once, for 24 hours; a new one replaces the older; only its hash is stored", async () => {
		h.addMember("sam", "ABC");
		const one = await op({ op: "reset", id: "acct_sam" });
		assert.equal(one.status, 200);
		assert.deepEqual(Object.keys(one.body).sort(), ["code", "expiresAt", "view"]);
		assert.equal(one.body.expiresAt, h.clock.now + DAY);
		const two = await op({ op: "reset", id: "acct_sam" });
		assert.notEqual(two.body.code, one.body.code);
		assert.equal(h.state().resets.length, 1);
		assert.ok(!h.fileText().includes(two.body.code as string));
		const old = await h.call(h.post("/api/server-auth/reset", { name: "sam", code: one.body.code, password: "a brand new password" }));
		assert.equal(old.status, 401);
		assert.equal((await h.call(h.post("/api/server-auth/reset", { name: "sam", code: two.body.code, password: "a brand new password" }))).status, 200);
	});
});

describe("Pause and Resume", () => {
	it("pause: sessions end, the copy stops, the slot stays taken", async () => {
		h.addMember("sam", "ABC");
		const sam = await h.signIn("sam");
		const r = await op({ op: "pause", id: "acct_sam" });
		assert.equal(r.status, 200);
		assert.deepEqual(r.body, { view: view() });
		const a = acc.findAccount(h.state(), "acct_sam")!;
		assert.equal(a.state, "paused");
		assert.equal(acc.liveSessionsOf(h.state(), "acct_sam", h.clock.now).length, 0);
		assert.deepEqual(h.relayCalls, [], "review A: no unpair");
		assert.deepEqual(h.maker.calls, ["POST /copies/ABC/stop"]);
		assert.equal(h.maker.copies.get("ABC")!.state, "exited");
		assert.equal(view().used, 2);
		assert.equal((await h.call(h.gateAsk("/", sam))).status, 303);
		const login = await h.call(h.post("/api/server-auth/login", { name: "sam", password: "sams own passphrase" }));
		assert.deepEqual(await login.json(), { error: words.SIGN_IN_TEXT.paused });
		assert.equal((await op({ op: "pause", id: "acct_sam" })).status, 409, "already paused");
	});

	it("review A: pause → resume and remove → restore never unpair; the same device key works again", async () => {
		h.addMember("sam", "ABC");
		const key = `Bearer ABC${"k".repeat(43)}`;
		const syncAsk = () => h.call(h.get("/gate", { "x-forwarded-method": "POST", "x-forwarded-uri": "/api/sync/hello", authorization: key }));
		assert.equal((await syncAsk()).status, 200);
		assert.equal((await op({ op: "pause", id: "acct_sam" })).status, 200);
		assert.equal((await syncAsk()).status, 503, "paused: the PC reads offline and keeps its key");
		assert.equal((await op({ op: "resume", id: "acct_sam" })).status, 200);
		assert.deepEqual(h.maker.calls, ["POST /copies/ABC/stop", "POST /copies/ABC/start"]);
		assert.equal((await syncAsk()).status, 200);
		assert.equal((await op({ op: "remove", id: "acct_sam" })).status, 200);
		assert.equal((await syncAsk()).status, 503, "removed and kept: still 503");
		assert.equal((await op({ op: "restore", id: "acct_sam" })).status, 200);
		const answer = await syncAsk();
		assert.equal(answer.status, 200);
		assert.equal(answer.headers.get("x-lh-scope"), "sync");
		assert.equal(answer.headers.get("x-lh-gate"), h.maker.copies.get("ABC")!.secret, "the restored copy's new secret");
		await h.deps.lifecycle.idle();
		assert.equal(acc.findAccount(h.state(), "acct_sam")!.unpairPending, undefined);
		assert.deepEqual(h.relayCalls, [], "no unpair-all call at all");
	});

	it("resume on a missing container makes the copy again and saves its new secret", async () => {
		const sam = h.addMember("sam", "ABC", { state: "paused" });
		h.maker.copies.delete("ABC");
		const r = await op({ op: "resume", id: "acct_sam" });
		assert.equal(r.status, 200);
		assert.deepEqual(h.maker.calls, ["POST /copies/ABC/start", "POST /copies ABC"]);
		const a = acc.findAccount(h.state(), "acct_sam")!;
		assert.equal(a.state, "active");
		assert.equal(a.gateSecret, h.maker.copies.get("ABC")!.secret);
		assert.notEqual(a.gateSecret, sam.gateSecret);
		assert.equal(a.copyPending, undefined);
	});

	it("resume with the maker away: still paused, 503 with no sentence", async () => {
		h.addMember("sam", "ABC", { state: "paused" });
		h.maker.breakAll("503");
		assert.deepEqual(await op({ op: "resume", id: "acct_sam" }), { status: 503, body: { code: "maker_unavailable" } });
		assert.equal(acc.findAccount(h.state(), "acct_sam")!.state, "paused");
	});
});

describe("Remove, Restore, Delete now", () => {
	it("remove: sessions end, unpair, removed, the container goes and the volume stays; the slot is free at once", async () => {
		h.addMember("sam", "ABC");
		const sam = await h.signIn("sam");
		const r = await op({ op: "remove", id: "acct_sam" });
		assert.equal(r.status, 200);
		assert.deepEqual(r.body, { view: view() });
		const a = acc.findAccount(h.state(), "acct_sam")!;
		assert.equal(a.state, "removed");
		assert.equal(a.removedAt, h.clock.now);
		assert.deepEqual(h.relayCalls, [], "review A: no unpair");
		assert.deepEqual(h.maker.calls, ["DELETE /copies/ABC"]);
		assert.ok(!h.maker.copies.has("ABC"));
		assert.ok(h.maker.volumes.has("ABC"));
		assert.equal(view().used, 1);
		assert.deepEqual(view().removed, [{ id: "acct_sam", name: "sam", removedAt: h.clock.now, deletedAt: h.clock.now + acc.REMOVED_KEEP_MS }]);
		assert.equal((await h.call(h.gateAsk("/", sam))).status, 303);
		const login = await h.call(h.post("/api/server-auth/login", { name: "sam", password: "sams own passphrase" }));
		assert.deepEqual(await login.json(), { error: words.SIGN_IN_TEXT.removed });
	});

	it("restore inside the 30 days: the same tag and volume, a fresh secret; with no free slot, the approved sentence", async () => {
		const sam = h.addMember("sam", "ABC");
		await op({ op: "remove", id: "acct_sam" });
		h.clock.now += 29 * DAY;
		h.addMember("kim", "DEF");
		h.addMember("lee", "GHJ");
		h.addMember("max", "KMN");
		assert.deepEqual(await op({ op: "restore", id: "acct_sam" }), { status: 409, body: { error: words.restoreFullText(4), code: "full" } });
		assert.equal(acc.findAccount(h.state(), "acct_sam")!.state, "removed");
		await op({ op: "remove", id: "acct_max" });
		h.maker.calls = [];
		const r = await op({ op: "restore", id: "acct_sam" });
		assert.equal(r.status, 200);
		assert.deepEqual(h.maker.calls, ["POST /copies ABC"]);
		const a = acc.findAccount(h.state(), "acct_sam")!;
		assert.equal(a.state, "active");
		assert.equal(a.tag, "ABC");
		assert.equal(a.upstream, "lh-acct-ABC:3000");
		assert.notEqual(a.gateSecret, sam.gateSecret);
		assert.equal(a.gateSecret, h.maker.copies.get("ABC")!.secret);
		assert.equal(a.removedAt, null);
		assert.ok(h.maker.volumes.has("ABC"));
		assert.equal((await h.call(h.post("/api/server-auth/login", { name: "sam", password: "sams own passphrase" }))).status, 200);
	});

	it("restore with the maker away: restored, the copy owed (copyPending), made by the next pass", async () => {
		h.addMember("sam", "ABC");
		await op({ op: "remove", id: "acct_sam" });
		h.maker.breakAll("down");
		assert.equal((await op({ op: "restore", id: "acct_sam" })).status, 200);
		assert.equal(acc.findAccount(h.state(), "acct_sam")!.copyPending, true);
		h.maker.heal();
		await h.deps.lifecycle.pass();
		const a = acc.findAccount(h.state(), "acct_sam")!;
		assert.equal(a.copyPending, undefined);
		assert.equal(a.gateSecret, h.maker.copies.get("ABC")!.secret);
	});

	it("delete now: a removed account only; its copy, then its volume, then its record", async () => {
		h.addMember("sam", "ABC");
		assert.equal((await op({ op: "delete-now", id: "acct_sam" })).status, 409, "active: remove first");
		await op({ op: "remove", id: "acct_sam" });
		h.maker.calls = [];
		const r = await op({ op: "delete-now", id: "acct_sam" });
		assert.equal(r.status, 200);
		assert.deepEqual(h.maker.calls, ["DELETE /copies/ABC", "DELETE /volumes/ABC"]);
		assert.equal(acc.findAccount(h.state(), "acct_sam"), null);
		assert.ok(!h.maker.volumes.has("ABC"));
		assert.deepEqual(r.body, { view: view() });
		assert.equal(acc.checkName(h.state(), "sam"), null, "the name is free again");
	});

	it("delete now with the volume still in use: stays `deleting`, never erased early, finished later", async () => {
		h.addMember("sam", "ABC");
		await op({ op: "remove", id: "acct_sam" });
		h.maker.fail(/^DELETE \/volumes\/ABC$/, "503");
		assert.equal((await op({ op: "delete-now", id: "acct_sam" })).status, 200);
		assert.equal(acc.findAccount(h.state(), "acct_sam")!.state, "deleting");
		assert.ok(h.maker.volumes.has("ABC"));
		assert.deepEqual(view().removed, []);
		await h.deps.lifecycle.pass();
		assert.equal(acc.findAccount(h.state(), "acct_sam"), null);
		assert.ok(!h.maker.volumes.has("ABC"));
	});

	it("the owner's view never shows a code, a secret or a password", async () => {
		h.addMember("sam", "ABC");
		await op({ op: "invite" });
		await op({ op: "reset", id: "acct_sam" });
		const text = JSON.stringify(view());
		for (const bad of ["gateSecret", "codeHash", "password", "secret-of-sam", PASSWORD]) assert.ok(!text.includes(bad), bad);
		assert.ok(ORIGIN);
	});
});
