/**
 * Cloud sync Phase 6 (docs/fork/cloud-sync.md): the owner-approved words of the
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

/** Under the name box: where the server lists this PC. */
export const NAME_HELP_TEXT = "The server lists this PC by this name: Settings → Cloud.";

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

// ─── A session another device holds ─────────────────────────────────────────
// Sessions move to the device that needs them by themselves (seamless
// sessions, owner's decision): nothing says who holds a session and nothing
// offers to take it over. The page still knows the holder's name and times
// from the server; no screen shows them.

/** A session's holder as the page's sync state knows it. `online` and `lastSeenAt` are known on the server's site only. */
export interface SessionHolder {
	id: string;
	name: string | null;
	online?: boolean;
	lastSeenAt?: number | null;
}

/** The box's words when a session couldn't be moved here for an action (owner-approved). Also the `error` of the made-up refusal a write gets then. */
export const SESSION_MOVE_FAILED_TEXT = "This session couldn't be continued here. Try again.";

/** The folder Delete's failure line when a session inside couldn't be moved here first (owner-approved). Nothing is deleted then. Upstream's "Try again" follows it. */
export const FOLDER_DELETE_FAILED_TEXT = "This folder couldn't be deleted right now. Nothing was deleted.";

// ─── Slice 3: the desktop's own notices ─────────────────────────────────────

/** What is off with this PC's sync. Never set on a PC that was never paired, or that the learner unpaired. */
export type SyncTrouble = "offline" | "paused" | "needs-pairing";

/** The sync chip at the foot of the session list (shown in capitals). */
export const SYNC_CHIP_TEXT: Record<SyncTrouble, string> = {
	offline: "Offline",
	paused: "Sync paused",
	"needs-pairing": "Not paired",
};

/** The floating box's words in every lesson while this PC isn't syncing (owner-approved). */
export const SYNC_TROUBLE_BOX_TEXT: Record<SyncTrouble, string> = {
	offline: "This PC can't reach the server. If this session is continued on another device before it reconnects, any new messages will be discarded.",
	paused: "Sync is paused. If this session is continued on another device before sync is back, any new messages will be discarded.",
	"needs-pairing": "This PC isn't paired any more. If this session is continued on another device before you pair again, any new messages will be discarded.",
};

/** Quiet for short blips: the chip and the heads-up wait this long after the PC first fails to reach the server. */
export const OFFLINE_QUIET_MS = 30_000;

interface SyncFacts {
	state: string;
	lastContactAt: number | null;
	offlineSince?: number | null;
}

/**
 * How long until the chip and the heads-up should show, in ms: 0 = now,
 * null = nothing is off. A paused or removed PC shows at once; an offline
 * one after 30 seconds, or at once when the app started with no connection
 * (it hasn't reached the server since it started).
 */
export function syncTroubleDueIn(sync: SyncFacts | null | undefined, now: number): { trouble: SyncTrouble; inMs: number } | null {
	if (!sync) return null;
	if (sync.state === "paused" || sync.state === "needs-pairing") return { trouble: sync.state, inMs: 0 };
	if (sync.state !== "offline") return null;
	if (sync.lastContactAt === null || typeof sync.offlineSince !== "number") return { trouble: "offline", inMs: 0 };
	return { trouble: "offline", inMs: Math.max(0, sync.offlineSince + OFFLINE_QUIET_MS - now) };
}

export function syncTrouble(sync: SyncFacts | null | undefined, now: number): SyncTrouble | null {
	const due = syncTroubleDueIn(sync, now);
	return due && due.inMs === 0 ? due.trouble : null;
}

/** What a discarded session lost, as the notice says it. */
export function discardedText(turns: number): string {
	if (turns <= 0) return "Changes made here that hadn't reached the server were discarded.";
	if (turns === 1) return "1 message you sent here never reached the server and was discarded.";
	return `${turns} messages you sent here never reached the server and were discarded.`;
}

export const DISCARD_OK = "OK";

/**
 * The discard box: one session, or several at once (one box, one line per
 * session). `before`, the lines and `after` read as one paragraph for a
 * single session.
 */
export function discardBox(notices: ReadonlyArray<{ title: string; turns: number }>): { title: string; before: string; lines: string[]; after: string } | null {
	if (notices.length === 0) return null;
	const name = (title: string): string => title.trim() || "Untitled session";
	if (notices.length === 1) {
		const only = notices[0]!;
		return {
			title: `“${name(only.title)}” was continued on another device`,
			before: "It was continued on another device while this PC was offline.",
			lines: [discardedText(only.turns)],
			after: "The session now shows the server's version.",
		};
	}
	return {
		title: "Sessions were continued on another device",
		before: "They were continued on another device while this PC was offline.",
		lines: notices.map((notice) => `“${name(notice.title)}”: ${discardedText(notice.turns)}`),
		after: "The sessions now show the server's version.",
	};
}
