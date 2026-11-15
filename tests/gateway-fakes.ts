/**
 * Stand-ins shared by the gateway's lifecycle tests (tests/gateway-accounts,
 * -invite, -reset, -lifecycle): an in-memory maker behind the real maker
 * client (the real API's paths and statuses; any call can fail, lose its
 * answer after doing its work, or hang), a relay standing in for Caddy, and
 * a harness around the real store, unpairer, lifecycle and routes.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as path from "node:path";

import * as acc from "../src/core/accounts.ts";
import * as core from "../src/core/server-auth.ts";
import type { AccountDeps } from "../gateway/account-routes.ts";
import type { GatewayConfig } from "../gateway/config.ts";
import { createUnpairer, type RelayRequest } from "../gateway/copies.ts";
import { createLifecycle } from "../gateway/lifecycle.ts";
import { ALL_ROUTES, announceSetupCode } from "../gateway/main.ts";
import { createMakerClient } from "../gateway/maker-client.ts";
import { handleRequest } from "../gateway/routes.ts";
import { createStore, readStateFile } from "../gateway/state.ts";

export const MIN = 60 * 1000;
export const DAY = 24 * 60 * MIN;
export const T0 = Date.UTC(2026, 10, 15, 12, 0);
export const HOST = "learn.example.com";
export const ORIGIN = `https://${HOST}`;
export const ADDR = "203.0.113.7";
export const OWNER_SECRET = "owner-gate-secret-".padEnd(40, "q");
export const RELAY_TOKEN = "relay-token-".padEnd(40, "r");
export const MAKER_TOKEN = "maker-token-".padEnd(40, "m");
export const PASSWORD = "correct horse battery";
export const SAM_PASSWORD = "sams own passphrase";
export const UA = "Mozilla/5.0 (iPhone) Safari/605.1";

// ─── The maker ───────────────────────────────────────────────────────────────

export type FailKind = "503" | "down" | "hang" | "lost";
interface Rule { match: RegExp; kind: FailKind; times: number }

export interface FakeCopy { state: "running" | "exited"; secret: string; image: string }

export class FakeMaker {
	copies = new Map<string, FakeCopy>();
	volumes = new Set<string>();
	/** Every call as "METHOD /path" (+ " start=false" for a stopped create), in order. */
	calls: string[] = [];
	/** Tags left out of GET /copies (a swap under way). */
	hidden = new Set<string>();
	/** Every secret ever handed out. */
	secrets: string[] = [];
	private rules: Rule[] = [];
	private n = 0;

	/** The next `times` calls matching `match` ("POST /copies", "DELETE /volumes/ABC"…) fail this way. */
	fail(match: RegExp, kind: FailKind, times = 1): void { this.rules.push({ match, kind, times }); }
	/** Every call fails this way until `heal()`. */
	breakAll(kind: FailKind = "down"): void { this.rules.push({ match: /.*/, kind, times: Infinity }); }
	heal(): void { this.rules = []; }

	/** A copy made outside the gateway (another tool, a leftover). */
	add(tag: string, state: "running" | "exited" = "running"): void {
		this.copies.set(tag, { state, secret: "x".repeat(43), image: "img-1" });
		this.volumes.add(tag);
	}

	readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		const method = (init?.method ?? "GET").toUpperCase();
		assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${MAKER_TOKEN}`);
		const body = typeof init?.body === "string" ? JSON.parse(init.body) as { tag?: string; start?: boolean } : {};
		const label = `${method} ${url.pathname}${method === "POST" && url.pathname === "/copies" ? ` ${body.tag}${body.start === false ? " start=false" : ""}` : ""}`;
		this.calls.push(label);
		const rule = this.rules.find((r) => r.times > 0 && r.match.test(label));
		if (rule) {
			rule.times -= 1;
			if (rule.kind === "503") return Response.json({ code: "shutting_down" }, { status: 503 });
			if (rule.kind === "down") throw new TypeError("fetch failed");
			if (rule.kind === "hang") {
				return new Promise<Response>((_, reject) => {
					const signal = init?.signal;
					const abort = () => reject(new DOMException("aborted", "TimeoutError"));
					if (signal?.aborted) abort();
					signal?.addEventListener("abort", abort, { once: true });
				});
			}
			this.act(method, url.pathname, body);
			throw new TypeError("fetch failed");
		}
		return this.act(method, url.pathname, body);
	};

	private act(method: string, pathname: string, body: { tag?: string; start?: boolean }): Response {
		if (pathname === "/copies" && method === "GET") {
			return Response.json([...this.copies].filter(([tag]) => !this.hidden.has(tag)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([tag, c]) => ({ tag, state: c.state, image: c.image, upToDate: true })));
		}
		if (pathname === "/copies" && method === "POST") {
			const tag = body.tag!;
			this.n += 1;
			const secret = `S${this.n}`.padEnd(43, "k");
			this.secrets.push(secret);
			this.volumes.add(tag);
			this.copies.set(tag, { state: body.start === false ? "exited" : "running", secret, image: "img-1" });
			return Response.json({ upstream: `lh-acct-${tag}:3000`, gateSecret: secret });
		}
		let m = /^\/copies\/([^/]+)\/(stop|start)$/.exec(pathname);
		if (m && method === "POST") {
			const copy = this.copies.get(m[1]!);
			if (!copy) return Response.json({ code: "no_copy" }, { status: 404 });
			copy.state = m[2] === "stop" ? "exited" : "running";
			return Response.json({ tag: m[1], state: m[2] === "stop" ? "stopped" : "running" });
		}
		m = /^\/copies\/([^/]+)$/.exec(pathname);
		if (m && method === "DELETE") {
			this.copies.delete(m[1]!);
			return Response.json({ tag: m[1], removed: true });
		}
		m = /^\/volumes\/([^/]+)$/.exec(pathname);
		if (m && method === "DELETE") {
			if (this.copies.has(m[1]!)) return Response.json({ code: "volume_in_use" }, { status: 409 });
			const had = this.volumes.delete(m[1]!);
			return Response.json({ tag: m[1], removed: had });
		}
		return Response.json({ code: "not_found" }, { status: 404 });
	}
}

// ─── The harness ─────────────────────────────────────────────────────────────

export interface Harness {
	deps: AccountDeps;
	maker: FakeMaker;
	relayCalls: RelayRequest[];
	/** Set to make the copies unreachable through the relay. */
	relayDown: { value: boolean };
	logs: string[];
	clock: { now: number };
	call(request: Request): Promise<Response>;
	post(pathname: string, body: unknown, headers?: Record<string, string>): Request;
	get(pathname: string, headers?: Record<string, string>): Request;
	gateAsk(uri: string, cookie?: string, extra?: Record<string, string>): Request;
	state(): acc.GatewayState;
	fileText(): string;
	/** First start, claimed as "Boss": the owner's cookie. */
	claimOwner(): Promise<string>;
	/** A member with a ready copy (in the fake maker too), straight into the file. */
	addMember(name: string, tag: string, over?: Partial<acc.AccountRecord>): acc.AccountRecord;
	signIn(name: string, password?: string): Promise<string>;
	ownerOp(cookie: string, body: Record<string, unknown>): Promise<Response>;
}

export const cookiesOf = (response: Response): string[] => response.headers.getSetCookie();
export const sessionFrom = (response: Response): string => cookiesOf(response).find((c) => c.startsWith(`${core.SESSION_COOKIE}=`))!.split(";")[0]!;

export function config(file: string, over: Partial<GatewayConfig> = {}): GatewayConfig {
	return {
		port: 0, stateFile: file, maxAccounts: 4, ownerUpstream: "lh:3000", ownerGateSecret: OWNER_SECRET,
		relayUrl: "http://caddy:9200", relayToken: RELAY_TOKEN, makerUrl: "http://maker:9100", makerToken: MAKER_TOKEN, trustProxy: true,
		...over,
	};
}

/** One real scrypt hash per process, reused for every member put straight into the file. */
let memberHash: core.PasswordHash | null = null;
export const memberPassword = (): core.PasswordHash => (memberHash ??= core.hashPassword(SAM_PASSWORD));

export function harness(root: string, over: Partial<GatewayConfig> = {}): Harness {
	const dir = fs.mkdtempSync(path.join(root, "g-"));
	const clock = { now: T0 };
	const relayCalls: RelayRequest[] = [];
	const relayDown = { value: false };
	const logs: string[] = [];
	const maker = new FakeMaker();
	const store = createStore(path.join(dir, "accounts.json"));
	const cfg = config(store.file, over);
	const relay = {
		send: async (req: RelayRequest) => {
			relayCalls.push(req);
			if (relayDown.value) throw new TypeError("fetch failed");
			return Response.json({ ok: true });
		},
	};
	const log = (line: string) => { logs.push(line); };
	const now = () => clock.now;
	const unpairer = createUnpairer({ store, relay, config: cfg, log });
	const makerClient = createMakerClient(cfg, maker.fetch, { create: 40, call: 40 });
	const lifecycle = createLifecycle({ store, maker: makerClient, unpairer, config: cfg, now, log });
	const deps: AccountDeps = { store, config: cfg, relay, unpairer, lifecycle, now, log };

	const post = (pathname: string, body: unknown, headers: Record<string, string> = {}) => new Request(`http://gateway.invalid${pathname}`, {
		method: "POST",
		headers: { host: HOST, origin: ORIGIN, "content-type": "application/json", "x-forwarded-for": ADDR, "x-forwarded-proto": "https", "user-agent": UA, ...headers },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
	const get = (pathname: string, headers: Record<string, string> = {}) => new Request(`http://gateway.invalid${pathname}`, { headers: { host: HOST, "x-forwarded-for": ADDR, "x-forwarded-proto": "https", "user-agent": UA, ...headers } });
	const call = (request: Request) => handleRequest(request, deps, ALL_ROUTES);

	const h: Harness = {
		deps, maker, relayCalls, relayDown, logs, clock, call, post, get,
		gateAsk: (uri, cookie, extra = {}) => get("/gate", { "x-forwarded-method": "GET", "x-forwarded-uri": uri, ...(cookie ? { cookie } : {}), ...extra }),
		state: () => readStateFile(store.file),
		fileText: () => fs.readFileSync(store.file, "utf-8"),
		async claimOwner() {
			const lines: string[] = [];
			announceSetupCode(store, (l) => lines.push(l));
			const code = lines.find((l) => l.startsWith("[LearnHarness] Setup code: "))!.slice("[LearnHarness] Setup code: ".length);
			const response = await call(post("/api/server-auth/setup", { code, name: "Boss", password: PASSWORD }));
			assert.equal(response.status, 200);
			return sessionFrom(response);
		},
		addMember(name, tag, extra = {}) {
			const record: acc.AccountRecord = {
				id: `acct_${name}`, tag, name, nameKey: name.toLowerCase(), password: memberPassword(), recoveryCodes: [],
				role: "member", state: "active", createdAt: clock.now, lastSeenAt: null, removedAt: null,
				upstream: `lh-acct-${tag}:3000`, gateSecret: `secret-of-${name}`.padEnd(43, "s"), ...extra,
			};
			store.update((state) => ({ state: { ...state, accounts: [...state.accounts, record] }, result: undefined }));
			if (record.state === "active" || record.state === "paused") maker.copies.set(tag, { state: record.state === "active" ? "running" : "exited", secret: record.gateSecret!, image: "img-1" });
			maker.volumes.add(tag);
			return record;
		},
		async signIn(name, password = SAM_PASSWORD) {
			const response = await call(post("/api/server-auth/login", { name, password }));
			assert.equal(response.status, 200, `sign in as ${name}`);
			return sessionFrom(response);
		},
		ownerOp: (cookie, body) => call(post("/api/accounts", body, { cookie })),
	};
	return h;
}
