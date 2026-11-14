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
 * A TAP ON THE FOLDED QUESTION GLIDES DOWN INTO IT (owner's iPhone, then the
 * owner's choice on a test page: "stop the glide and immediately pull me
 * down", and "pull down into the question, like how you can already scroll
 * down into the question"). On a touch screen, away from the bottom:
 *   - a touch on the dock while the lesson still moves by itself (Safari's
 *     momentum) stops that motion first (stopMomentum, at the touchstart);
 *   - the tap starts ONE glide, the browser's own smooth scroll to the
 *     bottom (glideToBottom); the question stays folded and opens as the
 *     lesson arrives, by the fold machine's own "reached the bottom again"
 *     in chat.tsx;
 *   - a touch on the lesson or the dock, a wheel, a mouse press or a
 *     scrolling key during the glide ends it where it is, and nothing pulls
 *     the lesson back; so does anything else that moves the lesson back up
 *     once the glide has gone down (the status bar's scroll to the top, "Show
 *     in the lesson"). The browser's own shifts as messages above the screen
 *     take their real height (scroll anchoring, with the off-screen rule) are
 *     not taken for that (anchoringShift, glideReach): read as a scroll back
 *     up, they ended 1 in 10 glides short at iPhone size in Chromium;
 *   - the lesson growing under a glide in flight (a demo sizing itself as it
 *     comes on screen) re-aims the same glide at the new bottom once it has
 *     slowed (shouldRetarget), so it eases out and in again without a rest,
 *     and never brakes from full speed;
 *   - ending short with nobody touching glides once more, at most
 *     GLIDE_RETRIES times; if the lesson still won't go
 *     down, the caller opens the question where it is, as a computer does (a
 *     net, so a tap is never lost).
 * At the bottom the tap opens the question at once, as on a computer. (The
 * first version opened the question at the tap and slid the lesson with
 * use-stick-to-bottom's spring, sliding again each time a scroll report ended
 * it; on the iPhone it fought Safari's momentum and jittered.)
 *
 * A TAP ON THE QUESTION DURING A SLIDE (owner: "this change is fine"): an
 * open question can still be under a slide to the bottom (a question that
 * opens at the bottom, the lesson following a reply). A touch on the dock
 * then still stops the slide at once, but holds the question open until the
 * touch is known. Ends as a tap (it never moved, by dragDecision): the reveal
 * is taken up again, so the box that was tapped stays and the lesson ends at
 * the bottom. Moves, lasts past TAP_MS or gets a second finger: let go, and
 * the question folds as before. A touch on the lesson itself is unchanged: it
 * stops the slide, and that is that.
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
	/** A glide to the bottom (glideToBottom) is over:
	 *    "arrived"  at the bottom;
	 *    "stopped"  the learner stopped it (a touch, a wheel, a mouse press, a
	 *               scrolling key), or something else moved the lesson back up
	 *               (the status bar's scroll to the top, "Show in the lesson");
	 *    "gave-up"  the lesson wouldn't go down, with nobody touching: the
	 *               caller opens the question where it is, as a computer does. */
	onGlideEnd?: (end: GlideEnd) => void;
};

/** The keys that scroll the lesson when it or the page has the focus. */
export const SCROLL_KEYS = new Set(["PageUp", "PageDown", "ArrowUp", "ArrowDown", "Home", "End", " "]);

/** Pure rule, exported for tests: does this key press scroll the lesson (and
 *  so stop a glide to the bottom, as a touch does)? Only a scrolling key, and
 *  only while the focus is on the page itself or inside the lesson; a text
 *  box, the question's own controls and menus keep their keys. */
export function keyScrollsLesson(key: string, target: EventTarget | null, lesson: Element, doc: Document): boolean {
	if (!SCROLL_KEYS.has(key)) return false;
	if (target === doc || target === doc.body || target === doc.documentElement) return true;
	if (!(target instanceof Element) || !lesson.contains(target) || leaveAlone(target)) return false;
	// Space on a button or a link in the lesson presses it.
	return key !== " " || !target.closest('button, a[href], [role="button"], summary');
}

/** The glide has arrived: as close as the fold machine's own "reached the
 *  bottom again" (EXPAND_DIST in chat.tsx), which opens the question. */
export const GLIDE_ARRIVED_PX = 16;
/** A glide counts as ended once the lesson hasn't moved for this long. */
export const GLIDE_QUIET_MS = 150;
/** At most this many more glides when one ends short with nobody touching
 *  (the lesson grew under it, or the browser gave up). */
export const GLIDE_RETRIES = 2;
/** How far above the lowest point a glide has reached the lesson may be
 *  before something else has moved it back up. A glide only goes down, and
 *  the lesson growing under it doesn't move it up. */
export const GLIDE_PULLED_BACK_PX = 8;
/** The bottom has moved away under a glide in flight by more than this:
 *  aim the same glide at the new bottom. */
export const GLIDE_RETARGET_PX = 4;
/** Re-aim a glide in flight at most this often. */
export const GLIDE_RETARGET_MS = 100;
/** Re-aim only once the glide has slowed below this speed, in px per ms (10 px
 *  a frame at 60 Hz, 5 at 120 Hz). Chromium restarts a re-aimed smooth scroll
 *  from rest (390 px a frame, then 2); whether Safari keeps its speed can't be
 *  known here, so a re-aim waits until a restart can't be a hard brake. */
export const GLIDE_RETARGET_SLOW = 0.6;

/** The glide's speed in px per ms over its last frame or two (`samples`,
 *  oldest first), so one long frame doesn't read as slow. */
export function glideSpeed(samples: { t: number; top: number }[]): number {
	const first = samples[0];
	const last = samples[samples.length - 1];
	if (!first || !last || last.t <= first.t) return 0;
	return Math.abs(last.top - first.top) / (last.t - first.t);
}

/** Pure rule, exported for tests: re-aim a glide still in flight at the
 *  bottom it should now reach? The lesson grew under it (a demo sizing itself
 *  as it comes on screen): left alone, the glide slows to a stop short of the
 *  new bottom, rests, and starts again (stop-and-go). Re-aimed once it has
 *  slowed below GLIDE_RETARGET_SLOW, it eases out towards the old bottom and
 *  in again, with no rest and never a brake from full speed. Only while it
 *  still moves (an ended glide is the retry rule's case), when the bottom
 *  moved away by more than GLIDE_RETARGET_PX, and not more often than every
 *  GLIDE_RETARGET_MS. Never before the smooth scroll has started moving:
 *  `aimed` is null until it has been asked for, and `moved` says the lesson
 *  has moved since (a speed of 0 before the first frame of motion isn't
 *  "slowed"). */
export function shouldRetarget(g: { bottom: number; aimed: number | null; moved: boolean; sinceAimMs: number; quietMs: number; speed: number }): boolean {
	if (g.aimed === null || !g.moved || g.quietMs >= GLIDE_QUIET_MS) return false;
	return g.bottom - g.aimed > GLIDE_RETARGET_PX && g.sinceAimMs >= GLIDE_RETARGET_MS && g.speed < GLIDE_RETARGET_SLOW;
}

export type GlideEnd = "arrived" | "stopped" | "gave-up";

/** Pure rule, exported for tests: one look at a glide to the bottom.
 *    "arrived"     close enough to the bottom;
 *    "interrupted" it had gone down, and something moved the lesson back up
 *                  (a scroll this file can't see): end it as a learner's stop;
 *    "wait"        still moving (or not started yet);
 *    "again"       ended short with nobody touching: glide once more;
 *    "give-up"     ended short GLIDE_RETRIES times already.
 *  `pulledBack` is how far the lesson is above the lowest point this glide
 *  took it to, counted only once it has gone down at all: before that, motion
 *  up is Safari's momentum the stop didn't catch, and a later glide, once it
 *  has died, can still go down. */
export function glideStep(g: { distance: number; quietMs: number; retries: number; pulledBack: number }): "arrived" | "interrupted" | "wait" | "again" | "give-up" {
	if (g.distance <= GLIDE_ARRIVED_PX) return "arrived";
	if (g.pulledBack > GLIDE_PULLED_BACK_PX) return "interrupted";
	if (g.quietMs < GLIDE_QUIET_MS) return "wait";
	return g.retries < GLIDE_RETRIES ? "again" : "give-up";
}

export type GlideFrame = { top: number; height: number };

/** Pure rule, exported for tests: how much of one frame's move of the lesson
 *  (`prev` to `now`: its scrollTop and scrollHeight) is the browser keeping
 *  the view still (scroll anchoring) rather than a scroll. Messages above the
 *  screen that change height move the lesson's scrollTop by the same amount,
 *  and the lesson's height with it (with the off-screen rule, a message the
 *  glide passed takes its real height a frame later, above the screen).
 *    > 0  scrollTop rose with the height: that much of the rise is the browser's;
 *    < 0  scrollTop fell with the height: that much of the fall is the browser's;
 *    0    anything else: a move with the height unchanged, or the height
 *         changing alone (messages ahead of the screen), or the two moving
 *         opposite ways, is a scroll as far as the glide can tell.
 *  Never more than either move, so a scroll up larger than the height's fall
 *  still counts for the rest. */
export function anchoringShift(prev: GlideFrame, now: GlideFrame): number {
	const dTop = now.top - prev.top;
	const dHeight = now.height - prev.height;
	if (dTop > 0 && dHeight > 0) return Math.min(dTop, dHeight);
	if (dTop < 0 && dHeight < 0) return -Math.min(-dTop, -dHeight);
	return 0;
}

/** How long a rise of the lesson's scrollTop that was the browser's
 *  (anchoringShift) stays out of the glide's lowest point: a running smooth
 *  scroll puts scrollTop back on its own course within a frame or two
 *  (Chromium at iPhone size: the next frame, or the second after a 33 ms one). */
export const GLIDE_SHIFT_MS = 100;

export type GlideMarks = { start: number; lowest: number; credit: number; creditAt: number; taken: number };

/** Pure rule, exported for tests: the glide's start and the lowest point it has
 *  taken the lesson to, after one more frame (`prev` to `now`, at time `t`),
 *  with the browser's own shifts (anchoringShift) left out, so they never read
 *  as the glide pulled back up (glideStep's `pulledBack`), which ended it as a
 *  learner's stop:
 *    - a fall that is the browser's moves both marks down with the lesson;
 *    - a rise that is the browser's (`credit`) doesn't count as the glide going
 *      down for GLIDE_SHIFT_MS. A running smooth scroll (Chromium's, measured)
 *      keeps to its own course and puts scrollTop back on it a frame or two
 *      later: scrollTop then falls, with the height unchanged, from a place the
 *      glide never took it to, and that fall ends the credit. A browser
 *      whose smooth scroll moves with the shift goes on from there; once the
 *      credit has run out the lowest point catches up as it goes.
 *  A fall beyond the credit, with the height unchanged, still counts. A fall
 *  the credit covered (`taken`) followed by a frame in which the lesson didn't
 *  move at all counts too: the smooth scroll goes on after putting scrollTop
 *  back on its course, but a scroll by something else ("Show in the lesson",
 *  an instant scrollTo) cancels it, and the lesson stops dead. */
export function glideReach(marks: GlideMarks, prev: GlideFrame, now: GlideFrame, t: number): GlideMarks {
	const shift = anchoringShift(prev, now);
	let { start, lowest, credit, creditAt } = marks;
	if (marks.taken > 0 && now.top === prev.top) lowest = Math.max(lowest, now.top + marks.taken);
	let taken = 0;
	if (t - creditAt > GLIDE_SHIFT_MS) credit = 0;
	if (shift > 0) {
		credit += shift;
		creditAt = t;
	} else if (shift < 0) {
		start += shift;
		lowest += shift;
	}
	// The smooth scroll taking the browser's rise back (beyond the part of this
	// fall that anchoringShift already gave to the browser).
	const ownFall = prev.top - now.top + Math.min(0, shift);
	// The first fall after a rise is the smooth scroll back on its course, or not
	// at all: either way the rest of the credit goes with it.
	if (ownFall > 0) {
		taken = Math.min(credit, ownFall);
		credit = 0;
	}
	lowest = Math.max(lowest, now.top - credit);
	return { start, lowest, credit, creditAt, taken };
}

function prefersReducedMotion(): boolean {
	return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function useDockTouchScroll(rootRef: RefObject<HTMLElement | null>, transcriptRef: RefObject<HTMLElement | null>, hooks: DockTouchHooks = {}) {
	// A phone, and a tablet with the computer layout (owner's choice): the
	// dock is the transcript's sibling at every width.
	const touch = useIsTouchScreen();
	const hooksRef = useRef(hooks);
	hooksRef.current = hooks;
	// Set by the effect below, only on a touch screen.
	const glideRef = useRef<(() => boolean) | null>(null);
	/** On a touch screen: stop the lesson's own motion and glide it to its
	 *  bottom, once (onGlideEnd says how that ended). False elsewhere, and when
	 *  the lesson is already at its bottom: the caller opens at once. */
	const glideToBottom = useCallback(() => glideRef.current?.() ?? false, []);
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
		const distance = () => transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop;

		// STOP SAFARI'S OWN GLIDE (owner's choice B on the test page): the
		// lesson still moving under its own momentum when the dock is touched.
		// Safari ignores a page's scroll while it decelerates, so the scrolling
		// is hidden for one frame, keeping the place (the place as it is when
		// the scrolling comes back, so a drag begun meanwhile isn't undone).
		let restore = 0;
		let glideAfterRestore = false;
		// The inline value to put back: use-stick-to-bottom sets the scroller's
		// own `overflow: auto` inline.
		let overflowBefore = "";
		const scrollBack = () => {
			const y = transcript.scrollTop;
			transcript.style.overflowY = overflowBefore;
			transcript.scrollTop = y;
		};
		const endStop = () => {
			if (!restore) return;
			cancelAnimationFrame(restore);
			restore = 0;
			scrollBack();
		};
		const stopMomentum = () => {
			endStop();
			const y = transcript.scrollTop;
			overflowBefore = transcript.style.overflowY;
			transcript.style.overflowY = "hidden";
			transcript.scrollTop = y;
			restore = requestAnimationFrame(() => {
				restore = 0;
				scrollBack();
				// A glide asked for meanwhile starts now: on a box whose scrolling
				// is hidden it would be cut off when the scrolling comes back, and
				// restoring at once could undo the stop before a frame showed it
				// (a tap whose touchstart and touchend land in one frame).
				if (glideAfterRestore) {
					glideAfterRestore = false;
					smoothToBottom();
				}
			});
		};

		// THE GLIDE TO THE BOTTOM (glideToBottom): one motion, the browser's own
		// smooth scroll, watched each frame only to know how it ends. Input from
		// the learner ends it for good (stopGlide); ending short with nobody
		// touching starts it once more, at most GLIDE_RETRIES times.
		// `last` is the previous watched frame's scrollTop and height (glideReach).
		let glide: { frame: number; retries: number; top: number; movedAt: number; start: number; lowest: number; credit: number; creditAt: number; taken: number; last: GlideFrame; aimed: number | null; aimedAt: number; samples: { t: number; top: number }[] } | null = null;
		const bottom = () => transcript.scrollHeight - transcript.clientHeight;
		const smoothToBottom = () => {
			const to = bottom();
			if (glide) {
				glide.aimed = to;
				glide.aimedAt = performance.now();
			}
			transcript.scrollTo({ top: to, behavior: prefersReducedMotion() ? "auto" : "smooth" });
		};
		const glideOnce = () => {
			if (restore) glideAfterRestore = true;
			else smoothToBottom();
		};
		const endGlide = (end: GlideEnd) => {
			glideAfterRestore = false;
			if (!glide) return;
			cancelAnimationFrame(glide.frame);
			glide = null;
			hooksRef.current.onGlideEnd?.(end);
		};
		/** The learner took the lesson: end the glide where it is. `halt` also
		 *  stops the browser's smooth scroll, for an input that doesn't scroll
		 *  by itself; a wheel or a key moves the lesson anyway. */
		const stopGlide = (halt: boolean) => {
			if (!glide) return;
			endGlide("stopped");
			if (halt) transcript.scrollTo({ top: transcript.scrollTop, behavior: "instant" });
		};
		glideRef.current = () => {
			if (distance() <= GLIDE_ARRIVED_PX) return false;
			stopFling();
			endGlide("stopped");
			const top = transcript.scrollTop;
			glide = { frame: 0, retries: 0, top, movedAt: performance.now(), start: top, lowest: top, credit: 0, creditAt: 0, taken: 0, last: { top, height: transcript.scrollHeight }, aimed: null, aimedAt: 0, samples: [] };
			glideOnce();
			const watch = () => {
				if (!glide) return;
				const t = performance.now();
				const now = transcript.scrollTop;
				const here = { top: now, height: transcript.scrollHeight };
				glide.samples.push({ t, top: now });
				if (glide.samples.length > 3) glide.samples.shift();
				if (now !== glide.top) {
					glide.top = now;
					glide.movedAt = t;
				}
				// The browser keeping the view still as messages above the screen
				// take their real height (the off-screen rule) is not a scroll up.
				Object.assign(glide, glideReach(glide, glide.last, here, t));
				glide.last = here;
				const pulledBack = glide.lowest > glide.start + GLIDE_PULLED_BACK_PX ? glide.lowest - now : 0;
				const step = glideStep({ distance: distance(), quietMs: t - glide.movedAt, retries: glide.retries, pulledBack });
				if (step !== "wait" && step !== "again") {
					endGlide(step === "arrived" ? "arrived" : step === "give-up" ? "gave-up" : "stopped");
					return;
				}
				if (step === "again") {
					glide.retries++;
					glide.movedAt = t;
					glideOnce();
				} else if (shouldRetarget({ bottom: bottom(), aimed: glide.aimed, moved: glide.movedAt > glide.aimedAt, sinceAimMs: t - glide.aimedAt, quietMs: t - glide.movedAt, speed: glideSpeed(glide.samples) })) {
					// The same glide, aimed at the new bottom once it has slowed:
					// not one of the GLIDE_RETRIES.
					smoothToBottom();
				}
				glide.frame = requestAnimationFrame(watch);
			};
			glide.frame = requestAnimationFrame(watch);
			return true;
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
			stopFling();
			stopGlide(true);
			settleHeld(false);
			hooksRef.current.onTouchStart?.(false);
		};
		const onStart = (e: TouchEvent) => {
			const sliding = !!hooksRef.current.isSliding?.();
			const scrolledRecently = performance.now() - lastScrollAt < 100;
			// The lesson moving by itself (not this file's throw, not a slide):
			// Safari's momentum, or a glide. A touch on the dock stops it, as a
			// touch on the lesson does natively.
			const nativeMotion = scrolledRecently && frame === 0 && !sliding;
			movingAtStart = frame !== 0 || scrolledRecently || sliding;
			startT = e.timeStamp;
			stopFling();
			endGlide("stopped");
			if (nativeMotion) stopMomentum();
			settleHeld(false);
			const first = e.touches[0];
			if (sliding && e.touches.length === 1 && first) {
				// A tap on the question while the lesson slides to the bottom
				// (the slide after a question opens at the bottom, or the lesson
				// following a reply) mustn't fold the question out from under the
				// finger: hold it until the touch is known.
				held = true;
				heldX = first.clientX;
				heldY = first.clientY;
				heldPencil = isPencilTouch(first);
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
		// Scrolling by other means ends a glide too: a wheel (an iPad's
		// trackpad), a mouse on the lesson or its scrollbar (a touch laptop),
		// the scrolling keys. Their own scrolling then goes on, and nothing
		// pulls the lesson back.
		// A wheel halts it too: the browser's smooth scroll runs on under a
		// wheel, and the wheel's own step still applies after the halt.
		const onWheel = () => stopGlide(true);
		const onPointerDown = (e: PointerEvent) => {
			if (e.pointerType === "mouse") stopGlide(true);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (keyScrollsLesson(e.key, e.target, transcript, document)) stopGlide(false);
		};
		root.addEventListener("wheel", onWheel, { passive: true });
		transcript.addEventListener("wheel", onWheel, { passive: true });
		transcript.addEventListener("pointerdown", onPointerDown, { passive: true });
		document.addEventListener("keydown", onKeyDown, true);
		return () => {
			transcript.style.overscrollBehaviorY = previousOverscroll;
			stopFling();
			endStop();
			endGlide("stopped");
			settleHeld(false);
			glideRef.current = null;
			root.removeEventListener("wheel", onWheel);
			transcript.removeEventListener("wheel", onWheel);
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
	return { glideToBottom };
}
