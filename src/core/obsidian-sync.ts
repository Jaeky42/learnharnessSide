/**
 * The Obsidian vault on the cloud server (side-tutor fork, cloud sync
 * Phase 4; docs/cloud-sync.md). Pure rules and wording, shared by the
 * server's sync manager (src/server/obsidian-sync.ts) and Settings →
 * Obsidian (components/settings/obsidian-section.tsx). Browser-safe.
 *
 * The official headless client `obsidian-headless` (`ob`) does the syncing
 * as one more Obsidian Sync device. LearnHarness drives it: sign-in, vault
 * setup, continuous sync, and the excluded-folders list (every top-level
 * folder except LearnHarness/ is left out as it first appears).
 */

import { NOTES_FOLDER } from "./notes.ts";

/** The pinned `obsidian-headless` version. deploy/docker-entrypoint.sh
 *  installs exactly this one (tests/obsidian-sync.test.ts pins both). The
 *  manager reads the program's output, so a new version is a tested bump. */
export const OB_VERSION = "0.0.14";
/** The server's name in Obsidian's sync history (owner's choice). */
export const OB_DEVICE_NAME = "LearnHarness server";
/** Same note changed in two places: merge (owner's choice; ob's default). */
export const OB_CONFLICT_STRATEGY = "merge";

// ─── What the page shows ─────────────────────────────────────────────────────

export type ObsidianPhase = "installing" | "signed-out" | "signed-in" | "connected";

export type ObsidianSyncState =
	| "starting"
	| "first-sync"
	| "up-to-date"
	| "syncing"
	| "offline"
	| "needs-sign-in"
	| "subscription"
	| "vault-gone"
	| "paused"
	| "failing";

export interface ObsidianView {
	phase: ObsidianPhase;
	account: { name: string; email: string } | null;
	vault: { id: string; name: string } | null;
	/** null unless a vault is connected. */
	sync: ObsidianSyncState | null;
	lastSyncedAt: number | null;
	/** Top-level folders left out of this server. */
	leftOut: string[];
	/** Something written here may not have reached Obsidian yet. */
	unsynced: boolean;
	busy: "sign-in" | "connect" | "disconnect" | null;
}

export interface ObsidianVault {
	id: string;
	name: string;
}

/** Owner-approved wording (the Phase 4 plan). */
export const OBSIDIAN_TEXT = {
	installing: "Obsidian's sync program is still installing on this server. That takes a minute or two after the first start.",
	wrongCredentials: "Obsidian didn't accept that email and password.",
	twoStepNeeded: "Your Obsidian account uses two-step sign-in. Enter the code from your authenticator app and press Sign in again.",
	twoStepWrong: "That two-step code wasn't accepted. Enter a fresh one.",
	unreachable: "Obsidian couldn't be reached. Try again in a minute.",
	noVaults: "This Obsidian account has no vaults in Obsidian Sync. Turn on Sync for your vault in Obsidian first.",
	wrongVaultPassword: "That isn't this vault's encryption password.",
	vaultPasswordNeeded: "This vault is end-to-end encrypted. Enter its encryption password.",
	unsynced: "Some changes made here haven't reached Obsidian yet. Disconnecting now loses them.",
	paused: "The server's copy of your notes is missing or much smaller than before. Syncing now could delete notes from Obsidian on every device.",
	pausedFix: "Disconnect, then connect again to download a fresh copy.",
	notSyncing: "Not syncing with Obsidian right now. What you write here is kept and syncs when it's back.",
} as const;

/** The status line under "Connected to …". */
export const OBSIDIAN_SYNC_LABEL: Record<ObsidianSyncState, string> = {
	starting: "Starting…",
	"first-sync": "Downloading your notes…",
	"up-to-date": "Up to date",
	syncing: "Syncing…",
	offline: "Can't reach Obsidian. Trying again.",
	"needs-sign-in": "Sync stopped",
	subscription: "Sync stopped. Your Obsidian Sync subscription has expired.",
	"vault-gone": "Sync stopped. This vault no longer exists in Obsidian Sync.",
	paused: "Sync is paused",
	failing: "Sync keeps stopping. The reason is in the server log.",
};

/** States in which notes written here are reaching Obsidian. */
export function syncIsRunning(state: ObsidianSyncState | null): boolean {
	return state === "starting" || state === "first-sync" || state === "up-to-date" || state === "syncing";
}

// ─── Reading ob's output ─────────────────────────────────────────────────────

export type ObLine =
	| { kind: "downloading"; path: string }
	| { kind: "downloaded"; path: string }
	| { kind: "working" }
	| { kind: "synced" }
	| { kind: "connecting" }
	| { kind: "connected" }
	| { kind: "offline" }
	| { kind: "auth"; detail: string }
	| { kind: "subscription" }
	| { kind: "vault-gone" }
	| { kind: "locked" }
	| { kind: "other" };

/** One line of `ob sync --continuous` (obsidian-headless 0.0.14). Plain
 *  lines come from console.log; errors print as "Error: <message>". */
export function parseObLine(raw: string): ObLine {
	const line = raw.replace(/\r$/, "").trim();
	if (!line) return { kind: "other" };
	if (line.includes("Your subscription to Obsidian Sync has expired")) return { kind: "subscription" };
	if (line.includes("The connected remote vault no longer exists") || line.includes("Vault not found")) return { kind: "vault-gone" };
	if (line.includes("Failed to authenticate")) return { kind: "auth", detail: line.slice(line.indexOf("Failed to authenticate") + "Failed to authenticate".length).replace(/^[:\s]+/, "").slice(0, 200) };
	if (line.includes("Another sync instance is already running")) return { kind: "locked" };
	if (line.startsWith("Downloading ")) return { kind: "downloading", path: line.slice("Downloading ".length) };
	if (line.startsWith("Downloaded ")) return { kind: "downloaded", path: line.slice("Downloaded ".length) };
	if (line === "Fully synced") return { kind: "synced" };
	if (line === "Connecting...") return { kind: "connecting" };
	if (line.startsWith("Connection successful")) return { kind: "connected" };
	if (
		line.includes("Unable to connect to server") ||
		line.includes("The connection to the server has encountered an error") ||
		line === "Disconnected from server" ||
		line === "Waiting to connect to server" ||
		/Disconnected\. Code: \d+/.test(line)
	) return { kind: "offline" };
	if (/^(Uploading|Upload complete|Deleting|Merging|Merge successful|Accepted|Checking|Restoring|Reverting|Removing|Renaming) /.test(line)) return { kind: "working" };
	return { kind: "other" };
}

// ─── Leaving folders out ─────────────────────────────────────────────────────

/** A top-level entry LearnHarness never leaves out: the notes folder and
 *  dot-folders (ob never syncs those itself). */
function keptTopLevel(name: string): boolean {
	return name === NOTES_FOLDER || name.startsWith(".");
}

/** The top-level folder to leave out for a path ob is downloading, or null:
 *  a loose top-level file, the LearnHarness folder, or one already left out. */
export function folderToLeaveOut(downloadPath: string, leftOut: readonly string[]): string | null {
	const clean = downloadPath.replace(/^\/+/, "");
	const slash = clean.indexOf("/");
	if (slash <= 0) return null;
	const top = clean.slice(0, slash);
	if (keptTopLevel(top) || leftOut.includes(top)) return null;
	return top;
}

/** A path ob just finished that sits at the top of the vault: a folder to
 *  leave out if it is one on disk (a folder's record arrives before its
 *  files, so leaving it out here usually means none of them is downloaded). */
export function topLevelCandidate(downloadedPath: string, leftOut: readonly string[]): string | null {
	const clean = downloadedPath.replace(/^\/+/, "");
	if (!clean || clean.includes("/") || keptTopLevel(clean) || leftOut.includes(clean)) return null;
	return clean;
}

/** Top-level folders found on disk that aren't left out yet. */
export function foldersToLeaveOut(topLevelFolders: readonly string[], leftOut: readonly string[]): string[] {
	return topLevelFolders.filter((name) => !keptTopLevel(name) && !leftOut.includes(name));
}

/** The value for `ob sync-config --excluded-folders`, or null when a name
 *  can't go through that option: ob splits the value on commas and trims
 *  each entry. The manager then writes the list into ob's settings file. */
export function excludedFoldersArgument(folders: readonly string[]): string | null {
	if (folders.some((name) => !name || name.includes(",") || name !== name.trim())) return null;
	return folders.join(",");
}

// ─── Safety check before sync starts ─────────────────────────────────────────

/** True when the server's LearnHarness folder is missing, empty, or has
 *  lost more than half its notes since the last healthy sync. Starting ob
 *  then would delete the missing notes from Obsidian on every device. */
export function vaultLooksEmptied(notesSeen: number, notesNow: number): boolean {
	if (notesSeen <= 0) return false;
	return notesNow === 0 || notesNow * 2 < notesSeen;
}

// ─── Restarts ────────────────────────────────────────────────────────────────

export const OB_RESTART_BASE_MS = 5_000;
export const OB_RESTART_MAX_MS = 5 * 60_000;
/** ob keeps a lock in the vault for 5 seconds after it was last touched. A
 *  start right after ob was killed is refused; this is how long to wait. */
export const OB_LOCK_WAIT_MS = 6_000;
/** Unexpected stops in a row before the page says sync keeps stopping. */
export const OB_FAILING_AFTER = 5;

/** Wait before restarting after the n-th unexpected stop in a row (n ≥ 1):
 *  5 seconds, doubling, at most 5 minutes. */
export function restartDelayMs(failures: number, base = OB_RESTART_BASE_MS, max = OB_RESTART_MAX_MS): number {
	const n = Math.max(1, Math.floor(failures));
	return Math.min(max, base * 2 ** Math.min(n - 1, 20));
}

// ─── Input checks ────────────────────────────────────────────────────────────

export interface ObsidianSignInInput {
	email: string;
	password: string;
	/** Digits only; "" when the account has no two-step sign-in. */
	code: string;
}

/** Checks what the sign-in form sent. The password is passed on untouched
 *  (ob reads it from its input and drops only trailing whitespace). */
export function checkSignInInput(email: unknown, password: unknown, code: unknown): ObsidianSignInInput | { error: string } {
	const e = typeof email === "string" ? email.trim() : "";
	const p = typeof password === "string" ? password : "";
	const c = typeof code === "string" ? code.replace(/[\s-]/g, "") : "";
	// Not starting with "-": the email is passed to ob as a command argument.
	if (!e || e.length > 320 || !/^[^\s@-][^\s@]*@[^\s@]+$/.test(e)) return { error: "Enter your Obsidian email." };
	if (!p || p.length > 1024 || /[\0\r\n]/.test(p)) return { error: "Enter your Obsidian password." };
	if (c && !/^\d{4,10}$/.test(c)) return { error: OBSIDIAN_TEXT.twoStepWrong };
	return { email: e, password: p, code: c };
}

/** A vault id as Obsidian Sync lists it. Never a name: the value is passed
 *  to ob as a command argument. */
export function validVaultId(id: unknown): id is string {
	return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id);
}

/** The vault password as the form sent it ("" for a standard vault). */
export function checkVaultPassword(password: unknown): string | null {
	const p = typeof password === "string" ? password : "";
	return p.length > 1024 || /[\0\r\n]/.test(p) ? null : p;
}

// ─── Reading ob's one-shot commands ──────────────────────────────────────────

/** "Logged in as NAME (EMAIL)" from `ob login`. */
export function parseLoggedIn(output: string): { name: string; email: string } | null {
	const match = /^Logged in as (.*) \(([^()\s]+)\)\s*$/m.exec(output);
	return match ? { name: (match[1] ?? "").trim(), email: match[2] ?? "" } : null;
}

/** Why `ob login` or `ob sync-list-remote` couldn't reach Obsidian. */
export function looksUnreachable(output: string): boolean {
	return /fetch failed|HTTP Error \d+|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|UND_ERR|network/i.test(output);
}

/** Obsidian's own error text from a failed command, when it printed one
 *  ("Login failed: s [Error]: <text>", then the same text as `error: '…'`). */
export function obsidianErrorText(output: string): string | null {
	const quoted = /^\s*error: ['"](.+)['"],?\s*$/m.exec(output);
	if (quoted?.[1]) return quoted[1];
	const head = /\[Error\]: (.+)$/m.exec(output);
	return head?.[1] ? head[1].trim() : null;
}

export type SignInOutcome =
	| { ok: true; account: { name: string; email: string } }
	| { ok: false; error: string; detail: string | null };

/** What an `ob login --email … [--mfa …]` run means. ob 0.0.14 exits 0 and
 *  prints nothing when it wanted a two-step code it couldn't ask for. */
export function signInOutcome(exitCode: number | null, output: string, codeGiven: boolean): SignInOutcome {
	const account = parseLoggedIn(output);
	if (account) return { ok: true, account };
	if (exitCode === 0) return { ok: false, error: codeGiven ? OBSIDIAN_TEXT.twoStepWrong : OBSIDIAN_TEXT.twoStepNeeded, detail: null };
	const detail = obsidianErrorText(output);
	if (/2FA code/i.test(output)) return { ok: false, error: codeGiven ? OBSIDIAN_TEXT.twoStepWrong : OBSIDIAN_TEXT.twoStepNeeded, detail: null };
	if (!detail && looksUnreachable(output)) return { ok: false, error: OBSIDIAN_TEXT.unreachable, detail: null };
	return { ok: false, error: OBSIDIAN_TEXT.wrongCredentials, detail };
}

export type ConnectOutcome = { ok: true } | { ok: false; error: string; signedOut?: boolean };

/** What an `ob sync-setup` run means. */
export function connectOutcome(exitCode: number | null, output: string): ConnectOutcome {
	if (exitCode === 0 && output.includes("Vault configured successfully")) return { ok: true };
	if (output.includes("Password not provided")) return { ok: false, error: OBSIDIAN_TEXT.vaultPasswordNeeded };
	if (output.includes("Failed to validate password")) {
		return looksUnreachable(output) && !obsidianErrorText(output)
			? { ok: false, error: OBSIDIAN_TEXT.unreachable }
			: { ok: false, error: OBSIDIAN_TEXT.wrongVaultPassword };
	}
	if (output.includes("No account logged in")) return { ok: false, error: "Sign in to Obsidian again.", signedOut: true };
	if (looksUnreachable(output)) return { ok: false, error: OBSIDIAN_TEXT.unreachable };
	return { ok: false, error: "The vault couldn't be connected. Try again." };
}

/** The vaults from `ob sync-list-remote --json` (own and shared). */
export function parseVaultList(output: string): ObsidianVault[] | null {
	try {
		const parsed = JSON.parse(output) as { vaults?: unknown; shared?: unknown };
		const rows = [...(Array.isArray(parsed.vaults) ? parsed.vaults : []), ...(Array.isArray(parsed.shared) ? parsed.shared : [])];
		return rows.flatMap((row) => {
			const r = row as { id?: unknown; name?: unknown };
			return validVaultId(r.id) && typeof r.name === "string" ? [{ id: r.id, name: r.name }] : [];
		});
	} catch {
		return null;
	}
}
