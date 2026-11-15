/**
 * Multi-account, slices 3b–5b: the lifecycle loop and what keeps copies in
 * step with accounts. Every branch of a pass (a reservation cut off, a
 * deletion unfinished, the 30 days, a copy missing for two passes, a swap's
 * brief absence, paused running, active stopped, removed still there, a copy
 * of no account, a copy owed after an answer that never came), one account's
 * steps serialized with the owner's actions, a maker failure on one account
 * not stopping the pass; the maker client's statuses; and the review's F
 * (no owner: 503 for tagged codes), H (capped answers), J (a pairing in
 * flight holds unpair-all back), K (upstreams allowed) and the rule that no
 * code, password or token reaches the file or a log line.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import * as acc from "../src/core/accounts.ts";
import { createUnpairer, type RelayRequest } from "../gateway/copies.ts";
import { RESERVATION_STALE_MS } from "../gateway/lifecycle.ts";
import { createMakerClient, MakerUnavailable, TagTaken } from "../gateway/maker-client.ts";
import { ALL_ROUTES } from "../gateway/main.ts";
import { handleRequest } from "../gateway/routes.ts";
import { readStateFile, writeStateFile } from "../gateway/state.ts";
import { DAY, harness, MAKER_TOKEN, PASSWORD, RELAY_TOKEN, SAM_PASSWORD, type Harness } from "./gateway-fakes.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-gateway-lifecycle-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let h: Harness;
beforeEach(async () => {
	h = harness(TMP);
	await h.claimOwner();
});

const pass = () => h.deps.lifecycle.pass();
const find = (id: string) => acc.findAccount(h.state(), id);

describe("the maker client", () => {
	it("reads the real API's statuses", async () => {
		const maker = createMakerClient({ makerUrl: "http://maker:9100", makerToken: MAKER_TOKEN }, (i, init) => h.maker.fetch(i, init), { create: 40, call: 40 });
		const made = await maker.createCopy("ABC");
		assert.deepEqual(made, { upstream: "lh-acct-ABC:3000", gateSecret: h.maker.copies.get("ABC")!.secret });
		await assert.rejects(maker.createCopy("ABC", { fresh: true }), TagTaken);
		assert.deepEqual(await maker.listVolumes(), ["ABC"]);
		assert.equal(await maker.stopCopy("ABC"), "ok");
		assert.equal(await maker.startCopy("ZZZ"), "missing");
		assert.equal(await maker.removeVolume("ABC"), "in-use");
		await maker.removeCopy("ABC");
		assert.equal(await maker.removeVolume("ABC"), "ok");
		assert.equal(await maker.removeVolume("ABC"), "ok", "idempotent");
		h.maker.fail(/stop/, "503");
		await assert.rejects(maker.stopCopy("ABC"), MakerUnavailable, "503: try later, never 'missing'");
		h.maker.fail(/GET \/copies/, "hang");
		await assert.rejects(maker.listCopies(), MakerUnavailable);
		await assert.rejects(maker.createCopy("abc"), /invalid tag/);
		assert.deepEqual(h.maker.calls.at(-1), "GET /copies", "a bad tag never reaches the maker");
	});

	it("review H: an answer over 64 KB is not read (no answer)", async () => {
		const maker = createMakerClient({ makerUrl: "http://maker:9100", makerToken: MAKER_TOKEN }, (i, init) => h.maker.fetch(i, init), { create: 40, call: 40 });
		h.maker.padAnswers = 70 * 1024;
		await assert.rejects(maker.listCopies(), MakerUnavailable);
		await assert.rejects(maker.createCopy("ABC"), MakerUnavailable);
	});
});

describe("a pass", () => {
	it("a reservation cut off (older than 2 minutes) is undone: its container goes, its volume stays; a young one is left", async () => {
		h.addMember("old", "D1D", { upstream: null, gateSecret: null });
		h.addMember("new", "NEW", { upstream: null, gateSecret: null, createdAt: h.clock.now + RESERVATION_STALE_MS });
		h.clock.now += RESERVATION_STALE_MS + 1;
		h.maker.copies.delete("NEW");
		await pass();
		assert.equal(find("acct_old"), null);
		assert.ok(!h.maker.copies.has("D1D"));
		assert.ok(h.maker.volumes.has("D1D"), "kept: it may not be the reservation's own");
		assert.ok(h.maker.calls.includes("DELETE /copies/D1D"));
		assert.ok(!h.maker.calls.some((c) => c.startsWith("DELETE /volumes")));
		assert.equal(find("acct_new")!.state, "active", "young: being made right now");
	});

	it("a `deleting` account is retried until the maker finishes, and only then erased", async () => {
		h.addMember("sam", "ABC", { state: "deleting" });
		h.maker.breakAll("503");
		await pass();
		assert.equal(find("acct_sam")!.state, "deleting");
		h.maker.heal();
		await pass();
		assert.equal(find("acct_sam"), null);
		assert.ok(!h.maker.volumes.has("ABC"));
	});

	it("a removed account is deleted for good after 30 days, not before", async () => {
		h.addMember("sam", "ABC");
		const owner = await h.signIn("Boss", PASSWORD);
		await h.ownerOp(owner, { op: "remove", id: "acct_sam" });
		h.clock.now += 30 * DAY - 1;
		await pass();
		assert.equal(find("acct_sam")!.state, "removed");
		assert.ok(h.maker.volumes.has("ABC"));
		h.clock.now += 1;
		await pass();
		assert.equal(find("acct_sam"), null);
		assert.ok(!h.maker.volumes.has("ABC"));
	});

	it("an active account's missing copy: nothing after one absence (a swap), made again after two, with its new secret saved", async () => {
		h.addMember("sam", "ABC");
		h.maker.hidden.add("ABC");
		await pass();
		assert.ok(!h.maker.calls.some((c) => c.startsWith("POST /copies ")), "one absence: wait");
		h.maker.hidden.delete("ABC");
		await pass();
		await pass();
		assert.ok(!h.maker.calls.some((c) => c.startsWith("POST /copies ")), "it came back: nothing to do");
		h.maker.copies.delete("ABC");
		await pass();
		await pass();
		assert.deepEqual(h.maker.calls.filter((c) => c.startsWith("POST /copies ")), ["POST /copies ABC"]);
		assert.equal(find("acct_sam")!.gateSecret, h.maker.copies.get("ABC")!.secret);
		assert.equal(h.maker.copies.get("ABC")!.state, "running");
	});

	it("a paused account: a missing copy is made stopped; a running one is stopped", async () => {
		h.addMember("sam", "ABC", { state: "paused" });
		h.maker.copies.get("ABC")!.state = "running";
		await pass();
		assert.ok(h.maker.calls.includes("POST /copies/ABC/stop"));
		h.maker.copies.delete("ABC");
		await pass();
		await pass();
		assert.ok(h.maker.calls.includes("POST /copies ABC start=false"));
		assert.equal(h.maker.copies.get("ABC")!.state, "exited");
		assert.equal(find("acct_sam")!.gateSecret, h.maker.copies.get("ABC")!.secret);
	});

	it("an active account's stopped copy is started; a removed account's container is removed; a copy of no account is left alone, logged once", async () => {
		h.addMember("sam", "ABC");
		h.maker.copies.get("ABC")!.state = "exited";
		h.addMember("rob", "R0B", { state: "removed", removedAt: h.clock.now });
		h.maker.add("ZZZ");
		await pass();
		await pass();
		assert.equal(h.maker.copies.get("ABC")!.state, "running");
		assert.ok(!h.maker.copies.has("R0B"));
		assert.ok(h.maker.volumes.has("R0B"));
		assert.ok(h.maker.copies.has("ZZZ"));
		assert.ok(!h.maker.calls.some((c) => c.includes("ZZZ")));
		assert.equal(h.logs.filter((l) => l.includes("ZZZ")).length, 1);
	});

	it("a copy owed after an answer that never came (copyPending) is made again at once, even if listed", async () => {
		h.addMember("sam", "ABC", { copyPending: true });
		await pass();
		assert.deepEqual(h.maker.calls.filter((c) => c.startsWith("POST /copies ")), ["POST /copies ABC"]);
		assert.equal(find("acct_sam")!.copyPending, undefined);
		assert.equal(find("acct_sam")!.gateSecret, h.maker.copies.get("ABC")!.secret);
	});

	it("one account's failure doesn't stop the pass; a list that fails still lets deletions run", async () => {
		h.addMember("sam", "ABC");
		h.addMember("kim", "DEF");
		h.maker.copies.get("ABC")!.state = "exited";
		h.maker.copies.get("DEF")!.state = "exited";
		h.maker.fail(/^POST \/copies\/ABC\/start$/, "503");
		const report = await pass();
		assert.deepEqual(report.failed, ["start ABC"]);
		assert.equal(h.maker.copies.get("DEF")!.state, "running");
		h.addMember("dan", "D4N", { state: "deleting" });
		h.maker.fail(/^GET \/copies$/, "down");
		const second = await pass();
		assert.ok(second.failed.includes("list"));
		assert.equal(find("acct_dan"), null);
	});

	it("one pass at a time; an account's steps wait for the owner's action on it", async () => {
		h.addMember("sam", "ABC");
		const owner = await h.signIn("Boss", PASSWORD);
		h.maker.fail(/^POST \/copies\/ABC\/stop$/, "hang");
		const pausing = h.ownerOp(owner, { op: "pause", id: "acct_sam" });
		await new Promise((r) => setTimeout(r, 5));
		const p1 = pass();
		assert.equal(pass(), p1, "a second call joins the running pass");
		await pausing;
		await p1;
		const stops = h.maker.calls.filter((c) => c === "POST /copies/ABC/stop");
		// The pause's stop hung (timed out); the pass, run after it, saw a paused account whose copy runs and stopped it.
		assert.equal(stops.length, 2);
		assert.equal(h.maker.copies.get("ABC")!.state, "exited");
	});
});

describe("review fixes", () => {
	it("F: with no owner (a new or lost file), an 11-character pairing code answers 503, not counted as a wrong code", async () => {
		const fresh = harness(TMP);
		const pair = (code: string) => fresh.call(fresh.post("/api/sync/pair", { code, deviceId: "d", name: "Desktop" }, { origin: "" }));
		for (let i = 0; i < 6; i += 1) assert.equal((await pair("AAAA-AAAA-ABC")).status, 503);
		assert.deepEqual(fresh.state().lockouts, {});
		assert.equal((await pair("AAAA-AAAA")).status, 200, "an older code still goes to the owner's copy");
	});

	it("H: a copy answering its pairing with an oversized body gets 502; the gateway reads at most 64 KB", async () => {
		const big = { send: async () => new Response("x".repeat(70 * 1024), { headers: { "content-type": "application/json" } }) };
		const streamed = { send: async () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(32 * 1024)); } }), { headers: { "content-type": "application/json" } }) };
		for (const relay of [big, streamed]) {
			const deps = { ...h.deps, relay };
			const r = await handleRequest(h.post("/api/sync/pair", { code: "AAAA-AAAA" }, { origin: "" }), deps, ALL_ROUTES);
			assert.equal(r.status, 502);
		}
	});

	it("J: a pairing forward in flight holds that account's unpair-all back until it ends", async () => {
		h.addMember("sam", "ABC");
		const order: string[] = [];
		let release!: () => void;
		const relay = {
			send: async (req: RelayRequest) => {
				order.push(`start ${req.path}`);
				if (req.path === "/api/sync/pair") await new Promise<void>((r) => { release = r; });
				order.push(`end ${req.path}`);
				return Response.json({ ok: true });
			},
		};
		const unpairer = createUnpairer({ store: h.deps.store, relay, config: h.deps.config, log: () => {} });
		const deps = { ...h.deps, relay, unpairer };
		const sam = await h.signIn("sam");
		const pairing = handleRequest(h.post("/api/sync/pair", { code: "AAAA-AAAA-ABC" }, { origin: "" }), deps, ALL_ROUTES);
		await new Promise((r) => setTimeout(r, 5));
		const change = handleRequest(h.post("/api/server-auth/password", { current: SAM_PASSWORD, next: "a whole new password" }, { cookie: sam }), deps, ALL_ROUTES);
		await new Promise((r) => setTimeout(r, 5));
		// A new pairing is refused while the unpair is owed.
		assert.equal((await handleRequest(h.post("/api/sync/pair", { code: "BBBB-BBBB-ABC" }, { origin: "" }), deps, ALL_ROUTES)).status, 503);
		assert.deepEqual(order, ["start /api/sync/pair"], "unpair-all waits");
		release();
		await pairing;
		assert.equal((await change).status, 200);
		assert.deepEqual(order, ["start /api/sync/pair", "end /api/sync/pair", "start /api/internal/unpair-all", "end /api/internal/unpair-all"]);
		assert.equal(find("acct_sam")!.unpairPending, undefined);
	});

	it("K: a member's upstream must be its own lh-acct-<tag>:3000; anything else makes the file damaged (fail closed)", async () => {
		h.addMember("sam", "ABC");
		const good = readStateFile(h.deps.store.file);
		for (const upstream of ["lh:3000", "lh-acct-DEF:3000", "evil.example:443", "lh-acct-ABC:3001"]) {
			const bad = { ...good, accounts: good.accounts.map((a) => a.id === "acct_sam" ? { ...a, upstream } : a) };
			assert.throws(() => acc.parseGatewayState(JSON.parse(JSON.stringify(bad))), /upstream/, upstream);
			writeStateFile(h.deps.store.file, bad);
			assert.equal((await h.call(h.gateAsk("/"))).status, 503, upstream);
		}
		writeStateFile(h.deps.store.file, good);
		assert.equal((await h.call(h.gateAsk("/"))).status, 303);
		assert.ok(acc.upstreamAllowed("owner", null, "lh:3000"));
		assert.ok(!acc.upstreamAllowed("owner", "ABC", "lh:3000"));
	});

	it("K: a maker answer naming another upstream is never saved", async () => {
		h.addMember("sam", "ABC", { copyPending: true });
		const original = h.maker.fetch;
		h.maker.fetch = async (input, init) => {
			const answer = await original(input, init);
			if (String(input).endsWith("/copies") && init?.method === "POST") return Response.json({ upstream: "lh:3000", gateSecret: "y".repeat(43) });
			return answer;
		};
		await pass();
		assert.equal(find("acct_sam")!.upstream, "lh-acct-ABC:3000");
		assert.equal(find("acct_sam")!.copyPending, true, "still owed");
		assert.notEqual(find("acct_sam")!.gateSecret, "y".repeat(43));
	});
});

describe("secrets", () => {
	it("no code, password, session token or token in the file; nothing secret in a log line", async () => {
		const owner = await h.signIn("Boss", PASSWORD);
		const invite = (await (await h.ownerOp(owner, { op: "invite" })).json() as { code: string }).code;
		const redeemed = await h.call(h.post("/api/server-auth/invite", { code: invite, name: "sam", password: "sams new password" }));
		const codes = (await redeemed.json() as { codes: string[] }).codes;
		const samToken = redeemed.headers.getSetCookie()[0]!.split(";")[0]!.split("=")[1]!;
		const reset = (await (await h.ownerOp(owner, { op: "reset", id: acc.findAccountByName(h.state(), "sam")!.id })).json() as { code: string }).code;
		h.maker.breakAll("503");
		await h.ownerOp(owner, { op: "pause", id: acc.findAccountByName(h.state(), "sam")!.id });
		await pass();
		h.maker.heal();
		const text = h.fileText();
		const clear = [invite, reset, ...codes, PASSWORD, "sams new password", samToken, owner.split("=")[1]!, MAKER_TOKEN, RELAY_TOKEN];
		for (const value of clear) {
			assert.ok(!text.includes(value), "file");
			assert.ok(!text.includes(value.replace("-", "")), "file, without its dash");
		}
		const secrets = [...clear, ...h.maker.secrets];
		for (const line of h.logs) for (const value of secrets) assert.ok(!line.includes(value), line);
		assert.ok(h.logs.length > 0, "something was logged");
		assert.equal(fs.statSync(h.deps.store.file).mode & 0o777, 0o600);
	});
});

describe("findings from the real stack", () => {
	it("1: the owner's claim gives four recovery codes, and one of them resets the owner's password", async () => {
		const fresh = harness(TMP);
		const lines: string[] = [];
		(await import("../gateway/main.ts")).announceSetupCode(fresh.deps.store, (l) => lines.push(l));
		const claim = await fresh.call(fresh.post("/api/server-auth/setup", { code: lines[1]!.split(": ")[1]!, name: "Boss", password: PASSWORD }));
		const { codes } = await claim.json() as { codes: string[] };
		assert.equal(codes.length, 4);
		const r = await fresh.call(fresh.post("/api/server-auth/reset", { name: "boss", code: codes[3], password: "the owner's new one" }));
		assert.equal(r.status, 200);
	});

	it("2: several Cookie lines are joined with '; '; two Authorization lines are refused (400)", async () => {
		const { toHeaders, startGateway } = await import("../gateway/main.ts");
		assert.equal(toHeaders(["Cookie", "a=1", "Host", "x", "cookie", "__Host-lh_session=t"]).get("cookie"), "a=1; __Host-lh_session=t");
		assert.throws(() => toHeaders(["Authorization", "Bearer a", "authorization", "Bearer b"]));
		const owner = await h.signIn("Boss", PASSWORD);
		const gateway = await startGateway(h.deps.config, { relay: h.deps.relay, log: () => {}, loop: false, listen: false });
		await new Promise<void>((resolve) => gateway.server.listen(0, "127.0.0.1", resolve));
		try {
			const port = (gateway.server.address() as import("node:net").AddressInfo).port;
			const raw = (headers: Array<[string, string]>) => new Promise<number>((resolve, reject) => {
				const req = http.request({ host: "127.0.0.1", port, path: "/gate", method: "GET", headers: headers.flat() as unknown as http.OutgoingHttpHeaders }, (res) => { res.resume(); resolve(res.statusCode!); });
				req.on("error", reject);
				req.end();
			});
			const base: Array<[string, string]> = [["x-forwarded-method", "GET"], ["x-forwarded-uri", "/chat/1"], ["host", "learn.example.com"]];
			assert.equal(await raw([...base, ["cookie", "lh_server=1"], ["cookie", owner]]), 200, "the session in the second Cookie line");
			assert.equal(await raw([...base, ["cookie", owner], ["cookie", owner]]), 303, "named twice: none");
			const sync: Array<[string, string]> = [["x-forwarded-method", "POST"], ["x-forwarded-uri", "/api/sync/hello"], ["host", "learn.example.com"]];
			assert.equal(await raw([...sync, ["authorization", `Bearer ${"A".repeat(43)}`]]), 200);
			assert.equal(await raw([...sync, ["authorization", `Bearer ${"A".repeat(43)}`], ["authorization", `Bearer ABC${"k".repeat(43)}`]]), 400);
		} finally {
			await gateway.stop();
		}
	});

	it("3: /gate is matched on its path; its own query (Caddy appends the request's) is never read", async () => {
		const owner = await h.signIn("Boss", PASSWORD);
		const ask = (gatePath: string, uri: string) => handleRequest(h.get(gatePath, { "x-forwarded-method": "GET", "x-forwarded-uri": uri, cookie: owner }), h.deps, ALL_ROUTES);
		for (const gatePath of ["/gate?z=2", "/gate?anything", "/gate?x=/../..", "/gate?x=%2e%2e%2fapi%2finternal"]) {
			const a = await ask(gatePath, "/chat/1");
			assert.equal(a.status, 200, gatePath);
			assert.equal(a.headers.get("x-lh-scope"), "session");
			assert.equal((await ask(gatePath, "/api/internal/unpair-all")).status, 404, gatePath);
			assert.equal((await ask(gatePath, "/_next/a%23/../../api/chats")).status, 400, gatePath);
		}
	});

	it("4: the lockout's address comes from X-Forwarded-For only, never X-Real-IP or Forwarded", async () => {
		for (let i = 0; i < 5; i += 1) {
			await h.call(h.post("/api/server-auth/login", { name: "Boss", password: "wrong wrong wrong" }, { "x-real-ip": `198.51.100.${i}`, forwarded: `for=198.51.100.${i}` }));
		}
		assert.deepEqual(Object.keys(h.state().lockouts), ["203.0.113.7"]);
		const blocked = await h.call(h.post("/api/server-auth/login", { name: "Boss", password: PASSWORD }, { "x-real-ip": "192.0.2.1", forwarded: "for=192.0.2.1" }));
		assert.equal(blocked.status, 429);
	});

	it("5: the relay always names a client for the copy: the real one on a pairing, 'gateway' on unpair-all", async () => {
		const { createRelay } = await import("../gateway/copies.ts");
		const seen: Headers[] = [];
		const relay = createRelay({ relayUrl: "http://caddy:9200", relayToken: RELAY_TOKEN }, async (_input, init) => { seen.push(new Headers(init?.headers)); return Response.json({ ok: true }); });
		await relay.send({ upstream: "lh-acct-ABC:3000", gateSecret: "s".repeat(43), scope: "internal", method: "POST", path: "/api/internal/unpair-all", body: "{}" });
		await relay.send({ upstream: "lh-acct-ABC:3000", gateSecret: "s".repeat(43), scope: "sync", clientAddress: "203.0.113.7", method: "POST", path: "/api/sync/pair", headers: { "x-lh-scope": "session", "x-lh-client-addr": "1.1.1.1" }, body: "{}" });
		assert.equal(seen[0]!.get("x-lh-client-addr"), "gateway");
		assert.equal(seen[0]!.get("x-lh-scope"), "internal");
		assert.equal(seen[1]!.get("x-lh-client-addr"), "203.0.113.7", "a header passed in can't override it");
		assert.equal(seen[1]!.get("x-lh-scope"), "sync");
	});
});
