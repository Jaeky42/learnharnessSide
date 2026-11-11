/**
 * Cloud sync (Phase 5, docs/cloud-sync.md): the protocol version rule.
 *
 * Owner-approved: the number starts at 1 and rises only when a release
 * changes what the two sides send each other, a stored format that syncs,
 * or the deletion rules both sides replay. The desktop and the server must
 * be EQUAL or sync pauses; the desktop keeps working on its own data. The
 * message names the side that is behind (the approved wording).
 */

export const SYNC_PROTOCOL_VERSION = 1;

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
