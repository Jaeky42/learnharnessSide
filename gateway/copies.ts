/**
 * Talking to a copy. The gateway shares no network with any copy; it goes
 * through Caddy's internal relay (deploy/Caddyfile, `http://:9200`): the
 * relay token opens it, X-LH-Upstream names the copy, X-LH-Gate is that
 * copy's secret, and X-LH-Client-Addr becomes the copy's X-Forwarded-For (the
 * real client's address, for the copy's own lockout).
 *
 * Every relay call names its scope (X-LH-Scope: `sync` for a forwarded
 * pairing, `internal` for unpair-all), which the copy checks again.
 *
 * Also the unpairer: after a password change, either reset, or Sign out
 * everywhere the account's copy must forget its desktop apps
 * (POST /api/internal/unpair-all). Pause and Remove don't unpair: a paused
 * or removed account's PC gets 503 and keeps its key, so it carries on after
 * Resume or Restore. The account is marked `unpairPending` in
 * the same write as the change itself, so a crash or an unreachable copy is
 * retried (at start and on a timer); while it is marked, the gate answers
 * that account's sync requests 503 and new pairings are refused. A pairing
 * already forwarded when the mark is set could reach the copy after the
 * unpair-all and survive it, so unpair-all waits until that account's
 * forwards in flight have ended.
 */

import {
	clearUnpairPending,
	findAccount,
	markUnpairPending,
	unpairPendingAccounts,
} from "../src/core/accounts.ts";
import type { GatewayConfig } from "./config.ts";
import { copyOf, type RelayScope } from "./gate.ts";
import type { GatewayStore } from "./state.ts";

export const RELAY_TIMEOUT_MS = 15_000;
/** The most of a copy's or the maker's answer the gateway reads. */
export const ANSWER_LIMIT_BYTES = 64 * 1024;

export class AnswerTooLarge extends Error {
	constructor() { super("The answer is too large."); }
}

/** Reads a body of at most `limit` bytes; beyond it the rest is cancelled and AnswerTooLarge thrown. */
export async function readCapped(response: Response, limit = ANSWER_LIMIT_BYTES): Promise<Uint8Array<ArrayBuffer>> {
	const declared = Number(response.headers.get("content-length") ?? "");
	if (Number.isFinite(declared) && declared > limit) {
		await response.body?.cancel().catch(() => undefined);
		throw new AnswerTooLarge();
	}
	if (!response.body) return new Uint8Array(new ArrayBuffer(0));
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > limit) {
			await reader.cancel().catch(() => undefined);
			throw new AnswerTooLarge();
		}
		chunks.push(value);
	}
	const out = new Uint8Array(new ArrayBuffer(size));
	let at = 0;
	for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength; }
	return out;
}
export const UNPAIR_RETRY_MS = 60_000;
const UPSTREAM = /^[A-Za-z0-9.-]+:\d{1,5}$/;

export interface RelayRequest {
	upstream: string;
	gateSecret: string;
	/** The real client's address; omitted for the gateway's own calls. */
	clientAddress?: string;
	method: "GET" | "POST";
	/** Why this call may reach the copy (X-LH-Scope). */
	scope: RelayScope;
	/** Path and query on the copy. */
	path: string;
	headers?: Record<string, string>;
	body?: Uint8Array | string;
}

export interface Relay {
	/** The copy's answer; throws when the relay or the copy can't be reached. */
	send(request: RelayRequest): Promise<Response>;
}

export function createRelay(config: Pick<GatewayConfig, "relayUrl" | "relayToken">, fetchImpl: typeof fetch = fetch, timeoutMs = RELAY_TIMEOUT_MS): Relay {
	return {
		async send(request) {
			if (!UPSTREAM.test(request.upstream)) throw new Error("Invalid upstream.");
			if (!request.path.startsWith("/") || request.path.startsWith("//")) throw new Error("Invalid path.");
			const headers = new Headers(request.headers ?? {});
			headers.set("x-lh-relay", config.relayToken);
			headers.set("x-lh-upstream", request.upstream);
			headers.set("x-lh-gate", request.gateSecret);
			headers.set("x-lh-scope", request.scope);
			if (request.clientAddress) headers.set("x-lh-client-addr", request.clientAddress);
			return fetchImpl(`${config.relayUrl}${request.path}`, {
				method: request.method,
				headers,
				body: request.body === undefined ? undefined : (request.body as BodyInit),
				redirect: "manual",
				signal: AbortSignal.timeout(timeoutMs),
			});
		},
	};
}

export interface Unpairer {
	/**
	 * A pairing forward to this account's copy starts; call the returned
	 * function when it has ended. Unpair-all for the account waits for it.
	 */
	beginPairing(accountId: string): () => void;
	/** Marks the account and tries at once. True when the copy confirmed. */
	requestUnpair(accountId: string): Promise<boolean>;
	/** One try for an account already marked. */
	attempt(accountId: string): Promise<boolean>;
	/** One try for every marked account. */
	retryPending(): Promise<void>;
	/** Retries now and then every `intervalMs`; returns a stop function. */
	start(intervalMs?: number): () => void;
}

export function createUnpairer(deps: { store: GatewayStore; relay: Relay; config: Pick<GatewayConfig, "ownerUpstream" | "ownerGateSecret">; log?: (line: string) => void }): Unpairer {
	const log = deps.log ?? ((line: string) => console.error(line));
	const inFlight = new Map<string, Promise<boolean>>();
	const complained = new Set<string>();
	const pairings = new Map<string, { count: number; waiters: Array<() => void> }>();

	const pairingsEnded = (accountId: string): Promise<void> => {
		const entry = pairings.get(accountId);
		if (!entry || entry.count === 0) return Promise.resolve();
		return new Promise<void>((resolve) => entry.waiters.push(resolve));
	};

	const clear = (accountId: string): void => {
		deps.store.update((state) => ({ state: clearUnpairPending(state, accountId), result: undefined }));
	};

	async function once(accountId: string): Promise<boolean> {
		const read = deps.store.read();
		if (!read.ok) return false;
		const account = findAccount(read.state, accountId);
		if (!account || !account.unpairPending) return true;
		const copy = copyOf(account, deps.config);
		// A copy that was never made has no desktop apps to forget.
		if (!copy) { clear(accountId); return true; }
		await pairingsEnded(accountId);
		let ok = false;
		try {
			const response = await deps.relay.send({ ...copy, scope: "internal", method: "POST", path: "/api/internal/unpair-all", headers: { "content-type": "application/json" }, body: "{}" });
			ok = response.ok;
			await response.body?.cancel().catch(() => undefined);
		} catch { ok = false; }
		if (!ok) {
			if (!complained.has(accountId)) log(`[LearnHarness gateway] The copy of account ${accountId} couldn't be told to unpair its desktop apps; trying again.`);
			complained.add(accountId);
			return false;
		}
		complained.delete(accountId);
		try { clear(accountId); } catch { return false; }
		return true;
	}

	const attempt = (accountId: string): Promise<boolean> => {
		const running = inFlight.get(accountId);
		if (running) return running;
		const run = once(accountId).catch(() => false).finally(() => inFlight.delete(accountId));
		inFlight.set(accountId, run);
		return run;
	};

	return {
		attempt,
		beginPairing(accountId) {
			const entry = pairings.get(accountId) ?? { count: 0, waiters: [] };
			entry.count += 1;
			pairings.set(accountId, entry);
			let ended = false;
			return () => {
				if (ended) return;
				ended = true;
				entry.count -= 1;
				if (entry.count > 0) return;
				pairings.delete(accountId);
				for (const wake of entry.waiters.splice(0)) wake();
			};
		},
		async requestUnpair(accountId) {
			deps.store.update((state) => ({ state: markUnpairPending(state, accountId), result: undefined }));
			return attempt(accountId);
		},
		async retryPending() {
			const read = deps.store.read();
			if (!read.ok) return;
			await Promise.all(unpairPendingAccounts(read.state).map((a) => attempt(a.id)));
		},
		start(intervalMs = UNPAIR_RETRY_MS) {
			void this.retryPending();
			const timer = setInterval(() => { void this.retryPending(); }, intervalMs);
			timer.unref?.();
			return () => clearInterval(timer);
		},
	};
}
