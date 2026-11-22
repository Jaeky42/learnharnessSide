"use client";
/**
 * THE FLOATING BOX at the top of a lesson (cloud sync, docs/fork/cloud-sync.md).
 *
 * Sessions move between devices by themselves (seamless sessions, owner's
 * decision: components/cloud/session-move.ts), so nothing here says who holds
 * a session or offers to take it over. The box says only two things:
 *
 *   - a move that failed: a write needed the session here and it couldn't be
 *     moved (`useMoveFailed`). It wins over the other message.
 *   - sync trouble on a PC (`useSyncTrouble`: offline after the 30-second
 *     quiet rule, paused, or the pairing removed), in every lesson, because
 *     every session can be continued here: what is added now is discarded if
 *     another device continues the session first.
 *
 * It looks like the update box (components/update-banner.tsx), floats over
 * the lesson 12 px under the top bar and pushes nothing: a zero-height
 * wrapper holds its place and the box is positioned inside it. It sits above
 * the lesson and below the Tutor (z-30), menus and dialogs.
 *
 * The box is always in the page and opens or closes by a data attribute, so
 * it can fade both ways (app/cloud.css); the last words stay while it fades
 * out. The ✕ on a sync message hides it until that trouble next starts (the
 * kind of trouble and, offline, the current offline spell), in every lesson
 * of this window and not across a reload. The ✕ on the failure clears the
 * flag. Nothing renders where sync isn't in use.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { XIcon } from "lucide-react";
import { SESSION_MOVE_FAILED_TEXT, SYNC_TROUBLE_BOX_TEXT, type SyncTrouble } from "@/src/core";
import { useCloud, useSyncTrouble } from "./cloud-state";
import { clearMoveFailed, useMoveFailed } from "./session-move";

// ── The ✕ on a sync message: shared by every lesson of this window ──────────

let dismissedKey: string | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const setDismissed = (key: string | null) => {
	if (dismissedKey === key) return;
	dismissedKey = key;
	for (const listener of [...listeners]) listener();
};

/** Which spell of trouble this is: paused and removed by their kind, offline
 *  by the start of the current offline spell. */
export function troubleKey(trouble: SyncTrouble, offlineSince: number | null | undefined): string {
	return trouble === "offline" ? `offline:${typeof offlineSince === "number" ? offlineSince : "start"}` : trouble;
}

/** Tests only: forget a dismissal. */
export function resetSessionBoxForTests(): void {
	setDismissed(null);
}

interface Shown {
	/** Changes when the words change in place. */
	key: string;
	text: string;
	/** What the ✕ does. */
	dismiss: () => void;
}

export function SessionStrip({ chatId }: { chatId: string; /** Not shown any more (the box names no session). */ title?: string }) {
	const cloud = useCloud();
	const trouble = useSyncTrouble();
	const failed = useMoveFailed(chatId);
	const dismissed = useSyncExternalStore(subscribe, () => dismissedKey, () => null);
	const key = trouble ? troubleKey(trouble, cloud.sync?.offlineSince) : null;

	// The trouble is over: the next one shows again.
	useEffect(() => { if (!trouble) setDismissed(null); }, [trouble]);

	let shown: Shown | null = null;
	if (failed) {
		shown = { key: "failed", text: SESSION_MOVE_FAILED_TEXT, dismiss: () => clearMoveFailed(chatId) };
	} else if (trouble && key !== dismissed) {
		shown = { key: `sync-${trouble}`, text: SYNC_TROUBLE_BOX_TEXT[trouble], dismiss: () => setDismissed(key) };
	}

	// Open one frame after there is something to show, and keep the last
	// words on screen while it fades out.
	const lastRef = useRef<Shown | null>(null);
	if (shown) lastRef.current = shown;
	const [open, setOpen] = useState(false);
	const has = shown !== null;
	useEffect(() => { setOpen(has); }, [has]);
	const view = shown ?? lastRef.current;
	if (cloud.role === null && !view) return null;
	const visible = open && has;

	return (
		<div className="pointer-events-none relative z-20 h-0" data-testid="session-box-anchor">
			<div
				role="status"
				className="lh-session-box absolute inset-x-0 top-3 mx-auto w-[min(36rem,calc(100%-2rem))]"
				data-open={visible ? "" : undefined}
				data-testid="session-box"
				data-box={has ? view?.key : undefined}
				inert={!visible}
			>
				{view && (
					<div className="flex items-center gap-3 rounded-lg border border-border bg-popover px-4 py-3 shadow-lg">
						<p className="min-w-0 flex-1 text-sm" data-testid="session-box-text">{view.text}</p>
						<button
							type="button"
							aria-label="Dismiss"
							data-testid="session-box-dismiss"
							onClick={() => view.dismiss()}
							className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							<XIcon className="size-4" aria-hidden="true" />
						</button>
					</div>
				)}
			</div>
		</div>
	);
}
