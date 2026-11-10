/**
 * Routes for Claude sign-in on the cloud server (src/server/claude-login.ts).
 * Server mode only (404 otherwise). The login gate (proxy.ts) already
 * requires a signed-in LearnHarness session and a same-site Origin for
 * writes; these also require the app's own request header, like the other
 * Claude Code route, and never return the sign-in link itself: the page
 * navigates to /api/claude-code/login/open, a one-use 303 redirect.
 *
 *   GET  /api/claude-code/login           → { login, signedIn }
 *   POST /api/claude-code/login {op}      → start | code | cancel | logout
 *   GET  /api/claude-code/login/open?id=  → 303 to Claude's sign-in page
 */

import { claudeLogin } from "./claude-login.ts";
import { serverModeEnabled } from "./server-auth.ts";

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" } as const;

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: HEADERS });
}

function appRequest(request: Request): boolean {
	return request.headers.get("x-learnharness-claude-code") === "1" && request.headers.get("sec-fetch-site") !== "cross-site";
}

export async function claudeLoginStatusResponse(request: Request): Promise<Response> {
	if (!serverModeEnabled()) return json({ error: "Not found." }, 404);
	if (!appRequest(request)) return json({ error: "Claude sign-in requires a LearnHarness request." }, 403);
	const login = claudeLogin();
	return json({ login: login.view(), signedIn: await login.signedIn() });
}

export async function claudeLoginControlResponse(request: Request): Promise<Response> {
	if (!serverModeEnabled()) return json({ error: "Not found." }, 404);
	if (!appRequest(request)) return json({ error: "Claude sign-in requires a LearnHarness request." }, 403);
	if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return json({ error: "Expected JSON." }, 415);
	const text = await request.text();
	if (text.length > 8192) return json({ error: "Request too large." }, 413);
	let body: Record<string, unknown>;
	try {
		const parsed = JSON.parse(text) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
		body = parsed as Record<string, unknown>;
	} catch {
		return json({ error: "Expected JSON." }, 400);
	}
	const login = claudeLogin();
	switch (body.op) {
		case "start": return json({ login: login.start() });
		case "code": {
			const result = login.submitCode(body.attemptId, body.code);
			return "phase" in result ? json({ login: result }) : json({ error: result.error }, 400);
		}
		case "cancel": return json({ login: login.cancel() });
		case "logout": {
			const ok = await login.logout();
			return ok ? json({ login: login.view(), signedIn: false }) : json({ error: "Claude Code couldn't sign out on this server. Try again." }, 500);
		}
		default: return json({ error: "Unsupported action." }, 400);
	}
}

export function claudeLoginOpenResponse(request: Request): Response {
	if (!serverModeEnabled()) return json({ error: "Not found." }, 404);
	if (request.headers.get("sec-fetch-site") === "cross-site") return json({ error: "Open sign-in from LearnHarness." }, 403);
	const id = new URL(request.url).searchParams.get("id");
	const target = id && /^[0-9a-f-]{36}$/.test(id) ? claudeLogin().takeLink(id) : null;
	if (!target) return new Response("This sign-in link has already been used or has expired. Go back to LearnHarness and press Sign in to Claude again.", { status: 410, headers: { ...HEADERS, "Content-Type": "text/plain; charset=utf-8" } });
	return new Response(null, { status: 303, headers: { ...HEADERS, Location: target } });
}
