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

import React, { act, useCallback, useEffect, useRef, useState } from "react";
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
class NoResize { observe() {} disconnect() {} }
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

// DockOverlay's thresholds (components/chat.tsx).
const COLLAPSE_DIST = 96;
const EXPAND_DIST = 16;
const CLIENT_H = 600;
const SMOOTH_MS = 500;

/** The lesson's scroller: a scripted box (see the top of this file). */
let scroller: HTMLElement;
let scrollHeight = 10000;
let top = 0;
let scrollPending = false;
let smooth: { from: number; to: number; t0: number } | null = null;
let momentum = 0; // px per frame, upwards
let smoothRefused = false; // a browser that gives up on its smooth scroll at once
let momentumOutlivesStop = false; // a hidden frame that didn't catch Safari's momentum
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
					smooth = smoothRefused || momentum ? null : { from: top, to, t0: clock };
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
};
let probe: Probe;

/** chat.tsx's wiring around the dock, copied. `teach`: a teach check waiting
 *  behind its Open invitation (requiresReveal). */
function Harness({ teach = false }: { teach?: boolean }) {
	const stick = useStickToBottom({ initial: "instant", resize: "smooth" });
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
		setExpanded(true);
		void suppressFoldDuringReveal();
	};
	const openDock = (reveal: boolean) => {
		if (!atBottomRef.current) {
			if (stickState.animation) stopScroll();
			if (dockTouch.glideToBottom()) {
				openOnArrivalRef.current = reveal;
				return;
			}
		}
		openAtOnce(reveal);
	};
	const arriveAtBottomRef = useRef(() => {});
	arriveAtBottomRef.current = () => {
		if (teach && !revealedRef.current) {
			if (!openOnArrivalRef.current) return;
			setRevealed(true);
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
	};
	useEffect(() => {
		const el = stick.scrollRef.current;
		if (!el) return;
		const onScroll = () => {
			const d = el.scrollHeight - el.clientHeight - el.scrollTop;
			if (expandedRef.current) {
				if (d > COLLAPSE_DIST && !expandIntentRef.current && !atBottomRef.current) setExpanded(false);
			} else if (d < EXPAND_DIST) {
				arriveAtBottomRef.current();
			}
		};
		el.addEventListener("scroll", onScroll, { passive: true });
		return () => el.removeEventListener("scroll", onScroll);
	}, [stick.scrollRef]);
	const stickScrollRef = stick.scrollRef;
	const scrollRef = useCallback((el: HTMLDivElement | null) => {
		if (el) fakeScroller(el);
		stickScrollRef(el);
	}, [stickScrollRef]);
	return (
		<div>
			<div id="lesson" ref={scrollRef} data-overflow="auto">
				<div ref={stick.contentRef} />
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
		} else if (smooth) {
			const p = Math.min(1, (clock - smooth.t0) / SMOOTH_MS);
			const e = 1 - (1 - p) ** 3;
			setTop(smooth.from + (smooth.to - smooth.from) * e);
			if (p >= 1) smooth = null;
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
	probe = { expanded: () => false, revealed: () => false, intent: () => false, atBottom: () => false, slides: 0, options: 0, revealNow: () => {} };
	scrollHeight = 10000;
	top = 0;
	smooth = null;
	momentum = 0;
	smoothRefused = false;
	momentumOutlivesStop = false;
	smoothCalls = 0;
	rafQueue = [];
	const host = dom.document.createElement("div");
	dom.document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root!.render(<Harness teach={teach} />));
	// The lesson starts at its bottom; the learner has scrolled up from there
	// (use-stick-to-bottom takes the scroll up as leaving the bottom).
	await act(async () => {
		scroller.scrollTop = scrollHeight;
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

	it("the lesson grew under the glide: it finishes once more, and opens on arrival", async () => {
		await mount();
		await tapOn("bar");
		await run(5);
		scrollHeight += 1500;
		const frames = await run(120);
		assert.equal(smoothCalls, 2, "one more glide");
		assert.equal(probe.expanded(), true);
		assert.ok(distance() <= 2);
		assert.ok(beforeArrival(frames).every((f) => !f.open));
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

	it("a teach check's glide stopped by the learner: the invitation stays, and reaching the bottom later doesn't open it", async () => {
		await mount({ teach: true });
		await tapOn("open");
		await run(6);
		await act(async () => {
			touch("touchstart", $("lesson"));
			touch("touchend", $("lesson"));
		});
		await act(async () => {
			scroller.scrollTop = scrollHeight;
		});
		await run(20);
		assert.equal(probe.revealed(), false);
		assert.equal(probe.expanded(), false);
		assert.ok($("open"));
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
