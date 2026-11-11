"use client";
/**
 * THE DISCARD BOX (cloud sync Phase 6, owner's choice: a box over the app,
 * once, with OK). A session this PC had continued was taken over on another
 * device, so what the PC hadn't sent was discarded (no copies). The box
 * names the session and how many messages went; several sessions at once
 * share one box, one line each.
 *
 * It shows on whatever screen the learner is on, as soon as it happens or
 * when the app is next opened. Only OK closes it, and clears it for good
 * (POST /api/cloud {op:"dismiss-notice"}): a click outside or Esc does
 * nothing, so it can't be lost by accident.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DISCARD_OK, discardBox } from "@/src/core";
import { useCloud, type CloudNotice } from "./cloud-state";

const keyOf = (notice: CloudNotice): string => `${notice.chatId}|${notice.at}`;

async function dismiss(notice: CloudNotice): Promise<void> {
	try {
		await fetch("/api/cloud", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "dismiss-notice", chatId: notice.chatId, at: notice.at }) });
	} catch { /* it shows again at the next start */ }
}

export function DiscardNotice() {
	const cloud = useCloud();
	/** Read here already; they stay away while the server is told. */
	const [read, setRead] = useState<ReadonlySet<string>>(() => new Set());
	const notices = useMemo(
		() => (cloud.role === "desktop" ? cloud.notices.filter((notice) => !read.has(keyOf(notice))) : []),
		[cloud.role, cloud.notices, read],
	);
	const box = discardBox(notices);
	const okRef = useRef<HTMLButtonElement>(null);
	const shown = box !== null;
	useEffect(() => { if (shown) okRef.current?.focus(); }, [shown]);
	if (!box) return null;

	const ok = () => {
		const gone = notices;
		setRead((current) => new Set([...current, ...gone.map(keyOf)]));
		void Promise.all(gone.map(dismiss)).then(() => cloud.refresh());
	};

	return createPortal(
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80" data-testid="discard-backdrop">
			<div
				role="alertdialog"
				aria-modal="true"
				aria-label={box.title}
				data-testid="discard-dialog"
				className="max-h-[calc(100dvh-4rem)] w-[26rem] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border bg-card p-5 shadow-xl"
			>
				<h2 className="text-sm font-semibold" data-testid="discard-title">{box.title}</h2>
				<div className="mt-1 flex flex-col gap-2 text-xs text-muted-foreground" data-testid="discard-body">
					{box.lines.length === 1 ? <p>{box.before} {box.lines[0]} {box.after}</p> : (
						<>
							<p>{box.before}</p>
							<ul className="flex flex-col gap-1">
								{box.lines.map((line, index) => <li key={keyOf(notices[index]!)} data-testid="discard-line">{line}</li>)}
							</ul>
							<p>{box.after}</p>
						</>
					)}
				</div>
				<div className="mt-5 flex justify-end">
					<button
						ref={okRef}
						type="button"
						onClick={ok}
						data-testid="discard-ok"
						className="rounded-md border border-border px-4 py-1.5 text-sm text-foreground transition-colors hover:bg-accent"
					>
						{DISCARD_OK}
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}
