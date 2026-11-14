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
 *                  the app's top edge sits at the top of the screen;
 *   data-lh-keyboard-up  on the body while the keyboard covers the bottom of
 *                  the screen (keyboardMarker). app/phone.css drops the room
 *                  kept for the home bar there, which the keyboard covers
 *                  anyway, and hides the Tutor's bubble (owner's asks).
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

import { useEffect, useLayoutEffect } from "react";
import { isBrowserNow, useIsPhone } from "@/components/phone/use-phone";

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

/** Pure rule, exported for tests: the height to lay the app out in. While
 *  the keyboard is closing the app takes the full height at once: iPhone
 *  Safari reports the new visible height only after the keyboard has slid
 *  away, so the app sat squeezed above an empty band for a moment and then
 *  dropped down (owner's iPhone). At full height the message box sits at
 *  the bottom behind the keyboard and is revealed as it slides away. */
export function layoutHeight(visible: number, innerHeight: number, closing: boolean): number {
	return closing ? Math.max(visible, innerHeight) : visible;
}

/** Pure rule, exported for tests: is the body marked data-lh-keyboard-up?
 *  While the keyboard is up by its SIZE (not by focus alone, which comes
 *  before the keyboard does), and not while it closes: the app then already
 *  has its full height (layoutHeight), and the home bar's room with it. */
export function keyboardMarker(keyboardBySize: boolean, closing: boolean): boolean {
	return keyboardBySize && !closing;
}

/** How much shorter than its full height the visible area must be to count
 *  as the keyboard (keyboardUp's own 120 px). */
export const KEYBOARD_MIN_DROP = 120;

/** Pure rule, exported for tests: the tallest visible area seen at this width
 *  (keyboardByDrop). A new width (the phone turned, a window resized) starts
 *  again. */
export function fullVisible(prev: { width: number; height: number } | null, width: number, height: number): { width: number; height: number } {
	return !prev || prev.width !== width ? { width, height } : { width, height: Math.max(prev.height, height) };
}

/** Pure rule, exported for tests: the keyboard is up, told WITHOUT
 *  window.innerHeight: a text box has the focus and the visible area is much
 *  shorter than the tallest it has been at this width. keyboardUp compares
 *  the visible height with innerHeight, and on the owner's iPhone that
 *  comparison stays under its 120 px with the keyboard up (the first build of
 *  data-lh-keyboard-up never came on there: the bottom block and the Tutor's
 *  bubble stayed as they were, in the home-screen app and in a Safari tab),
 *  although the visible height itself had dropped by more than 300. The focus
 *  is asked for too, so a browser window made shorter isn't taken for a
 *  keyboard. */
export function keyboardByDrop(typing: boolean, full: number, visible: number): boolean {
	return typing && full - visible > KEYBOARD_MIN_DROP;
}

/** Pure rule, exported for tests: how much taller the app should be than
 *  the iPhone reports, in the home-screen app. With the status bar drawn
 *  over the page (black-translucent) the page starts behind the clock, but
 *  the reported height leaves the clock strip out, so the app stopped that
 *  far above the bottom of the screen (owner's iPhone: 894 of 956 points,
 *  a 62-point band at the bottom). Only when the shortfall matches the
 *  clock strip, so a phone without the quirk is left alone. */
export function standaloneGap(env: { standalone: boolean; innerWidth: number; innerHeight: number; screenWidth: number; screenHeight: number; safeTop: number }): number {
	if (!env.standalone || env.safeTop <= 0) return 0;
	const portrait = env.innerHeight >= env.innerWidth;
	const screenSide = portrait ? Math.max(env.screenWidth, env.screenHeight) : Math.min(env.screenWidth, env.screenHeight);
	return Math.abs(screenSide - env.innerHeight - env.safeTop) <= 2 ? env.safeTop : 0;
}

let safeTopProbe: HTMLDivElement | null = null;
/** The clock strip's height (env(safe-area-inset-top)), read from a probe. */
function safeAreaTop(): number {
	if (!safeTopProbe) {
		safeTopProbe = document.createElement("div");
		safeTopProbe.setAttribute("aria-hidden", "true");
		safeTopProbe.style.cssText = "position:fixed;top:0;left:0;width:0;height:env(safe-area-inset-top,0px);visibility:hidden;pointer-events:none";
		document.body.appendChild(safeTopProbe);
	}
	return safeTopProbe.getBoundingClientRect().height;
}

/** How long the keyboard-closing override waits for Safari's new height. */
export const CLOSING_MAX_MS = 1200;

/** Pure rule, exported for tests: the text box the app believes has focus
 *  has left the page. WebKit sends no blur or focusout for a focused element
 *  that is removed (whatwg/html#1569), yet on the owner's iPhone the keyboard
 *  closes at once then (Submit answer: a test page was told 0 of 2 times).
 *  Without this the app sat squeezed above an empty band until Safari
 *  reported the new height. */
export function boxGone(typingEl: { isConnected: boolean } | null): boolean {
	return typingEl !== null && !typingEl.isConnected;
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

/** Pure rule, exported for tests: does this page get the home-screen app's
 *  marker? In a browser only, at any width: on a phone app/phone.css moves the
 *  top edges below iOS's blur with it, on a tablet (the computer layout)
 *  app/tablet.css does (owner's iPad). Never in the desktop app. */
export function standaloneMarker(env: { browser: boolean; standalone: boolean }): boolean {
	return env.browser && env.standalone;
}

/** useLayoutEffect, silent during the server render. */
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function PhoneViewport() {
	const phone = useIsPhone();
	// The home-screen app's marker, at every width (body[data-lh-standalone]).
	// A layout effect, so it is set before any component's first ordinary
	// effect reads the top inset it gives (the Tutor's window places itself
	// in one; this runtime mounts after the page).
	useIsoLayoutEffect(() => {
		const body = document.body;
		if (standaloneMarker({ browser: isBrowserNow(), standalone: standaloneNow() })) body.dataset.lhStandalone = "";
		else delete body.dataset.lhStandalone;
		return () => {
			delete body.dataset.lhStandalone;
		};
	}, []);
	useEffect(() => {
		const root = document.documentElement;
		const body = document.body;
		const vv = window.visualViewport;
		const clear = () => {
			root.style.removeProperty("--lh-vvh");
			body.style.removeProperty("--lh-vv-top");
			delete body.dataset.lhKeyboard;
			delete body.dataset.lhKeyboardUp;
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
		/** The text box whose focusin set `typing`, watched for leaving the page. */
		let typingEl: Element | null = typing ? document.activeElement : null;
		let closing = false;
		let closingTimer = 0;
		/** The tallest visible area seen at this width (keyboardByDrop). */
		let full: { width: number; height: number } | null = null;
		/** The pending frame that takes the full height (see closeSoon). */
		let closingFrame = 0;
		const endClosing = () => {
			closing = false;
			window.clearTimeout(closingTimer);
			window.cancelAnimationFrame(closingFrame);
			closingFrame = 0;
		};
		/** The keyboard is closing: take the full height now, not when Safari
		 *  reports it after the slide (layoutHeight), but one frame from now,
		 *  not inside the focus change. A tap is delivered as mousedown,
		 *  mouseup and click in one task; the mousedown takes the focus off
		 *  the box, and with the full height taken right there the button
		 *  under the finger dropped about 300 px before the mouseup, so the
		 *  mouseup landed on the lesson and the click never reached the
		 *  button. The frame comes after that task. On the owner's iPhone a
		 *  test page delivered 0 of 5 taps with the step inside the focus
		 *  change and 5 of 5 one frame later. A focusin on another text box
		 *  before the frame (endClosing) cancels it. */
		const closeSoon = () => {
			window.cancelAnimationFrame(closingFrame);
			closingFrame = window.requestAnimationFrame(() => {
				closingFrame = 0;
				closing = true;
				window.clearTimeout(closingTimer);
				closingTimer = window.setTimeout(() => {
					closing = false;
					sync();
				}, CLOSING_MAX_MS);
				sync();
			});
		};
		/** Watches the focused box for leaving the page while `typing` (boxGone). */
		const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => {
			if (typing && boxGone(typingEl)) loseFocus();
		});
		const watch = () => {
			observer?.disconnect();
			if (typing) observer?.observe(document.body, { childList: true, subtree: true });
		};
		/** No text box has focus any more: a focusout to nothing, or the box
		 *  was removed from the page (boxGone). */
		const loseFocus = () => {
			typing = false;
			typingEl = null;
			watch();
			if (vv.height < window.innerHeight - 1) closeSoon();
			sync();
		};
		const sync = () => {
			const fit = viewportFit(vv);
			if (!fit) return;
			// Safari's new height has arrived: the keyboard is gone.
			if (closing && fit.height >= window.innerHeight - 1) endClosing();
			const standalone = standaloneNow();
			// Only while the keyboard is down: with it up the iPhone reports the
			// visible height correctly, and adding the strip pushed the bottom of
			// the app (and menus anchored there) 62 points under the keyboard
			// (owner's iPhone, home-screen app). Sized by height, not focus, so the
			// app doesn't shrink before the keyboard arrives; while it closes the
			// full height (layoutHeight) takes the strip again at once.
			const keyboardBySize = keyboardUp(fit, window.innerHeight);
			const gap = keyboardBySize && !closing ? 0 : standaloneGap({ standalone, innerWidth: window.innerWidth, innerHeight: window.innerHeight, screenWidth: window.screen.width, screenHeight: window.screen.height, safeTop: standalone ? safeAreaTop() : 0 });
			root.style.setProperty("--lh-vvh", `${layoutHeight(fit.height, window.innerHeight, closing) + gap}px`);
			full = fullVisible(full, window.innerWidth, fit.height);
			const keyboardShown = keyboardBySize || keyboardByDrop(typing, full.height, fit.height);
			if (keyboardMarker(keyboardShown, closing)) body.dataset.lhKeyboardUp = "";
			else delete body.dataset.lhKeyboardUp;
			const bleed = bleedFor({ userAgent: navigator.userAgent, standalone, keyboard: keyboardUp(fit, window.innerHeight, typing) });
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
		// showing one frame in the wrong place while the keyboard slides. Only
		// the keyboard-closing step waits one frame (closeSoon), so the tap
		// that took the focus is delivered first.
		const onFocus = (e: FocusEvent) => {
			// Focus moving straight to another text box keeps the keyboard up.
			if (e.type === "focusout" && typingTarget(e.relatedTarget as HTMLElement | null)) return;
			const next = e.type === "focusin" && typingTarget(e.target as HTMLElement | null);
			if (next) {
				endClosing();
				// Also when the previous box left the page without a blur.
				typingEl = e.target as Element;
			}
			if (next === typing) return;
			if (!next) {
				loseFocus();
				return;
			}
			typing = true;
			watch();
			sync();
		};
		sync();
		vv.addEventListener("resize", sync);
		vv.addEventListener("scroll", sync);
		window.addEventListener("scroll", sync, { passive: true });
		document.addEventListener("focusin", onFocus);
		document.addEventListener("focusout", onFocus);
		watch();
		return () => {
			vv.removeEventListener("resize", sync);
			vv.removeEventListener("scroll", sync);
			window.removeEventListener("scroll", sync);
			document.removeEventListener("focusin", onFocus);
			document.removeEventListener("focusout", onFocus);
			observer?.disconnect();
			endClosing();
			clear();
		};
	}, [phone]);
	return null;
}
