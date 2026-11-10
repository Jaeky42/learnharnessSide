"use client";

/**
 * Where the side tutor's phone bubble sits (cloud sync Phase 3): just above
 * the dock (the message box / question area, marked data-phone="dock"),
 * following it as it grows and folds. While an opened question leaves no
 * room above the dock, the bubble moves to the top-right corner under the
 * top bar instead, so the tutor stays reachable while answering.
 *
 * The position is a distance from the TOP of the screen: on an iPhone the
 * on-screen keyboard covers the bottom edge, so "from the bottom" would put
 * the bubble under the keyboard.
 */

import { useEffect, useState } from "react";

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

function same(a: DockAnchor, b: DockAnchor): boolean {
	return a.place === b.place && (a.place === "top" || (b.place === "above-dock" && a.top === b.top));
}

export function useDockAnchor(active: boolean): DockAnchor {
	const [anchor, setAnchor] = useState<DockAnchor>({ place: "top" });
	useEffect(() => {
		if (!active) return;
		let frame = 0;
		let observed: Element | null = null;
		const ro = new ResizeObserver(() => schedule());
		const measure = () => {
			const dock = document.querySelector('[data-phone="dock"]');
			if (dock !== observed) {
				if (observed) ro.unobserve(observed);
				if (dock) ro.observe(dock);
				observed = dock;
			}
			// Relative to the body: while the iPhone keyboard is up the body is
			// shifted (phone-viewport.tsx) and is the bubble's positioning frame.
			const bodyTop = document.body.getBoundingClientRect().top;
			const next = dockAnchor(dock ? dock.getBoundingClientRect().top - bodyTop : null);
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
