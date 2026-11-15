/**
 * Accounts on one server: the owner-approved words of the new screens
 * (docs/multi-account-plan.md, "The approved words"), in one place so the
 * pages, the screens and their tests agree. A change here is a change to
 * approved wording: ask the owner first. Quoted names take curly quotes.
 *
 * Pure text, like ./sync/screens.ts. Browser-safe: React components import it,
 * so it imports nothing at all (no node built-ins, not ./server-auth.ts or
 * ./accounts.ts; a test reads the source to keep it so). The gateway and
 * ./accounts.ts may import it, never the other way round.
 */

// TODO(owner wording): placeholder, not approved. The 503 body while the gateway's accounts file is damaged.
export const ACCOUNTS_FILE_DAMAGED_PLACEHOLDER = "The accounts file on this server is damaged. See the server guide.";

/** Equal to PASSWORD_MIN_LENGTH in ./server-auth.ts (a test pins it). */
const PASSWORD_MIN_LENGTH = 8;

/** A copy of `formatWait` in ./server-auth.ts ("15 min", "2 h", "1 h 30 min"; a test pins them equal). */
export function waitText(ms: number): string {
	const minutes = Math.max(1, Math.ceil(ms / 60000));
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

// Equal to RECOVERY_CODE_COUNT and REMOVED_KEEP_MS in ./accounts.ts (a test pins it); not imported, to keep this file standalone.
const RECOVERY_TOTAL = 4;
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

// ─── Reused as they are today ────────────────────────────────────────────────

export const PASSWORDS_DONT_MATCH = "The two passwords don't match.";
/** The same sentence `passwordProblem` gives. */
export const USE_AT_LEAST = `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
/** Today's lockout sentence (src/server/server-auth.ts `lockedMessage`). */
export const tooManyAttempts = (waitMs: number): string => `Too many attempts. Try again in ${waitText(waitMs)}.`;
/** Today's wrong setup code sentence. */
export const SETUP_CODE_WRONG = "That setup code isn't right. Check the server log for the current code.";

// ─── Times ───────────────────────────────────────────────────────────────────

const timeOf = (ms: number): string => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/** "9 Nov": the device's own format. */
export const dayText = (ms: number): string => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** "9 Nov, 18:20", or "today, 18:20" when `now` is given and it is the same day (as Settings → Obsidian words it). */
export function dayTimeText(ms: number, now?: number): string {
	if (now !== undefined && new Date(ms).toDateString() === new Date(now).toDateString()) return `today, ${timeOf(ms)}`;
	return `${dayText(ms)}, ${timeOf(ms)}`;
}

// ─── Quoted names ────────────────────────────────────────────────────────────

export const quoted = (name: string): string => `“${name}”`;
/** `“sam”’s` */
export const quotedPossessive = (name: string): string => `“${name}”’s`;

// ─── The pages before sign-in ────────────────────────────────────────────────

export const SIGN_IN_TEXT = {
	title: "LearnHarness",
	nameLabel: "Name",
	passwordLabel: "Password",
	submit: "Sign in",
	inviteLink: "Have an invite code?",
	forgotLink: "Forgot your password?",
	wrong: "That name or password isn't right.",
	/** Only after a correct name and password. */
	paused: "This account is paused. Ask this server's owner.",
	removed: "This account was removed. Ask this server's owner.",
} as const;

export const SETUP_TEXT = {
	title: "Set up LearnHarness",
	intro: `Enter the setup code from the server log, then choose a name and a password of at least ${PASSWORD_MIN_LENGTH} characters.`,
	codeLabel: "Setup code",
	nameLabel: "Name",
	nameHelp: "3 to 20 letters, digits or dashes.",
	passwordLabel: "New password",
	confirmLabel: "Type it again",
	submit: "Create account",
	wrongCode: SETUP_CODE_WRONG,
	nameNotAllowed: "Use 3 to 20 letters, digits or dashes.",
} as const;

export const INVITE_TEXT = {
	title: "Create your account",
	codeLabel: "Invite code",
	nameLabel: "Name",
	nameHelp: "3 to 20 letters, digits or dashes.",
	nameHelpSignIn: "You sign in with it.",
	passwordLabel: "Password",
	passwordHelp: `At least ${PASSWORD_MIN_LENGTH} characters.`,
	confirmLabel: "Type it again",
	submit: "Create account",
	invalid: "That invite code isn't right, or it has run out.",
	taken: "That name is taken. Choose another.",
	full: "This server is full. Ask its owner.",
	/** A reserved name. */
	reserved: "That name can't be used. Choose another.",
	notAllowed: SETUP_TEXT.nameNotAllowed,
} as const;

export const RECOVERY_PAGE_TEXT = {
	title: "Your recovery codes",
	body: "If you forget your password, any one of these lets you choose a new one. Each works once. They won't be shown again.",
	copy: "Copy",
	continue: "Continue",
} as const;

export const RESET_PAGE_TEXT = {
	title: "Choose a new password",
	intro: "Enter one of your recovery codes, or a reset code from this server's owner.",
	nameLabel: "Name",
	codeLabel: "Code",
	passwordLabel: "New password",
	confirmLabel: "Type it again",
	submit: "Set new password",
	invalid: "That name or code isn't right, or the code has been used or has run out.",
} as const;

// ─── Settings → Accounts (the owner only) ────────────────────────────────────

export const ACCOUNTS_TEXT = {
	group: "Accounts",
	menu: { reset: "Reset password", pause: "Pause", resume: "Resume", remove: "Remove" },
	invitesGroup: "Invite codes",
	newInvite: "New invite code",
	cancelInvite: "Cancel",
	removedGroup: "Removed",
	restore: "Restore",
	deleteNow: "Delete now",
	cancel: "Cancel",
	copy: "Copy",
	done: "Done",
} as const;

export const usedText = (used: number, cap: number): string => `${used} of ${cap} accounts used.`;
/** The invite button is greyed. */
export const serverFullText = (cap: number): string => `All ${cap} accounts are used. Remove one to invite someone.`;
/** Restore with no room. */
export const restoreFullText = (cap: number): string => `All ${cap} accounts are used. Remove one first.`;

/**
 * An account line's second part: "Owner · signed in now", "Last seen 9 Nov, 18:20",
 * "Paused". The owner's line is prefixed "Owner · ".
 */
export function accountStatusText(account: { role: "owner" | "member"; state: "active" | "paused"; signedInNow: boolean; lastSeenAt: number | null }, now?: number): string {
	let status: string;
	if (account.state === "paused") status = "Paused";
	else if (account.signedInNow) status = account.role === "owner" ? "signed in now" : "Signed in now";
	else status = account.lastSeenAt === null ? "Never signed in" : `Last seen ${dayTimeText(account.lastSeenAt, now)}`;
	return account.role === "owner" ? `Owner · ${status}` : status;
}

/** A waiting invite: "Works once, until 22 Nov". */
export const inviteUntilText = (expiresAt: number): string => `Works once, until ${dayText(expiresAt)}`;

/** A removed account: "Removed 9 Nov · deleted for good on 9 Dec". */
export const removedText = (removedAt: number, deletedAt: number = removedAt + KEEP_MS): string => `Removed ${dayText(removedAt)} · deleted for good on ${dayText(deletedAt)}`;

export interface ConfirmText { title: string; body: string; cancel: string; confirm: string }

export const resetConfirm = (name: string): ConfirmText => ({
	title: `Reset ${quotedPossessive(name)} password?`,
	body: `You get a code to pass on. It works once, for 24 hours. When it is used, ${name} is signed out everywhere and pairs their desktop apps again.`,
	cancel: "Cancel",
	confirm: "Get reset code",
});

export const pauseConfirm = (name: string): ConfirmText => ({
	title: `Pause ${quoted(name)}?`,
	body: `${name} can't sign in and their copy stops. Nothing is deleted.`,
	cancel: "Cancel",
	confirm: "Pause",
});

export const removeAccountConfirm = (name: string): ConfirmText => ({
	title: `Remove ${quoted(name)}?`,
	body: "The account stops now. Its data is kept for 30 days, then deleted for good.",
	cancel: "Cancel",
	confirm: "Remove",
});

export const deleteNowConfirm = (name: string): ConfirmText => ({
	title: `Delete ${quoted(name)} now?`,
	body: "This deletes the account's data for good.",
	cancel: "Cancel",
	confirm: "Delete",
});

/** After New invite code. */
export const inviteBox = (expiresAt: number): { title: string; body: string; copy: string; done: string } => ({
	title: "Invite code",
	body: `Works once, until ${dayText(expiresAt)}. Send it to the person with this site's address.`,
	copy: "Copy",
	done: "Done",
});

/** After Get reset code. */
export const resetCodeBox = (name: string): { title: string; body: string; copy: string; done: string } => ({
	title: `Reset code for ${quoted(name)}`,
	body: "Works once, for 24 hours.",
	copy: "Copy",
	done: "Done",
});

// ─── Each person's Settings → Account, the new parts ─────────────────────────

export const signedInAs = (name: string): string => `Signed in as ${name}`;

export const ACCOUNT_TEXT = {
	recoveryGroup: "Recovery codes",
	newRecoveryCodes: "New recovery codes",
	recoveryBox: {
		title: "New recovery codes?",
		body: "Your old codes stop working.",
		passwordLabel: "Password",
		cancel: "Cancel",
		confirm: "Make new codes",
	},
	dataGroup: "Your data",
	download: "Download my data",
	downloadHelp: "Your sessions, graph and settings as one file.",
	deleteAccount: "Delete my account",
	deleteBox: {
		title: "Delete your account?",
		body: "Your account and everything in it are deleted now, for good. This can't be undone. Download your data first if you want to keep it.",
		passwordLabel: "Password",
		cancel: "Cancel",
		confirm: "Delete my account",
	},
} as const;

export const recoveryLeftText = (left: number, total: number = RECOVERY_TOTAL): string => `${left} of ${total} left.`;
