/**
 * Cloud sync (Phase 5, docs/cloud-sync.md): the protocol version rule.
 *
 * Owner-approved: the number starts at 1 and rises only when a release
 * changes what the two sides send each other, a stored format that syncs,
 * or the deletion rules both sides replay. The desktop and the server must
 * be EQUAL or sync pauses; the desktop keeps working on its own data. The
 * message names the side that is behind (the approved wording).
 *
 * 2 (upstream 0.6.0): the chat record format went from 1 to 2 (side
 * questions inside the record; an older build refuses a v2 file), the
 * session bundle lost its side-tutor file, pictures inside messages travel
 * once, and theme files and more settings sync. A protocol-1 build must
 * never receive any of that. tests/sync-sessions.test.ts pins which chat
 * format needs which protocol.
 *
 * 3 (Flashcards sync, docs/phone-plugins-plan.md): the Flashcards library
 * travels item by item (POST /api/sync/flashcards), and a PC sends its time
 * zone. A protocol-2 build knows nothing of it, and a server of protocol 2
 * would refuse the route. tests/sync-sessions.test.ts pins which Flashcards
 * file format needs which protocol, beside the chat format.
 */

export const SYNC_PROTOCOL_VERSION = 3;

/** Sent by the desktop on every sync request, and echoed by the server. */
export const SYNC_PROTOCOL_HEADER = "x-lh-sync-protocol";

export const UPDATE_SERVER_MESSAGE = "Update the server to continue syncing";
export const UPDATE_APP_MESSAGE = "Update LearnHarness to continue syncing";

export type ProtocolVerdict =
	| { ok: true }
	| { ok: false; behind: "server" | "app"; message: string };

/** Compare the desktop app's protocol number with the server's. */
export function protocolVerdict(app: number, server: number): ProtocolVerdict {
	if (app === server) return { ok: true };
	return server < app
		? { ok: false, behind: "server", message: UPDATE_SERVER_MESSAGE }
		: { ok: false, behind: "app", message: UPDATE_APP_MESSAGE };
}

/** The header's value as a protocol number, or null when absent or malformed. */
export function parseProtocolHeader(value: string | null | undefined): number | null {
	if (!value || !/^\d{1,6}$/.test(value)) return null;
	return Number(value);
}
