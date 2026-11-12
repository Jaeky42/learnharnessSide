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
import { PHONE_HEIGHT_EVENT } from "@/components/phone/phone-viewport";

/** The top bar's height and the bubble's size (app/phone.css), in px. */
const TOP_BAR = 60;
export const BUBBLE_SIZE = 52;
const GAP = 12;

export type DockAnchor = { place: "above-dock"; top: number } | { place: "top" };

/** Pure rule, exported for tests: the bubble needs its own height plus a gap
 *  on each side between the top bar and the dock. */
export function dockAnchor(dockTop: number | null): DockAnchor {
	if (dockTop === null) return { place: "top" };
	const top = Math.round(dockTop - GAP - BUBBLE_SIZE);
	if (top < TOP_BAR + GAP) return { place: "top" };
	return { place: "above-dock", top };
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
			const next: PlacedAnchor = { ...dockAnchor(box ? box.top - bodyTop : null), right: box ? Math.max(0, Math.round(window.innerWidth - box.right)) : 0, dock };
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
		// The app's height glides with the iPhone keyboard (phone-viewport.tsx),
		// moving the dock every frame without resizing it: follow in the same
		// frame.
		window.addEventListener(PHONE_HEIGHT_EVENT, measure);
		return () => {
			window.removeEventListener(PHONE_HEIGHT_EVENT, measure);
			cancelAnimationFrame(frame);
			window.clearInterval(poll);
			ro.disconnect();
			window.removeEventListener("resize", schedule);
			window.visualViewport?.removeEventListener("resize", schedule);
		};
	}, [active]);
	return anchor;
}
