/**
 * Cloud sync (Phase 5): the app's OWN control route, /api/cloud. The Phase 6
 * screens will call it; until then only tests do.
 *
 *   GET                          what this copy is (the cloud server, or a
 *                                desktop) and, for a desktop, its sync state
 *   POST {op:"pair", server, code, name}    desktop only: pair with a server
 *   POST {op:"check"}                       desktop only: contact the server now
 *   POST {op:"sync"}                        desktop only: one sync round now
 *
 * On the cloud server GET answers {role:"server"} and POST answers 404: the
 * server is what desktops pair with, it never pairs itself.
 */

import { json, readBody, serverModeEnabled } from "../server-auth.ts";
import { cloudStatus, contactServer, pairWithServer } from "./client.ts";
import { runSyncRound } from "./engine.ts";

export function cloudStatusResponse(): Response {
	if (serverModeEnabled()) return json({ role: "server" });
	return json(cloudStatus());
}

export async function cloudActionResponse(request: Request): Promise<Response> {
	if (serverModeEnabled()) return json({ error: "Not found." }, 404);
	const body = await readBody(request);
	if (!body) return json({ error: "Expected JSON." }, 400);
	if (body.op === "pair") {
		const result = await pairWithServer({ server: body.server, code: body.code, name: body.name });
		return result.ok ? json(result.status) : json({ error: result.error }, result.status);
	}
	if (body.op === "check") return json(await contactServer());
	// One round with the server, now. (Phase 6's "Sync now"; the timed rounds come with slice 6.)
	if (body.op === "sync") return json({ round: await runSyncRound(), status: cloudStatus() });
	return json({ error: "Unknown action." }, 400);
}
