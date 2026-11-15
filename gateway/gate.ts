/**
 * The `/gate` decision (docs/multi-account-build.md "What /gate decides"):
 * Caddy's forward_auth asks it about every request that goes to a copy, and
 * a 200 names the copy (X-LH-Upstream), its secret (X-LH-Gate) and why the
 * request may go there (X-LH-Scope: public, sync or session), which the copy
 * checks again with its own parser. One pure
 * function, no I/O: the listener reads the headers and the state and persists
 * the touch it asks for.
 *
 * The decision reads only the forwarded method, URI, Host, Cookie,
 * Authorization, Origin, Sec-Fetch-Site and X-Forwarded-Proto. It never reads
 * an X-LH-* header (Caddy strips client-sent ones, and nothing here would
 * believe one anyway).
 *
 * The small rules the copy also applies (which paths are sync, public or
 * internal; the same-site write check; the client's address) are repeated
 * here, because the gateway is bundled without src/server. Tests compare each
 * with the copy's own (tests/gateway-gate.test.ts).
 */

import {
	findAccountByTag,
	hasOwner,
	isReady,
	resolveSession,
	tagFromDeviceKey,
	type AccountRecord,
	type GatewayState,
} from "../src/core/accounts.ts";
import { SESSION_COOKIE } from "../src/core/server-auth.ts";
import { bearerKey } from "../src/core/sync/devices.ts";
import type { GatewayConfig } from "./config.ts";

// ─── Rules shared with the copy (src/server/server-auth.ts) ──────────────────

export const NO_STORE: Record<string, string> = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

/** The copy's internal routes: never from outside. */
export function isInternalPath(pathname: string): boolean {
	return pathname === "/api/internal" || pathname.startsWith("/api/internal/");
}

export function isSyncPath(pathname: string): boolean {
	return pathname === "/api/sync" || pathname.startsWith("/api/sync/");
}

// A subset of the copy's public list: without its pages and APIs (the
// gateway's own), without the manifest (the gateway serves it in the standard
// dark colours), and of the build files only the static ones. Everything else
// under /_next/ (/_next/image, /_next/data, ...) needs a session and goes to
// the caller's OWN copy.
const PUBLIC_PREFIXES = ["/_next/static/", "/fonts/", "/icons/"];
const PUBLIC_FILES = new Set(["/favicon.ico", "/robots.txt"]);

/** A static build file or icon that needs no session; served from the owner's copy. */
export function isPublicFile(pathname: string): boolean {
	return PUBLIC_FILES.has(pathname) || PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function isWrite(method: string): boolean {
	return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

export interface OriginHeaders {
	origin: string | null;
	host: string | null;
	fetchSite: string | null;
}

/** The copy's `sameOrigin`: a write must name this host in its Origin. */
export function sameOrigin(method: string, h: OriginHeaders): boolean {
	if (!isWrite(method)) return true;
	if (h.fetchSite === "cross-site") return false;
	if (!h.origin || !h.host) return false;
	try { return new URL(h.origin).host === h.host; } catch { return false; }
}

/** The copy's sync-path rule: a desktop app sends no Origin; a browser on another site always names it. */
export function foreignRequest(h: OriginHeaders): boolean {
	let foreign = h.fetchSite === "cross-site";
	if (h.origin) {
		try { foreign ||= new URL(h.origin).host !== h.host; } catch { foreign = true; }
	}
	return foreign;
}

/** The copy's `clientAddress`: behind Caddy (LH_TRUST_PROXY=1) the LAST X-Forwarded-For entry. */
export function clientAddress(forwardedFor: string | null, trustProxy: boolean): string {
	if (trustProxy) {
		const last = forwardedFor?.split(",").map((s) => s.trim()).filter(Boolean).pop();
		if (last && last.length <= 64) return last;
	}
	return "unknown";
}

/**
 * The copy's `readSessionCookie`, for any cookie name, but fail closed: a
 * name given twice (two Cookie headers joined by a proxy, or a planted
 * duplicate) or a value with a comma or a space in it reads as no cookie.
 */
export function readCookie(header: string | null, name: string = SESSION_COOKIE): string | null {
	if (!header) return null;
	let found: string | null = null;
	let seen = 0;
	for (const part of header.split(";")) {
		const index = part.indexOf("=");
		if (index > 0 && part.slice(0, index).trim() === name) {
			seen += 1;
			found = part.slice(index + 1).trim() || null;
		}
	}
	if (seen !== 1 || found === null || /[\s,]/.test(found)) return null;
	return found;
}

/** The session cookie's token from a Cookie header. */
export const findSessionCookie = (header: string | null): string | null => readCookie(header, SESSION_COOKIE);

/** The address the visitor used, for absolute redirects (the copy's `publicUrl`). */
export function publicBase(host: string | null, proto: string | null, trustProxy: boolean): string | null {
	if (!host || !/^[A-Za-z0-9.:[\]-]+$/.test(host)) return null;
	const scheme = trustProxy && (proto === "https" || proto === "http") ? proto : "http";
	try { return new URL(`${scheme}://${host}/`).href; } catch { return null; }
}

/**
 * The request's path, when the whole request target is already in its one
 * canonical form; null (400) otherwise. Refused: a fragment (`#`), the
 * absolute form, a control character, a space or a backslash anywhere; in
 * the path, dot segments (plain or encoded), encoded slashes, backslashes,
 * NUL or `#`, and doubled slashes; and anything a URL parser gives back
 * differently, in the path or in the query, byte for byte. The gate must
 * classify exactly the path the copy will route.
 */
export function canonicalPath(uri: string | null): string | null {
	if (!uri || uri.length > 8192 || !uri.startsWith("/") || uri.startsWith("//")) return null;
	if (/[#\\\s\u0000-\u001f\u007f-\u00ff]/.test(uri) || /[^\u0000-\u007e]/.test(uri)) return null;
	const query = uri.indexOf("?");
	const raw = query === -1 ? uri : uri.slice(0, query);
	if (/%(2e|2f|5c|00|23)/i.test(raw) || raw.includes("//")) return null;
	let parsed: URL;
	try { parsed = new URL(uri, "http://gate.invalid"); } catch { return null; }
	if (parsed.origin !== "http://gate.invalid") return null;
	const search = query === -1 ? "" : uri.slice(query);
	// "?" alone parses to an empty search; both are the same request to the copy only if written alike.
	if (parsed.pathname !== raw || (parsed.search || (search === "?" ? "?" : "")) !== search) return null;
	return raw;
}

// ─── The decision ────────────────────────────────────────────────────────────

export interface GateInput {
	/** X-Forwarded-Method. */
	method: string | null;
	/** X-Forwarded-Uri: path and query. */
	uri: string | null;
	host: string | null;
	cookie: string | null;
	authorization: string | null;
	origin: string | null;
	fetchSite: string | null;
	/** X-Forwarded-Proto. */
	proto: string | null;
}

/**
 * Why a request may reach a copy; Caddy copies it to the copy (X-LH-Scope),
 * which checks it again with its own parser. `internal` is only ever sent by
 * the gateway's own relay calls (unpair-all).
 */
export type GateScope = "public" | "sync" | "session";
export type RelayScope = "sync" | "internal";

export type GateDecision =
	| { status: 200; upstream: string; gateSecret: string; scope: GateScope; touch?: string }
	| { status: number; headers: Record<string, string>; body: string };

/** The copy an account's requests go to. The owner's always from the settings. */
export function copyOf(account: AccountRecord, config: Pick<GatewayConfig, "ownerUpstream" | "ownerGateSecret">): { upstream: string; gateSecret: string } | null {
	if (account.role === "owner") return { upstream: config.ownerUpstream, gateSecret: config.ownerGateSecret };
	return isReady(account) ? { upstream: account.upstream!, gateSecret: account.gateSecret! } : null;
}

/** The desktop app reads this exact shape as "removed": it drops its key. */
export const NOT_PAIRED_BODY = { error: "This desktop app isn't paired with this server.", code: "not_paired" } as const;
export const DAMAGED_TEXT = "The server login file is damaged. Run reset-password on the server.";
export const SIGN_IN_FIRST = "Sign in to LearnHarness first.";
export const SAME_SITE_REFUSAL = "This request must come from the LearnHarness site itself.";

const jsonRefusal = (status: number, body: unknown): GateDecision => ({ status, headers: { ...NO_STORE, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const bare = (status: number): GateDecision => ({ status, headers: { ...NO_STORE }, body: "" });

/**
 * `state` null: the state file is damaged (the site closes). Order:
 * internal → sync → public file → write check → session → sign in.
 */
export function decideGate(input: GateInput, state: GatewayState | null, config: Pick<GatewayConfig, "ownerUpstream" | "ownerGateSecret" | "trustProxy">, now: number): GateDecision {
	const pathname = canonicalPath(input.uri);
	if (pathname === null || !input.method) return bare(400);
	const isApi = pathname.startsWith("/api/");
	const owner = (scope: GateScope) => ({ status: 200 as const, upstream: config.ownerUpstream, gateSecret: config.ownerGateSecret, scope });

	// 1. Never from outside.
	if (isInternalPath(pathname)) return jsonRefusal(404, { error: "Not found." });

	// 2. A desktop app: sorted by the tag in its key, never by a cookie. The
	//    copy checks the key itself; a 5xx keeps the app's key, a 401
	//    not_paired makes it drop it.
	if (isSyncPath(pathname)) {
		if (state === null) return jsonRefusal(503, { error: DAMAGED_TEXT });
		const read = tagFromDeviceKey(bearerKey(new Headers(input.authorization ? { authorization: input.authorization } : {})));
		if (!read.ok) return jsonRefusal(401, NOT_PAIRED_BODY);
		if (read.tag === null) {
			// An older 43-character key is the owner's copy's, claimed or not
			// (a PC paired before the gateway keeps working through the switch).
			const ownerAccount = findAccountByTag(state, null);
			return ownerAccount?.unpairPending ? bare(503) : owner("sync");
		}
		// No owner: the file is new or was lost. A tagged key may belong to an
		// account this file has forgotten; 503 keeps that PC's key (401 would drop it).
		if (!hasOwner(state)) return bare(503);
		const account = findAccountByTag(state, read.tag);
		if (!account || account.role === "owner" || account.state === "deleting") return jsonRefusal(401, NOT_PAIRED_BODY);
		const copy = copyOf(account, config);
		if (account.state !== "active" || !copy || account.unpairPending) return bare(503);
		return { status: 200, ...copy, scope: "sync" };
	}

	// 3. Icons and static build files, signed in or not.
	if (isPublicFile(pathname)) return owner("public");

	// 4. A write from another site.
	if (!sameOrigin(input.method, input)) return jsonRefusal(403, { error: SAME_SITE_REFUSAL });

	if (state === null) {
		return isApi ? jsonRefusal(503, { error: DAMAGED_TEXT }) : { status: 503, headers: { ...NO_STORE, "Content-Type": "text/plain; charset=utf-8" }, body: DAMAGED_TEXT };
	}

	// 5. A signed-in browser: only its own account's copy.
	const found = resolveSession(state, readCookie(input.cookie), now);
	const copy = found ? copyOf(found.account, config) : null;
	if (found && copy) return { status: 200, ...copy, scope: "session", touch: found.session.id };

	// 6. Sign in first.
	if (isApi) return jsonRefusal(401, { error: SIGN_IN_FIRST });
	const to = hasOwner(state) ? "/login" : "/setup";
	const base = publicBase(input.host, input.proto, config.trustProxy);
	return { status: 303, headers: { ...NO_STORE, Location: base ? new URL(to, base).href : to }, body: "" };
}

/** The forwarded request's facts from the headers Caddy's forward_auth sends. */
export function gateInputFrom(headers: Headers): GateInput {
	return {
		method: headers.get("x-forwarded-method"),
		uri: headers.get("x-forwarded-uri"),
		host: headers.get("host"),
		cookie: headers.get("cookie"),
		authorization: headers.get("authorization"),
		origin: headers.get("origin"),
		fetchSite: headers.get("sec-fetch-site"),
		proto: headers.get("x-forwarded-proto"),
	};
}
