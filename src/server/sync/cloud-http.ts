/**
 * Cloud sync (Phase 5): the app's OWN control route, /api/cloud. The Phase 6
 * screens call it (components/settings/cloud-section.tsx and
 * cloud-server-section.tsx).
 *
 *   GET    what this copy is (the cloud server, or a desktop), its sync
 *          state, every session it may not change with who holds it, on a
 *          desktop the discards the learner hasn't been told about, and on
 *          the server its paired desktop apps (name, online, last seen)
 *   POST {op:"take-over", chatId, force}    ask for a session another device holds
 *   POST {op:"pair", server, code, name}    desktop only: pair with a server
 *   POST {op:"check"}                       desktop only: contact the server now
 *   POST {op:"sync"}                        desktop only: one sync round now
 *   POST {op:"dismiss-notice", chatId, at}  desktop only: a discard notice was read
 *   POST {op:"unpair"}                      desktop only: "Unpair this PC" (Phase 6)
 *
 * The server never pairs itself: pair, check and sync answer 404 there.
 */

import { emit } from "../../core/events.ts";
import { CLOUD_HOLDER, isSessionId } from "../../core/sync/sessions.ts";
import { json, readBody, serverModeEnabled } from "../server-auth.ts";
import { cloudStatus, contactServer, pairWithServer } from "./client.ts";
import { desktopSync, syncAuthority } from "./engine.ts";
import { runSyncRound } from "./round.ts";
import { kickSyncLoop } from "./loop.ts";
import { readServerAuthState } from "../../store/server-auth.ts";
import { readCloudPairing } from "../../store/sync/pairing.ts";
import { unpairThisDesktop } from "./unpair.ts";

/** The server's paired desktop apps, for its Settings → Cloud (Phase 6). Never a key. */
function pairedDesktops(): Array<{ id: string; name: string; pairedAt: number; online: boolean; lastSeenAt: number }> {
	try {
		const authority = syncAuthority();
		return readServerAuthState().devices
			.slice()
			.sort((a, b) => b.pairedAt - a.pairedAt)
			.map((device) => {
				const presence = authority.presence(device.id);
				return { id: device.id, name: device.name, pairedAt: device.pairedAt, online: presence.online, lastSeenAt: Math.max(presence.lastSeenAt ?? 0, device.lastSeenAt) };
			});
	} catch {
		return [];
	}
}

export function cloudStatusResponse(): Response {
	if (serverModeEnabled()) return json({ role: "server", held: syncAuthority().held(), desktops: pairedDesktops() });
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
		const before = readCloudPairing();
		const result = await pairWithServer({ server: body.server, code: body.code, name: body.name });
		// The same server as before: a fresh backup comes before the next sync.
		if (result.ok && before && before.server === result.status.server) desktopSync().rejoin();
		// Every open window of this app learns that sync is in use now.
		if (result.ok) emit("cloud-changed", {});
		// Paired: from now on this app syncs by itself (loop.ts). Not in tests, which drive rounds by hand.
		if (result.ok && process.env.NODE_ENV !== "test" && process.env.LH_SYNC_LOOP !== "off") kickSyncLoop();
		return result.ok ? json(result.status) : json({ error: result.error }, result.status);
	}
	if (body.op === "check") return json(await contactServer());
	// One round with the server, now (Phase 6's "Sync now"). The timed rounds are loop.ts.
	if (body.op === "sync") return json({ round: await runSyncRound(), status: cloudStatus() });
	if (body.op === "unpair") {
		const result = await unpairThisDesktop();
		emit("cloud-changed", {});
		return json(result);
	}
	if (body.op === "dismiss-notice") {
		if (isSessionId(body.chatId) && typeof body.at === "number") desktopSync().dismissNotice(body.chatId, body.at);
		return json({ notices: desktopSync().notices() });
	}
	return json({ error: "Unknown action." }, 400);
}
