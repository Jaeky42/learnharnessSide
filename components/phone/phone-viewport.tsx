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
 *
 * SAFARI TAB BLEED (experiment, owner's ask). In an iPhone Safari tab the
 * page box is only the area between the clock strip and Safari's toolbar;
 * at rest Safari fills both strips with one plain colour. Content shows
 * under them only once the page is scrolled. So in a Safari tab (not the
 * home-screen app, which already draws edge to edge) the body gets
 * BLEED_PX of padding above and below (data-lh-bleed, --lh-bleed) and the
 * window rests scrolled down by BLEED_PX: the app sits exactly where it
 * did, and the padding (body colour, the session drawer and its dim) is
 * what shows under the clock and the toolbar. Off while the keyboard is
 * up, so the keyboard handling above is unchanged.
 */

import { useEffect } from "react";
import { useIsPhone } from "@/components/phone/use-phone";

/** Pure rule, exported for tests: what to apply for a visual viewport. */
export function viewportFit(vv: { height: number; offsetTop: number; scale: number }): { height: number; top: number } | null {
	if (vv.scale > 1.01) return null; // pinch-zoomed: leave the layout alone
	return { height: Math.round(vv.height), top: Math.max(0, Math.round(vv.offsetTop)) };
}

/** How far the page runs past the visible area at each end in a Safari tab:
 *  more than any iPhone's clock strip or toolbar. */
export const BLEED_PX = 200;

/** Pure rule, exported for tests: an iPhone Safari tab (not the home-screen
 *  app, not another iOS browser) with the keyboard down gets the bleed. */
export function bleedFor(env: { userAgent: string; standalone: boolean; keyboard: boolean }): number {
	if (env.standalone || env.keyboard) return 0;
	const ua = env.userAgent;
	if (!/iPhone|iPod/.test(ua)) return 0;
	if (/CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(ua)) return 0;
	return BLEED_PX;
}

/** The keyboard is up (or about to be) when a text box has focus, Safari
 *  has panned the view, or the visible area is much shorter than the layout
 *  (an iPhone keyboard is ~300px tall).
 *
 *  Focus counts on its own: Safari starts scrolling the page to reveal the
 *  box before the keyboard's size arrives. With the bleed on, that scroll was
 *  snapped back as a stray drag, and then the bleed went off once the
 *  keyboard's size came in: a quick jump down and up (owner's iPhone).
 *  Switching the bleed off on focus, before Safari moves anything, leaves
 *  only the keyboard handling. */
export function keyboardUp(fit: { height: number; top: number }, innerHeight: number, typing = false): boolean {
	return typing || fit.top > 0 || innerHeight - fit.height > 120;
}

/** Pure rule, exported for tests: does focusing this element bring up the
 *  on-screen keyboard? */
export function typingTarget(el: { tagName: string; type?: string; isContentEditable?: boolean } | null): boolean {
	if (!el) return false;
	if (el.isContentEditable) return true;
	const tag = el.tagName.toUpperCase();
	if (tag === "TEXTAREA") return true;
	if (tag !== "INPUT") return false;
	return !/^(button|checkbox|color|file|hidden|image|radio|range|reset|submit)$/i.test(el.type ?? "text");
}

function standaloneNow(): boolean {
	const nav = navigator as Navigator & { standalone?: boolean };
	return nav.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
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
			if (body.dataset.lhBleed !== undefined) {
				delete body.dataset.lhBleed;
				body.style.removeProperty("--lh-bleed");
				window.scrollTo(0, 0);
			}
		};
		if (!phone || !vv) {
			clear();
			return;
		}
		let typing = typingTarget(document.activeElement as HTMLElement | null);
		const sync = () => {
			const fit = viewportFit(vv);
			if (!fit) return;
			root.style.setProperty("--lh-vvh", `${fit.height}px`);
			const bleed = bleedFor({ userAgent: navigator.userAgent, standalone: standaloneNow(), keyboard: keyboardUp(fit, window.innerHeight, typing) });
			if (bleed > 0) {
				body.dataset.lhBleed = "";
				body.style.setProperty("--lh-bleed", `${bleed}px`);
			} else if (body.dataset.lhBleed !== undefined) {
				delete body.dataset.lhBleed;
				body.style.removeProperty("--lh-bleed");
			}
			// The app's pages never scroll the window; only their inner panels
			// scroll. A window scroll is Safari revealing a box (or, in a Safari
			// tab, a drag on the page): put it back at rest.
			if (Math.abs(window.scrollY - bleed) > 0.5) window.scrollTo(0, bleed);
			if (bleed === 0 && fit.top > 0) {
				body.style.setProperty("--lh-vv-top", `${fit.top}px`);
				body.dataset.lhKeyboard = "";
			} else {
				body.style.removeProperty("--lh-vv-top");
				delete body.dataset.lhKeyboard;
			}
		};
		// Synchronous, not on the next frame: these events arrive just before
		// the browser paints, so following them at once keeps the app from
		// showing one frame in the wrong place while the keyboard slides.
		const onFocus = (e: FocusEvent) => {
			const next = e.type === "focusin" && typingTarget(e.target as HTMLElement | null);
			if (next === typing) return;
			typing = next;
			sync();
		};
		sync();
		vv.addEventListener("resize", sync);
		vv.addEventListener("scroll", sync);
		window.addEventListener("scroll", sync, { passive: true });
		document.addEventListener("focusin", onFocus);
		document.addEventListener("focusout", onFocus);
		return () => {
			vv.removeEventListener("resize", sync);
			vv.removeEventListener("scroll", sync);
			window.removeEventListener("scroll", sync);
			document.removeEventListener("focusin", onFocus);
			document.removeEventListener("focusout", onFocus);
			clear();
		};
	}, [phone]);
	return null;
}
