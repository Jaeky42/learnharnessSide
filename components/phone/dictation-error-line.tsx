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
 *   - Never above the top bar's end. In a lesson its anchor is the bottom
 *     block's top edge, and an opened question or practice problem grows that
 *     block up to the top bar, which put the line behind the bar (found in a
 *     real Firefox, 15 to 44 px from the top). It is then moved down, with a
 *     transform only, to LINE_TOP_GAP under the top bar (owner's choice of
 *     "fix the hidden line"; the place is option A of the two offered: under
 *     the top bar, over the question's first line, covering no control).
 *   - A long unbroken reason (a provider's JSON) wraps inside the line; it
 *     used to run out of the box's right edge.
 *
 * The mic icon's error colour is app/phone.css's, from the idle button's
 * `data-dictation-error` attribute (components/dictation.tsx).
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
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

/** The clear space kept between the top bar's end (or the screen's top) and the line. */
export const LINE_TOP_GAP = 8;

/**
 * How far down the line must move so its top is LINE_TOP_GAP below the top
 * bar's end (the screen's top where there is no top bar): 0 when it already
 * is. `naturalTop` is the line's top where its anchor puts it, unmoved.
 */
export function lineDrop(naturalTop: number, topBarBottom: number | null): number {
	return Math.max(0, Math.ceil((topBarBottom ?? 0) + LINE_TOP_GAP - naturalTop));
}

export function DictationErrorLine({ error, className }: { error: string | null | undefined; className?: string }) {
	const shown = useDictationErrorFlash(error);
	const ref = useRef<HTMLDivElement>(null);
	// Kept under the top bar for as long as it shows: placed before the first
	// paint, and again whenever the block it hangs on changes size (a question
	// folding or opening, the keyboard) or the window does.
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el || typeof el.getBoundingClientRect !== "function") return;
		let drop = 0;
		const place = () => {
			const bar = document.querySelector('[data-phone="topbar"]')?.getBoundingClientRect() ?? null;
			const next = lineDrop(el.getBoundingClientRect().top - drop, bar ? bar.bottom : null);
			if (next === drop) return;
			drop = next;
			el.style.transform = drop ? `translateY(${drop}px)` : "";
		};
		place();
		const anchor = el.offsetParent;
		const observer = anchor && typeof ResizeObserver !== "undefined" ? new ResizeObserver(place) : null;
		if (anchor) observer?.observe(anchor);
		window.addEventListener("resize", place);
		return () => {
			observer?.disconnect();
			window.removeEventListener("resize", place);
		};
	}, [shown]);
	if (!shown) return null;
	return (
		<div
			ref={ref}
			role="alert"
			data-testid="dictation-error-line"
			className={cn(
				"pointer-events-none absolute bottom-full left-4 w-fit max-w-[calc(100%-5.5rem)] rounded-xl border border-border bg-card/95 px-3 py-1.5 text-xs text-error shadow-lg backdrop-blur",
				className,
			)}
		>
			<span className="line-clamp-3 [overflow-wrap:anywhere]">{shown}</span>
		</div>
	);
}
