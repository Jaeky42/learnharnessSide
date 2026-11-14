"use client";

/**
 * ONE MORE PUSH AT THE END OPENS A FOLDED QUESTION (fork, owner's ask: a
 * check behaves like any other question, "scroll down and it opens").
 *
 * The fold machine in components/chat.tsx opens a folded question when the
 * lesson comes back to its bottom; a check the learner has never left the
 * bottom of has nothing to come back from. So, while the lesson is already at
 * its end and a question owns the dock folded, a further scroll-down gesture
 * opens it:
 *   - a finger moving towards the bottom (up the screen) by PUSH_TOUCH_PX,
 *     on the lesson or on the dock;
 *   - a wheel (or trackpad) scrolling down by PUSH_WHEEL_PX, with no pause
 *     longer than PUSH_WHEEL_PAUSE_MS in between.
 * Every device, touch or not. It never opens by itself: nothing counts for
 * PUSH_GRACE_MS after the dock becomes folded or its question changes (a
 * trackpad still coasting, or a finger already down, when a check arrives),
 * and a touch counts only if it started after that. Never while a scroll box
 * under the finger or pointer can still scroll that way, never for a touch
 * that starts in a text box or goes sideways first, never for a pinch zoom
 * (a wheel with ctrlKey), and never while the dock sits inside an [inert]
 * element (a held session hides the dock that way). The listeners are all
 * passive: nothing here changes how the page scrolls.
 */

import { useEffect, useRef, type RefObject } from "react";
import { innerCanTake, leaveAlone, scrollersUnder, type ScrollBox } from "@/components/phone/use-dock-touch-scroll";

/** "At the end": no further than this from the lesson's bottom. */
export const PUSH_END_PX = 16;
/** How far a finger moves towards the bottom, at the end, to open it. */
export const PUSH_TOUCH_PX = 24;
/** How far a wheel scrolls down, at the end, to open it. */
export const PUSH_WHEEL_PX = 100;
/** A longer pause between counted wheel events starts the sum again. */
export const PUSH_WHEEL_PAUSE_MS = 250;
/** After the dock folds, or its question changes, nothing counts this long. */
export const PUSH_GRACE_MS = 500;

/** Pure rule, exported for tests: is the lesson at its end? */
export function atEnd(box: ScrollBox): boolean {
	return box.scrollHeight - box.clientHeight - box.scrollTop <= PUSH_END_PX;
}

/** Pure rule, exported for tests: is the grace since arming over? */
export function graceOver(armedAt: number, now: number): boolean {
	return now - armedAt >= PUSH_GRACE_MS;
}

/** Pure rule, exported for tests: a wheel delta in px (deltaMode 1 is lines,
 *  2 is pages). */
export function wheelPx(deltaY: number, deltaMode: number, pageHeight: number): number {
	return deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? pageHeight : 1);
}

export type WheelPush = { sum: number; lastAt: number };
export const WHEEL_START: WheelPush = { sum: 0, lastAt: -Infinity };

/** Pure rule, exported for tests: one wheel event. `counts` is false when it
 *  doesn't scroll down at the end (up, a pinch, not at the end, a box under
 *  the pointer that can still take it); that starts the sum again. */
export function wheelPushStep(s: WheelPush, px: number, now: number, counts: boolean): { state: WheelPush; push: boolean } {
	if (!counts || px <= 0) return { state: WHEEL_START, push: false };
	const sum = (now - s.lastAt > PUSH_WHEEL_PAUSE_MS ? 0 : s.sum) + px;
	if (sum >= PUSH_WHEEL_PX) return { state: WHEEL_START, push: true };
	return { state: { sum, lastAt: now }, push: false };
}

export type TouchPush = { x0: number; y0: number; lastY: number; sum: number; axis: "wait" | "vertical" | "sideways" | "done" };

export function touchPushStart(x: number, y: number): TouchPush {
	return { x0: x, y0: y, lastY: y, sum: 0, axis: "wait" };
}

/** Pure rule, exported for tests: one finger movement. `endNow` is whether
 *  the lesson is at its end; `innerCan` whether a scroll box under the finger
 *  can still scroll for this movement. The first movement decides the axis:
 *  sideways ignores the rest of the touch. Towards the bottom (y decreasing)
 *  at the end adds up; the other way, or away from the end, starts again. */
export function touchPushMove(s: TouchPush, x: number, y: number, endNow: boolean, innerCan: boolean): { state: TouchPush; push: boolean } {
	if (s.axis === "sideways" || s.axis === "done") return { state: s, push: false };
	let axis = s.axis;
	if (axis === "wait") {
		const dx = Math.abs(x - s.x0);
		const dy = Math.abs(y - s.y0);
		if (dx === 0 && dy === 0) return { state: s, push: false };
		if (dx > dy) return { state: { ...s, axis: "sideways" }, push: false };
		axis = "vertical";
	}
	const step = s.lastY - y;
	if (step === 0) return { state: { ...s, axis }, push: false };
	if (step < 0 || !endNow || innerCan) return { state: { ...s, axis, lastY: y, sum: 0 }, push: false };
	const sum = s.sum + step;
	if (sum >= PUSH_TOUCH_PX) return { state: { ...s, axis: "done", lastY: y, sum }, push: true };
	return { state: { ...s, axis, lastY: y, sum }, push: false };
}

export type PushAtEndOptions = {
	/** A question owns the dock, folded. */
	armed: boolean;
	/** Changes when the question changes (the grace starts again). */
	armKey: string;
	onPush: () => void;
};

export function usePushAtEnd(rootRef: RefObject<HTMLElement | null>, transcriptRef: RefObject<HTMLElement | null>, { armed, armKey, onPush }: PushAtEndOptions) {
	const onPushRef = useRef(onPush);
	onPushRef.current = onPush;
	const armedRef = useRef(armed);
	armedRef.current = armed;
	const armedAtRef = useRef(0);
	const wheelRef = useRef<WheelPush>(WHEEL_START);
	const touchRef = useRef<TouchPush | null>(null);

	// Arming, and every change of question, starts the grace and drops whatever
	// was being counted.
	useEffect(() => {
		armedAtRef.current = performance.now();
		wheelRef.current = WHEEL_START;
		touchRef.current = null;
	}, [armed, armKey]);

	useEffect(() => {
		const root = rootRef.current;
		const lesson = transcriptRef.current;
		if (!root || !lesson) return;
		const live = () => armedRef.current && !root.closest("[inert]") && graceOver(armedAtRef.current, performance.now());
		const push = () => {
			wheelRef.current = WHEEL_START;
			touchRef.current = null;
			onPushRef.current();
		};
		// The dock is the lesson's sibling, but one event reaching both
		// listeners must still count once.
		let last: Event | null = null;
		const once = (e: Event) => {
			if (e === last) return false;
			last = e;
			return true;
		};

		const onTouchStart = (e: TouchEvent) => {
			if (!once(e)) return;
			const t = e.touches[0];
			touchRef.current = e.touches.length === 1 && t && !leaveAlone(e.target) && live() ? touchPushStart(t.clientX, t.clientY) : null;
		};
		const onTouchMove = (e: TouchEvent) => {
			if (!once(e)) return;
			const s = touchRef.current;
			if (!s) return;
			const t = e.touches[0];
			if (e.touches.length !== 1 || !t || !armedRef.current || root.closest("[inert]")) {
				touchRef.current = null;
				return;
			}
			const host = e.currentTarget as HTMLElement;
			const dy = t.clientY - s.lastY;
			const innerCan = dy !== 0 && innerCanTake(scrollersUnder(e.target, host), dy);
			const { state, push: fire } = touchPushMove(s, t.clientX, t.clientY, atEnd(lesson), innerCan);
			touchRef.current = state;
			if (fire) push(); // the rest of this touch is ignored
		};
		const onTouchEnd = (e: TouchEvent) => {
			if (!once(e)) return;
			if (e.type === "touchcancel" || e.touches.length === 0) touchRef.current = null;
		};
		const onWheel = (e: WheelEvent) => {
			if (!once(e)) return;
			if (!live()) {
				wheelRef.current = WHEEL_START;
				return;
			}
			const host = e.currentTarget as HTMLElement;
			const px = wheelPx(e.deltaY, e.deltaMode, lesson.clientHeight);
			const counts = e.deltaY > 0 && !e.ctrlKey && atEnd(lesson) && !innerCanTake(scrollersUnder(e.target, host), -1);
			const { state, push: fire } = wheelPushStep(wheelRef.current, px, performance.now(), counts);
			wheelRef.current = state;
			if (fire) push();
		};

		const opts = { passive: true } as const;
		const hosts = [root, lesson];
		for (const h of hosts) {
			h.addEventListener("touchstart", onTouchStart, opts);
			h.addEventListener("touchmove", onTouchMove, opts);
			h.addEventListener("touchend", onTouchEnd, opts);
			h.addEventListener("touchcancel", onTouchEnd, opts);
			h.addEventListener("wheel", onWheel, opts);
		}
		return () => {
			for (const h of hosts) {
				h.removeEventListener("touchstart", onTouchStart);
				h.removeEventListener("touchmove", onTouchMove);
				h.removeEventListener("touchend", onTouchEnd);
				h.removeEventListener("touchcancel", onTouchEnd);
				h.removeEventListener("wheel", onWheel);
			}
		};
	}, [rootRef, transcriptRef]);
}
