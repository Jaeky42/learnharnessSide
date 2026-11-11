"use client";
/**
 * Settings → Cloud on the SERVER's site (side-tutor fork, cloud sync
 * Phase 6; docs/cloud-sync.md). Shown only on a server-mode LearnHarness;
 * the desktop app shows cloud-section.tsx under the same row and never
 * renders or requests this.
 *
 * The paired desktop apps (name, when paired, online or last seen), each
 * with Remove, and "Add a desktop app": a pairing code that works once for
 * 10 minutes, with this server's address to type into the PC.
 * Backend: GET /api/cloud (the list) and POST /api/server-auth/desktops
 * (the code, Remove). The wording is owner-approved
 * (src/core/sync/screens.ts).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { CLOUD_SERVER_TEXT, codeTimeLeft, removeConfirm } from "@/src/core";
import { announceSyncInUse } from "@/components/cloud/sync-marker";
import { SettingsGroup } from "./controls.tsx";
import { lastSyncedText } from "./obsidian-section.tsx";

export interface PairedDesktop {
	id: string;
	name: string;
	pairedAt: number;
	online: boolean;
	lastSeenAt: number;
}

/** While a code is showing, the list is checked often, so a PC that pairs appears by itself. */
const CODE_POLL_MS = 3000;
const IDLE_POLL_MS = 10_000;
/** A pairing code's life on the server (PAIRING_CODE_LIFETIME_MS); a PC paired since the code was made used it. */
const CODE_LIFETIME_MS = 10 * 60 * 1000;
const buttonClass = "rounded-sm border border-border px-3 py-1.5 font-ui text-sm text-foreground transition-colors hover:bg-accent disabled:opacity-50";
const dangerClass = "rounded-sm border border-border px-3 py-1.5 font-ui text-sm text-red-500 transition-colors hover:bg-red-500/10 disabled:opacity-50";

const day = (ms: number): string => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** "Paired 12 Nov · online now" or "Paired 3 Nov · last seen 9 Nov, 18:20". */
export function desktopLine(desktop: PairedDesktop, now: number = Date.now()): string {
	return `Paired ${day(desktop.pairedAt)} · ${desktop.online ? CLOUD_SERVER_TEXT.onlineNow : `last seen ${lastSyncedText(desktop.lastSeenAt, now)}`}`;
}

async function post(body: object): Promise<{ ok: boolean; data: Record<string, unknown> }> {
	try {
		const response = await fetch("/api/server-auth/desktops", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
		return { ok: response.ok, data };
	} catch {
		return { ok: false, data: { error: "The server couldn't be reached. Check your connection and try again." } };
	}
}

export function CloudServerSection() {
	/** undefined = still asking, null = couldn't ask. */
	const [desktops, setDesktops] = useState<PairedDesktop[] | null | undefined>(undefined);
	const [code, setCode] = useState<{ code: string; expiresAt: number; known: string[] } | null>(null);
	const [now, setNow] = useState(() => Date.now());
	const [busy, setBusy] = useState(false);
	const [removing, setRemoving] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const alive = useRef(true);

	const load = useCallback(async () => {
		try {
			const response = await fetch("/api/cloud", { cache: "no-store", credentials: "same-origin" });
			const body = response.ok ? (await response.json()) as { role?: string; desktops?: PairedDesktop[] } : null;
			if (!alive.current) return;
			if (body && body.role === "server" && Array.isArray(body.desktops)) setDesktops(body.desktops);
			else setDesktops((current) => current ?? null);
		} catch {
			if (alive.current) setDesktops((current) => current ?? null);
		}
	}, []);

	useEffect(() => {
		alive.current = true;
		void load();
		return () => { alive.current = false; };
	}, [load]);

	const showingCode = code !== null;
	useEffect(() => {
		const timer = setInterval(() => { if (document.visibilityState !== "hidden") void load(); }, showingCode ? CODE_POLL_MS : IDLE_POLL_MS);
		return () => clearInterval(timer);
	}, [showingCode, load]);

	// The countdown, once a second while a code is on screen.
	useEffect(() => {
		if (!showingCode) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [showingCode]);

	// A PC used the code: it is in the list now, and the code box closes.
	useEffect(() => {
		if (!code || !desktops) return;
		if (desktops.some((d) => !code.known.includes(d.id) || d.pairedAt >= code.expiresAt - CODE_LIFETIME_MS)) {
			setCode(null);
			announceSyncInUse(true);
		}
	}, [code, desktops]);

	const newCode = async () => {
		setBusy(true);
		setError(null);
		const reply = await post({ op: "code" });
		setBusy(false);
		if (reply.ok && typeof reply.data.code === "string" && typeof reply.data.expiresAt === "number") {
			setCode({ code: reply.data.code, expiresAt: reply.data.expiresAt, known: (desktops ?? []).map((d) => d.id) });
		} else {
			setError(typeof reply.data.error === "string" ? reply.data.error : "Something went wrong. Try again.");
		}
	};

	const remove = async (id: string) => {
		setBusy(true);
		setError(null);
		const reply = await post({ op: "remove", id });
		setBusy(false);
		setRemoving(null);
		if (!reply.ok) setError(typeof reply.data.error === "string" ? reply.data.error : "Something went wrong. Try again.");
		await load();
	};

	const timeLeft = code ? codeTimeLeft(code.expiresAt, now) : null;

	return (
		<SettingsGroup label={CLOUD_SERVER_TEXT.group} testid="cloud-server-section">
			{desktops === undefined ? <p className="text-xs text-muted-foreground/70">Loading…</p>
				: desktops === null ? (
					<div className="flex flex-col items-start gap-2">
						<p role="alert" className="text-xs text-red-500">Cloud sync couldn’t be checked. Try again.</p>
						<button type="button" className={buttonClass} onClick={() => void load()}>Check again</button>
					</div>
				) : (
					<div className="flex max-w-md flex-col gap-3">
						{desktops.length === 0
							? <p className="text-xs text-muted-foreground" data-testid="cloud-no-desktops">{CLOUD_SERVER_TEXT.none}</p>
							: (
								<ul className="flex flex-col gap-2">
									{desktops.map((desktop) => (
										<li key={desktop.id} className="flex flex-col gap-1.5" data-testid="cloud-desktop">
											<div className="flex items-start justify-between gap-3">
												<span className="min-w-0 font-ui text-sm">
													<span className="block truncate text-foreground">{desktop.name}</span>
													<span className="block text-xs text-muted-foreground">{desktopLine(desktop)}</span>
												</span>
												{removing !== desktop.id && (
													<button type="button" className={buttonClass} disabled={busy} onClick={() => { setError(null); setRemoving(desktop.id); }} data-testid="cloud-remove">{CLOUD_SERVER_TEXT.remove}</button>
												)}
											</div>
											{removing === desktop.id && (
												<div className="flex flex-col gap-2" data-testid="cloud-remove-confirm">
													<p className="text-xs text-muted-foreground">{removeConfirm(desktop.name)}</p>
													<div className="flex flex-wrap gap-2">
														<button type="button" className={dangerClass} disabled={busy} onClick={() => void remove(desktop.id)} data-testid="cloud-remove-yes">{CLOUD_SERVER_TEXT.remove}</button>
														<button type="button" className={buttonClass} disabled={busy} onClick={() => setRemoving(null)}>{CLOUD_SERVER_TEXT.cancel}</button>
													</div>
												</div>
											)}
										</li>
									))}
								</ul>
							)}
						{code ? (
							<div className="flex flex-col gap-2 rounded-sm border border-border p-3" data-testid="cloud-code-box">
								{timeLeft ? (
									<dl className="grid grid-cols-1 gap-x-3 gap-y-1 font-ui text-sm sm:grid-cols-[7rem_minmax(0,1fr)]">
										<dt className="text-muted-foreground">{CLOUD_SERVER_TEXT.codeLabel}</dt>
										<dd>
											<span className="block select-all text-lg tracking-widest text-foreground" data-testid="cloud-code">{code.code}</span>
											<span className="block text-xs text-muted-foreground tabular-nums" data-testid="cloud-code-time">{timeLeft}</span>
										</dd>
										<dt className="mt-1.5 text-muted-foreground sm:mt-0">{CLOUD_SERVER_TEXT.addressLabel}</dt>
										<dd className="select-all text-foreground [overflow-wrap:anywhere]" data-testid="cloud-server-address">{window.location.origin}</dd>
									</dl>
								) : <p className="text-xs text-muted-foreground" data-testid="cloud-code-gone">{CLOUD_SERVER_TEXT.codeGone}</p>}
								{timeLeft && <p className="text-xs text-muted-foreground">{CLOUD_SERVER_TEXT.codeHelp}</p>}
								<div className="flex flex-wrap gap-2">
									<button type="button" className={buttonClass} disabled={busy} onClick={() => void newCode()} data-testid="cloud-new-code">{CLOUD_SERVER_TEXT.newCode}</button>
									<button type="button" className={buttonClass} disabled={busy} onClick={() => setCode(null)} data-testid="cloud-code-done">{CLOUD_SERVER_TEXT.done}</button>
								</div>
							</div>
						) : (
							<button type="button" className={`${buttonClass} self-start`} disabled={busy} onClick={() => void newCode()} data-testid="cloud-add">{CLOUD_SERVER_TEXT.add}</button>
						)}
						{error && <p role="alert" className="text-xs text-red-500" data-testid="cloud-error">{error}</p>}
					</div>
				)}
		</SettingsGroup>
	);
}
