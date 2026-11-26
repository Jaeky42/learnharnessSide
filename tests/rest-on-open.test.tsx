/**
 * REST ON OPEN (components/rest-on-open.ts): from the moment a lesson opens
 * until the learner's first scroll, tap or key press, a lesson that messages
 * taking their real height left short of its resting point is put back there.
 *
 * The pure rule, then the real use-stick-to-bottom hook over a scripted
 * lesson that plays the sequence recorded in Chromium (production build,
 * 1366 × 1024): the lesson jumps to its bottom, messages take their real
 * height, a message above the screen comes out 24 px shorter and the
 * browser's scroll anchoring moves scrollTop up with it (one scroll event), a
 * ResizeObserver callback that sees no change of height wipes the library's
 * guard before its late 1 ms timeout runs, the library takes the shift for the
 * learner scrolling up and stops following, and 413 px of growth below is then
 * not followed.
 */

import React, { act, useEffect } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
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
Object.assign(dom.window, { requestAnimationFrame, cancelAnimationFrame, getSelection: () => null, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
Object.defineProperty(performance, "now", { configurable: true, value: () => clock });
type Observed = { cb: (entries: unknown[]) => void; targets: Element[] };
let observers: Observed[] = [];
class ScriptedResize {
	o: Observed;
	constructor(cb: (entries: unknown[]) => void) {
		this.o = { cb, targets: [] };
		observers.push(this.o);
	}
	observe(t: Element) { this.o.targets.push(t); }
	disconnect() { observers = observers.filter((o) => o !== this.o); }
}
Object.assign(globalThis, {
	window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame, cancelAnimationFrame,
	ResizeObserver: ScriptedResize,
	getComputedStyle: () => ({ scrollBehavior: "auto", overflow: "auto", overflowY: "auto" }),
});

const { useStickToBottom } = await import("use-stick-to-bottom");
const { REST_TOLERANCE_PX, installRestOnOpen, noteLessonJump, opensOnMessageLink, restOnOpenStep, viewMovedByOther } = await import("../components/rest-on-open.ts");
const { checkOpensOnScroll, createCheckSpace, noteCheckPlace, offerCheckSpace } = await import("../components/check-blank-space.ts");

const CLIENT_H = 964;
const EXPAND_DIST = 16;
let scrollHeight = 20000;
let top = 0;
let scrollPending = false;
let scroller: HTMLElement;
let content: HTMLElement;
/** A tall row of the lesson, in content coordinates: where its top is in the
 *  lesson. Scroll anchoring moves it with scrollTop; a scroll doesn't. */
let rowY = 18000;
const ROW_H = 2000;
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
		scrollTop: { configurable: true, get: () => top, set: (v: number) => setTop(v) },
		getBoundingClientRect: { configurable: true, value: () => ({ top: 0, bottom: CLIENT_H, height: CLIENT_H }) },
	});
}
function fakeRow(el: HTMLElement) {
	Object.defineProperty(el, "getBoundingClientRect", { configurable: true, value: () => ({ top: rowY - top, bottom: rowY - top + ROW_H, height: ROW_H }) });
}
/** The ResizeObservers on the lesson's content (the library's and the rule's). */
function contentResized() {
	for (const o of [...observers]) for (const t of o.targets) if (t === content) o.cb([{ contentRect: { height: scrollHeight }, target: t }]);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** One frame: the scroll event, then animation frames, then the timers due. */
async function frame() {
	await act(async () => {
		clock += 16;
		if (scrollPending) {
			scrollPending = false;
			scroller.dispatchEvent(new dom.window.Event("scroll"));
		}
		const due = rafQueue;
		rafQueue = [];
		for (const r of due) r.cb(clock);
		await sleep(8);
	});
}
async function run(n: number) { for (let i = 0; i < n; i++) await frame(); }

type Stick = ReturnType<typeof useStickToBottom>;
let stick: Stick;
let checkSpace = createCheckSpace();
/** The blank space a waiting check keeps beyond the end of the text (0: an ordinary lesson). */
let extra = 0;
/** chat.tsx's wiring of the rule (DockOverlay, `FORK (rest on open)`), copied. */
function Lesson({ rule, hash = "" }: { rule: boolean; hash?: string }) {
	stick = useStickToBottom({ initial: "instant", targetScrollTop: (t: number) => Math.max(0, t - extra) });
	const { scrollRef, state, scrollToBottom, stopScroll } = stick;
	useEffect(() => {
		const el = scrollRef.current;
		const c = el?.firstElementChild;
		if (!rule || !el || !c) return;
		const guard = installRestOnOpen({
			scroller: el, content: c, state,
			rearm: () => { void scrollToBottom("instant"); },
			release: stopScroll,
			onPutBack: (at) => { checkSpace.lastTop = at; checkSpace.movedDown = false; },
			ended: opensOnMessageLink(hash),
		});
		return () => guard.dispose();
	}, [rule, hash, scrollRef, state, scrollToBottom, stopScroll]);
	return (
		<div id="lesson" ref={(el) => { if (el) fakeScroller(el); scrollRef(el); }}>
			<div ref={(el) => { if (el) content = el; stick.contentRef(el); }}><p ref={(el) => { if (el) fakeRow(el); }}>text</p></div>
			<div id="dock" />
		</div>
	);
}

let root: Root | null = null;
const rest = () => Math.max(0, scrollHeight - 1 - CLIENT_H - extra);
const gap = () => rest() - top;
async function open({ rule = true, hash = "" }: { rule?: boolean; hash?: string } = {}) {
	scrollHeight = 20425;
	top = 0;
	rowY = 18000;
	scrollPending = false;
	rafQueue = [];
	checkSpace = createCheckSpace();
	const host = dom.document.createElement("div");
	dom.document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root!.render(<Lesson rule={rule} hash={hash} />));
	// The first layout: the library jumps to the bottom.
	await act(async () => contentResized());
	await run(4);
	// Messages take their real height: the lesson grows, and the library follows.
	await act(async () => { scrollHeight += 413; contentResized(); });
	await run(60);
	assert.ok(Math.abs(gap()) <= REST_TOLERANCE_PX, `at rest after the first heights (${gap()})`);
}
/** The recorded failure: a message above shrinks by 24 px and one below
 *  grows by 24 (scroll anchoring moves scrollTop up 24, scrollHeight is
 *  unchanged), the library's guard is set by that resize and then wiped by a
 *  ResizeObserver callback that saw no change of height, all before its 1 ms
 *  timeout runs. */
async function anchoringShift() {
	await act(async () => {
		scrollHeight -= 24;
		top -= 24;
		rowY -= 24; // what is on screen stays where it was
		contentResized(); // -24: the library's guard is set
		scrollHeight += 24;
		contentResized(); // +24
		scroller.dispatchEvent(new dom.window.Event("scroll")); // the anchoring's scroll event
		contentResized(); // no change of height: resizeDifference = 0
		await sleep(12); // the library's late timeout, then the rule's
	});
	await run(4);
}
/** 413 px more below the screen, later (a message's real height). */
async function laterGrowth() {
	await act(async () => { scrollHeight += 413; contentResized(); });
	await run(80);
}

afterEach(async () => {
	if (root) await act(async () => root!.unmount());
	root = null;
	observers = [];
	extra = 0;
	// use-stick-to-bottom keeps one page-wide "mouse is down" flag.
	dom.document.dispatchEvent(new dom.window.Event("mouseup"));
});

describe("the rule", () => {
	const base = { ended: false, sliding: false, scrollable: true, top: 900, rest: 1000, following: false };
	it("above the resting point with no slide under way: put back", () => {
		assert.equal(restOnOpenStep(base), "put-back");
		assert.equal(restOnOpenStep({ ...base, following: true }), "put-back");
	});
	it("within 2 px: nothing; at rest with the library let go: following again, without moving", () => {
		assert.equal(restOnOpenStep({ ...base, top: 998, following: true }), "none");
		assert.equal(restOnOpenStep({ ...base, top: 1000 }), "re-arm");
		assert.equal(restOnOpenStep({ ...base, top: 1002 }), "re-arm");
	});
	it("below the resting point (a check's blank space): never moved", () => {
		assert.equal(restOnOpenStep({ ...base, top: 1200 }), "none");
		assert.equal(restOnOpenStep({ ...base, top: 1200, following: true }), "none");
	});
	it("while the library slides: look again next frame; ended or too short to scroll: nothing", () => {
		assert.equal(restOnOpenStep({ ...base, sliding: true }), "wait");
		assert.equal(restOnOpenStep({ ...base, ended: true }), "none");
		assert.equal(restOnOpenStep({ ...base, scrollable: false }), "none");
	});
	it("what is on screen moved, other than by the library's setter: the learner's scroll", () => {
		assert.equal(viewMovedByOther({ moves: [0, 0, 0, 0], atMax: false }), false, "scroll anchoring: nothing on screen moved");
		assert.equal(viewMovedByOther({ moves: [-413, 0, 0, 0], atMax: false }), false, "the first row grew above the browser's anchor: its top moved, its bottom stayed (the recorded load)");
		assert.equal(viewMovedByOther({ moves: [0, 24, 24, 24], atMax: false }), false, "the first row grew below the anchor: what follows moved, its top stayed");
		assert.equal(viewMovedByOther({ moves: [2, 1, 2, 2], atMax: false }), false, "within 2 px");
		assert.equal(viewMovedByOther({ moves: [300, 300, 300, 300], atMax: false }), true, "scrolled up 300 px");
		assert.equal(viewMovedByOther({ moves: [-120, -120], atMax: false }), true, "scrolled down");
		assert.equal(viewMovedByOther({ moves: [200, 200], atMax: true }), false, "clamped at the very bottom: what is under it got shorter");
		assert.equal(viewMovedByOther({ moves: [], atMax: false }), false, "nothing to look at");
	});
	it("a link to a message in the address", () => {
		assert.equal(opensOnMessageLink("#message-msg_1"), true);
		assert.equal(opensOnMessageLink("#message-"), false);
		assert.equal(opensOnMessageLink(""), false);
		assert.equal(opensOnMessageLink("#other"), false);
	});
});

describe("the installer on its own", () => {
	function setup(over: Partial<{ top: number; rest: number; sliding: boolean; atBottom: boolean }> = {}) {
		const el = dom.document.createElement("div");
		const c = dom.document.createElement("div");
		el.appendChild(c);
		dom.document.body.appendChild(el);
		let t = over.top ?? 500;
		const sets: number[] = [];
		Object.defineProperties(el, { scrollHeight: { configurable: true, value: 5000 }, clientHeight: { configurable: true, value: 900 }, scrollTop: { configurable: true, get: () => t, set: (v) => { t = v; } } });
		const state = { get scrollTop() { return t; }, set scrollTop(v: number) { sets.push(v); t = v; }, calculatedTargetScrollTop: over.rest ?? 4099, isAtBottom: over.atBottom ?? false, animation: over.sliding ? {} : undefined as unknown };
		let rearms = 0;
		const putBacks: number[] = [];
		const guard = installRestOnOpen({ scroller: el, content: c, state, rearm: () => { rearms++; state.isAtBottom = true; }, onPutBack: (a) => putBacks.push(a) });
		return { el, state, guard, sets, putBacks, rearms: () => rearms, top: () => t };
	}
	it("a scroll event short of rest: put back a few ms later, through the library's setter, and following again", async () => {
		const s = setup();
		s.el.dispatchEvent(new dom.window.Event("scroll"));
		assert.deepEqual(s.sets, [], "not at the scroll event itself (the library decides first)");
		await sleep(10);
		assert.deepEqual(s.sets, [4099]);
		assert.deepEqual(s.putBacks, [4099]);
		assert.equal(s.rearms(), 1);
		s.guard.dispose();
	});
	for (const type of ["wheel", "touchstart", "pointerdown", "mousedown", "keydown"]) {
		it(`the learner's ${type} anywhere on the page ends it for good`, async () => {
			const s = setup();
			dom.document.body.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
			assert.equal(s.guard.ended, true);
			s.el.dispatchEvent(new dom.window.Event("scroll"));
			s.guard.check();
			await sleep(10);
			assert.deepEqual(s.sets, []);
			s.guard.dispose();
		});
	}
	it("a jump to a passage ends it for good", async () => {
		const s = setup();
		noteLessonJump();
		assert.equal(s.guard.ended, true);
		s.el.dispatchEvent(new dom.window.Event("scroll"));
		await sleep(10);
		assert.deepEqual(s.sets, []);
	});
	it("while the library slides: nothing until the slide is over, then put back", async () => {
		const s = setup({ sliding: true });
		s.guard.check();
		await sleep(10);
		const frames = rafQueue; rafQueue = [];
		assert.deepEqual(s.sets, [], "not during the slide");
		assert.ok(frames.length === 1, "looks again next frame");
		s.state.animation = undefined;
		for (const r of frames) r.cb(clock);
		assert.deepEqual(s.sets, [4099]);
		s.guard.dispose();
	});
	it("further down than rest: left where it is", async () => {
		const s = setup({ top: 4500, rest: 4099 });
		s.guard.check();
		await sleep(10);
		assert.deepEqual(s.sets, []);
		s.guard.dispose();
	});
});

describe("a lesson opening, with the real use-stick-to-bottom", () => {
	it("without the rule (as before): the anchoring shift is taken for the learner scrolling up, and later growth isn't followed", async () => {
		await open({ rule: false });
		await anchoringShift();
		assert.equal(stick.state.isAtBottom, false, "the library let go");
		assert.equal(gap(), 24);
		await laterGrowth();
		assert.equal(gap(), 24 + 413, "stopped short, and stays there");
	});

	it("with the rule: put back at the bottom, the library follows again, and later growth is followed", async () => {
		await open();
		await anchoringShift();
		assert.ok(Math.abs(gap()) <= REST_TOLERANCE_PX, `at rest (${gap()})`);
		assert.equal(stick.state.isAtBottom, true, "following again");
		await laterGrowth();
		assert.ok(Math.abs(gap()) <= REST_TOLERANCE_PX, `still at rest after growth (${gap()})`);
		// Again, later: still kept.
		await anchoringShift();
		await laterGrowth();
		assert.ok(Math.abs(gap()) <= REST_TOLERANCE_PX, `at rest (${gap()})`);
	});

	it("a waiting check: put back at the end of the text (not the real bottom), not as a move down, and it never opens by itself", async () => {
		extra = 700;
		await open();
		offerCheckSpace(checkSpace, extra);
		const look = () => noteCheckPlace(checkSpace, top, scrollHeight - CLIENT_H - top, EXPAND_DIST, rest());
		look();
		// The lesson was jumped down to rest on load: as before, that counted as a move down.
		checkSpace.movedDown = false;
		await anchoringShift();
		look();
		assert.ok(Math.abs(gap()) <= REST_TOLERANCE_PX, `at the end of the text (${gap()})`);
		assert.ok(scrollHeight - CLIENT_H - top > 600, "the blank space stays below");
		assert.equal(checkSpace.movedDown, false, "the put-back is not a move down");
		assert.equal(checkOpensOnScroll(checkSpace, scrollHeight - CLIENT_H - top, EXPAND_DIST), false);
		await laterGrowth();
		look();
		assert.ok(Math.abs(gap()) <= REST_TOLERANCE_PX, `at the end of the text after growth (${gap()})`);
		assert.equal(checkOpensOnScroll(checkSpace, scrollHeight - CLIENT_H - top, EXPAND_DIST), false);
	});

	for (const [type, on] of [["wheel", "lesson"], ["wheel", "dock"], ["touchstart", "dock"], ["pointerdown", "lesson"], ["keydown", "body"]] as const) {
		it(`the learner's ${type} on the ${on} before the shift: nothing moves the lesson afterwards (as before)`, async () => {
			await open();
			const target = on === "body" ? dom.document.body : dom.document.getElementById(on)!;
			await act(async () => { target.dispatchEvent(new dom.window.Event(type, { bubbles: true })); });
			const before = top;
			await anchoringShift();
			await laterGrowth();
			assert.equal(top, before - 24, "left where the browser put it");
		});
	}

	it("the learner's scroll whose input event never reaches the page (Chromium scrolls a wheel on the compositor): left where the learner put it", async () => {
		await open();
		await act(async () => { setTop(top - 300); });
		await run(4);
		const at = top;
		await anchoringShift();
		await laterGrowth();
		assert.equal(top, at - 24, "never pulled back");
	});

	it("the learner's scroll lands between a put-back and the library's next frame (its input event never comes): not pulled back", async () => {
		await open();
		await act(async () => {
			scrollHeight -= 24; top -= 24; rowY -= 24; contentResized();
			scrollHeight += 24; contentResized();
			scroller.dispatchEvent(new dom.window.Event("scroll"));
			contentResized();
			await sleep(12); // the library lets go; the rule puts it back and re-arms the library
		});
		assert.ok(Math.abs(gap()) <= REST_TOLERANCE_PX);
		// Before the re-arm's frame: the learner scrolls up 600 px.
		await act(async () => { setTop(top - 600); });
		const at = top;
		await run(10);
		assert.equal(top, at, "left where the learner put it");
		assert.equal(stick.state.isAtBottom, false, "the library let go, as at a wheel event");
	});

	it("the library's own slide and setter are never taken for the learner's scroll", async () => {
		await open();
		// A slide from far up (the library's spring), then the recorded shift: still kept at rest.
		await act(async () => { scrollHeight += 3000; contentResized(); });
		await run(80);
		await anchoringShift();
		await laterGrowth();
		assert.ok(Math.abs(gap()) <= REST_TOLERANCE_PX, `at rest (${gap()})`);
	});

	it("a jump to a passage (Find, a citation, \"Show in the lesson\"): the lesson stays on the passage", async () => {
		await open();
		await act(async () => { noteLessonJump(); stick.stopScroll(); setTop(6000); });
		await run(4);
		await anchoringShift();
		await laterGrowth();
		assert.equal(top, 6000 - 24, "on the passage, as the browser left it");
	});

	it("opening on a link to a message: never started", async () => {
		await open({ hash: "#message-msg_1" });
		await act(async () => { stick.stopScroll(); setTop(3000); });
		await run(4);
		await laterGrowth();
		assert.equal(top, 3000);
	});
});
