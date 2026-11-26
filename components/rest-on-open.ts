/**
 * Side-tutor fork: REST ON OPEN. From the moment a lesson opens until the
 * learner's first scroll, tap or key press, the lesson is kept at its resting
 * point (its bottom; for a lesson whose check waits folded, the end of the
 * text: components/check-blank-space.ts), so that messages taking their real
 * height can't leave it stopped short of it.
 *
 * The fault this fixes (measured in Chromium, production builds): a lesson
 * opened and stopped 12 to 135 px short of its resting point, and stayed
 * there. The cause is use-stick-to-bottom's own rule for telling the learner
 * scrolling up from a resize. Its scroll handler compares each scroll event's
 * scrollTop with the previous one's, and a timeout 1 ms later takes any
 * decrease for the learner scrolling up (it stops following the bottom),
 * unless its one shared `resizeDifference` is non-zero at that moment. When a
 * message above the screen takes its real height under the off-screen rule
 * (app/offscreen.css) and is shorter than its estimate, the browser's scroll
 * anchoring moves scrollTop up with it, and that scroll event is such a
 * decrease. The guard doesn't hold it: on a busy main thread the timeout runs
 * tens of milliseconds late, after the next ResizeObserver callback has
 * overwritten `resizeDifference` (with 0 for a callback that saw no change of
 * height, or reset by an earlier one). So the library lets go, the slide to
 * the bottom stops where it is, and later growth is no longer followed.
 *
 * The rule: while nothing the learner did has moved the lesson, a lesson above
 * its resting point (more than 2 px), with no slide of the library under way,
 * is put back there through the library's own setter, and the library is set
 * following the bottom again (its own `scrollToBottom("instant")`, which moves
 * nothing further). One at rest whose library had let go is set following
 * again without moving. The check runs a few milliseconds after every scroll
 * event of the lesson (after the library's own 1 ms decision on that event),
 * and after every resize of the lesson or its content.
 *
 * It ends for good, and the page behaves exactly as before, at the learner's
 * first wheel, touch, pointer press or key press anywhere on the page; at the
 * first scroll event that moved what is on screen other than by the library's
 * own setter (a scroll the learner made, also when its input event comes late
 * or never reaches the page: Chromium scrolls a wheel on the compositor, and in
 * headless runs the page often saw the scroll and no wheel event at all;
 * scroll anchoring moves scrollTop and keeps what is on screen still, which is
 * how it is told apart: viewMovedByOther; a scroll up of this kind also lets
 * the library go, as its wheel handler would have, so a re-arm still waiting
 * for its frame can't pull the lesson back); at any jump to a passage (Find, a citation, the Tutor's "Show in the lesson", a link
 * to a message: they all go through revealOffscreenTarget, which calls
 * noteLessonJump), and it never starts when the lesson opens on a link to a
 * message (a message anchor in the address).
 *
 * A lesson further down than its resting point is never moved (a check's blank
 * space is check-blank-space.ts's backToRest), and one too short to scroll
 * neither. The pure decision is restOnOpenStep; installRestOnOpen wires it.
 */

import { messageIdFromHash } from "@/src/core";

/** A lesson this far above its resting point (px) is put back. */
export const REST_TOLERANCE_PX = 2;
/** The check runs this long after a scroll event: after use-stick-to-bottom's
 *  own 1 ms timeout for that event (timers run in the order they are due). */
export const REST_CHECK_DELAY_MS = 5;
/** What is on screen moved by more than this (px) at a scroll event, beyond
 *  the library's own setter: a scroll of the learner's. */
export const VIEW_MOVED_PX = 2;
/** At most this many rows on screen are looked at. */
const LOOK_ROWS = 16;

export type RestOnOpenStep = "none" | "put-back" | "re-arm" | "wait";

export interface RestOnOpenFacts {
	/** The learner acted, or a jump took the lesson elsewhere. */
	ended: boolean;
	/** The library's own slide to the bottom is under way. */
	sliding: boolean;
	/** The lesson can scroll at all. */
	scrollable: boolean;
	/** The lesson's scrollTop. */
	top: number;
	/** The resting point (the library's own target, with the fork's targetScrollTop). */
	rest: number;
	/** The library is following the bottom. */
	following: boolean;
}

/** What to do now. "wait": look again at the next frame (the slide decides
 *  where it ends; it may let go on the way). */
export function restOnOpenStep(f: RestOnOpenFacts): RestOnOpenStep {
	if (f.ended || !f.scrollable) return "none";
	if (f.sliding) return "wait";
	if (f.top < f.rest - REST_TOLERANCE_PX) return "put-back";
	if (!f.following && f.top <= f.rest + REST_TOLERANCE_PX) return "re-arm";
	return "none";
}

/** The events that end it: the learner's own input, anywhere on the page (a
 *  wheel or a drag on the dock scrolls the lesson from script). */
export const REST_END_EVENTS = ["wheel", "touchstart", "pointerdown", "mousedown", "keydown"] as const;

/** A link to a message in the address (`#message-…`): the lesson opens on it. */
export function opensOnMessageLink(hash: string): boolean {
	return messageIdFromHash(hash) !== null;
}

/** At a scroll event: did what is on screen move, other than by the library's
 *  own setter? `moves` are how far the top and bottom edges of the rows that
 *  were on screen at the last look have moved on screen since (the last look
 *  is taken again after every move of the library's setter, every resize and
 *  every scroll event). A scroll moves every edge by the same amount; scroll
 *  anchoring moves scrollTop and leaves the browser's anchor (a node in the
 *  first row on screen) where it was, so an edge of that row stays put, or its
 *  two edges move opposite ways, unless that row changed above and below the
 *  anchor at once. So it is the learner's only when every edge moved, all the
 *  same way (a misreading the other way only ends the rule early: the lesson
 *  then behaves as before). A lesson clamped at its very bottom (`atMax`:
 *  what is under it got shorter) is not a scroll of the learner's. */
export function viewMovedByOther(f: { moves: readonly number[]; atMax: boolean }): boolean {
	if (f.atMax || f.moves.length === 0) return false;
	return f.moves.every((m) => m > VIEW_MOVED_PX) || f.moves.every((m) => m < -VIEW_MOVED_PX);
}

const jumpListeners = new Set<() => void>();
/** A jump to a passage is starting (Find, a citation, "Show in the lesson",
 *  a link to a message): every open lesson stops being kept at rest. */
export function noteLessonJump(): void {
	for (const listener of [...jumpListeners]) listener();
}

/** The parts of use-stick-to-bottom's state this reads and writes. */
export interface StickStateLike {
	scrollTop: number;
	readonly calculatedTargetScrollTop: number;
	isAtBottom: boolean;
	animation?: unknown;
}

export interface RestOnOpenOptions {
	scroller: HTMLElement;
	content: Element;
	state: StickStateLike;
	/** use-stick-to-bottom's scrollToBottom("instant"): following again. */
	rearm: () => void;
	/** After a put-back (the check space notes the place, not as a move down). */
	onPutBack?: (top: number) => void;
	/** use-stick-to-bottom's stopScroll: the learner scrolled up. Called when a
	 *  scroll up of the learner's ends this, so that a re-arm still waiting for
	 *  its frame can't pull the lesson back (the library would have let go at
	 *  the wheel event, which may come late or not at all). */
	release?: () => void;
	/** Starts ended (the lesson opens on a link to a message). */
	ended?: boolean;
}

export interface RestOnOpen {
	/** Look now (also: a frame later while a slide is under way). */
	check(): void;
	/** Stop for good. */
	end(): void;
	readonly ended: boolean;
	dispose(): void;
}

export function installRestOnOpen(o: RestOnOpenOptions): RestOnOpen {
	const { scroller, content, state } = o;
	const doc = scroller.ownerDocument;
	const view = doc.defaultView;
	let ended = !!o.ended;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let frame = 0;
	const raf = (fn: () => void) => (view && typeof view.requestAnimationFrame === "function" ? view.requestAnimationFrame(fn) : (setTimeout(fn, 16) as unknown as number));
	const caf = (id: number) => { if (view && typeof view.cancelAnimationFrame === "function") view.cancelAnimationFrame(id); else clearTimeout(id); };

	const check = () => {
		if (ended) return;
		const step = restOnOpenStep({
			ended,
			sliding: !!state.animation,
			scrollable: scroller.scrollHeight > scroller.clientHeight,
			top: scroller.scrollTop,
			rest: state.calculatedTargetScrollTop,
			following: state.isAtBottom,
		});
		if (step === "wait") {
			if (!frame) frame = raf(() => { frame = 0; check(); });
			return;
		}
		if (step === "put-back") {
			const rest = state.calculatedTargetScrollTop;
			state.scrollTop = rest;
			o.onPutBack?.(scroller.scrollTop);
			o.rearm();
		} else if (step === "re-arm") {
			o.rearm();
		}
	};
	const schedule = () => {
		if (ended) return;
		clearTimeout(timer);
		timer = setTimeout(check, REST_CHECK_DELAY_MS);
	};
	/** The rows on screen at the last look, with where their edges sat. */
	let base: { row: Element; top: number; bottom: number }[] = [];
	const look = () => {
		const column = scroller.querySelector("[data-session-find-root]") ?? content;
		const rows = column.children;
		const box = scroller.getBoundingClientRect();
		let lo = 0, hi = rows.length - 1, first = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (rows[mid]!.getBoundingClientRect().bottom > box.top + 0.5) { first = mid; hi = mid - 1; } else lo = mid + 1;
		}
		base = [];
		for (let i = first; i >= 0 && i < rows.length && base.length < LOOK_ROWS; i++) {
			const r = rows[i]!.getBoundingClientRect();
			if (r.top >= box.bottom) break;
			base.push({ row: rows[i]!, top: r.top - box.top, bottom: r.bottom - box.top });
		}
	};
	/** The library's own setter (its slide, its clamp, the fork's backToRest and
	 *  this rule's put-back all go through it): look again right after it moves
	 *  the lesson, so its move is never taken for the learner's. The property is
	 *  given back as it was when this ends. */
	const own = Object.getOwnPropertyDescriptor(state, "scrollTop");
	if (own?.configurable && own.set && !ended) {
		Object.defineProperty(state, "scrollTop", {
			configurable: true,
			enumerable: own.enumerable,
			get: own.get,
			set(value: number) { own.set!.call(state, value); if (!ended) look(); },
		});
	}
	const onScroll = () => {
		if (ended) return;
		const kept = base.filter((b) => b.row.isConnected);
		if (kept.length > 0) {
			const boxTop = scroller.getBoundingClientRect().top;
			const moves: number[] = [];
			for (const b of kept) {
				const r = b.row.getBoundingClientRect();
				moves.push(r.top - boxTop - b.top, r.bottom - boxTop - b.bottom);
			}
			const moved = viewMovedByOther({
				moves,
				atMax: scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 1,
			});
			if (moved) {
				end();
				if (moves[0]! > 0) o.release?.();
				return;
			}
		}
		look();
		schedule();
	};
	const onResize = () => {
		if (ended) return;
		look();
		raf(schedule);
	};
	const ro = typeof ResizeObserver === "function" ? new ResizeObserver(onResize) : null;
	const stop = () => {
		clearTimeout(timer);
		if (frame) caf(frame);
		frame = 0;
		scroller.removeEventListener("scroll", onScroll);
		for (const type of REST_END_EVENTS) doc.removeEventListener(type, end, true);
		jumpListeners.delete(end);
		ro?.disconnect();
		if (own?.configurable && own.set) Object.defineProperty(state, "scrollTop", own);
	};
	function end() {
		ended = true;
		stop();
	}
	if (!ended) {
		look();
		scroller.addEventListener("scroll", onScroll, { passive: true });
		for (const type of REST_END_EVENTS) doc.addEventListener(type, end, { capture: true, passive: true });
		jumpListeners.add(end);
		ro?.observe(content);
		ro?.observe(scroller);
	}
	return {
		check: () => { if (!ended) schedule(); },
		end,
		get ended() { return ended; },
		dispose: stop,
	};
}
