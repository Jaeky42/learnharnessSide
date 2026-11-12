"use client";
/**
 * Settings → Cloud on the DESKTOP app (side-tutor fork, cloud sync Phase 6;
 * docs/cloud-sync.md). The server's site shows cloud-server-section.tsx
 * under the same row instead.
 *
 * Not paired: a short pairing form (server address, pairing code, this
 * PC's name). Paired: the sync state, Sync now, and Unpair this PC.
 * Backend: GET | POST /api/cloud (src/server/sync/cloud-http.ts).
 *
 * An app that isn't paired asks its own server once, when this section
 * opens, and never again; a paired one checks every few seconds while the
 * section is open. The wording is owner-approved (src/core/sync/screens.ts).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { CLOUD_TEXT, DEFAULT_DESKTOP_NAME, heldByExample, normalizeServerAddress, recentlyText, serverNotTold } from "@/src/core";
import { announceSyncInUse } from "@/components/cloud/sync-marker";
import { SettingsGroup } from "./controls.tsx";
import { lastSyncedText } from "./obsidian-section.tsx";

export type CloudSyncState = "off" | "starting" | "ok" | "offline" | "paused" | "needs-pairing" | "unpaired";

export interface CloudView {
	role: "desktop";
	paired: boolean;
	server: string | null;
	device: { id: string; name: string } | null;
	sync: { state: CloudSyncState; message: string | null; lastContactAt: number | null };
}

const POLL_MS = 5000;
const fieldClass = "w-full rounded-sm border border-input bg-background px-2.5 py-1.5 font-ui text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring";
const buttonClass = "rounded-sm border border-border px-3 py-1.5 font-ui text-sm text-foreground transition-colors hover:bg-accent disabled:opacity-50";
const primaryClass = "self-start rounded-sm bg-primary px-3 py-1.5 font-ui text-sm text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50";
const dangerClass = "rounded-sm border border-border px-3 py-1.5 font-ui text-sm text-error transition-colors hover:bg-error/10 disabled:opacity-50";

const isPairedState = (state: CloudSyncState): boolean => state === "starting" || state === "ok" || state === "offline" || state === "paused";

/** "just now", "12 minutes ago", then "today, 14:02" or "9 Nov, 18:20". */
export function lastContactText(at: number, now: number = Date.now()): string {
	return recentlyText(at, now) ?? lastSyncedText(at, now);
}

async function send(body: object): Promise<{ ok: boolean; data: Record<string, unknown> }> {
	try {
		const response = await fetch("/api/cloud", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
		return { ok: response.ok, data };
	} catch {
		return { ok: false, data: {} };
	}
}

const asView = (value: unknown): CloudView | null => {
	const view = value as Partial<CloudView> | null;
	return view && view.role === "desktop" && !!view.sync && typeof view.sync.state === "string" ? view as CloudView : null;
};

type Tone = "ok" | "idle" | "trouble";
const DOT: Record<Tone, string> = { ok: "bg-success", idle: "bg-muted-foreground", trouble: "bg-warning" };

function StatusLine({ tone, busy, children }: { tone: Tone; busy?: boolean; children: React.ReactNode }) {
	return (
		<p role="status" className="flex items-center gap-2 font-ui text-sm text-foreground" data-testid="cloud-status">
			{busy
				? <span aria-hidden className="size-2.5 shrink-0 animate-spin rounded-full border-[1.5px] border-muted-foreground border-t-transparent" />
				: <span aria-hidden className={`size-2 shrink-0 rounded-full ${DOT[tone]}`} />}
			<span>{children}</span>
		</p>
	);
}

/** The pairing form: an unpaired PC, and one that has to be paired again. */
function PairForm({ view, notice, onPaired }: { view: CloudView; notice: string | null; onPaired: (next: CloudView) => void }) {
	const [address, setAddress] = useState(view.server ?? "");
	const [code, setCode] = useState("");
	const [name, setName] = useState(view.device?.name ?? DEFAULT_DESKTOP_NAME);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// The same server as before: this isn't a first pairing, and the form says what that means.
	const typed = normalizeServerAddress(address);
	const again = view.server !== null && typed.ok && typed.url === view.server;

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		const reply = await send({ op: "pair", server: address, code, name });
		setBusy(false);
		const next = reply.ok ? asView(reply.data) : null;
		if (next) {
			setCode("");
			onPaired(next);
		} else {
			setError(typeof reply.data.error === "string" ? reply.data.error : "Something went wrong. Try again.");
		}
	};

	return (
		<form className="flex max-w-sm flex-col gap-3" onSubmit={submit} autoComplete="off" data-testid="cloud-pair-form">
			{view.sync.state === "needs-pairing" && <StatusLine tone="trouble">{CLOUD_TEXT.noLongerPaired}</StatusLine>}
			{notice && <p role="status" className="text-xs text-muted-foreground" data-testid="cloud-notice">{notice}</p>}
			<p className="text-xs text-muted-foreground">{CLOUD_TEXT.intro}</p>
			<label className="flex flex-col gap-1 text-xs text-muted-foreground" htmlFor="cloud-address">{CLOUD_TEXT.addressLabel}
				<input id="cloud-address" name="cloud-address" type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="off" placeholder="https://" className={fieldClass} value={address} onChange={(e) => setAddress(e.target.value)} />
			</label>
			<label className="flex flex-col gap-1 text-xs text-muted-foreground" htmlFor="cloud-code">{CLOUD_TEXT.codeLabel}
				<input id="cloud-code" name="cloud-code" type="text" autoCapitalize="characters" autoCorrect="off" spellCheck={false} autoComplete="off" placeholder="XXXX-XXXX" className={`${fieldClass} max-w-40 tracking-wider`} value={code} onChange={(e) => setCode(e.target.value)} />
				<span>{CLOUD_TEXT.codeHelp}</span>
			</label>
			<label className="flex flex-col gap-1 text-xs text-muted-foreground" htmlFor="cloud-name">{CLOUD_TEXT.nameLabel}
				<input id="cloud-name" name="cloud-name" type="text" autoComplete="off" spellCheck={false} maxLength={40} className={`${fieldClass} max-w-60`} value={name} onChange={(e) => setName(e.target.value)} />
				<span data-testid="cloud-name-help">{heldByExample(name)}</span>
			</label>
			<p className="text-xs text-muted-foreground" data-testid="cloud-pair-note">{again ? CLOUD_TEXT.pairingAgain : CLOUD_TEXT.firstPairing}</p>
			<button type="submit" className={primaryClass} disabled={busy || !address.trim() || !code.trim() || !name.trim()} data-testid="cloud-pair">{busy ? CLOUD_TEXT.pairing : CLOUD_TEXT.pair}</button>
			{error && <p role="alert" className="text-xs text-error" data-testid="cloud-error">{error}</p>}
		</form>
	);
}

function PairedView({ view, onView, onUnpaired }: { view: CloudView; onView: (next: CloudView) => void; onUnpaired: (next: CloudView, told: boolean) => void }) {
	const [syncing, setSyncing] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const [unpairing, setUnpairing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const { state, message, lastContactAt } = view.sync;

	const syncNow = async () => {
		setSyncing(true);
		setError(null);
		const reply = await send({ op: "sync" });
		setSyncing(false);
		const next = reply.ok ? asView(reply.data.status) : null;
		if (next) onView(next);
		else setError("Something went wrong. Try again.");
	};

	const unpair = async () => {
		setUnpairing(true);
		setError(null);
		const reply = await send({ op: "unpair" });
		setUnpairing(false);
		const next = reply.ok ? asView(reply.data.status) : null;
		if (next) onUnpaired(next, reply.data.told === true);
		else setError("Something went wrong. Try again.");
	};

	return (
		<div className="flex max-w-md flex-col gap-3" data-testid="cloud-paired">
			<div className="flex flex-wrap items-center justify-between gap-2">
				{syncing ? <StatusLine tone="idle" busy>{CLOUD_TEXT.syncing}</StatusLine>
					: state === "ok" ? <StatusLine tone="ok">{CLOUD_TEXT.upToDate}</StatusLine>
					: state === "starting" ? <StatusLine tone="idle">{CLOUD_TEXT.starting}</StatusLine>
					: state === "offline" ? <StatusLine tone="trouble">{CLOUD_TEXT.offline}</StatusLine>
					: <StatusLine tone="trouble">{message ?? ""}</StatusLine>}
				<button type="button" className={buttonClass} disabled={syncing || unpairing} onClick={() => void syncNow()} data-testid="cloud-sync-now">{CLOUD_TEXT.syncNow}</button>
			</div>
			{lastContactAt !== null && <p className="text-xs text-muted-foreground" data-testid="cloud-last-synced">Last synced {lastContactText(lastContactAt)}</p>}
			<dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-1 font-ui text-sm">
				<dt className="text-muted-foreground">{CLOUD_TEXT.serverRow}</dt>
				<dd className="text-foreground [overflow-wrap:anywhere]" data-testid="cloud-server">{view.server}</dd>
				<dt className="text-muted-foreground">{CLOUD_TEXT.nameRow}</dt>
				<dd className="text-foreground" data-testid="cloud-device">{view.device?.name}</dd>
			</dl>
			{confirming ? (
				<div className="flex flex-col gap-2" data-testid="cloud-unpair-confirm">
					<p className="text-xs text-muted-foreground">{CLOUD_TEXT.unpairConfirm}</p>
					<div className="flex flex-wrap gap-2">
						<button type="button" className={dangerClass} disabled={unpairing} onClick={() => void unpair()} data-testid="cloud-unpair-yes">{CLOUD_TEXT.unpair}</button>
						<button type="button" className={buttonClass} disabled={unpairing} onClick={() => setConfirming(false)}>{CLOUD_TEXT.cancel}</button>
					</div>
				</div>
			) : (
				<button type="button" className={`${buttonClass} self-start`} disabled={syncing} onClick={() => setConfirming(true)} data-testid="cloud-unpair">{CLOUD_TEXT.unpair}</button>
			)}
			{error && <p role="alert" className="text-xs text-error" data-testid="cloud-error">{error}</p>}
		</div>
	);
}

export function CloudSection() {
	/** undefined = still asking, null = couldn't ask. */
	const [view, setView] = useState<CloudView | null | undefined>(undefined);
	const [notice, setNotice] = useState<string | null>(null);
	const alive = useRef(true);

	const load = useCallback(async () => {
		try {
			const response = await fetch("/api/cloud", { cache: "no-store" });
			const next = response.ok ? asView(await response.json()) : null;
			if (!alive.current) return;
			if (next) setView(next); else setView((current) => current ?? null);
		} catch {
			if (alive.current) setView((current) => current ?? null);
		}
	}, []);

	useEffect(() => {
		alive.current = true;
		void load();
		return () => { alive.current = false; };
	}, [load]);

	// Only a paired PC keeps looking; an unpaired one asked once, above.
	const watching = !!view && isPairedState(view.sync.state);
	useEffect(() => {
		if (!watching) return;
		const timer = setInterval(() => { if (document.visibilityState !== "hidden") void load(); }, POLL_MS);
		return () => clearInterval(timer);
	}, [watching, load]);

	return (
		<SettingsGroup label={CLOUD_TEXT.group} testid="cloud-section">
			{view === undefined ? <p className="text-xs text-muted-foreground/70">Loading…</p>
				: view === null ? (
					<div className="flex flex-col items-start gap-2">
						<p role="alert" className="text-xs text-error">Cloud sync couldn’t be checked. Try again.</p>
						<button type="button" className={buttonClass} onClick={() => void load()}>Check again</button>
					</div>
				) : isPairedState(view.sync.state) ? (
					<PairedView
						view={view}
						onView={setView}
						onUnpaired={(next, told) => {
							setNotice(told ? null : serverNotTold(view.device?.name ?? DEFAULT_DESKTOP_NAME));
							setView(next);
							announceSyncInUse(false);
						}}
					/>
				) : (
					<PairForm
						// A fresh form whenever the PC it describes changes.
						key={`${view.sync.state}:${view.server ?? ""}`}
						view={view}
						notice={notice}
						onPaired={(next) => {
							setNotice(null);
							setView(next);
							announceSyncInUse(true);
						}}
					/>
				)}
		</SettingsGroup>
	);
}
