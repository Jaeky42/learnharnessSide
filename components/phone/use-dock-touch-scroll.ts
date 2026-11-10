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
 * A TOUCH STOPS THE SLIDE TO THE BOTTOM (owner's find on their iPhone).
 * When a question opens, or the learner reaches the bottom, the transcript
 * slides down to the bottom (use-stick-to-bottom's scrollToBottom). While
 * that slide runs it pulls the scroll down every frame, and chat.tsx won't
 * fold the question until it settles or is interrupted. A wheel interrupts
 * it at once; a finger never did, so a swipe while the text was still
 * moving was pulled back into the question. `onTouchStart` runs on every
 * touch on the dock or the transcript; chat.tsx stops the slide there, and
 * only while one is under way (running, or a reveal still waiting for its
 * first frame), the way a touch stops a moving list on an iPhone.
 *
 * A TAP WHILE THE LESSON IS MOVING still taps. On an iPhone the first tap on
 * something that is still scrolling only stops the scroll; Safari swallows
 * it, so tapping the folded question then stopped the text with a jolt and
 * left the question folded (owner's iPhone). A tap on the dock that began
 * while the lesson was moving (a throw, a slide, or a scroll in the last
 * 100ms) is replayed as a click on what was touched, and its own click is
 * cancelled so it can't land twice. (Calling stopScroll on every move instead made scrolling jump up
 * and down on the owner's iPhone and was reverted.)
 *
 * Phone layout only. Horizontal drags (the confidence slider, wide tables)
 * and drags that start in a text box are left alone. The choice is made on
 * the drag's first movement (dragDecision).
 */

import { useEffect, useRef, type RefObject } from "react";
import { useIsPhone } from "@/components/phone/use-phone";
import { dlog } from "@/components/phone/scroll-debug"; // TEMPORARY scroll-debug

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

/** Pure rule, exported for tests: what a one-finger drag does, decided on
 *  its FIRST movement. iPhone Safari picks native scrolling on the first
 *  touchmove that isn't prevented, so waiting for a few pixels of travel let
 *  Safari scroll the page while this also moved the lesson, and the page
 *  snapping back made scrolling jump and rubber-band (owner's iPhone). Once
 *  native scrolling has started the event isn't cancelable and is left to it.
 *    "wait"   no movement yet;
 *    "native" sideways, a scroll box under the finger can take it, or too late;
 *    "take"   nothing under the finger can scroll that way: the caller moves
 *             the lesson (the dock) or stops the drag (the page). */
export function dragDecision(dx: number, dy: number, cancelable: boolean, innerCan: (dy: number) => boolean): "wait" | "native" | "take" {
	if (!cancelable) return "native";
	if (dx === 0 && dy === 0) return "wait";
	if (Math.abs(dx) > Math.abs(dy)) return "native";
	return innerCan(dy) ? "native" : "take";
}

/** How far back the release speed looks, and the fastest fling, px/frame. */
export const FLING_WINDOW_MS = 80;
export const FLING_MAX = 60;

/** Pure rule, exported for tests: the fling's starting speed (px per 16ms
 *  frame, finger direction) from the drag's recent finger positions. It
 *  spans the last FLING_WINDOW_MS, not the last move alone: as a finger
 *  lifts, an iPhone can report a tiny twitch backwards a millisecond after
 *  the previous move, which read as a fast throw the other way, sent the
 *  lesson back to the bottom and re-opened the question (owner's iPhone).
 *  A finger that stopped before lifting throws nothing. */
export function releaseVelocity(samples: { t: number; y: number }[], endT: number): number {
	const last = samples[samples.length - 1];
	if (!last || endT - last.t > 50) return 0;
	const recent = samples.filter((s) => last.t - s.t <= FLING_WINDOW_MS);
	const first = recent[0];
	if (!first || last.t - first.t < 8) return 0;
	const v = ((last.y - first.y) / (last.t - first.t)) * 16;
	return Math.max(-FLING_MAX, Math.min(FLING_MAX, v));
}

/** Pure rule, exported for tests: the next fling velocity (px per 16ms
 *  frame) after `frames` such frames (fractional at 120 fps), or 0 once it
 *  is too slow to see. */
export function flingStep(v: number, frames = 1): number {
	const next = v * FLING_DECAY ** frames;
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

/** How long a touch can last and still count as a tap, in ms. */
export const TAP_MS = 500;

/** Pure rule, exported for tests: does a touch that never became a drag
 *  replay as a click? Only when the lesson was moving as it began (Safari
 *  swallows that tap) and it was short. */
export function replayTap(movingAtStart: boolean, durationMs: number): boolean {
	return movingAtStart && durationMs <= TAP_MS;
}

export type DockTouchHooks = {
	/** Every touch on the dock or the transcript, before anything else. */
	onTouchStart?: () => void;
	/** Is the transcript sliding to the bottom right now? */
	isSliding?: () => boolean;
};

export function useDockTouchScroll(rootRef: RefObject<HTMLElement | null>, transcriptRef: RefObject<HTMLElement | null>, hooks: DockTouchHooks = {}) {
	const phone = useIsPhone();
	const hooksRef = useRef(hooks);
	hooksRef.current = hooks;
	useEffect(() => {
		const root = rootRef.current;
		const transcript = transcriptRef.current;
		if (!phone || !root || !transcript) return;
		let startX = 0;
		let startY = 0;
		let lastY = 0;
		let samples: { t: number; y: number }[] = [];
		let mode: "idle" | "pending" | "native" | "forward" = "idle";
		let target: EventTarget | null = null;
		let frame = 0;
		let startT = 0;
		let movingAtStart = false;
		let lastScrollAt = -Infinity;
		const onTranscriptScroll = () => {
			lastScrollAt = performance.now();
		};
		const stopFling = () => {
			cancelAnimationFrame(frame);
			frame = 0;
		};
		const onTranscriptStart = () => {
			stopFling();
			hooksRef.current.onTouchStart?.();
		};
		const onStart = (e: TouchEvent) => {
			movingAtStart = frame !== 0 || performance.now() - lastScrollAt < 100 || !!hooksRef.current.isSliding?.();
			startT = e.timeStamp;
			stopFling();
			hooksRef.current.onTouchStart?.();
			if (e.touches.length !== 1 || leaveAlone(e.target)) {
				mode = "idle";
				return;
			}
			const t = e.touches[0];
			if (!t) return;
			startX = t.clientX;
			startY = lastY = t.clientY;
			samples = [{ t: e.timeStamp, y: t.clientY }];
			target = e.target;
			mode = "pending";
		};
		const onMove = (e: TouchEvent) => {
			const t = e.touches[0];
			if (mode === "idle" || mode === "native" || e.touches.length !== 1 || !t) return;
			if (mode === "pending") {
				const decision = dragDecision(t.clientX - startX, t.clientY - startY, e.cancelable, (dy) => innerCanTake(scrollersUnder(target, root), dy));
				if (decision === "wait") return;
				if (decision === "native") {
					// scroll-debug (temporary)
					dlog(!e.cancelable ? "drag: Safari already scrolling (left alone)" : Math.abs(t.clientX - startX) > Math.abs(t.clientY - startY) ? "drag: sideways" : "drag: panel scrolls itself");
					mode = "native";
					return;
				}
				dlog(`drag on question: moving the lesson ${t.clientY > startY ? "up" : "down"}`); // scroll-debug (temporary)
				mode = "forward";
			}
			e.preventDefault();
			const step = t.clientY - lastY;
			samples.push({ t: e.timeStamp, y: t.clientY });
			if (samples.length > 32) samples.shift();
			lastY = t.clientY;
			transcript.scrollTop -= step;
		};
		const onEnd = (e: TouchEvent) => {
			if (mode === "pending" && e.type === "touchend" && replayTap(movingAtStart, e.timeStamp - startT) && target instanceof HTMLElement) {
				mode = "idle";
				if (e.cancelable) e.preventDefault();
				dlog("tap while moving: replayed"); // scroll-debug (temporary)
				target.click();
				return;
			}
			if (mode !== "forward") {
				mode = "idle";
				return;
			}
			mode = "idle";
			let v = releaseVelocity(samples, e.timeStamp);
			dlog(v === 0 ? "release: no throw" : `release: throw ${v > 0 ? "up" : "down"} ${Math.abs(v).toFixed(1)}px/frame`); // scroll-debug (temporary)
			if (v === 0) return;
			// Time-based, so the throw travels as far at 120 fps as at 60.
			let prev = performance.now();
			const tick = (now: number) => {
				const frames = Math.min(4, Math.max(0, (now - prev) / 16));
				prev = now;
				transcript.scrollTop -= v * frames;
				v = flingStep(v, frames);
				if (v === 0) {
					frame = 0;
					return;
				}
				frame = requestAnimationFrame(tick);
			};
			frame = requestAnimationFrame(tick);
		};
		root.addEventListener("touchstart", onStart, { passive: true });
		root.addEventListener("touchmove", onMove, { passive: false });
		root.addEventListener("touchend", onEnd);
		root.addEventListener("touchcancel", onEnd);
		// A touch on the transcript itself stops a fling, as native scrolling does.
		transcript.addEventListener("touchstart", onTranscriptStart, { passive: true });
		transcript.addEventListener("scroll", onTranscriptScroll, { passive: true });
		return () => {
			stopFling();
			root.removeEventListener("touchstart", onStart);
			root.removeEventListener("touchmove", onMove);
			root.removeEventListener("touchend", onEnd);
			root.removeEventListener("touchcancel", onEnd);
			transcript.removeEventListener("touchstart", onTranscriptStart);
			transcript.removeEventListener("scroll", onTranscriptScroll);
		};
	}, [phone, rootRef, transcriptRef]);
}
