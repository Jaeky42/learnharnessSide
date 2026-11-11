/**
 * Routes for the Obsidian vault on the cloud server (src/server/obsidian-sync.ts).
 * Server mode only (404 otherwise). The login gate (proxy.ts) already
 * requires a signed-in LearnHarness session and a same-site Origin for
 * writes; these also require the app's own request header.
 *
 *   GET  /api/obsidian        → the view (phase, account, vault, sync, left out)
 *   POST /api/obsidian {op}   → sign-in | sign-out | vaults | connect | disconnect | retry
 *
 * A sign-in body carries the Obsidian password and a connect body the
 * vault's encryption password. Both go straight to ob's input; neither is
 * logged, stored or echoed back.
 */

import { obsidianSync } from "./obsidian-sync.ts";
import { serverModeEnabled } from "./server-auth.ts";

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" } as const;

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: HEADERS });
}

function appRequest(request: Request): boolean {
	return request.headers.get("x-learnharness-obsidian") === "1" && request.headers.get("sec-fetch-site") !== "cross-site";
}

/** The manager, started if the server's start hook hasn't done it yet. */
function started() {
	const manager = obsidianSync();
	void manager.boot().catch(() => undefined);
	return manager;
}

export function obsidianStatusResponse(request: Request): Response {
	if (!serverModeEnabled()) return json({ error: "Not found." }, 404);
	if (!appRequest(request)) return json({ error: "This needs a LearnHarness request." }, 403);
	return json({ obsidian: started().view() });
}

export async function obsidianControlResponse(request: Request): Promise<Response> {
	if (!serverModeEnabled()) return json({ error: "Not found." }, 404);
	if (!appRequest(request)) return json({ error: "This needs a LearnHarness request." }, 403);
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
	const manager = started();
	switch (body.op) {
		case "sign-in": {
			const result = await manager.signIn(body.email, body.password, body.code);
			return result.ok ? json({ obsidian: manager.view() }) : json({ error: result.error, detail: result.detail ?? null, obsidian: manager.view() }, 400);
		}
		case "sign-out": {
			const result = await manager.signOut();
			return result.ok ? json({ obsidian: manager.view() }) : json({ error: result.error, obsidian: manager.view() }, 400);
		}
		case "vaults": {
			const result = await manager.vaults();
			return result.ok ? json({ vaults: result.vaults, obsidian: manager.view() }) : json({ error: result.error, obsidian: manager.view() }, 400);
		}
		case "connect": {
			const result = await manager.connect(body.vaultId, body.password);
			return result.ok ? json({ obsidian: manager.view() }) : json({ error: result.error, obsidian: manager.view() }, 400);
		}
		case "disconnect": {
			const result = await manager.disconnect(body.force);
			if (result.ok) return json({ obsidian: manager.view() });
			return json({ error: result.error, unsynced: result.unsynced === true, obsidian: manager.view() }, result.unsynced ? 409 : 400);
		}
		case "retry": {
			await manager.retry();
			return json({ obsidian: manager.view() });
		}
		default: return json({ error: "Unsupported action." }, 400);
	}
}
