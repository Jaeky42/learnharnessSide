/**
 * Server-mode login (cloud sync Phase 1, docs/cloud-sync.md): pure rules
 * for the password gate a public LearnHarness server puts in front of
 * everything. The desktop app and local dev never use this (no
 * LH_SERVER_MODE), so nothing here changes their behavior.
 *
 * Approved rules (owner, 2026-11-10):
 *  - Password of at least 8 characters, stored only as a scrypt hash.
 *  - First start: a one-time setup code (printed to the server log) lets
 *    the owner choose the password. It is stored only as a hash.
 *  - A login lasts a FIXED 30 days from sign-in; use never extends it.
 *  - After 5 wrong attempts from one address, logins from it pause for
 *    15 minutes; each repeated pause doubles, up to 24 hours. Signed-in
 *    devices keep working. A success, or a day without failures, resets it.
 *  - Changing the password signs out every OTHER device.
 *
 * State shape is versioned JSON owned by src/store/server-auth.ts. All
 * functions take `now` (ms) so tests drive time; randomness comes from
 * node:crypto. Tokens and setup codes are never stored, only SHA-256.
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const SERVER_AUTH_VERSION = 1;
export const PASSWORD_MIN_LENGTH = 8;
/** Bound the work a single login can cause (scrypt cost is per byte of input too). */
export const PASSWORD_MAX_LENGTH = 1024;
export const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
export const LOCKOUT_FAILURES = 5;
export const LOCKOUT_BASE_MS = 15 * 60 * 1000;
export const LOCKOUT_MAX_MS = 24 * 60 * 60 * 1000;
/** A day with no failures from an address forgets its lockout history. */
export const LOCKOUT_FORGET_MS = 24 * 60 * 60 * 1000;
/** lastSeenAt is refreshed at most this often (it costs a file write). */
export const LAST_SEEN_RESOLUTION_MS = 5 * 60 * 1000;
export const SESSION_COOKIE = "__Host-lh_session";
const MAX_SESSIONS = 50;
const MAX_LABEL = 80;

// scrypt parameters: N=2^15, r=8, p=1 (~32 MiB, tens of ms). Stored with the
// hash so they can be raised later without invalidating old passwords.
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64 } as const;

export interface PasswordHash {
	algorithm: "scrypt";
	N: number;
	r: number;
	p: number;
	salt: string; // base64url
	hash: string; // base64url
}

export interface SessionRecord {
	id: string;
	/** SHA-256 (hex) of the cookie token; the token itself is never stored. */
	tokenHash: string;
	label: string;
	createdAt: number;
	expiresAt: number;
	lastSeenAt: number;
}

export interface LockoutRecord {
	/** Wrong attempts since the last pause began (or since the start). */
	failures: number;
	/** How many pauses this address has had; the next one lasts BASE·2^level. */
	level: number;
	lockedUntil: number;
	lastFailureAt: number;
}

/** A paired desktop app (cloud sync Phase 5, src/core/sync/devices.ts). Its
 *  key opens only the sync API; only the key's SHA-256 is stored. */
export interface DeviceRecord {
	/** Chosen by the desktop and kept across re-pairing ("dev_" + 16 hex). */
	id: string;
	name: string;
	/** SHA-256 (hex) of the device key. */
	keyHash: string;
	pairedAt: number;
	lastSeenAt: number;
}

/** The one pairing code that is waiting to be typed into a desktop app. */
export interface PairingRecord {
	/** SHA-256 (hex) of the normalized code. */
	codeHash: string;
	expiresAt: number;
}

export interface ServerAuthState {
	version: typeof SERVER_AUTH_VERSION;
	password: PasswordHash | null;
	/** SHA-256 (hex) of the normalized setup code, while no password is set. */
	setupCodeHash: string | null;
	sessions: SessionRecord[];
	lockouts: Record<string, LockoutRecord>;
	/** Paired desktop apps. Absent in files written before Phase 5. */
	devices: DeviceRecord[];
	pairing: PairingRecord | null;
}

export function emptyServerAuthState(): ServerAuthState {
	return { version: SERVER_AUTH_VERSION, password: null, setupCodeHash: null, sessions: [], lockouts: {}, devices: [], pairing: null };
}

// ─── Passwords ───────────────────────────────────────────────────────────────

/** null when acceptable, otherwise the message to show. */
export function passwordProblem(password: unknown): string | null {
	if (typeof password !== "string") return "Enter a password.";
	if ([...password].length < PASSWORD_MIN_LENGTH) return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
	if (password.length > PASSWORD_MAX_LENGTH) return `Use at most ${PASSWORD_MAX_LENGTH} characters.`;
	return null;
}

export function hashPassword(password: string): PasswordHash {
	const salt = randomBytes(16);
	const hash = scryptSync(password.normalize("NFC"), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 128 * SCRYPT.N * SCRYPT.r * 2 });
	return { algorithm: "scrypt", N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString("base64url"), hash: hash.toString("base64url") };
}

export function verifyPassword(password: string, stored: PasswordHash): boolean {
	if (typeof password !== "string" || password.length > PASSWORD_MAX_LENGTH) return false;
	const expected = Buffer.from(stored.hash, "base64url");
	const actual = scryptSync(password.normalize("NFC"), Buffer.from(stored.salt, "base64url"), expected.length, {
		N: stored.N, r: stored.r, p: stored.p, maxmem: 128 * stored.N * stored.r * 2,
	});
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ─── Tokens and setup codes ──────────────────────────────────────────────────

export function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

export function newSessionToken(): string {
	return randomBytes(32).toString("base64url");
}

// Crockford base32 without I, L, O, U: easy to read from a log and type.
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** "7KQ2-M9XD" style: 8 symbols, 40 bits, plus the lockout on wrong tries. */
export function newSetupCode(): string {
	const bytes = randomBytes(8);
	let code = "";
	for (const byte of bytes) code += CODE_ALPHABET[byte % 32];
	return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Case, spaces and dashes don't matter when the code is typed back.
 *  scripts/server-reset-password.mjs repeats this rule (tests pin parity). */
export function normalizeSetupCode(code: string): string {
	return code.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

export function setupCodeHash(code: string): string {
	return sha256(normalizeSetupCode(code));
}

export function setupCodeMatches(code: unknown, storedHash: string | null): boolean {
	if (typeof code !== "string" || !storedHash || code.length > 64) return false;
	const actual = Buffer.from(setupCodeHash(code), "hex");
	const expected = Buffer.from(storedHash, "hex");
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ─── Sessions ────────────────────────────────────────────────────────────────

/** A readable device name from the User-Agent, e.g. "Safari on iPhone". */
export function deviceLabel(userAgent: string | null | undefined): string {
	const ua = userAgent ?? "";
	const os = /iPhone/.test(ua) ? "iPhone"
		: /iPad/.test(ua) ? "iPad"
		: /Android/.test(ua) ? "Android"
		: /Windows/.test(ua) ? "Windows"
		: /Mac OS X|Macintosh/.test(ua) ? "Mac"
		: /Linux/.test(ua) ? "Linux"
		: null;
	const browser = /Edg\//.test(ua) ? "Edge"
		: /Firefox\/|FxiOS/.test(ua) ? "Firefox"
		: /CriOS|Chrome\//.test(ua) ? "Chrome"
		: /Safari\//.test(ua) ? "Safari"
		: null;
	const label = browser && os ? `${browser} on ${os}` : browser ?? os ?? "Unknown device";
	return label.slice(0, MAX_LABEL);
}

export function liveSessions(state: ServerAuthState, now: number): SessionRecord[] {
	return state.sessions.filter((s) => s.expiresAt > now);
}

/** Adds a session; returns the new state and the cookie token. */
export function createSession(state: ServerAuthState, label: string, now: number): { state: ServerAuthState; token: string; session: SessionRecord } {
	const token = newSessionToken();
	const session: SessionRecord = {
		id: randomBytes(9).toString("base64url"),
		tokenHash: sha256(token),
		label: label.slice(0, MAX_LABEL),
		createdAt: now,
		expiresAt: now + SESSION_LIFETIME_MS,
		lastSeenAt: now,
	};
	// Oldest sessions fall off past the cap so the file can't grow forever.
	const sessions = [...liveSessions(state, now), session].slice(-MAX_SESSIONS);
	return { state: { ...state, sessions }, token, session };
}

export function findSession(state: ServerAuthState, token: string | null | undefined, now: number): SessionRecord | null {
	if (!token || token.length > 256) return null;
	const wanted = Buffer.from(sha256(token), "hex");
	for (const session of state.sessions) {
		if (session.expiresAt <= now) continue;
		const stored = Buffer.from(session.tokenHash, "hex");
		if (stored.length === wanted.length && timingSafeEqual(stored, wanted)) return session;
	}
	return null;
}

/** New state with lastSeenAt refreshed, or null when no write is needed. */
export function touchSession(state: ServerAuthState, sessionId: string, now: number): ServerAuthState | null {
	const session = state.sessions.find((s) => s.id === sessionId);
	if (!session || now - session.lastSeenAt < LAST_SEEN_RESOLUTION_MS) return null;
	return { ...state, sessions: state.sessions.map((s) => s.id === sessionId ? { ...s, lastSeenAt: now } : s) };
}

export function removeSession(state: ServerAuthState, sessionId: string): ServerAuthState {
	return { ...state, sessions: state.sessions.filter((s) => s.id !== sessionId) };
}

/** Keeps only `keepId` (or nothing). */
export function removeOtherSessions(state: ServerAuthState, keepId: string | null): ServerAuthState {
	return { ...state, sessions: state.sessions.filter((s) => s.id === keepId) };
}

// ─── Lockout ─────────────────────────────────────────────────────────────────

/** Milliseconds until `address` may try again, or 0. */
export function lockedFor(state: ServerAuthState, address: string, now: number): number {
	const record = state.lockouts[address];
	return record && record.lockedUntil > now ? record.lockedUntil - now : 0;
}

export function recordFailure(state: ServerAuthState, address: string, now: number): ServerAuthState {
	const previous = state.lockouts[address];
	const fresh = !previous || now - previous.lastFailureAt >= LOCKOUT_FORGET_MS;
	const record: LockoutRecord = fresh
		? { failures: 0, level: 0, lockedUntil: 0, lastFailureAt: now }
		: { ...previous };
	record.failures += 1;
	record.lastFailureAt = now;
	if (record.failures >= LOCKOUT_FAILURES) {
		record.lockedUntil = now + Math.min(LOCKOUT_BASE_MS * 2 ** record.level, LOCKOUT_MAX_MS);
		record.level += 1;
		record.failures = 0;
	}
	const pruned = pruneLockouts(state, now);
	return { ...pruned, lockouts: { ...pruned.lockouts, [address]: record } };
}

export function clearFailures(state: ServerAuthState, address: string): ServerAuthState {
	if (!state.lockouts[address]) return state;
	const lockouts = { ...state.lockouts };
	delete lockouts[address];
	return { ...state, lockouts };
}

function pruneLockouts(state: ServerAuthState, now: number): ServerAuthState {
	const lockouts: Record<string, LockoutRecord> = {};
	for (const [address, record] of Object.entries(state.lockouts)) {
		if (record.lockedUntil > now || now - record.lastFailureAt < LOCKOUT_FORGET_MS) lockouts[address] = record;
	}
	return { ...state, lockouts };
}

/** "15 min", "2 h", "1 h 30 min" for the lockout message. */
export function formatWait(ms: number): string {
	const minutes = Math.max(1, Math.ceil(ms / 60000));
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

// ─── Validation of the stored file ───────────────────────────────────────────

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isHash = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

/** Strict parse: anything malformed throws (the store refuses to guess). */
export function parseServerAuthState(raw: unknown): ServerAuthState {
	const value = raw as Partial<ServerAuthState> | null;
	if (!value || typeof value !== "object" || value.version !== SERVER_AUTH_VERSION) throw new Error("Unsupported server login file.");
	const password = value.password;
	if (password !== null && (!password || password.algorithm !== "scrypt" || !isNum(password.N) || !isNum(password.r) || !isNum(password.p) || !isStr(password.salt) || !isStr(password.hash))) {
		throw new Error("Invalid password record.");
	}
	if (value.setupCodeHash !== null && !(typeof value.setupCodeHash === "string" && /^[0-9a-f]{64}$/.test(value.setupCodeHash))) throw new Error("Invalid setup code record.");
	if (!Array.isArray(value.sessions)) throw new Error("Invalid sessions.");
	for (const s of value.sessions) {
		if (!s || !isStr(s.id) || !/^[0-9a-f]{64}$/.test(s.tokenHash) || typeof s.label !== "string" || !isNum(s.createdAt) || !isNum(s.expiresAt) || !isNum(s.lastSeenAt)) throw new Error("Invalid session.");
	}
	if (!value.lockouts || typeof value.lockouts !== "object" || Array.isArray(value.lockouts)) throw new Error("Invalid lockouts.");
	for (const r of Object.values(value.lockouts)) {
		if (!r || !isNum(r.failures) || !isNum(r.level) || !isNum(r.lockedUntil) || !isNum(r.lastFailureAt)) throw new Error("Invalid lockout.");
	}
	// Paired desktops (Phase 5). Files from before it have neither field.
	const devices = value.devices ?? [];
	if (!Array.isArray(devices)) throw new Error("Invalid devices.");
	for (const d of devices) {
		if (!d || !isStr(d.id) || !isStr(d.name) || !isHash(d.keyHash) || !isNum(d.pairedAt) || !isNum(d.lastSeenAt)) throw new Error("Invalid device.");
	}
	const pairing = value.pairing ?? null;
	if (pairing !== null && (typeof pairing !== "object" || !isHash(pairing.codeHash) || !isNum(pairing.expiresAt))) throw new Error("Invalid pairing record.");
	return { version: SERVER_AUTH_VERSION, password: password ?? null, setupCodeHash: value.setupCodeHash ?? null, sessions: value.sessions, lockouts: value.lockouts, devices, pairing };
}
