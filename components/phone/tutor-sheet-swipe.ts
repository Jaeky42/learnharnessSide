"use client";

/**
 * THE TUTOR'S SHEET SWIPES DOWN TO MINIMIZE (phone layout; owner's choice
 * from a live demo, "A: handle and top bar").
 *
 *  - A swipe starts only on the handle strip at the sheet's top and on the
 *    top bar ("Tutor"). Not on the conversation (it only scrolls), not on
 *    the typing row, and not on a button in the bar (the − button).
 *  - The sheet follows the finger downward, never above its resting place.
 *    The dim over the lesson fades with it.
 *  - Let go past a quarter of the sheet's height, or after a quick flick
 *    down, and it slides away and the Tutor is minimized; otherwise it
 *    springs back.
 *  - The − button, a tap on the dim, Esc and "Show in the lesson" slide it
 *    away the same way (side-tutor.tsx calls slideAway()).
 *  - Only transform (and the dim's opacity) move. With reduced motion,
 *    everything happens at once; the sheet still follows the finger.
 *
 * Touch rules learned on the owner's iPhone (use-dock-touch-scroll.ts): the
 * drag is decided on its FIRST movement and that move's default is
 * prevented from then on, or Safari starts scrolling the page and can't be
 * stopped; the release speed is the finger's last 80 ms (releaseVelocity),
 * nothing if it had stopped; a second finger cancels the drag. The page lock
 * (window-lock.ts) also prevents a drag on the bar, which nothing can scroll;
 * the two agree. The sheet isn't inside the dock, so the dock's helper never
 * sees these touches.
 *
 * The sheet opens with a CSS slide (app/phone.css, lh-phone-in-up), which
 * overrides an inline transform while it runs. A swipe that starts during it
 * picks the sheet up where it is: the running slide is cancelled and the drag
 * goes on from the place it had reached.
 */

import { useEffect, useRef, type RefObject } from "react";
import { MORPH_EASE } from "@/components/side-tutor-window";
import { releaseVelocity } from "@/components/phone/use-dock-touch-scroll";

/** Past this share of the sheet's height, letting go minimizes. */
export const SHEET_CLOSE_FRACTION = 0.25;
/** A flick: faster than this over the finger's last 80 ms (px per ms)… */
export const SHEET_FLICK_SPEED = 0.5;
/** …and moved more than this (px). */
export const SHEET_FLICK_MIN = 12;
/** The spring back to the resting place. */
export const SHEET_SPRING_MS = 200;
/** The slide away from the resting place; shorter for what is left to travel, never under the floor. */
export const SHEET_SLIDE_MS = 260;
export const SHEET_SLIDE_MIN_MS = 130;
/** The easing of the slide and the spring (the computer's morph). */
export const SHEET_EASE = MORPH_EASE;

/** Pure rule: how far down the sheet is for a finger that has moved dy from
 *  where the drag picked the sheet up at `base`. Never above its place. */
export function sheetOffset(base: number, dy: number): number {
	return Math.max(0, base + dy);
}

/** Pure rule: the release speed in px per ms, downward positive, over the
 *  finger's last 80 ms; 0 if it had stopped before lifting. */
export function sheetReleaseSpeed(samples: { t: number; y: number }[], endT: number): number {
	return releaseVelocity(samples, endT) / 16;
}

/** Pure rule: what letting go does. */
export function sheetRelease(offset: number, height: number, speed: number): "close" | "back" {
	if (offset > height * SHEET_CLOSE_FRACTION) return "close";
	if (speed > SHEET_FLICK_SPEED && offset > SHEET_FLICK_MIN) return "close";
	return "back";
}

/** Pure rule: how long the slide away takes from `offset` down. */
export function sheetSlideMs(offset: number, height: number): number {
	const left = height > 0 ? Math.min(1, Math.max(0, 1 - offset / height)) : 1;
	return Math.max(SHEET_SLIDE_MIN_MS, Math.round(SHEET_SLIDE_MS * left));
}

/** Pure rule: the dim's opacity with the sheet `offset` px down. */
export function sheetDimOpacity(offset: number, height: number): number {
	if (height <= 0) return 1;
	return Math.min(1, Math.max(0, 1 - offset / height));
}

/** Pure helper: the vertical translation in a computed `transform` value
 *  ("none", "matrix(…)" or "matrix3d(…)"); null when it can't be read. */
export function translateYOf(transform: string): number | null {
	const value = transform.trim();
	if (value === "none") return 0;
	const found = /^matrix(3d)?\(([^)]*)\)$/.exec(value);
	if (!found) return null;
	const parts = found[2]!.split(",").map((part) => Number(part.trim()));
	const ty = found[1] ? parts[13] : parts[5];
	return ty !== undefined && Number.isFinite(ty) ? ty : null;
}

export type SheetSwipe = {
	/** Slide the sheet away from where it is now, then call onGone. False when
	 *  it can't be animated (reduced motion, no animation support): the caller
	 *  closes at once, as before. True while a slide away is already under way. */
	slideAway(): boolean;
	/** Asked to open while sliding away: it comes back up (the spring). */
	reopen(): void;
	/** Remove the listeners and every inline style; a slide away under way ends minimized. */
	dispose(): void;
};

export type SheetSwipeOptions = {
	/** The dim over the lesson above the sheet. */
	dim: () => HTMLElement | null;
	/** A swipe was let go past the line: minimize (through the window's own close, which calls slideAway). */
	onSwipeClose: () => void;
	/** The slide away has ended: unmount the sheet. */
	onGone: () => void;
	/** Clock in ms (tests). */
	now?: () => number;
};

/** The sheet's own swipe zone: the top bar carries this attribute; the
 *  handle strip is the sheet itself, above the bar. */
export const SWIPE_BAR_ATTR = "data-tutor-swipe";

function motionAllowed(el: HTMLElement): boolean {
	const view = el.ownerDocument.defaultView;
	if (typeof el.animate !== "function") return false;
	return !view?.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export function installTutorSheetSwipe(sheet: HTMLElement, options: SheetSwipeOptions): SheetSwipe {
	const now = options.now ?? (() => performance.now());
	/** Where the sheet is (px down from its place), as last set here. */
	let offset = 0;
	let closing = false;
	let token = 0;
	let running: Animation[] = [];
	let drag: { startX: number; startY: number; base: number; state: "pending" | "drag" | "no"; samples: { t: number; y: number }[] } | null = null;

	const height = () => sheet.offsetHeight || 1;

	const place = (y: number) => {
		offset = y;
		sheet.style.transform = y ? `translateY(${y}px)` : "";
		const dim = options.dim();
		if (dim) dim.style.opacity = y ? String(sheetDimOpacity(y, height())) : "";
	};

	/** Stop every animation on the sheet and the dim (the CSS open slide, a
	 *  spring, a slide), keeping the place it had reached. */
	const halt = () => {
		const view = sheet.ownerDocument.defaultView;
		const computed = view?.getComputedStyle?.(sheet)?.transform;
		const shown = computed === undefined ? null : translateYOf(computed);
		for (const run of running) run.cancel();
		running = [];
		for (const el of [sheet, options.dim()]) {
			if (el && typeof el.getAnimations === "function") for (const run of el.getAnimations()) run.cancel();
		}
		place(shown === null ? offset : Math.max(0, shown));
	};

	/** Move from `from` to `to` (px, or "gone": the sheet's own height) over ms. */
	const glide = (from: number, to: number | "gone", ms: number, done?: () => void) => {
		for (const run of running) run.cancel();
		running = [];
		const h = height();
		const end = to === "gone" ? h : to;
		const finalTransform = to === "gone" ? "translateY(100%)" : end ? `translateY(${end}px)` : "";
		const dim = options.dim();
		const settle = () => {
			offset = end;
			sheet.style.transform = finalTransform;
			if (dim) dim.style.opacity = end ? String(sheetDimOpacity(end, h)) : "";
		};
		if (!motionAllowed(sheet)) {
			settle();
			done?.();
			return;
		}
		const mine = ++token;
		const runs = [sheet.animate([{ transform: `translateY(${from}px)` }, { transform: finalTransform || "translateY(0px)" }], { duration: ms, easing: SHEET_EASE })];
		if (dim && typeof dim.animate === "function") runs.push(dim.animate([{ opacity: sheetDimOpacity(from, h) }, { opacity: sheetDimOpacity(end, h) }], { duration: ms, easing: SHEET_EASE }));
		running = runs;
		settle();
		runs[0]!.onfinish = () => {
			if (mine !== token) return;
			running = [];
			done?.();
		};
	};

	const gone = () => {
		closing = false;
		options.onGone();
	};

	const inZone = (target: EventTarget | null, y: number): boolean => {
		const el = target as Element | null;
		if (!el || typeof el.closest !== "function" || el.closest("button")) return false;
		const bar = sheet.querySelector(`[${SWIPE_BAR_ATTR}]`);
		if (bar && bar.contains(el)) return true;
		// The handle strip: the sheet itself, above the bar.
		return target === sheet && !!bar && y < bar.getBoundingClientRect().top;
	};

	const springBack = () => glide(offset, 0, SHEET_SPRING_MS);

	const onStart = (e: TouchEvent) => {
		if (e.touches.length !== 1) {
			// A second finger cancels the drag: back to its place.
			if (drag?.state === "drag") springBack();
			drag = null;
			return;
		}
		const t = e.touches[0]!;
		if (closing || !inZone(e.target, t.clientY)) {
			drag = null;
			return;
		}
		drag = { startX: t.clientX, startY: t.clientY, base: 0, state: "pending", samples: [{ t: now(), y: t.clientY }] };
	};
	const onMove = (e: TouchEvent) => {
		const t = e.touches[0];
		if (!drag || drag.state === "no" || e.touches.length !== 1 || !t) return;
		if (drag.state === "pending") {
			// Decided on the first movement: once Safari's own scrolling has
			// started the move can't be cancelled, and it is left to it.
			if (t.clientX === drag.startX && t.clientY === drag.startY && e.cancelable) return;
			if (!e.cancelable) {
				drag.state = "no";
				return;
			}
			drag.state = "drag";
			halt();
			drag.base = offset;
		}
		if (e.cancelable) e.preventDefault();
		drag.samples.push({ t: now(), y: t.clientY });
		if (drag.samples.length > 32) drag.samples.shift();
		place(sheetOffset(drag.base, t.clientY - drag.startY));
	};
	const onEnd = (e: TouchEvent) => {
		const d = drag;
		drag = null;
		if (!d || d.state !== "drag") return;
		if (e.type === "touchcancel") {
			springBack();
			return;
		}
		const speed = sheetReleaseSpeed(d.samples, now());
		if (sheetRelease(offset, height(), speed) === "close") options.onSwipeClose();
		else springBack();
	};

	sheet.addEventListener("touchstart", onStart, { passive: true });
	sheet.addEventListener("touchmove", onMove, { passive: false });
	sheet.addEventListener("touchend", onEnd);
	sheet.addEventListener("touchcancel", onEnd);

	return {
		slideAway() {
			if (closing) return true;
			if (!motionAllowed(sheet)) return false;
			drag = null;
			halt();
			closing = true;
			glide(offset, "gone", sheetSlideMs(offset, height()), gone);
			return true;
		},
		reopen() {
			if (!closing) return;
			closing = false;
			token++;
			halt();
			springBack();
		},
		dispose() {
			sheet.removeEventListener("touchstart", onStart);
			sheet.removeEventListener("touchmove", onMove);
			sheet.removeEventListener("touchend", onEnd);
			sheet.removeEventListener("touchcancel", onEnd);
			token++;
			for (const run of running) run.cancel();
			running = [];
			sheet.style.transform = "";
			const dim = options.dim();
			if (dim) dim.style.opacity = "";
			if (closing) gone();
		},
	};
}

/** The swipe on the open sheet, while `enabled` (the phone layout, the sheet
 *  open, the session not held). The callbacks are read when they run. */
export function useTutorSheetSwipe(sheetRef: RefObject<HTMLElement | null>, dimRef: RefObject<HTMLElement | null>, enabled: boolean, onSwipeClose: () => void, onGone: () => void): RefObject<SheetSwipe | null> {
	const swipe = useRef<SheetSwipe | null>(null);
	const calls = useRef({ onSwipeClose, onGone });
	calls.current = { onSwipeClose, onGone };
	useEffect(() => {
		const sheet = sheetRef.current;
		if (!enabled || !sheet) return;
		const installed = installTutorSheetSwipe(sheet, {
			dim: () => dimRef.current,
			onSwipeClose: () => calls.current.onSwipeClose(),
			onGone: () => calls.current.onGone(),
		});
		swipe.current = installed;
		return () => {
			if (swipe.current === installed) swipe.current = null;
			installed.dispose();
		};
	}, [enabled, sheetRef, dimRef]);
	return swipe;
}
