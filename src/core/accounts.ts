/**
 * Accounts on one server (docs/multi-account-plan.md, docs/multi-account-build.md
 * "Slice 1a"): the pure rules the gateway uses. No file I/O, no environment,
 * no clock reads: every function takes `now` (ms). Randomness comes from
 * node:crypto, as in ./server-auth, whose password hashing, code alphabet and
 * lockout rules are reused unchanged.
 *
 * This file is bundled into the standalone gateway program, so it imports only
 * from ./server-auth and node built-ins (never from the core barrel).
 *
 * Result convention: a mutating function returns
 *   { ok: true, state, ... } | { ok: false, code, state, waitMs?, message? }
 * and never throws for a user error or mutates its input. On a failure `state`
 * is what to persist: it carries a recorded wrong attempt (the one lockout),
 * and is the very same object that was passed in when nothing changed.
 * `code: "locked"` always comes with `waitMs`.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import {
	LAST_SEEN_RESOLUTION_MS,
	LOCKOUT_FORGET_MS,
	clearFailures,
	emptyServerAuthState,
	hashPassword,
	lockedFor,
	newSessionToken,
	newSetupCode,
	normalizeSetupCode,
	passwordProblem,
	recordFailure,
	setupCodeHash,
	sha256,
	verifyPassword,
	type LockoutRecord,
	type PasswordHash,
	type SessionRecord,
} from "./server-auth.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

export const GATEWAY_STATE_VERSION = 1;
export const NAME_MIN_LENGTH = 3;
export const NAME_MAX_LENGTH = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
/** An invite code works once, for 7 days. */
export const INVITE_LIFETIME_MS = 7 * DAY_MS;
/** The owner's reset code works once, for 24 hours. */
export const RESET_LIFETIME_MS = DAY_MS;
export const RECOVERY_CODE_COUNT = 4;
/** A removed account's data is kept this long, then deleted for good. */
export const REMOVED_KEEP_MS = 30 * DAY_MS;
/** A sign-in lasts 30 days from its last use ... */
export const SESSION_IDLE_MS = 30 * DAY_MS;
/** ... and never longer than 180 days from the sign-in. */
export const SESSION_MAX_MS = 180 * DAY_MS;
/**
 * "Signed in now" on the owner's screen: a live session used within this long.
 * Twice the write resolution (LAST_SEEN_RESOLUTION_MS, 5 min), because a
 * session in constant use is only stamped about that often.
 */
export const SIGNED_IN_NOW_MS = 2 * LAST_SEEN_RESOLUTION_MS;
const MAX_SESSIONS_PER_ACCOUNT = 50;
const MAX_LABEL = 80;
const MAX_CODE_INPUT = 64;
const TAG_LENGTH = 3;
/** Pairing code with a tag: 8 symbols + 3. Device key with a tag: 32 bytes of base64url (43) + 3. */
const OWNER_CODE_LENGTH = 8;
const TAGGED_CODE_LENGTH = OWNER_CODE_LENGTH + TAG_LENGTH;
const OWNER_KEY_LENGTH = 43;
const TAGGED_KEY_LENGTH = OWNER_KEY_LENGTH + TAG_LENGTH;

/** Names nobody may take (compared lower case, with dashes removed as well). */
export const RESERVED_NAMES: readonly string[] = [
	"admin", "administrator", "owner", "root", "api", "login", "logout", "signin", "signout", "signup",
	"setup", "invite", "reset", "recover", "recovery", "account", "accounts", "gateway", "maker", "system",
	"support", "server", "learnharness", "harness", "help", "www", "mail", "email", "static", "public",
	"settings", "user", "users", "staff", "moderator", "mod", "official", "security", "docker", "caddy",
	"null", "undefined", "anonymous", "guest", "everyone", "nobody", "internal", "manifest", "icons", "fonts",
];

// ─── Types ───────────────────────────────────────────────────────────────────

export type AccountRole = "owner" | "member";
/** `deleting`: a deletion that failed part-way; can't sign in, holds no slot, keeps its name and tag until erased. */
export type AccountStatus = "active" | "paused" | "removed" | "deleting";

export interface AccountRecord {
	id: string;
	/** Three characters of the setup-code alphabet; null for the owner. */
	tag: string | null;
	/** As typed. */
	name: string;
	/** Lower case; names are unique by it. */
	nameKey: string;
	password: PasswordHash;
	/** SHA-256 (hex) of each unused recovery code. */
	recoveryCodes: string[];
	role: AccountRole;
	state: AccountStatus;
	createdAt: number;
	lastSeenAt: number | null;
	removedAt: number | null;
	/** "host:3000" of the account's copy; null while the copy is being made. */
	upstream: string | null;
	gateSecret: string | null;
	/**
	 * Present (true) only while the copy still has to be told to unpair its
	 * desktop apps (after a password change, either reset, Sign out
	 * everywhere; never Pause or Remove). Its sync requests get 503 until it is cleared.
	 */
	unpairPending?: true;
	/**
	 * Present (true) from just before the gateway asks the maker to (re)create
	 * the copy until the answer's upstream and secret are saved. Set, the maker
	 * may have made a container whose secret the gateway never received, so
	 * the lifecycle loop creates it again (a fresh secret) before trusting it.
	 */
	copyPending?: true;
	/**
	 * Present (true) on an abandoned reservation: its deletion removes the
	 * container but never the volume, because a volume under this tag may
	 * not be this attempt's own (it could predate a lost state file).
	 */
	keepVolume?: true;
}

/** One address's lockout, and whose password every counted failure was against. */
export interface GatewayLockout extends LockoutRecord {
	/** An account id when every counted failure was a password try against it; "*" otherwise (another name, mixed, any code). */
	against: string;
}

export interface GatewaySession extends SessionRecord {
	accountId: string;
}

export interface InviteRecord {
	id: string;
	/** SHA-256 (hex) of the normalized code. */
	codeHash: string;
	createdAt: number;
	expiresAt: number;
}

export interface ResetRecord {
	accountId: string;
	codeHash: string;
	createdAt: number;
	expiresAt: number;
}

export interface GatewayState {
	version: typeof GATEWAY_STATE_VERSION;
	accounts: AccountRecord[];
	sessions: GatewaySession[];
	invites: InviteRecord[];
	resets: ResetRecord[];
	/** One lockout per client address (IPv6 by /64): passwords and every kind of code. */
	lockouts: Record<string, GatewayLockout>;
	/** SHA-256 (hex) of the first-start setup code while no owner exists. */
	setupCodeHash: string | null;
}

export interface Fail<C extends string> {
	ok: false;
	code: C;
	/** What to persist (a recorded wrong attempt), or the unchanged input. */
	state: GatewayState;
	/** Milliseconds until the address may try again (code "locked"). */
	waitMs?: number;
	/** The existing sentence for a password that doesn't qualify. */
	message?: string;
}

export type NameProblem = "not-allowed" | "reserved" | "taken";

export function emptyGatewayState(): GatewayState {
	return { version: GATEWAY_STATE_VERSION, accounts: [], sessions: [], invites: [], resets: [], lockouts: {}, setupCodeHash: null };
}

// ─── The file ────────────────────────────────────────────────────────────────

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isHash = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const bad = (what: string): never => { throw new Error(`Invalid ${what}.`); };

function parsePassword(raw: unknown): PasswordHash {
	if (!isObject(raw) || raw.algorithm !== "scrypt" || !isNum(raw.N) || !isNum(raw.r) || !isNum(raw.p) || !isStr(raw.salt) || !isStr(raw.hash)) return bad("password record");
	return { algorithm: "scrypt", N: raw.N, r: raw.r, p: raw.p, salt: raw.salt, hash: raw.hash };
}

function parseAccount(raw: unknown): AccountRecord {
	if (!isObject(raw)) return bad("account");
	const { role, state } = raw;
	if (!isStr(raw.id) || !isStr(raw.name) || !isStr(raw.nameKey)) return bad("account");
	if (role !== "owner" && role !== "member") return bad("account role");
	if (state !== "active" && state !== "paused" && state !== "removed" && state !== "deleting") return bad("account state");
	if (raw.tag !== null && !isTag(raw.tag)) return bad("account tag");
	if (!Array.isArray(raw.recoveryCodes) || !raw.recoveryCodes.every(isHash)) return bad("recovery codes");
	if (!isNum(raw.createdAt)) return bad("account");
	if (raw.lastSeenAt !== null && !isNum(raw.lastSeenAt)) return bad("account");
	if (raw.removedAt !== null && !isNum(raw.removedAt)) return bad("account");
	if (raw.upstream !== null && !isStr(raw.upstream)) return bad("account");
	if (raw.gateSecret !== null && !isStr(raw.gateSecret)) return bad("account");
	if (raw.unpairPending !== undefined && raw.unpairPending !== true) return bad("account");
	if (raw.copyPending !== undefined && raw.copyPending !== true) return bad("account");
	if (raw.keepVolume !== undefined && raw.keepVolume !== true) return bad("account");
	if (!upstreamAllowed(role, raw.tag as string | null, raw.upstream as string | null)) return bad("account upstream");
	return {
		id: raw.id, tag: raw.tag as string | null, name: raw.name, nameKey: raw.nameKey, password: parsePassword(raw.password),
		recoveryCodes: [...(raw.recoveryCodes as string[])], role, state, createdAt: raw.createdAt,
		lastSeenAt: raw.lastSeenAt as number | null, removedAt: raw.removedAt as number | null,
		upstream: raw.upstream as string | null, gateSecret: raw.gateSecret as string | null,
		...(raw.unpairPending === true ? { unpairPending: true as const } : {}),
		...(raw.copyPending === true ? { copyPending: true as const } : {}),
		...(raw.keepVolume === true ? { keepVolume: true as const } : {}),
	};
}

/** Strict parse: unknown fields are dropped; a wrong version or shape throws (the store refuses to guess). */
export function parseGatewayState(raw: unknown): GatewayState {
	if (!isObject(raw) || raw.version !== GATEWAY_STATE_VERSION) throw new Error("Unsupported gateway file.");
	if (!Array.isArray(raw.accounts) || !Array.isArray(raw.sessions) || !Array.isArray(raw.invites) || !Array.isArray(raw.resets)) return bad("gateway file");
	const accounts = raw.accounts.map(parseAccount);
	const sessions = raw.sessions.map((s): GatewaySession => {
		if (!isObject(s) || !isStr(s.id) || !isHash(s.tokenHash) || typeof s.label !== "string" || !isNum(s.createdAt) || !isNum(s.expiresAt) || !isNum(s.lastSeenAt) || !isStr(s.accountId)) return bad("session");
		return { id: s.id, tokenHash: s.tokenHash, label: s.label, createdAt: s.createdAt, expiresAt: s.expiresAt, lastSeenAt: s.lastSeenAt, accountId: s.accountId };
	});
	const invites = raw.invites.map((i): InviteRecord => {
		if (!isObject(i) || !isStr(i.id) || !isHash(i.codeHash) || !isNum(i.createdAt) || !isNum(i.expiresAt)) return bad("invite");
		return { id: i.id, codeHash: i.codeHash, createdAt: i.createdAt, expiresAt: i.expiresAt };
	});
	const resets = raw.resets.map((r): ResetRecord => {
		if (!isObject(r) || !isStr(r.accountId) || !isHash(r.codeHash) || !isNum(r.createdAt) || !isNum(r.expiresAt)) return bad("reset code");
		return { accountId: r.accountId, codeHash: r.codeHash, createdAt: r.createdAt, expiresAt: r.expiresAt };
	});
	if (!isObject(raw.lockouts)) return bad("lockouts");
	const lockouts: Record<string, GatewayLockout> = {};
	for (const [address, l] of Object.entries(raw.lockouts)) {
		if (!isObject(l) || !isNum(l.failures) || !isNum(l.level) || !isNum(l.lockedUntil) || !isNum(l.lastFailureAt)) return bad("lockout");
		if (l.against !== undefined && !isStr(l.against)) return bad("lockout");
		// An older record says nothing about whose: no success clears it.
		lockouts[address] = { failures: l.failures, level: l.level, lockedUntil: l.lockedUntil, lastFailureAt: l.lastFailureAt, against: (l.against as string | undefined) ?? ANY };
	}
	if (raw.setupCodeHash !== null && !isHash(raw.setupCodeHash)) return bad("setup code record");
	return { version: GATEWAY_STATE_VERSION, accounts, sessions, invites, resets, lockouts, setupCodeHash: raw.setupCodeHash as string | null };
}

// ─── Lookups ─────────────────────────────────────────────────────────────────

export const nameKeyOf = (name: string): string => name.toLowerCase();

export function findAccount(state: GatewayState, id: string): AccountRecord | null {
	return state.accounts.find((a) => a.id === id) ?? null;
}

export function findAccountByName(state: GatewayState, name: unknown): AccountRecord | null {
	if (typeof name !== "string") return null;
	const key = nameKeyOf(name);
	return state.accounts.find((a) => a.nameKey === key) ?? null;
}

export function ownerAccount(state: GatewayState): AccountRecord | null {
	return state.accounts.find((a) => a.role === "owner") ?? null;
}

export function hasOwner(state: GatewayState): boolean {
	return ownerAccount(state) !== null;
}

/** The account a tag names; `null` (an older code or key) is the owner's. */
export function findAccountByTag(state: GatewayState, tag: string | null): AccountRecord | null {
	if (tag === null) return ownerAccount(state);
	return state.accounts.find((a) => a.tag === tag) ?? null;
}

/** A copy that is ready to receive requests. */
export function isReady(account: AccountRecord): boolean {
	return account.upstream !== null && account.gateSecret !== null;
}

// ─── Names ───────────────────────────────────────────────────────────────────

const NAME_PATTERN = /^[A-Za-z0-9-]+$/;

/** Bad characters or length → "not-allowed"; a reserved word → "reserved"; otherwise null. */
export function nameShapeProblem(name: unknown): "not-allowed" | "reserved" | null {
	if (typeof name !== "string" || name.length < NAME_MIN_LENGTH || name.length > NAME_MAX_LENGTH || !NAME_PATTERN.test(name)) return "not-allowed";
	const key = nameKeyOf(name);
	const squeezed = key.replace(/-/g, "");
	if (RESERVED_NAMES.includes(key) || RESERVED_NAMES.includes(squeezed)) return "reserved";
	return null;
}

/** Shape first, then taken: an account in any state (removed and deleting too) keeps its name. */
export function checkName(state: GatewayState, name: unknown): NameProblem | null {
	const shape = nameShapeProblem(name);
	if (shape) return shape;
	return findAccountByName(state, name) ? "taken" : null;
}

// ─── Tags and codes ──────────────────────────────────────────────────────────

const TAG_PATTERN = /^[0-9A-HJKMNP-TV-Z]{3}$/;

export function isTag(value: unknown): value is string {
	return typeof value === "string" && TAG_PATTERN.test(value);
}

/** The one upstream a member's copy can have (the maker names every copy so). */
export const memberUpstream = (tag: string): string => `lh-acct-${tag}:3000`;
const OWNER_UPSTREAM_SHAPE = /^[A-Za-z0-9.-]{1,253}:\d{1,5}$/;

/**
 * A member's upstream is exactly its own `lh-acct-<tag>:3000` (or none yet);
 * the owner's is a host:port (the gateway uses the configured one anyway).
 * Any other value makes the file damaged: the gate must never send a member
 * to another copy.
 */
export function upstreamAllowed(role: AccountRole, tag: string | null, upstream: string | null): boolean {
	if (upstream === null) return true;
	if (role === "owner") return tag === null && OWNER_UPSTREAM_SHAPE.test(upstream);
	return tag !== null && upstream === memberUpstream(tag);
}

/** Three characters of the setup-code alphabet. */
function randomTag(): string {
	return normalizeSetupCode(newSetupCode()).slice(0, TAG_LENGTH);
}

/** A fresh tag, unique among all account records of any state; null only if the space is exhausted. */
export function newTag(state: GatewayState): string | null {
	const taken = new Set(state.accounts.map((a) => a.tag));
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const tag = randomTag();
		if (!taken.has(tag)) return tag;
	}
	return null;
}

export type TagRead = { ok: true; tag: string | null } | { ok: false };

/** A pairing code: 11 characters after normalizing end in the tag; 8 is the owner's (tag null). */
export function tagFromPairingCode(code: unknown): TagRead {
	if (typeof code !== "string" || code.length > MAX_CODE_INPUT) return { ok: false };
	const normalized = normalizeSetupCode(code);
	if (normalized.length === OWNER_CODE_LENGTH) return { ok: true, tag: null };
	if (normalized.length === TAGGED_CODE_LENGTH) {
		const tag = normalized.slice(-TAG_LENGTH);
		return isTag(tag) ? { ok: true, tag } : { ok: false };
	}
	return { ok: false };
}

/** A device key: 46 characters start with the tag; 43 is the owner's (tag null). */
export function tagFromDeviceKey(key: unknown): TagRead {
	if (typeof key !== "string" || !/^[A-Za-z0-9_-]+$/.test(key)) return { ok: false };
	if (key.length === OWNER_KEY_LENGTH) return { ok: true, tag: null };
	if (key.length === TAGGED_KEY_LENGTH) {
		const tag = key.slice(0, TAG_LENGTH);
		return isTag(tag) ? { ok: true, tag } : { ok: false };
	}
	return { ok: false };
}

function newId(prefix: string): string {
	return `${prefix}_${randomBytes(9).toString("base64url")}`;
}

/** Four distinct codes and their hashes. */
function newRecoveryCodes(): { codes: string[]; hashes: string[] } {
	const codes: string[] = [];
	const hashes: string[] = [];
	while (codes.length < RECOVERY_CODE_COUNT) {
		const code = newSetupCode();
		const hash = setupCodeHash(code);
		if (hashes.includes(hash)) continue;
		codes.push(code);
		hashes.push(hash);
	}
	return { codes, hashes };
}

function safeEqualHex(a: string, b: string): boolean {
	const left = Buffer.from(a, "hex");
	const right = Buffer.from(b, "hex");
	return left.length === right.length && timingSafeEqual(left, right);
}

function codeHashOf(code: unknown): string | null {
	if (typeof code !== "string" || code.length === 0 || code.length > MAX_CODE_INPUT) return null;
	return setupCodeHash(code);
}

// ─── The lockout (one per address, every kind of attempt) ────────────────────

/** `against` for a failure that is not a password try against one existing account. */
const ANY = "*";
/** At most this many addresses are remembered; the oldest failures go first (bounds the file too). */
export const MAX_LOCKOUT_ENTRIES = 2000;

/**
 * The lockout's key for a client address: an IPv6 address by its /64 (one
 * home or one server usually holds a whole /64), an IPv4-mapped IPv6
 * address as the IPv4 address, anything else as it is.
 */
export function lockoutKey(address: string): string {
	const plain = address.trim().toLowerCase();
	const mapped = /^(?:0{0,4}:){0,5}(?:0{0,4}::?)?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(plain) ?? /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(plain);
	if (mapped) return mapped[1]!;
	if (!plain.includes(":") || !/^[0-9a-f:.%a-z]+$/.test(plain)) return address;
	const bare = plain.split("%")[0]!;
	const halves = bare.split("::");
	if (halves.length > 2) return address;
	const head = halves[0] ? halves[0].split(":") : [];
	const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	const missing = 8 - head.length - tail.length;
	if (halves.length === 1 ? head.length !== 8 : missing < 1) return address;
	const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
	if (!groups.slice(0, 4).every((g) => /^[0-9a-f]{1,4}$/.test(g))) return address;
	return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

// ./server-auth's helpers are typed against its own state; they only touch `lockouts`.
function shim(state: GatewayState) {
	return { ...emptyServerAuthState(), lockouts: state.lockouts as Record<string, LockoutRecord> };
}

/** Milliseconds until this address may try again, or 0. */
export function lockWait(state: GatewayState, address: string, now: number): number {
	return lockedFor(shim(state), lockoutKey(address), now);
}

/**
 * One failure for the address. `against`: the account whose password was
 * tried, or "*" (a name with no account, or any code). A record already
 * against another account, or "*", stays "*" until it ages out.
 */
function withFailure(state: GatewayState, address: string, now: number, against: string): GatewayState {
	const key = lockoutKey(address);
	const previous = state.lockouts[key];
	const fresh = !previous || now - previous.lastFailureAt >= LOCKOUT_FORGET_MS;
	const target = fresh ? against : previous.against === against ? against : ANY;
	const recorded = recordFailure(shim(state), key, now).lockouts;
	const lockouts: Record<string, GatewayLockout> = {};
	for (const [k, record] of Object.entries(recorded)) {
		lockouts[k] = { failures: record.failures, level: record.level, lockedUntil: record.lockedUntil, lastFailureAt: record.lastFailureAt, against: k === key ? target : state.lockouts[k]?.against ?? ANY };
	}
	const keys = Object.keys(lockouts);
	if (keys.length > MAX_LOCKOUT_ENTRIES) {
		const oldest = keys.filter((k) => k !== key).sort((a, b) => lockouts[a]!.lastFailureAt - lockouts[b]!.lastFailureAt);
		for (const k of oldest.slice(0, keys.length - MAX_LOCKOUT_ENTRIES)) delete lockouts[k];
	}
	return { ...state, lockouts };
}

/**
 * A success clears the address's failures only when every one of them was a
 * password try against this same account (someone mistyping their own
 * password). Failures against another name, or any code failure, are never
 * cleared by a success; they age out (LOCKOUT_FORGET_MS).
 */
function withoutFailures(state: GatewayState, address: string, accountId: string | null): GatewayState {
	const key = lockoutKey(address);
	const record = state.lockouts[key];
	if (!record || accountId === null || record.against !== accountId) return state;
	return { ...state, lockouts: clearFailures(shim(state), key).lockouts as Record<string, GatewayLockout> };
}

/**
 * A wrong attempt the gateway judges outside these rules (a pairing code of
 * no copy's shape): recorded in the one lockout. `waitMs` > 0 when it tripped the pause.
 */
export function recordWrongAttempt(state: GatewayState, address: string, now: number): { state: GatewayState; waitMs: number } {
	const next = withFailure(state, address, now, ANY);
	return { state: next, waitMs: lockWait(next, address, now) };
}

function locked(state: GatewayState, wait: number): Fail<"locked"> {
	return { ok: false, code: "locked", state, waitMs: wait };
}

/** A wrong attempt: recorded, and "locked" when it was the one that tripped the pause. */
function wrongAttempt<C extends string>(state: GatewayState, address: string, now: number, code: C, against: string = ANY): Fail<C | "locked"> {
	const next = withFailure(state, address, now, against);
	const wait = lockWait(next, address, now);
	return wait ? locked(next, wait) : { ok: false, code, state: next };
}

// ─── The cap and invites ─────────────────────────────────────────────────────

/** Accounts that hold a slot: active or paused, the owner included. */
export function usedSlots(state: GatewayState): number {
	return state.accounts.filter((a) => a.state === "active" || a.state === "paused").length;
}

export function freeSlots(state: GatewayState, cap: number): number {
	return Math.max(0, cap - usedSlots(state));
}

export function waitingInvites(state: GatewayState, now: number): InviteRecord[] {
	return state.invites.filter((i) => i.expiresAt > now);
}

/** Drops expired invites, reset codes and sessions. Returns the same object when nothing went. */
export function pruneExpired(state: GatewayState, now: number): GatewayState {
	const sessions = state.sessions.filter((s) => s.expiresAt > now);
	const invites = state.invites.filter((i) => i.expiresAt > now);
	const resets = state.resets.filter((r) => r.expiresAt > now);
	if (sessions.length === state.sessions.length && invites.length === state.invites.length && resets.length === state.resets.length) return state;
	return { ...state, sessions, invites, resets };
}

/** The owner makes a code that works once, for 7 days. Refused ("full") when waiting codes already fill the free slots. */
export function createInvite(state: GatewayState, cap: number, now: number): { ok: true; state: GatewayState; code: string; invite: InviteRecord } | Fail<"full"> {
	const pruned = pruneExpired(state, now);
	if (waitingInvites(pruned, now).length >= freeSlots(pruned, cap)) return { ok: false, code: "full", state };
	const code = newSetupCode();
	const invite: InviteRecord = { id: newId("inv"), codeHash: setupCodeHash(code), createdAt: now, expiresAt: now + INVITE_LIFETIME_MS };
	return { ok: true, state: { ...pruned, invites: [...pruned.invites, invite] }, code, invite };
}

export function cancelInvite(state: GatewayState, inviteId: string): { ok: true; state: GatewayState } | Fail<"not-found"> {
	if (!state.invites.some((i) => i.id === inviteId)) return { ok: false, code: "not-found", state };
	return { ok: true, state: { ...state, invites: state.invites.filter((i) => i.id !== inviteId) } };
}

// ─── First start ─────────────────────────────────────────────────────────────

/** While no owner exists: a fresh setup code (its hash is stored; print the code). */
export function issueSetupCode(state: GatewayState): { ok: true; state: GatewayState; code: string } | Fail<"owner-exists"> {
	if (hasOwner(state)) return { ok: false, code: "owner-exists", state };
	const code = newSetupCode();
	return { ok: true, state: { ...state, setupCodeHash: setupCodeHash(code) }, code };
}

export interface ClaimInput {
	code: unknown;
	name: unknown;
	password: unknown;
	/** The owner's copy ("lh:3000") and its secret. */
	upstream: string;
	gateSecret: string;
}

export type ClaimFailure = "already-set-up" | "setup-code-invalid" | NameProblem | "password-problem" | "locked";

/** The setup code, a name and a password create the owner's account, once. */
export function claimOwner(state: GatewayState, input: ClaimInput, address: string, now: number): { ok: true; state: GatewayState; account: AccountRecord } | Fail<ClaimFailure> {
	if (hasOwner(state)) return { ok: false, code: "already-set-up", state };
	const wait = lockWait(state, address, now);
	if (wait) return locked(state, wait);
	const typed = input.code;
	if (!state.setupCodeHash || typeof typed !== "string" || typed.length > MAX_CODE_INPUT || !safeEqualHex(setupCodeHash(typed), state.setupCodeHash)) {
		return wrongAttempt(state, address, now, "setup-code-invalid");
	}
	const problem = checkName(state, input.name);
	if (problem) return { ok: false, code: problem, state };
	const passwordIssue = passwordProblem(input.password);
	if (passwordIssue) return { ok: false, code: "password-problem", state, message: passwordIssue };
	const name = input.name as string;
	const account: AccountRecord = {
		id: newId("acct"), tag: null, name, nameKey: nameKeyOf(name), password: hashPassword(input.password as string),
		recoveryCodes: [], role: "owner", state: "active", createdAt: now, lastSeenAt: null, removedAt: null,
		upstream: input.upstream, gateSecret: input.gateSecret,
	};
	return { ok: true, state: { ...state, accounts: [...state.accounts, account], setupCodeHash: null }, account };
}

// ─── Redeeming an invite (reserve, call the maker, then finish or roll back) ─

export interface RedeemInput {
	code: unknown;
	name: unknown;
	password: unknown;
}

export type RedeemFailure = "invite-invalid" | "full" | NameProblem | "password-problem" | "locked";

/**
 * Step 1. Checks the code (a wrong one counts toward the lockout), the cap, the
 * name and the password; consumes the invite and creates an `active` member
 * with a fresh tag and no copy yet (`upstream`/`gateSecret` null). Returns the
 * four recovery codes in clear (shown once) and the consumed invite, which
 * `rollbackReservation` hands back if the maker fails.
 */
export function reserveMember(state: GatewayState, input: RedeemInput, cap: number, address: string, now: number): { ok: true; state: GatewayState; account: AccountRecord; codes: string[]; invite: InviteRecord } | Fail<RedeemFailure> {
	const wait = lockWait(state, address, now);
	if (wait) return locked(state, wait);
	const hash = codeHashOf(input.code);
	const invite = hash ? state.invites.find((i) => i.expiresAt > now && safeEqualHex(i.codeHash, hash)) : undefined;
	if (!invite) return wrongAttempt(state, address, now, "invite-invalid");
	if (freeSlots(state, cap) < 1) return { ok: false, code: "full", state };
	const problem = checkName(state, input.name);
	if (problem) return { ok: false, code: problem, state };
	const passwordIssue = passwordProblem(input.password);
	if (passwordIssue) return { ok: false, code: "password-problem", state, message: passwordIssue };
	const tag = newTag(state);
	if (!tag) return { ok: false, code: "full", state };
	const name = input.name as string;
	const recovery = newRecoveryCodes();
	const account: AccountRecord = {
		id: newId("acct"), tag, name, nameKey: nameKeyOf(name), password: hashPassword(input.password as string),
		recoveryCodes: recovery.hashes, role: "member", state: "active", createdAt: now, lastSeenAt: null, removedAt: null,
		upstream: null, gateSecret: null,
	};
	const next: GatewayState = { ...state, invites: state.invites.filter((i) => i.id !== invite.id), accounts: [...state.accounts, account] };
	return { ok: true, state: next, account, codes: recovery.codes, invite };
}

/** Step 3a: the maker made the copy. */
export function finishReservation(state: GatewayState, accountId: string, copy: { upstream: string; gateSecret: string }): { ok: true; state: GatewayState; account: AccountRecord } | Fail<"not-found"> {
	const account = findAccount(state, accountId);
	if (!account) return { ok: false, code: "not-found", state };
	const done: AccountRecord = { ...account, upstream: copy.upstream, gateSecret: copy.gateSecret };
	return { ok: true, state: { ...state, accounts: state.accounts.map((a) => a.id === accountId ? done : a) }, account: done };
}

/** Step 3b: the maker failed. The account record goes (name and tag are free again) and the invite is given back. */
export function rollbackReservation(state: GatewayState, accountId: string, invite?: InviteRecord): GatewayState {
	const erased = eraseAccount(state, accountId);
	if (!invite || erased.invites.some((i) => i.id === invite.id)) return erased;
	return { ...erased, invites: [...erased.invites, invite] };
}

/**
 * A reservation whose copy couldn't be made (or whose maker answer never
 * came): the account goes to `deleting` (no slot, no sign-in; name and tag
 * kept until the leftovers are gone and it is erased). Idempotent.
 */
export function abandonReservation(state: GatewayState, accountId: string): { ok: true; state: GatewayState; account: AccountRecord } | Fail<"not-found" | "bad-state"> {
	const account = findAccount(state, accountId);
	if (!account) return { ok: false, code: "not-found", state };
	if (account.role !== "member" || (account.state !== "deleting" && isReady(account))) return { ok: false, code: "bad-state", state };
	const marked = markDeleting(state, account);
	const kept: AccountRecord = { ...marked.account, keepVolume: true };
	return { ok: true, state: withAccount(marked.state, kept), account: kept };
}

/** Member accounts that were reserved but never got a copy (a crash between steps 1 and 3). */
export function unfinishedReservations(state: GatewayState): AccountRecord[] {
	return state.accounts.filter((a) => a.role === "member" && (a.state === "active" || a.state === "paused") && !isReady(a));
}

// ─── Sessions ────────────────────────────────────────────────────────────────

/** Idle for 30 days ends it; so does 180 days since the sign-in. */
export function sessionExpiry(createdAt: number, lastSeenAt: number): number {
	return Math.min(lastSeenAt + SESSION_IDLE_MS, createdAt + SESSION_MAX_MS);
}

export function liveSessionsOf(state: GatewayState, accountId: string, now: number): GatewaySession[] {
	return state.sessions.filter((s) => s.accountId === accountId && s.expiresAt > now);
}

/** Adds a session for an account; returns the cookie token. Expired sessions are dropped, and an account keeps at most 50. */
export function createAccountSession(state: GatewayState, accountId: string, label: string, now: number): { state: GatewayState; token: string; session: GatewaySession } {
	const token = newSessionToken();
	const session: GatewaySession = {
		id: randomBytes(9).toString("base64url"), tokenHash: sha256(token), label: label.slice(0, MAX_LABEL),
		createdAt: now, expiresAt: sessionExpiry(now, now), lastSeenAt: now, accountId,
	};
	const live = state.sessions.filter((s) => s.expiresAt > now);
	const mine = live.filter((s) => s.accountId === accountId);
	const drop = new Set(mine.slice(0, Math.max(0, mine.length + 1 - MAX_SESSIONS_PER_ACCOUNT)).map((s) => s.id));
	return { state: { ...state, sessions: [...live.filter((s) => !drop.has(s.id)), session] }, token, session };
}

export function findSession(state: GatewayState, token: string | null | undefined, now: number): GatewaySession | null {
	if (!token || token.length > 256) return null;
	const wanted = Buffer.from(sha256(token), "hex");
	for (const session of state.sessions) {
		if (session.expiresAt <= now) continue;
		const stored = Buffer.from(session.tokenHash, "hex");
		if (stored.length === wanted.length && timingSafeEqual(stored, wanted)) return session;
	}
	return null;
}

/** The session and its account, when the cookie is live and the account is active (what /gate needs). */
export function resolveSession(state: GatewayState, token: string | null | undefined, now: number): { session: GatewaySession; account: AccountRecord } | null {
	const session = findSession(state, token, now);
	if (!session) return null;
	const account = findAccount(state, session.accountId);
	if (!account || account.state !== "active") return null;
	return { session, account };
}

/**
 * Stamps the session (and extends it, within the 180-day limit) and the
 * account's last seen, at most every 5 minutes. null when no write is needed.
 */
export function touchSession(state: GatewayState, sessionId: string, now: number): GatewayState | null {
	const session = state.sessions.find((s) => s.id === sessionId);
	if (!session || now - session.lastSeenAt < LAST_SEEN_RESOLUTION_MS) return null;
	return {
		...state,
		sessions: state.sessions.map((s) => s.id === sessionId ? { ...s, lastSeenAt: now, expiresAt: sessionExpiry(s.createdAt, now) } : s),
		accounts: state.accounts.map((a) => a.id === session.accountId ? { ...a, lastSeenAt: now } : a),
	};
}

export function removeSession(state: GatewayState, sessionId: string): GatewayState {
	return { ...state, sessions: state.sessions.filter((s) => s.id !== sessionId) };
}

export function removeAccountSessions(state: GatewayState, accountId: string): GatewayState {
	return { ...state, sessions: state.sessions.filter((s) => s.accountId !== accountId) };
}

/** Every session of the account except `keepId`. */
export function removeOtherAccountSessions(state: GatewayState, accountId: string, keepId: string | null): GatewayState {
	return { ...state, sessions: state.sessions.filter((s) => s.accountId !== accountId || s.id === keepId) };
}

/** An account's signed-in devices, newest use first, in the shape the Account screen has today. */
export function sessionList(state: GatewayState, accountId: string, currentId: string | null, now: number): Array<{ id: string; label: string; createdAt: number; lastSeenAt: number; expiresAt: number; current: boolean }> {
	return liveSessionsOf(state, accountId, now)
		.sort((a, b) => b.lastSeenAt - a.lastSeenAt)
		.map((s) => ({ id: s.id, label: s.label, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, expiresAt: s.expiresAt, current: s.id === currentId }));
}

/** A live session of the account used within the last 10 minutes. */
export function signedInNow(state: GatewayState, accountId: string, now: number): boolean {
	return liveSessionsOf(state, accountId, now).some((s) => now - s.lastSeenAt <= SIGNED_IN_NOW_MS);
}

// ─── Sign-in ─────────────────────────────────────────────────────────────────

/** A real scrypt hash of a password nobody has: a wrong name still costs one verification. */
const DUMMY_PASSWORD: PasswordHash = {
	algorithm: "scrypt", N: 32768, r: 8, p: 1,
	salt: "djMpIdwJ1alTWH-KM1yI8w",
	hash: "dUqVrLfrdw48CtuFTHxJZCG-351Itgvtw9uiGUEj8FLn2vLP5YRP1-r6FMzlgLB1BliqXzz1_ONEgYuRprWblw",
};

export type SignInFailure = "wrong" | "paused" | "removed" | "locked";

/**
 * Name and password. A wrong name and a wrong password are the same answer and
 * cost the same (the name's absence still runs one verification); "paused" and
 * "removed" are told only after a correct password.
 */
export function signIn(state: GatewayState, input: { name: unknown; password: unknown }, label: string, address: string, now: number): { ok: true; state: GatewayState; token: string; session: GatewaySession; account: AccountRecord } | Fail<SignInFailure> {
	const wait = lockWait(state, address, now);
	if (wait) return locked(state, wait);
	const found = findAccountByName(state, input.name);
	const account = found && found.state !== "deleting" ? found : null;
	const password = typeof input.password === "string" ? input.password : "";
	const right = verifyPassword(password, account ? account.password : DUMMY_PASSWORD);
	if (!account || !right) return wrongAttempt(state, address, now, "wrong", account ? account.id : ANY);
	if (account.state === "paused") return { ok: false, code: "paused", state };
	if (account.state === "removed") return { ok: false, code: "removed", state };
	const created = createAccountSession(withoutFailures(state, address, account.id), account.id, label, now);
	const seen: AccountRecord = { ...account, lastSeenAt: now };
	return { ok: true, state: { ...created.state, accounts: created.state.accounts.map((a) => a.id === account.id ? seen : a) }, token: created.token, session: created.session, account: seen };
}

// ─── Password and recovery codes ─────────────────────────────────────────────

function checkPassword(state: GatewayState, account: AccountRecord, password: unknown, address: string, now: number): { ok: true } | Fail<"wrong-password" | "locked"> {
	const wait = lockWait(state, address, now);
	if (wait) return locked(state, wait);
	if (typeof password !== "string" || !verifyPassword(password, account.password)) return wrongAttempt(state, address, now, "wrong-password", account.id);
	return { ok: true };
}

function withAccount(state: GatewayState, account: AccountRecord): GatewayState {
	return { ...state, accounts: state.accounts.map((a) => a.id === account.id ? account : a) };
}

/** Needs the current password. Ends the account's other sessions (keeping `keepSessionId`). */
export function changePassword(state: GatewayState, accountId: string, keepSessionId: string | null, input: { current: unknown; next: unknown }, address: string, now: number): { ok: true; state: GatewayState } | Fail<"not-found" | "wrong-password" | "password-problem" | "locked"> {
	const account = findAccount(state, accountId);
	if (!account || (account.state !== "active" && account.state !== "paused")) return { ok: false, code: "not-found", state };
	const checked = checkPassword(state, account, input.current, address, now);
	if (!checked.ok) return checked;
	const issue = passwordProblem(input.next);
	if (issue) return { ok: false, code: "password-problem", state, message: issue };
	const updated = withAccount(withoutFailures(state, address, accountId), { ...account, password: hashPassword(input.next as string) });
	return { ok: true, state: removeOtherAccountSessions(updated, accountId, keepSessionId) };
}

/** Sign out everywhere: every session of the account, the current one too. */
export function signOutEverywhere(state: GatewayState, accountId: string): GatewayState {
	return removeAccountSessions(state, accountId);
}

export function recoveryCodesLeft(account: Pick<AccountRecord, "recoveryCodes">): number {
	return account.recoveryCodes.length;
}

/** Needs the password. Replaces all codes; the new ones come back in clear, once. */
export function replaceRecoveryCodes(state: GatewayState, accountId: string, password: unknown, address: string, now: number): { ok: true; state: GatewayState; codes: string[] } | Fail<"not-found" | "wrong-password" | "locked"> {
	const account = findAccount(state, accountId);
	if (!account || (account.state !== "active" && account.state !== "paused")) return { ok: false, code: "not-found", state };
	const checked = checkPassword(state, account, password, address, now);
	if (!checked.ok) return checked;
	const fresh = newRecoveryCodes();
	return { ok: true, state: withAccount(withoutFailures(state, address, accountId), { ...account, recoveryCodes: fresh.hashes }), codes: fresh.codes };
}

// ─── Reset ───────────────────────────────────────────────────────────────────

/** The owner's reset code for a member: once, 24 hours; replaces an older one for that account. */
export function issueResetCode(state: GatewayState, accountId: string, now: number): { ok: true; state: GatewayState; code: string; expiresAt: number } | Fail<"not-found" | "is-owner" | "bad-state"> {
	const account = findAccount(state, accountId);
	if (!account) return { ok: false, code: "not-found", state };
	if (account.role === "owner") return { ok: false, code: "is-owner", state };
	if (account.state !== "active" && account.state !== "paused") return { ok: false, code: "bad-state", state };
	const code = newSetupCode();
	const record: ResetRecord = { accountId, codeHash: setupCodeHash(code), createdAt: now, expiresAt: now + RESET_LIFETIME_MS };
	const resets = [...state.resets.filter((r) => r.expiresAt > now && r.accountId !== accountId), record];
	return { ok: true, state: { ...state, resets }, code, expiresAt: record.expiresAt };
}

export type ResetFailure = "reset-invalid" | "password-problem" | "locked";

/**
 * A recovery code or a live reset code for the account, and a new password.
 * A wrong name and a wrong code are one answer. Allowed for active and paused
 * accounts (a paused one stays paused). On success every session of the
 * account ends and the code is used up; the caller unpairs the account's
 * desktop apps (`account` says whose copy).
 */
export function resetPassword(state: GatewayState, input: { name: unknown; code: unknown; password: unknown }, address: string, now: number): { ok: true; state: GatewayState; account: AccountRecord } | Fail<ResetFailure> {
	const wait = lockWait(state, address, now);
	if (wait) return locked(state, wait);
	const issue = passwordProblem(input.password);
	if (issue) return { ok: false, code: "password-problem", state, message: issue };
	const hash = codeHashOf(input.code);
	const found = findAccountByName(state, input.name);
	const account = found && (found.state === "active" || found.state === "paused") ? found : null;
	let recovery: string | undefined;
	let reset: ResetRecord | undefined;
	if (account && hash) {
		recovery = account.recoveryCodes.find((c) => safeEqualHex(c, hash));
		reset = state.resets.find((r) => r.accountId === account.id && r.expiresAt > now && safeEqualHex(r.codeHash, hash));
	}
	if (!account || (!recovery && !reset)) return wrongAttempt(state, address, now, "reset-invalid");
	const updated: AccountRecord = {
		...account,
		password: hashPassword(input.password as string),
		recoveryCodes: recovery ? account.recoveryCodes.filter((c) => c !== recovery) : account.recoveryCodes,
	};
	const next: GatewayState = { ...withAccount(state, updated), resets: state.resets.filter((r) => r.accountId !== account.id) };
	return { ok: true, state: removeAccountSessions(next, account.id), account: updated };
}

// ─── The owner's actions on a member ─────────────────────────────────────────

type OwnerActionFailure = "not-found" | "is-owner" | "bad-state";

function ownerTarget(state: GatewayState, accountId: string, allowed: AccountStatus[]): { ok: true; account: AccountRecord } | Fail<OwnerActionFailure> {
	const account = findAccount(state, accountId);
	if (!account) return { ok: false, code: "not-found", state };
	if (account.role === "owner") return { ok: false, code: "is-owner", state };
	if (!allowed.includes(account.state)) return { ok: false, code: "bad-state", state };
	return { ok: true, account };
}

/** Sign-in is refused and every session ends; the slot stays taken. */
export function pauseAccount(state: GatewayState, accountId: string): { ok: true; state: GatewayState; account: AccountRecord } | Fail<OwnerActionFailure> {
	const target = ownerTarget(state, accountId, ["active"]);
	if (!target.ok) return target;
	const account: AccountRecord = { ...target.account, state: "paused" };
	return { ok: true, state: removeAccountSessions(withAccount(state, account), accountId), account };
}

export function resumeAccount(state: GatewayState, accountId: string): { ok: true; state: GatewayState; account: AccountRecord } | Fail<OwnerActionFailure> {
	const target = ownerTarget(state, accountId, ["paused"]);
	if (!target.ok) return target;
	const account: AccountRecord = { ...target.account, state: "active" };
	return { ok: true, state: withAccount(state, account), account };
}

/** The slot is free at once; the data is kept 30 days. Sessions and reset codes go. */
export function removeAccount(state: GatewayState, accountId: string, now: number): { ok: true; state: GatewayState; account: AccountRecord } | Fail<OwnerActionFailure> {
	const target = ownerTarget(state, accountId, ["active", "paused"]);
	if (!target.ok) return target;
	const account: AccountRecord = { ...target.account, state: "removed", removedAt: now };
	const next = removeAccountSessions({ ...withAccount(state, account), resets: state.resets.filter((r) => r.accountId !== accountId) }, accountId);
	return { ok: true, state: next, account };
}

/** Back to active as it was, only when a slot is free. */
export function restoreAccount(state: GatewayState, accountId: string, cap: number): { ok: true; state: GatewayState; account: AccountRecord } | Fail<OwnerActionFailure | "full"> {
	const target = ownerTarget(state, accountId, ["removed"]);
	if (!target.ok) return target;
	if (freeSlots(state, cap) < 1) return { ok: false, code: "full", state };
	const account: AccountRecord = { ...target.account, state: "active", removedAt: null };
	return { ok: true, state: withAccount(state, account), account };
}

/** Removed accounts whose 30 days have passed. */
export function dueForDeletion(state: GatewayState, now: number): AccountRecord[] {
	return state.accounts.filter((a) => a.state === "removed" && a.removedAt !== null && now - a.removedAt >= REMOVED_KEEP_MS);
}

/** Accounts whose deletion started and must be finished (a retry at the gateway's start). */
export function pendingDeletions(state: GatewayState): AccountRecord[] {
	return state.accounts.filter((a) => a.state === "deleting");
}

/**
 * Marks an account `deleting` (idempotent): it can't sign in, holds no slot,
 * keeps its name and tag. The gateway then has the maker remove the copy and
 * its volume, and only then calls `eraseAccount`.
 */
function markDeleting(state: GatewayState, account: AccountRecord): { state: GatewayState; account: AccountRecord } {
	if (account.state === "deleting") return { state, account };
	const next: AccountRecord = { ...account, state: "deleting" };
	return { state: removeAccountSessions({ ...withAccount(state, next), resets: state.resets.filter((r) => r.accountId !== account.id) }, account.id), account: next };
}

/** The owner's "Delete now": a removed account only. */
export function deleteNow(state: GatewayState, accountId: string): { ok: true; state: GatewayState; account: AccountRecord } | Fail<OwnerActionFailure> {
	const target = ownerTarget(state, accountId, ["removed", "deleting"]);
	if (!target.ok) return target;
	return { ok: true, ...markDeleting(state, target.account) };
}

/** A removed account whose 30 days have passed goes the same way. */
export function deleteDue(state: GatewayState, accountId: string, now: number): { ok: true; state: GatewayState; account: AccountRecord } | Fail<OwnerActionFailure> {
	const target = ownerTarget(state, accountId, ["removed", "deleting"]);
	if (!target.ok) return target;
	if (target.account.state === "removed" && (target.account.removedAt === null || now - target.account.removedAt < REMOVED_KEEP_MS)) return { ok: false, code: "bad-state", state };
	return { ok: true, ...markDeleting(state, target.account) };
}

/** "Delete my account": the password, then `deleting` at once (no 30 days). Not for the owner. */
export function selfDelete(state: GatewayState, accountId: string, password: unknown, address: string, now: number): { ok: true; state: GatewayState; account: AccountRecord } | Fail<OwnerActionFailure | "wrong-password" | "locked"> {
	const target = ownerTarget(state, accountId, ["active", "paused", "deleting"]);
	if (!target.ok) return target;
	const checked = checkPassword(state, target.account, password, address, now);
	if (!checked.ok) return checked;
	return { ok: true, ...markDeleting(withoutFailures(state, address, target.account.id), target.account) };
}

/** Removes the record, its sessions and its reset codes for good; the name and tag are free again. */
export function eraseAccount(state: GatewayState, accountId: string): GatewayState {
	return {
		...state,
		accounts: state.accounts.filter((a) => a.id !== accountId),
		sessions: state.sessions.filter((s) => s.accountId !== accountId),
		resets: state.resets.filter((r) => r.accountId !== accountId),
	};
}

// ─── Unpairing a copy's desktop apps ─────────────────────────────────────────

/** Marks the account's copy as owing an unpair-all (idempotent; same object when nothing changes). */
export function markUnpairPending(state: GatewayState, accountId: string): GatewayState {
	const account = findAccount(state, accountId);
	if (!account || account.unpairPending) return state;
	return withAccount(state, { ...account, unpairPending: true });
}

/** The copy confirmed the unpair-all (same object when nothing changes). */
export function clearUnpairPending(state: GatewayState, accountId: string): GatewayState {
	const account = findAccount(state, accountId);
	if (!account || !account.unpairPending) return state;
	const { unpairPending: _done, ...rest } = account;
	return withAccount(state, rest);
}

export function unpairPendingAccounts(state: GatewayState): AccountRecord[] {
	return state.accounts.filter((a) => a.unpairPending === true);
}

// ─── (Re)creating a copy ─────────────────────────────────────────────────────

/** Written before every POST /copies for an existing account (same object when already set). */
export function markCopyPending(state: GatewayState, accountId: string): GatewayState {
	const account = findAccount(state, accountId);
	if (!account || account.copyPending) return state;
	return withAccount(state, { ...account, copyPending: true });
}

/** The maker's answer: the copy's address and its new secret; the pending mark goes. */
export function saveCopy(state: GatewayState, accountId: string, copy: { upstream: string; gateSecret: string }): GatewayState {
	const account = findAccount(state, accountId);
	if (!account) return state;
	const { copyPending: _done, ...rest } = account;
	return withAccount(state, { ...rest, upstream: copy.upstream, gateSecret: copy.gateSecret });
}

export function copyPendingAccounts(state: GatewayState): AccountRecord[] {
	return state.accounts.filter((a) => a.copyPending === true);
}

// ─── The owner's last way back in (`lh-gateway reset-owner`) ─────────────────

/**
 * Every session of the owner's account ends, the lockouts are cleared (as
 * today's reset-password does) and a reset code for the owner is issued:
 * once, 24 hours, used at the reset page like any other. With no owner yet,
 * a fresh first-start setup code instead.
 */
export function resetOwnerAccess(state: GatewayState, now: number): { kind: "reset"; state: GatewayState; name: string; code: string; expiresAt: number } | { kind: "setup"; state: GatewayState; code: string } {
	const owner = ownerAccount(state);
	if (!owner) {
		const code = newSetupCode();
		return { kind: "setup", state: { ...state, lockouts: {}, setupCodeHash: setupCodeHash(code) }, code };
	}
	const code = newSetupCode();
	const record: ResetRecord = { accountId: owner.id, codeHash: setupCodeHash(code), createdAt: now, expiresAt: now + RESET_LIFETIME_MS };
	const resets = [...state.resets.filter((r) => r.expiresAt > now && r.accountId !== owner.id), record];
	return { kind: "reset", state: { ...removeAccountSessions(state, owner.id), resets, lockouts: {} }, name: owner.name, code, expiresAt: record.expiresAt };
}

// ─── Views ───────────────────────────────────────────────────────────────────

export interface AccountsView {
	accounts: Array<{ id: string; name: string; role: AccountRole; state: "active" | "paused"; signedInNow: boolean; lastSeenAt: number | null }>;
	/** Waiting invites; never the code. */
	invites: Array<{ id: string; expiresAt: number }>;
	removed: Array<{ id: string; name: string; removedAt: number; deletedAt: number }>;
	used: number;
	cap: number;
}

/** The owner's Accounts screen. Accounts being deleted are not listed. */
export function accountsView(state: GatewayState, cap: number, now: number): AccountsView {
	const accounts = state.accounts
		.filter((a): a is AccountRecord & { state: "active" | "paused" } => a.state === "active" || a.state === "paused")
		.sort((a, b) => (a.role === b.role ? a.createdAt - b.createdAt : a.role === "owner" ? -1 : 1))
		.map((a) => ({ id: a.id, name: a.name, role: a.role, state: a.state, signedInNow: signedInNow(state, a.id, now), lastSeenAt: a.lastSeenAt }));
	const removed = state.accounts
		.filter((a) => a.state === "removed" && a.removedAt !== null)
		.sort((a, b) => (a.removedAt as number) - (b.removedAt as number))
		.map((a) => ({ id: a.id, name: a.name, removedAt: a.removedAt as number, deletedAt: (a.removedAt as number) + REMOVED_KEEP_MS }));
	const invites = waitingInvites(state, now).sort((a, b) => a.expiresAt - b.expiresAt).map((i) => ({ id: i.id, expiresAt: i.expiresAt }));
	return { accounts, invites, removed, used: usedSlots(state), cap };
}

/** One person's Account screen: today's `devices` shape plus the name, the owner flag and the codes left. */
export function accountView(state: GatewayState, accountId: string, currentSessionId: string | null, now: number): { name: string; owner: boolean; recoveryCodesLeft: number; devices: ReturnType<typeof sessionList> } | null {
	const account = findAccount(state, accountId);
	if (!account) return null;
	return { name: account.name, owner: account.role === "owner", recoveryCodesLeft: recoveryCodesLeft(account), devices: sessionList(state, accountId, currentSessionId, now) };
}
