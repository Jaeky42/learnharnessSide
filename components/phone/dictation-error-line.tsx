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
 *   - Left-aligned and kept clear of the right 5.5rem, where the Tutor's
 *     bubble sits just above the message box.
 *
 * The mic icon's error colour is app/phone.css's, from the idle button's
 * `data-dictation-error` attribute (components/dictation.tsx).
 */

import { useEffect, useState } from "react";
import { useIsPhone } from "@/components/phone/use-phone";
import { cn } from "@/lib/utils";

/** How long the line stays after a failure. */
export const DICTATION_ERROR_MS = 5000;

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
				"pointer-events-none absolute bottom-full left-4 w-fit max-w-[calc(100%-5.5rem)] rounded-xl border border-border bg-card/95 px-3 py-1.5 text-xs text-error shadow-lg backdrop-blur",
				className,
			)}
		>
			<span className="line-clamp-3">{shown}</span>
		</div>
	);
}
