"use client";
/**
 * The take-over warning (cloud sync Phase 6, owner's choice: a confirm box
 * with one wording). Shown only when the holder is offline and last told
 * the server it was writing a reply or had unsent changes: taking over then
 * discards those turns when that device is back.
 *
 * The same frame as the notes drawer's Delete box: a dimmed backdrop, Esc
 * and a click outside cancel.
 */

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { HELD_TEXT } from "@/src/core";

export function TakeOverDialog({ title, body, busy, onCancel, onConfirm }: {
	title: string;
	body: string;
	busy: boolean;
	onCancel: () => void;
	onConfirm: () => void;
}) {
	const backdrop = useBackdropDismiss(onCancel);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				onCancel();
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onCancel]);
	return createPortal(
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80" data-testid="take-over-backdrop" {...backdrop}>
			<div
				role="dialog"
				aria-modal="true"
				aria-label={title}
				data-testid="take-over-dialog"
				onClick={(e) => e.stopPropagation()}
				className="max-h-[calc(100dvh-4rem)] w-[26rem] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border bg-card p-5 shadow-xl"
			>
				<h2 className="text-sm font-semibold" data-testid="take-over-title">{title}</h2>
				<p className="mt-1 text-xs text-muted-foreground" data-testid="take-over-body">{body}</p>
				<div className="mt-5 flex justify-end gap-2">
					<button type="button" onClick={onCancel} className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
						{HELD_TEXT.cancel}
					</button>
					<button
						type="button"
						onClick={onConfirm}
						disabled={busy}
						data-testid="take-over-anyway"
						className="rounded-md bg-destructive px-3 py-1.5 text-sm text-white transition-colors hover:bg-destructive/90 disabled:opacity-40"
					>
						{HELD_TEXT.takeOverAnyway}
					</button>
				</div>
			</div>
		</div>,
		document.body,
	);
}
