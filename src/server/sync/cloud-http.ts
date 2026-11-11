/**
 * Cloud sync (Phase 5): the app's OWN control route, /api/cloud. The Phase 6
 * screens will call it; until then only tests do.
 *
 *   GET    what this copy is (the cloud server, or a desktop), its sync
 *          state, every session it may not change with who holds it, and,
 *          on a desktop, the discards the learner hasn't been told about
 *   POST {op:"take-over", chatId, force}    ask for a session another device holds
 *   POST {op:"pair", server, code, name}    desktop only: pair with a server
 *   POST {op:"check"}                       desktop only: contact the server now
 *   POST {op:"sync"}                        desktop only: one sync round now
 *   POST {op:"dismiss-notice", chatId, at}  desktop only: a discard notice was read
 *
 * The server never pairs itself: pair, check and sync answer 404 there.
 */

import { CLOUD_HOLDER, isSessionId } from "../../core/sync/sessions.ts";
import { json, readBody, serverModeEnabled } from "../server-auth.ts";
import { cloudStatus, contactServer, pairWithServer } from "./client.ts";
import { desktopSync, syncAuthority } from "./engine.ts";
import { runSyncRound } from "./round.ts";

export function cloudStatusResponse(): Response {
	if (serverModeEnabled()) return json({ role: "server", held: syncAuthority().held() });
	const sync = desktopSync();
	return json({ ...cloudStatus(), held: sync.held(), notices: sync.notices() });
}

export async function cloudActionResponse(request: Request): Promise<Response> {
	const body = await readBody(request);
	if (!body) return json({ error: "Expected JSON." }, 400);
	if (body.op === "take-over") {
		if (!isSessionId(body.chatId)) return json({ error: "No such session." }, 404);
		const force = body.force === true;
		if (serverModeEnabled()) {
			const reply = syncAuthority().takeOver(CLOUD_HOLDER, body.chatId, force);
			return json(reply.body, reply.status);
		}
		return json(await desktopSync().takeOver(body.chatId, force));
	}
	if (serverModeEnabled()) return json({ error: "Not found." }, 404);
	if (body.op === "pair") {
		const result = await pairWithServer({ server: body.server, code: body.code, name: body.name });
		return result.ok ? json(result.status) : json({ error: result.error }, result.status);
	}
	if (body.op === "check") return json(await contactServer());
	// One round with the server, now. (Phase 6's "Sync now"; the timed rounds come with slice 6.)
	if (body.op === "sync") return json({ round: await runSyncRound(), status: cloudStatus() });
	if (body.op === "dismiss-notice") {
		if (isSessionId(body.chatId) && typeof body.at === "number") desktopSync().dismissNotice(body.chatId, body.at);
		return json({ notices: desktopSync().notices() });
	}
	return json({ error: "Unknown action." }, 400);
}
