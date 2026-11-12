"use client";

/**
 * The page itself never moves under a finger (cloud sync Phase 3, owner's
 * iPhone: a drag on an opened question pulled the whole page down, as if to
 * refresh). The app's pages never scroll the window; only their panels
 * scroll. Two parts:
 *
 *  - app/phone.css turns off the page's own bounce (overscroll-behavior on
 *    the root);
 *  - this listener stops a one-finger vertical drag that starts where no
 *    panel can scroll that way: on the top bar, on the drawer's header, or
 *    on a panel already at its end (iOS hands such a drag to the page). In
 *    a Safari tab the page has room to move (the bleed in
 *    phone-viewport.tsx), so that drag would move the whole app.
 *
 * Drags on the dock are forwarded to the lesson first on a phone
 * (use-dock-touch-scroll.ts). Pinches (two fingers) and sideways drags are
 * left alone.
 *
 * On every touch screen in a browser, whatever the width (owner's ask: an
 * iPad gets the computer layout, and a drag there pulled the whole page down
 * to refresh as it once did on the phone). app/touch.css turns the page's
 * bounce off for those. Never in the desktop app.
 */

import { isBrowserNow } from "@/components/phone/use-phone";
import { dragDecision, innerCanTake, type ScrollBox } from "@/components/phone/use-dock-touch-scroll";

function scrollersFrom(target: EventTarget | null, doc: Document): ScrollBox[] {
	const out: ScrollBox[] = [];
	for (let n = target instanceof Element ? target : null; n && n !== doc.body && n !== doc.documentElement; n = n.parentElement) {
		if (/^(auto|scroll)$/.test(getComputedStyle(n).overflowY)) out.push(n);
	}
	return out;
}

export function installWindowLock(doc: Document = document): () => void {
	let startX = 0;
	let startY = 0;
	let target: EventTarget | null = null;
	let mode: "idle" | "pending" | "free" | "lock" = "idle";
	const onStart = (e: TouchEvent) => {
		const t = e.touches[0];
		if (e.touches.length !== 1 || !t || !isBrowserNow()) {
			mode = "idle";
			return;
		}
		startX = t.clientX;
		startY = t.clientY;
		target = e.target;
		mode = "pending";
	};
	const onMove = (e: TouchEvent) => {
		const t = e.touches[0];
		if (e.touches.length !== 1 || !t || mode === "idle" || mode === "free") return;
		if (mode === "pending") {
			// Decided on the first movement, as the dock does (dragDecision):
			// Safari starts its own scrolling on the first unprevented move.
			const decision = dragDecision(t.clientX - startX, t.clientY - startY, e.cancelable, (dy) => innerCanTake(scrollersFrom(target, doc), dy));
			if (decision === "wait") return;
			mode = decision === "native" ? "free" : "lock";
		}
		if (mode === "lock" && e.cancelable) e.preventDefault();
	};
	const onEnd = () => {
		mode = "idle";
	};
	doc.addEventListener("touchstart", onStart, { passive: true });
	doc.addEventListener("touchmove", onMove, { passive: false });
	doc.addEventListener("touchend", onEnd);
	doc.addEventListener("touchcancel", onEnd);
	return () => {
		doc.removeEventListener("touchstart", onStart);
		doc.removeEventListener("touchmove", onMove);
		doc.removeEventListener("touchend", onEnd);
		doc.removeEventListener("touchcancel", onEnd);
	};
}
