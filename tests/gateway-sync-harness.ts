/**
 * The in-process world for tests/gateway-sync*.test.ts (multi-account slice
 * 2): the REAL desktop client → a stand-in for Caddy (strips X-LH-*, asks
 * the gateway's /gate, or sends the gateway's own paths to it) → the REAL
 * copy's gate and routes, with the gate secret Caddy would add. The gateway's
 * relay is a stand-in too: it delivers only to the one copy this process
 * plays, and only under that copy's upstream; anything else is unreachable.
 *
 * Load it only after the test file has set LH_AUTH_FILE, LH_DATA_DIR and the
 * copy's variables (a copy's data folder is fixed when its modules load).
 */

import path from "node:path";

const core = await import("../src/core/server-auth.ts");
const server = await import("../src/server/server-auth.ts");
const syncHttp = await import("../src/server/sync/http.ts");
const routes = await import("../gateway/routes.ts");
const { createStore } = await import("../gateway/state.ts");
const { createUnpairer } = await import("../gateway/copies.ts");

type RelayRequest = import("../gateway/copies.ts").RelayRequest;

export const SERVER = "https://learn.example.com";
export const HOST = "learn.example.com";
export const DESKTOP_ADDR = "198.51.100.20";
export const BROWSER_ADDR = "203.0.113.7";
export const OWNER_UPSTREAM = "lh:3000";
export const OWNER_SECRET = "owner-copy-gate-secret-".padEnd(44, "o");
const GATEWAY_PATHS = new Set(["/login", "/setup", "/invite", "/reset", "/manifest.webmanifest", "/api/sync/pair"]);

/** The copy's routes the tests reach. */
async function copyRoutes(request: Request): Promise<Response> {
	const url = new URL(request.url);
	const gated = server.serverGate({ method: request.method, pathname: url.pathname, headers: request.headers, url: request.url, touch: () => {} });
	if (gated) return gated;
	switch (url.pathname) {
		case "/api/sync/pair": return syncHttp.pairResponse(request);
		case "/api/sync/hello": return syncHttp.helloResponse(request);
		case "/api/sync/sessions": return syncHttp.sessionsExchangeResponse(request);
		case "/api/server-auth/desktops": return syncHttp.desktopsResponse(request);
		case "/api/internal/unpair-all": return server.unpairAllResponse(request);
		case "/api/chats": return Response.json({ chats: [] });
		default: return Response.json({ error: "Not found." }, { status: 404 });
	}
}

export interface World {
	deps: import("../gateway/routes.ts").RouteDeps;
	relayCalls: RelayRequest[];
	/** The copy this process plays is reachable through the relay (and from Caddy). */
	copyUp: { value: boolean };
	/** What the desktop app's fetch reaches: Caddy, then the gateway or a copy. */
	desktopFetch: typeof fetch;
	/** A browser's request through Caddy. */
	browser(pathname: string, init?: { method?: string; body?: unknown; cookie?: string }): Promise<Response>;
	/** The copy alone, as before the gateway (single-copy mode). */
	directFetch: typeof fetch;
}

/** `copy`: the one copy this process plays (its upstream and the secret it was started with). */
export function makeWorld(stateDir: string, copy: { upstream: string; secret: string }, now: () => number = Date.now): World {
	const store = createStore(path.join(stateDir, "accounts.json"));
	const relayCalls: RelayRequest[] = [];
	const copyUp = { value: true };
	const config = {
		port: 0, stateFile: store.file, maxAccounts: 4, ownerUpstream: OWNER_UPSTREAM, ownerGateSecret: OWNER_SECRET,
		relayUrl: "http://caddy:9200", relayToken: "relay-token-".padEnd(40, "r"), makerUrl: null, makerToken: null, trustProxy: true,
	};

	/** Delivers to the copy only under its own upstream; the secret is the copy's to check. */
	async function toCopy(upstream: string, request: Request): Promise<Response> {
		if (!copyUp.value || upstream !== copy.upstream) throw new TypeError("fetch failed");
		return copyRoutes(request);
	}

	const relay = {
		async send(req: RelayRequest): Promise<Response> {
			relayCalls.push(req);
			// What Caddy's relay does: X-LH-Gate on, X-Forwarded-For from X-LH-Client-Addr, the rest as sent.
			const headers = new Headers(req.headers ?? {});
			headers.set("host", "caddy:9200");
			headers.set(server.GATE_HEADER, req.gateSecret);
			headers.set("x-forwarded-for", req.clientAddress ?? "");
			return toCopy(req.upstream, new Request(`http://caddy:9200${req.path}`, { method: req.method, headers, body: req.body as BodyInit | undefined }));
		},
	};
	const deps = { store, config, relay, unpairer: createUnpairer({ store, relay, config, log: () => {} }), now, log: () => {} };

	/** Caddy (deploy/Caddyfile, slice 0's proven file): strip, route, forward_auth, proxy. */
	async function caddy(original: Request, address: string): Promise<Response> {
		const url = new URL(original.url);
		const headers = new Headers(original.headers);
		for (const name of ["x-lh-upstream", "x-lh-gate", "x-lh-relay", "x-lh-client-addr"]) headers.delete(name);
		headers.set("host", HOST);
		headers.set("x-forwarded-for", address);
		headers.set("x-forwarded-proto", "https");
		const body = original.method === "GET" || original.method === "HEAD" ? undefined : new Uint8Array(await original.arrayBuffer());
		if (url.pathname.startsWith("/api/internal/")) return new Response(null, { status: 404 });
		const isGateway = GATEWAY_PATHS.has(url.pathname) || (url.pathname.startsWith("/api/server-auth/") && url.pathname !== "/api/server-auth/desktops");
		if (isGateway) return routes.handleRequest(new Request(`http://gateway:9000${url.pathname}${url.search}`, { method: original.method, headers, body }), deps);
		const ask = new Headers(headers);
		ask.set("x-forwarded-method", original.method);
		ask.set("x-forwarded-uri", `${url.pathname}${url.search}`);
		const answer = await routes.handleRequest(new Request("http://gateway:9000/gate", { headers: ask }), deps);
		if (answer.status !== 200) return answer;
		headers.set(server.GATE_HEADER, answer.headers.get("x-lh-gate")!);
		try {
			return await toCopy(answer.headers.get("x-lh-upstream")!, new Request(original.url, { method: original.method, headers, body }));
		} catch {
			return new Response(null, { status: 502 });
		}
	}

	const desktopFetch: typeof fetch = async (input, init) => caddy(new Request(input as string, init), DESKTOP_ADDR);
	const directFetch: typeof fetch = async (input, init) => {
		const original = new Request(input as string, init);
		const headers = new Headers(original.headers);
		headers.set("host", HOST);
		headers.set("x-forwarded-for", DESKTOP_ADDR);
		const body = original.method === "GET" ? undefined : await original.text();
		return copyRoutes(new Request(original.url, { method: original.method, headers, body }));
	};

	async function browser(pathname: string, init: { method?: string; body?: unknown; cookie?: string } = {}): Promise<Response> {
		const method = init.method ?? (init.body === undefined ? "GET" : "POST");
		return caddy(new Request(SERVER + pathname, {
			method,
			headers: {
				"user-agent": "Mozilla/5.0 (Windows) Chrome/140",
				...(method === "GET" ? {} : { origin: SERVER, "content-type": "application/json" }),
				...(init.cookie ? { cookie: init.cookie } : {}),
			},
			body: init.body === undefined ? undefined : JSON.stringify(init.body),
			redirect: "manual",
		}), BROWSER_ADDR);
	}

	return { deps, relayCalls, copyUp, desktopFetch, directFetch, browser };
}

export const sessionCookieOf = (response: Response): string =>
	response.headers.getSetCookie().find((c) => c.startsWith(`${core.SESSION_COOKIE}=`))!.split(";")[0]!;
