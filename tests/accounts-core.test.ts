/**
 * Accounts on one server (docs/fork/plans/multi-account-build.md, slice 1a): the pure
 * rules in src/core/accounts.ts and the approved words in
 * src/core/account-screens.ts. Every state passed in is deep-frozen, so a
 * function that mutates its input throws. Real scrypt is used sparingly: most
 * fixtures share one pre-made password hash.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as acc from "../src/core/accounts.ts";
import * as words from "../src/core/account-screens.ts";
import fs from "node:fs";
import { formatWait, hashPassword, newSetupCode, normalizeSetupCode, PASSWORD_MIN_LENGTH, passwordProblem, setupCodeHash, verifyPassword } from "../src/core/server-auth.ts";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 9, 18, 20);
const ADDR = "203.0.113.7";
const PASSWORD = "correct horse battery";
const PW = hashPassword(PASSWORD);

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const inner of Object.values(value as object)) deepFreeze(inner);
	}
	return value;
}

type Ok<T> = Extract<T, { ok: true }>;
function good<T extends { ok: boolean }>(result: T): Ok<T> {
	assert.equal(result.ok, true, JSON.stringify(result));
	return result as Ok<T>;
}
function refused<T extends { ok: boolean }>(result: T, code: string): Extract<T, { ok: false }> {
	assert.equal(result.ok, false, "expected a refusal");
	assert.equal((result as unknown as { code: string }).code, code);
	return result as Extract<T, { ok: false }>;
}

const RECOVERY = ["AAAA-BBBB", "CCCC-DDDD", "EEEE-FFFF", "GGGG-HHHH"];

function account(over: Partial<acc.AccountRecord> & { name: string }): acc.AccountRecord {
	return {
		id: `acct_${over.name}`, tag: null, nameKey: over.name.toLowerCase(), password: PW, recoveryCodes: [],
		role: "member", state: "active", createdAt: NOW - 10 * DAY, lastSeenAt: null, removedAt: null,
		upstream: `lh-acct-${over.tag ?? "own"}:3000`, gateSecret: "secret", ...over,
	};
}

/** Owner "Boss", members "sam" (tag 7KQ) and "kim" (tag M9X). */
function fixture(extra: Partial<acc.GatewayState> = {}): acc.GatewayState {
	return deepFreeze({
		...acc.emptyGatewayState(),
		accounts: [
			account({ name: "Boss", role: "owner", tag: null, createdAt: NOW - 30 * DAY }),
			account({ name: "sam", tag: "7KQ", recoveryCodes: RECOVERY.map(setupCodeHash) }),
			account({ name: "kim", tag: "M9X", createdAt: NOW - 5 * DAY }),
		],
		...extra,
	});
}

const idOf = (state: acc.GatewayState, name: string): string => acc.findAccountByName(state, name)!.id;
const withState = (state: acc.GatewayState, id: string, status: acc.AccountStatus, removedAt: number | null = null): acc.GatewayState =>
	deepFreeze({ ...state, accounts: state.accounts.map((a) => a.id === id ? { ...a, state: status, removedAt } : a) });

describe("the stored file", () => {
	it("parses what it wrote and drops unknown fields", () => {
		let state = fixture();
		state = acc.createAccountSession(state, idOf(state, "sam"), "Safari on iPhone", NOW).state;
		state = good(acc.createInvite(state, 4, NOW)).state;
		state = good(acc.issueResetCode(state, idOf(state, "kim"), NOW)).state;
		state = { ...state, lockouts: { [ADDR]: { failures: 2, level: 0, lockedUntil: 0, lastFailureAt: NOW, against: "*" } }, setupCodeHash: setupCodeHash("ZZZZ-ZZZZ") };
		const text = JSON.parse(JSON.stringify(state));
		assert.deepEqual(acc.parseGatewayState(text), state);
		const noisy = { ...text, extra: 1, accounts: text.accounts.map((a: object) => ({ ...a, extra: 2 })), sessions: text.sessions.map((s: object) => ({ ...s, extra: 3 })) };
		assert.deepEqual(acc.parseGatewayState(noisy), state);
		assert.deepEqual(acc.parseGatewayState(acc.emptyGatewayState()), acc.emptyGatewayState());
	});

	it("refuses a wrong version or shape", () => {
		const good1 = JSON.parse(JSON.stringify(fixture()));
		const attempt = (change: (value: Record<string, any>) => void) => {
			const copy = JSON.parse(JSON.stringify(good1));
			change(copy);
			assert.throws(() => acc.parseGatewayState(copy));
		};
		assert.throws(() => acc.parseGatewayState(null));
		assert.throws(() => acc.parseGatewayState("x"));
		attempt((v) => { v.version = 2; });
		attempt((v) => { delete v.version; });
		attempt((v) => { v.accounts = {}; });
		attempt((v) => { v.sessions = null; });
		attempt((v) => { v.lockouts = []; });
		attempt((v) => { v.setupCodeHash = "nothash"; });
		attempt((v) => { v.accounts[0].state = "gone"; });
		attempt((v) => { v.accounts[0].role = "king"; });
		attempt((v) => { v.accounts[1].tag = "iii"; });
		attempt((v) => { v.accounts[1].password = null; });
		attempt((v) => { v.accounts[1].recoveryCodes = ["plain"]; });
		attempt((v) => { v.accounts[1].upstream = 5; });
		attempt((v) => { v.invites = [{ id: "x", codeHash: "nope", createdAt: 1, expiresAt: 2 }]; });
		attempt((v) => { v.resets = [{ accountId: "x", codeHash: "0".repeat(64), createdAt: "1", expiresAt: 2 }]; });
		attempt((v) => { v.sessions = [{ id: "s", tokenHash: "0".repeat(64), label: "", createdAt: 1, expiresAt: 2, lastSeenAt: 1 }]; });
		attempt((v) => { v.lockouts = { a: { failures: "x" } }; });
	});
});

describe("names", () => {
	it("allows 3 to 20 letters, digits and dashes", () => {
		for (const ok of ["sam", "Sam-2", "a-b", "x".repeat(20), "007"]) assert.equal(acc.checkName(acc.emptyGatewayState(), ok), null, ok);
		for (const no of ["ab", "x".repeat(21), "sam smith", "sám", "sam_1", "sam.", "", " sam", "sam\n"]) assert.equal(acc.checkName(fixture(), no), "not-allowed", JSON.stringify(no));
		for (const no of [null, undefined, 42, {}]) assert.equal(acc.checkName(fixture(), no), "not-allowed");
	});

	it("keeps three different codes for not allowed, reserved and taken", () => {
		const state = fixture();
		assert.equal(acc.checkName(state, "bad name"), "not-allowed");
		assert.equal(acc.checkName(state, "Admin"), "reserved");
		assert.equal(acc.checkName(state, "LOG-IN"), "reserved");
		for (const name of ["admin", "owner", "root", "api", "login", "setup", "invite", "reset", "account", "accounts", "gateway", "maker", "system", "support", "server", "learnharness"]) {
			assert.equal(acc.checkName(state, name), "reserved", name);
		}
		assert.equal(acc.checkName(state, "SAM"), "taken");
		assert.equal(acc.checkName(state, "boss"), "taken");
	});

	it("keeps a removed or deleting account's name taken until the record is erased", () => {
		const base = fixture();
		const sam = idOf(base, "sam");
		assert.equal(acc.checkName(withState(base, sam, "removed", NOW), "sam"), "taken");
		assert.equal(acc.checkName(withState(base, sam, "deleting"), "SAM"), "taken");
		assert.equal(acc.checkName(acc.eraseAccount(base, sam), "sam"), null);
	});

	it("nameKeyOf lower-cases", () => {
		assert.equal(acc.nameKeyOf("SaM-1"), "sam-1");
	});
});

describe("tags", () => {
	it("recognises the code alphabet", () => {
		for (let i = 0; i < 100; i += 1) assert.ok(acc.isTag(normalizeSetupCode(newSetupCode()).slice(0, 3)));
		for (const no of ["", "AB", "ABCD", "abc", "I00", "L00", "O00", "U00", "A-B", 5, null]) assert.equal(acc.isTag(no), false, String(no));
	});

	it("makes tags that are unique among all records, in any state", () => {
		const accounts: acc.AccountRecord[] = [];
		const seen = new Set<string>();
		for (let i = 0; i < 300; i += 1) {
			const state = { ...acc.emptyGatewayState(), accounts } as acc.GatewayState;
			const tag = acc.newTag(state);
			assert.ok(tag && acc.isTag(tag));
			assert.ok(!seen.has(tag), `repeated ${tag}`);
			seen.add(tag);
			accounts.push(account({ name: `user${i}`, tag, state: (["active", "paused", "removed", "deleting"] as const)[i % 4]! }));
		}
	});

	it("reads the tag from a pairing code: 8 characters is the owner's, 11 end in the tag", () => {
		assert.deepEqual(acc.tagFromPairingCode("ABCD-EFGH"), { ok: true, tag: null });
		assert.deepEqual(acc.tagFromPairingCode("abcd efgh"), { ok: true, tag: null });
		assert.deepEqual(acc.tagFromPairingCode("ABCD-EFGH-7KQ"), { ok: true, tag: "7KQ" });
		assert.deepEqual(acc.tagFromPairingCode("abcdefgh7kq"), { ok: true, tag: "7KQ" });
		for (const no of ["", "ABCD", "ABCD-EFG", "ABCD-EFGH-7K", "ABCD-EFGH-7KQ2", "ABCD-EFGH-IOU", "ABCD-EFGH-7K-Q-X", "-", "x".repeat(65), 7, null, undefined]) {
			assert.deepEqual(acc.tagFromPairingCode(no), { ok: false }, String(no));
		}
	});

	it("reads the tag from a device key: 43 characters is the owner's, 46 start with the tag", () => {
		const body = randomKeyBody();
		assert.equal(body.length, 43);
		assert.deepEqual(acc.tagFromDeviceKey(body), { ok: true, tag: null });
		assert.deepEqual(acc.tagFromDeviceKey(`7KQ${body}`), { ok: true, tag: "7KQ" });
		for (const no of ["", body.slice(1), `${body}x`, `7K${body}`, `7KQ${body}x`, `iii${body}`, `7kq${body}`, `7K?${body.slice(0, 42)}`, `${body.slice(0, 42)} `, 3, null, undefined]) {
			assert.deepEqual(acc.tagFromDeviceKey(no), { ok: false }, String(no));
		}
	});

	it("finds an account by tag; no tag is the owner", () => {
		const state = fixture();
		assert.equal(acc.findAccountByTag(state, "7KQ")?.name, "sam");
		assert.equal(acc.findAccountByTag(state, null)?.name, "Boss");
		assert.equal(acc.findAccountByTag(state, "ZZZ"), null);
	});
});

function randomKeyBody(): string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
	let out = "";
	for (let i = 0; i < 43; i += 1) out += alphabet[(i * 7 + 3) % alphabet.length];
	return out;
}

describe("first start", () => {
	it("issues a setup code, stores only its hash, and claims once", () => {
		const issued = good(acc.issueSetupCode(acc.emptyGatewayState()));
		assert.equal(issued.state.setupCodeHash, setupCodeHash(issued.code));
		assert.ok(!JSON.stringify(issued.state).includes(normalizeSetupCode(issued.code)));
		const state = deepFreeze(issued.state);
		const input = { code: issued.code.toLowerCase(), name: "Boss", password: PASSWORD, upstream: "lh:3000", gateSecret: "s3" };
		const claimed = good(acc.claimOwner(state, input, ADDR, NOW));
		assert.equal(claimed.account.role, "owner");
		assert.equal(claimed.account.tag, null);
		assert.equal(claimed.account.state, "active");
		assert.equal(claimed.account.upstream, "lh:3000");
		assert.equal(claimed.account.gateSecret, "s3");
		assert.equal(claimed.account.nameKey, "boss");
		assert.ok(verifyPassword(PASSWORD, claimed.account.password));
		assert.equal(claimed.state.setupCodeHash, null);
		assert.ok(acc.hasOwner(claimed.state));
		// The owner gets four recovery codes too (found on the real stack): hashes stored, the codes once.
		assert.equal(claimed.codes.length, acc.RECOVERY_CODE_COUNT);
		assert.deepEqual(claimed.account.recoveryCodes, claimed.codes.map((c) => setupCodeHash(c)));
		for (const c of claimed.codes) assert.ok(!JSON.stringify(claimed.state).includes(c));
		refused(acc.claimOwner(deepFreeze(claimed.state), input, ADDR, NOW), "already-set-up");
		refused(acc.issueSetupCode(claimed.state), "owner-exists");
	});

	it("refuses a wrong code (counted), a bad name and a short password without using the code up", () => {
		const issued = good(acc.issueSetupCode(acc.emptyGatewayState()));
		const state = deepFreeze(issued.state);
		const base = { upstream: "lh:3000", gateSecret: "s" };
		const wrong = refused(acc.claimOwner(state, { ...base, code: "AAAA-AAAA", name: "Boss", password: PASSWORD }, ADDR, NOW), "setup-code-invalid");
		assert.equal(wrong.state.lockouts[ADDR]?.failures, 1);
		assert.equal(refused(acc.claimOwner(state, { ...base, code: 5, name: "Boss", password: PASSWORD }, ADDR, NOW), "setup-code-invalid").state.lockouts[ADDR]?.failures, 1);
		refused(acc.claimOwner(state, { ...base, code: issued.code, name: "x", password: PASSWORD }, ADDR, NOW), "not-allowed");
		refused(acc.claimOwner(state, { ...base, code: issued.code, name: "admin", password: PASSWORD }, ADDR, NOW), "reserved");
		const short = refused(acc.claimOwner(state, { ...base, code: issued.code, name: "Boss", password: "short" }, ADDR, NOW), "password-problem");
		assert.equal(short.message, "Use at least 8 characters.");
		assert.equal(short.state, state);
	});

	it("shares the lockout: five wrong setup codes pause the address", () => {
		let state = deepFreeze(good(acc.issueSetupCode(acc.emptyGatewayState())).state);
		const input = { code: "AAAA-AAAA", name: "Boss", password: PASSWORD, upstream: "u", gateSecret: "s" };
		for (let i = 0; i < 4; i += 1) state = deepFreeze(refused(acc.claimOwner(state, input, ADDR, NOW), "setup-code-invalid").state);
		const fifth = refused(acc.claimOwner(state, input, ADDR, NOW), "locked");
		assert.equal(fifth.waitMs, 15 * MIN);
	});
});

describe("the cap and invites", () => {
	it("counts active and paused accounts, the owner included; removed and deleting hold no slot", () => {
		const state = fixture();
		assert.equal(acc.usedSlots(state), 3);
		assert.equal(acc.freeSlots(state, 4), 1);
		assert.equal(acc.usedSlots(withState(state, idOf(state, "sam"), "paused")), 3);
		assert.equal(acc.usedSlots(withState(state, idOf(state, "sam"), "removed", NOW)), 2);
		assert.equal(acc.usedSlots(withState(state, idOf(state, "sam"), "deleting")), 2);
		assert.equal(acc.freeSlots(state, 2), 0);
	});

	it("makes a code that works once for 7 days and keeps only its hash", () => {
		const made = good(acc.createInvite(fixture(), 4, NOW));
		assert.equal(made.invite.expiresAt, NOW + 7 * DAY);
		assert.equal(made.invite.codeHash, setupCodeHash(made.code));
		assert.ok(!JSON.stringify(made.state).includes(normalizeSetupCode(made.code)));
		assert.equal(acc.waitingInvites(made.state, NOW).length, 1);
		assert.equal(acc.waitingInvites(made.state, NOW + 7 * DAY).length, 0);
	});

	it("is refused when waiting invites fill the free slots", () => {
		let state = fixture();
		state = deepFreeze(good(acc.createInvite(state, 4, NOW)).state);
		const second = refused(acc.createInvite(state, 4, NOW), "full");
		assert.equal(second.state, state);
		refused(acc.createInvite(fixture(), 3, NOW), "full");
		state = deepFreeze(good(acc.createInvite(fixture(), 5, NOW)).state);
		good(acc.createInvite(state, 5, NOW));
	});

	it("frees the place of an expired invite and prunes it", () => {
		let state = fixture();
		state = deepFreeze(good(acc.createInvite(state, 4, NOW)).state);
		const later = good(acc.createInvite(state, 4, NOW + 7 * DAY));
		assert.equal(later.state.invites.length, 1);
		assert.equal(acc.pruneExpired(state, NOW), state);
		assert.equal(acc.pruneExpired(state, NOW + 8 * DAY).invites.length, 0);
	});

	it("cancels an invite", () => {
		const made = good(acc.createInvite(fixture(), 4, NOW));
		const state = deepFreeze(made.state);
		assert.equal(good(acc.cancelInvite(state, made.invite.id)).state.invites.length, 0);
		refused(acc.cancelInvite(state, "inv_nope"), "not-found");
	});
});

describe("redeeming an invite", () => {
	const input = (code: string, over: Record<string, unknown> = {}) => ({ code, name: "lee", password: PASSWORD, ...over });

	it("reserves a member in steps: reserve, then finish", () => {
		const made = good(acc.createInvite(fixture(), 4, NOW));
		const state = deepFreeze(made.state);
		const reserved = good(acc.reserveMember(state, input(made.code.toLowerCase()), 4, ADDR, NOW + HOUR));
		assert.equal(reserved.account.role, "member");
		assert.equal(reserved.account.state, "active");
		assert.equal(reserved.account.name, "lee");
		assert.ok(acc.isTag(reserved.account.tag));
		assert.equal(reserved.account.upstream, null);
		assert.equal(reserved.account.gateSecret, null);
		assert.equal(acc.isReady(reserved.account), false);
		assert.ok(verifyPassword(PASSWORD, reserved.account.password));
		assert.equal(reserved.state.invites.length, 0);
		assert.equal(reserved.invite.id, made.invite.id);
		// Four codes in clear, only hashes stored, each different.
		assert.equal(reserved.codes.length, 4);
		assert.equal(new Set(reserved.codes).size, 4);
		assert.deepEqual(reserved.account.recoveryCodes, reserved.codes.map(setupCodeHash));
		assert.ok(!JSON.stringify(reserved.state).includes(normalizeSetupCode(reserved.codes[0]!)));
		assert.equal(acc.unfinishedReservations(reserved.state).length, 1);
		const frozen = deepFreeze(reserved.state);
		const finished = good(acc.finishReservation(frozen, reserved.account.id, { upstream: "lh-acct-x:3000", gateSecret: "g" }));
		assert.equal(finished.account.upstream, "lh-acct-x:3000");
		assert.ok(acc.isReady(finished.account));
		assert.equal(acc.unfinishedReservations(finished.state).length, 0);
		assert.equal(acc.usedSlots(finished.state), 4);
		refused(acc.finishReservation(frozen, "acct_none", { upstream: "x", gateSecret: "y" }), "not-found");
	});

	it("rolls back: the record is gone, its name and tag are free, the invite comes back", () => {
		const made = good(acc.createInvite(fixture(), 4, NOW));
		const reserved = good(acc.reserveMember(deepFreeze(made.state), input(made.code), 4, ADDR, NOW));
		const rolled = acc.rollbackReservation(deepFreeze(reserved.state), reserved.account.id, reserved.invite);
		assert.equal(acc.findAccountByName(rolled, "lee"), null);
		assert.equal(acc.checkName(rolled, "lee"), null);
		assert.equal(rolled.invites.length, 1);
		assert.equal(rolled.invites[0]!.id, made.invite.id);
		// The same code works again; rolling back twice doesn't duplicate.
		good(acc.reserveMember(deepFreeze(rolled), input(made.code), 4, ADDR, NOW));
		assert.equal(acc.rollbackReservation(deepFreeze(rolled), reserved.account.id, reserved.invite).invites.length, 1);
		assert.equal(acc.rollbackReservation(deepFreeze(reserved.state), reserved.account.id).invites.length, 0);
	});

	it("works once", () => {
		const made = good(acc.createInvite(fixture(), 4, NOW));
		const reserved = good(acc.reserveMember(deepFreeze(made.state), input(made.code), 4, ADDR, NOW));
		const after = deepFreeze(reserved.state);
		refused(acc.reserveMember(after, input(made.code, { name: "other" }), 5, ADDR, NOW), "invite-invalid");
	});

	it("runs out after 7 days", () => {
		const made = good(acc.createInvite(fixture(), 4, NOW));
		const state = deepFreeze(made.state);
		good(acc.reserveMember(state, input(made.code), 4, ADDR, NOW + 7 * DAY - 1));
		refused(acc.reserveMember(state, input(made.code), 4, ADDR, NOW + 7 * DAY), "invite-invalid");
	});

	it("counts wrong codes toward the lockout and says nothing else about the name", () => {
		const state = fixture();
		const wrong = refused(acc.reserveMember(state, input("AAAA-AAAA", { name: "sam" }), 4, ADDR, NOW), "invite-invalid");
		assert.equal(wrong.state.lockouts[ADDR]?.failures, 1);
		refused(acc.reserveMember(state, input(5 as never), 4, ADDR, NOW), "invite-invalid");
	});

	it("refuses a name that can't be used, a short password and a full server, keeping the invite", () => {
		const made = good(acc.createInvite(fixture(), 4, NOW));
		const state = deepFreeze(made.state);
		refused(acc.reserveMember(state, input(made.code, { name: "SAM" }), 4, ADDR, NOW), "taken");
		refused(acc.reserveMember(state, input(made.code, { name: "admin" }), 4, ADDR, NOW), "reserved");
		refused(acc.reserveMember(state, input(made.code, { name: "no good" }), 4, ADDR, NOW), "not-allowed");
		const short = refused(acc.reserveMember(state, input(made.code, { password: "abc" }), 4, ADDR, NOW), "password-problem");
		assert.equal(short.message, "Use at least 8 characters.");
		const full = refused(acc.reserveMember(state, input(made.code), 3, ADDR, NOW), "full");
		assert.equal(full.state, state);
		assert.equal(full.state.invites.length, 1);
	});

	// Changed with the review (E): a code success never clears the address's failures; they age out.
	it("a success does not clear the address's code failures", () => {
		const made = good(acc.createInvite(fixture(), 4, NOW));
		const failed = deepFreeze(refused(acc.reserveMember(deepFreeze(made.state), input("AAAA-AAAA"), 4, ADDR, NOW), "invite-invalid").state);
		assert.equal(failed.lockouts[ADDR]?.failures, 1);
		assert.equal(failed.lockouts[ADDR]?.against, "*");
		assert.equal(good(acc.reserveMember(failed, input(made.code), 4, ADDR, NOW)).state.lockouts[ADDR]?.failures, 1);
	});
});

describe("sign-in", () => {
	const SIGN = (name: unknown, password: unknown = PASSWORD) => ({ name, password });

	it("signs in by name without regard to capitals and records the visit", () => {
		const state = fixture();
		const result = good(acc.signIn(state, SIGN("SAM"), "Safari on iPhone", ADDR, NOW));
		assert.equal(result.account.name, "sam");
		assert.equal(result.account.lastSeenAt, NOW);
		assert.equal(result.session.accountId, result.account.id);
		assert.equal(result.session.label, "Safari on iPhone");
		assert.equal(result.session.expiresAt, NOW + 30 * DAY);
		assert.equal(acc.findSession(result.state, result.token, NOW)?.id, result.session.id);
		assert.equal(acc.findAccount(result.state, result.account.id)?.lastSeenAt, NOW);
		assert.ok(!JSON.stringify(result.state).includes(result.token));
	});

	it("answers a wrong name and a wrong password the same way and counts both", () => {
		const state = fixture();
		const wrongName = refused(acc.signIn(state, SIGN("nobody"), "ua", ADDR, NOW), "wrong");
		const wrongPassword = refused(acc.signIn(state, SIGN("sam", "not the password"), "ua", ADDR, NOW), "wrong");
		// The same answer and the same count; only the never-shown `against` differs (review item E).
		const counts = (s: acc.GatewayState) => { const { against: _a, ...rest } = s.lockouts[ADDR]!; return rest; };
		assert.deepEqual(counts(wrongName.state), counts(wrongPassword.state));
		assert.deepEqual({ ...wrongName.state, lockouts: {} }, { ...wrongPassword.state, lockouts: {} });
		assert.equal(wrongName.state.lockouts[ADDR]?.failures, 1);
		assert.equal(wrongName.state.lockouts[ADDR]?.against, "*");
		assert.equal(wrongPassword.state.lockouts[ADDR]?.against, idOf(state, "sam"));
		refused(acc.signIn(state, SIGN(null, null), "ua", ADDR, NOW), "wrong");
		refused(acc.signIn(state, SIGN("sam", 5), "ua", ADDR, NOW), "wrong");
	});

	it("costs a wrong name about as much as a wrong password (one verification each)", () => {
		const state = fixture();
		const time = (name: string): number => {
			const times: number[] = [];
			for (let i = 0; i < 3; i += 1) {
				const start = process.hrtime.bigint();
				acc.signIn(state, SIGN(name, "wrong password"), "ua", `10.0.0.${i}`, NOW);
				times.push(Number(process.hrtime.bigint() - start) / 1e6);
			}
			return times.sort((a, b) => a - b)[1]!;
		};
		const known = time("sam");
		const unknown = time("nobody-here");
		assert.ok(unknown > known * 0.4, `unknown name ${unknown.toFixed(1)} ms against ${known.toFixed(1)} ms`);
	});

	it("tells paused and removed only after a correct password", () => {
		const base = fixture();
		const sam = idOf(base, "sam");
		const paused = withState(base, sam, "paused");
		refused(acc.signIn(paused, SIGN("sam"), "ua", ADDR, NOW), "paused");
		const pausedWrong = refused(acc.signIn(paused, SIGN("sam", "nope nope nope"), "ua", ADDR, NOW), "wrong");
		assert.equal(pausedWrong.state.lockouts[ADDR]?.failures, 1);
		const removed = withState(base, sam, "removed", NOW);
		refused(acc.signIn(removed, SIGN("sam"), "ua", ADDR, NOW), "removed");
		refused(acc.signIn(removed, SIGN("sam", "nope nope nope"), "ua", ADDR, NOW), "wrong");
		// A correct password on a paused account is not a failure and opens no session.
		assert.equal(refused(acc.signIn(paused, SIGN("sam"), "ua", ADDR, NOW), "paused").state, paused);
	});

	it("answers 'wrong' for an account being deleted, even with the right password", () => {
		const deleting = withState(fixture(), idOf(fixture(), "sam"), "deleting");
		refused(acc.signIn(deleting, SIGN("sam"), "ua", ADDR, NOW), "wrong");
	});

	it("shares one lockout across passwords and every kind of code", () => {
		let state = fixture();
		const invite = good(acc.createInvite(state, 4, NOW));
		state = deepFreeze(invite.state);
		const step = (result: { state: acc.GatewayState }) => { state = deepFreeze(result.state); };
		step(refused(acc.signIn(state, SIGN("nobody"), "ua", ADDR, NOW), "wrong"));
		step(refused(acc.signIn(state, SIGN("sam", "bad bad bad"), "ua", ADDR, NOW), "wrong"));
		step(refused(acc.reserveMember(state, { code: "AAAA-AAAA", name: "lee", password: PASSWORD }, 4, ADDR, NOW), "invite-invalid"));
		step(refused(acc.reserveMember(state, { code: "BBBB-BBBB", name: "lee", password: PASSWORD }, 4, ADDR, NOW), "invite-invalid"));
		const tripped = refused(acc.resetPassword(state, { name: "sam", code: "CCCC-CCCC", password: PASSWORD }, ADDR, NOW), "locked");
		assert.equal(tripped.waitMs, 15 * MIN);
		state = deepFreeze(tripped.state);
		// Every kind is now refused without being looked at, even the right one.
		assert.equal(refused(acc.signIn(state, SIGN("sam"), "ua", ADDR, NOW + MIN), "locked").waitMs, 14 * MIN);
		refused(acc.reserveMember(state, { code: invite.code, name: "lee", password: PASSWORD }, 4, ADDR, NOW + MIN), "locked");
		refused(acc.resetPassword(state, { name: "sam", code: RECOVERY[0], password: PASSWORD }, ADDR, NOW + MIN), "locked");
		assert.ok(acc.lockWait(state, ADDR, NOW + MIN) > 0);
		// Another address is untouched, and the pause ends.
		good(acc.signIn(state, SIGN("sam"), "ua", "198.51.100.1", NOW + MIN));
		const open = good(acc.signIn(state, SIGN("sam"), "ua", ADDR, NOW + 15 * MIN));
		// Changed with the review (E): mixed failures are not cleared by a success; the doubling level stays.
		assert.equal(open.state.lockouts[ADDR]?.level, 1);
		assert.equal(acc.lockWait(open.state, ADDR, NOW + 15 * MIN), 0);
	});

	it("review E: four wrong tries against another account, then one's own success, no longer resets the count", () => {
		let state = fixture();
		const kim = idOf(state, "kim");
		for (let round = 0; round < 2; round += 1) {
			for (let i = 0; i < 4 && acc.lockWait(state, ADDR, NOW) === 0; i += 1) {
				const r = acc.signIn(state, SIGN("sam", "guess guess guess"), "ua", ADDR, NOW);
				state = deepFreeze(r.state);
			}
			if (acc.lockWait(state, ADDR, NOW)) break;
			state = deepFreeze(good(acc.signIn({ ...state, accounts: state.accounts }, SIGN("kim", PASSWORD), "ua", ADDR, NOW)).state);
		}
		assert.ok(kim);
		assert.ok(acc.lockWait(state, ADDR, NOW) > 0, "the 5th wrong try locks");
	});

	it("review E: one's own typo, then the right password, clears it; a code failure then a sign-in doesn't", () => {
		const state = fixture();
		const typo = deepFreeze(refused(acc.signIn(state, SIGN("sam", "typo typo typo"), "ua", ADDR, NOW), "wrong").state);
		assert.equal(good(acc.signIn(typo, SIGN("sam"), "ua", ADDR, NOW)).state.lockouts[ADDR], undefined);
		const two = deepFreeze(refused(acc.signIn(typo, SIGN("kim", "typo typo typo"), "ua", ADDR, NOW), "wrong").state);
		assert.equal(two.lockouts[ADDR]?.against, "*", "two accounts: mixed");
		assert.equal(good(acc.signIn(two, SIGN("sam"), "ua", ADDR, NOW)).state.lockouts[ADDR]?.failures, 2);
		const code = deepFreeze(refused(acc.resetPassword(state, { name: "sam", code: "CCCC-CCCC", password: PASSWORD }, ADDR, NOW), "reset-invalid").state);
		assert.equal(good(acc.signIn(code, SIGN("sam"), "ua", ADDR, NOW)).state.lockouts[ADDR]?.failures, 1);
		// Mixed failures age out by the existing rule.
		assert.equal(acc.lockWait(two, ADDR, NOW + DAY), 0);
		const later = refused(acc.signIn(two, SIGN("sam", "typo typo typo"), "ua", ADDR, NOW + DAY), "wrong").state;
		assert.equal(later.lockouts[ADDR]?.failures, 1);
		assert.equal(later.lockouts[ADDR]?.against, idOf(state, "sam"));
	});

	it("review I: IPv6 addresses share a lockout by /64; IPv4-mapped is the IPv4 address", () => {
		assert.equal(acc.lockoutKey("2001:db8:1:2:3:4:5:6"), "2001:db8:1:2::/64");
		assert.equal(acc.lockoutKey("2001:0db8:0001:0002::9"), "2001:db8:1:2::/64");
		assert.equal(acc.lockoutKey("2001:db8::1"), "2001:db8:0:0::/64");
		assert.equal(acc.lockoutKey("::1"), "0:0:0:0::/64");
		assert.equal(acc.lockoutKey("::ffff:203.0.113.7"), "203.0.113.7");
		assert.equal(acc.lockoutKey("0:0:0:0:0:ffff:203.0.113.7"), "203.0.113.7");
		assert.equal(acc.lockoutKey("203.0.113.7"), "203.0.113.7");
		assert.equal(acc.lockoutKey("unknown"), "unknown");
		let state = fixture();
		for (let i = 0; i < 5; i += 1) state = deepFreeze(acc.signIn(state, SIGN("nobody"), "ua", `2001:db8:1:2::${i + 1}`, NOW).state);
		assert.ok(acc.lockWait(state, "2001:db8:1:2:ffff::1", NOW) > 0);
		assert.equal(acc.lockWait(state, "2001:db8:1:3::1", NOW), 0);
		assert.equal(acc.lockWait(state, "::ffff:203.0.113.7", NOW), 0);
	});

	it("review I: at most MAX_LOCKOUT_ENTRIES addresses are remembered; only one it needn't keep makes room", () => {
		assert.equal(acc.MAX_LOCKOUT_ENTRIES, 5000);
		const many: Record<string, acc.GatewayLockout> = {};
		// One stale entry (a day old, not locked) that the prune drops; the rest recent.
		for (let i = 0; i < acc.MAX_LOCKOUT_ENTRIES; i += 1) many[`10.${i >> 16 & 255}.${i >> 8 & 255}.${i & 255}`] = { failures: 1, level: 0, lockedUntil: 0, lastFailureAt: i === 0 ? NOW - DAY : NOW - DAY / 2 + i, against: "*" };
		const full = { ...fixture(), lockouts: many };
		const next = acc.recordWrongAttempt(full, ADDR, NOW).state;
		assert.equal(Object.keys(next.lockouts).length, acc.MAX_LOCKOUT_ENTRIES);
		assert.ok(next.lockouts[ADDR]);
		assert.equal(next.lockouts["10.0.0.0"], undefined, "the stale one went");
		assert.ok(next.lockouts["10.0.0.1"]);
		assert.equal(next.lockoutPauseUntil, undefined, "no pause: there was room");
	});

	it("doubles the pause each time", () => {
		let state = fixture();
		for (let i = 0; i < 5; i += 1) state = deepFreeze(acc.signIn(state, SIGN("nobody"), "ua", ADDR, NOW).state);
		assert.equal(acc.lockWait(state, ADDR, NOW), 15 * MIN);
		const later = NOW + 15 * MIN;
		for (let i = 0; i < 5; i += 1) state = deepFreeze(acc.signIn(state, SIGN("nobody"), "ua", ADDR, later).state);
		assert.equal(acc.lockWait(state, ADDR, later), 30 * MIN);
	});
});

describe("sessions", () => {
	const sam = (state = fixture()) => idOf(state, "sam");

	it("lasts 30 days from the last use and never past 180 days from the sign-in", () => {
		const state0 = fixture();
		const made = acc.createAccountSession(state0, sam(state0), "Chrome on Windows", NOW);
		let state = deepFreeze(made.state);
		assert.ok(acc.findSession(state, made.token, NOW + 30 * DAY - 1));
		assert.equal(acc.findSession(state, made.token, NOW + 30 * DAY), null);
		// Used every 20 days: still valid long past 30 days, but ends at day 180.
		let last = NOW;
		for (let day = 20; day <= 160; day += 20) {
			last = NOW + day * DAY;
			const touched = acc.touchSession(state, made.session.id, last);
			assert.ok(touched, `day ${day}`);
			state = deepFreeze(touched);
			assert.ok(acc.findSession(state, made.token, last));
		}
		assert.equal(acc.findSession(state, made.token, NOW + 180 * DAY - 1)?.id, made.session.id);
		const extra = acc.touchSession(state, made.session.id, NOW + 175 * DAY);
		assert.ok(extra);
		const capped = extra.sessions.find((s) => s.id === made.session.id)!;
		assert.equal(capped.expiresAt, NOW + 180 * DAY);
		assert.equal(acc.findSession(deepFreeze(extra), made.token, NOW + 180 * DAY), null);
		assert.equal(acc.sessionExpiry(NOW, NOW + 100 * DAY), NOW + 130 * DAY);
		assert.equal(acc.sessionExpiry(NOW, NOW + 170 * DAY), NOW + 180 * DAY);
	});

	it("touches at most every five minutes and stamps the account too", () => {
		const state0 = fixture();
		const made = acc.createAccountSession(state0, sam(state0), "x", NOW);
		const state = deepFreeze(made.state);
		assert.equal(acc.touchSession(state, made.session.id, NOW + 5 * MIN - 1), null);
		assert.equal(acc.touchSession(state, "nope", NOW + DAY), null);
		const touched = acc.touchSession(state, made.session.id, NOW + 5 * MIN)!;
		const session = touched.sessions[0]!;
		assert.equal(session.lastSeenAt, NOW + 5 * MIN);
		assert.equal(session.expiresAt, NOW + 5 * MIN + 30 * DAY);
		assert.equal(acc.findAccount(touched, sam(state))?.lastSeenAt, NOW + 5 * MIN);
		assert.equal(acc.findAccount(touched, idOf(state, "kim"))?.lastSeenAt, null);
	});

	it("resolves only a live session of an active account", () => {
		const state0 = fixture();
		const made = acc.createAccountSession(state0, sam(state0), "x", NOW);
		const state = deepFreeze(made.state);
		assert.equal(acc.resolveSession(state, made.token, NOW)?.account.name, "sam");
		assert.equal(acc.resolveSession(state, "wrong", NOW), null);
		assert.equal(acc.resolveSession(state, null, NOW), null);
		assert.equal(acc.resolveSession(state, "x".repeat(300), NOW), null);
		for (const status of ["paused", "removed", "deleting"] as const) assert.equal(acc.resolveSession(withState(state, sam(state), status, NOW), made.token, NOW), null, status);
		assert.equal(acc.resolveSession(acc.eraseAccount(state, sam(state)), made.token, NOW), null);
	});

	it("removes one session, all of an account's, or all but one", () => {
		let state = fixture();
		const ids: Record<string, string[]> = { sam: [], kim: [] };
		const tokens: string[] = [];
		for (const name of ["sam", "sam", "sam", "kim"]) {
			const made = acc.createAccountSession(state, idOf(state, name), name, NOW);
			state = deepFreeze(made.state);
			ids[name]!.push(made.session.id);
			tokens.push(made.token);
		}
		assert.equal(acc.removeSession(state, ids.sam![0]!).sessions.length, 3);
		const allSam = acc.removeAccountSessions(state, sam(state));
		assert.deepEqual(allSam.sessions.map((s) => s.id), ids.kim);
		const others = acc.removeOtherAccountSessions(state, sam(state), ids.sam![1]!);
		assert.deepEqual(others.sessions.map((s) => s.id).sort(), [ids.sam![1]!, ids.kim![0]!].sort());
		assert.equal(acc.removeOtherAccountSessions(state, sam(state), null).sessions.length, 1);
		// A session id of another account is not kept by naming it.
		assert.equal(acc.removeOtherAccountSessions(state, sam(state), ids.kim![0]!).sessions.length, 1);
	});

	it("lists an account's live sessions in today's shape, newest use first", () => {
		let state = fixture();
		const a = acc.createAccountSession(state, sam(state), "Safari on iPhone", NOW);
		const b = acc.createAccountSession(a.state, sam(state), "Chrome on Windows", NOW + HOUR);
		const c = acc.createAccountSession(b.state, idOf(state, "kim"), "Kim's", NOW);
		state = deepFreeze(c.state);
		const list = acc.sessionList(state, sam(state), a.session.id, NOW + 2 * HOUR);
		assert.deepEqual(list.map((s) => s.label), ["Chrome on Windows", "Safari on iPhone"]);
		assert.deepEqual(Object.keys(list[0]!).sort(), ["createdAt", "current", "expiresAt", "id", "label", "lastSeenAt"]);
		assert.deepEqual(list.map((s) => s.current), [false, true]);
		assert.equal(acc.sessionList(state, sam(state), null, NOW + 31 * DAY).length, 0);
	});

	it("says 'signed in now' for a live session used within 10 minutes", () => {
		const state0 = fixture();
		const made = acc.createAccountSession(state0, sam(state0), "x", NOW);
		const state = deepFreeze(made.state);
		assert.equal(acc.signedInNow(state, sam(state), NOW + 10 * MIN), true);
		assert.equal(acc.signedInNow(state, sam(state), NOW + 10 * MIN + 1), false);
		assert.equal(acc.signedInNow(state, idOf(state, "kim"), NOW), false);
		assert.equal(acc.SIGNED_IN_NOW_MS, 10 * MIN);
	});

	it("keeps an account to 50 sessions and drops expired ones", () => {
		let state = fixture();
		const first = acc.createAccountSession(state, sam(state), "first", NOW);
		state = deepFreeze(first.state);
		for (let i = 0; i < 55; i += 1) state = deepFreeze(acc.createAccountSession(state, sam(state), `s${i}`, NOW + i + 1).state);
		assert.equal(state.sessions.length, 50);
		assert.equal(acc.findSession(state, first.token, NOW + 100), null);
		const later = acc.createAccountSession(state, idOf(state, "kim"), "k", NOW + 31 * DAY).state;
		assert.equal(later.sessions.length, 1);
	});
});

describe("password and recovery codes", () => {
	it("changes the password with the current one and ends the other sessions", () => {
		let state = fixture();
		const one = acc.createAccountSession(state, idOf(state, "sam"), "one", NOW);
		const two = acc.createAccountSession(one.state, idOf(state, "sam"), "two", NOW);
		const other = acc.createAccountSession(two.state, idOf(state, "kim"), "kim", NOW);
		state = deepFreeze(other.state);
		const changed = good(acc.changePassword(state, idOf(state, "sam"), one.session.id, { current: PASSWORD, next: "a new password" }, ADDR, NOW));
		assert.deepEqual(changed.state.sessions.map((s) => s.id).sort(), [one.session.id, other.session.id].sort());
		assert.ok(verifyPassword("a new password", acc.findAccountByName(changed.state, "sam")!.password));
		assert.equal(verifyPassword(PASSWORD, acc.findAccountByName(changed.state, "sam")!.password), false);
		assert.equal(acc.findAccountByName(changed.state, "kim")!.password, PW);
	});

	it("refuses a wrong current password (counted) and a password that is too short", () => {
		const state = fixture();
		const sam = idOf(state, "sam");
		const wrong = refused(acc.changePassword(state, sam, null, { current: "nope nope nope", next: "a new password" }, ADDR, NOW), "wrong-password");
		assert.equal(wrong.state.lockouts[ADDR]?.failures, 1);
		const short = refused(acc.changePassword(state, sam, null, { current: PASSWORD, next: "short" }, ADDR, NOW), "password-problem");
		assert.equal(short.message, "Use at least 8 characters.");
		assert.equal(short.state, state);
		refused(acc.changePassword(state, "acct_none", null, { current: PASSWORD, next: "a new password" }, ADDR, NOW), "not-found");
		refused(acc.changePassword(withState(state, sam, "removed", NOW), sam, null, { current: PASSWORD, next: "a new password" }, ADDR, NOW), "not-found");
	});

	it("signs out everywhere, the current device too", () => {
		let state = fixture();
		const one = acc.createAccountSession(state, idOf(state, "sam"), "one", NOW);
		const two = acc.createAccountSession(one.state, idOf(state, "kim"), "kim", NOW);
		state = deepFreeze(two.state);
		const result = acc.signOutEverywhere(state, idOf(state, "sam"));
		assert.deepEqual(result.sessions.map((s) => s.id), [two.session.id]);
	});

	it("keeps four recovery codes, each working once, and counts what is left", () => {
		const state = fixture();
		const sam = acc.findAccountByName(state, "sam")!;
		assert.equal(acc.recoveryCodesLeft(sam), 4);
		let current = state;
		for (let i = 0; i < 4; i += 1) {
			const result = good(acc.resetPassword(current, { name: "sam", code: RECOVERY[i]!.toLowerCase(), password: "brand new password" }, ADDR, NOW));
			current = deepFreeze(result.state);
			assert.equal(acc.recoveryCodesLeft(acc.findAccountByName(current, "sam")!), 3 - i);
			// The used one never works again.
			refused(acc.resetPassword(current, { name: "sam", code: RECOVERY[i]!, password: "brand new password" }, ADDR, NOW), "reset-invalid");
		}
	});

	it("replaces all codes with the password, returning four new ones once", () => {
		const state = fixture();
		const sam = idOf(state, "sam");
		const wrong = refused(acc.replaceRecoveryCodes(state, sam, "nope nope nope", ADDR, NOW), "wrong-password");
		assert.equal(wrong.state.lockouts[ADDR]?.failures, 1);
		const made = good(acc.replaceRecoveryCodes(state, sam, PASSWORD, ADDR, NOW));
		assert.equal(made.codes.length, 4);
		assert.equal(new Set(made.codes).size, 4);
		assert.deepEqual(acc.findAccount(made.state, sam)!.recoveryCodes, made.codes.map(setupCodeHash));
		const after = deepFreeze(made.state);
		refused(acc.resetPassword(after, { name: "sam", code: RECOVERY[0], password: "brand new password" }, ADDR, NOW), "reset-invalid");
		good(acc.resetPassword(after, { name: "sam", code: made.codes[2], password: "brand new password" }, ADDR, NOW));
		refused(acc.replaceRecoveryCodes(state, "acct_none", PASSWORD, ADDR, NOW), "not-found");
	});
});

describe("reset", () => {
	it("gives the owner a code that works once, for 24 hours, and replaces an older one", () => {
		const state = fixture();
		const kim = idOf(state, "kim");
		const first = good(acc.issueResetCode(state, kim, NOW));
		assert.equal(first.expiresAt, NOW + 24 * HOUR);
		assert.equal(first.state.resets[0]!.codeHash, setupCodeHash(first.code));
		const second = good(acc.issueResetCode(deepFreeze(first.state), kim, NOW + HOUR));
		assert.equal(second.state.resets.length, 1);
		const frozen = deepFreeze(second.state);
		refused(acc.resetPassword(frozen, { name: "kim", code: first.code, password: "brand new password" }, ADDR, NOW + 2 * HOUR), "reset-invalid");
		good(acc.resetPassword(frozen, { name: "kim", code: second.code, password: "brand new password" }, "198.51.100.9", NOW + 2 * HOUR));
	});

	it("works once and is used up with any other reset code", () => {
		const state = fixture();
		const kim = idOf(state, "kim");
		const made = good(acc.issueResetCode(state, kim, NOW));
		const used = good(acc.resetPassword(deepFreeze(made.state), { name: "KIM", code: made.code.toLowerCase(), password: "brand new password" }, ADDR, NOW + HOUR));
		assert.equal(used.state.resets.length, 0);
		assert.equal(used.account.id, kim);
		assert.ok(verifyPassword("brand new password", acc.findAccount(used.state, kim)!.password));
		refused(acc.resetPassword(deepFreeze(used.state), { name: "kim", code: made.code, password: "another new password" }, ADDR, NOW + HOUR), "reset-invalid");
	});

	it("runs out after 24 hours", () => {
		const made = good(acc.issueResetCode(fixture(), idOf(fixture(), "kim"), NOW));
		const state = deepFreeze(made.state);
		good(acc.resetPassword(state, { name: "kim", code: made.code, password: "brand new password" }, ADDR, NOW + 24 * HOUR - 1));
		refused(acc.resetPassword(state, { name: "kim", code: made.code, password: "brand new password" }, ADDR, NOW + 24 * HOUR), "reset-invalid");
		assert.equal(acc.pruneExpired(state, NOW + 25 * HOUR).resets.length, 0);
	});

	it("is for a member only: not the owner, not a removed or deleting account", () => {
		const state = fixture();
		refused(acc.issueResetCode(state, idOf(state, "Boss"), NOW), "is-owner");
		refused(acc.issueResetCode(state, "acct_none", NOW), "not-found");
		refused(acc.issueResetCode(withState(state, idOf(state, "kim"), "removed", NOW), idOf(state, "kim"), NOW), "bad-state");
		refused(acc.issueResetCode(withState(state, idOf(state, "kim"), "deleting"), idOf(state, "kim"), NOW), "bad-state");
		good(acc.issueResetCode(withState(state, idOf(state, "kim"), "paused"), idOf(state, "kim"), NOW));
	});

	it("ends every session of the account and says whose account it was", () => {
		let state = fixture();
		const a = acc.createAccountSession(state, idOf(state, "sam"), "a", NOW);
		const b = acc.createAccountSession(a.state, idOf(state, "sam"), "b", NOW);
		const c = acc.createAccountSession(b.state, idOf(state, "kim"), "c", NOW);
		state = deepFreeze(c.state);
		const result = good(acc.resetPassword(state, { name: "sam", code: RECOVERY[1], password: "brand new password" }, ADDR, NOW));
		assert.equal(result.account.name, "sam");
		assert.equal(result.account.tag, "7KQ");
		assert.deepEqual(result.state.sessions.map((s) => s.id), [c.session.id]);
	});

	it("answers a wrong name and a wrong code the same, counted by the one lockout", () => {
		const state = fixture();
		const base = { password: "brand new password" };
		const a = refused(acc.resetPassword(state, { ...base, name: "nobody", code: RECOVERY[0] }, ADDR, NOW), "reset-invalid");
		const b = refused(acc.resetPassword(state, { ...base, name: "sam", code: "ZZZZ-ZZZZ" }, ADDR, NOW), "reset-invalid");
		const c = refused(acc.resetPassword(state, { ...base, name: "kim", code: RECOVERY[0] }, ADDR, NOW), "reset-invalid");
		// The address's lockout counts all three the same; a named account also counts it against itself (review finding 3c).
		assert.deepEqual(a.state.lockouts, b.state.lockouts);
		assert.deepEqual(a.state.lockouts, c.state.lockouts);
		assert.equal(a.state.lockouts[ADDR]?.failures, 1);
		assert.deepEqual(a.state.accounts, state.accounts);
		assert.deepEqual(acc.findAccountByName(b.state, "sam")!.codeFailures, { count: 1, since: NOW });
		refused(acc.resetPassword(state, { ...base, name: 5, code: 5 }, ADDR, NOW), "reset-invalid");
	});

	it("checks the new password before using the code up or counting a failure", () => {
		const state = fixture();
		const short = refused(acc.resetPassword(state, { name: "sam", code: RECOVERY[0], password: "short" }, ADDR, NOW), "password-problem");
		assert.equal(short.message, "Use at least 8 characters.");
		assert.equal(short.state, state);
		// Same answer whether or not the name and code were right.
		refused(acc.resetPassword(state, { name: "nobody", code: "x", password: "short" }, ADDR, NOW), "password-problem");
	});

	it("a paused account is reset and stays paused; a removed or deleting one is not", () => {
		const base = fixture();
		const sam = idOf(base, "sam");
		const result = good(acc.resetPassword(withState(base, sam, "paused"), { name: "sam", code: RECOVERY[0], password: "brand new password" }, ADDR, NOW));
		assert.equal(acc.findAccount(result.state, sam)!.state, "paused");
		refused(acc.resetPassword(withState(base, sam, "removed", NOW), { name: "sam", code: RECOVERY[0], password: "brand new password" }, ADDR, NOW), "reset-invalid");
		refused(acc.resetPassword(withState(base, sam, "deleting"), { name: "sam", code: RECOVERY[0], password: "brand new password" }, ADDR, NOW), "reset-invalid");
	});

	it("a recovery code does not open another account, and a reset code only its own", () => {
		const state = fixture();
		const made = good(acc.issueResetCode(state, idOf(state, "kim"), NOW));
		refused(acc.resetPassword(deepFreeze(made.state), { name: "sam", code: made.code, password: "brand new password" }, ADDR, NOW), "reset-invalid");
	});
});

describe("the owner's actions on a member", () => {
	it("pauses (sessions end, the slot stays) and resumes", () => {
		let state = fixture();
		const made = acc.createAccountSession(state, idOf(state, "sam"), "x", NOW);
		state = deepFreeze(made.state);
		const paused = good(acc.pauseAccount(state, idOf(state, "sam")));
		assert.equal(paused.account.state, "paused");
		assert.equal(paused.state.sessions.length, 0);
		assert.equal(acc.usedSlots(paused.state), 3);
		refused(acc.pauseAccount(deepFreeze(paused.state), idOf(state, "sam")), "bad-state");
		const resumed = good(acc.resumeAccount(deepFreeze(paused.state), idOf(state, "sam")));
		assert.equal(resumed.account.state, "active");
		refused(acc.resumeAccount(deepFreeze(resumed.state), idOf(state, "sam")), "bad-state");
	});

	it("removes: slot free at once, sessions and reset codes gone, name still taken", () => {
		let state = fixture();
		const made = acc.createAccountSession(state, idOf(state, "kim"), "x", NOW);
		state = deepFreeze(good(acc.issueResetCode(made.state, idOf(state, "kim"), NOW)).state);
		const removed = good(acc.removeAccount(state, idOf(state, "kim"), NOW));
		assert.equal(removed.account.state, "removed");
		assert.equal(removed.account.removedAt, NOW);
		assert.equal(removed.state.sessions.length, 0);
		assert.equal(removed.state.resets.length, 0);
		assert.equal(acc.usedSlots(removed.state), 2);
		assert.equal(acc.checkName(removed.state, "kim"), "taken");
		refused(acc.removeAccount(deepFreeze(removed.state), idOf(state, "kim"), NOW), "bad-state");
		good(acc.removeAccount(withState(state, idOf(state, "kim"), "paused"), idOf(state, "kim"), NOW));
	});

	it("never pauses, removes or deletes the owner", () => {
		const state = fixture();
		const boss = idOf(state, "Boss");
		refused(acc.pauseAccount(state, boss), "is-owner");
		refused(acc.resumeAccount(state, boss), "is-owner");
		refused(acc.removeAccount(state, boss, NOW), "is-owner");
		refused(acc.restoreAccount(state, boss, 4), "is-owner");
		refused(acc.deleteNow(state, boss), "is-owner");
		refused(acc.deleteDue(state, boss, NOW), "is-owner");
		refused(acc.selfDelete(state, boss, PASSWORD, ADDR, NOW), "is-owner");
		refused(acc.pauseAccount(state, "acct_none"), "not-found");
	});

	it("restores only when a slot is free", () => {
		const base = fixture();
		const kim = idOf(base, "kim");
		const removed = withState(base, kim, "removed", NOW);
		const full = refused(acc.restoreAccount(removed, kim, 2), "full");
		assert.equal(full.state, removed);
		const restored = good(acc.restoreAccount(removed, kim, 3));
		assert.equal(restored.account.state, "active");
		assert.equal(restored.account.removedAt, null);
		refused(acc.restoreAccount(base, kim, 9), "bad-state");
	});

	it("lists removed accounts due after 30 days", () => {
		const base = fixture();
		const kim = idOf(base, "kim");
		const state = withState(base, kim, "removed", NOW);
		assert.equal(acc.dueForDeletion(state, NOW + 30 * DAY - 1).length, 0);
		assert.deepEqual(acc.dueForDeletion(state, NOW + 30 * DAY).map((a) => a.name), ["kim"]);
		assert.equal(acc.dueForDeletion(withState(base, kim, "paused"), NOW + 90 * DAY).length, 0);
		refused(acc.deleteDue(state, kim, NOW + 30 * DAY - 1), "bad-state");
		const marked = good(acc.deleteDue(state, kim, NOW + 30 * DAY));
		assert.equal(marked.account.state, "deleting");
	});

	it("deletes now: a removed account only, in two steps so a failure can be retried", () => {
		const base = fixture();
		const kim = idOf(base, "kim");
		refused(acc.deleteNow(base, kim), "bad-state");
		const removed = withState(base, kim, "removed", NOW);
		const marked = good(acc.deleteNow(removed, kim));
		assert.equal(marked.account.state, "deleting");
		assert.equal(acc.usedSlots(marked.state), 2);
		assert.equal(acc.checkName(marked.state, "kim"), "taken");
		assert.deepEqual(acc.pendingDeletions(marked.state).map((a) => a.name), ["kim"]);
		// A second call is allowed (retry) and changes nothing.
		const again = good(acc.deleteNow(deepFreeze(marked.state), kim));
		assert.equal(again.state, marked.state);
		const erased = acc.eraseAccount(deepFreeze(marked.state), kim);
		assert.equal(acc.findAccount(erased, kim), null);
		assert.equal(acc.checkName(erased, "kim"), null);
		assert.equal(acc.pendingDeletions(erased).length, 0);
	});

	it("self-delete needs the password, signs the account out, and keeps name and tag until erased", () => {
		let state = fixture();
		const made = acc.createAccountSession(state, idOf(state, "sam"), "x", NOW);
		state = deepFreeze(made.state);
		const sam = idOf(state, "sam");
		const wrong = refused(acc.selfDelete(state, sam, "nope nope nope", ADDR, NOW), "wrong-password");
		assert.equal(wrong.state.lockouts[ADDR]?.failures, 1);
		const marked = good(acc.selfDelete(state, sam, PASSWORD, ADDR, NOW));
		assert.equal(marked.account.state, "deleting");
		assert.equal(marked.state.sessions.length, 0);
		assert.equal(acc.usedSlots(marked.state), 2);
		assert.equal(acc.checkName(marked.state, "sam"), "taken");
		assert.equal(acc.findAccount(marked.state, sam)!.tag, "7KQ");
		refused(acc.signIn(deepFreeze(marked.state), { name: "sam", password: PASSWORD }, "ua", ADDR, NOW), "wrong");
		// A retry of a half-finished deletion works with the password too.
		good(acc.selfDelete(deepFreeze(marked.state), sam, PASSWORD, ADDR, NOW));
		const erased = acc.eraseAccount(deepFreeze(marked.state), sam);
		assert.equal(acc.findAccountByTag(erased, "7KQ"), null);
	});

	it("eraseAccount removes the record, its sessions and its reset codes only", () => {
		let state = fixture();
		const a = acc.createAccountSession(state, idOf(state, "sam"), "a", NOW);
		const b = acc.createAccountSession(a.state, idOf(state, "kim"), "b", NOW);
		state = deepFreeze(good(acc.issueResetCode(b.state, idOf(state, "sam"), NOW)).state);
		const erased = acc.eraseAccount(state, idOf(state, "sam"));
		assert.deepEqual(erased.accounts.map((x) => x.name), ["Boss", "kim"]);
		assert.deepEqual(erased.sessions.map((s) => s.id), [b.session.id]);
		assert.equal(erased.resets.length, 0);
	});
});

describe("views", () => {
	it("gives the owner's screen accounts, waiting invites without codes, and removed accounts", () => {
		let state = fixture();
		const made = acc.createAccountSession(state, idOf(state, "sam"), "x", NOW);
		const invite = good(acc.createInvite(made.state, 5, NOW));
		state = deepFreeze(invite.state);
		state = withState(state, idOf(state, "kim"), "removed", NOW - DAY);
		const touched = acc.touchSession(state, made.session.id, NOW + 6 * MIN)!;
		const stamped = deepFreeze(touched);
		const view = acc.accountsView(stamped, 5, NOW + 7 * MIN);
		assert.deepEqual(view.accounts.map((a) => [a.name, a.role, a.state, a.signedInNow]), [["Boss", "owner", "active", false], ["sam", "member", "active", true]]);
		assert.equal(view.accounts[1]!.lastSeenAt, NOW + 6 * MIN);
		assert.deepEqual(view.invites, [{ id: invite.invite.id, expiresAt: NOW + 7 * DAY }]);
		assert.deepEqual(view.removed, [{ id: idOf(stamped, "kim"), name: "kim", removedAt: NOW - DAY, deletedAt: NOW + 29 * DAY }]);
		assert.equal(view.used, 2);
		assert.equal(view.cap, 5);
		assert.ok(!JSON.stringify(view).includes(invite.code));
		assert.ok(!JSON.stringify(view).includes("password"));
		assert.ok(!JSON.stringify(view).includes("gateSecret"));
		assert.equal(acc.accountsView(stamped, 5, NOW + 8 * DAY).invites.length, 0);
	});

	it("lists a paused account and leaves out one being deleted", () => {
		const base = fixture();
		const paused = withState(base, idOf(base, "sam"), "paused");
		assert.equal(acc.accountsView(paused, 4, NOW).accounts.find((a) => a.name === "sam")!.state, "paused");
		const deleting = withState(base, idOf(base, "kim"), "deleting");
		assert.deepEqual(acc.accountsView(deleting, 4, NOW).accounts.map((a) => a.name), ["Boss", "sam"]);
		assert.equal(acc.accountsView(deleting, 4, NOW).removed.length, 0);
	});

	it("gives a person's own screen: name, owner flag, codes left, devices", () => {
		let state = fixture();
		const made = acc.createAccountSession(state, idOf(state, "sam"), "Safari on iPhone", NOW);
		state = deepFreeze(made.state);
		const view = acc.accountView(state, idOf(state, "sam"), made.session.id, NOW)!;
		assert.equal(view.name, "sam");
		assert.equal(view.owner, false);
		assert.equal(view.recoveryCodesLeft, 4);
		assert.deepEqual(view.devices.map((d) => [d.label, d.current]), [["Safari on iPhone", true]]);
		assert.equal(acc.accountView(state, idOf(state, "Boss"), null, NOW)!.owner, true);
		assert.equal(acc.accountView(state, "acct_none", null, NOW), null);
	});
});

describe("the approved words", () => {
	it("holds the sign-in, first-start, invite, recovery and reset pages", () => {
		assert.equal(words.SIGN_IN_TEXT.wrong, "That name or password isn't right.");
		assert.equal(words.SIGN_IN_TEXT.paused, "This account is paused. Ask this server's owner.");
		assert.equal(words.SIGN_IN_TEXT.removed, "This account was removed. Ask this server's owner.");
		assert.equal(words.SIGN_IN_TEXT.inviteLink, "Have an invite code?");
		assert.equal(words.SIGN_IN_TEXT.forgotLink, "Forgot your password?");
		assert.equal(words.tooManyAttempts(15 * MIN), "Too many attempts. Try again in 15 min.");
		assert.equal(words.SETUP_TEXT.title, "Set up LearnHarness");
		assert.equal(words.SETUP_TEXT.intro, "Enter the setup code from the server log, then choose a name and a password of at least 8 characters.");
		assert.equal(words.SETUP_TEXT.wrongCode, "That setup code isn't right. Check the server log for the current code.");
		assert.equal(words.SETUP_TEXT.nameNotAllowed, "Use 3 to 20 letters, digits or dashes.");
		assert.equal(words.INVITE_TEXT.title, "Create your account");
		assert.equal(words.INVITE_TEXT.invalid, "That invite code isn't right, or it has run out.");
		assert.equal(words.INVITE_TEXT.taken, "That name is taken. Choose another.");
		assert.equal(words.INVITE_TEXT.full, "This server is full. Ask its owner.");
		assert.equal(words.INVITE_TEXT.reserved, "That name can't be used. Choose another.");
		assert.equal(words.INVITE_TEXT.passwordHelp, "At least 8 characters.");
		assert.equal(words.RECOVERY_PAGE_TEXT.body, "If you forget your password, any one of these lets you choose a new one. Each works once. They won't be shown again.");
		assert.equal(words.RESET_PAGE_TEXT.intro, "Enter one of your recovery codes, or a reset code from this server's owner.");
		assert.equal(words.RESET_PAGE_TEXT.invalid, "That name or code isn't right, or the code has been used or has run out.");
		assert.equal(words.RESET_PAGE_TEXT.submit, "Set new password");
	});

	it("is browser-safe: imports nothing (no node built-in, not ./server-auth or ./accounts)", () => {
		const source = fs.readFileSync(new URL("../src/core/account-screens.ts", import.meta.url), "utf-8");
		assert.doesNotMatch(source, /\bfrom\s+["']node:/);
		assert.doesNotMatch(source, /\bimport\s*\(?\s*["']node:/);
		assert.doesNotMatch(source, /["']\.\/(server-auth|accounts)(\.ts)?["']/);
		assert.doesNotMatch(source, /^\s*import\s/m);
		assert.doesNotMatch(source, /\brequire\s*\(/);
	});

	it("its copies of the password rule and the wait text equal the originals", () => {
		assert.equal(words.USE_AT_LEAST, `Use at least ${PASSWORD_MIN_LENGTH} characters.`);
		assert.equal(words.INVITE_TEXT.passwordHelp, `At least ${PASSWORD_MIN_LENGTH} characters.`);
		const SEC = 1000;
		const durations = [0, 1, SEC, 30 * SEC, 59 * SEC, MIN, MIN + 1, 2 * MIN, 14 * MIN, 15 * MIN, 15 * MIN + 1, 59 * MIN, 59 * MIN + 1, HOUR - 1,
			HOUR, HOUR + 1, HOUR + MIN, 90 * MIN, 2 * HOUR, 2 * HOUR + 59 * MIN, 23 * HOUR + 59 * MIN, 24 * HOUR - 1, 24 * HOUR, 24 * HOUR + 1, 48 * HOUR, -5];
		for (const ms of durations) {
			assert.equal(words.waitText(ms), formatWait(ms), String(ms));
			assert.equal(words.tooManyAttempts(ms), `Too many attempts. Try again in ${formatWait(ms)}.`, String(ms));
		}
		assert.equal(words.waitText(15 * MIN), "15 min");
		assert.equal(words.waitText(24 * HOUR), "24 h");
	});

	it("reuses today's two password sentences", () => {
		assert.equal(words.PASSWORDS_DONT_MATCH, "The two passwords don't match.");
		assert.equal(words.USE_AT_LEAST, passwordProblem("short"));
	});

	it("words the owner's screen with curly quotes", () => {
		assert.equal(words.resetConfirm("sam").title, "Reset “sam”’s password?");
		assert.equal(words.resetConfirm("sam").body, "You get a code to pass on. It works once, for 24 hours. When it is used, sam is signed out everywhere and pairs their desktop apps again.");
		assert.equal(words.resetConfirm("sam").confirm, "Get reset code");
		assert.deepEqual(words.pauseConfirm("sam"), { title: "Pause “sam”?", body: "sam can't sign in and their copy stops. Nothing is deleted.", cancel: "Cancel", confirm: "Pause" });
		assert.deepEqual(words.removeAccountConfirm("sam"), { title: "Remove “sam”?", body: "The account stops now. Its data is kept for 30 days, then deleted for good.", cancel: "Cancel", confirm: "Remove" });
		assert.deepEqual(words.deleteNowConfirm("lee"), { title: "Delete “lee” now?", body: "This deletes the account's data for good.", cancel: "Cancel", confirm: "Delete" });
		assert.equal(words.resetCodeBox("sam").title, "Reset code for “sam”");
		assert.equal(words.resetCodeBox("sam").body, "Works once, for 24 hours.");
		assert.equal(words.usedText(3, 4), "3 of 4 accounts used.");
		assert.equal(words.serverFullText(4), "All 4 accounts are used. Remove one to invite someone.");
		assert.equal(words.restoreFullText(4), "All 4 accounts are used. Remove one first.");
		assert.deepEqual(words.ACCOUNTS_TEXT.menu, { reset: "Reset password", pause: "Pause", resume: "Resume", remove: "Remove" });
		assert.equal(words.ACCOUNTS_TEXT.newInvite, "New invite code");
		assert.equal(words.signedInAs("sam"), "Signed in as sam");
	});

	it("words dates in the device's own format", () => {
		const day = new Date(NOW).toLocaleDateString(undefined, { day: "numeric", month: "short" });
		const time = new Date(NOW).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
		assert.equal(words.dayText(NOW), day);
		assert.equal(words.dayTimeText(NOW), `${day}, ${time}`);
		assert.equal(words.dayTimeText(NOW, NOW + MIN), `today, ${time}`);
		assert.equal(words.dayTimeText(NOW, NOW + 3 * DAY), `${day}, ${time}`);
		assert.equal(words.inviteUntilText(NOW), `Works once, until ${day}`);
		assert.equal(words.removedText(NOW), `Removed ${day} · deleted for good on ${words.dayText(NOW + 30 * DAY)}`);
		assert.equal(words.removedText(NOW, NOW + 30 * DAY), words.removedText(NOW));
		assert.equal(words.inviteBox(NOW).body, `Works once, until ${day}. Send it to the person with this site's address.`);
		assert.equal(words.accountStatusText({ role: "owner", state: "active", signedInNow: true, lastSeenAt: NOW }), "Owner · signed in now");
		assert.equal(words.accountStatusText({ role: "member", state: "active", signedInNow: false, lastSeenAt: NOW }), `Last seen ${day}, ${time}`);
		assert.equal(words.accountStatusText({ role: "member", state: "paused", signedInNow: false, lastSeenAt: NOW }), "Paused");
	});

	it("words each person's own Account screen", () => {
		assert.equal(words.recoveryLeftText(2), "2 of 4 left.");
		assert.equal(words.ACCOUNT_TEXT.recoveryBox.title, "New recovery codes?");
		assert.equal(words.ACCOUNT_TEXT.recoveryBox.body, "Your old codes stop working.");
		assert.equal(words.ACCOUNT_TEXT.recoveryBox.confirm, "Make new codes");
		assert.equal(words.ACCOUNT_TEXT.downloadHelp, "Your sessions, graph and settings as one file.");
		assert.equal(words.ACCOUNT_TEXT.deleteBox.title, "Delete your account?");
		assert.equal(words.ACCOUNT_TEXT.deleteBox.body, "Your account and everything in it are deleted now, for good. This can't be undone. Download your data first if you want to keep it.");
		assert.equal(words.ACCOUNT_TEXT.deleteBox.confirm, "Delete my account");
	});

	it("keeps the constants the words repeat equal to the rules'", () => {
		assert.equal(words.recoveryLeftText(0), `0 of ${acc.RECOVERY_CODE_COUNT} left.`);
		assert.equal(words.removedText(0, undefined), words.removedText(0, acc.REMOVED_KEEP_MS));
		assert.equal(acc.INVITE_LIFETIME_MS, 7 * DAY);
		assert.equal(acc.RESET_LIFETIME_MS, 24 * HOUR);
	});
});

// ─── The security review's findings ──────────────────────────────────────────

describe("review 1: a member whose copy was never made", () => {
	const RES_CODES = ["JJJJ-KKKK", "MMMM-NNNN"];
	/** Adds "res" (tag R3S), reserved but never made, in the given state. */
	const withReservation = (status: acc.AccountStatus = "active", removedAt: number | null = null) => deepFreeze({
		...fixture(),
		accounts: [...fixture().accounts, account({ name: "res", tag: "R3S", upstream: null, gateSecret: null, state: status, removedAt, recoveryCodes: RES_CODES.map(setupCodeHash), createdAt: NOW - 40 * DAY })],
	});
	const RES = "acct_res";

	it("is refused by every owner action, Delete my account and the reset code", () => {
		refused(acc.pauseAccount(withReservation(), RES), "bad-state");
		refused(acc.resumeAccount(withReservation("paused"), RES), "bad-state");
		refused(acc.removeAccount(withReservation(), RES, NOW), "bad-state");
		refused(acc.removeAccount(withReservation("paused"), RES, NOW), "bad-state");
		refused(acc.restoreAccount(withReservation("removed", NOW - 31 * DAY), RES, 9), "bad-state");
		refused(acc.deleteNow(withReservation("removed", NOW - DAY), RES), "bad-state");
		refused(acc.deleteNow(withReservation("deleting"), RES), "bad-state");
		refused(acc.deleteDue(withReservation("removed", NOW - 31 * DAY), RES, NOW), "bad-state");
		refused(acc.selfDelete(withReservation(), RES, PASSWORD, ADDR, NOW), "bad-state");
		refused(acc.selfDelete(withReservation("deleting"), RES, PASSWORD, ADDR, NOW), "bad-state");
		refused(acc.issueResetCode(withReservation(), RES, NOW), "bad-state");
		refused(acc.changePassword(withReservation(), RES, null, { current: PASSWORD, next: "brand new password" }, ADDR, NOW), "not-found");
		refused(acc.replaceRecoveryCodes(withReservation(), RES, PASSWORD, ADDR, NOW), "not-found");
		const state = withReservation();
		assert.equal(acc.markCopyPending(state, RES), state, "no remake is ever marked");
		assert.equal(acc.dueForDeletion(withReservation("removed", NOW - 31 * DAY), NOW).length, 0);
	});

	it("can't sign in: the same answer and count as a name with no account", () => {
		const state = withReservation();
		const res = refused(acc.signIn(state, { name: "res", password: PASSWORD }, "ua", ADDR, NOW), "wrong");
		const nobody = refused(acc.signIn(state, { name: "nobody", password: PASSWORD }, "ua", ADDR, NOW), "wrong");
		assert.deepEqual(res.state.lockouts, nobody.state.lockouts);
		assert.equal(res.state.lockouts[ADDR]?.against, "*");
		refused(acc.resetPassword(state, { name: "res", code: RES_CODES[0], password: "brand new password" }, ADDR, NOW), "reset-invalid");
		const session = acc.createAccountSession(state, RES, "ua", NOW);
		assert.equal(acc.resolveSession(session.state, session.token, NOW), null, "a session, however made, opens nothing");
	});

	it("is never listed on the owner's screen; its slot is still taken", () => {
		for (const [status, removedAt] of [["active", null], ["paused", null], ["removed", NOW - DAY]] as const) {
			const view = acc.accountsView(withReservation(status, removedAt), 9, NOW);
			assert.ok(!view.accounts.some((a) => a.name === "res"), status);
			assert.ok(!view.removed.some((a) => a.name === "res"), status);
		}
		assert.equal(acc.accountsView(withReservation(), 9, NOW).used, 4);
	});

	it("only finishing the redeem or abandoning it acts on it; a removed one (an older file) is abandoned too", () => {
		assert.deepEqual(acc.unfinishedReservations(withReservation("removed", NOW - DAY)).map((a) => a.name), ["res"]);
		const abandoned = good(acc.abandonReservation(withReservation("removed", NOW - DAY), RES));
		assert.equal(abandoned.account.state, "deleting");
		assert.equal(abandoned.account.keepVolume, true);
		const made = good(acc.finishReservation(withReservation(), RES, { upstream: "lh-acct-R3S:3000", gateSecret: "s".repeat(43) }));
		good(acc.pauseAccount(deepFreeze(made.state), RES));
		good(acc.signIn(deepFreeze(made.state), { name: "res", password: PASSWORD }, "ua", ADDR, NOW));
	});
});

describe("review 3: the lockout table can't be emptied", () => {
	const SIGN = (name: string, password = "wrong wrong wrong") => ({ name, password });
	const fill = (record: (i: number) => acc.GatewayLockout): Record<string, acc.GatewayLockout> => {
		const many: Record<string, acc.GatewayLockout> = {};
		for (let i = 0; i < acc.MAX_LOCKOUT_ENTRIES; i += 1) many[`10.${i >> 16 & 255}.${i >> 8 & 255}.${i & 255}`] = record(i);
		return many;
	};

	it("never evicts a locked address, however old its last failure", () => {
		const lockouts = fill((i) => ({ failures: 0, level: 1, lockedUntil: NOW + HOUR, lastFailureAt: NOW - 2 * DAY + i, against: "*" }));
		const next = acc.recordWrongAttempt({ ...fixture(), lockouts }, ADDR, NOW).state;
		assert.equal(Object.keys(next.lockouts).length, acc.MAX_LOCKOUT_ENTRIES);
		assert.ok(Object.keys(lockouts).every((k) => next.lockouts[k]?.lockedUntil === NOW + HOUR), "every lock stands");
		assert.equal(next.lockouts[ADDR], undefined, "the new address isn't recorded");
		assert.equal(next.lockoutPauseUntil, NOW + acc.LOCKOUT_FULL_PAUSE_MS);
	});

	it("full of addresses it must keep: every address with no entry is refused for 60 seconds at a time; known ones and sessions carry on", () => {
		let state = deepFreeze({ ...fixture(), lockouts: fill((i) => ({ failures: 1, level: 0, lockedUntil: 0, lastFailureAt: NOW - HOUR + i, against: "*" })) });
		const first = refused(acc.signIn(state, SIGN("nobody"), "ua", ADDR, NOW), "locked");
		assert.equal(first.waitMs, acc.LOCKOUT_FULL_PAUSE_MS);
		assert.equal(words.tooManyAttempts(first.waitMs!), "Too many attempts. Try again in 1 min.");
		state = deepFreeze(first.state);
		const other = "198.51.100.9";
		assert.equal(acc.lockWait(state, other, NOW + 1000), acc.LOCKOUT_FULL_PAUSE_MS - 1000);
		refused(acc.signIn(state, SIGN("sam", PASSWORD), "ua", other, NOW + 1000), "locked");
		refused(acc.resetPassword(state, { name: "sam", code: RECOVERY[0], password: "brand new password" }, other, NOW + 1000), "locked");
		const invite = good(acc.createInvite(state, 9, NOW));
		refused(acc.reserveMember(deepFreeze(invite.state), { code: invite.code, name: "newbie", password: PASSWORD }, 9, other, NOW + 1000), "locked");
		const noOwner = deepFreeze(good(acc.issueSetupCode({ ...state, accounts: [] })).state);
		refused(acc.claimOwner(noOwner, { code: "x", name: "Boss", password: PASSWORD, upstream: "lh:3000", gateSecret: "s" }, other, NOW + 1000), "locked");
		// An address that has an entry, and an existing session, are not paused.
		good(acc.signIn(state, SIGN("sam", PASSWORD), "ua", "10.0.0.7", NOW + 1000));
		const session = acc.createAccountSession(state, idOf(state, "sam"), "ua", NOW);
		assert.ok(acc.resolveSession(session.state, session.token, NOW + 1000));
		// The pause ends; the next failure from a new address starts it again.
		good(acc.signIn(state, SIGN("sam", PASSWORD), "ua", other, NOW + acc.LOCKOUT_FULL_PAUSE_MS));
		const again = refused(acc.signIn(state, SIGN("nobody"), "ua", other, NOW + acc.LOCKOUT_FULL_PAUSE_MS), "locked");
		assert.equal(again.state.lockoutPauseUntil, NOW + 2 * acc.LOCKOUT_FULL_PAUSE_MS);
	});

	it("10 wrong codes against one account in 24 hours, from any addresses, refuse code resets of it until the window passes", () => {
		let state = fixture();
		const T = (i: number) => NOW + i * MIN;
		for (let i = 0; i < acc.CODE_TRIES_PER_ACCOUNT; i += 1) {
			state = deepFreeze(refused(acc.resetPassword(state, { name: "sam", code: "ZZZZ-ZZZZ", password: "brand new password" }, `192.0.2.${i}`, T(i)), "reset-invalid").state);
		}
		assert.deepEqual(acc.findAccountByName(state, "sam")!.codeFailures, { count: 10, since: NOW });
		// The right recovery code, from a fresh address, is refused with the same sentence.
		const blocked = refused(acc.resetPassword(state, { name: "sam", code: RECOVERY[0], password: "brand new password" }, "198.51.100.1", T(20)), "locked");
		assert.equal(blocked.waitMs, NOW + DAY - T(20));
		assert.equal(blocked.state, state, "a refusal records nothing");
		// Another account and sign-in by password are untouched.
		const kimReset = good(acc.issueResetCode(state, idOf(state, "kim"), T(20)));
		good(acc.resetPassword(deepFreeze(kimReset.state), { name: "kim", code: kimReset.code, password: "brand new password" }, "198.51.100.1", T(20)));
		good(acc.signIn(state, { name: "sam", password: PASSWORD }, "ua", "198.51.100.2", T(20)));
		// The window passes.
		const done = good(acc.resetPassword(state, { name: "sam", code: RECOVERY[0], password: "brand new password" }, "198.51.100.1", NOW + DAY));
		assert.equal(done.account.codeFailures, undefined);
	});

	it("under the limit, a correct code works and clears the count", () => {
		let state = fixture();
		for (let i = 0; i < acc.CODE_TRIES_PER_ACCOUNT - 1; i += 1) {
			state = deepFreeze(refused(acc.resetPassword(state, { name: "sam", code: "ZZZZ-ZZZZ", password: "brand new password" }, `192.0.2.${i}`, NOW), "reset-invalid").state);
		}
		const done = good(acc.resetPassword(state, { name: "sam", code: RECOVERY[1], password: "brand new password" }, "198.51.100.1", NOW));
		assert.equal(acc.findAccountByName(done.state, "sam")!.codeFailures, undefined);
	});

	it("reset-owner clears the pause and the owner's code count; both survive the file", () => {
		const owner = { ...fixture().accounts[0]!, codeFailures: { count: 10, since: NOW } };
		const state = deepFreeze({ ...fixture(), accounts: [owner, ...fixture().accounts.slice(1)], lockoutPauseUntil: NOW + MIN });
		const back = acc.parseGatewayState(JSON.parse(JSON.stringify(state)));
		assert.equal(back.lockoutPauseUntil, NOW + MIN);
		assert.deepEqual(back.accounts[0]!.codeFailures, { count: 10, since: NOW });
		const r = acc.resetOwnerAccess(state, NOW);
		assert.equal(r.state.lockoutPauseUntil, undefined);
		assert.equal(acc.ownerAccount(r.state)!.codeFailures, undefined);
		assert.throws(() => acc.parseGatewayState({ ...JSON.parse(JSON.stringify(state)), lockoutPauseUntil: "soon" }));
		assert.throws(() => acc.parseGatewayState({ ...JSON.parse(JSON.stringify(state)), accounts: [{ ...JSON.parse(JSON.stringify(owner)), codeFailures: { count: "x", since: 1 } }] }));
	});
});

describe("review 4: the file must name every account once", () => {
	const raw = () => JSON.parse(JSON.stringify(fixture())) as { accounts: Array<Record<string, unknown>> };
	const damaged = (change: (v: { accounts: Array<Record<string, unknown>> }) => void) => {
		const v = raw();
		change(v);
		assert.throws(() => acc.parseGatewayState(v), /Invalid/);
	};

	it("refuses duplicate ids, tags and names, two owners, an owner with a tag and a member without one", () => {
		acc.parseGatewayState(raw());
		damaged((v) => { v.accounts[2]!.id = v.accounts[1]!.id; });
		damaged((v) => { v.accounts[2]!.tag = v.accounts[1]!.tag; v.accounts[2]!.upstream = v.accounts[1]!.upstream; });
		damaged((v) => { v.accounts[2]!.nameKey = "sam"; });
		damaged((v) => { v.accounts[2]!.role = "owner"; v.accounts[2]!.tag = null; v.accounts[2]!.upstream = "lh:3000"; });
		damaged((v) => { v.accounts[0]!.tag = "ABC"; v.accounts[0]!.upstream = null; });
		damaged((v) => { v.accounts[1]!.tag = null; v.accounts[1]!.upstream = null; });
	});
});

describe("review 5: a reset code doesn't outlive the password it was for", () => {
	it("a password change ends that account's reset code, no one else's", () => {
		const base = fixture();
		const sam = good(acc.issueResetCode(base, idOf(base, "sam"), NOW));
		const both = good(acc.issueResetCode(deepFreeze(sam.state), idOf(base, "kim"), NOW));
		const changed = good(acc.changePassword(deepFreeze(both.state), idOf(base, "sam"), null, { current: PASSWORD, next: "brand new password" }, ADDR, NOW));
		assert.deepEqual(changed.state.resets.map((r) => r.accountId), [idOf(base, "kim")]);
		refused(acc.resetPassword(deepFreeze(changed.state), { name: "sam", code: sam.code, password: "another new password" }, ADDR, NOW), "reset-invalid");
	});

	it("a reset by recovery code ends the account's reset code too", () => {
		const base = fixture();
		const sam = good(acc.issueResetCode(base, idOf(base, "sam"), NOW));
		const done = good(acc.resetPassword(deepFreeze(sam.state), { name: "sam", code: RECOVERY[2], password: "brand new password" }, ADDR, NOW));
		assert.equal(done.state.resets.length, 0);
	});
});
