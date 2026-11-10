"use client";

/**
 * PHONE DETECTION (cloud sync Phase 3). The phone layout applies to screens
 * narrower than 640 px in a BROWSER only — never in the desktop app, whose
 * window can't go below 640 px but whose UI zoom can shrink the CSS width.
 *
 * Two halves share this one rule:
 *   - CSS: app/phone.css puts every rule inside PHONE_QUERY and under
 *     html:not(.lh-electron).
 *   - JS: useIsPhone() for the few places where behavior (not just styling)
 *     differs — the session drawer, the side tutor sheet, the notes drawer,
 *     Settings.
 *
 * The server and the first client render always answer "not a phone", so
 * hydration matches; the real answer arrives right after mount.
 */

import { useSyncExternalStore } from "react";

/** The phone layout applies BELOW this width (CSS px). */
export const PHONE_MAX_WIDTH = 640;
export const PHONE_QUERY = "(max-width: 639.98px)";
/** Touch is the main input (a finger, not a mouse or trackpad). */
export const TOUCH_QUERY = "(pointer: coarse)";

/** Pure rule, exported for tests. */
export function isPhoneViewport(width: number, electron: boolean): boolean {
	return !electron && width < PHONE_MAX_WIDTH;
}

function inElectron(): boolean {
	return typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");
}

function matches(query: string): boolean {
	return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}

/** Is the phone layout active right now? Safe outside React. */
export function isPhoneNow(): boolean {
	return !inElectron() && matches(PHONE_QUERY);
}

/** A phone with an on-screen keyboard: Enter makes a new line there and the
 *  button sends (owner decision, Phase 3). Desktop keeps Enter-sends. */
export function isTouchPhoneNow(): boolean {
	return isPhoneNow() && matches(TOUCH_QUERY);
}

function subscribe(onChange: () => void): () => void {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
	const lists = [window.matchMedia(PHONE_QUERY), window.matchMedia(TOUCH_QUERY)];
	for (const l of lists) l.addEventListener("change", onChange);
	return () => {
		for (const l of lists) l.removeEventListener("change", onChange);
	};
}

const never = () => false;

/** True while the phone layout is active. False on the server and during
 *  hydration. */
export function useIsPhone(): boolean {
	return useSyncExternalStore(subscribe, isPhoneNow, never);
}

/** True on a phone whose main input is touch (see isTouchPhoneNow). */
export function useIsTouchPhone(): boolean {
	return useSyncExternalStore(subscribe, isTouchPhoneNow, never);
}
