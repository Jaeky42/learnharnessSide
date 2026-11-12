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
 * A TAP ON THE FOLDED QUESTION ENDS AT THE BOTTOM, OPEN (owner's iPhone: it
 * opened for an instant and folded again, with the lesson left far up). The
 * tap opens the question and slides the lesson down (use-stick-to-bottom's
 * scrollToBottom). That library takes ANY upward scroll during its slide for
 * the learner leaving: it ends the slide at once, chat.tsx then lets go of
 * the question, and the next scroll event folds it. On an iPhone such scrolls
 * come without a new touch: Safari's own deceleration of a lesson still
 * moving, or its late reports of where the lesson was. A tap whose wobble
 * became a short drag here could also leave this file's own throw running
 * against the slide. So on a touch screen a reveal (revealToBottom): stops
 * that throw first, and holds the question open, sliding again whenever a
 * slide ends short of the bottom, until the lesson is at its bottom, or the
 * learner touches or wheels again (a new touch still stops the slide), or
 * scrolls by mouse on the lesson or by key (a touch laptop), or
 * REVEAL_HOLD_MS has passed. Elsewhere it is one slide, as before.
 *
 * A TAP ON THE QUESTION DURING THE SLIDE (for the owner to review): a touch
 * on the dock while the lesson slides to the bottom still stops the slide at
 * once, but holds the question open until the touch is known. Ends as a tap
 * (it never moved, by dragDecision): the reveal is taken up again, so the box
 * that was tapped stays and the lesson ends at the bottom. Moves, lasts past
 * TAP_MS or gets a second finger: let go, and the question folds as before.
 * A touch on the lesson itself is unchanged: it stops the slide, and that is
 * that.
 *
 * NO BOUNCE AT THE ENDS (found with the scroll readout on the owner's
 * iPhone). When the lesson overshot its bottom, Safari's rubber-band spring
 * pulled it back to the edge; a swipe that began during that bounce folded
 * the question, but the spring kept running underneath, overrode the
 * forwarded scroll and snapped the lesson back to the bottom, which
 * re-opened the question (the readout showed d below zero, then FOLD, then
 * "reached the bottom" 150ms later with nothing else moving it). The
 * transcript gets overscroll-behavior-y: none on phones, so it stops dead at
 * its ends like the desktop's.
 *
 * Phone layout only. Horizontal drags (the confidence slider, wide tables)
 * and drags that start in a text box are left alone. The choice is made on
 * the drag's first movement (dragDecision).
 */

import { useCallback, useEffect, useRef, type RefObject } from "react";
import { useIsTouchScreen } from "@/components/phone/use-phone";

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

/** How far an Apple Pencil moves before it counts as a drag (dragDecision).
 *  The owner's Pencil taps moved at most 9.6 px; the test page's bench with
 *  this slop clicked on all 27 Pencil taps. */
export const PENCIL_SLOP = 12;

/** Is this touch an Apple Pencil? iPadOS labels each touch (`touchType`,
 *  "stylus" or "direct"); other browsers don't, so it reads as a finger. */
export function isPencilTouch(t: Touch): boolean {
	return (t as Touch & { touchType?: string }).touchType === "stylus";
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
 *             the lesson (the dock) or stops the drag (the page).
 *
 *  An Apple Pencil waits PENCIL_SLOP px first (owner's iPad, option B of two).
 *  A Pencil tap always moves a little (1.4 to 9.6 px in the owner's test; a
 *  finger tap moved 0), and stopping that move cost the tap its click, so a
 *  Pencil tap often needed several tries. Under the slop its moves are left
 *  to Safari. The owner accepted the cost: a Pencil drag that starts where
 *  nothing can scroll may move the page a little before it is stopped. */
export function dragDecision(dx: number, dy: number, cancelable: boolean, innerCan: (dy: number) => boolean, pencil = false): "wait" | "native" | "take" {
	if (!cancelable) return "native";
	if (pencil && Math.hypot(dx, dy) < PENCIL_SLOP) return "wait";
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
	/** Every touch on the dock or the transcript, before anything else. `hold`
	 *  is true for one finger on the DOCK while the lesson slides to the
	 *  bottom: the slide stops at once, but the question stays held until
	 *  onTouchSettled says whether the touch was a tap. */
	onTouchStart?: (hold: boolean) => void;
	/** Is the transcript sliding to the bottom right now? */
	isSliding?: () => boolean;
	/** A held dock touch is known: a tap (take the reveal up again) or not
	 *  (a drag, a long press, a second finger: let go, as a touch did before). */
	onTouchSettled?: (tap: boolean) => void;
};

/** The keys that scroll the lesson when it or the page has the focus. */
export const SCROLL_KEYS = new Set(["PageUp", "PageDown", "ArrowUp", "ArrowDown", "Home", "End", " "]);

/** Pure rule, exported for tests: does this key press scroll the lesson (and
 *  so let go of a reveal, as a touch does)? Only a scrolling key, and only
 *  while the focus is on the page itself or inside the lesson; a text box,
 *  the question's own controls and menus keep their keys. */
export function keyScrollsLesson(key: string, target: EventTarget | null, lesson: Element, doc: Document): boolean {
	if (!SCROLL_KEYS.has(key)) return false;
	if (target === doc || target === doc.body || target === doc.documentElement) return true;
	if (!(target instanceof Element) || !lesson.contains(target) || leaveAlone(target)) return false;
	// Space on a button or a link in the lesson presses it.
	return key !== " " || !target.closest('button, a[href], [role="button"], summary');
}

/** The longest a reveal holds the question open on a touch screen, in ms. A
 *  slide from far up takes about 2 s; this leaves room for a lesson that was
 *  still moving when the tap landed. */
export const REVEAL_HOLD_MS = 4000;
/** Close enough to the bottom: the slide stops 1 px short of it. */
export const REVEAL_BOTTOM_PX = 2;

/** Pure rule, exported for tests: a slide to the bottom has ended; is the
 *  reveal over? Yes at the bottom, or once the hold was let go (a new touch
 *  or wheel, the time limit). Otherwise motion that wasn't the learner's
 *  stopped the slide short: slide again. */
export function revealOver(distance: number, held: boolean): boolean {
	return !held || distance <= REVEAL_BOTTOM_PX;
}

/** A touch screen's reveal, exported for tests: slide, and slide again (a
 *  frame later) while the slide ends short of the bottom and the hold lasts. */
export async function holdReveal(o: { slide: () => unknown; distance: () => number; held: () => boolean; frame: () => Promise<unknown> }): Promise<void> {
	for (;;) {
		await o.slide();
		if (revealOver(o.distance(), o.held())) return;
		await o.frame();
		if (!o.held()) return;
	}
}

/** Open the question's way to the bottom: `slide` is scrollToBottom, `held`
 *  says chat.tsx still holds the question open, `settle` lets go of it. */
export type RevealToBottom = (slide: () => unknown, held: () => boolean, settle: () => void) => Promise<unknown>;

export function useDockTouchScroll(rootRef: RefObject<HTMLElement | null>, transcriptRef: RefObject<HTMLElement | null>, hooks: DockTouchHooks = {}) {
	// A phone, and a tablet with the computer layout (owner's choice): the
	// dock is the transcript's sibling at every width.
	const touch = useIsTouchScreen();
	const hooksRef = useRef(hooks);
	hooksRef.current = hooks;
	const touchRef = useRef(touch);
	touchRef.current = touch;
	// Set by the effect below: stop this file's throw; when the learner last
	// touched the dock or the lesson, or turned a wheel over them.
	const motionRef = useRef({ stop: () => {}, inputAt: -Infinity });
	const revealIdRef = useRef(0);
	const revealToBottom = useCallback<RevealToBottom>((slide, held, settle) => {
		const transcript = transcriptRef.current;
		if (!touchRef.current || !transcript) return Promise.resolve(slide()).finally(settle);
		motionRef.current.stop();
		const id = ++revealIdRef.current;
		const startedAt = performance.now();
		const holds = () => id === revealIdRef.current && motionRef.current.inputAt < startedAt && held();
		return holdReveal({
			slide,
			distance: () => transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop,
			held: holds,
			frame: () => new Promise(requestAnimationFrame),
		}).finally(() => {
			// A newer reveal owns the hold now.
			if (id === revealIdRef.current) settle();
		});
	}, [transcriptRef]);
	useEffect(() => {
		const root = rootRef.current;
		const transcript = transcriptRef.current;
		if (!touch || !root || !transcript) return;
		const previousOverscroll = transcript.style.overscrollBehaviorY;
		transcript.style.overscrollBehaviorY = "none";
		let startX = 0;
		let startY = 0;
		let lastY = 0;
		let pencil = false;
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
		const motion = motionRef.current;
		motion.stop = stopFling;
		const onInput = () => {
			motion.inputAt = performance.now();
		};
		// A dock touch that stopped a slide and holds the question (onTouchSettled).
		let held = false;
		let heldX = 0;
		let heldY = 0;
		let heldPencil = false;
		const settleHeld = (tap: boolean) => {
			if (!held) return;
			held = false;
			hooksRef.current.onTouchSettled?.(tap);
		};
		const onTranscriptStart = () => {
			onInput();
			stopFling();
			settleHeld(false);
			hooksRef.current.onTouchStart?.(false);
		};
		const onStart = (e: TouchEvent) => {
			onInput();
			const sliding = !!hooksRef.current.isSliding?.();
			movingAtStart = frame !== 0 || performance.now() - lastScrollAt < 100 || sliding;
			startT = e.timeStamp;
			stopFling();
			settleHeld(false);
			const first = e.touches[0];
			if (sliding && e.touches.length === 1 && first) {
				// A tap on the question while the lesson slides to the bottom
				// (a reveal, or the slide after reaching it) mustn't fold the
				// question out from under the finger: hold it, and end the
				// running reveal without letting go of the question.
				held = true;
				heldX = first.clientX;
				heldY = first.clientY;
				heldPencil = isPencilTouch(first);
				revealIdRef.current++;
			}
			hooksRef.current.onTouchStart?.(held);
			if (e.touches.length !== 1 || leaveAlone(e.target)) {
				mode = "idle";
				return;
			}
			const t = e.touches[0];
			if (!t) return;
			pencil = isPencilTouch(t);
			startX = t.clientX;
			startY = lastY = t.clientY;
			samples = [{ t: e.timeStamp, y: t.clientY }];
			target = e.target;
			mode = "pending";
		};
		const onMove = (e: TouchEvent) => {
			const t = e.touches[0];
			// The held touch moved: it is a drag, decided as for any drag, and
			// it lets go before it moves the lesson, so it folds as before.
			if (held && (e.touches.length !== 1 || !t || dragDecision(t.clientX - heldX, t.clientY - heldY, true, () => false, heldPencil) !== "wait")) settleHeld(false);
			if (mode === "idle" || mode === "native" || e.touches.length !== 1 || !t) return;
			if (mode === "pending") {
				const decision = dragDecision(t.clientX - startX, t.clientY - startY, e.cancelable, (dy) => innerCanTake(scrollersUnder(target, root), dy), pencil);
				if (decision === "wait") return;
				if (decision === "native") {
					mode = "native";
					return;
				}
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
			const tap = e.type === "touchend" && e.touches.length === 0 && e.timeStamp - startT <= TAP_MS;
			endTouch(e);
			// After a replayed click, so what the tap pressed acts first.
			settleHeld(tap);
		};
		const endTouch = (e: TouchEvent) => {
			if (mode === "pending" && e.type === "touchend" && replayTap(movingAtStart, e.timeStamp - startT) && target instanceof HTMLElement) {
				mode = "idle";
				if (e.cancelable) e.preventDefault();
				target.click();
				return;
			}
			if (mode !== "forward") {
				mode = "idle";
				return;
			}
			mode = "idle";
			let v = releaseVelocity(samples, e.timeStamp);
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
		// Scrolling by other means lets go of a reveal, as a touch does: a wheel
		// (an iPad's trackpad), a mouse on the lesson or its scrollbar (a touch
		// laptop), the scrolling keys.
		const onPointerDown = (e: PointerEvent) => {
			if (e.pointerType === "mouse") onInput();
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (keyScrollsLesson(e.key, e.target, transcript, document)) onInput();
		};
		root.addEventListener("wheel", onInput, { passive: true });
		transcript.addEventListener("wheel", onInput, { passive: true });
		transcript.addEventListener("pointerdown", onPointerDown, { passive: true });
		document.addEventListener("keydown", onKeyDown, true);
		return () => {
			transcript.style.overscrollBehaviorY = previousOverscroll;
			stopFling();
			settleHeld(false);
			motion.stop = () => {};
			root.removeEventListener("wheel", onInput);
			transcript.removeEventListener("wheel", onInput);
			transcript.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown, true);
			root.removeEventListener("touchstart", onStart);
			root.removeEventListener("touchmove", onMove);
			root.removeEventListener("touchend", onEnd);
			root.removeEventListener("touchcancel", onEnd);
			transcript.removeEventListener("touchstart", onTranscriptStart);
			transcript.removeEventListener("scroll", onTranscriptScroll);
		};
	}, [touch, rootRef, transcriptRef]);
	return { revealToBottom, revealHoldMs: touch ? REVEAL_HOLD_MS : undefined };
}
