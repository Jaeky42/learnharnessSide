"use client";
/**
 * Claude sign-in on the cloud server (side-tutor fork, Phase 2). Rendered
 * inside the Claude Code settings block only in server mode
 * (claude-code-status.tsx); the desktop app keeps its terminal instructions.
 * Backend: src/server/claude-login-http.ts.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

type Phase = "idle" | "starting" | "waiting" | "verifying" | "done" | "failed";
interface LoginView { phase: Phase; attemptId: string | null; expiresAt: number | null; openPath: string | null; error: string | null }
interface Status { login: LoginView; signedIn: boolean | null }

const HEADERS = { "content-type": "application/json", "x-learnharness-claude-code": "1" };

function left(ms: number): string {
	const s = Math.max(0, Math.ceil(ms / 1000));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function ClaudeServerSignIn() {
	const [status, setStatus] = useState<Status | null>(null);
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [opened, setOpened] = useState(false);
	const [now, setNow] = useState(() => Date.now());
	const live = useRef(true);

	const load = useCallback(async () => {
		try {
			const res = await fetch("/api/claude-code/login", { cache: "no-store", credentials: "same-origin", headers: { "x-learnharness-claude-code": "1" } });
			if (!res.ok) throw new Error(String(res.status));
			const body = await res.json() as Status;
			if (live.current) setStatus(body);
		} catch {
			if (live.current) setError("Couldn't check Claude's sign-in on this server.");
		}
	}, []);

	const control = async (body: object) => {
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/claude-code/login", { method: "POST", credentials: "same-origin", headers: HEADERS, body: JSON.stringify(body) });
			const reply = await res.json().catch(() => ({})) as { login?: LoginView; signedIn?: boolean; error?: string };
			if (!res.ok) setError(reply.error ?? "Something went wrong. Try again.");
			else if (reply.login) setStatus((s) => ({ login: reply.login!, signedIn: reply.signedIn ?? s?.signedIn ?? null }));
		} catch {
			setError("The server couldn't be reached. Check your connection and try again.");
		} finally {
			setBusy(false);
		}
	};

	useEffect(() => { live.current = true; void load(); return () => { live.current = false; }; }, [load]);

	const phase = status?.login.phase ?? "idle";
	const active = phase === "starting" || phase === "waiting" || phase === "verifying";
	// While an attempt runs, follow it; when it ends, re-check the sign-in once.
	useEffect(() => {
		if (!active) return;
		const poll = setInterval(() => void load(), phase === "waiting" ? 3000 : 1000);
		const tick = setInterval(() => setNow(Date.now()), 1000);
		return () => { clearInterval(poll); clearInterval(tick); };
	}, [active, phase, load]);
	useEffect(() => { if (phase === "done") void load(); }, [phase, load]);
	useEffect(() => { if (!active) { setOpened(false); setCode(""); } }, [active]);

	if (!status) return <p className="text-xs text-muted-foreground" data-testid="claude-server-sign-in">{error ?? "Checking Claude's sign-in on this server…"}</p>;
	const shownError = error ?? (phase === "failed" ? status.login.error : null);

	return <div className="space-y-2" data-testid="claude-server-sign-in">
		{status.signedIn && !active ? <div className="flex flex-wrap items-center gap-3">
			<span role="status" className="text-xs text-foreground" data-testid="claude-server-signed-in">Signed in on this server ✓</span>
			<Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => void control({ op: "logout" })} data-testid="claude-server-disconnect">Disconnect</Button>
		</div> : !active ? <div className="flex flex-wrap items-center gap-3">
			<span role="status" className="text-xs text-muted-foreground">{status.signedIn === null ? "Claude Code isn't installed on this server yet." : "Not signed in on this server."}</span>
			<Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => void control({ op: "start" })} data-testid="claude-server-sign-in-start">Sign in to Claude</Button>
		</div> : null}

		{phase === "starting" && <p role="status" className="text-xs text-muted-foreground">Starting Claude Code…</p>}

		{(phase === "waiting" || phase === "verifying") && <form
			className="flex flex-col gap-2 rounded-sm border border-border p-3"
			onSubmit={(e) => { e.preventDefault(); void control({ op: "code", attemptId: status.login.attemptId, code }); }}
			data-testid="claude-server-code-step"
		>
			<p className="text-xs text-foreground">1. {status.login.openPath
				? <a href={status.login.openPath} target="_blank" rel="noreferrer" onClick={() => setOpened(true)} className="underline underline-offset-2" data-testid="claude-server-open">Open Claude sign-in ↗</a>
				: <span className="text-muted-foreground">{opened ? "Sign-in page opened." : "Sign-in page already opened."} Closed it by mistake? Cancel and start again.</span>}
			</p>
			<label htmlFor="claude-server-code" className="text-xs text-foreground">2. After you authorize, paste the code Claude shows you:</label>
			<input id="claude-server-code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} disabled={busy || phase === "verifying"}
				className="w-full min-w-0 rounded-sm border border-input bg-background px-2.5 py-1.5 font-ui text-xs text-foreground" />
			<div className="flex flex-wrap items-center gap-3">
				<Button type="submit" size="xs" variant="outline" disabled={busy || phase === "verifying" || !code.trim()} data-testid="claude-server-finish">Finish</Button>
				<Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => void control({ op: "cancel" })}>Cancel</Button>
				<span role="timer" className="font-ui text-xs tabular-nums text-muted-foreground">
					{phase === "verifying" ? "Checking the code…" : status.login.expiresAt ? `${left(status.login.expiresAt - now)} left` : ""}
				</span>
			</div>
		</form>}

		{shownError && <p role="alert" className="text-xs text-red-400" data-testid="claude-server-error">{shownError}</p>}
	</div>;
}
