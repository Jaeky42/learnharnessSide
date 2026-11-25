"use client";

/**
 * A failed Dictate run, said out loud on a phone (fork; owner's ask).
 *
 * On a phone the idle Dictate button is icon-only (app/phone.css), so the
 * reason a computer shows inside the button is hidden. Here it appears as one
 * short line above the message box for DICTATION_ERROR_MS after each failure,
 * with the words exactly as the dictation gives them (no new wording).
 *
 *   - Phone layout only (useIsPhone); on a computer, a tablet and in the
 *     desktop app nothing is rendered.
 *   - It floats: absolutely positioned against the nearest positioned
 *     ancestor, with pointer-events off, so the message box and the lesson
 *     never move when it comes and goes.
 *   - Centred on the screen (owner's ask; it was left-aligned), as wide as
 *     its words, a long reason wrapping centred. Where the Tutor's bubble
 *     sits just above the message box (the lesson), the caller narrows it by
 *     5.5rem on BOTH sides (`DICTATION_ERROR_BESIDE_BUBBLE`), so it stays
 *     centred and clear of the bubble.
 *
 * The mic icon's error colour is app/phone.css's, from the idle button's
 * `data-dictation-error` attribute (components/dictation.tsx).
 */

import { useEffect, useState } from "react";
import { useIsPhone } from "@/components/phone/use-phone";
import { cn } from "@/lib/utils";

/** How long the line stays after a failure. */
export const DICTATION_ERROR_MS = 5000;

/** The line's place: centred above the bottom block, as wide as its words. */
export const DICTATION_ERROR_PLACE = "inset-x-0 mx-auto w-fit max-w-[calc(100%-2rem)] text-center";
/** For a screen with the Tutor's bubble at the right: the bubble's room kept on both sides. */
export const DICTATION_ERROR_BESIDE_BUBBLE = "max-w-[calc(100%-11rem)]";

/**
 * The failure to show right now: `error` for DICTATION_ERROR_MS after it
 * appears (a new failure, or a different one), then null; null at once when
 * the dictation's error clears (the next tap) and always off the phone layout.
 */
export function useDictationErrorFlash(error: string | null | undefined): string | null {
	const phone = useIsPhone();
	const [shown, setShown] = useState<string | null>(null);
	useEffect(() => {
		if (!phone || !error) {
			setShown(null);
			return;
		}
		setShown(error);
		const timer = setTimeout(() => setShown(null), DICTATION_ERROR_MS);
		return () => clearTimeout(timer);
	}, [phone, error]);
	return phone ? shown : null;
}

export function DictationErrorLine({ error, className }: { error: string | null | undefined; className?: string }) {
	const shown = useDictationErrorFlash(error);
	if (!shown) return null;
	return (
		<div
			role="alert"
			data-testid="dictation-error-line"
			className={cn(
				"pointer-events-none absolute bottom-full rounded-xl border border-border bg-card/95 px-3 py-1.5 text-xs text-error shadow-lg backdrop-blur",
				DICTATION_ERROR_PLACE,
				className,
			)}
		>
			<span className="line-clamp-3">{shown}</span>
		</div>
	);
}
