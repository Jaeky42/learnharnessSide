/**
 * The gateway's side of the maker's API (gateway/maker.ts; docs/multi-account-build.md
 * "The maker's API"). Bearer LH_MAKER_TOKEN, plain fetch, a timeout on every call.
 *
 * Outcomes the callers act on:
 *   - "missing"  start/stop of a container that isn't there (404 no_copy);
 *   - "in-use"   a volume still used by a container (409; retry later);
 *   - MakerUnavailable  no answer, a timeout, or a 5xx (the maker is busy,
 *                restarting or shutting down for an update): try again later,
 *                and never read it as "the copy doesn't exist". After a
 *                POST /copies that ended this way a container may exist with
 *                a secret the gateway never saw.
 *   - MakerRefused  a 4xx the gateway shouldn't cause (a bad token or tag).
 *
 * Never logs; never puts the token or a secret into an error message.
 */

import type { GatewayConfig } from "./config.ts";

export const MAKER_CREATE_TIMEOUT_MS = 60_000;
export const MAKER_CALL_TIMEOUT_MS = 20_000;

const UPSTREAM = /^[A-Za-z0-9.-]+:\d{1,5}$/;
const SECRET = /^[A-Za-z0-9_-]{32,128}$/;
const TAG = /^[0-9A-HJKMNP-TV-Z]{3}$/;

export class MakerUnavailable extends Error {
	constructor(what: string) { super(`The maker didn't answer (${what}).`); }
}

export class MakerRefused extends Error {
	constructor(what: string, readonly status: number) { super(`The maker refused ${what} (${status}).`); }
}

export interface CopySummary {
	tag: string;
	/** Docker's state: "running", "exited", "created", "restarting", ... */
	state: string;
	image: string;
	upToDate: boolean;
}

export interface MakerClient {
	createCopy(tag: string, options?: { start?: boolean }): Promise<{ upstream: string; gateSecret: string }>;
	stopCopy(tag: string): Promise<"ok" | "missing">;
	startCopy(tag: string): Promise<"ok" | "missing">;
	/** Container and network; the volume stays. Idempotent. */
	removeCopy(tag: string): Promise<void>;
	/** The final deletion. Idempotent when the volume is already gone. */
	removeVolume(tag: string): Promise<"ok" | "in-use">;
	listCopies(): Promise<CopySummary[]>;
}

/** A maker that was never configured: every call is "not available". */
export const NO_MAKER: MakerClient = {
	createCopy: async () => { throw new MakerUnavailable("not configured"); },
	stopCopy: async () => { throw new MakerUnavailable("not configured"); },
	startCopy: async () => { throw new MakerUnavailable("not configured"); },
	removeCopy: async () => { throw new MakerUnavailable("not configured"); },
	removeVolume: async () => { throw new MakerUnavailable("not configured"); },
	listCopies: async () => { throw new MakerUnavailable("not configured"); },
};

function checkTag(tag: string): string {
	if (!TAG.test(tag)) throw new MakerRefused("an invalid tag", 400);
	return tag;
}

export function createMakerClient(config: Pick<GatewayConfig, "makerUrl" | "makerToken">, fetchImpl: typeof fetch = fetch, timeouts: { create?: number; call?: number } = {}): MakerClient {
	if (!config.makerUrl || !config.makerToken) return NO_MAKER;
	const base = config.makerUrl;
	const token = config.makerToken;
	const createTimeout = timeouts.create ?? MAKER_CREATE_TIMEOUT_MS;
	const callTimeout = timeouts.call ?? MAKER_CALL_TIMEOUT_MS;

	async function call(method: "GET" | "POST" | "DELETE", path: string, what: string, body?: unknown, timeoutMs = callTimeout): Promise<{ status: number; data: unknown }> {
		let response: Response;
		try {
			response = await fetchImpl(`${base}${path}`, {
				method,
				headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
				body: body === undefined ? undefined : JSON.stringify(body),
				redirect: "manual",
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch {
			throw new MakerUnavailable(what);
		}
		let data: unknown = null;
		try { data = await response.json(); } catch { data = null; }
		if (response.status >= 500) throw new MakerUnavailable(`${what}: ${response.status}`);
		return { status: response.status, data };
	}

	const codeOf = (data: unknown): string | null => (data && typeof data === "object" && typeof (data as { code?: unknown }).code === "string" ? (data as { code: string }).code : null);

	return {
		async createCopy(tag, options = {}) {
			const body = options.start === false ? { tag: checkTag(tag), start: false } : { tag: checkTag(tag) };
			const { status, data } = await call("POST", "/copies", "create", body, createTimeout);
			if (status !== 200) throw new MakerRefused("create", status);
			const answer = data as { upstream?: unknown; gateSecret?: unknown } | null;
			if (!answer || typeof answer.upstream !== "string" || !UPSTREAM.test(answer.upstream) || typeof answer.gateSecret !== "string" || !SECRET.test(answer.gateSecret)) {
				// A 200 we can't read: the container may exist; treat it like no answer.
				throw new MakerUnavailable("create: unreadable answer");
			}
			return { upstream: answer.upstream, gateSecret: answer.gateSecret };
		},
		async stopCopy(tag) {
			const { status, data } = await call("POST", `/copies/${checkTag(tag)}/stop`, "stop");
			if (status === 200) return "ok";
			if (status === 404 && codeOf(data) === "no_copy") return "missing";
			throw new MakerRefused("stop", status);
		},
		async startCopy(tag) {
			const { status, data } = await call("POST", `/copies/${checkTag(tag)}/start`, "start");
			if (status === 200) return "ok";
			if (status === 404 && codeOf(data) === "no_copy") return "missing";
			throw new MakerRefused("start", status);
		},
		async removeCopy(tag) {
			const { status } = await call("DELETE", `/copies/${checkTag(tag)}`, "remove");
			if (status !== 200) throw new MakerRefused("remove", status);
		},
		async removeVolume(tag) {
			const { status } = await call("DELETE", `/volumes/${checkTag(tag)}`, "delete volume");
			if (status === 200) return "ok";
			if (status === 409) return "in-use";
			throw new MakerRefused("delete volume", status);
		},
		async listCopies() {
			const { status, data } = await call("GET", "/copies", "list");
			if (status !== 200 || !Array.isArray(data)) throw new MakerRefused("list", status);
			return data.flatMap((item): CopySummary[] => {
				if (!item || typeof item !== "object") return [];
				const { tag, state, image, upToDate } = item as Record<string, unknown>;
				if (typeof tag !== "string" || !TAG.test(tag) || typeof state !== "string") return [];
				return [{ tag, state, image: typeof image === "string" ? image : "", upToDate: upToDate === true }];
			});
		},
	};
}
