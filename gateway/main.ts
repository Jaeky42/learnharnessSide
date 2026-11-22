/**
 * The gateway program (docs/fork/plans/multi-account-plan.md "The pieces"): accounts,
 * sign-in sessions and `/gate`, which tells Caddy whose copy each request
 * belongs to. Plain node:http, no Next, no dependencies; bundled into one
 * file by scripts/build-gateway.mjs and started as `lh-gateway`. Only Caddy
 * can reach it (the `front` network).
 *
 *   lh-gateway               serve (PORT, default 9000)
 *   lh-gateway reset-owner   the owner's last way back in (./control.ts)
 *
 * At a start with no owner yet it prints a one-time setup code to its log,
 * as the single-copy server does today.
 */

import http from "node:http";
import { pathToFileURL } from "node:url";
import { hasOwner, issueSetupCode } from "../src/core/accounts.ts";
import { ACCOUNT_ROUTES, type AccountDeps } from "./account-routes.ts";
import { ConfigError, loadConfig, type GatewayConfig } from "./config.ts";
import { CONTROL_PATH, controlRoute, resetOwnerCommand } from "./control.ts";
import { createRelay, createUnpairer, type Relay, type Unpairer } from "./copies.ts";
import { NO_STORE } from "./gate.ts";
import { createLifecycle, type Lifecycle } from "./lifecycle.ts";
import { createMakerClient, NO_MAKER, type MakerClient } from "./maker-client.ts";
import { OWNER_ROUTES } from "./owner-routes.ts";
import { BASE_ROUTES, handleRequest, type RouteTable } from "./routes.ts";
import { createStore, damagedLine, StateDamagedError, type GatewayStore } from "./state.ts";

/** Every route the gateway serves. */
export const ALL_ROUTES: RouteTable<AccountDeps> = { ...BASE_ROUTES, ...ACCOUNT_ROUTES, ...OWNER_ROUTES };

/** Every request body the gateway takes is small (sign-in, a pairing code). */
export const BODY_LIMIT_BYTES = 16 * 1024;
const HEADERS_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const KEEP_ALIVE_TIMEOUT_MS = 5_000;
/**
 * At SIGTERM the gateway stops taking requests and waits this long for the
 * ones under way and the lifecycle's steps (a redeem's maker call can take
 * ~60 s; its answer must be saved, or the reservation is left half made).
 * Compose gives the container 90 s.
 */
export const SHUTDOWN_GRACE_MS = 75_000;

/** Requests under way, and whether the gateway is shutting down. */
export class RequestTracker {
	active = 0;
	closing = false;
	private waiters: Array<() => void> = [];
	enter(): void { this.active += 1; }
	leave(): void {
		this.active -= 1;
		if (this.active === 0) for (const wake of this.waiters.splice(0)) wake();
	}
	idle(): Promise<void> {
		return this.active === 0 ? Promise.resolve() : new Promise((resolve) => { this.waiters.push(resolve); });
	}
}

/** Today's lines (src/server/server-auth.ts `announceSetupCode`), the code fresh at every start while no owner exists. */
export function announceSetupCode(store: GatewayStore, log: (line: string) => void = console.log): void {
	try {
		const code = store.update((state) => {
			if (hasOwner(state)) return { state: null, result: null };
			const issued = issueSetupCode(state);
			return issued.ok ? { state: issued.state, result: issued.code } : { state: null, result: null };
		});
		if (code) {
			log("[LearnHarness] No password is set yet.");
			log(`[LearnHarness] Setup code: ${code}`);
			log("[LearnHarness] Open the site, enter this code and choose a password.");
		}
	} catch (error) {
		if (error instanceof StateDamagedError) log(`[LearnHarness gateway] ${damagedLine(store.file)}`);
		else log("[LearnHarness gateway] The state file couldn't be written.");
	}
}

class TooLarge extends Error {}

async function readLimited(req: http.IncomingMessage, limit: number): Promise<Buffer> {
	const declared = Number(req.headers["content-length"] ?? "0");
	if (Number.isFinite(declared) && declared > limit) throw new TooLarge();
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > limit) throw new TooLarge();
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks);
}

/** Two Authorization lines: whose key would count is ambiguous, so the request is refused (400). */
class DuplicateHeader extends Error {}

/**
 * The request's headers. Several Cookie lines (HTTP/1.1 allows them; HTTP/2
 * crumbs reach us joined) are joined with "; ", as one Cookie header reads;
 * a session cookie named twice still reads as none (gate.ts `readCookie`).
 */
export function toHeaders(rawHeaders: string[]): Headers {
	const headers = new Headers();
	const cookies: string[] = [];
	let authorizations = 0;
	for (let i = 0; i < rawHeaders.length; i += 2) {
		const name = rawHeaders[i]!;
		const value = rawHeaders[i + 1]!;
		const lower = name.toLowerCase();
		if (lower === "cookie") { cookies.push(value); continue; }
		if (lower === "authorization" && ++authorizations > 1) throw new DuplicateHeader();
		try { headers.append(name, value); } catch { /* a header fetch can't carry */ }
	}
	if (cookies.length) {
		try { headers.set("cookie", cookies.join("; ")); } catch { /* as above */ }
	}
	return headers;
}

async function send(res: http.ServerResponse, response: Response, head: boolean): Promise<void> {
	const cookies = response.headers.getSetCookie();
	for (const [name, value] of response.headers) {
		if (name !== "set-cookie") res.setHeader(name, value);
	}
	if (cookies.length) res.setHeader("set-cookie", cookies);
	res.statusCode = response.status;
	const body = head || response.body === null ? null : Buffer.from(await response.arrayBuffer());
	res.end(body ?? undefined);
}

/** The listener; `handle` is the route table's dispatcher, told the connection's own address. */
export function createServer(handle: (request: Request, info: { remoteAddress: string | undefined }) => Promise<Response>, tracker: RequestTracker = new RequestTracker()): http.Server {
	const server = http.createServer((req, res) => {
		if (tracker.closing) {
			// Shutting down: nothing new starts (Caddy retries or shows its error).
			res.writeHead(503, { ...NO_STORE, Connection: "close" });
			res.end();
			return;
		}
		tracker.enter();
		void (async () => {
			const head = req.method === "HEAD";
			try {
				const method = req.method ?? "GET";
				const body = method === "GET" || method === "HEAD" ? undefined : await readLimited(req, BODY_LIMIT_BYTES);
				// The path is the gateway's own: the request's Host never decides where it is routed.
				const url = new URL(req.url ?? "/", "http://gateway.invalid");
				const request = new Request(url, { method, headers: toHeaders(req.rawHeaders), body: body && body.length ? new Uint8Array(body) : undefined });
				const response = await handle(request, { remoteAddress: req.socket.remoteAddress });
				if (tracker.closing) res.setHeader("Connection", "close");
				await send(res, response, head);
			} catch (error) {
				const status = error instanceof TooLarge ? 413 : 400;
				if (!res.headersSent) {
					res.writeHead(status, { ...NO_STORE, "Content-Type": "application/json", Connection: "close" });
					res.end(status === 413 ? JSON.stringify({ error: "Expected JSON." }) : undefined);
				} else {
					res.destroy();
				}
			} finally {
				tracker.leave();
			}
		})();
	});
	server.headersTimeout = HEADERS_TIMEOUT_MS;
	server.requestTimeout = REQUEST_TIMEOUT_MS;
	server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
	return server;
}

export interface Gateway {
	server: http.Server;
	deps: AccountDeps;
	stop(): Promise<void>;
	/**
	 * Shutting down: no new connection or request is taken, the requests under
	 * way and the lifecycle's queued steps finish (at most `limitMs`), then
	 * every connection is closed. True when everything finished in time.
	 */
	drain(limitMs?: number): Promise<boolean>;
}

export interface GatewayOptions {
	relay?: Relay;
	unpairer?: Unpairer;
	maker?: MakerClient;
	lifecycle?: Lifecycle;
	routes?: RouteTable<AccountDeps>;
	log?: (line: string) => void;
	now?: () => number;
	listen?: boolean;
	/** The lifecycle loop's timer (default: on when a maker is configured). */
	loop?: boolean;
}

/** Builds and starts the gateway (tests pass a stand-in relay and port 0). */
export async function startGateway(config: GatewayConfig, options: GatewayOptions = {}): Promise<Gateway> {
	const log = options.log ?? ((line: string) => console.log(line));
	const now = options.now ?? Date.now;
	const store = createStore(config.stateFile);
	const relay = options.relay ?? createRelay(config);
	const unpairer = options.unpairer ?? createUnpairer({ store, relay, config, log });
	const maker = options.maker ?? createMakerClient(config);
	const lifecycle = options.lifecycle ?? createLifecycle({ store, maker, unpairer, config, now, log });
	const deps: AccountDeps = { store, config, relay, unpairer, lifecycle, now, log };
	announceSetupCode(store, log);
	const stopRetries = unpairer.start();
	const stopLoop = (options.loop ?? maker !== NO_MAKER) ? lifecycle.start() : () => undefined;
	const routes = options.routes ?? ALL_ROUTES;
	const tracker = new RequestTracker();
	const server = createServer((request, info) =>
		new URL(request.url).pathname === CONTROL_PATH ? controlRoute(request, deps, info.remoteAddress) : handleRequest(request, deps, routes), tracker);
	if (options.listen !== false) await new Promise<void>((resolve) => server.listen(config.port, resolve));
	return {
		server, deps,
		stop: () => new Promise<void>((resolve) => {
			stopRetries();
			stopLoop();
			server.close(() => resolve());
			server.closeIdleConnections?.();
		}),
		async drain(limitMs = SHUTDOWN_GRACE_MS) {
			tracker.closing = true;
			stopRetries();
			stopLoop();
			server.close(() => undefined);
			server.closeIdleConnections?.();
			const settled = (async () => {
				// A request can queue a lifecycle step and a step can outlive its request: wait for both, twice over.
				await tracker.idle();
				await lifecycle.idle();
				await tracker.idle();
				return true;
			})();
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finished = await Promise.race([settled, new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), limitMs); })]);
			clearTimeout(timer);
			server.closeAllConnections?.();
			return finished;
		},
	};
}

/** Sub-commands (`lh-gateway <name>`). */
export const SUBCOMMANDS: Record<string, (args: string[]) => Promise<number>> = {
	"reset-owner": () => resetOwnerCommand(),
};

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
	const [command, ...args] = argv;
	if (command !== undefined) {
		const run = Object.hasOwn(SUBCOMMANDS, command) ? SUBCOMMANDS[command] : undefined;
		if (!run) {
			console.error(`lh-gateway: unknown command. Commands: ${Object.keys(SUBCOMMANDS).join(", ")}.`);
			return 2;
		}
		return run(args);
	}
	let config: GatewayConfig;
	try {
		config = loadConfig();
	} catch (error) {
		if (error instanceof ConfigError) {
			console.error(`[LearnHarness gateway] Not started: ${error.message}`);
			return 1;
		}
		throw error;
	}
	const gateway = await startGateway(config);
	console.log(`[LearnHarness gateway] Listening on port ${config.port}.`);
	const stop = () => {
		setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS + 5_000).unref();
		void gateway.drain(SHUTDOWN_GRACE_MS).then((finished) => {
			if (!finished) console.log("[LearnHarness gateway] Stopped with work still under way.");
			process.exit(0);
		});
	};
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	return new Promise<number>(() => { /* runs until a signal */ });
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
	void main().then((code) => process.exit(code));
}
