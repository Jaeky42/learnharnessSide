"use client";
/**
 * Settings → Obsidian (side-tutor fork, cloud sync Phase 4). Shown only on
 * a server-mode LearnHarness (docs/cloud-sync.md); the desktop app never
 * renders it and makes no request for it. Backend:
 * src/server/obsidian-sync-http.ts.
 *
 * Sign in to Obsidian, pick the vault, watch the sync state, Disconnect.
 * The Obsidian password and the vault's encryption password are sent once
 * and never kept: the fields are cleared as soon as the server answers.
 * Wording is owner-approved (the Phase 4 plan); the strings shared with the
 * server live in src/core/obsidian-sync.ts.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { OBSIDIAN_SYNC_LABEL, OBSIDIAN_TEXT, type ObsidianSyncState, type ObsidianVault, type ObsidianView } from "@/src/core";

const HEADERS = { "content-type": "application/json", "x-learnharness-obsidian": "1" };
const fieldClass = "w-full rounded-sm border border-input bg-background px-2.5 py-1.5 font-ui text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring";
const buttonClass = "rounded-sm border border-border px-3 py-1.5 font-ui text-sm text-foreground transition-colors hover:bg-accent disabled:opacity-50";
const primaryClass = "rounded-sm bg-primary px-3 py-1.5 font-ui text-sm text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50";
const dangerClass = "rounded-sm border border-border px-3 py-1.5 font-ui text-sm text-red-500 transition-colors hover:bg-red-500/10 disabled:opacity-50";

interface Reply {
	ok: boolean;
	error?: string;
	detail?: string | null;
	unsynced?: boolean;
	vaults?: ObsidianVault[];
}

type Tone = "ok" | "busy" | "stopped";
const TONE: Record<ObsidianSyncState, Tone> = {
	starting: "busy",
	"first-sync": "busy",
	"up-to-date": "ok",
	syncing: "busy",
	offline: "busy",
	"needs-sign-in": "stopped",
	subscription: "stopped",
	"vault-gone": "stopped",
	paused: "stopped",
	failing: "stopped",
};
const DOT: Record<Tone, string> = { ok: "bg-emerald-500", busy: "bg-amber-500", stopped: "bg-red-500" };

/** "today, 14:02", or the date and time on another day. */
export function lastSyncedText(at: number, now: number = Date.now()): string {
	const then = new Date(at);
	const time = then.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	const sameDay = then.toDateString() === new Date(now).toDateString();
	return sameDay ? `today, ${time}` : `${then.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${time}`;
}

/** A line with a coloured bar at its left. The bar is its own element: the
 *  app's global border colour rule beats border-colour utilities. */
function Notice({ tone, children, testid }: { tone: "stopped" | "warning"; children: React.ReactNode; testid?: string }) {
	return (
		<p role="alert" className="flex gap-2 text-xs text-foreground" data-testid={testid}>
			<span aria-hidden className={`w-0.5 shrink-0 self-stretch rounded-full ${tone === "stopped" ? "bg-red-500" : "bg-amber-500"}`} />
			<span>{children}</span>
		</p>
	);
}

function ErrorLine({ error }: { error: { text: string; detail?: string | null } | null }) {
	if (!error) return null;
	return (
		<div role="alert" className="text-xs text-red-500" data-testid="obsidian-error">
			<p>{error.text}</p>
			{error.detail && <p className="mt-0.5 text-muted-foreground">Obsidian said: {error.detail}</p>}
		</div>
	);
}

/** Email, password and the optional two-step code. Used to sign in, and to
 *  sign in again when a connected vault's sign-in stopped being valid. */
function SignInForm({ onSignedIn, control, onCancel }: {
	onSignedIn: () => void;
	control: (body: object) => Promise<Reply>;
	onCancel?: () => void;
}) {
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<{ text: string; detail?: string | null } | null>(null);
	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		const reply = await control({ op: "sign-in", email, password, code });
		setBusy(false);
		if (reply.ok) {
			setPassword("");
			setCode("");
			onSignedIn();
		} else {
			// The password stays in the box for the two-step retry; the code is one-use.
			setCode("");
			setError({ text: reply.error ?? "Something went wrong. Try again.", detail: reply.detail });
		}
	};
	return (
		<form className="flex max-w-sm flex-col gap-2" onSubmit={submit} data-testid="obsidian-sign-in" autoComplete="off">
			<label className="flex flex-col gap-1 text-xs text-muted-foreground" htmlFor="obsidian-email">Obsidian email
				<input id="obsidian-email" name="obsidian-email" type="email" inputMode="email" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="off" className={fieldClass} value={email} onChange={(e) => setEmail(e.target.value)} />
			</label>
			<label className="flex flex-col gap-1 text-xs text-muted-foreground" htmlFor="obsidian-password">Obsidian password
				<input id="obsidian-password" name="obsidian-password" type="password" autoComplete="off" className={fieldClass} value={password} onChange={(e) => setPassword(e.target.value)} />
			</label>
			<label className="flex flex-col gap-1 text-xs text-muted-foreground" htmlFor="obsidian-code">Two-step code
				<input id="obsidian-code" name="obsidian-code" type="text" inputMode="numeric" autoComplete="one-time-code" className={fieldClass} value={code} onChange={(e) => setCode(e.target.value)} />
				<span>Only if your Obsidian account asks for one.</span>
			</label>
			<p className="text-xs text-muted-foreground">Your password goes straight to Obsidian’s sync program and is never saved here.</p>
			<ErrorLine error={error} />
			<div className="flex flex-wrap justify-end gap-2">
				{onCancel && <button type="button" className={buttonClass} disabled={busy} onClick={onCancel}>Cancel</button>}
				<button type="submit" className={primaryClass} disabled={busy || !email.trim() || !password} data-testid="obsidian-sign-in-submit">{busy ? "Signing in…" : "Sign in"}</button>
			</div>
		</form>
	);
}

function ChooseVault({ view, control }: { view: ObsidianView; control: (body: object) => Promise<Reply> }) {
	const [vaults, setVaults] = useState<ObsidianVault[] | null>(null);
	const [listError, setListError] = useState<string | null>(null);
	const [vaultId, setVaultId] = useState("");
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<{ text: string } | null>(null);
	const load = useCallback(async () => {
		setListError(null);
		setVaults(null);
		const reply = await control({ op: "vaults" });
		if (reply.ok && reply.vaults) {
			setVaults(reply.vaults);
			setVaultId((current) => current || reply.vaults?.[0]?.id || "");
		} else {
			setListError(reply.error ?? "Something went wrong. Try again.");
		}
	}, [control]);
	useEffect(() => { void load(); }, [load]);
	const connect = async (event: React.FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		const reply = await control({ op: "connect", vaultId, password });
		setBusy(false);
		if (reply.ok) setPassword("");
		else setError({ text: reply.error ?? "Something went wrong. Try again." });
	};
	const signOut = async () => {
		setBusy(true);
		await control({ op: "sign-out" });
		setBusy(false);
	};
	return (
		<div className="flex max-w-sm flex-col gap-3" data-testid="obsidian-choose-vault">
			<p className="text-xs text-muted-foreground">
				{view.account?.email ? `Signed in as ${view.account.name ? `${view.account.name} (${view.account.email})` : view.account.email}` : "Signed in to Obsidian"}
				{" · "}
				<button type="button" className="underline underline-offset-2 hover:text-foreground disabled:opacity-50" disabled={busy} onClick={() => void signOut()} data-testid="obsidian-sign-out">Sign out</button>
			</p>
			<div>
				<h3 className="font-ui text-sm font-medium text-foreground">Choose your vault</h3>
				<p className="mt-1 text-xs text-muted-foreground">Pick the vault that holds your LearnHarness folder.</p>
			</div>
			{vaults === null && !listError && <p role="status" className="text-xs text-muted-foreground">Loading your vaults…</p>}
			{listError && (
				<div className="flex flex-col items-start gap-2">
					<p role="alert" className="text-xs text-red-500" data-testid="obsidian-error">{listError}</p>
					<button type="button" className={buttonClass} onClick={() => void load()}>Check again</button>
				</div>
			)}
			{vaults && (
				<form className="flex flex-col gap-3" onSubmit={connect} autoComplete="off">
					<fieldset className="flex flex-col gap-1.5">
						<legend className="sr-only">Vault</legend>
						{vaults.map((vault) => (
							<label key={vault.id} className="flex items-center gap-2 font-ui text-sm text-foreground">
								<input type="radio" name="obsidian-vault" value={vault.id} checked={vaultId === vault.id} onChange={() => setVaultId(vault.id)} />
								{vault.name}
							</label>
						))}
					</fieldset>
					<label className="flex flex-col gap-1 text-xs text-muted-foreground" htmlFor="obsidian-vault-password">Vault encryption password
						<input id="obsidian-vault-password" name="obsidian-vault-password" type="password" autoComplete="off" className={fieldClass} value={password} onChange={(e) => setPassword(e.target.value)} />
						<span>The password you set for end-to-end encryption. Leave it empty if this vault uses standard encryption.</span>
					</label>
					<ErrorLine error={error} />
					<div className="flex justify-end">
						<button type="submit" className={primaryClass} disabled={busy || !vaultId} data-testid="obsidian-connect">{busy ? "Connecting…" : "Connect"}</button>
					</div>
				</form>
			)}
		</div>
	);
}

function Connected({ view, control }: { view: ObsidianView; control: (body: object) => Promise<Reply> }) {
	const [confirming, setConfirming] = useState(false);
	const [signingIn, setSigningIn] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<{ text: string } | null>(null);
	/** The server found unsynced changes when Disconnect was pressed. */
	const [unsyncedAtPress, setUnsyncedAtPress] = useState(false);
	const sync = view.sync ?? "starting";
	const unsynced = view.unsynced || unsyncedAtPress;

	const disconnect = async () => {
		setBusy(true);
		setError(null);
		const reply = await control({ op: "disconnect", force: unsynced });
		setBusy(false);
		if (reply.ok) { setConfirming(false); setUnsyncedAtPress(false); return; }
		if (reply.unsynced) { setUnsyncedAtPress(true); return; }
		setError({ text: reply.error ?? "Something went wrong. Try again." });
	};
	const retry = async () => {
		setBusy(true);
		await control({ op: "retry" });
		setBusy(false);
	};

	if (confirming) {
		return (
			<div className="flex max-w-sm flex-col gap-2 rounded-sm border border-border p-3" data-testid="obsidian-disconnect-confirm">
				<h3 className="font-ui text-sm font-medium text-foreground">Disconnect Obsidian?</h3>
				<p className="text-xs text-muted-foreground">The notes are removed from this server. They stay in Obsidian and on your other devices.</p>
				{unsynced && <Notice tone="warning" testid="obsidian-unsynced">{OBSIDIAN_TEXT.unsynced}</Notice>}
				<ErrorLine error={error} />
				<div className="flex flex-wrap justify-end gap-2">
					<button type="button" className={buttonClass} disabled={busy} onClick={() => { setConfirming(false); setUnsyncedAtPress(false); setError(null); }}>Cancel</button>
					<button type="button" className={dangerClass} disabled={busy} onClick={() => void disconnect()} data-testid="obsidian-disconnect-confirm-button">{unsynced ? "Disconnect anyway" : "Disconnect"}</button>
				</div>
			</div>
		);
	}

	return (
		<div className="flex max-w-sm flex-col gap-3" data-testid="obsidian-connected">
			<div>
				<h3 className="font-ui text-sm font-medium text-foreground">Connected to &quot;{view.vault?.name}&quot;</h3>
				{view.account?.email && <p className="mt-0.5 text-xs text-muted-foreground">Signed in as {view.account.email}</p>}
			</div>
			<p role="status" className="flex items-center gap-2 font-ui text-sm text-foreground" data-testid="obsidian-sync-state" data-state={sync}>
				<span aria-hidden className={`inline-block size-2 shrink-0 rounded-full ${DOT[TONE[sync]]}`} />
				{OBSIDIAN_SYNC_LABEL[sync]}
			</p>
			{sync === "up-to-date" && view.lastSyncedAt && <p className="text-xs text-muted-foreground">Last synced {lastSyncedText(view.lastSyncedAt)}</p>}

			{sync === "needs-sign-in" && (
				<>
					<Notice tone="stopped">Sign in to Obsidian again.</Notice>
					<p className="text-xs text-muted-foreground">Your notes stay on this server. What you write here syncs once you’re signed in again.</p>
					{signingIn && <SignInForm control={control} onSignedIn={() => setSigningIn(false)} onCancel={() => setSigningIn(false)} />}
				</>
			)}
			{sync === "paused" && (
				<>
					<Notice tone="stopped">{OBSIDIAN_TEXT.paused}</Notice>
					<p className="text-xs text-muted-foreground">{OBSIDIAN_TEXT.pausedFix}</p>
				</>
			)}

			{sync !== "paused" && (
				<>
					<div className="flex flex-col gap-0.5 border-t border-border/60 pt-3">
						<span className="text-xs text-muted-foreground">Left out of this server</span>
						<span className="font-ui text-sm text-foreground" data-testid="obsidian-left-out">{view.leftOut.length ? view.leftOut.join(", ") : "Nothing yet"}</span>
					</div>
					<p className="text-xs text-muted-foreground">Loose files at the top of your vault are copied too. Obsidian Sync can only leave out folders.</p>
				</>
			)}

			{!(sync === "needs-sign-in" && signingIn) && (
				<div className="flex flex-wrap justify-end gap-2">
					{(sync === "failing" || sync === "subscription") && <button type="button" className={buttonClass} disabled={busy} onClick={() => void retry()} data-testid="obsidian-retry">Try again</button>}
					<button type="button" className={sync === "paused" ? dangerClass : buttonClass} disabled={busy} onClick={() => setConfirming(true)} data-testid="obsidian-disconnect">Disconnect</button>
					{sync === "needs-sign-in" && <button type="button" className={primaryClass} onClick={() => setSigningIn(true)} data-testid="obsidian-sign-in-again">Sign in again</button>}
				</div>
			)}
		</div>
	);
}

export function ObsidianSection() {
	const [view, setView] = useState<ObsidianView | null>(null);
	const [failed, setFailed] = useState(false);
	const live = useRef(true);

	const load = useCallback(async () => {
		try {
			const res = await fetch("/api/obsidian", { cache: "no-store", credentials: "same-origin", headers: { "x-learnharness-obsidian": "1" } });
			if (!res.ok) throw new Error(String(res.status));
			const body = (await res.json()) as { obsidian: ObsidianView };
			if (live.current) { setView(body.obsidian); setFailed(false); }
		} catch {
			if (live.current) setFailed(true);
		}
	}, []);

	const control = useCallback(async (body: object): Promise<Reply> => {
		try {
			const res = await fetch("/api/obsidian", { method: "POST", credentials: "same-origin", headers: HEADERS, body: JSON.stringify(body) });
			const reply = (await res.json().catch(() => ({}))) as { obsidian?: ObsidianView; error?: string; detail?: string | null; unsynced?: boolean; vaults?: ObsidianVault[] };
			if (reply.obsidian && live.current) setView(reply.obsidian);
			return res.ok
				? { ok: true, vaults: reply.vaults }
				: { ok: false, error: reply.error ?? "Something went wrong. Try again.", detail: reply.detail, unsynced: reply.unsynced };
		} catch {
			return { ok: false, error: "The server couldn’t be reached. Check your connection and try again." };
		}
	}, []);

	useEffect(() => {
		live.current = true;
		void load();
		const poll = setInterval(() => { if (document.visibilityState !== "hidden") void load(); }, 2000);
		return () => { live.current = false; clearInterval(poll); };
	}, [load]);

	if (!view) {
		return <p className="text-xs text-muted-foreground" data-testid="obsidian-section">{failed ? "Couldn’t check Obsidian sync on this server." : "Loading…"}</p>;
	}

	return (
		<div data-testid="obsidian-section" data-phase={view.phase}>
			{view.phase === "installing" && (
				<div className="flex max-w-sm flex-col items-start gap-3">
					<p className="text-xs text-muted-foreground">{OBSIDIAN_TEXT.installing}</p>
					<button type="button" className={buttonClass} onClick={() => void control({ op: "retry" })}>Check again</button>
				</div>
			)}
			{view.phase === "signed-out" && (
				<div className="flex max-w-sm flex-col gap-3">
					<div>
						<h3 className="font-ui text-sm font-medium text-foreground">Connect your Obsidian vault</h3>
						<p className="mt-1 text-xs leading-relaxed text-muted-foreground">Your notes sync with Obsidian through Obsidian Sync, so the notes drawer shows the same notes here as in Obsidian. Only the LearnHarness folder is copied to this server.</p>
					</div>
					<SignInForm control={control} onSignedIn={() => undefined} />
				</div>
			)}
			{view.phase === "signed-in" && <ChooseVault view={view} control={control} />}
			{view.phase === "connected" && <Connected view={view} control={control} />}
		</div>
	);
}
