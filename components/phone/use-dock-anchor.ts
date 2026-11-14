"use client";

/**
 * Where the minimized side tutor's bubble sits: just above the dock (the
 * message box / question area, marked data-phone="dock"), following it as
 * it grows and folds. While an opened question leaves no room above the
 * dock, the bubble moves to the top-right corner under the top bar instead,
 * so the tutor stays reachable while answering.
 *
 * Built for the phone (cloud sync Phase 3); the computer's minimized tutor
 * uses it too since the owner asked for the same bubble there. On a
 * computer the bubble is drawn INSIDE the dock (components/side-tutor.tsx),
 * so it keeps its place against the question bar exactly, through every
 * fold and resize; from this hook it takes the dock element (`dock`) and
 * whether there is room above it (`place`). For the place under the top
 * bar it also needs how far the lesson's right edge is from the window's
 * (`right`), which isn't 0 while the notes drawer is open. The phone
 * ignores both: its CSS places the bubble sideways.
 *
 * The position is a distance from the TOP of the screen: on an iPhone the
 * on-screen keyboard covers the bottom edge, so "from the bottom" would put
 * the bubble under the keyboard.
 */

import { useEffect, useState } from "react";
import { isPhoneNow } from "@/components/phone/use-phone";

/** The top bar's height and the bubble's size (app/phone.css), in px. */
export const TOP_BAR = 60;
export const BUBBLE_SIZE = 52;
const GAP = 12;

export type DockAnchor = { place: "above-dock"; top: number } | { place: "top" };

/** Pure rule, exported for tests: the bubble needs its own height plus a gap
 *  on each side between the top bar and the dock. `topBar` is where the top
 *  bar ends (topBarEnd). */
export function dockAnchor(dockTop: number | null, topBar = TOP_BAR): DockAnchor {
	if (dockTop === null) return { place: "top" };
	const top = Math.round(dockTop - GAP - BUBBLE_SIZE);
	if (top < topBar + GAP) return { place: "top" };
	return { place: "above-dock", top };
}

/** Pure rule, exported for tests: where the top bar ends, for dockAnchor. In
 *  the phone layout it is measured: the bar is taller there by the clock
 *  strip, and in the home-screen app by the room kept clear of iOS's blur
 *  (--lh-safe-top in app/phone.css; 148 points on the owner's iPhone). With
 *  the 60 px assumed, an opened question that reached the top bar left the
 *  bubble "above the dock", on top of the top bar's buttons (owner's
 *  screenshot of the home-screen app). Off the phone layout it stays the
 *  60 px it always was, so nothing moves on a computer. */
export function topBarEnd(phone: boolean, measuredBottom: number | null): number {
	return phone && measuredBottom !== null && measuredBottom > 0 ? measuredBottom : TOP_BAR;
}

/** The bubble's place, plus the dock itself and the lesson's right edge
 *  measured from the window's right edge (0 while the lesson reaches it,
 *  or isn't known). */
export type PlacedAnchor = DockAnchor & { right: number; dock: HTMLElement | null };

function same(a: PlacedAnchor, b: PlacedAnchor): boolean {
	return a.dock === b.dock && a.right === b.right && a.place === b.place && (a.place === "top" || (b.place === "above-dock" && a.top === b.top));
}

export function useDockAnchor(active: boolean): PlacedAnchor {
	const [anchor, setAnchor] = useState<PlacedAnchor>({ place: "top", right: 0, dock: null });
	useEffect(() => {
		if (!active) return;
		let frame = 0;
		let observed: Element | null = null;
		const ro = new ResizeObserver(() => schedule());
		const measure = () => {
			const dock = document.querySelector<HTMLElement>('[data-phone="dock"]');
			if (dock !== observed) {
				if (observed) ro.unobserve(observed);
				if (dock) ro.observe(dock);
				observed = dock;
			}
			// The bubble's positioning frame: the screen, except while the iPhone
			// keyboard is up, when the body is shifted (phone-viewport.tsx) and
			// becomes the frame.
			const bodyTop = document.body.dataset.lhKeyboard !== undefined ? document.body.getBoundingClientRect().top : 0;
			const box = dock?.getBoundingClientRect() ?? null;
			const bar = isPhoneNow() ? (document.querySelector<HTMLElement>('[data-phone="topbar"]')?.getBoundingClientRect() ?? null) : null;
			const topBar = topBarEnd(bar !== null, bar ? bar.bottom - bodyTop : null);
			const next: PlacedAnchor = { ...dockAnchor(box ? box.top - bodyTop : null, topBar), right: box ? Math.max(0, Math.round(window.innerWidth - box.right)) : 0, dock };
			setAnchor((prev) => (same(prev, next) ? prev : next));
		};
		const schedule = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(measure);
		};
		measure();
		// The dock mounts after us and morphs; a cheap poll catches what the
		// observer can't (a dock that appears or is replaced).
		const poll = window.setInterval(measure, 500);
		window.addEventListener("resize", schedule);
		window.visualViewport?.addEventListener("resize", schedule);
		return () => {
			cancelAnimationFrame(frame);
			window.clearInterval(poll);
			ro.disconnect();
			window.removeEventListener("resize", schedule);
			window.visualViewport?.removeEventListener("resize", schedule);
		};
	}, [active]);
	return anchor;
}
