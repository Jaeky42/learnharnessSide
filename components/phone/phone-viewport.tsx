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
 *
 * IN STEP WITH THE KEYBOARD (owner's choice "B · In step", iPhone: the
 * Tutor's typing box opened with a jerk). An iPhone tells a page the
 * keyboard's size only once it is up, so --lh-vvh used to snap to the
 * smaller height after the slide, and back to the full height at once on
 * blur. Now the app's height glides (createKeyboardMotion, one value driven
 * frame by frame; GLIDE_BOXES says what it moves mid-glide): on focus it
 * moves toward the height the keyboard left the last time (remembered per
 * orientation, in the browser's storage) over the keyboard's own time and
 * curve; Safari's real height then corrects it with a short glide. With
 * nothing remembered the real height is glided to when it arrives. On blur
 * it glides back to the full height. With reduced motion every change lands
 * at once, as before.
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

/** A visible area this much shorter than the layout is the keyboard (an
 *  iPhone keyboard is ~300px tall). */
export const KEYBOARD_MIN_PX = 120;

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
	return typing || fit.top > 0 || innerHeight - fit.height > KEYBOARD_MIN_PX;
}

/** Pure rule, exported for tests: the height to lay the app out in. While
 *  the keyboard is closing the app takes the full height at once: iPhone
 *  Safari reports the new visible height only after the keyboard has slid
 *  away, so the app sat squeezed above an empty band for a moment and then
 *  dropped down (owner's iPhone). At full height the message box sits at
 *  the bottom behind the keyboard and is revealed as it slides away. (Since
 *  "In step" the app glides to that height over the keyboard's own time.) */
export function layoutHeight(visible: number, innerHeight: number, closing: boolean): number {
	return closing ? Math.max(visible, innerHeight) : visible;
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

// ── In step with the keyboard ──────────────────────────────────────────
// Timings to tune on the owner's iPhone (Chromium has no keyboard).

/** The keyboard's own slide, and its curve (close to the iPhone's). The app
 *  glides over this when a remembered height is there, and when it closes. */
export const KEYBOARD_MS = 300;
export const KEYBOARD_EASE: Bezier = [0.38, 0.7, 0.125, 1];
/** Nothing remembered yet (the first time on this device and orientation):
 *  the glide to the real height once Safari reports it (option A). */
export const CATCH_UP_MS = 220;
/** A remembered height that was off (another keyboard, the suggestions bar),
 *  or a change while the keyboard is up: the short glide to the real one. */
export const CORRECTION_MS = 180;
/** The curve of both short glides: the sync strip's and the Tutor's morph. */
export const SETTLE_EASE: Bezier = [0.2, 0.8, 0.2, 1];
/** No keyboard after all (a hardware keyboard, a box the iPhone shows none
 *  for): when Safari has reported no new visible height this long after the
 *  focus, the app glides back to the real height. The same time the closing
 *  override already gives Safari's height to arrive (CLOSING_MAX_MS). A
 *  shorter wait wobbled in the browser run: with the page busy (CPU slowed
 *  4×) the stand-in keyboard's height arrived 780 ms after the focus, after
 *  a 750 ms wait had started back up. */
export const NO_KEYBOARD_MS = CLOSING_MAX_MS;
/** A remembered keyboard is taller than KEYBOARD_MIN_PX and covers at most
 *  this share of the full height. */
export const KEYBOARD_MAX_SHARE = 0.6;
/** The browser's storage key: { [slot]: keyboard height in px }. */
export const KEYBOARD_STORE_KEY = "lh:phone:keyboard";
/** Sent on window whenever the app's height changes (every frame of a
 *  glide), so what places itself from it (menus, the Tutor's bubble)
 *  follows. phoneLayoutHeight() is the height of that moment. Its detail is
 *  a PhoneHeightDetail: `frame` is true when it is sent from a glide's own
 *  animation frame (never from inside a React render or commit), so a
 *  listener may render at once there (flushSync) and land in that frame. */
export const PHONE_HEIGHT_EVENT = "lh:phone-height";
export type PhoneHeightDetail = { frame: boolean };
/** Pure, exported for tests: may a PHONE_HEIGHT_EVENT listener render at
 *  once (flushSync)? Only for an event sent from a glide's frame. */
export function heightEventInFrame(e: Event): boolean {
	const detail = (e as CustomEvent<PhoneHeightDetail | undefined>).detail;
	return detail?.frame === true;
}

/** A focus counts as the learner's own tap when a touch ended on the
 *  focused box (or inside it, or on what holds it) at most this long before.
 *  iOS shows the keyboard for a tap on a box, but not for a box focused by
 *  code outside a tap (autoFocus after a navigation, the message box
 *  refocused after a dictation): predicting a keyboard there shrank the app
 *  for 1.5 s for nothing. On an iPhone the focus comes right after touchend
 *  (with the compatibility mousedown), a few ms; 500 leaves room for a busy
 *  page. navigator.userActivation isn't used: its transient activation lasts
 *  for seconds after any tap and survives async code, so a tap on Home
 *  followed by the topic box's autoFocus would count. */
export const TOUCH_FOCUS_MS = 500;

/** Pure rule, exported for tests: is this focus the learner's own tap on
 *  the box (so the keyboard is coming and can be met in step)? */
export function focusFromTouch(touch: { target: Node | null; at: number } | null, focused: Node | null, now: number): boolean {
	if (!touch || !touch.target || !focused) return false;
	if (now - touch.at > TOUCH_FOCUS_MS || now < touch.at) return false;
	return touch.target === focused || focused.contains(touch.target) || touch.target.contains(focused);
}

/** Pure rule, exported for tests: the state says a text box has focus but
 *  none has (it was removed while focused: WebKit sends no blur then,
 *  whatwg/html#1569). Treated as a blur, so nothing stays stuck. */
export function focusLost(typing: boolean, typingEl: { isConnected: boolean } | null, active: { tagName: string; type?: string; isContentEditable?: boolean } | null): boolean {
	if (!typing) return false;
	if (typingEl && !typingEl.isConnected) return true;
	return !typingTarget(active);
}

/** WHAT A GLIDE MOVES. Changing --lh-vvh on <html> makes the browser work out
 *  the style of every element again, since custom properties are inherited:
 *  measured at iPhone size on a long lesson, 33 ms per change (170 ms with
 *  the CPU slowed 4×), so a glide of one change per frame dropped most of
 *  its frames. The layout itself is cheap. So while a glide moves, <html>
 *  keeps its value and only the few boxes sized from it take the moving
 *  value, on themselves: the full-height shells their height (.h-dvh, whose
 *  subtree is the whole lesson), and the boxes listed here --lh-vvh (their
 *  subtrees are small). At the glide's last frame <html> takes the value
 *  and these go. Every rule in app/phone.css that reads --lh-vvh is either
 *  a .h-dvh shell, the body (its min-height can wait for the last frame), a
 *  Safari-tab bleed rule (off while a text box has focus), or listed here
 *  (tests/phone-keyboard-motion.test.ts checks). */
export const GLIDE_SHELLS = ".h-dvh";
export const GLIDE_BOXES = [
	'[data-phone="sidebar"]',
	'[data-phone="backdrop"]',
	'[data-testid="settings-backdrop"]',
	'[data-phone="notes"]',
	'[data-phone="tutor-sheet"]',
	'[data-phone="settings"]',
	'[data-interaction-layer][role="dialog"] > div > div.fixed',
	'[data-interaction-layer][role="dialog"] > div > div.fixed > *',
].join(", ");

let layoutNow: number | null = null;
/** The app's laid-out height at this moment, mid-glide too, or null when
 *  PhoneViewport isn't sizing the app (off a phone). */
export function phoneLayoutHeight(): number | null {
	return layoutNow;
}

export type Bezier = readonly [number, number, number, number];

/** Pure, exported for tests: a CSS cubic-bezier timing function. */
export function cubicBezier([x1, y1, x2, y2]: Bezier): (t: number) => number {
	const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
	const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
	const x = (s: number) => ((ax * s + bx) * s + cx) * s;
	const y = (s: number) => ((ay * s + by) * s + cy) * s;
	const dx = (s: number) => (3 * ax * s + 2 * bx) * s + cx;
	return (t) => {
		if (t <= 0) return 0;
		if (t >= 1) return 1;
		let s = t;
		for (let i = 0; i < 8; i++) {
			const err = x(s) - t;
			if (Math.abs(err) < 1e-6) return y(s);
			const d = dx(s);
			if (Math.abs(d) < 1e-6) break;
			s -= err / d;
		}
		let lo = 0, hi = 1;
		s = t;
		for (let i = 0; i < 30; i++) {
			const v = x(s);
			if (Math.abs(v - t) < 1e-6) break;
			if (v < t) lo = s;
			else hi = s;
			s = (lo + hi) / 2;
		}
		return y(s);
	};
}

/** Pure rule, exported for tests: which remembered keyboard applies. Kept
 *  apart for portrait and landscape, and for the home-screen app and a
 *  Safari tab (Safari's own bars change what the keyboard takes away). */
export function keyboardSlot(env: { standalone: boolean; innerWidth: number; innerHeight: number }): string {
	return `${env.standalone ? "app" : "tab"}-${env.innerHeight >= env.innerWidth ? "portrait" : "landscape"}`;
}

/** Pure rule, exported for tests: a keyboard height worth remembering, or
 *  null. */
export function plausibleKeyboard(cut: number, full: number): number | null {
	if (!Number.isFinite(cut) || !Number.isFinite(full) || full <= 0) return null;
	const px = Math.round(cut);
	return px > KEYBOARD_MIN_PX && px <= full * KEYBOARD_MAX_SHARE ? px : null;
}

type KeyValueStore = Pick<Storage, "getItem" | "setItem">;

function readStore(store: KeyValueStore | null): Record<string, number> {
	try {
		const raw = store?.getItem(KEYBOARD_STORE_KEY);
		const parsed: unknown = raw ? JSON.parse(raw) : null;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const out: Record<string, number> = {};
		for (const [k, v] of Object.entries(parsed)) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
		return out;
	} catch {
		return {};
	}
}

/** Exported for tests: the remembered keyboard height for a slot, if it is
 *  still plausible for this full height. Never throws. */
export function recallKeyboard(store: KeyValueStore | null, slot: string, full: number): number | null {
	const px = readStore(store)[slot];
	return px === undefined ? null : plausibleKeyboard(px, full);
}

/** Exported for tests: remembers a plausible keyboard height for a slot.
 *  Writes only a change; never throws. */
export function rememberKeyboard(store: KeyValueStore | null, slot: string, cut: number, full: number): boolean {
	const px = plausibleKeyboard(cut, full);
	if (px === null || !store) return false;
	const all = readStore(store);
	if (all[slot] === px) return false;
	try {
		store.setItem(KEYBOARD_STORE_KEY, JSON.stringify({ ...all, [slot]: px }));
		return true;
	} catch {
		return false;
	}
}

interface Frames {
	now(): number;
	frame(cb: () => void): number;
	cancelFrame(id: number): void;
}

/** One value moved frame by frame (whole px). `to` from wherever it is now;
 *  a new target mid-glide keeps at least the time the glide had left, so it
 *  never jumps. `apply` is told whether the value is still moving: the last
 *  frame of a glide, and every change at once, come with `moving` false.
 *  Exported for tests. */
export function createHeightGlide(deps: Frames & { apply(px: number, moving: boolean): void }) {
	let value: number | null = null;
	let written: number | null = null;
	let writtenMoving = false;
	let from = 0, target = 0, start = 0, ms = 0;
	let ease: (t: number) => number = (t) => t;
	let id = 0;
	let running = false;
	const write = (v: number, moving: boolean) => {
		value = v;
		const px = Math.round(v);
		if (px !== written || moving !== writtenMoving) {
			written = px;
			writtenMoving = moving;
			deps.apply(px, moving);
		}
	};
	const stop = () => {
		if (running) deps.cancelFrame(id);
		running = false;
	};
	const step = () => {
		const t = ms > 0 ? Math.min(1, (deps.now() - start) / ms) : 1;
		if (t < 1) {
			write(from + (target - from) * ease(t), true);
			id = deps.frame(step);
		} else {
			running = false;
			write(target, false);
		}
	};
	/** At once. */
	const set = (px: number) => {
		stop();
		target = px;
		write(px, false);
	};
	return {
		set,
		/** Glide to px over at least `duration`. */
		to(px: number, duration: number, curve: Bezier) {
			if (value === null) return set(px);
			if (Math.abs(px - target) < 0.5 && (running || Math.abs(value - px) < 0.5)) return;
			const left = running ? Math.max(0, start + ms - deps.now()) : 0;
			stop();
			from = value;
			target = px;
			start = deps.now();
			ms = Math.max(duration, left);
			ease = cubicBezier(curve);
			if (Math.abs(from - target) < 0.5) return write(target, false);
			running = true;
			id = deps.frame(step);
		},
		target: () => target,
		value: () => value,
		running: () => running,
		stop,
	};
}

/** What the page reports to the keyboard motion on every viewport change. */
export interface HeightReport {
	/** The height as laid out without any glide (layoutHeight plus the
	 *  home-screen app's gap): where the app comes to rest. */
	target: number;
	/** The height with no keyboard: the full screen height the app has. */
	full: number;
	/** The visible height Safari reports. */
	visible: number;
	/** The keyboard is up by size (a pan or a much shorter visible area). */
	keyboard: boolean;
	/** A text box has focus. */
	typing: boolean;
	/** The keyboard is closing (blur while it was up). */
	closing: boolean;
	/** keyboardSlot for this page. */
	slot: string;
}

export interface KeyboardMotionDeps extends Frames {
	apply(px: number, moving: boolean): void;
	later(cb: () => void, ms: number): number;
	cancelLater(id: number): void;
	reduced(): boolean;
	recall(slot: string, full: number): number | null;
	remember(slot: string, cut: number, full: number): void;
}

/** The rules of "In step", with the clock, frames and storage passed in, so
 *  every sequence can be tested without a browser. Exported for tests. */
export function createKeyboardMotion(deps: KeyboardMotionDeps) {
	const glide = createHeightGlide(deps);
	let prev: HeightReport | null = null;
	/** A predicted height is on screen and Safari hasn't reported a size yet. */
	let predicting: { visible: number; timer: number } | null = null;
	const endPrediction = () => {
		if (!predicting) return;
		deps.cancelLater(predicting.timer);
		predicting = null;
	};
	return {
		/** A text box took focus (typing was off). Call before report(). */
		focus(r: HeightReport) {
			if (deps.reduced() || r.keyboard || predicting) return;
			const cut = deps.recall(r.slot, r.full);
			if (cut === null) return; // the first time: wait for the real height
			glide.to(r.full - cut, KEYBOARD_MS, KEYBOARD_EASE);
			predicting = {
				visible: r.visible,
				timer: deps.later(() => {
					if (!predicting) return;
					// No size came: no keyboard after all.
					predicting = null;
					if (prev) glide.to(prev.target, CORRECTION_MS, SETTLE_EASE);
				}, NO_KEYBOARD_MS),
			};
		},
		/** Every viewport change, focus change included. */
		report(r: HeightReport) {
			const last = prev;
			prev = r;
			if (deps.reduced() || !last) {
				endPrediction();
				glide.set(r.target);
				return;
			}
			if (r.typing && r.keyboard && !r.closing) deps.remember(r.slot, r.full - r.target, r.full);
			let settle = false;
			if (predicting) {
				if (!r.typing || r.closing) {
					// Blur before the keyboard was reported: back to full in its time.
					endPrediction();
					glide.to(r.target, KEYBOARD_MS, KEYBOARD_EASE);
					return;
				}
				// Hold the predicted height until Safari reports a new size (a pan
				// alone doesn't count).
				if (Math.abs(r.visible - predicting.visible) <= 1) return;
				endPrediction();
				settle = true;
			}
			// Already there, or on the way.
			if (Math.abs(r.target - glide.target()) < 0.5) return;
			if (r.closing) glide.to(r.target, KEYBOARD_MS, KEYBOARD_EASE);
			else if (settle || (r.typing && r.keyboard && last.keyboard)) glide.to(r.target, CORRECTION_MS, SETTLE_EASE);
			else if (r.keyboard !== last.keyboard) glide.to(r.target, CATCH_UP_MS, SETTLE_EASE);
			else glide.set(r.target); // not the keyboard (a rotation, Safari's bars, Android): at once
		},
		/** Off the phone, or unmounted. */
		stop() {
			endPrediction();
			glide.stop();
			prev = null;
		},
		glide,
		predicting: () => predicting !== null,
	};
}

/** useLayoutEffect, silent during the server render. */
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function localStore(): Storage | null {
	try {
		return window.localStorage;
	} catch {
		return null;
	}
}

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
		/** The boxes holding a glide's moving value, and what was set on each. */
		const moved = new Map<HTMLElement, "height" | "--lh-vvh">();
		const settle = () => {
			for (const [el, prop] of moved) el.style.removeProperty(prop);
			moved.clear();
		};
		/** True while a glide's own frame runs (PHONE_HEIGHT_EVENT's detail). */
		let inFrame = false;
		const paint = (px: number, moving: boolean) => {
			layoutNow = px;
			const value = `${px}px`;
			if (moving) {
				for (const el of document.querySelectorAll<HTMLElement>(GLIDE_SHELLS)) {
					el.style.setProperty("height", value);
					moved.set(el, "height");
				}
				for (const el of document.querySelectorAll<HTMLElement>(GLIDE_BOXES)) {
					el.style.setProperty("--lh-vvh", value);
					moved.set(el, "--lh-vvh");
				}
			} else {
				root.style.setProperty("--lh-vvh", value);
				settle();
			}
			window.dispatchEvent(new CustomEvent<PhoneHeightDetail>(PHONE_HEIGHT_EVENT, { detail: { frame: inFrame } }));
		};
		const clear = () => {
			settle();
			layoutNow = null;
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
		const remembered = new Map<string, number>();
		const reducedQuery = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
		const motion = createKeyboardMotion({
			apply: paint,
			now: () => performance.now(),
			frame: (cb) =>
				window.requestAnimationFrame(() => {
					inFrame = true;
					try {
						cb();
					} finally {
						inFrame = false;
					}
				}),
			cancelFrame: (id) => window.cancelAnimationFrame(id),
			later: (cb, ms) => window.setTimeout(cb, ms),
			cancelLater: (id) => window.clearTimeout(id),
			reduced: () => reducedQuery?.matches === true,
			recall: (slot, full) => recallKeyboard(localStore(), slot, full),
			remember: (slot, cut, full) => {
				const px = plausibleKeyboard(cut, full);
				if (px === null || remembered.get(slot) === px) return;
				remembered.set(slot, px);
				rememberKeyboard(localStore(), slot, px, full);
			},
		});
		let typing = typingTarget(document.activeElement as HTMLElement | null);
		/** The text box that has focus, while typing. */
		let typingEl: Element | null = typing ? document.activeElement : null;
		/** The learner's last touch: where it ended, and when (focusFromTouch). */
		let lastTouch: { target: Node | null; at: number } | null = null;
		const onTouchEnd = (e: TouchEvent) => {
			lastTouch = { target: e.target as Node | null, at: performance.now() };
		};
		let closing = false;
		let closingTimer = 0;
		const endClosing = () => {
			closing = false;
			window.clearTimeout(closingTimer);
		};
		/** The heights for this moment, or null while pinch-zoomed. */
		const measure = (): (HeightReport & { fit: { height: number; top: number }; standalone: boolean }) | null => {
			const fit = viewportFit(vv);
			if (!fit) return null;
			const standalone = standaloneNow();
			const gapNow = standaloneGap({ standalone, innerWidth: window.innerWidth, innerHeight: window.innerHeight, screenWidth: window.screen.width, screenHeight: window.screen.height, safeTop: standalone ? safeAreaTop() : 0 });
			// Only while the keyboard is down: with it up the iPhone reports the
			// visible height correctly, and adding the strip pushed the bottom of
			// the app (and menus anchored there) 62 points under the keyboard
			// (owner's iPhone, home-screen app). Sized by height, not focus, so the
			// app doesn't shrink before the keyboard arrives (unless a remembered
			// keyboard says how far, createKeyboardMotion); while it closes the
			// full height (layoutHeight) takes the strip again.
			const keyboard = keyboardUp(fit, window.innerHeight);
			const gap = keyboard && !closing ? 0 : gapNow;
			return {
				fit,
				standalone,
				target: layoutHeight(fit.height, window.innerHeight, closing) + gap,
				full: Math.max(fit.height, window.innerHeight) + gapNow,
				visible: fit.height,
				keyboard,
				typing,
				closing,
				slot: keyboardSlot({ standalone, innerWidth: window.innerWidth, innerHeight: window.innerHeight }),
			};
		};
		const sync = () => {
			// A focused box removed from the page (WebKit sends no blur): a blur.
			if (focusLost(typing, typingEl, document.activeElement as HTMLElement | null)) changeTyping(false, null);
			const m = measure();
			if (!m) return;
			const { fit, standalone } = m;
			// Safari's new height has arrived: the keyboard is gone.
			if (closing && fit.height >= window.innerHeight - 1) {
				endClosing();
				m.closing = false;
			}
			motion.report(m);
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
		// showing one frame in the wrong place while the keyboard slides.
		/** A text box took focus (next) or lost it; false when nothing changed. */
		const changeTyping = (next: boolean, focused: Element | null): boolean => {
			if (next) endClosing();
			if (next === typing) return false;
			typing = next;
			typingEl = next ? focused : null;
			if (!next && vv.height < window.innerHeight - 1) {
				// The keyboard is closing: head for the full height now, not when
				// Safari reports it after the slide (layoutHeight).
				closing = true;
				window.clearTimeout(closingTimer);
				closingTimer = window.setTimeout(() => {
					closing = false;
					sync();
				}, CLOSING_MAX_MS);
			}
			// In step: start toward the remembered keyboard at once, but only for
			// the learner's own tap; a box focused by code brings no keyboard on
			// an iPhone, so the app waits for Safari's report as the first time.
			if (next && focusFromTouch(lastTouch, focused, performance.now())) {
				const m = measure();
				if (m) motion.focus(m);
			}
			return true;
		};
		const onFocus = (e: FocusEvent) => {
			// Focus moving straight to another text box keeps the keyboard up.
			if (e.type === "focusout" && typingTarget(e.relatedTarget as HTMLElement | null)) return;
			const target = e.target as HTMLElement | null;
			const next = e.type === "focusin" && typingTarget(target);
			// The box that had focus was removed without a blur: end that first,
			// so this focus is a new one.
			if (next && typing && typingEl && typingEl !== target && !typingEl.isConnected) changeTyping(false, null);
			if (!changeTyping(next, next ? target : null)) return;
			sync();
		};
		sync();
		vv.addEventListener("resize", sync);
		vv.addEventListener("scroll", sync);
		window.addEventListener("scroll", sync, { passive: true });
		document.addEventListener("focusin", onFocus);
		document.addEventListener("focusout", onFocus);
		document.addEventListener("touchend", onTouchEnd, { capture: true, passive: true });
		return () => {
			document.removeEventListener("touchend", onTouchEnd, { capture: true });
			vv.removeEventListener("resize", sync);
			vv.removeEventListener("scroll", sync);
			window.removeEventListener("scroll", sync);
			document.removeEventListener("focusin", onFocus);
			document.removeEventListener("focusout", onFocus);
			endClosing();
			motion.stop();
			clear();
		};
	}, [phone]);
	return null;
}
