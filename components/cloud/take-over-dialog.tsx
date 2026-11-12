"use client";
/**
 * The take-over warning (cloud sync Phase 6, owner's choice: a confirm box
 * with one wording). Shown only when the holder is offline and last told
 * the server it was writing a reply or had unsent changes: taking over then
 * discards those turns when that device is back.
 *
 * The same frame as the notes drawer's Delete box: a dimmed backdrop, Esc
 * and a click outside cancel. It sits on the host's dialog layer
 * (HostDialog, docs/dialog-overlay-contract.md) like the app's own boxes.
 */

import { HostDialog } from "@/components/host-dialog";
import { HELD_TEXT } from "@/src/core";

export function TakeOverDialog({ title, body, busy, onCancel, onConfirm }: {
	title: string;
	body: string;
	busy: boolean;
	onCancel: () => void;
	onConfirm: () => void;
}) {
	const frame = (
		<div
			data-testid="take-over-dialog"
			onClick={(e) => e.stopPropagation()}
			className="max-h-[calc(100dvh-4rem)] w-[26rem] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border bg-card p-5 shadow-xl"
		/>
	);
	return (
		<HostDialog
			open
			aria-label={title}
			frame={frame}
			backdropProps={{ className: "fixed inset-0 z-50 flex items-center justify-center bg-background/80", "data-testid": "take-over-backdrop" }}
			onClose={() => { onCancel(); return "closed"; }}
		>
			<h2 className="text-sm font-semibold" data-testid="take-over-title">{title}</h2>
			<p className="mt-1 text-xs text-muted-foreground" data-testid="take-over-body">{body}</p>
			<div className="mt-5 flex justify-end gap-2">
				<button type="button" onClick={onCancel} className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
					{HELD_TEXT.cancel}
				</button>
				{/* White on the theme's error colour, as upstream's destructive button. */}
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
		</HostDialog>
	);
}
