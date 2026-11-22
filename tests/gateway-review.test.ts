/**
 * Multi-account: the security review's findings on the gateway, end to end
 * through the real routes, store, lifecycle and maker client. 1: a member
 * whose copy was never made (a reservation) is refused by every owner action,
 * sign-in and Delete my account, so no remake without `fresh` and no volume
 * deletion can touch an older person's volume. 2: a shutdown waits for a
 * redeem under way. 3: the full lockout table's pause. 5 and 8: a reset code
 * after a password change; Delete now and Restore at once. 7: the backup
 * beside the accounts file, the 503 while it is damaged, `reset-owner` on a
 * damaged file.
 *
 * Namespace imports, so a test of something that doesn't exist fails alone.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import * as acc from "../src/core/accounts.ts";
import * as words from "../src/core/account-screens.ts";
import * as core from "../src/core/server-auth.ts";
import * as control from "../gateway/control.ts";
import * as gatewayMain from "../gateway/main.ts";
import type { MakerClient } from "../gateway/maker-client.ts";
import * as stateFile from "../gateway/state.ts";
import { ADDR, config, DAY, harness, PASSWORD, SAM_PASSWORD, type Harness } from "./helpers/gateway-fakes.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-gateway-review-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const NEW_PASSWORD = "a long new password";
const RES = "acct_res";

let h: Harness;
let owner: string;
beforeEach(async () => {
	h = harness(TMP);
	owner = await h.claimOwner();
});

const opBody = async (r: Response) => ({ status: r.status, body: await r.json() as { code?: string } });
const setStatus = (id: string, state: acc.AccountStatus, removedAt: number | null = null) =>
	h.deps.store.update((s) => ({ state: { ...s, accounts: s.accounts.map((a) => a.id === id ? { ...a, state, removedAt } : a) }, result: undefined }));
/** "res" (tag R3S): reserved, never made. A volume under R3S exists: an older person's, from before a lost file. */
function reservation(): void {
	h.addMember("res", "R3S", { upstream: null, gateSecret: null });
	h.maker.copies.delete("R3S");
	h.maker.calls = [];
}
const touchedR3S = () => h.maker.calls.filter((c) => c.includes("R3S"));

async function invite(): Promise<string> {
	const response = await h.ownerOp(owner, { op: "invite" });
	assert.equal(response.status, 200);
	return (await response.json() as { code: string }).code;
}

async function freePort(): Promise<number> {
	const server = net.createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as net.AddressInfo).port;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

describe("review 1: a reservation is acted on only by its redeem", () => {
	it("pause, resume, remove, restore and delete now are refused (bad-state); nothing reaches the maker", async () => {
		reservation();
		for (const op of ["pause", "remove"]) assert.deepEqual(await opBody(await h.ownerOp(owner, { op, id: RES })), { status: 409, body: { code: "bad-state" } }, op);
		setStatus(RES, "paused");
		assert.deepEqual(await opBody(await h.ownerOp(owner, { op: "resume", id: RES })), { status: 409, body: { code: "bad-state" } }, "resume");
		setStatus(RES, "removed", h.clock.now);
		for (const op of ["restore", "delete-now", "reset"]) assert.deepEqual(await opBody(await h.ownerOp(owner, { op, id: RES })), { status: 409, body: { code: "bad-state" } }, op);
		assert.deepEqual(touchedR3S(), []);
		assert.ok(h.maker.volumes.has("R3S"));
		assert.equal(acc.findAccount(h.state(), RES)!.copyPending, undefined, "no remake was marked");
	});

	it("is not listed; can't sign in (the answer for a wrong name)", async () => {
		reservation();
		const list = await (await h.call(h.get("/api/accounts", { cookie: owner }))).json() as acc.AccountsView;
		assert.deepEqual(list.accounts.map((a) => a.name), ["Boss"]);
		const login = await h.call(h.post("/api/server-auth/login", { name: "res", password: SAM_PASSWORD }));
		assert.equal(login.status, 401);
		assert.deepEqual(await login.json(), { error: words.SIGN_IN_TEXT.wrong });
		assert.equal(h.state().lockouts[ADDR]?.against, "*");
	});

	it("removed in an older file, past its 30 days: abandoned, its container goes, its volume stays", async () => {
		reservation();
		setStatus(RES, "removed", h.clock.now);
		h.clock.now += 31 * DAY;
		await h.deps.lifecycle.pass();
		assert.equal(acc.findAccount(h.state(), RES), null);
		assert.ok(h.maker.volumes.has("R3S"), "never deleted");
		assert.ok(!h.maker.calls.includes("DELETE /volumes/R3S"));
		assert.ok(!h.maker.calls.some((c) => c.startsWith("POST /copies R3S")));
	});

	it("a deleting reservation without keepVolume (an older file) still keeps its volume", async () => {
		reservation();
		setStatus(RES, "deleting");
		await h.deps.lifecycle.pass();
		assert.equal(acc.findAccount(h.state(), RES), null);
		assert.ok(h.maker.volumes.has("R3S"));
	});

	it("Delete my account arriving while its copy is being made is refused; the redeem finishes", async () => {
		const code = await invite();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let started!: () => void;
		const making = new Promise<void>((resolve) => { started = resolve; });
		const original = h.maker.fetch;
		h.maker.fetch = async (input, init) => {
			if (String(input).endsWith("/copies") && init?.method === "POST") { started(); await gate; }
			return original(input, init);
		};
		const redeeming = h.call(h.post("/api/server-auth/invite", { code, name: "newbie", password: NEW_PASSWORD }));
		await making;
		const reserved = acc.findAccountByName(h.state(), "newbie")!;
		assert.ok(!acc.isReady(reserved));
		// A session for it, however one came about, opens nothing.
		const session = h.deps.store.update((s) => {
			const made = acc.createAccountSession(s, reserved.id, "ua", h.clock.now);
			return { state: made.state, result: made.token };
		});
		const del = await h.call(h.post("/api/server-auth/delete-account", { password: NEW_PASSWORD }, { cookie: `${core.SESSION_COOKIE}=${session}` }));
		assert.equal(del.status, 401);
		assert.equal(acc.findAccount(h.state(), reserved.id)!.state, "active");
		release();
		assert.equal((await redeeming).status, 200);
		await h.deps.lifecycle.idle();
		const made = acc.findAccount(h.state(), reserved.id)!;
		assert.ok(acc.isReady(made));
		assert.equal(made.state, "active");
		assert.ok(!h.maker.calls.some((c) => c.startsWith("DELETE ")));
	});
});

describe("review 2: a shutdown waits for a redeem under way", () => {
	/** The maker's create waits for `release()`. */
	function slowMaker() {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let started!: () => void;
		const creating = new Promise<void>((resolve) => { started = resolve; });
		const maker: MakerClient = {
			createCopy: async (tag) => { started(); await gate; return { upstream: `lh-acct-${tag}:3000`, gateSecret: "G".repeat(43) }; },
			stopCopy: async () => "ok",
			startCopy: async () => "ok",
			removeCopy: async () => undefined,
			removeVolume: async () => "ok",
			listCopies: async () => [],
			listVolumes: async () => [],
		};
		return { maker, release, creating };
	}
	const send = (port: number, pathname: string, body?: unknown) => new Promise<{ status: number; text: string }>((resolve, reject) => {
		const data = body === undefined ? undefined : JSON.stringify(body);
		const req = http.request({
			host: "127.0.0.1", port, path: pathname, method: data ? "POST" : "GET",
			headers: { host: "learn.example.com", origin: "https://learn.example.com", "content-type": "application/json", "x-forwarded-for": ADDR, "x-forwarded-proto": "https" },
		}, (res) => {
			let text = "";
			res.setEncoding("utf-8");
			res.on("data", (c) => { text += c; });
			res.on("end", () => resolve({ status: res.statusCode!, text }));
		});
		req.on("error", reject);
		req.end(data);
	});

	it("waits up to its limit: the redeem's copy is saved and the person signed in, and nothing new is taken meanwhile", async () => {
		assert.equal(gatewayMain.SHUTDOWN_GRACE_MS, 75_000);
		const code = await invite();
		const slow = slowMaker();
		const gateway = await gatewayMain.startGateway(config(h.deps.store.file), { maker: slow.maker, relay: h.deps.relay, loop: false, log: () => {} });
		const port = (gateway.server.address() as net.AddressInfo).port;
		const redeeming = send(port, "/api/server-auth/invite", { code, name: "newbie", password: NEW_PASSWORD });
		await slow.creating;
		let drained: boolean | null = null;
		const draining = gateway.drain(5_000).then((done) => { drained = done; });
		await new Promise((r) => setTimeout(r, 50));
		assert.equal(drained, null, "still waiting for the redeem");
		const late = await send(port, "/healthz").then((r) => r.status, () => "refused");
		assert.ok(late === "refused" || late === 503, String(late));
		slow.release();
		const answer = await redeeming;
		assert.equal(answer.status, 200);
		assert.equal((JSON.parse(answer.text) as { codes: string[] }).codes.length, 4);
		await draining;
		assert.equal(drained, true);
		const made = acc.findAccountByName(h.state(), "newbie")!;
		assert.ok(acc.isReady(made));
		assert.equal(acc.liveSessionsOf(h.state(), made.id, h.clock.now).length, 1);
	});

	it("gives up after its limit", async () => {
		const code = await invite();
		const slow = slowMaker();
		const gateway = await gatewayMain.startGateway(config(h.deps.store.file), { maker: slow.maker, relay: h.deps.relay, loop: false, log: () => {} });
		const port = (gateway.server.address() as net.AddressInfo).port;
		const redeeming = send(port, "/api/server-auth/invite", { code, name: "newbie", password: NEW_PASSWORD }).catch(() => null);
		await slow.creating;
		assert.equal(await gateway.drain(50), false);
		slow.release();
		await redeeming;
		await gateway.deps.lifecycle.idle();
	});
});

describe("review 3: the full lockout table", () => {
	it("a new address is refused for a minute with the existing sentence; one the table knows signs in", async () => {
		const lockouts: Record<string, acc.GatewayLockout> = {};
		for (let i = 0; i < acc.MAX_LOCKOUT_ENTRIES; i += 1) lockouts[`10.${i >> 16 & 255}.${i >> 8 & 255}.${i & 255}`] = { failures: 1, level: 0, lockedUntil: 0, lastFailureAt: h.clock.now - 1000, against: "*" };
		h.deps.store.update((s) => ({ state: { ...s, lockouts }, result: undefined }));
		const wrong = await h.call(h.post("/api/server-auth/login", { name: "Boss", password: "wrong wrong wrong" }));
		assert.equal(wrong.status, 429);
		assert.deepEqual(await wrong.json(), { error: "Too many attempts. Try again in 1 min." });
		assert.equal((await h.call(h.post("/api/server-auth/login", { name: "Boss", password: PASSWORD }))).status, 429);
		assert.equal((await h.call(h.post("/api/server-auth/login", { name: "Boss", password: PASSWORD }, { "x-forwarded-for": "10.0.0.3" }))).status, 200);
		assert.equal((await h.call(h.gateAsk("/", owner))).status, 200, "a signed-in browser carries on");
		h.clock.now += 60_000;
		assert.equal((await h.call(h.post("/api/server-auth/login", { name: "Boss", password: PASSWORD }))).status, 200);
	});
});

describe("reviews 5 and 8", () => {
	it("an owner's reset code stops working when the person changes their password", async () => {
		h.addMember("sam", "ABC");
		const code = (await (await h.ownerOp(owner, { op: "reset", id: "acct_sam" })).json() as { code: string }).code;
		const sam = await h.signIn("sam");
		assert.equal((await h.call(h.post("/api/server-auth/password", { current: SAM_PASSWORD, next: NEW_PASSWORD }, { cookie: sam }))).status, 200);
		const used = await h.call(h.post("/api/server-auth/reset", { name: "sam", code, password: "yet another password" }));
		assert.equal(used.status, 401);
		assert.deepEqual(await used.json(), { error: words.RESET_PAGE_TEXT.invalid });
	});

	for (const order of ["delete-now first", "restore first"] as const) {
		it(`Delete now and Restore sent at once (${order}): exactly one wins; the volume goes only if Delete now did`, async () => {
			h.addMember("sam", "ABC");
			assert.equal((await h.ownerOp(owner, { op: "remove", id: "acct_sam" })).status, 200);
			const ops = order === "delete-now first" ? ["delete-now", "restore"] : ["restore", "delete-now"];
			const answers = await Promise.all(ops.map((op) => h.ownerOp(owner, { op, id: "acct_sam" })));
			const byOp = Object.fromEntries(ops.map((op, i) => [op, answers[i]!.status]));
			assert.equal(answers.filter((r) => r.status === 200).length, 1, JSON.stringify(byOp));
			await h.deps.lifecycle.idle();
			const sam = acc.findAccount(h.state(), "acct_sam");
			if (byOp["delete-now"] === 200) {
				assert.equal(sam, null);
				assert.ok(!h.maker.volumes.has("ABC"));
				assert.equal(byOp.restore, 404);
			} else {
				assert.equal(sam!.state, "active");
				assert.ok(h.maker.volumes.has("ABC"));
				assert.ok(!h.maker.calls.includes("DELETE /volumes/ABC"));
				assert.equal(byOp["delete-now"], 409);
			}
		});
	}
});

describe("review 7: the backup beside the accounts file", () => {
	const file = () => h.deps.store.file;
	const bak = () => stateFile.backupFileOf(file());
	const age = (ms: number) => { const t = new Date(Date.now() - ms); fs.utimesSync(bak(), t, t); };
	const write = () => h.deps.store.update((s) => ({ state: { ...s, invites: [...s.invites] }, result: undefined }));

	it("is the file as it was before a write, at most a day old; mode 0600", async () => {
		// The first start's two writes: the setup code, then the claim; the backup is the file from before the claim.
		assert.ok(fs.existsSync(bak()));
		assert.equal(fs.statSync(bak()).mode & 0o777, 0o600);
		assert.equal(acc.hasOwner(stateFile.readStateFile(bak())), false);
		const first = fs.readFileSync(bak(), "utf-8");
		await h.signIn("Boss", PASSWORD);
		assert.equal(fs.readFileSync(bak(), "utf-8"), first, "younger than a day: kept");
		age(25 * 60 * 60 * 1000);
		const before = fs.readFileSync(file(), "utf-8");
		write();
		assert.equal(fs.readFileSync(bak(), "utf-8"), before, "a day old: the file before this write");
		assert.equal(fs.statSync(bak()).mode & 0o777, 0o600);
		assert.ok(!fs.readdirSync(path.dirname(file())).some((f) => f.includes(".tmp-")));
	});

	it("is never made from a damaged file", async () => {
		const good = fs.readFileSync(bak(), "utf-8");
		age(2 * DAY);
		fs.writeFileSync(file(), "{ damaged");
		assert.throws(write, stateFile.StateDamagedError);
		stateFile.backupIfDue(file());
		assert.equal(fs.readFileSync(bak(), "utf-8"), good);
	});

	it("while the file is damaged, or missing with a backup beside it: 503 everywhere, with the placeholder", async () => {
		assert.equal(words.ACCOUNTS_FILE_DAMAGED_PLACEHOLDER, "The accounts file on this server is damaged. See the server guide.");
		for (const damage of [() => fs.writeFileSync(file(), "{ damaged"), () => fs.rmSync(file())]) {
			damage();
			const page = await h.call(h.gateAsk("/"));
			assert.equal(page.status, 503);
			assert.equal(await page.text(), words.ACCOUNTS_FILE_DAMAGED_PLACEHOLDER);
			const api = await h.call(h.post("/api/server-auth/login", { name: "Boss", password: PASSWORD }));
			assert.equal(api.status, 503);
			assert.deepEqual(await api.json(), { error: words.ACCOUNTS_FILE_DAMAGED_PLACEHOLDER });
			assert.equal((await h.call(h.get("/setup"))).status, 503, "first-start setup is not reopened");
			const lines: string[] = [];
			gatewayMain.announceSetupCode(h.deps.store, (l) => lines.push(l));
			assert.equal(lines.length, 1);
			assert.ok(lines[0]!.includes(`${bak()} (from `), lines[0]);
			assert.ok(!lines.join("\n").includes("Setup code"));
		}
		assert.ok(!fs.existsSync(file()), "a missing file stays missing");
	});

	it("reset-owner on a damaged file: one line naming the backup and its date, exit 1, nothing changed", async () => {
		const run = async (env: Record<string, string>) => {
			const err: string[] = [];
			const out: string[] = [];
			const code = await control.resetOwnerCommand({ env, out: (l) => out.push(l), err: (l) => err.push(l) });
			return { code, err, out };
		};
		const dir = path.dirname(file());
		const snapshot = () => fs.readdirSync(dir).sort().map((f) => `${f}:${fs.readFileSync(path.join(dir, f), "utf-8")}`);
		const when = `${new Date(fs.statSync(bak()).mtimeMs).toISOString().slice(0, 16).replace("T", " ")} UTC`;
		const expected = `The accounts file is damaged. Nothing was changed. ${bak()} (from ${when}) can be put back.`;

		fs.writeFileSync(file(), "{ damaged");
		let before = snapshot();
		const direct = await run({ LH_GATEWAY_FILE: file(), PORT: String(await freePort()) });
		assert.deepEqual(direct, { code: 1, err: [expected], out: [] });
		assert.deepEqual(snapshot(), before);

		const gateway = await gatewayMain.startGateway(config(file(), { port: await freePort(), makerUrl: null, makerToken: null }), { relay: h.deps.relay, log: () => {}, loop: false });
		try {
			const port = (gateway.server.address() as net.AddressInfo).port;
			assert.deepEqual(await run({ LH_GATEWAY_FILE: file(), PORT: String(port) }), { code: 1, err: [expected], out: [] });
			assert.deepEqual(snapshot(), before, "through the running gateway");
		} finally {
			await gateway.stop();
		}

		fs.rmSync(file());
		before = snapshot();
		assert.deepEqual(await run({ LH_GATEWAY_FILE: file(), PORT: String(await freePort()) }), { code: 1, err: [expected], out: [] });
		assert.deepEqual(snapshot(), before, "missing with a backup: not made anew");

		fs.rmSync(bak());
		fs.writeFileSync(file(), "{ damaged");
		assert.deepEqual(await run({ LH_GATEWAY_FILE: file(), PORT: String(await freePort()) }), { code: 1, err: ["The accounts file is damaged. Nothing was changed. There is no backup beside it."], out: [] });
	});
});
