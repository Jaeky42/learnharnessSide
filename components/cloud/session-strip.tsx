"use client";
/**
 * THE STRIP under a lesson's top bar (cloud sync Phase 6, docs/cloud-sync.md).
 *
 * A session another device holds is read-only here: the strip says who
 * holds it and offers Take over (owner's choices: a strip under the top
 * bar, no message box; the strip changes in place while an online holder
 * hands over, with Cancel; a confirm box when turns could be lost).
 *
 * Take over asks this copy's own server (POST /api/cloud), which knows the
 * rules; this component only shows the answer:
 *   moved / yours   the session is here now; the strip goes
 *   waiting         the holder hands over by itself: ask again every 2 s
 *   warning         the offline holder may have unsent turns: the box
 *
 * The strip is always in the page and opens or closes by a data attribute,
 * so it can fade and slide both ways (app/cloud.css). It renders nothing
 * where sync isn't in use.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { askingText, cannotTakeOverText, finishingText, HELD_TEXT, heldStripText, takeOverWarning, type SessionHolder } from "@/src/core";
import { lastSyncedText } from "@/components/settings/obsidian-section";
import { useCloud } from "./cloud-state";
import { TakeOverDialog } from "./take-over-dialog";

const ASK_AGAIN_MS = 2000;
const buttonClass = "shrink-0 rounded-sm border border-border px-3 py-1 font-ui text-sm text-foreground transition-colors hover:bg-accent disabled:opacity-40 disabled:hover:bg-transparent";

type Phase =
	| { kind: "idle" }
	/** The first answer hasn't come yet. */
	| { kind: "asking" }
	| { kind: "waiting"; reason: "reply" | "handing-over" }
	| { kind: "warning"; holder: SessionHolder }
	| { kind: "failed" };

interface Shown {
	/** Changes when the words change in place, so they cross-fade. */
	key: string;
	text: string;
	note: string | null;
	busy: boolean;
	button: "take-over" | "cancel" | null;
	disabled: boolean;
}

const since = (holder: SessionHolder): string | null => (typeof holder.lastSeenAt === "number" ? lastSyncedText(holder.lastSeenAt) : null);

async function ask(chatId: string, force: boolean): Promise<Record<string, unknown> | null> {
	try {
		const response = await fetch("/api/cloud", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "take-over", chatId, force }) });
		if (!response.ok) return null;
		return (await response.json()) as Record<string, unknown>;
	} catch {
		return null;
	}
}

export function SessionStrip({ chatId, title }: { chatId: string; title: string }) {
	const cloud = useCloud();
	const holder = cloud.held[chatId] ?? null;
	const [phase, setPhase] = useState<Phase>({ kind: "idle" });
	const [forcing, setForcing] = useState(false);
	/** Bumped to drop the answer of a request the learner has cancelled or left. */
	const runRef = useRef(0);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const refresh = cloud.refresh;

	const stop = useCallback(() => {
		runRef.current += 1;
		if (timerRef.current) clearTimeout(timerRef.current);
		timerRef.current = null;
	}, []);

	// Another session, or this one is no longer held: start afresh.
	useEffect(() => {
		if (!holder) {
			stop();
			setPhase({ kind: "idle" });
			setForcing(false);
		}
	}, [holder, stop]);
	useEffect(() => {
		stop();
		setPhase({ kind: "idle" });
		setForcing(false);
		return stop;
	}, [chatId, stop]);

	const request = useCallback(async (force: boolean) => {
		const run = ++runRef.current;
		const answer = await ask(chatId, force);
		if (run !== runRef.current) return;
		const status = answer?.status;
		if (status === "moved" || status === "yours") {
			// It is here: the strip goes once the page has heard so. Should the
			// page not hear, Take over is offered again.
			setForcing(false);
			setPhase({ kind: "asking" });
			refresh();
			timerRef.current = setTimeout(() => { if (run === runRef.current) setPhase({ kind: "idle" }); }, 3000);
			return;
		}
		if (status === "waiting") {
			setPhase({ kind: "waiting", reason: answer?.reason === "reply" ? "reply" : "handing-over" });
			timerRef.current = setTimeout(() => { void request(false); }, ASK_AGAIN_MS);
			return;
		}
		if (status === "warning" && answer?.heldBy && typeof answer.heldBy === "object") {
			setForcing(false);
			setPhase({ kind: "warning", holder: answer.heldBy as SessionHolder });
			return;
		}
		setForcing(false);
		setPhase({ kind: "failed" });
	}, [chatId, refresh]);

	const takeOver = () => {
		stop();
		setPhase({ kind: "asking" });
		void request(false);
	};
	const cancel = () => {
		stop();
		setForcing(false);
		setPhase({ kind: "idle" });
	};
	const takeOverAnyway = () => {
		setForcing(true);
		void request(true);
	};

	let shown: Shown | null = null;
	if (holder) {
		// A PC that can't reach its server can't ask for a session.
		const blocked = cloud.role === "desktop" ? cannotTakeOverText(cloud.sync?.state) : null;
		if (phase.kind === "waiting") {
			shown = { key: `waiting-${phase.reason}`, text: phase.reason === "reply" ? finishingText(holder) : askingText(holder), note: null, busy: true, button: "cancel", disabled: false };
		} else if (phase.kind === "failed") {
			shown = { key: "failed", text: HELD_TEXT.failed, note: null, busy: false, button: "take-over", disabled: blocked !== null };
		} else {
			shown = { key: "held", text: heldStripText(holder, since(holder)), note: blocked, busy: false, button: "take-over", disabled: blocked !== null || phase.kind === "asking" || phase.kind === "warning" };
		}
	}

	// Open one frame after there is something to show, and keep the last
	// words on screen while it closes, so it slides both ways.
	const lastRef = useRef<Shown | null>(null);
	if (shown) lastRef.current = shown;
	const [open, setOpen] = useState(false);
	const has = shown !== null;
	useEffect(() => { setOpen(has); }, [has]);
	const view = shown ?? lastRef.current;
	if (cloud.role === null && !view) return null;

	const warning = phase.kind === "warning" && holder ? takeOverWarning(title, phase.holder, since(phase.holder)) : null;

	return (
		<>
			<div className="lh-strip" data-open={open && has ? "" : undefined} data-testid="session-strip" data-strip={has ? view?.key : undefined} inert={!(open && has)}>
				<div>
					{view && (
						<div role="status" className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border bg-card px-3 py-2 font-ui text-sm text-foreground">
							<p key={view.key} className="lh-strip-words min-w-0 flex-1 basis-56">
								{view.busy && <span aria-hidden className="mr-2 inline-block size-2.5 animate-spin rounded-full border-[1.5px] border-muted-foreground border-t-transparent align-[-1px]" />}
								<span data-testid="session-strip-text">{view.text}</span>
								{view.note && <span className="mt-0.5 block text-xs text-muted-foreground" data-testid="session-strip-note">{view.note}</span>}
							</p>
							{view.button === "take-over" && (
								<button type="button" className={buttonClass} disabled={view.disabled} onClick={takeOver} data-testid="take-over">{HELD_TEXT.takeOver}</button>
							)}
							{view.button === "cancel" && (
								<button type="button" className={buttonClass} onClick={cancel} data-testid="take-over-cancel">{HELD_TEXT.cancel}</button>
							)}
						</div>
					)}
				</div>
			</div>
			{warning && <TakeOverDialog title={warning.title} body={warning.body} busy={forcing} onCancel={cancel} onConfirm={takeOverAnyway} />}
		</>
	);
}
