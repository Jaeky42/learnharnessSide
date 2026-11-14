/**
 * A TAP ON THE FOLDED QUESTION GLIDES DOWN INTO IT (owner's iPhone, then the
 * owner's choice on a test page: stop Safari's glide, then one smooth pull
 * down, and the question opens as the lesson arrives). The real
 * use-stick-to-bottom hook and the real dock touch hook
 * (components/phone/use-dock-touch-scroll.ts), with chat.tsx's wiring copied
 * in (openDock, arriveAtBottom, suppressFoldDuringReveal, the fold machine,
 * the held tap), over a scripted lesson and frame clock.
 *
 * The scripted lesson plays the two motions Chromium can't show the way an
 * iPhone has them:
 *   - the browser's smooth scroll (scrollTo, behavior "smooth"): eased over
 *     SMOOTH_MS, cancelled by any other scroll the page makes;
 *   - Safari's own momentum after a flick: it moves the lesson every frame
 *     and wins over the page's own scrolling, until a touch on the lesson or
 *     a frame with its scrolling hidden (overflow-y: hidden) stops it.
 */

import React, { act, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
let touchScreen = true;
let reduceMotion = false;
let clock = 1000;
let rafQueue: { id: number; cb: FrameRequestCallback }[] = [];
let rafId = 0;
const requestAnimationFrame = (cb: FrameRequestCallback) => {
	rafQueue.push({ id: ++rafId, cb });
	return rafId;
};
const cancelAnimationFrame = (id: number) => {
	rafQueue = rafQueue.filter((r) => r.id !== id);
};
Object.assign(dom.window, {
	matchMedia: (query: string) => ({
		matches: query.includes("reduced-motion") ? reduceMotion : touchScreen && /max-width|coarse/.test(query),
		addEventListener() {},
		removeEventListener() {},
	}),
	requestAnimationFrame,
	cancelAnimationFrame,
});
Object.defineProperty(globalThis, "navigator", { configurable: true, get: () => ({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1" }) });
Object.defineProperty(performance, "now", { configurable: true, value: () => clock });
/** ResizeObserver: never fires by itself. `contentResized()` plays the one
 *  on use-stick-to-bottom's content (the spacer under a waiting check). */
type Observed = { cb: (entries: unknown[]) => void; targets: Element[] };
let observers: Observed[] = [];
class NoResize {
	o: Observed;
	constructor(cb: (entries: unknown[]) => void) {
		this.o = { cb, targets: [] };
		observers.push(this.o);
	}
	observe(t: Element) { this.o.targets.push(t); }
	disconnect() { observers = observers.filter((o) => o !== this.o); }
}
let contentEl: Element | null = null;
function contentResized(target: Element | null = contentEl) {
	for (const o of [...observers]) for (const t of o.targets) if (t === target) o.cb([{ contentRect: { height: t === contentEl ? scrollHeight : CLIENT_H }, target: t }]);
}
Object.assign(globalThis, {
	window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame, cancelAnimationFrame,
	ResizeObserver: NoResize,
	getComputedStyle: (el: HTMLElement) => {
		const overflow = el.getAttribute?.("data-overflow") ?? "visible";
		return { scrollBehavior: "auto", overflow, overflowY: overflow };
	},
});

const { useStickToBottom } = await import("use-stick-to-bottom");
const { useDockTouchScroll, keyScrollsLesson, GLIDE_RETRIES } = await import("../components/phone/use-dock-touch-scroll.ts");
const { backToRest, blankSpaceExtra, bottomTarget, checkOpensOnScroll, createCheckSpace, noteCheckPlace, offerCheckSpace, resetCheckSpace, restingTarget } = await import("../components/check-blank-space.ts");

// DockOverlay's thresholds (components/chat.tsx).
const COLLAPSE_DIST = 96;
const EXPAND_DIST = 16;
let CLIENT_H = 600; // a test may make the viewport taller
const SMOOTH_MS = 500;
const GRADIENT_H = 96;
// The scripted dock under a teach check (SCROLL INTO A CHECK): the block folded
// (the bar and the reading-thinking field), the open check as measured from its
// hidden form, and the open check as it really lays out (`openActual`).
const FOLDED_BLOCK = 130;
const OPEN_BLOCK = 430;
const COMPOSER_BLOCK = 112;
let openMeasured = OPEN_BLOCK;
let openActual = OPEN_BLOCK;
/** The lesson's text; under a teach check the scroller is the text plus the spacer. */
let textH = 0;
/** The spacer as laid out. With `deferSpacer` an offer only reaches it at
 *  commitSpacer() (React renders the reserve a moment after it is offered). */
let spacerDom = 0;
let deferSpacer = false;
let pendingSpacer: number | null = null;
function commitSpacer() {
	if (pendingSpacer === null) return;
	spacerDom = pendingSpacer;
	pendingSpacer = null;
	scrollHeight = textH + spacerDom;
	contentResized();
}
/** chat.tsx's resize and growth mutes, played only where a test asks (Date.now, as there). */
let mutes = false;

/** The lesson's scroller: a scripted box (see the top of this file). */
let scroller: HTMLElement;
let scrollHeight = 10000;
let top = 0;
let scrollPending = false;
let smooth: { from: number; to: number; t0: number } | null = null;
let momentum = 0; // px per frame, upwards
let smoothRefused = false; // a browser that gives up on its smooth scroll at once
let smoothShortBy = 0; // a browser whose next smooth scroll ends this far short of where it was aimed
let momentumOutlivesStop = false; // a hidden frame that didn't catch Safari's momentum
// Scroll anchoring in the next frame: messages above the screen change height
// by this much, and scrollTop moves with them. Chromium's smooth scroll keeps
// to its own course (measured at iPhone size with the off-screen rule), so the
// next frame puts scrollTop back on it; `anchorCarries` plays a browser whose
// smooth scroll moves with the shift instead.
let anchorNext = 0;
let anchorCarries = false;
// Frames after the shift before the smooth scroll puts scrollTop back on its
// course (Chromium: 0, or 1 after a long frame); meanwhile it moves on from the
// shifted place.
let anchorLag = 0;
let anchorLagLeft = 0;
let smoothCalls = 0;
function setTop(v: number) {
	const next = Math.max(0, Math.min(scrollHeight - CLIENT_H, v));
	if (next !== top) scrollPending = true;
	top = next;
}
function fakeScroller(el: HTMLElement) {
	scroller = el;
	Object.defineProperties(el, {
		scrollHeight: { configurable: true, get: () => scrollHeight },
		clientHeight: { configurable: true, get: () => CLIENT_H },
		scrollTop: {
			configurable: true,
			get: () => top,
			set: (v: number) => {
				smooth = null;
				if (momentum) return; // Safari ignores a page's scroll while it decelerates
				setTop(v);
			},
		},
		scrollTo: {
			configurable: true,
			value: ({ top: to, behavior }: { top: number; behavior?: string }) => {
				if (behavior === "smooth") {
					smoothCalls++;
					smooth = smoothRefused || momentum ? null : { from: top, to: to - smoothShortBy, t0: clock };
					smoothShortBy = 0;
					return;
				}
				smooth = null;
				if (!momentum) setTop(to);
			},
		},
	});
}
const distance = () => scrollHeight - CLIENT_H - top;

type Probe = {
	expanded: () => boolean;
	revealed: () => boolean;
	intent: () => boolean;
	atBottom: () => boolean;
	slides: number;
	options: number;
	revealNow: () => void;
	reserve: () => number;
	extra: () => number;
	stampGeometry: () => void;
	offerNow: () => void;
};
let probe: Probe;

/** chat.tsx's wiring around the dock, copied. `teach`: a teach check waiting
 *  behind its Open invitation (requiresReveal). */
function Harness({ teach = false, question = "q1" }: { teach?: boolean; question?: string | null }) {
	// SCROLL INTO A CHECK: chat.tsx sets the same function on the context's
	// targetScrollTop; the hook reads it through its first options either way.
	const stick = useStickToBottom({ initial: "instant", resize: "smooth", targetScrollTop: (target) => (blankSpaceRef.current ? restingTarget(target, checkSpaceRef.current.extra) : target) });
	const { scrollToBottom: libraryScrollToBottom, stopScroll, state: stickState, isAtBottom } = stick;
	const scrollToBottom = () => {
		probe.slides++;
		return libraryScrollToBottom();
	};
	const scrollToBottomRef = useRef(scrollToBottom);
	scrollToBottomRef.current = scrollToBottom;
	const blockRef = useRef<HTMLDivElement>(null);
	const [expanded, setExpanded] = useState(false);
	const [revealed, setRevealed] = useState(false);
	const revealPending = teach && !revealed;
	// SCROLL INTO A CHECK (chat.tsx's DockOverlay, copied): the blank space, the
	// resting point, and the arrival that opens it.
	const blankSpace = revealPending && !expanded && question !== null;
	const blankSpaceRef = useRef(blankSpace);
	blankSpaceRef.current = blankSpace;
	const checkSpaceRef = useRef(createCheckSpace());
	const pendingRef = useRef(question !== null);
	pendingRef.current = question !== null;
	const prevQuestionRef = useRef(question);
	if (question !== prevQuestionRef.current) {
		prevQuestionRef.current = question;
		resetCheckSpace(checkSpaceRef.current);
		if (question !== null) {
			setExpanded(false);
			setRevealed(false);
		}
	}
	const geometryAtRef = useRef(0);
	const reserveRef = useRef(0);
	const endCheckSpace = () => {
		blankSpaceRef.current = false;
		checkSpaceRef.current.extra = 0;
	};
	// chat.tsx's lookAtCheck: the rest from the spacer as laid out.
	const lookAtCheckRef = useRef<(settle: boolean) => void>(() => {});
	lookAtCheckRef.current = (settle) => {
		const el = stick.scrollRef.current, s = checkSpaceRef.current;
		if (!el || !blankSpaceRef.current || expandedRef.current) return;
		const rest = restingTarget(bottomTarget(el), blankSpaceExtra(spacerDom, FOLDED_BLOCK, GRADIENT_H));
		if (settle && backToRest(s, el.scrollTop, rest)) stick.state.scrollTop = rest;
		noteCheckPlace(s, el.scrollTop, el.scrollHeight - el.clientHeight - el.scrollTop, EXPAND_DIST, rest);
	};
	const noteCheckOffer = (extra: number | null) => {
		const s = checkSpaceRef.current;
		if (extra === null) { s.extra = 0; return; }
		offerCheckSpace(s, extra);
		lookAtCheckRef.current(true);
		requestAnimationFrame(() => lookAtCheckRef.current(true));
	};
	useEffect(() => {
		const el = stick.scrollRef.current;
		if (!el || !contentEl) return;
		const ro = new ResizeObserver(() => lookAtCheckRef.current(true));
		ro.observe(contentEl);
		ro.observe(el);
		return () => ro.disconnect();
	}, [stick.scrollRef]);
	/** chat.tsx's offer, over the scripted spacer: the scroller is the text plus
	 *  the reserve, and use-stick-to-bottom hears its content resize. */
	const offer = (blockH: number) => {
		const open = blankSpaceRef.current ? openMeasured : null;
		const next = Math.max(blockH, open ?? 0) + GRADIENT_H;
		noteCheckOffer(open === null ? null : blankSpaceExtra(Math.max(reserveRef.current, next), blockH, GRADIENT_H));
		if (next <= reserveRef.current + 0.5 && pendingRef.current) return;
		if (pendingRef.current && next > reserveRef.current + 1) geometryAtRef.current = Date.now();
		reserveRef.current = next;
		pendingSpacer = next;
		if (!deferSpacer) commitSpacer();
	};
	useLayoutEffect(() => {
		if (teach) offer(question === null ? COMPOSER_BLOCK : expanded ? openActual : FOLDED_BLOCK);
	});
	const expandedRef = useRef(expanded);
	expandedRef.current = expanded;
	const revealedRef = useRef(revealed);
	revealedRef.current = revealed;
	const atBottomRef = useRef(isAtBottom);
	atBottomRef.current = isAtBottom;
	const expandIntentRef = useRef(false);
	const intentTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
	const dockTouch = useDockTouchScroll(blockRef, stick.scrollRef, {
		onTouchStart: (hold) => {
			if (!stickState.animation && !expandIntentRef.current) return;
			stopScroll();
			clearTimeout(intentTimerRef.current);
			expandIntentRef.current = hold;
		},
		isSliding: () => !!stickState.animation || expandIntentRef.current,
		onTouchSettled: (tap) => {
			if (tap) {
				void suppressFoldDuringReveal();
				return;
			}
			expandIntentRef.current = false;
			const el = stick.scrollRef.current;
			if (el && expandedRef.current && !atBottomRef.current && el.scrollHeight - el.clientHeight - el.scrollTop > COLLAPSE_DIST) setExpanded(false);
		},
		onGlideEnd: (end) => {
			const reveal = openOnArrivalRef.current;
			if (end === "arrived" && !expandedRef.current) arriveAtBottomRef.current();
			openOnArrivalRef.current = false;
			if (end === "gave-up" && !expandedRef.current) openAtOnce(reveal);
		},
	});
	const suppressFoldDuringReveal = () => {
		expandIntentRef.current = true;
		clearTimeout(intentTimerRef.current);
		intentTimerRef.current = setTimeout(() => {
			expandIntentRef.current = false;
		}, 2000);
		return Promise.resolve(scrollToBottom()).finally(() => {
			clearTimeout(intentTimerRef.current);
			expandIntentRef.current = false;
		});
	};
	const openOnArrivalRef = useRef(false);
	const openAtOnce = (reveal: boolean) => {
		if (reveal) setRevealed(true);
		if (reveal) endCheckSpace();
		setExpanded(true);
		void suppressFoldDuringReveal();
	};
	const openDock = (reveal: boolean) => {
		if (!atBottomRef.current || (reveal && blankSpaceRef.current && checkSpaceRef.current.extra > 0)) {
			if (stickState.animation) stopScroll();
			if (dockTouch.glideToBottom()) {
				openOnArrivalRef.current = reveal;
				return;
			}
		}
		openAtOnce(reveal);
	};
	const arriveAtBottomRef = useRef<(intoCheck?: boolean) => void>(() => {});
	arriveAtBottomRef.current = (intoCheck = false) => {
		if (teach && !revealedRef.current) {
			if (!openOnArrivalRef.current && !intoCheck) return;
			setRevealed(true);
			endCheckSpace();
		}
		openOnArrivalRef.current = false;
		setExpanded(true);
		void scrollToBottomRef.current();
	};
	probe = {
		expanded: () => expandedRef.current,
		revealed: () => revealedRef.current,
		intent: () => expandIntentRef.current,
		atBottom: () => stickState.isAtBottom,
		slides: probe?.slides ?? 0,
		options: probe?.options ?? 0,
		revealNow: () => {
			setExpanded(true);
			void suppressFoldDuringReveal();
		},
		reserve: () => reserveRef.current,
		extra: () => checkSpaceRef.current.extra,
		stampGeometry: () => { geometryAtRef.current = Date.now(); },
		offerNow: () => offer(FOLDED_BLOCK),
	};
	useEffect(() => {
		const el = stick.scrollRef.current;
		if (!el) return;
		let recheck: ReturnType<typeof setTimeout> | undefined;
		const recheckAfterMutes = () => {
			clearTimeout(recheck);
			const wait = geometryAtRef.current + 400 - Date.now();
			recheck = setTimeout(() => {
				if (!pendingRef.current || !blankSpaceRef.current || expandedRef.current) return;
				if (Date.now() - geometryAtRef.current < 400) { recheckAfterMutes(); return; }
				const d = el.scrollHeight - el.clientHeight - el.scrollTop;
				if (checkOpensOnScroll(checkSpaceRef.current, d, EXPAND_DIST)) arriveAtBottomRef.current(true);
			}, Math.max(wait, 0) + 1);
		};
		const onScroll = () => {
			if (!pendingRef.current) return;
			const waiting = blankSpaceRef.current;
			if (waiting) lookAtCheckRef.current(false);
			const intoCheck = waiting && !expandedRef.current && checkOpensOnScroll(checkSpaceRef.current, el.scrollHeight - el.clientHeight - el.scrollTop, EXPAND_DIST);
			if (mutes && Date.now() - geometryAtRef.current < 400) { if (intoCheck) recheckAfterMutes(); return; }
			const d = el.scrollHeight - el.clientHeight - el.scrollTop;
			if (expandedRef.current) {
				if (d > COLLAPSE_DIST && !expandIntentRef.current && !atBottomRef.current) setExpanded(false);
			} else if (d < EXPAND_DIST) {
				arriveAtBottomRef.current(intoCheck);
			}
		};
		el.addEventListener("scroll", onScroll, { passive: true });
		return () => { el.removeEventListener("scroll", onScroll); clearTimeout(recheck); };
	}, [stick.scrollRef]);
	const stickContentRef = stick.contentRef;
	const contentRef = useCallback((el: HTMLDivElement | null) => {
		contentEl = el;
		stickContentRef(el);
	}, [stickContentRef]);
	const stickScrollRef = stick.scrollRef;
	const scrollRef = useCallback((el: HTMLDivElement | null) => {
		if (el) fakeScroller(el);
		stickScrollRef(el);
	}, [stickScrollRef]);
	return (
		<div>
			<div id="lesson" ref={scrollRef} data-overflow="auto">
				<div ref={contentRef} />
			</div>
			<div ref={blockRef} id="dock">
				<p id="pad">The dock around the question</p>
				{!expanded && (revealPending
					? <button id="open" type="button" onClick={() => openDock(true)}>Open</button>
					: <button id="bar" type="button" onClick={() => openDock(false)}>Answer</button>)}
				{expanded && (
					<div id="question">
						<p id="text">The question</p>
						<div id="box" contentEditable="true" suppressContentEditableWarning>thinking</div>
						<button id="option" type="button" onClick={() => probe.options++}>An option</button>
					</div>
				)}
			</div>
		</div>
	);
}

/** One frame: Safari's own motion (momentum, or the smooth scroll), the
 *  scroll event, then animation frames, then the library's 1 ms timeouts. */
async function frame() {
	await act(async () => {
		clock += 16;
		if (momentum && scroller.style.overflowY === "hidden" && !momentumOutlivesStop) momentum = 0;
		if (momentum) {
			setTop(top - momentum);
			momentum = momentum * 0.97 < 1 ? 0 : momentum * 0.97;
		} else if (smooth && anchorLagLeft > 0) {
			anchorLagLeft--;
			setTop(top + 50);
		} else if (smooth) {
			const p = Math.min(1, (clock - smooth.t0) / SMOOTH_MS);
			const e = 1 - (1 - p) ** 3;
			setTop(smooth.from + (smooth.to - smooth.from) * e);
			if (p >= 1) smooth = null;
		}
		if (anchorNext) {
			scrollHeight += anchorNext;
			top = Math.max(0, Math.min(scrollHeight - CLIENT_H, top + anchorNext));
			if (anchorCarries && smooth) {
				smooth.from += anchorNext;
				smooth.to += anchorNext;
			}
			anchorNext = 0;
			anchorLagLeft = anchorLag;
			scrollPending = true;
		}
		if (scrollPending) {
			scrollPending = false;
			scroller.dispatchEvent(new dom.window.Event("scroll"));
		}
		const due = rafQueue;
		rafQueue = [];
		for (const r of due) r.cb(clock);
		await new Promise((r) => setTimeout(r, 2));
	});
}
function touch(type: string, target: Element, y = 300, timeStamp = clock) {
	const e = new dom.window.Event(type, { bubbles: true, cancelable: true });
	Object.assign(e, { touches: type === "touchend" ? [] : [{ clientX: 100, clientY: y }] });
	Object.defineProperty(e, "timeStamp", { value: timeStamp });
	// A touch on the lesson itself stops its momentum, as on an iPhone.
	if (type === "touchstart" && target === scroller) momentum = 0;
	target.dispatchEvent(e);
	return e;
}
const $ = (id: string) => dom.document.getElementById(id)!;

let root: Root | null = null;
async function mount({ teach = false, from = 4000 }: { teach?: boolean; from?: number } = {}) {
	probe = { expanded: () => false, revealed: () => false, intent: () => false, atBottom: () => false, slides: 0, options: 0, revealNow: () => {}, reserve: () => 0, extra: () => 0, stampGeometry: () => {}, offerNow: () => {} };
	scrollHeight = 10000;
	// Under a teach check the lesson is its text plus the open check's blank space.
	textH = 10000 - OPEN_BLOCK - GRADIENT_H;
	openMeasured = OPEN_BLOCK;
	openActual = OPEN_BLOCK;
	top = 0;
	smooth = null;
	momentum = 0;
	smoothRefused = false;
	smoothShortBy = 0;
	momentumOutlivesStop = false;
	anchorNext = 0;
	anchorCarries = false;
	anchorLag = 0;
	anchorLagLeft = 0;
	smoothCalls = 0;
	rafQueue = [];
	const host = dom.document.createElement("div");
	dom.document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root!.render(<Harness teach={teach} />));
	// The lesson starts at its bottom (a waiting teach check: at the end of its
	// text, as use-stick-to-bottom puts it); the learner has scrolled up from
	// there (use-stick-to-bottom takes the scroll up as leaving the bottom).
	await act(async () => {
		scroller.scrollTop = teach ? scrollHeight - 1 - CLIENT_H - (spacerDom - FOLDED_BLOCK - GRADIENT_H) : scrollHeight;
	});
	await frame();
	await act(async () => {
		scroller.scrollTop = scrollHeight - CLIENT_H - from + 30;
	});
	await frame();
	await act(async () => {
		scroller.scrollTop = scrollHeight - CLIENT_H - from;
	});
	// At rest: no scroll in the last 100 ms (a tap then isn't replayed).
	for (let i = 0; i < 10; i++) await frame();
	assert.equal(probe.expanded(), false);
	probe.slides = 0;
}
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	dom.document.body.innerHTML = "";
	touchScreen = true;
	reduceMotion = false;
	mutes = false;
	CLIENT_H = 600;
	spacerDom = 0;
	deferSpacer = false;
	pendingSpacer = null;
	observers = [];
	contentEl = null;
});

/** A tap: touchstart, touchend, then Safari's own click (unless the touchend
 *  cancelled it: a replayed tap). */
async function tapOn(id: string, ms = 60) {
	const el = $(id);
	await act(async () => {
		touch("touchstart", el);
	});
	// A finger's tap lasts a few frames.
	for (let t = 16; t < ms; t += 16) await frame();
	await act(async () => {
		const end = touch("touchend", el, 300, clock);
		if (!end.defaultPrevented) (el as HTMLElement).click();
	});
}

/** Run frames; returns, per frame, the distance to the bottom and whether the
 *  question was open. */
async function run(frames: number) {
	const out: { d: number; open: boolean }[] = [];
	for (let i = 0; i < frames; i++) {
		await frame();
		out.push({ d: distance(), open: probe.expanded() });
	}
	return out;
}
/** The frames until the lesson first came within the fold machine's reach of the bottom. */
const beforeArrival = (frames: { d: number; open: boolean }[]) => frames.slice(0, frames.findIndex((f) => f.d < EXPAND_DIST));
const neverUp = (frames: { d: number }[]) => frames.every((f, i) => i === 0 || f.d <= frames[i - 1]!.d);
/** The lesson's place per frame (scrollTop), from the run's frames. */
const places = (frames: { d: number }[]) => frames.map((f) => scrollHeight - CLIENT_H - f.d);
/** The longest run of frames in which the lesson didn't move, between its
 *  first movement and its arrival. */
function longestRest(frames: { d: number }[]) {
	const at = places(frames);
	const first = at.findIndex((y, i) => i > 0 && y !== at[i - 1]);
	const arrive = frames.findIndex((f) => f.d < EXPAND_DIST);
	let best = 0;
	let run = 0;
	for (let i = Math.max(1, first); i < (arrive < 0 ? at.length : arrive); i++) {
		run = at[i] === at[i - 1] ? run + 1 : 0;
		best = Math.max(best, run);
	}
	return best;
}

describe("a tap on the folded question glides down into it (touch screen)", () => {
	it("at rest far up: one glide, folded on the way, open on arrival, and use-stick-to-bottom follows from there", async () => {
		await mount();
		await tapOn("bar");
		assert.equal(probe.expanded(), false, "not opened at the tap");
		const frames = await run(80);
		const way = beforeArrival(frames);
		assert.ok(way.length > 5, "it glided");
		assert.ok(way.every((f) => !f.open), "folded all the way down");
		assert.ok(neverUp(frames), "one motion, only down");
		assert.equal(probe.expanded(), true, "open at the bottom");
		assert.ok(distance() <= 2, `at the bottom (${distance()} px)`);
		assert.equal(smoothCalls, 1, "one glide");
		assert.equal(probe.atBottom(), true, "counts as at the bottom: a new reply is followed");
	});

	it("while Safari's momentum still carries the lesson up: the touch stops it, then the glide goes down", async () => {
		await mount({ from: 3000 });
		momentum = 40;
		await run(3);
		const upBefore = distance();
		await tapOn("bar");
		const frames = await run(80);
		assert.ok(frames[0]!.d <= upBefore + 1, "stopped at once: no more motion up");
		assert.ok(neverUp(frames), "no fight between the momentum and the glide");
		assert.equal(momentum, 0);
		assert.ok(beforeArrival(frames).every((f) => !f.open));
		assert.equal(probe.expanded(), true);
		assert.ok(distance() <= 2);
		assert.equal(smoothCalls, 1);
	});

	it("a tap whose touchstart and touchend land in one frame, during the momentum: the stop still gets its frame, then the glide", async () => {
		await mount({ from: 3000 });
		scroller.style.overflowY = "auto"; // use-stick-to-bottom's own inline value
		momentum = 40;
		await run(3);
		await act(async () => {
			touch("touchstart", $("bar"));
			const end = touch("touchend", $("bar"), 300, clock + 8);
			if (!end.defaultPrevented) ($("bar") as HTMLButtonElement).click();
		});
		const frames = await run(80);
		assert.equal(momentum, 0, "the hidden frame stopped it");
		assert.ok(neverUp(frames), "no fight");
		assert.equal(scroller.style.overflowY, "auto", "the scrolling is back, as it was");
		assert.equal(probe.expanded(), true);
		assert.ok(distance() <= 2);
		assert.equal(smoothCalls, 1);
	});

	it("while the dock's own throw runs: it is stopped, and the glide goes down", async () => {
		await mount();
		// A flick down on the bar: the lesson thrown up.
		await act(async () => {
			touch("touchstart", $("bar"), 300, clock);
			touch("touchmove", $("bar"), 330, clock + 10);
			touch("touchmove", $("bar"), 360, clock + 20);
			touch("touchend", $("bar"), 360, clock + 21);
		});
		await run(3);
		await tapOn("bar");
		const frames = await run(80);
		assert.ok(neverUp(frames), "the throw doesn't pull it back up");
		assert.equal(probe.expanded(), true);
		assert.ok(distance() <= 2);
	});

	it("already at the bottom: the tap opens it at once, as before", async () => {
		await mount();
		// Back down by hand to 40 px from the bottom: within use-stick-to-bottom's
		// "near the bottom", short of the fold machine's re-open.
		await act(async () => {
			scroller.scrollTop = scrollHeight - CLIENT_H - 40;
		});
		await run(10);
		assert.equal(probe.expanded(), false);
		await tapOn("bar");
		assert.equal(probe.expanded(), true);
		assert.equal(smoothCalls, 0, "no glide");
	});

	it("a touch on the lesson during the glide stops it there, and nothing pulls it back", async () => {
		await mount();
		await tapOn("bar");
		await run(6);
		await act(async () => {
			touch("touchstart", $("lesson"));
		});
		const stoppedAt = distance();
		assert.ok(stoppedAt > COLLAPSE_DIST);
		await act(async () => {
			touch("touchend", $("lesson"));
		});
		await run(60);
		assert.ok(Math.abs(distance() - stoppedAt) <= 1, `left where it stopped (${stoppedAt} → ${distance()})`);
		assert.equal(probe.expanded(), false);
		assert.equal(smoothCalls, 1);
	});

	it("a touch on the dock during the glide stops it there too", async () => {
		await mount();
		await tapOn("bar");
		await run(6);
		await act(async () => {
			touch("touchstart", $("pad"));
		});
		await run(1);
		const stoppedAt = distance();
		await act(async () => {
			clock += 300;
			touch("touchend", $("pad"), 300, clock);
		});
		await run(60);
		assert.ok(stoppedAt > COLLAPSE_DIST);
		assert.ok(Math.abs(distance() - stoppedAt) <= 1, `left where it stopped (${stoppedAt} → ${distance()})`);
		assert.equal(probe.expanded(), false);
		assert.equal(smoothCalls, 1);
	});

	it("a wheel, a mouse press on the lesson or a scrolling key during the glide: nothing pulls the lesson back", async () => {
		for (const input of ["wheel", "mouse", "key"] as const) {
			await mount();
			await tapOn("bar");
			await run(6);
			await act(async () => {
				if (input === "wheel") {
					$("lesson").dispatchEvent(new dom.window.Event("wheel", { bubbles: true }));
					// The wheel's own step up. A browser's smooth scroll runs on under
					// a wheel (headless Chrome: the lesson still ended at the bottom).
					setTop(top - 300);
				}
				if (input === "mouse") {
					// A press that doesn't scroll by itself.
					const e = new dom.window.Event("pointerdown", { bubbles: true });
					Object.assign(e, { pointerType: "mouse" });
					$("lesson").dispatchEvent(e);
				}
				if (input === "key") {
					const e = new dom.window.Event("keydown", { bubbles: true });
					Object.assign(e, { key: "PageUp" });
					dom.document.body.dispatchEvent(e);
					// The key's own scroll, which cancels a smooth scroll in Chrome.
					scroller.scrollTop = top - 500;
				}
			});
			await run(4);
			const at = distance();
			await run(60);
			assert.ok(at > COLLAPSE_DIST && Math.abs(distance() - at) <= 1, `${input}: left where the learner put it (${at} → ${distance()})`);
			assert.equal(smoothCalls, 1, `${input}: no glide again`);
			assert.equal(probe.expanded(), false, input);
			await act(async () => root?.unmount());
			root = null;
			dom.document.body.innerHTML = "";
		}
	});

	it("the lesson grows under the glide in flight (a demo sizing itself): once the glide has slowed it is aimed at the new bottom and goes on, no rest, no retry", async () => {
		await mount();
		await tapOn("bar");
		const early = await run(5);
		scrollHeight += 1500;
		const frames = [...early, ...(await run(120))];
		assert.equal(smoothCalls, 2, "aimed once more, in flight");
		assert.ok(longestRest(frames) <= 1, `never at rest on the way (${longestRest(frames)} still frames)`);
		assert.equal(probe.expanded(), true);
		assert.ok(distance() <= 2);
		assert.ok(beforeArrival(frames).every((f) => !f.open));
	});

	it("a fast glide whose bottom moved is not aimed again until it has slowed: never a brake from full speed", async () => {
		const { GLIDE_RETARGET_SLOW } = await import("../components/phone/use-dock-touch-scroll.ts");
		await mount();
		await tapOn("bar");
		await run(5);
		scrollHeight += 1500;
		let speedAtAim: number | null = null;
		let last = top;
		for (let i = 0; i < 120 && speedAtAim === null; i++) {
			const calls = smoothCalls;
			await frame();
			const speed = Math.abs(top - last) / 16;
			last = top;
			if (smoothCalls > calls) speedAtAim = speed;
		}
		assert.ok(speedAtAim !== null, "aimed again in the end");
		assert.ok(speedAtAim! < GLIDE_RETARGET_SLOW * 2, `only once slow (${speedAtAim!.toFixed(2)} px/ms at the re-aim)`);
		await run(120);
		assert.equal(probe.expanded(), true);
		assert.ok(distance() <= 2);
	});

	it("a glide that ends short and rests (the browser stopped it): the retry rule glides once more, as before", async () => {
		await mount();
		smoothShortBy = 2000;
		await tapOn("bar");
		const frames = await run(150);
		assert.equal(smoothCalls, 2, "one retry");
		assert.ok(longestRest(frames) >= 8, "after it had rested");
		assert.equal(probe.expanded(), true);
		assert.ok(distance() <= 2);
	});

	it("a lesson growing every frame under a slow glide: re-aimed at most every 100 ms", async () => {
		await mount({ from: 300 });
		await tapOn("bar");
		// Let the short glide slow down, with its bottom kept just out of reach.
		const before = smoothCalls;
		const times: number[] = [];
		for (let i = 0; i < 60; i++) {
			scrollHeight += 6;
			const calls = smoothCalls;
			await frame();
			if (smoothCalls > calls) times.push(clock);
		}
		const aims = smoothCalls - before;
		assert.ok(aims >= 2, `re-aimed (${aims} times)`);
		assert.ok(times.every((at, i) => i === 0 || at - times[i - 1]! >= 100), `never twice within 100 ms (${times.map((at) => at - times[0]!).join(", ")})`);
	});

	it("a browser that won't glide, with nobody touching: a couple more tries, never one per frame, then the net opens the question where it is and slides it down, as a computer does", async () => {
		await mount();
		smoothRefused = true;
		await tapOn("bar");
		const frames = await run(200);
		assert.equal(smoothCalls, 1 + GLIDE_RETRIES);
		const opened = frames.findIndex((f) => f.open);
		assert.ok(opened > 0, "opened by the net, not at the tap");
		assert.ok(frames[opened - 1]!.d >= 3999, `where the lesson was (${frames[opened - 1]!.d} px up)`);
		assert.equal(probe.expanded(), true);
		assert.ok(probe.slides >= 1, "use-stick-to-bottom's slide");
		assert.ok(distance() <= 2, `at the bottom (${distance()} px)`);
	});

	it("the net for a teach check: revealed, as its Open asked", async () => {
		await mount({ teach: true });
		smoothRefused = true;
		await tapOn("open");
		await run(200);
		assert.equal(probe.revealed(), true);
		assert.equal(probe.expanded(), true);
		assert.ok(distance() <= 2);
	});

	it("Safari's momentum outlives the stop: the glide waits it out and goes down then, not read as the learner's", async () => {
		await mount({ from: 3000 });
		momentum = 30;
		momentumOutlivesStop = true;
		await run(3);
		await tapOn("bar");
		const frames = await run(300);
		assert.equal(momentum, 0, "it died by itself");
		assert.equal(probe.expanded(), true, "open in the end");
		assert.ok(distance() <= 2);
		assert.ok(smoothCalls >= 2, "glided again once the momentum had died");
		const opened = frames.findIndex((f) => f.open);
		assert.ok(frames[opened]!.d < EXPAND_DIST, "and opened on arrival, not by the net");
	});

	it("something else moves the lesson back up during the glide (\"Show in the lesson\", the status bar): the glide ends there, folded, and doesn't come back", async () => {
		await mount();
		await tapOn("bar");
		await run(8);
		// A scroll this hook can't see: scrollIntoView, iOS's tap on the status bar.
		await act(async () => {
			scroller.scrollTop = top - 800;
		});
		await run(4);
		const at = distance();
		await run(80);
		assert.ok(at > COLLAPSE_DIST && Math.abs(distance() - at) <= 1, `left where it was put (${at} → ${distance()})`);
		assert.equal(smoothCalls, 1, "no glide back down");
		assert.equal(probe.expanded(), false, "folded, as after a learner's stop");
	});

	it("messages above the screen take their real height under the glide (scroll anchoring, the off-screen rule): the glide carries on, and the question opens on arrival", async () => {
		// Chromium at iPhone size: +1,114 and +4,147 px (scrollTop up with them, then
		// back on the smooth scroll's course a frame later), and a message that
		// came out shorter; the same with the smooth scroll back on its course
		// only the second frame after (rule off, a demo sizing itself, after a
		// 33 ms frame); and with a smooth scroll that moves with the shift.
		for (const [carries, lag] of [[false, 0], [false, 1], [true, 0]] as const) {
			for (const shifts of [[1114], [4147, 1114], [-600], [1114, -600]]) {
				const label = `${shifts.join(", ")} px${carries ? ", the smooth scroll moving with them" : lag ? `, back on course ${lag + 1} frames later` : ""}`;
				await mount();
				anchorCarries = carries;
				anchorLag = lag;
				await tapOn("bar");
				const frames = await run(4);
				for (const shift of shifts) {
					anchorNext = shift;
					frames.push(...(await run(3)));
				}
				frames.push(...(await run(200)));
				assert.equal(probe.expanded(), true, `${label}: open in the end`);
				assert.ok(distance() <= 2, `${label}: at the bottom (${distance()} px)`);
				assert.ok(beforeArrival(frames).every((f) => !f.open), `${label}: folded on the way, opened on arrival`);
				assert.ok(longestRest(frames) <= 1, `${label}: never at rest on the way (${longestRest(frames)} still frames)`);
				// The lesson growing above the screen moves its bottom away from where
				// a smooth scroll that keeps its course was aimed: one re-aim, in flight.
				const grew = shifts.some((x) => x > 0);
				assert.equal(smoothCalls, grew && !carries ? 2 : 1, `${label}: ${smoothCalls} smooth scrolls, no retry`);
				await act(async () => root?.unmount());
				root = null;
				dom.document.body.innerHTML = "";
			}
		}
	});

	it("a real scroll back up under the glide still ends it, also when the lesson's height changes in the same frame", async () => {
		// [the scroll up, the height's change in the same frame]
		for (const [up, height] of [[800, 500], [800, -300], [800, 0]] as const) {
			await mount();
			await tapOn("bar");
			await run(8);
			await act(async () => {
				scrollHeight += height;
				scroller.scrollTop = top - up;
			});
			await run(4);
			const at = distance();
			await run(80);
			assert.ok(at > COLLAPSE_DIST && Math.abs(distance() - at) <= 1, `${up} up, height ${height}: left where it was put (${at} → ${distance()})`);
			assert.equal(smoothCalls, 1, `${up} up, height ${height}: no glide back down`);
			assert.equal(probe.expanded(), false, `${up} up, height ${height}: folded`);
			await act(async () => root?.unmount());
			root = null;
			dom.document.body.innerHTML = "";
		}
	});

	it("a real scroll back up right after the browser's own shift, smaller than it: the lesson stops dead, and that still ends the glide", async () => {
		await mount({ from: 8000 });
		await tapOn("bar");
		await run(6);
		anchorNext = 4000;
		await run(1);
		// "Show in the lesson" a frame later: an instant scroll, which also
		// cancels the smooth scroll.
		await act(async () => {
			scroller.scrollTop = top - 3000;
		});
		await run(4);
		const at = distance();
		await run(80);
		assert.ok(at > COLLAPSE_DIST && Math.abs(distance() - at) <= 1, `left where it was put (${at} → ${distance()})`);
		assert.equal(smoothCalls, 1, "no glide back down");
		assert.equal(probe.expanded(), false, "folded");
	});

	it("with reduced motion it jumps, and opens", async () => {
		reduceMotion = true;
		await mount();
		await tapOn("bar");
		await run(3);
		assert.equal(smoothCalls, 0);
		assert.ok(distance() <= 2);
		assert.equal(probe.expanded(), true);
	});

	it("a teach check's Open away from the bottom: the invitation stays while gliding, and the check opens on arrival", async () => {
		await mount({ teach: true });
		await tapOn("open");
		assert.ok($("open"), "the invitation is still there");
		assert.equal(probe.revealed(), false);
		const frames = await run(80);
		assert.ok(beforeArrival(frames).every((f) => !f.open));
		assert.equal(probe.revealed(), true);
		assert.equal(probe.expanded(), true);
		assert.ok(distance() <= 2);
	});

	it("a teach check's glide stopped by the learner: the invitation stays, and scrolling on down to the bottom by hand opens it then (SCROLL INTO A CHECK)", async () => {
		await mount({ teach: true });
		await tapOn("open");
		await run(6);
		await act(async () => {
			touch("touchstart", $("lesson"));
			touch("touchend", $("lesson"));
		});
		await run(20);
		assert.equal(probe.revealed(), false, "stopped: still waiting");
		assert.equal(probe.expanded(), false);
		assert.ok($("open"));
		await act(async () => {
			scroller.scrollTop = scrollHeight;
		});
		await run(20);
		assert.equal(probe.revealed(), true, "the learner scrolled into it");
		assert.equal(probe.expanded(), true);
	});

	it("on a computer: the click opens at once and slides, as before", async () => {
		touchScreen = false;
		await mount();
		await act(async () => {
			($("bar") as HTMLButtonElement).click();
		});
		assert.equal(probe.expanded(), true);
		await run(200);
		assert.equal(smoothCalls, 0);
		assert.equal(probe.slides, 1);
		assert.ok(distance() <= 2);
	});
});

describe("a tap on an open question while the lesson slides to the bottom (owner: \"this change is fine\")", () => {
	/** An open question under use-stick-to-bottom's slide (one that opens at
	 *  the bottom, a reply followed): far up, so there is a slide to touch. */
	async function sliding() {
		await mount();
		await act(async () => probe.revealNow());
		await run(4);
		assert.ok(distance() > COLLAPSE_DIST, "still sliding");
	}

	it("a tap on its thinking box takes the reveal up again: it stays open and ends at the bottom", async () => {
		await sliding();
		await tapOn("box", 40);
		assert.ok($("box"));
		const frames = await run(300);
		assert.ok(frames.every((f) => f.open), "never folded");
		assert.ok(distance() <= 2, `at the bottom (${distance()} px)`);
	});

	it("a drag from the same place lets go and folds, as before", async () => {
		await sliding();
		const stoppedAt = distance();
		const box = $("box");
		await act(async () => {
			touch("touchstart", box, 300);
		});
		await act(async () => {
			touch("touchmove", box, 320, clock + 16);
		});
		assert.equal(probe.expanded(), false);
		await act(async () => {
			touch("touchend", box, 320, clock + 60);
		});
		await run(60);
		assert.ok(distance() >= stoppedAt - 40);
	});

	it("a tap on an option is pressed once, and the reveal is taken up again", async () => {
		await sliding();
		await tapOn("option", 40);
		assert.equal(probe.options, 1);
		assert.ok((await run(300)).every((f) => f.open));
		assert.ok(distance() <= 2);
	});

	it("a tap on the lesson stops the slide, and that is that", async () => {
		await sliding();
		const stoppedAt = distance();
		await act(async () => {
			touch("touchstart", $("lesson"));
			clock += 40;
			touch("touchend", $("lesson"));
		});
		await run(100);
		assert.ok(distance() >= stoppedAt - 40, `stopped where it was (${stoppedAt} → ${distance()})`);
	});
});

describe("which keys stop a glide", () => {
	it("scrolling keys on the page or in the lesson, never in a text box or Space on a button", async () => {
		await mount();
		const doc = dom.document as unknown as Document;
		const lesson = $("lesson");
		const inLesson = dom.document.createElement("p");
		const button = dom.document.createElement("button");
		const box = dom.document.createElement("textarea");
		lesson.append(inLesson, button, box);
		assert.equal(keyScrollsLesson("PageUp", doc.body, lesson, doc), true);
		assert.equal(keyScrollsLesson("ArrowDown", inLesson, lesson, doc), true);
		assert.equal(keyScrollsLesson(" ", doc.body, lesson, doc), true);
		assert.equal(keyScrollsLesson(" ", button, lesson, doc), false, "Space presses the button");
		assert.equal(keyScrollsLesson("ArrowUp", button, lesson, doc), true);
		assert.equal(keyScrollsLesson("PageUp", box, lesson, doc), false, "a text box keeps its keys");
		assert.equal(keyScrollsLesson("PageUp", $("pad"), lesson, doc), false, "outside the lesson (the dock)");
		assert.equal(keyScrollsLesson("a", doc.body, lesson, doc), false);
	});
});

describe("scroll into a check: a waiting check has its blank space, rests at the end of the text, and opens when the learner scrolls into it", () => {
	const EXTRA = OPEN_BLOCK - FOLDED_BLOCK;
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
	/** A fresh page: use-stick-to-bottom places the lesson by itself. */
	async function mountRest({ question = "q1" as string | null, text = 10000 - OPEN_BLOCK - GRADIENT_H } = {}) {
		probe = { expanded: () => false, revealed: () => false, intent: () => false, atBottom: () => false, slides: 0, options: 0, revealNow: () => {}, reserve: () => 0, extra: () => 0, stampGeometry: () => {}, offerNow: () => {} };
		textH = text;
		scrollHeight = text;
		openMeasured = OPEN_BLOCK;
		openActual = OPEN_BLOCK;
		top = 0;
		smooth = null;
		momentum = 0;
		smoothRefused = false;
		smoothShortBy = 0;
		momentumOutlivesStop = false;
		anchorNext = 0;
		anchorCarries = false;
		anchorLag = 0;
		anchorLagLeft = 0;
		smoothCalls = 0;
		rafQueue = [];
		const host = dom.document.createElement("div");
		dom.document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => root!.render(<Harness teach question={question} />));
		await run(40);
	}
	/** The learner's own scroll down, `step` px a frame, until the bottom. */
	async function scrollDown(step = 30, untilD = 0) {
		const frames: { d: number; open: boolean; reserve: number }[] = [];
		for (let i = 0; i < 400 && distance() > untilD; i++) {
			await act(async () => {
				scroller.scrollTop = top + step;
			});
			await frame();
			frames.push({ d: distance(), open: probe.expanded(), reserve: probe.reserve() });
		}
		return frames;
	}
	/** The end of the text: the bar right under the last line (use-stick-to-bottom's target is 1 px short of the bottom). */
	const textEnd = () => scrollHeight - 1 - CLIENT_H - EXTRA;

	it("on load: folded behind Open, with the open check's blank space already under it, the lesson resting at the end of the text", async () => {
		await mountRest();
		assert.equal(probe.expanded(), false);
		assert.equal(probe.revealed(), false);
		assert.equal(probe.reserve(), OPEN_BLOCK + GRADIENT_H, "the reserve is the open check's");
		assert.equal(probe.extra(), EXTRA);
		assert.ok(Math.abs(top - textEnd()) <= 1, `resting at the end of the text (${top} vs ${textEnd()})`);
		assert.equal(probe.atBottom(), true, "counts as at the bottom: no jump-to-bottom disc");
		const frames = await run(120);
		assert.ok(frames.every((f) => !f.open), "never opens by itself");
		assert.ok(Math.abs(top - textEnd()) <= 1);
	});

	it("a check arriving while the lesson follows the teacher: it rests at the end of the text, folded", async () => {
		await mountRest({ question: null });
		const followed = distance();
		assert.ok(followed <= 2, "following at the bottom");
		await act(async () => root!.render(<Harness teach question="q2" />));
		const frames = await run(120);
		assert.ok(frames.every((f) => !f.open), "folded all the while");
		assert.equal(probe.reserve(), OPEN_BLOCK + GRADIENT_H);
		assert.ok(Math.abs(top - textEnd()) <= 1, `at the end of the text (${top} vs ${textEnd()})`);
		assert.ok(frames.every((f) => f.d >= EXTRA - 2), "never into the blank space");
	});

	it("scrolling down through the blank space opens and reveals it on arrival, with no change of the reserve, and it stays open", async () => {
		await mountRest();
		const reserve = probe.reserve();
		const frames = await scrollDown(30);
		const opened = frames.findIndex((f) => f.open);
		assert.ok(opened >= 0, "opened");
		assert.ok(frames[opened]!.d < EXPAND_DIST, `on arrival (${frames[opened]!.d} px)`);
		assert.ok(frames.slice(0, opened).every((f) => !f.open), "folded on the way");
		assert.equal(probe.revealed(), true, "counts as opened");
		const after = await run(150);
		assert.ok(after.every((f) => f.open), "never folds again");
		assert.equal(probe.reserve(), reserve, "the reserve didn't change at the open");
		assert.ok(distance() <= 2);
		// Then it is a question like any other: scrolling up folds it, back down opens it.
		for (let i = 0; i < 8; i++) {
			await act(async () => {
				scroller.scrollTop = top - 50;
			});
			await frame();
		}
		assert.equal(probe.expanded(), false, "folded by scrolling up");
		await scrollDown(40);
		await run(5);
		assert.equal(probe.expanded(), true, "open again at the bottom");
	});

	it("an open check 40 px taller than measured: the reserve grows by that and slides; it never folds", async () => {
		await mountRest();
		openActual = OPEN_BLOCK + 40;
		await scrollDown(30);
		const after = await run(200);
		assert.ok(after.every((f) => f.open), "never folds");
		assert.equal(probe.reserve(), OPEN_BLOCK + 40 + GRADIENT_H);
		assert.ok(distance() <= 2, `at the bottom (${distance()} px)`);
	});

	it("the finger still on the screen when it arrives (one long slow swipe that ends at the bottom): it opens and stays open", async () => {
		await mountRest();
		await act(async () => {
			touch("touchstart", $("lesson"), 500);
		});
		const frames = await scrollDown(8);
		assert.ok(frames.some((f) => f.open), "opened on arrival");
		// The finger rests, wobbles a little, then lifts.
		const held = await run(30);
		await act(async () => {
			scroller.scrollTop = top - 4;
		});
		held.push(...(await run(10)));
		await act(async () => {
			touch("touchend", $("lesson"), 500);
		});
		held.push(...(await run(60)));
		assert.ok(held.every((f) => f.open), "never closed again");
		assert.equal(probe.reserve(), OPEN_BLOCK + GRADIENT_H);
	});

	it("never opens with no input, also once the mutes are over and when its form grows while it waits", async () => {
		mutes = true;
		await mountRest();
		await sleep(450);
		let frames = await run(40);
		openMeasured = OPEN_BLOCK + 60; // late math: the form taller
		await act(async () => root!.render(<Harness teach question="q1" />));
		frames = [...frames, ...(await run(40))];
		await sleep(450);
		frames = [...frames, ...(await run(40))];
		assert.ok(frames.every((f) => !f.open));
		assert.equal(probe.revealed(), false);
		assert.equal(probe.reserve(), OPEN_BLOCK + 60 + GRADIENT_H, "the blank space followed the form");
		assert.ok(Math.abs(distance() - (EXTRA + 60) - 1) <= 1, `still at the end of the text (${distance()} px from the bottom)`);
	});

	it("messages under a resting lesson drawn shorter than estimated (the off-screen rule): back to the end of the text, not into the blank space", async () => {
		await mountRest();
		await act(async () => {
			textH -= 400;
			scrollHeight -= 400;
			setTop(top); // the browser keeps scrollTop where it can
			contentResized();
		});
		const frames = await run(30);
		assert.ok(Math.abs(top - textEnd()) <= 1, `at the end of the text (${top} vs ${textEnd()})`);
		assert.ok(frames.every((f) => !f.open));
		assert.equal(probe.atBottom(), true, "still following");
		// Scroll anchoring with it (Chromium at iPhone size, on load): a message
		// above grows by 545 px and scrollTop moves with it, the ones below come
		// out 332 px shorter.
		await act(async () => {
			textH += 213;
			scrollHeight += 213;
			setTop(top + 545);
			contentResized();
		});
		const anchored = await run(30);
		assert.ok(Math.abs(top - textEnd()) <= 1, `anchoring: at the end of the text (${top} vs ${textEnd()})`);
		assert.ok(anchored.every((f) => !f.open));
		// A learner who has scrolled into the blank space is left there.
		await scrollDown(30, 150);
		const at = top;
		await act(async () => {
			textH -= 100;
			scrollHeight -= 100;
			setTop(top);
			contentResized();
		});
		await run(10);
		assert.equal(top, Math.min(at, scrollHeight - CLIENT_H), "not pulled back up");
		assert.equal(probe.expanded(), false);
	});

	/** Where the end of the text puts the lesson, from the spacer as laid out. */
	const restNow = () => scrollHeight - 1 - CLIENT_H - (spacerDom - FOLDED_BLOCK - GRADIENT_H);
	/** The viewport 300 px taller, in the browser's order (Chromium at iPhone
	 *  size): the window's resize event offers the reserve (the open check's cap
	 *  rose with the column: +222) before React has rendered it, the frame's
	 *  animation frames, the scroller's ResizeObserver, then the spacer. */
	async function taller() {
		deferSpacer = true;
		await act(async () => {
			CLIENT_H += 300;
			openMeasured += 222;
			setTop(top);
			probe.offerNow();
		});
		await frame();
		await act(async () => contentResized(scroller));
		await act(async () => commitSpacer());
		deferSpacer = false;
		return run(30);
	}

	it("the viewport 300 px taller while it rests: back at the end of the text, folded", async () => {
		await mountRest();
		assert.ok(Math.abs(top - restNow()) <= 1);
		const frames = await taller();
		assert.equal(spacerDom, OPEN_BLOCK + 222 + GRADIENT_H, "the blank space followed the taller cap");
		assert.ok(Math.abs(top - restNow()) <= 1, `at the end of the text (${top} vs ${restNow()})`);
		assert.ok(Math.abs(distance() - (EXTRA + 222) - 1) <= 1, `d = the new blank space (${distance()})`);
		assert.ok(frames.every((f) => !f.open));
	});

	it("the viewport 300 px taller while the learner is 150 px into the blank space: left where it is, folded", async () => {
		await mountRest();
		await scrollDown(10, EXTRA + 1 - 150);
		const at = top;
		const frames = await taller();
		// The browser clamps it to the shorter scroll range; nothing else moves it.
		assert.equal(top, Math.min(at, textH + OPEN_BLOCK + GRADIENT_H - CLIENT_H), "not moved back to the rest");
		assert.ok(top > restNow() + 100);
		assert.ok(frames.every((f) => !f.open));
	});

	it("the reserve growing while it rests, rendered a moment after it was offered: still at the end of the text", async () => {
		await mountRest();
		deferSpacer = true;
		await act(async () => {
			openMeasured += 80;
			probe.offerNow();
		});
		await frame();
		await act(async () => commitSpacer());
		deferSpacer = false;
		const frames = await run(30);
		assert.ok(Math.abs(top - restNow()) <= 1, `at the end of the text (${top} vs ${restNow()})`);
		assert.equal(spacerDom, OPEN_BLOCK + 80 + GRADIENT_H);
		assert.ok(frames.every((f) => !f.open));
	});

	it("a lesson too short to scroll: it never opens by itself, and stays behind Open", async () => {
		await mountRest({ text: 50 });
		assert.ok(scrollHeight <= CLIENT_H, "nothing to scroll");
		await act(async () => {
			scroller.scrollTop = 1000;
		});
		const frames = await run(60);
		assert.ok(frames.every((f) => !f.open));
		assert.ok($("open"));
	});

	it("a geometry change that clamps the lesson to its bottom (the keyboard closing, the lesson shrinking) doesn't open it: that moves it up", async () => {
		await mountRest();
		await scrollDown(30, 150);
		assert.equal(probe.expanded(), false);
		await act(async () => {
			scrollHeight -= 200;
			setTop(top);
		});
		const frames = await run(30);
		assert.ok(distance() < EXPAND_DIST, "at the bottom now");
		assert.ok(frames.every((f) => !f.open), "but not opened");
	});

	it("an arrival during a resize mute isn't swallowed: it opens once the mute is over", async () => {
		mutes = true;
		await mountRest();
		await sleep(450);
		await scrollDown(30, 40);
		probe.stampGeometry();
		await scrollDown(30);
		await run(2);
		assert.equal(probe.expanded(), false, "muted");
		await sleep(450);
		await run(2);
		assert.equal(probe.expanded(), true, "opened after the mute");
		assert.equal(probe.revealed(), true);
	});

	it("a tap on Open at rest (touch): one glide to the real bottom, folded on the way, open on arrival", async () => {
		await mountRest();
		const reserve = probe.reserve();
		await tapOn("open");
		const frames = await run(80);
		assert.ok(beforeArrival(frames).length > 3, "it glided");
		assert.ok(beforeArrival(frames).every((f) => !f.open));
		assert.equal(probe.revealed(), true);
		assert.equal(probe.expanded(), true);
		assert.ok(distance() <= 2, `at the real bottom (${distance()} px)`);
		assert.equal(smoothCalls, 1);
		assert.equal(probe.reserve(), reserve);
		assert.ok((await run(100)).every((f) => f.open));
	});

	it("a click on Open at rest on a computer: open at once, slid to the real bottom, never folds", async () => {
		touchScreen = false;
		await mountRest();
		await act(async () => {
			($("open") as HTMLButtonElement).click();
		});
		assert.equal(probe.expanded(), true);
		assert.equal(probe.revealed(), true);
		const frames = await run(200);
		assert.ok(frames.every((f) => f.open));
		assert.equal(smoothCalls, 0);
		assert.ok(distance() <= 2, `at the real bottom (${distance()} px)`);
	});
});
