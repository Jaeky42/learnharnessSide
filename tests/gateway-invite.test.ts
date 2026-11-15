/**
 * Multi-account, slice 3b: redeeming an invite at the gateway. The page and
 * its words (the recovery codes rendered by the page's own script from the
 * POST's answer); a redeem end to end (an active account, signed in, its own
 * copy, four codes once, the invite used up, a unique tag); the refusals in
 * the approved words; the maker failing, losing its answer or hanging (the
 * reservation undone, its leftovers removed, the invite usable again,
 * nothing stranding a slot or a name); two redeems of one code at once, and
 * two racing for the last slot; one lockout for passwords and every code;
 * Clear-Site-Data on every answer that starts or ends a sign-in.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import * as acc from "../src/core/accounts.ts";
import * as words from "../src/core/account-screens.ts";
import * as core from "../src/core/server-auth.ts";
import * as pages from "../gateway/pages.ts";
import { cookiesOf, harness, MIN, PASSWORD, sessionFrom, type Harness } from "./gateway-fakes.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-gateway-invite-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const NEW_PASSWORD = "a long new password";

let h: Harness;
let owner: string;
beforeEach(async () => {
	h = harness(TMP);
	owner = await h.claimOwner();
});

async function invite(): Promise<string> {
	const response = await h.ownerOp(owner, { op: "invite" });
	assert.equal(response.status, 200);
	return (await response.json() as { code: string }).code;
}

const redeem = (code: string, name = "sam", password = NEW_PASSWORD, headers: Record<string, string> = {}) =>
	h.call(h.post("/api/server-auth/invite", { code, name, password }, headers));

describe("the invite page", () => {
	it("shows the approved words, the two hint lines, and the recovery codes' words for its script", async () => {
		const page = await h.call(h.get("/invite"));
		assert.equal(page.status, 200);
		assert.match(page.headers.get("content-security-policy")!, /default-src 'none'/);
		const html = await page.text();
		for (const text of [words.INVITE_TEXT.title, words.INVITE_TEXT.codeLabel, words.INVITE_TEXT.nameLabel, words.INVITE_TEXT.nameHelp, words.INVITE_TEXT.nameHelpSignIn, words.INVITE_TEXT.passwordLabel, words.INVITE_TEXT.passwordHelp, words.INVITE_TEXT.confirmLabel, words.INVITE_TEXT.submit]) {
			assert.ok(html.includes(pages.escapeHtml(text)), text);
		}
		for (const text of [words.RECOVERY_PAGE_TEXT.title, words.RECOVERY_PAGE_TEXT.body, words.RECOVERY_PAGE_TEXT.copy, words.RECOVERY_PAGE_TEXT.continue, words.PASSWORDS_DONT_MATCH, words.USE_AT_LEAST]) {
			assert.ok(html.includes(pages.jsString(text)), text);
		}
		// Literal sentences from the plan.
		assert.ok(html.includes("Create your account"));
		assert.ok(html.includes(pages.jsString("If you forget your password, any one of these lets you choose a new one. Each works once. They won't be shown again.")));
		// The codes are never put anywhere but the page's memory.
		for (const forbidden of ["localStorage", "sessionStorage", "document.cookie", "history.pushState", "location.hash", "?codes"]) assert.ok(!html.includes(forbidden), forbidden);
		assert.ok(html.includes(`window.location.replace("/")`));
		// The standard dark theme.
		assert.ok(html.includes(`color-scheme: dark`));
	});

	it("a signed-in browser goes to its copy; with no owner yet, to /setup", async () => {
		assert.equal((await h.call(h.get("/invite", { cookie: owner }))).headers.get("location"), "https://learn.example.com/");
		const fresh = harness(TMP);
		assert.equal((await fresh.call(fresh.get("/invite"))).headers.get("location"), "https://learn.example.com/setup");
	});
});

describe("redeeming", () => {
	it("end to end: an active member with its own copy, signed in, four codes once, the invite used up", async () => {
		const code = await invite();
		const response = await redeem(code, "Sam");
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("clear-site-data"), `"cache"`);
		const body = await response.json() as { codes: string[] };
		assert.deepEqual(Object.keys(body), ["codes"]);
		assert.equal(body.codes.length, 4);
		assert.equal(new Set(body.codes).size, 4);
		for (const c of body.codes) assert.match(c, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
		const cookies = cookiesOf(response);
		assert.match(cookies[0]!, new RegExp(`^${core.SESSION_COOKIE}=`));
		assert.equal(cookies[1], "lh_owner=; Path=/; Secure; SameSite=Lax; Max-Age=0");

		const sam = acc.findAccountByName(h.state(), "sam")!;
		assert.equal(sam.state, "active");
		assert.equal(sam.role, "member");
		assert.ok(acc.isTag(sam.tag));
		assert.deepEqual(h.maker.calls, ["GET /volumes", `POST /copies ${sam.tag} fresh`]);
		assert.equal(sam.upstream, `lh-acct-${sam.tag}:3000`);
		assert.equal(sam.gateSecret, h.maker.copies.get(sam.tag!)!.secret);
		assert.equal(sam.lastSeenAt, h.clock.now);
		assert.deepEqual(sam.recoveryCodes, body.codes.map((c) => core.setupCodeHash(c)));
		const text = h.fileText();
		for (const c of [code, ...body.codes, NEW_PASSWORD]) {
			assert.ok(!text.includes(c), "nothing in clear");
			assert.ok(!text.includes(c.replace("-", "")), "nothing in clear");
		}
		assert.equal(h.state().invites.length, 0);

		const gate = await h.call(h.gateAsk("/", sessionFrom(response)));
		assert.equal(gate.status, 200);
		assert.equal(gate.headers.get("x-lh-upstream"), sam.upstream);
		assert.equal(gate.headers.get("x-lh-gate"), sam.gateSecret);

		const again = await redeem(code, "other");
		assert.equal(again.status, 401);
		assert.deepEqual(await again.json(), { error: words.INVITE_TEXT.invalid });
		const account = await (await h.call(h.get("/api/server-auth/account", { cookie: sessionFrom(response) }))).json() as Record<string, unknown>;
		assert.equal(account.recoveryCodesLeft, 4);
		assert.equal(account.owner, false);
	});

	it("each new account gets its own tag; a browser's earlier session goes", async () => {
		const first = await redeem(await invite(), "sam");
		const kim = await redeem(await invite(), "kim", NEW_PASSWORD, { cookie: sessionFrom(first) });
		assert.equal(kim.status, 200);
		const s = h.state();
		const tags = s.accounts.map((a) => a.tag).filter((t) => t !== null);
		assert.equal(new Set(tags).size, 2);
		assert.equal(acc.liveSessionsOf(s, acc.findAccountByName(s, "sam")!.id, h.clock.now).length, 0);
	});

	it("refusals, in the approved words", async () => {
		const code = await invite();
		h.addMember("taken", "ZZZ");
		const cases: Array<[Record<string, unknown>, number, string]> = [
			[{ code: "AAAA-AAAA", name: "sam", password: NEW_PASSWORD }, 401, words.INVITE_TEXT.invalid],
			[{ code, name: "TAKEN", password: NEW_PASSWORD }, 400, words.INVITE_TEXT.taken],
			[{ code, name: "admin", password: NEW_PASSWORD }, 400, words.INVITE_TEXT.reserved],
			[{ code, name: "no spaces", password: NEW_PASSWORD }, 400, words.INVITE_TEXT.notAllowed],
			[{ code, name: "sam", password: "short" }, 400, words.USE_AT_LEAST],
		];
		for (const [body, status, error] of cases) {
			const r = await h.call(h.post("/api/server-auth/invite", body));
			assert.equal(r.status, status, error);
			assert.deepEqual(await r.json(), { error });
		}
		assert.equal(h.state().invites.length, 1, "the code still works");
		assert.equal((await redeem(code)).status, 200);
	});

	it("a full server: the approved sentence", async () => {
		const code = await invite();
		h.addMember("kim", "DEF");
		h.addMember("lee", "GHJ");
		h.addMember("max", "KMN");
		const r = await redeem(code);
		assert.equal(r.status, 409);
		assert.deepEqual(await r.json(), { error: words.INVITE_TEXT.full });
		assert.deepEqual(h.maker.calls, []);
	});

	it("a write from another site is refused before anything happens", async () => {
		const code = await invite();
		assert.equal((await redeem(code, "sam", NEW_PASSWORD, { origin: "https://evil.example" })).status, 403);
		assert.equal(h.state().invites.length, 1);
	});
});

describe("when the maker fails", () => {
	async function expectRolledBack(code: string, response: Response): Promise<void> {
		assert.equal(response.status, 503);
		assert.deepEqual(await response.json(), { code: "unavailable" });
		assert.equal(cookiesOf(response).length, 0, "not signed in");
		const s = h.state();
		assert.equal(acc.findAccountByName(s, "sam"), null, "the name is free");
		assert.equal(acc.usedSlots(s), 1, "no slot stranded");
		assert.equal(s.invites.length, 1, "the invite works again");
		assert.equal(h.maker.copies.size, 0, "no container left");
		// Review G: a volume under the tag may not be this attempt's own, so it is never deleted here.
		assert.ok(h.maker.calls.every((c) => !c.startsWith("DELETE /volumes")), "no volume deleted");
		h.maker.heal();
		h.maker.calls = [];
		const retry = await redeem(code);
		assert.equal(retry.status, 200);
	}

	it("a 503 (an update under way): undone; what may exist under the tag is removed", async () => {
		const code = await invite();
		h.maker.fail(/^POST \/copies /, "503");
		const r = await redeem(code);
		const tagged = h.maker.calls.map((c) => c.replace(/\/[0-9A-Z]{3}$/, "/TAG").replace(/ [0-9A-Z]{3} fresh$/, " TAG fresh"));
		assert.deepEqual(tagged, ["GET /volumes", "POST /copies TAG fresh", "DELETE /copies/TAG"]);
		await expectRolledBack(code, r);
	});

	it("an answer lost after the copy was made: the container and its volume are removed", async () => {
		const code = await invite();
		h.maker.fail(/^POST \/copies /, "lost");
		await expectRolledBack(code, await redeem(code));
	});

	it("a maker that hangs (the call times out)", async () => {
		const code = await invite();
		h.maker.fail(/^POST \/copies /, "hang");
		await expectRolledBack(code, await redeem(code));
	});

	it("and can't clean up either: `deleting` (no slot, no sign-in), the invite back; the loop finishes it", async () => {
		const code = await invite();
		h.maker.fail(/^POST \/copies /, "lost");
		h.maker.fail(/^DELETE /, "down", 1);
		const r = await redeem(code);
		assert.equal(r.status, 503);
		const s = h.state();
		const sam = acc.findAccountByName(s, "sam")!;
		assert.equal(sam.state, "deleting");
		assert.equal(acc.usedSlots(s), 1);
		assert.equal(s.invites.length, 1);
		assert.ok(h.maker.copies.has(sam.tag!), "the leftover is still there");
		const login = await h.call(h.post("/api/server-auth/login", { name: "sam", password: NEW_PASSWORD }));
		assert.equal(login.status, 401);
		await h.deps.lifecycle.pass();
		assert.equal(acc.findAccountByName(h.state(), "sam"), null);
		assert.equal(h.maker.copies.size, 0);
		assert.ok(h.maker.volumes.has(sam.tag!), "its volume is kept (it may not be this attempt's own)");
		const retry = await redeem(code);
		assert.equal(retry.status, 200, "the name and the code work");
		assert.notEqual(acc.findAccountByName(h.state(), "sam")!.tag, sam.tag, "the kept volume's tag is not given out again");
	});

	it("no maker configured: 503, nothing kept", async () => {
		const bare = harness(TMP, { makerUrl: null, makerToken: null });
		const boss = await bare.claimOwner();
		const code = (await (await bare.ownerOp(boss, { op: "invite" })).json() as { code: string }).code;
		const r = await bare.call(bare.post("/api/server-auth/invite", { code, name: "sam", password: NEW_PASSWORD }));
		assert.equal(r.status, 503);
		assert.equal(acc.findAccountByName(bare.state(), "sam"), null);
		assert.equal(bare.state().invites.length, 1);
	});
});

describe("review G: a new account never gets a tag whose volume exists", () => {
	/** The harness with the maker's fetch wrapped. */
	async function withMaker(wrap: (original: typeof fetch) => typeof fetch) {
		const makerClient = (await import("../gateway/maker-client.ts")).createMakerClient(h.deps.config, wrap(h.maker.fetch as typeof fetch), { create: 40, call: 40 });
		const lifecycle = (await import("../gateway/lifecycle.ts")).createLifecycle({ store: h.deps.store, maker: makerClient, unpairer: h.deps.unpairer, config: h.deps.config, now: () => h.clock.now, log: () => {} });
		const deps = { ...h.deps, lifecycle };
		const routesMod = await import("../gateway/routes.ts");
		const main = await import("../gateway/main.ts");
		return (request: Request) => routesMod.handleRequest(request, deps, main.ALL_ROUTES);
	}
	const pathOf = (input: string | URL | Request) => new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname;

	it("GET /volumes is asked first: a reserved tag whose volume exists is changed before any create", async () => {
		const code = await invite();
		let reservedTag = "";
		const call = await withMaker((original) => async (input, init) => {
			if (pathOf(input) === "/volumes") {
				reservedTag = acc.findAccountByName(h.state(), "sam")!.tag!;
				h.maker.volumes.add(reservedTag);
				h.maker.calls.push("GET /volumes");
				return Response.json([...h.maker.volumes].sort().map((tag) => ({ tag })));
			}
			return original(input, init);
		});
		const r = await call(h.post("/api/server-auth/invite", { code, name: "sam", password: NEW_PASSWORD }));
		assert.equal(r.status, 200);
		const sam = acc.findAccountByName(h.state(), "sam")!;
		assert.notEqual(sam.tag, reservedTag);
		assert.deepEqual(h.maker.calls, ["GET /volumes", `POST /copies ${sam.tag} fresh`], "no 409 needed");
		assert.ok(h.maker.volumes.has(reservedTag), "the old volume is untouched");
	});

	it("fresh: true's 409 that the list didn't predict: the next tag", async () => {
		const code = await invite();
		let first = true;
		const call = await withMaker((original) => async (input, init) => {
			if (pathOf(input) === "/copies" && init?.method === "POST" && first) {
				first = false;
				h.maker.calls.push("POST /copies (taken)");
				return Response.json({ code: "volume_exists" }, { status: 409 });
			}
			return original(input, init);
		});
		const r = await call(h.post("/api/server-auth/invite", { code, name: "sam", password: NEW_PASSWORD }));
		assert.equal(r.status, 200);
		const sam = acc.findAccountByName(h.state(), "sam")!;
		assert.deepEqual(h.maker.calls, ["GET /volumes", "POST /copies (taken)", `POST /copies ${sam.tag} fresh`]);
		assert.equal(sam.gateSecret, h.maker.copies.get(sam.tag!)!.secret);
	});

	it("every tag refused: rolled back after a bounded number, 503, nothing deleted", async () => {
		const code = await invite();
		let refusedCalls = 0;
		const call = await withMaker((original) => async (input, init) => {
			if (pathOf(input) === "/copies" && init?.method === "POST") {
				refusedCalls += 1;
				h.maker.calls.push("POST /copies (taken)");
				return Response.json({ code: refusedCalls % 2 ? "volume_exists" : "copy_exists" }, { status: 409 });
			}
			return original(input, init);
		});
		const r = await call(h.post("/api/server-auth/invite", { code, name: "sam", password: NEW_PASSWORD }));
		assert.equal(r.status, 503);
		assert.equal(refusedCalls, 5, "a bounded number of tags");
		assert.equal(acc.findAccountByName(h.state(), "sam"), null);
		assert.equal(h.state().invites.length, 1);
		assert.ok(h.maker.calls.every((c) => !c.startsWith("DELETE")), "nothing it didn't make is removed");
	});
});

describe("races", () => {
	it("two redeems of one code at the same instant: exactly one wins", async () => {
		const code = await invite();
		const [a, b] = await Promise.all([redeem(code, "sam"), redeem(code, "kim")]);
		assert.deepEqual([a.status, b.status].sort(), [200, 401]);
		const members = h.state().accounts.filter((x) => x.role === "member");
		assert.equal(members.length, 1);
		assert.equal(h.maker.copies.size, 1);
	});

	it("two redeems racing for the last slot: one account, one 'full'", async () => {
		const one = await invite();
		const two = await invite();
		h.addMember("kim", "DEF");
		h.addMember("lee", "GHJ");
		assert.equal(acc.freeSlots(h.state(), 4), 1);
		const [a, b] = await Promise.all([redeem(one, "sam"), redeem(two, "max")]);
		assert.deepEqual([a.status, b.status].sort(), [200, 409]);
		assert.equal(acc.usedSlots(h.state()), 4);
	});
});

describe("one lockout", () => {
	it("wrong passwords, invite codes, reset codes and recovery tries count together", async () => {
		h.addMember("sam", "ABC");
		const sam = await h.signIn("sam");
		assert.equal((await h.call(h.post("/api/server-auth/login", { name: "sam", password: "wrong password" }))).status, 401);
		assert.equal((await redeem("AAAA-AAAA")).status, 401);
		assert.equal((await h.call(h.post("/api/server-auth/reset", { name: "sam", code: "BBBB-BBBB", password: NEW_PASSWORD }))).status, 401);
		assert.equal((await h.call(h.post("/api/server-auth/recovery-codes", { password: "wrong password" }, { cookie: sam }))).status, 401);
		const fifth = await redeem("CCCC-CCCC");
		assert.equal(fifth.status, 429);
		assert.deepEqual(await fifth.json(), { error: words.tooManyAttempts(15 * MIN) });
		const code = await invite();
		assert.equal((await redeem(code)).status, 429, "even the right code waits");
		assert.equal((await h.call(h.post("/api/server-auth/login", { name: "Boss", password: PASSWORD }))).status, 429);
	});
});

describe("Clear-Site-Data", () => {
	it("on every answer that starts or ends a sign-in", async () => {
		h.addMember("sam", "ABC");
		const login = await h.call(h.post("/api/server-auth/login", { name: "sam", password: "sams own passphrase" }));
		assert.equal(login.headers.get("clear-site-data"), `"cache"`);
		const sam = sessionFrom(login);
		const logout = await h.call(h.post("/api/server-auth/logout", {}, { cookie: sam }));
		assert.equal(logout.headers.get("clear-site-data"), `"cache"`);
		const again = await h.signIn("sam");
		const everywhere = await h.call(h.post("/api/server-auth/sign-out-everywhere", {}, { cookie: again }));
		assert.equal(everywhere.headers.get("clear-site-data"), `"cache"`);
		// A refusal is not a sign-in.
		const wrong = await h.call(h.post("/api/server-auth/login", { name: "sam", password: "nope nope nope" }));
		assert.equal(wrong.headers.get("clear-site-data"), null);
		// The first start (the setup answer) is covered here with a fresh server.
		const fresh = harness(TMP);
		const lines: string[] = [];
		(await import("../gateway/main.ts")).announceSetupCode(fresh.deps.store, (l) => lines.push(l));
		const setupCode = lines[1]!.split(": ")[1]!;
		const setup = await fresh.call(fresh.post("/api/server-auth/setup", { code: setupCode, name: "Boss", password: PASSWORD }));
		assert.equal(setup.status, 200);
		assert.equal(setup.headers.get("clear-site-data"), `"cache"`);
	});
});
