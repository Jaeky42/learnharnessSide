"use client";
/**
 * Settings → Account (side-tutor fork, cloud sync Phase 1). Shown only on a
 * server-mode LearnHarness (docs/cloud-sync.md): GET /api/server-auth/account
 * answers 404 everywhere else, and the tab stays hidden.
 *
 * Change password (signs out every other device), the signed-in devices
 * list, Sign out (this device), and Sign out everywhere (this device included). No browser
 * confirm(): the destructive button asks once more inline.
 */

import { useCallback, useEffect, useState } from "react";
import { SettingsGroup } from "./controls.tsx";
import { isServerMode } from "./server-mode";

export interface AccountDevice {
	id: string;
	label: string;
	createdAt: number;
	lastSeenAt: number;
	expiresAt: number;
	current: boolean;
}

/** undefined = still checking, null = not a server (hide the tab). */
export function useServerAccount(): { devices: AccountDevice[] | null | undefined; reload: () => void } {
	const [devices, setDevices] = useState<AccountDevice[] | null | undefined>(undefined);
	const reload = useCallback(() => {
		if (!isServerMode()) { setDevices(null); return; } // desktop/local: no request at all
		fetch("/api/server-auth/account", { credentials: "same-origin" })
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
			.then((body: { devices: AccountDevice[] }) => setDevices(body.devices))
			.catch(() => setDevices(null));
	}, []);
	useEffect(reload, [reload]);
	return { devices, reload };
}

const fieldClass = "w-full rounded-sm border border-input bg-background px-2.5 py-1.5 font-ui text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring";
const buttonClass = "self-start rounded-sm border border-border px-3 py-1.5 font-ui text-sm text-foreground transition-colors hover:bg-accent disabled:opacity-50";

function when(ms: number): string {
	return new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

async function post(path: string, body?: object): Promise<{ ok: boolean; error?: string }> {
	try {
		const res = await fetch(path, {
			method: "POST",
			credentials: "same-origin",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body ?? {}),
		});
		if (res.ok) return { ok: true };
		const detail = (await res.json().catch(() => ({}))) as { error?: string };
		return { ok: false, error: detail.error ?? "Something went wrong. Try again." };
	} catch {
		return { ok: false, error: "The server couldn't be reached. Check your connection and try again." };
	}
}

export function AccountSection({ devices, reload }: { devices: AccountDevice[]; reload: () => void }) {
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

	const signOut = async () => {
		setSignOutError(null);
		const result = await post("/api/server-auth/logout");
		if (result.ok) window.location.replace("/login");
		else setSignOutError(result.error ?? "Something went wrong. Try again.");
	};

	const signOutEverywhere = async () => {
		setSignOutError(null);
		const result = await post("/api/server-auth/sign-out-everywhere");
		if (result.ok) window.location.replace("/login");
		else setSignOutError(result.error ?? "Something went wrong. Try again.");
	};

	return (
		<div data-testid="account-section">
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
						<p role="status" className={`text-xs ${message.ok ? "text-muted-foreground" : "text-red-500"}`} data-testid="account-password-message">{message.text}</p>
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
				{signOutError && <p role="alert" className="text-xs text-red-500">{signOutError}</p>}
			</SettingsGroup>
		</div>
	);
}
