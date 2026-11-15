"use client";
/**
 * Settings → Account (side-tutor fork, cloud sync Phase 1). Shown only on a
 * server-mode LearnHarness (docs/cloud-sync.md): GET /api/server-auth/account
 * answers 404 everywhere else, and the tab stays hidden.
 *
 * Change password (signs out every other device), the signed-in devices
 * list, Sign out (this device), and Sign out everywhere (this device included). No browser
 * confirm(): the destructive button asks once more inline.
 *
 * Behind the multi-account gateway (docs/multi-account-plan.md) the answer
 * also carries `name`, and the screen gains "Signed in as", Recovery codes,
 * Your data (a real download from the copy) and Delete my account (not for
 * the owner), with the approved words from src/core/account-screens.ts. A
 * single-copy server's answer has no `name`: nothing is added there.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { HostDialog } from "@/components/host-dialog";
import { ACCOUNT_TEXT, ACCOUNTS_TEXT, RECOVERY_PAGE_TEXT, recoveryLeftText, signedInAs } from "@/src/core/account-screens";
import { SettingsGroup } from "./controls.tsx";
import { isServerMode } from "./server-mode";
import { clearAccountContent } from "./sign-out-storage.ts";

export interface AccountDevice {
	id: string;
	label: string;
	createdAt: number;
	lastSeenAt: number;
	expiresAt: number;
	current: boolean;
}

/** What a copy behind the gateway adds to the account answer; null on a single-copy server. */
export interface AccountInfo {
	name: string;
	owner: boolean;
	recoveryCodesLeft: number;
}

function parseInfo(body: unknown): AccountInfo | null {
	const b = body as { name?: unknown; owner?: unknown; recoveryCodesLeft?: unknown } | null;
	if (!b || typeof b.name !== "string" || b.name === "") return null;
	return { name: b.name, owner: b.owner === true, recoveryCodesLeft: typeof b.recoveryCodesLeft === "number" ? b.recoveryCodesLeft : 0 };
}

// The settings dialog hands AccountSection only the device list, so the hook
// keeps the rest of the answer here, where the section reads it.
let currentInfo: AccountInfo | null = null;
const infoListeners = new Set<() => void>();
function setCurrentInfo(next: AccountInfo | null): void {
	const same = next === currentInfo || (next && currentInfo && next.name === currentInfo.name && next.owner === currentInfo.owner && next.recoveryCodesLeft === currentInfo.recoveryCodesLeft);
	if (same) return;
	currentInfo = next;
	for (const listener of infoListeners) listener();
}
const subscribeInfo = (listener: () => void) => { infoListeners.add(listener); return () => { infoListeners.delete(listener); }; };

/** undefined = still checking, null = not a server (hide the tab). */
export function useServerAccount(): { devices: AccountDevice[] | null | undefined; info: AccountInfo | null; reload: () => void } {
	const [devices, setDevices] = useState<AccountDevice[] | null | undefined>(undefined);
	const info = useSyncExternalStore(subscribeInfo, () => currentInfo, () => null);
	const reload = useCallback(() => {
		if (!isServerMode()) { setDevices(null); return; } // desktop/local: no request at all
		fetch("/api/server-auth/account", { credentials: "same-origin" })
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
			.then((body: { devices: AccountDevice[] }) => { setCurrentInfo(parseInfo(body)); setDevices(body.devices); })
			.catch(() => { setCurrentInfo(null); setDevices(null); });
	}, []);
	useEffect(reload, [reload]);
	return { devices, info, reload };
}

const fieldClass = "w-full rounded-sm border border-input bg-background px-2.5 py-1.5 font-ui text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring";
const buttonClass = "self-start rounded-sm border border-border px-3 py-1.5 font-ui text-sm text-foreground transition-colors hover:bg-accent disabled:opacity-50";

function when(ms: number): string {
	return new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

async function post(path: string, body?: object): Promise<{ ok: boolean; error?: string; data?: Record<string, unknown> }> {
	try {
		const res = await fetch(path, {
			method: "POST",
			credentials: "same-origin",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body ?? {}),
		});
		if (res.ok) return { ok: true, data: (await Promise.resolve().then(() => res.json()).catch(() => ({}))) as Record<string, unknown> };
		const detail = (await res.json().catch(() => ({}))) as { error?: string };
		return { ok: false, error: detail.error ?? "Something went wrong. Try again." };
	} catch {
		return { ok: false, error: "The server couldn't be reached. Check your connection and try again." };
	}
}

const dialogFrame = (testid: string) => (
	<div
		data-testid={testid}
		onClick={(e) => e.stopPropagation()}
		className="max-h-[calc(100dvh-4rem)] w-[26rem] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border bg-card p-5 shadow-xl"
	/>
);
const dialogBackdrop = { className: "fixed inset-0 z-50 flex items-center justify-center bg-background/80" };
const cancelClass = "rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";
const primaryClass = "rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40";
// White on the theme's error colour, as upstream's destructive button.
const destructiveClass = "rounded-md bg-destructive px-3 py-1.5 text-sm text-white transition-colors hover:bg-destructive/90 disabled:opacity-40";
const dangerClass = "self-start rounded-sm border border-border px-3 py-1.5 font-ui text-sm text-error transition-colors hover:bg-error/10 disabled:opacity-50";

/** A box that asks for the password: the recovery codes' and the account deletion's. */
function PasswordBox({ testid, text, destructive, busy, error, onCancel, onSubmit }: {
	testid: string;
	text: { title: string; body: string; passwordLabel: string; cancel: string; confirm: string };
	destructive?: boolean;
	busy: boolean;
	error: string | null;
	onCancel: () => void;
	onSubmit: (password: string) => void;
}) {
	const [password, setPassword] = useState("");
	return (
		<HostDialog open aria-label={text.title} frame={dialogFrame(testid)} backdropProps={dialogBackdrop} onClose={() => { onCancel(); return "closed"; }}>
			<form onSubmit={(event) => { event.preventDefault(); if (password) onSubmit(password); }}>
				<h2 className="text-sm font-semibold" data-testid={`${testid}-title`}>{text.title}</h2>
				<p className="mt-1 text-xs text-muted-foreground" data-testid={`${testid}-body`}>{text.body}</p>
				<label className="mt-3 flex flex-col gap-1 text-xs text-muted-foreground" htmlFor={`${testid}-password`}>{text.passwordLabel}
					<input id={`${testid}-password`} data-testid={`${testid}-password`} type="password" autoComplete="current-password" className={fieldClass} value={password} onChange={(e) => setPassword(e.target.value)} />
				</label>
				{error && <p role="alert" className="mt-3 text-xs text-error" data-testid={`${testid}-error`}>{error}</p>}
				<div className="mt-5 flex justify-end gap-2">
					<button type="button" onClick={onCancel} className={cancelClass}>{text.cancel}</button>
					<button type="submit" disabled={busy || !password} data-testid={`${testid}-confirm`} className={destructive ? destructiveClass : primaryClass}>{text.confirm}</button>
				</div>
			</form>
		</HostDialog>
	);
}

/** The four new recovery codes, shown once (the recovery-codes page's words). Only Done closes it. */
function NewCodesBox({ codes, onDone }: { codes: string[]; onDone: () => void }) {
	const copy = () => { try { void navigator.clipboard?.writeText(codes.join("\n")).catch(() => {}); } catch { /* the codes are selectable */ } };
	return (
		<HostDialog open aria-label={RECOVERY_PAGE_TEXT.title} frame={dialogFrame("account-new-codes-box")} backdropProps={dialogBackdrop} onClose={() => "blocked"}>
			<h2 className="text-sm font-semibold">{RECOVERY_PAGE_TEXT.title}</h2>
			<p className="mt-1 text-xs text-muted-foreground">{RECOVERY_PAGE_TEXT.body}</p>
			<ul className="mt-3 flex flex-col gap-1" data-testid="account-new-codes">
				{codes.map((code) => <li key={code} className="select-all font-mono text-sm tracking-widest text-foreground">{code}</li>)}
			</ul>
			<div className="mt-5 flex justify-end gap-2">
				<button type="button" onClick={copy} className={cancelClass} data-testid="account-new-codes-copy">{RECOVERY_PAGE_TEXT.copy}</button>
				<button type="button" onClick={onDone} className={primaryClass} data-testid="account-new-codes-done">{ACCOUNTS_TEXT.done}</button>
			</div>
		</HostDialog>
	);
}

export function AccountSection({ devices, reload, info: infoProp }: { devices: AccountDevice[]; reload: () => void; info?: AccountInfo | null }) {
	const stored = useSyncExternalStore(subscribeInfo, () => currentInfo, () => null);
	const info = infoProp === undefined ? stored : infoProp;
	const [box, setBox] = useState<"codes" | "delete" | null>(null);
	const [boxBusy, setBoxBusy] = useState(false);
	const [boxError, setBoxError] = useState<string | null>(null);
	const [newCodes, setNewCodes] = useState<string[] | null>(null);
	const [codesLeft, setCodesLeft] = useState<number | null>(null);
	useEffect(() => { setCodesLeft(null); }, [info?.recoveryCodesLeft]);
	const closeBox = () => { setBox(null); setBoxError(null); setBoxBusy(false); };
	const [current, setCurrent] = useState("");
	const [next, setNext] = useState("");
	const [confirm, setConfirm] = useState("");
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
	const [confirmingSignOut, setConfirmingSignOut] = useState(false);
	const [signOutError, setSignOutError] = useState<string | null>(null);

	const changePassword = async (event: React.FormEvent) => {
		event.preventDefault();
		setMessage(null);
		if (next !== confirm) { setMessage({ ok: false, text: "The two new passwords don't match." }); return; }
		setBusy(true);
		const result = await post("/api/server-auth/password", { current, next });
		setBusy(false);
		if (result.ok) {
			setCurrent(""); setNext(""); setConfirm("");
			setMessage({ ok: true, text: "Password changed. Your other devices were signed out." });
			reload();
		} else {
			setMessage({ ok: false, text: result.error ?? "Something went wrong. Try again." });
		}
	};

	// Behind the gateway, accounts share a browser: what holds a person's words goes at sign-out.
	const leave = () => {
		if (info) clearAccountContent();
		window.location.replace("/login");
	};

	const signOut = async () => {
		setSignOutError(null);
		const result = await post("/api/server-auth/logout");
		if (result.ok) leave();
		else setSignOutError(result.error ?? "Something went wrong. Try again.");
	};

	const signOutEverywhere = async () => {
		setSignOutError(null);
		const result = await post("/api/server-auth/sign-out-everywhere");
		if (result.ok) leave();
		else setSignOutError(result.error ?? "Something went wrong. Try again.");
	};

	const makeCodes = async (password: string) => {
		setBoxBusy(true); setBoxError(null);
		const result = await post("/api/server-auth/recovery-codes", { password });
		setBoxBusy(false);
		const codes = result.data?.codes;
		if (result.ok && Array.isArray(codes) && codes.every((c) => typeof c === "string")) {
			closeBox();
			setNewCodes(codes as string[]);
			if (typeof result.data?.recoveryCodesLeft === "number") setCodesLeft(result.data.recoveryCodesLeft);
			reload();
		} else {
			setBoxError(result.ok ? "Something went wrong. Try again." : result.error ?? "Something went wrong. Try again.");
		}
	};

	const deleteAccount = async (password: string) => {
		setBoxBusy(true); setBoxError(null);
		const result = await post("/api/server-auth/delete-account", { password });
		if (result.ok) { leave(); return; }
		setBoxBusy(false);
		setBoxError(result.error ?? "Something went wrong. Try again.");
	};

	return (
		<div data-testid="account-section">
			{info && <p className="mb-4 font-ui text-sm text-foreground" data-testid="account-signed-in-as">{signedInAs(info.name)}</p>}
			<SettingsGroup label="Password" testid="account-password">
				<form className="flex max-w-sm flex-col gap-2" onSubmit={changePassword}>
					<label className="flex flex-col gap-1 text-xs text-muted-foreground" htmlFor="account-current">Current password
						<input id="account-current" type="password" autoComplete="current-password" className={fieldClass} value={current} onChange={(e) => setCurrent(e.target.value)} />
					</label>
					<label className="flex flex-col gap-1 text-xs text-muted-foreground" htmlFor="account-next">New password (at least 8 characters)
						<input id="account-next" type="password" autoComplete="new-password" className={fieldClass} value={next} onChange={(e) => setNext(e.target.value)} />
					</label>
					<label className="flex flex-col gap-1 text-xs text-muted-foreground" htmlFor="account-confirm">Type it again
						<input id="account-confirm" type="password" autoComplete="new-password" className={fieldClass} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
					</label>
					{message && (
						<p role="status" className={`text-xs ${message.ok ? "text-muted-foreground" : "text-error"}`} data-testid="account-password-message">{message.text}</p>
					)}
					<button type="submit" className={buttonClass} disabled={busy || !current || !next}>Change password</button>
				</form>
			</SettingsGroup>

			<SettingsGroup label="Signed-in devices" testid="account-devices">
				<ul className="flex flex-col gap-1.5">
					{devices.map((d) => (
						<li key={d.id} className="font-ui text-sm" data-testid="account-device">
							<span className="text-foreground">{d.label}</span>
							{d.current && <span className="ml-2 text-xs text-muted-foreground">(this device)</span>}
							<span className="block text-xs text-muted-foreground">
								Signed in {when(d.createdAt)} · last used {when(d.lastSeenAt)} · expires {when(d.expiresAt)}
							</span>
						</li>
					))}
				</ul>
				{confirmingSignOut ? (
					<div className="flex flex-wrap items-center gap-2">
						<span className="text-xs text-muted-foreground">Every device, this one included, will need the password again.</span>
						<button type="button" className={buttonClass} onClick={() => void signOutEverywhere()} data-testid="account-sign-out-confirm">Sign out everywhere</button>
						<button type="button" className={buttonClass} onClick={() => setConfirmingSignOut(false)}>Cancel</button>
					</div>
				) : (
					<div className="flex flex-wrap gap-2">
						<button type="button" className={buttonClass} onClick={() => void signOut()} data-testid="account-sign-out-here">Sign out</button>
						<button type="button" className={buttonClass} onClick={() => setConfirmingSignOut(true)} data-testid="account-sign-out">Sign out everywhere</button>
					</div>
				)}
				{signOutError && <p role="alert" className="text-xs text-error">{signOutError}</p>}
			</SettingsGroup>

			{info && (
				<>
					<SettingsGroup label={ACCOUNT_TEXT.recoveryGroup} testid="account-recovery">
						<p className="font-ui text-sm text-foreground" data-testid="account-recovery-left">{recoveryLeftText(codesLeft ?? info.recoveryCodesLeft)}</p>
						<button type="button" className={buttonClass} onClick={() => { setBoxError(null); setBox("codes"); }} data-testid="account-new-recovery-codes">{ACCOUNT_TEXT.newRecoveryCodes}</button>
					</SettingsGroup>

					<SettingsGroup label={ACCOUNT_TEXT.dataGroup} testid="account-data">
						{/* A real download: the copy answers with an attachment, nothing is held in the page. */}
						<a className={buttonClass} href={`/api/account/export?name=${encodeURIComponent(info.name)}`} download data-testid="account-download">{ACCOUNT_TEXT.download}</a>
						<p className="text-xs text-muted-foreground">{ACCOUNT_TEXT.downloadHelp}</p>
					</SettingsGroup>

					{!info.owner && (
						<div className="mt-5 border-t border-border/60 pt-4" data-testid="account-delete">
							<button type="button" className={dangerClass} onClick={() => { setBoxError(null); setBox("delete"); }} data-testid="account-delete-open">{ACCOUNT_TEXT.deleteAccount}</button>
						</div>
					)}

					{box === "codes" && (
						<PasswordBox testid="account-codes-box" text={ACCOUNT_TEXT.recoveryBox} busy={boxBusy} error={boxError} onCancel={closeBox} onSubmit={(password) => void makeCodes(password)} />
					)}
					{box === "delete" && !info.owner && (
						<PasswordBox testid="account-delete-box" text={ACCOUNT_TEXT.deleteBox} destructive busy={boxBusy} error={boxError} onCancel={closeBox} onSubmit={(password) => void deleteAccount(password)} />
					)}
					{newCodes && <NewCodesBox codes={newCodes} onDone={() => setNewCodes(null)} />}
				</>
			)}
		</div>
	);
}
