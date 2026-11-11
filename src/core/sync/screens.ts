/**
 * Cloud sync Phase 6 (docs/cloud-sync.md): the owner-approved words of the
 * sync screens, in one place so the screens and their tests agree. A change
 * here is a change to approved wording: ask the owner first.
 *
 * Pure text; no server code, so the page's components import it directly.
 */

/** What a desktop is called until the learner names it (owner's choice). */
export const DEFAULT_DESKTOP_NAME = "Desktop";

/** Settings → Cloud on the desktop app. */
export const CLOUD_TEXT = {
	group: "Cloud sync",
	intro: "Keep this PC's sessions, graph and settings in step with your LearnHarness server.",
	addressLabel: "Server address",
	codeLabel: "Pairing code",
	codeHelp: "On the server's site: Settings → Cloud → Add a desktop app.",
	nameLabel: "This PC's name",
	firstPairing: "Pairing combines this PC's sessions with the server's. Nothing is deleted, and a backup is made first.",
	pairingAgain: "This PC was paired with this server before. Where a session was continued on both sides since, the server's version is kept and what this PC added is discarded. A backup is made first.",
	pair: "Pair",
	pairing: "Pairing…",
	upToDate: "Up to date",
	starting: "Starting…",
	syncing: "Syncing…",
	offline: "Can't reach the server. Trying again.",
	noLongerPaired: "This PC is no longer paired.",
	syncNow: "Sync now",
	serverRow: "Server",
	nameRow: "This PC",
	unpair: "Unpair this PC",
	unpairConfirm: "Syncing stops. Nothing on this PC is deleted, and every session can be continued here.",
	cancel: "Cancel",
} as const;

/** Under the name box: what the other devices will read. */
export const heldByExample = (name: string): string => `Your other devices show it: “Held by ${name.trim() || DEFAULT_DESKTOP_NAME}”.`;

/** After an Unpair made without a connection. */
export const serverNotTold = (name: string): string => `The server couldn't be told. Remove “${name}” there too: Settings → Cloud.`;

/** Settings → Cloud on the server's site. */
export const CLOUD_SERVER_TEXT = {
	group: "Desktop apps",
	none: "No desktop app is paired.",
	add: "Add a desktop app",
	codeLabel: "Pairing code",
	addressLabel: "Server address",
	codeHelp: "In the desktop app, open Settings → Cloud and enter both.",
	codeGone: "This code has run out.",
	newCode: "New code",
	done: "Done",
	remove: "Remove",
	cancel: "Cancel",
	onlineNow: "online now",
} as const;

export const removeConfirm = (name: string): string => `“${name}” stops syncing. Nothing on that PC is deleted.`;

/** "Works once, for 9:41": the time a pairing code has left. */
export function codeTimeLeft(expiresAt: number, now: number): string | null {
	const left = Math.ceil((expiresAt - now) / 1000);
	if (left <= 0) return null;
	return `Works once, for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}

/**
 * How long ago the PC and the server last spoke, while that is recent:
 * "just now", "1 minute ago", "12 minutes ago". null once it is an hour or
 * more, when the screen gives the clock time instead.
 */
export function recentlyText(at: number, now: number): string | null {
	const minutes = Math.floor(Math.max(0, now - at) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
	return null;
}
