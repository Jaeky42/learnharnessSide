"use client";

/**
 * THE SESSION LIST DRAWER SWIPES LEFT TO CLOSE (phone layout; owner's
 * approved design, modelled on the Tutor's sheet swiping down:
 * tutor-sheet-swipe.ts).
 *
 *  - The swipe works on the drawer itself only. The dimmed area beside it
 *    keeps what it has: a tap closes the drawer, a swipe on it does nothing.
 *  - Phone layout only, while the drawer is open. Nothing is installed
 *    otherwise, and no inline style is ever set.
 *  - The drawer follows the finger to the left, never right of its resting
 *    place. The dim fades with it.
 *  - Let go past a quarter of the drawer's width, or after a quick flick to
 *    the left, and it slides away and the drawer closes; otherwise it springs
 *    back. The Tutor's numbers, and its easing (SHEET_EASE).
 *  - A touch that starts in a text box (the search box) is left alone: the
 *    box keeps its own sideways drag.
 *  - Only transform (and the dim's opacity) move, as inline styles set while
 *    the swipe is installed. With reduced motion, the drawer still follows
 *    the finger and everything else happens at once.
 *
 * Touch rules learned on the owner's iPhone (use-dock-touch-scroll.ts): the
 * drag is decided on its FIRST movement, and that move's default is
 * prevented from then on, or Safari starts scrolling and can't be stopped.
 * Mostly sideways and to the left: a drag. Anything else (vertical, which
 * scrolls the list natively, or to the right) is not a drag for the rest of
 * that touch. The release speed is the finger's last 80 ms (releaseVelocity),
 * nothing if it had stopped. A second finger springs the drawer back. After a
 * drag the touch's end and the click that would follow it are swallowed, so
 * the row under the finger never opens. A press and hold that fires during a
 * drag (long-press.ts sends a contextmenu event) springs it back and lets
 * the row's menu open as it does today.
 *
 * The drawer's open and closed look is CSS (app/phone.css: a transition on
 * transform). While a swipe is installed the inline `transition: none` keeps
 * that transition out of the way. After the slide away the drawer is left
 * off screen, inline, until React has committed the closed state; clearing
 * the inline styles first would start the CSS transition back toward the open
 * place. So the slide's end only calls onClose, and dispose() (the hook's
 * effect cleanup, after the commit) clears the styles.
 */

import { useEffect, useRef, type RefObject } from "react";
import { SHEET_EASE } from "@/components/phone/tutor-sheet-swipe";
import { releaseVelocity } from "@/components/phone/use-dock-touch-scroll";

/** Past this share of the drawer's width, letting go closes it. */
export const DRAWER_CLOSE_FRACTION = 0.25;
/** A flick: faster than this over the finger's last 80 ms (px per ms)… */
export const DRAWER_FLICK_SPEED = 0.5;
/** …and moved more than this (px). */
export const DRAWER_FLICK_MIN = 12;
/** The spring back to the resting place. */
export const DRAWER_SPRING_MS = 200;
/** The slide away from the resting place; shorter for what is left to travel, never under the floor. */
export const DRAWER_SLIDE_MS = 200;
export const DRAWER_SLIDE_MIN_MS = 130;
/** How long the click after a drag is swallowed if it doesn't come. */
const SWALLOW_MS = 400;

/** Pure rule: what the first movement of a touch means. `wait` while the
 *  finger hasn't moved; a drag only when mostly sideways and to the left;
 *  never when the browser already took the touch (not cancelable). */
export function drawerSwipeDecision(dx: number, dy: number, cancelable: boolean): "wait" | "drag" | "no" {
	if (!cancelable) return "no";
	if (dx === 0 && dy === 0) return "wait";
	return Math.abs(dx) > Math.abs(dy) && dx < 0 ? "drag" : "no";
}

/** Pure rule: how far left of its place the drawer is, for a finger that has
 *  moved dx (negative is leftward) since the drag picked the drawer up at
 *  `base`. Never right of its place, never past its own width. */
export function drawerOffset(base: number, dx: number, width: number): number {
	return Math.min(Math.max(0, width), Math.max(0, base - dx));
}

/** Pure rule: the release speed in px per ms, leftward positive, over the
 *  finger's last 80 ms; 0 if it had stopped before lifting. `samples` carry
 *  the finger's x in the `y` field (releaseVelocity's shape). */
export function drawerReleaseSpeed(samples: { t: number; y: number }[], endT: number): number {
	return 0 - releaseVelocity(samples, endT) / 16;
}

/** Pure rule: what letting go does. */
export function drawerRelease(offset: number, width: number, speed: number): "close" | "back" {
	if (offset > width * DRAWER_CLOSE_FRACTION) return "close";
	if (speed > DRAWER_FLICK_SPEED && offset > DRAWER_FLICK_MIN) return "close";
	return "back";
}

/** Pure rule: how long the slide away takes from `offset` to the left. */
export function drawerSlideMs(offset: number, width: number): number {
	const left = width > 0 ? Math.min(1, Math.max(0, 1 - offset / width)) : 1;
	return Math.max(DRAWER_SLIDE_MIN_MS, Math.round(DRAWER_SLIDE_MS * left));
}

/** Pure rule: the dim's opacity with the drawer `offset` px to the left. */
export function drawerDimOpacity(offset: number, width: number): number {
	if (width <= 0) return 1;
	return Math.min(1, Math.max(0, 1 - offset / width));
}

/** Pure helper: the horizontal translation in a computed `transform` value
 *  ("none", "matrix(…)" or "matrix3d(…)"); null when it can't be read. */
export function translateXOf(transform: string): number | null {
	const value = transform.trim();
	if (value === "none") return 0;
	const found = /^matrix(3d)?\(([^)]*)\)$/.exec(value);
	if (!found) return null;
	const parts = found[2]!.split(",").map((part) => Number(part.trim()));
	const tx = found[1] ? parts[12] : parts[4];
	return tx !== undefined && Number.isFinite(tx) ? tx : null;
}

export type SidebarSwipe = {
	/** Remove the listeners and every inline style. Calls no callback. */
	dispose(): void;
};

export type SidebarSwipeOptions = {
	/** The dim beside the drawer. */
	dim: () => HTMLElement | null;
	/** The drawer has slid away: close it (React then removes the swipe). */
	onClose: () => void;
	/** Clock in ms (tests). */
	now?: () => number;
};

const TEXT_BOX = "input, textarea, select, [contenteditable]";

function motionAllowed(el: HTMLElement): boolean {
	const view = el.ownerDocument.defaultView;
	if (typeof el.animate !== "function") return false;
	return !view?.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

type Drag = {
	startX: number;
	startY: number;
	base: number;
	state: "pending" | "drag" | "no" | "done";
	/** The touch became a drag at some point (its end and click are swallowed). */
	was: boolean;
	/** The finger's x over time, in the `y` field. */
	samples: { t: number; y: number }[];
};

export function installSidebarSwipe(drawer: HTMLElement, options: SidebarSwipeOptions): SidebarSwipe {
	const now = options.now ?? (() => performance.now());
	/** How far left of its place the drawer is (px), as last set here. */
	let offset = 0;
	let closing = false;
	let token = 0;
	let running: Animation[] = [];
	let drag: Drag | null = null;
	let swallow: { handler: (e: Event) => void; timer: ReturnType<typeof setTimeout> } | null = null;

	const width = () => drawer.offsetWidth || 1;

	const place = (x: number) => {
		offset = x;
		drawer.style.transition = "none";
		drawer.style.transform = x ? `translateX(-${x}px)` : "";
		const dim = options.dim();
		if (dim) dim.style.opacity = x ? String(drawerDimOpacity(x, width())) : "";
	};

	/** Stop every animation on the drawer and the dim (the CSS slide, a
	 *  spring), keeping the place it had reached. */
	const halt = () => {
		const view = drawer.ownerDocument.defaultView;
		const computed = view?.getComputedStyle?.(drawer)?.transform;
		const shown = computed === undefined ? null : translateXOf(computed);
		for (const run of running) run.cancel();
		running = [];
		for (const el of [drawer, options.dim()]) {
			if (el && typeof el.getAnimations === "function") for (const run of el.getAnimations()) run.cancel();
		}
		place(shown === null ? offset : Math.max(0, -shown));
	};

	/** Move from `from` to `to` (px left of its place, or "gone": its own width) over ms. */
	const glide = (from: number, to: number | "gone", ms: number, done?: () => void) => {
		for (const run of running) run.cancel();
		running = [];
		const w = width();
		const end = to === "gone" ? w : to;
		const finalTransform = to === "gone" ? "translateX(-100%)" : end ? `translateX(-${end}px)` : "";
		const dim = options.dim();
		const settle = () => {
			offset = end;
			drawer.style.transition = "none";
			drawer.style.transform = finalTransform;
			if (dim) dim.style.opacity = end ? String(drawerDimOpacity(end, w)) : "";
		};
		if (!motionAllowed(drawer)) {
			settle();
			done?.();
			return;
		}
		const mine = ++token;
		const runs = [drawer.animate([{ transform: `translateX(-${from}px)` }, { transform: finalTransform || "translateX(0px)" }], { duration: ms, easing: SHEET_EASE })];
		if (dim && typeof dim.animate === "function") runs.push(dim.animate([{ opacity: drawerDimOpacity(from, w) }, { opacity: drawerDimOpacity(end, w) }], { duration: ms, easing: SHEET_EASE }));
		running = runs;
		settle();
		runs[0]!.onfinish = () => {
			if (mine !== token) return;
			running = [];
			done?.();
		};
	};

	/** Back to its place; the inline `transition: none` stays until it is there. */
	const springBack = () =>
		glide(offset, 0, DRAWER_SPRING_MS, () => {
			drawer.style.transition = "";
		});

	const slideAway = () => {
		closing = true;
		glide(offset, "gone", drawerSlideMs(offset, width()), () => options.onClose());
	};

	const stopSwallowing = () => {
		if (!swallow) return;
		drawer.removeEventListener("click", swallow.handler, true);
		clearTimeout(swallow.timer);
		swallow = null;
	};
	/** The click that follows a drag must not open the row under the finger. */
	const swallowNextClick = () => {
		stopSwallowing();
		const handler = (e: Event) => {
			e.preventDefault();
			e.stopPropagation();
			stopSwallowing();
		};
		drawer.addEventListener("click", handler, true);
		swallow = { handler, timer: setTimeout(stopSwallowing, SWALLOW_MS) };
	};

	const onStart = (e: TouchEvent) => {
		if (e.touches.length !== 1) {
			// A second finger cancels the drag: back to its place.
			if (drag?.state === "drag") {
				springBack();
				drag.state = "done";
			} else if (drag && !drag.was) drag = null;
			return;
		}
		const t = e.touches[0]!;
		const target = e.target as Element | null;
		if (closing || (target && typeof target.closest === "function" && target.closest(TEXT_BOX))) {
			drag = null;
			return;
		}
		drag = { startX: t.clientX, startY: t.clientY, base: 0, state: "pending", was: false, samples: [{ t: now(), y: t.clientX }] };
	};
	const onMove = (e: TouchEvent) => {
		const t = e.touches[0];
		if (!drag || (drag.state !== "pending" && drag.state !== "drag") || e.touches.length !== 1 || !t) return;
		const dx = t.clientX - drag.startX;
		if (drag.state === "pending") {
			// Decided on the first movement: once Safari's own scrolling has
			// started the move can't be cancelled, and it is left to it.
			const decision = drawerSwipeDecision(dx, t.clientY - drag.startY, e.cancelable);
			if (decision === "wait") return;
			if (decision === "no") {
				drag.state = "no";
				return;
			}
			drag.state = "drag";
			drag.was = true;
			halt();
			drag.base = offset;
		}
		if (e.cancelable) e.preventDefault();
		drag.samples.push({ t: now(), y: t.clientX });
		if (drag.samples.length > 32) drag.samples.shift();
		place(drawerOffset(drag.base, dx, width()));
	};
	const onEnd = (e: TouchEvent) => {
		const d = drag;
		drag = null;
		if (!d || !d.was) return;
		if (e.type === "touchend" && e.cancelable) e.preventDefault();
		swallowNextClick();
		if (d.state !== "drag") return;
		if (e.type === "touchcancel") {
			springBack();
			return;
		}
		const speed = drawerReleaseSpeed(d.samples, now());
		if (drawerRelease(offset, width(), speed) === "close") slideAway();
		else springBack();
	};
	const onContextMenu = () => {
		// The press and hold fired while the drag was under way: the drawer goes
		// back and the row's menu opens as it does today.
		if (drag?.state !== "drag") return;
		springBack();
		drag.state = "done";
	};

	drawer.addEventListener("touchstart", onStart, { passive: true });
	drawer.addEventListener("touchmove", onMove, { passive: false });
	drawer.addEventListener("touchend", onEnd);
	drawer.addEventListener("touchcancel", onEnd);
	drawer.addEventListener("contextmenu", onContextMenu);

	return {
		dispose() {
			drawer.removeEventListener("touchstart", onStart);
			drawer.removeEventListener("touchmove", onMove);
			drawer.removeEventListener("touchend", onEnd);
			drawer.removeEventListener("touchcancel", onEnd);
			drawer.removeEventListener("contextmenu", onContextMenu);
			stopSwallowing();
			token++;
			for (const run of running) run.cancel();
			running = [];
			drag = null;
			drawer.style.transform = "";
			drawer.style.transition = "";
			const dim = options.dim();
			if (dim) dim.style.opacity = "";
		},
	};
}

/** The swipe on the open drawer, while `enabled` (the phone layout, the
 *  drawer open). `onClose` is read when it runs. */
export function useSidebarSwipe(drawerRef: RefObject<HTMLElement | null>, dimRef: RefObject<HTMLElement | null>, enabled: boolean, onClose: () => void): void {
	const calls = useRef({ onClose });
	calls.current = { onClose };
	useEffect(() => {
		const drawer = drawerRef.current;
		if (!enabled || !drawer) return;
		const installed = installSidebarSwipe(drawer, {
			dim: () => dimRef.current,
			onClose: () => calls.current.onClose(),
		});
		return () => installed.dispose();
	}, [enabled, drawerRef, dimRef]);
}
