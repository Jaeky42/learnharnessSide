"use client";
/**
 * ChatGPT sign-in on the cloud server (side-tutor fork, Phase 2): after
 * signing in at OpenAI the browser lands on http://127.0.0.1:…/auth/callback,
 * which only the server can open. The learner pastes that address here and
 * the server finishes the sign-in (src/server/chatgpt-paste.ts). OpenAI's
 * waiting listener gives up after 3 minutes, so a countdown shows the time left.
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

export const CHATGPT_LOGIN_LIMIT_MS = 180_000;

export const CHATGPT_SERVER_NOTICE = "LearnHarness stores your ChatGPT account details and credentials in an unencrypted file on this LearnHarness server. When this connection is used, relevant conversation context, learning material, and tool results are sent directly to OpenAI. ChatGPT plan limits apply; any additional credits are authorized and managed in ChatGPT, not LearnHarness.";

function left(ms: number): string {
	const s = Math.max(0, Math.ceil(ms / 1000));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function ChatGPTPasteStep({ startedAt }: { startedAt: number }) {
	const [address, setAddress] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [sent, setSent] = useState(false);
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	const remaining = startedAt + CHATGPT_LOGIN_LIMIT_MS - now;

	const finish = async (event: React.FormEvent) => {
		event.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const response = await fetch("/api/subscriptions", {
				method: "POST",
				credentials: "same-origin",
				headers: { "content-type": "application/json", "x-learnharness-subscriptions": "1" },
				body: JSON.stringify({ providerId: "chatgpt", op: "callback", url: address }),
			});
			if (response.ok) { setSent(true); return; }
			const body = (await response.json().catch(() => ({}))) as { error?: string };
			setError(body.error ?? "The sign-in couldn't be finished. Press Connect and try again.");
		} catch {
			setError("The server couldn't be reached. Check your connection and try again.");
		} finally {
			setBusy(false);
		}
	};

	return <form className="mt-3 flex flex-col gap-2 rounded-sm border border-border p-3" onSubmit={finish} data-testid="chatgpt-paste-step">
		<p className="text-xs leading-relaxed text-foreground">
			After you sign in at OpenAI, you&apos;ll land on a page that won&apos;t load. That&apos;s expected. Copy that page&apos;s whole address and paste it here:
		</p>
		<input
			id="chatgpt-paste-address"
			aria-label="Address of the page that wouldn't load"
			value={address}
			onChange={(e) => setAddress(e.target.value)}
			placeholder="http://127.0.0.1:…/auth/callback?code=…"
			autoComplete="off"
			spellCheck={false}
			disabled={busy || sent}
			className="w-full min-w-0 rounded-sm border border-input bg-background px-2.5 py-1.5 font-ui text-xs text-foreground"
		/>
		<div className="flex flex-wrap items-center gap-3">
			<Button type="submit" variant="outline" size="sm" disabled={busy || sent || !address.trim() || remaining <= 0} data-testid="chatgpt-paste-finish">Finish sign-in</Button>
			<span role="timer" className="font-ui text-xs tabular-nums text-muted-foreground">
				{sent ? "Finishing sign-in…" : remaining > 0 ? `${left(remaining)} left` : "Time's up. Close this and press Connect again."}
			</span>
		</div>
		{error && <p role="alert" className="text-xs text-error" data-testid="chatgpt-paste-error">{error}</p>}
	</form>;
}
