"use client";

/**
 * Drag on the dock scrolls the lesson (cloud sync Phase 3, owner's ask after
 * the real-phone check). The dock (an opened question, a practice problem,
 * the message box) is a SIBLING of the transcript scroller, so a finger
 * drag on it never chains to the transcript: on the owner's iPhone only a
 * thin strip of lesson above a full-screen question could be dragged. The
 * desktop forwards the mouse wheel for the same reason (forwardDockWheel in
 * components/dock-height.ts); this is the touch version, with the same rule:
 * a real scroll container under the finger keeps native scrolling while it
 * can still move that way, and only otherwise does the drag move the
 * transcript (which also folds an opened question, as scrolling does).
 *
 * Phone layout only. Horizontal drags (the confidence slider, wide tables)
 * and drags that start in a text box are left alone.
 */

import { useEffect, type RefObject } from "react";
import { useIsPhone } from "@/components/phone/use-phone";

/** Finger travel before a drag picks a direction, in px. */
export const DRAG_SLOP = 8;
/** Per-frame velocity decay of the fling after the finger lifts. */
export const FLING_DECAY = 0.95;

export type ScrollBox = { scrollTop: number; scrollHeight: number; clientHeight: number };

/** Pure rule, exported for tests: can one of these scrollers (innermost
 *  first) still move for a finger moving by dy (down is positive, which
 *  reveals content above)? */
export function innerCanTake(boxes: ScrollBox[], dy: number): boolean {
	for (const b of boxes) {
		if (b.scrollHeight - b.clientHeight < 2) continue;
		if (dy > 0 ? b.scrollTop > 0 : b.scrollTop < b.scrollHeight - b.clientHeight - 0.5) return true;
	}
	return false;
}

/** Pure rule, exported for tests: the next fling velocity (px per frame), or
 *  0 once it is too slow to see. */
export function flingStep(v: number): number {
	const next = v * FLING_DECAY;
	return Math.abs(next) < 0.5 ? 0 : next;
}

function scrollersUnder(target: EventTarget | null, root: HTMLElement): ScrollBox[] {
	const out: ScrollBox[] = [];
	for (let n = target as HTMLElement | null; n && n !== root; n = n.parentElement) {
		if (!(n instanceof HTMLElement)) continue;
		if (/^(auto|scroll)$/.test(getComputedStyle(n).overflowY)) out.push(n);
	}
	return out;
}

function leaveAlone(target: EventTarget | null): boolean {
	return target instanceof Element && !!target.closest('textarea, input, select, [contenteditable="true"], .cm-editor');
}

export function useDockTouchScroll(rootRef: RefObject<HTMLElement | null>, transcriptRef: RefObject<HTMLElement | null>) {
	const phone = useIsPhone();
	useEffect(() => {
		const root = rootRef.current;
		const transcript = transcriptRef.current;
		if (!phone || !root || !transcript) return;
		let startX = 0;
		let startY = 0;
		let lastY = 0;
		let lastT = 0;
		let velocity = 0; // px per frame (16ms), finger direction
		let mode: "idle" | "pending" | "native" | "forward" = "idle";
		let target: EventTarget | null = null;
		let frame = 0;
		const stopFling = () => {
			cancelAnimationFrame(frame);
			frame = 0;
		};
		const onStart = (e: TouchEvent) => {
			stopFling();
			if (e.touches.length !== 1 || leaveAlone(e.target)) {
				mode = "idle";
				return;
			}
			const t = e.touches[0];
			if (!t) return;
			startX = t.clientX;
			startY = lastY = t.clientY;
			lastT = e.timeStamp;
			velocity = 0;
			target = e.target;
			mode = "pending";
		};
		const onMove = (e: TouchEvent) => {
			const t = e.touches[0];
			if (mode === "idle" || mode === "native" || e.touches.length !== 1 || !t) return;
			if (mode === "pending") {
				const dx = t.clientX - startX;
				const dy = t.clientY - startY;
				if (Math.abs(dx) < DRAG_SLOP && Math.abs(dy) < DRAG_SLOP) return;
				if (Math.abs(dx) > Math.abs(dy) || innerCanTake(scrollersUnder(target, root), dy)) {
					mode = "native";
					return;
				}
				mode = "forward";
			}
			e.preventDefault();
			const step = t.clientY - lastY;
			const dt = Math.max(1, e.timeStamp - lastT);
			velocity = (step / dt) * 16;
			lastY = t.clientY;
			lastT = e.timeStamp;
			transcript.scrollTop -= step;
		};
		const onEnd = () => {
			if (mode !== "forward") {
				mode = "idle";
				return;
			}
			mode = "idle";
			let v = velocity;
			const tick = () => {
				v = flingStep(v);
				if (v === 0) {
					frame = 0;
					return;
				}
				transcript.scrollTop -= v;
				frame = requestAnimationFrame(tick);
			};
			frame = requestAnimationFrame(tick);
		};
		root.addEventListener("touchstart", onStart, { passive: true });
		root.addEventListener("touchmove", onMove, { passive: false });
		root.addEventListener("touchend", onEnd);
		root.addEventListener("touchcancel", onEnd);
		// A touch on the transcript itself stops a fling, as native scrolling does.
		transcript.addEventListener("touchstart", stopFling, { passive: true });
		return () => {
			stopFling();
			root.removeEventListener("touchstart", onStart);
			root.removeEventListener("touchmove", onMove);
			root.removeEventListener("touchend", onEnd);
			root.removeEventListener("touchcancel", onEnd);
			transcript.removeEventListener("touchstart", stopFling);
		};
	}, [phone, rootRef, transcriptRef]);
}
