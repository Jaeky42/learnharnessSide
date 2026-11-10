"use client";

/**
 * PHONE VIEWPORT (cloud sync Phase 3). On an iPhone the on-screen keyboard
 * covers the bottom of the page instead of shrinking it, and Safari pans the
 * view up to reveal the box being typed in, so the app slid up under the top
 * edge and left an empty band above the keyboard. This keeps the app inside
 * the part of the screen the keyboard leaves visible:
 *
 *   --lh-vvh       the visible height; app/phone.css sizes the full-height
 *                  shells and overlays from it;
 *   --lh-vv-top    how far Safari panned the view; while the keyboard is up
 *                  the body moves down by that much (data-lh-keyboard), so
 *                  the app's top edge sits at the top of the screen.
 *
 * Android shrinks the layout itself (interactive-widget=resizes-content in
 * the root layout's viewport), so there both values stay neutral.
 *
 * Nothing changes while the page is pinch-zoomed: the visible area is then
 * small because of the zoom, not the keyboard. Mounted once in the root
 * layout; does nothing off a phone.
 */

import { useEffect } from "react";
import { useIsPhone } from "@/components/phone/use-phone";

/** Pure rule, exported for tests: what to apply for a visual viewport. */
export function viewportFit(vv: { height: number; offsetTop: number; scale: number }): { height: number; top: number } | null {
	if (vv.scale > 1.01) return null; // pinch-zoomed: leave the layout alone
	return { height: Math.round(vv.height), top: Math.max(0, Math.round(vv.offsetTop)) };
}

export function PhoneViewport() {
	const phone = useIsPhone();
	useEffect(() => {
		const root = document.documentElement;
		const body = document.body;
		const vv = window.visualViewport;
		const clear = () => {
			root.style.removeProperty("--lh-vvh");
			body.style.removeProperty("--lh-vv-top");
			delete body.dataset.lhKeyboard;
		};
		if (!phone || !vv) {
			clear();
			return;
		}
		let frame = 0;
		const sync = () => {
			const fit = viewportFit(vv);
			if (!fit) return;
			root.style.setProperty("--lh-vvh", `${fit.height}px`);
			// The app's pages never scroll the window; only their inner panels
			// scroll. A window scroll is Safari revealing a box: undo it.
			if (window.scrollY !== 0) window.scrollTo(0, 0);
			if (fit.top > 0) {
				body.style.setProperty("--lh-vv-top", `${fit.top}px`);
				body.dataset.lhKeyboard = "";
			} else {
				body.style.removeProperty("--lh-vv-top");
				delete body.dataset.lhKeyboard;
			}
		};
		const schedule = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(sync);
		};
		sync();
		vv.addEventListener("resize", schedule);
		vv.addEventListener("scroll", schedule);
		window.addEventListener("scroll", schedule, { passive: true });
		return () => {
			cancelAnimationFrame(frame);
			vv.removeEventListener("resize", schedule);
			vv.removeEventListener("scroll", schedule);
			window.removeEventListener("scroll", schedule);
			clear();
		};
	}, [phone]);
	return null;
}
