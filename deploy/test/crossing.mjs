#!/usr/bin/env node
/**
 * The crossing tests (docs/multi-account-build.md, slice 6): against a
 * RUNNING stack (deploy/compose.yaml), make two member accounts through the
 * real invite flow and try every way one account could reach another's copy,
 * the owner's, the gateway, the maker or Caddy's relay. Each crossing must be
 * refused; the first one that isn't stops the run with a non-zero exit.
 *
 *   node deploy/test/crossing.mjs --base https://localhost --ca <caddy root.crt> [--compose-dir deploy]
 *
 * The owner's account: LH_CROSSING_OWNER_NAME and LH_CROSSING_OWNER_PASSWORD
 * in the environment, or, on a stack nobody has claimed yet, the script claims
 * it with the setup code from `docker compose logs gateway`.
 *
 * Needs `docker` on the PATH (it runs commands inside the containers) and
 * Node 22 or later. Node's own modules only. It prints no secret, code,
 * password or cookie. The two member accounts are removed and deleted at the
 * end, also after a failure, so the run can be repeated (the cap counts them).
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
	options: {
		base: { type: "string", default: "https://localhost" },
		ca: { type: "string" },
		"compose-dir": { type: "string", default: path.join(import.meta.dirname, "..") },
		caddy: { type: "string", default: "lh-caddy" },
	},
});
const BASE = new URL(args.base);
const CA = args.ca ? fs.readFileSync(args.ca) : undefined;
const COMPOSE_DIR = path.resolve(args["compose-dir"]);
const SYNC_PROTOCOL = "3";

// ─── HTTP, raw paths ─────────────────────────────────────────────────────────

/** One request; the path is sent exactly as given (no normalizing). */
function request(method, target, { cookie, headers = {}, body } = {}) {
	return new Promise((resolve, reject) => {
		const data = body === undefined ? undefined : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
		const all = { host: BASE.host, ...headers };
		if (cookie) all.cookie = cookie;
		if (data) { all["content-type"] ??= "application/json"; all["content-length"] = String(data.length); }
		if (method !== "GET" && method !== "HEAD") all.origin ??= BASE.origin;
		const req = https.request({ host: BASE.hostname, port: BASE.port || 443, method, path: target, headers: all, ca: CA, servername: BASE.hostname, agent: false, timeout: 30_000 }, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
		});
		req.on("timeout", () => req.destroy(new Error("timeout")));
		req.on("error", reject);
		if (data) req.write(data);
		req.end();
	});
}
const jsonOf = (r) => { try { return JSON.parse(r.text); } catch { return null; } };
/** The session cookie a response set, as "name=value" (never printed). */
function sessionCookieOf(r) {
	for (const c of [r.headers["set-cookie"] ?? []].flat()) {
		const m = /^(__Host-lh_session=[^;]+)/.exec(c);
		if (m && !/=;/.test(c)) return m[1];
	}
	return null;
}

// ─── Docker ──────────────────────────────────────────────────────────────────

const docker = (argv, input) => execFileSync("docker", argv, { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"], timeout: 60_000 });
const compose = (argv) => execFileSync("docker", ["compose", ...argv], { cwd: COMPOSE_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
const containerOf = (service) => compose(["ps", "-q", service]).trim();
/** A request made from inside a container: "<status>" or "unreachable:<reason>". */
function fromInside(container, url, headers = {}) {
	const script = `fetch(process.argv[1],{headers:JSON.parse(process.argv[2]),signal:AbortSignal.timeout(5000),redirect:"manual"}).then(r=>console.log(r.status)).catch(e=>console.log("unreachable:"+((e.cause&&e.cause.code)||e.name)))`;
	try { return docker(["exec", container, "node", "-e", script, url, JSON.stringify(headers)]).trim(); }
	catch { return "exec-failed"; }
}

// ─── The table ───────────────────────────────────────────────────────────────

const rows = [];
let failed = false;
class Stop extends Error {}
/** `want` is a status, a list of statuses, or a predicate over the answer. */
function expect(name, got, want, detail = "") {
	const ok = typeof want === "function" ? want(got) : [want].flat().includes(got);
	const shown = typeof want === "function" ? "refused" : [want].flat().join("/");
	rows.push({ ok, name, want: shown, got: String(got), detail });
	if (!ok) { failed = true; throw new Stop(name); }
}
function printTable() {
	const w = Math.min(70, Math.max(...rows.map((r) => r.name.length)));
	console.log(`\n${"crossing".padEnd(w)}  expected        got`);
	for (const r of rows) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name.slice(0, w).padEnd(w)}  ${r.want.padEnd(14)}  ${r.got}${r.detail ? `  (${r.detail})` : ""}`);
	console.log(`\n${rows.filter((r) => r.ok).length} of ${rows.length} refused as expected${failed ? "; STOPPED at the first crossing that was not refused" : ""}.`);
}

// ─── Accounts ────────────────────────────────────────────────────────────────

const rand = (n) => randomBytes(n).toString("hex");
const password = () => `pw-${rand(12)}`;

async function ownerCookie() {
	let name = process.env.LH_CROSSING_OWNER_NAME;
	let pass = process.env.LH_CROSSING_OWNER_PASSWORD;
	const home = await request("GET", "/");
	if (home.status >= 300 && home.status < 400 && /\/setup$/.test(home.headers.location ?? "")) {
		const code = /Setup code: ([0-9A-Z]{4}-[0-9A-Z]{4})/g;
		const logs = compose(["logs", "--no-log-prefix", "gateway"]);
		const all = [...logs.matchAll(code)];
		if (!all.length) throw new Error("the stack is unclaimed and the gateway's log has no setup code");
		name = "owner-x"; pass = password();
		const claim = await request("POST", "/api/server-auth/setup", { body: { code: all.at(-1)[1], name, password: pass } });
		if (claim.status !== 200) throw new Error(`claiming the stack answered ${claim.status}`);
		console.log("Claimed the stack as owner-x (a fresh stack).");
	}
	if (!name || !pass) throw new Error("set LH_CROSSING_OWNER_NAME and LH_CROSSING_OWNER_PASSWORD");
	const r = await request("POST", "/api/server-auth/login", { body: { name, password: pass } });
	const cookie = sessionCookieOf(r);
	if (r.status !== 200 || !cookie) throw new Error(`the owner's sign-in answered ${r.status}`);
	return cookie;
}

async function accountsView(owner) {
	const r = await request("GET", "/api/accounts", { cookie: owner });
	if (r.status !== 200) throw new Error(`GET /api/accounts answered ${r.status}`);
	return jsonOf(r);
}
/** Every account record in the owner's view, whatever group it is in. */
function accountsIn(view) {
	const out = [];
	const walk = (v) => {
		if (Array.isArray(v)) v.forEach(walk);
		else if (v && typeof v === "object") {
			if (typeof v.id === "string" && typeof v.name === "string") out.push(v);
			Object.values(v).forEach(walk);
		}
	};
	walk(view);
	return out;
}
async function accountId(owner, name) {
	const found = accountsIn(await accountsView(owner)).find((a) => a.name === name);
	if (!found) throw new Error(`account ${name} not in the owner's list`);
	return found.id;
}
const op = (owner, body) => request("POST", "/api/accounts", { cookie: owner, body });

async function makeMember(owner, name) {
	const invite = await op(owner, { op: "invite" });
	const code = jsonOf(invite)?.code;
	if (invite.status !== 200 || !code) throw new Error(`New invite code answered ${invite.status}`);
	const pass = password();
	const r = await request("POST", "/api/server-auth/invite", { body: { code, name, password: pass } });
	const cookie = sessionCookieOf(r);
	if (r.status !== 200 || !cookie) throw new Error(`redeeming the invite answered ${r.status}`);
	const id = await accountId(owner, name);
	return { name, pass, cookie, id };
}

/** The copy behind a member's session answers; wait for it (a new copy is starting). */
async function waitForCopy(cookie) {
	for (let i = 0; i < 90; i++) {
		const r = await request("GET", "/api/chats", { cookie }).catch(() => null);
		if (r?.status === 200) return;
		await new Promise((res) => setTimeout(res, 1000));
	}
	throw new Error("a new copy did not answer within 90 s");
}

async function marker(cookie, label) {
	const r = await request("POST", "/api/chats", { cookie, body: { title: label } });
	const id = jsonOf(r)?.id ?? jsonOf(r)?.chat?.id;
	if (r.status !== 200 || typeof id !== "string") throw new Error(`making a marker session answered ${r.status}`);
	return id;
}
async function chatIds(cookie) {
	const r = await request("GET", "/api/chats", { cookie });
	return r.status === 200 ? (jsonOf(r)?.chats ?? []).map((c) => c.id) : null;
}

async function pairKey(cookie) {
	const code = jsonOf(await request("POST", "/api/server-auth/desktops", { cookie, body: { op: "code" } }))?.code;
	if (typeof code !== "string") throw new Error("no pairing code");
	const r = await request("POST", "/api/sync/pair", { body: { code, deviceId: `dev_${rand(8)}`, name: "Crossing test" } });
	const key = jsonOf(r)?.key;
	if (r.status !== 200 || typeof key !== "string") throw new Error(`pairing answered ${r.status}`);
	return { code, key };
}
const sync = (key, method, target, body) => request(method, target, { headers: { authorization: `Bearer ${key}`, "x-lh-sync-protocol": SYNC_PROTOCOL }, body });

// ─── The run ─────────────────────────────────────────────────────────────────

const refusedStatus = (s) => s === 400 || s === 401 || s === 403 || s === 404 || s === 502 || s === 503;
const unreachable = (s) => s.startsWith("unreachable:");

async function main() {
	const owner = await ownerCookie();
	const tagOf = (container) => docker(["inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", container]).match(/^LH_ACCOUNT_TAG=(\w{3})$/m)?.[1];
	const suffix = rand(3);
	const made = [];
	try {
		const a = await makeMember(owner, `xa-${suffix}`); made.push(a);
		const b = await makeMember(owner, `xb-${suffix}`); made.push(b);
		await waitForCopy(a.cookie); await waitForCopy(b.cookie);
		const markers = { owner: await marker(owner, `marker-owner-${suffix}`), a: await marker(a.cookie, `marker-a-${suffix}`), b: await marker(b.cookie, `marker-b-${suffix}`) };
		const keys = { owner: await pairKey(owner), a: await pairKey(a.cookie), b: await pairKey(b.cookie) };
		// A member's tag is the first 3 characters of its device key; its container is named after it.
		a.tag = keys.a.key.slice(0, 3); b.tag = keys.b.key.slice(0, 3);
		a.container = `lh-acct-${a.tag}`; b.container = `lh-acct-${b.tag}`;
		expect("A's container carries A's tag (control)", tagOf(a.container), a.tag);
		const owners = containerOf("lh"), gateway = containerOf("gateway");

		// 1. Each cookie reaches only its own copy.
		for (const [who, cookie] of [["owner", owner], ["a", a.cookie], ["b", b.cookie]]) {
			const ids = await chatIds(cookie);
			const others = Object.entries(markers).filter(([k]) => k !== who).map(([, id]) => id);
			expect(`${who}'s cookie lists its own marker and no other`, ids && ids.includes(markers[who]) && !others.some((id) => ids.includes(id)) ? "own only" : JSON.stringify(ids?.length ?? null), "own only");
		}
		expect("pairing codes: a member's is XXXX-XXXX-TTT, the owner's XXXX-XXXX", `${keys.a.code.length}/${keys.owner.code.length}`, "13/9");
		expect("device keys: a member's 46 characters (its tag first), the owner's 43", `${keys.a.key.length}/${keys.owner.key.length}`, "46/43");

		// 2. Another account's session, by cookie or by key.
		expect("A's cookie + forged X-LH-Upstream/X-LH-Gate/X-LH-Scope naming B's copy -> still A's library",
			await request("GET", "/api/chats", { cookie: a.cookie, headers: { "x-lh-upstream": `${b.container}:3000`, "x-lh-gate": rand(32), "x-lh-scope": "internal", "x-lh-relay": rand(32), "x-lh-client-addr": "203.0.113.9" } })
				.then((r) => (jsonOf(r)?.chats ?? []).map((c) => c.id)).then((ids) => ids.includes(markers.a) && !ids.includes(markers.b) ? "A only" : "crossed"), "A only");
		expect("signed out + every forged X-LH-* header -> refused", (await request("GET", "/api/chats", { headers: { "x-lh-upstream": `${a.container}:3000`, "x-lh-gate": rand(32), "x-lh-scope": "session", "x-lh-relay": rand(32), "x-lh-client-addr": "203.0.113.9" } })).status, 401);
		expect("A's and B's cookies together -> one account's library, never both", await (async () => {
			const r = await request("GET", "/api/chats", { cookie: `${a.cookie}; ${b.cookie}` });
			const ids = (jsonOf(r)?.chats ?? []).map((c) => c.id);
			return r.status !== 200 ? "refused" : ids.includes(markers.a) && ids.includes(markers.b) ? "both" : "one";
		})(), ["one", "refused"]);
		expect("A's key reads A's marker session (control)", (await sync(keys.a.key, "GET", `/api/sync/sessions/${markers.a}`)).status, 200);
		expect("B's key on A's marker session -> not there", (await sync(keys.b.key, "GET", `/api/sync/sessions/${markers.a}`)).status, [401, 403, 404]);
		expect("A's key with B's tag -> not paired", (await sync(b.tag + keys.a.key.slice(3), "POST", "/api/sync/hello", {})).status, 401);
		expect("A's key without its tag (43 characters: the owner's copy) -> not paired", (await sync(keys.a.key.slice(3), "POST", "/api/sync/hello", {})).status, 401);
		expect("the owner's key with A's tag in front -> not paired", (await sync(a.tag + keys.owner.key, "POST", "/api/sync/hello", {})).status, 401);
		expect("A's key on the owner's marker -> not there", (await sync(keys.a.key, "GET", `/api/sync/sessions/${markers.owner}`)).status, [401, 403, 404]);
		const codeA = jsonOf(await request("POST", "/api/server-auth/desktops", { cookie: a.cookie, body: { op: "code" } }))?.code;
		expect("A's pairing code with B's tag -> refused", (await request("POST", "/api/sync/pair", { body: { code: codeA.slice(0, -3) + b.tag, deviceId: `dev_${rand(8)}`, name: "Crossing test" } })).status, [400, 401, 404]);
		expect("A's pairing code with no tag (the owner's copy) -> refused", (await request("POST", "/api/sync/pair", { body: { code: codeA.slice(0, 9), deviceId: `dev_${rand(8)}`, name: "Crossing test" } })).status, [400, 401, 404]);
		expect("a client-sent X-LH-Scope: internal on a sync path does nothing more", (await request("POST", "/api/sync/hello", { headers: { authorization: `Bearer ${keys.a.key}`, "x-lh-sync-protocol": SYNC_PROTOCOL, "x-lh-scope": "internal" }, body: {} })).status, 200);

		// 3. From inside containers.
		for (const [from, label] of [[a.container, "A's copy"], [owners, "the owner's copy"]]) {
			for (const [target, what] of [[`http://${b.container}:3000/api/chats`, "B's copy"], [`http://${a.container}:3000/api/chats`, "A's copy"], ["http://lh:3000/api/chats", "the owner's copy"], ["http://gateway:9000/gate", "the gateway"], ["http://maker:9100/copies", "the maker"]]) {
				if (from === a.container && what === "A's copy") continue;
				if (from === owners && what === "the owner's copy") continue;
				expect(`from ${label}: ${what}`, fromInside(from, target), unreachable, target);
			}
			expect(`from ${label}: Caddy's relay with a wrong token naming B's copy`, fromInside(from, `http://${args.caddy}:9200/api/chats`, { "x-lh-relay": rand(32), "x-lh-upstream": `${b.container}:3000`, "x-lh-gate": rand(32) }), "404");
			expect(`from ${label}: Caddy's relay with no token`, fromInside(from, `http://${args.caddy}:9200/api/chats`, { "x-lh-upstream": "lh:3000" }), "404");
		}
		expect("from B's copy: the maker", fromInside(b.container, "http://maker:9100/copies"), unreachable);
		expect("from the gateway: a copy directly (it goes through the relay only)", fromInside(gateway, `http://${a.container}:3000/api/chats`), unreachable);

		// 4. /api/internal/* and path tricks, from outside.
		const internal = ["/api/internal/unpair-all", "/api/Internal/unpair-all", "/API/internal/unpair-all", "/api//internal/unpair-all", "//api/internal/unpair-all", "/api/./internal/unpair-all", "/api/%69nternal/unpair-all", "/api/internal%2funpair-all", "/api/chats/../internal/unpair-all", "/api/x/..%2finternal/unpair-all"];
		for (const p of internal) {
			for (const [who, cookie] of [["signed out", undefined], ["owner", owner], ["A", a.cookie]]) {
				expect(`POST ${p} (${who})`, (await request("POST", p, { cookie, headers: { "x-lh-scope": "internal" }, body: {} })).status, [400, 404]);
			}
		}
		const tricks = ["/_next/a#/../../api/chats", "/_next/static/../../api/chats", "/_next/static/%2e%2e/%2e%2e/api/chats", "/_next/a%23/../../api/chats", "//api/chats", "/icons/../api/chats", "/favicon.ico/../api/chats", "/fonts/..%2f..%2fapi/chats", "/login/../api/chats", "/api/server-auth/../chats", "/api/sync/pair/../../chats", `${BASE.protocol}//evil.example/api/chats`];
		for (const p of tricks) {
			expect(`GET ${p} (signed out)`, (await request("GET", p)).status, refusedStatus);
			const r = await request("GET", p, { cookie: a.cookie });
			const ids = r.status === 200 ? (jsonOf(r)?.chats ?? []).map((c) => c.id) : [];
			expect(`GET ${p} (A) -> refused, or A's own and nothing else`, refusedStatus(r.status) || (ids.includes(markers.a) && !ids.includes(markers.b) && !ids.includes(markers.owner)) || (r.status === 200 && !r.text.includes("chat_")) ? "safe" : `${r.status} crossed`, "safe");
		}
		expect("a Service-Worker: script request -> 403", (await request("GET", "/sw.js", { cookie: a.cookie, headers: { "service-worker": "script" } })).status, 403);

		// 5. Paused, removed and deleted accounts.
		const hello = (key) => sync(key, "POST", "/api/sync/hello", {}).then((r) => r.status);
		expect("pause A (control)", (await op(owner, { op: "pause", id: a.id })).status, 200);
		expect("paused: A's cookie -> refused", (await request("GET", "/api/chats", { cookie: a.cookie })).status, refusedStatus);
		expect("paused: A's key -> 503 (the desktop keeps its key)", await hello(keys.a.key), 503);
		expect("paused: A's container stopped", docker(["inspect", "-f", "{{.State.Status}}", a.container]).trim(), "exited");
		expect("paused: B unaffected (control)", await hello(keys.b.key), 200);
		expect("resume A (control)", (await op(owner, { op: "resume", id: a.id })).status, 200);
		for (let i = 0; i < 60 && (await hello(keys.a.key)) !== 200; i++) await new Promise((res) => setTimeout(res, 1000));
		expect("resumed: A's key works again", await hello(keys.a.key), 200);
		expect("remove A (control)", (await op(owner, { op: "remove", id: a.id })).status, 200);
		expect("removed: A's cookie -> refused", (await request("GET", "/api/chats", { cookie: a.cookie })).status, refusedStatus);
		expect("removed: A's key -> 503 (kept 30 days)", await hello(keys.a.key), 503);
		expect("removed: A's container gone", (() => { try { docker(["inspect", a.container]); return "present"; } catch { return "gone"; } })(), "gone");
		expect("delete A now (control)", (await op(owner, { op: "delete-now", id: a.id })).status, 200);
		made.splice(made.indexOf(a), 1);
		const notPaired = await sync(keys.a.key, "POST", "/api/sync/hello", {});
		expect("deleted: A's key -> 401 not_paired", `${notPaired.status} ${jsonOf(notPaired)?.code ?? ""}`.trim(), "401 not_paired");
		expect("deleted: A's cookie -> refused", (await request("GET", "/api/chats", { cookie: a.cookie })).status, refusedStatus);
		expect("deleted: A's volume gone", docker(["volume", "ls", "-q", "--filter", `name=^${a.container}-data$`]).trim() || "gone", "gone");
		expect("deleted: A's name can't sign in", (await request("POST", "/api/server-auth/login", { body: { name: a.name, password: a.pass } })).status, 401);
	} catch (error) {
		if (!(error instanceof Stop)) { console.error(`\nThe run could not go on: ${error instanceof Error ? error.message : error}`); failed = true; }
	} finally {
		for (const m of made) {
			try {
				await op(owner, { op: "remove", id: m.id });
				await op(owner, { op: "delete-now", id: m.id });
			} catch { console.error(`Could not clean up ${m.name}; remove it in Settings → Accounts.`); }
		}
		await request("POST", "/api/server-auth/logout", { cookie: owner }).catch(() => {});
	}
	printTable();
	process.exit(failed ? 1 : 0);
}

await main();
