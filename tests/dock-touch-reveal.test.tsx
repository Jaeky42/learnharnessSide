/**
 * A TAP ON THE FOLDED QUESTION ENDS AT THE BOTTOM, OPEN (owner's iPhone: it
 * opened for an instant and folded again, the lesson left far up). The real
 * use-stick-to-bottom hook and the real dock touch hook
 * (components/phone/use-dock-touch-scroll.ts), with chat.tsx's reveal and
 * fold wiring (suppressFoldDuringReveal and DockOverlay's fold rule) copied
 * in, over a scripted lesson and frame clock.
 *
 * The iPhone part that Chromium can't show is played by `report()`: the
 * lesson's scroller announcing positions above where the slide put it, with
 * no new touch (Safari's own deceleration of a lesson still moving, or its
 * late reports). use-stick-to-bottom takes any such upward scroll for the
 * learner leaving and ends its slide.
 */

import React, { act, useCallback, useEffect, useRef, useState } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
let touchScreen = true;
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
	matchMedia: (query: string) => ({ matches: touchScreen && /max-width|coarse/.test(query), addEventListener() {}, removeEventListener() {} }),
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
const { useDockTouchScroll } = await import("../components/phone/use-dock-touch-scroll.ts");

// DockOverlay's thresholds (components/chat.tsx).
const COLLAPSE_DIST = 96;
const EXPAND_DIST = 16;
const CLIENT_H = 600;

/** The lesson's scroller: a scripted box. A changed scrollTop announces a
 *  scroll event at the next frame, as a browser does. */
let scroller: HTMLElement;
let scrollHeight = 10000;
let top = 0;
let scrollPending = false;
function fakeScroller(el: HTMLElement) {
	scroller = el;
	Object.defineProperties(el, {
		scrollHeight: { configurable: true, get: () => scrollHeight },
		clientHeight: { configurable: true, get: () => CLIENT_H },
		scrollTop: {
			configurable: true,
			get: () => top,
			set: (v: number) => {
				const next = Math.max(0, Math.min(scrollHeight - CLIENT_H, v));
				if (next !== top) scrollPending = true;
				top = next;
			},
		},
	});
}
const distance = () => scrollHeight - CLIENT_H - top;

type Probe = { expanded: () => boolean; intent: () => boolean; slides: number; options: number };
let probe: Probe;

/** chat.tsx's wiring around the dock, copied: `old` is the wiring before these fixes
 *  (one slide, and every touch lets go of the question). */
function Harness({ old = false }: { old?: boolean }) {
	const stick = useStickToBottom({ initial: "instant", resize: "smooth" });
	const { scrollToBottom, stopScroll, state: stickState, isAtBottom } = stick;
	const blockRef = useRef<HTMLDivElement>(null);
	const [expanded, setExpanded] = useState(false);
	const expandedRef = useRef(expanded);
	expandedRef.current = expanded;
	const atBottomRef = useRef(isAtBottom);
	atBottomRef.current = isAtBottom;
	const expandIntentRef = useRef(false);
	const intentTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
	const dockReveal = useDockTouchScroll(blockRef, stick.scrollRef, {
		onTouchStart: (hold) => {
			if (!stickState.animation && !expandIntentRef.current) return;
			stopScroll();
			clearTimeout(intentTimerRef.current);
			expandIntentRef.current = old ? false : hold;
		},
		isSliding: () => !!stickState.animation || expandIntentRef.current,
		onTouchSettled: (tap) => {
			if (old) return;
			if (tap) {
				void suppressFoldDuringReveal();
				return;
			}
			expandIntentRef.current = false;
			const el = stick.scrollRef.current;
			if (el && expandedRef.current && !atBottomRef.current && el.scrollHeight - el.clientHeight - el.scrollTop > COLLAPSE_DIST) setExpanded(false);
		},
	});
	const slide = () => {
		probe.slides++;
		return scrollToBottom();
	};
	const suppressFoldDuringReveal = () => {
		expandIntentRef.current = true;
		clearTimeout(intentTimerRef.current);
		if (old) {
			intentTimerRef.current = setTimeout(() => {
				expandIntentRef.current = false;
			}, 2000);
			return Promise.resolve(slide()).finally(() => {
				clearTimeout(intentTimerRef.current);
				expandIntentRef.current = false;
			});
		}
		const settle = () => {
			clearTimeout(intentTimerRef.current);
			expandIntentRef.current = false;
		};
		intentTimerRef.current = setTimeout(settle, dockReveal.revealHoldMs ?? 2000);
		return dockReveal.revealToBottom(slide, () => expandIntentRef.current, settle);
	};
	const expandAndReveal = () => {
		setExpanded(true);
		void suppressFoldDuringReveal();
	};
	probe = { expanded: () => expandedRef.current, intent: () => expandIntentRef.current, slides: probe?.slides ?? 0, options: probe?.options ?? 0 };
	useEffect(() => {
		const el = stick.scrollRef.current;
		if (!el) return;
		const onScroll = () => {
			const d = el.scrollHeight - el.clientHeight - el.scrollTop;
			if (expandedRef.current) {
				if (d > COLLAPSE_DIST && !expandIntentRef.current && !atBottomRef.current) setExpanded(false);
			} else if (d < EXPAND_DIST) {
				setExpanded(true);
				void scrollToBottom();
			}
		};
		el.addEventListener("scroll", onScroll, { passive: true });
		return () => el.removeEventListener("scroll", onScroll);
	}, [stick.scrollRef, scrollToBottom]);
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
				<button id="bar" type="button" onClick={expandAndReveal}>Answer</button>
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

/** One frame: the scroll event, then animation frames, then the library's 1 ms timeouts. */
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
		await new Promise((r) => setTimeout(r, 2));
	});
}
function touch(type: string, target: Element, y = 300, timeStamp = clock) {
	const e = new dom.window.Event(type, { bubbles: true, cancelable: true });
	Object.assign(e, { touches: type === "touchend" ? [] : [{ clientX: 100, clientY: y }] });
	Object.defineProperty(e, "timeStamp", { value: timeStamp });
	target.dispatchEvent(e);
	return e;
}
const $ = (id: string) => dom.document.getElementById(id)!;

let root: Root | null = null;
async function mount(old = false) {
	probe = { expanded: () => false, intent: () => false, slides: 0, options: 0 };
	scrollHeight = 10000;
	top = 0;
	rafQueue = [];
	const host = dom.document.createElement("div");
	dom.document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root!.render(<Harness old={old} />));
	// The learner has scrolled far up and the question has folded.
	await act(async () => {
		scroller.scrollTop = 4000;
	});
	// At rest: no scroll in the last 100 ms (a tap then isn't replayed).
	for (let i = 0; i < 10; i++) await frame();
	assert.equal(probe.expanded(), false);
}
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	dom.document.body.innerHTML = "";
	touchScreen = true;
});

/** The tap on the folded bar: touchstart, touchend, then Safari's own click
 *  (unless the touchend cancelled it: a replayed tap). */
async function tapBar() {
	await act(async () => {
		touch("touchstart", $("bar"));
		clock += 60;
		const end = touch("touchend", $("bar"));
		if (!end.defaultPrevented) ($("bar") as HTMLButtonElement).click();
	});
}

/** Run frames; at the frames listed, the scroller reports a position 30 px
 *  further up than the last, with no new touch. Returns the frames on which
 *  the question was folded. */
async function run(frames: number, reportsAt: number[] = []) {
	let reported = top;
	const folded: number[] = [];
	for (let i = 0; i < frames; i++) {
		if (reportsAt.includes(i)) {
			reported = Math.min(reported, top) - 30;
			scroller.scrollTop = reported;
		}
		await frame();
		if (!probe.expanded()) folded.push(i);
	}
	return folded;
}

describe("a tap on the folded question ends at the bottom, open (touch screen)", () => {
	it("the cause: without the hold, a scroll the learner didn't make ends the slide and the question folds back", async () => {
		await mount(true);
		await tapBar();
		const folded = await run(200, [2, 5, 8, 11, 14]);
		assert.ok(folded.length > 0, "the question folded again");
		assert.ok(distance() > 4000, `the lesson was left far up (${distance()} px from the bottom)`);
	});

	it("it stays open and the lesson reaches its bottom, sliding again after each such scroll", async () => {
		await mount();
		await tapBar();
		const folded = await run(400, [2, 5, 8, 11, 14]);
		assert.deepEqual(folded, [], "never folded");
		assert.ok(distance() <= 2, `at the bottom (${distance()} px)`);
		assert.ok(probe.slides > 1, "slid again");
		assert.equal(probe.intent(), false, "and let go of the question once there");
	});

	it("at rest with nothing else moving, one slide is enough, as before", async () => {
		await mount();
		await tapBar();
		assert.deepEqual(await run(400), []);
		assert.ok(distance() <= 2);
		assert.equal(probe.slides, 1);
		assert.equal(probe.intent(), false);
	});

	it("a tap while the lesson is still moving is replayed, opens the question, and it stays open", async () => {
		await mount();
		// The lesson moving up under its own momentum, the last frame just now.
		scroller.scrollTop = top - 40;
		await frame();
		let clicks = 0;
		$("bar").addEventListener("click", () => clicks++);
		await tapBar();
		assert.equal(clicks, 1, "replayed once; Safari's own click is cancelled");
		const folded = await run(400, [1, 4, 7]);
		assert.deepEqual(folded, []);
		assert.ok(distance() <= 2);
	});

	it("a new touch during the slide still stops it, and the question can fold again", async () => {
		await mount();
		await tapBar();
		await run(4);
		const stoppedAt = distance();
		assert.ok(stoppedAt > COLLAPSE_DIST, "still sliding");
		await act(async () => {
			touch("touchstart", $("lesson"));
		});
		assert.equal(probe.intent(), false, "the hold is let go at the touch");
		// The learner's own drag up the lesson.
		scroller.scrollTop = top - 300;
		await run(40);
		assert.equal(probe.expanded(), false, "folded by the learner's own scroll");
		assert.ok(distance() >= stoppedAt, "and the slide didn't come back");
		await act(async () => {
			touch("touchend", $("lesson"));
		});
	});

	it("a tap on the lesson during the slide stops it, and it stays stopped (no reveal taken up again)", async () => {
		await mount();
		await tapBar();
		await run(4);
		const stoppedAt = distance();
		await act(async () => {
			touch("touchstart", $("lesson"));
			clock += 40;
			touch("touchend", $("lesson"));
		});
		await run(100);
		assert.equal(probe.slides, 1);
		assert.ok(distance() >= stoppedAt - 40, `stopped where it was (${stoppedAt} → ${distance()})`);
	});

	/** One finger on the dock: down, then up `ms` later; Safari's click unless cancelled. */
	async function tapOn(id: string, ms = 40) {
		await act(async () => {
			touch("touchstart", $(id));
			clock += ms;
			const end = touch("touchend", $(id), 300, clock);
			if (!end.defaultPrevented) ($(id) as HTMLElement).click();
		});
	}

	it("the old rule: a tap on the question's thinking box while the lesson slides folds the question from under the finger", async () => {
		await mount(true);
		await tapBar();
		await run(4);
		await tapOn("box");
		await run(20);
		assert.equal(probe.expanded(), false);
		assert.ok(distance() > COLLAPSE_DIST);
	});

	it("a tap on the question's thinking box while the lesson slides: the reveal is taken up again, the box stays, it ends at the bottom", async () => {
		await mount();
		await tapBar();
		await run(4);
		assert.ok(distance() > COLLAPSE_DIST, "still sliding");
		await tapOn("box");
		assert.ok($("box"), "the box is still there");
		const folded = await run(400);
		assert.deepEqual(folded, [], "never folded");
		assert.ok(distance() <= 2, `at the bottom (${distance()} px)`);
		assert.ok($("box"));
		assert.equal(probe.intent(), false);
	});

	it("a drag from the same place lets go and folds, as before", async () => {
		await mount();
		await tapBar();
		await run(4);
		const stoppedAt = distance();
		// Touch events keep going to the element first touched.
		const box = $("box");
		await act(async () => {
			touch("touchstart", box, 300);
		});
		await act(async () => {
			touch("touchmove", box, 320, clock + 16);
		});
		assert.equal(probe.expanded(), false, "folded once it moved");
		assert.equal(probe.intent(), false);
		await act(async () => {
			touch("touchend", box, 320, clock + 60);
		});
		await run(60);
		assert.equal(probe.slides, 1, "no reveal taken up again");
		assert.ok(distance() >= stoppedAt - 40);
	});

	it("a long press on the question during the slide lets go, as before", async () => {
		await mount();
		await tapBar();
		await run(4);
		await tapOn("text", 700);
		await run(40);
		assert.equal(probe.slides, 1);
		assert.equal(probe.expanded(), false);
	});

	it("a tap on an option while the lesson slides is pressed once, and the reveal is taken up again", async () => {
		await mount();
		await tapBar();
		await run(4);
		await tapOn("option");
		assert.equal(probe.options, 1, "replayed once; Safari's own click is cancelled");
		assert.deepEqual(await run(400), []);
		assert.ok(distance() <= 2);
	});

	it("a mouse on the lesson (its scrollbar) during the hold lets go: the learner's scroll isn't pulled back", async () => {
		await mount();
		await tapBar();
		await run(4);
		await act(async () => {
			const e = new dom.window.Event("pointerdown", { bubbles: true });
			Object.assign(e, { pointerType: "mouse" });
			$("lesson").dispatchEvent(e);
		});
		// The scrollbar dragged up: the slide ends there, as for a wheel.
		for (let i = 0; i < 3; i++) {
			scroller.scrollTop = top - 200;
			await run(3);
		}
		await run(4);
		const at = distance();
		await run(90);
		assert.equal(probe.slides, 1, "not slid again");
		assert.ok(at > COLLAPSE_DIST && distance() >= at - 1, `left where the learner put it (${at} → ${distance()})`);
		assert.equal(probe.expanded(), false, "and the question folds, as for any scroll up");
	});

	it("a scrolling key during the hold lets go: the learner's scroll isn't pulled back", async () => {
		await mount();
		await tapBar();
		await run(4);
		await act(async () => {
			const e = new dom.window.Event("keydown", { bubbles: true });
			Object.assign(e, { key: "PageUp" });
			dom.document.body.dispatchEvent(e);
		});
		scroller.scrollTop = top - 540;
		await run(10);
		const at = distance();
		await run(90);
		assert.equal(probe.slides, 1);
		assert.ok(at > COLLAPSE_DIST && distance() >= at - 1, `left where the learner put it (${at} → ${distance()})`);
	});

	it("which keys count: scrolling keys on the page or in the lesson, never in a text box or Space on a button", async () => {
		const { keyScrollsLesson } = await import("../components/phone/use-dock-touch-scroll.ts");
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
		assert.equal(keyScrollsLesson("PageUp", $("box"), lesson, doc), false, "outside the lesson (the question)");
		assert.equal(keyScrollsLesson("a", doc.body, lesson, doc), false);
	});

	it("a tap whose wobble became a short drag: its throw is stopped, the slide only goes down", async () => {
		await mount();
		const bar = $("bar");
		// Finger down 6 px over 20 ms on the bar: forwarded to the lesson, with a throw.
		await act(async () => {
			touch("touchstart", bar, 300, clock);
			touch("touchmove", bar, 303, clock + 10);
			touch("touchmove", bar, 306, clock + 20);
			touch("touchend", bar, 306, clock + 21);
			clock += 21;
			(bar as HTMLButtonElement).click();
		});
		let last = top;
		let wentUp = false;
		for (let i = 0; i < 300; i++) {
			await frame();
			if (top < last) wentUp = true;
			last = top;
			assert.equal(probe.expanded(), true);
		}
		assert.equal(wentUp, false, "the throw didn't pull the lesson back up");
		assert.ok(distance() <= 2);
	});

	it("on a computer the reveal is one slide, as before: nothing slides again", async () => {
		touchScreen = false;
		await mount();
		await tapBar();
		await run(200, [2, 5, 8, 11, 14]);
		assert.equal(probe.slides, 1);
		assert.equal(probe.intent(), false);
	});
});
