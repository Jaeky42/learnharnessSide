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

// ─── A session held by another device (slice 2) ──────────────────────────────

/** What the server is called in "Held by …" (owner's choice). */
export const WEB_APP_NAME = "the web app";
/** The holder id the engine uses for the server itself (CLOUD_HOLDER in sessions.ts). */
const CLOUD_HOLDER_ID = "cloud";

/** A session's holder as the screens know it. `online` and `lastSeenAt` are known on the server's site only. */
export interface SessionHolder {
	id: string;
	name: string | null;
	online?: boolean;
	lastSeenAt?: number | null;
}

/** "Desktop", "the web app", or "another device" for a PC whose name isn't known. */
export function holderName(holder: Pick<SessionHolder, "id" | "name">): string {
	if (holder.id === CLOUD_HOLDER_ID) return WEB_APP_NAME;
	return holder.name?.trim() || "another device";
}

/** The same at the start of a sentence: "The web app is finishing a reply." */
export function holderNameAtStart(holder: Pick<SessionHolder, "id" | "name">): string {
	const name = holderName(holder);
	return holder.id === CLOUD_HOLDER_ID || !holder.name?.trim() ? name.charAt(0).toUpperCase() + name.slice(1) : name;
}

/** The session list's second line, and the strip's first words. */
export const heldByText = (holder: Pick<SessionHolder, "id" | "name">): string => `Held by ${holderName(holder)}`;

/**
 * The strip's line. The server's site adds whether the holder is online or
 * since when it has been offline (`since` is that time, already worded);
 * a desktop app knows only the name.
 */
export function heldStripText(holder: SessionHolder, since: string | null): string {
	const base = heldByText(holder);
	if (holder.online === undefined) return base;
	if (holder.online) return `${base} · online`;
	return since ? `${base} · offline since ${since}` : `${base} · offline`;
}

export const HELD_TEXT = {
	takeOver: "Take over",
	cancel: "Cancel",
	failed: "Couldn't take it over. Try again.",
	/** The tooltip of the controls that can't work until the session is taken over. */
	blocked: "Take this session over first",
	takeOverAnyway: "Take over anyway",
} as const;

export const askingText = (holder: Pick<SessionHolder, "id" | "name">): string => `Asking ${holderName(holder)} to hand it over…`;
export const finishingText = (holder: Pick<SessionHolder, "id" | "name">): string => `${holderNameAtStart(holder)} is finishing a reply. This session moves here when it's done.`;

/** Why a PC can't take a session over right now, or null when it can. */
export function cannotTakeOverText(syncState: string | null | undefined): string | null {
	if (syncState === "offline") return "This PC can't reach the server, so it can't be taken over right now.";
	if (syncState === "paused") return "Sync is paused, so it can't be taken over right now.";
	if (syncState === "needs-pairing") return "This PC is no longer paired, so it can't be taken over right now.";
	return null;
}

/** The take-over warning box. `since` is when the holder was last heard from, already worded, or null. */
export function takeOverWarning(title: string, holder: Pick<SessionHolder, "id" | "name">, since: string | null): { title: string; body: string } {
	const name = holderNameAtStart(holder);
	const offline = since ? `${name} has been offline since ${since}, and` : `${name} is offline and`;
	return {
		title: `Take over “${title}”?`,
		body: `${offline} may have turns that never reached the server. If you take over, those turns are discarded when ${holderName(holder)} is back online.`,
	};
}
