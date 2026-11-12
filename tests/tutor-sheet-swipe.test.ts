/**
 * THE TUTOR'S SHEET SWIPES DOWN (phone; owner's choice from a live demo):
 * the rules in components/phone/tutor-sheet-swipe.ts, and its touch driver
 * with scripted touch events and a scripted clock. What the sheet looks like
 * on the way needs real layout and is checked in a browser.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";

const {
	installTutorSheetSwipe,
	sheetDimOpacity,
	sheetOffset,
	sheetRelease,
	sheetReleaseSpeed,
	sheetSlideMs,
	translateYOf,
	SHEET_EASE,
	SHEET_SPRING_MS,
	SWIPE_BAR_ATTR,
} = await import("../components/phone/tutor-sheet-swipe.ts");

describe("the rules", () => {
	it("follows the finger down, never above the sheet's place", () => {
		assert.equal(sheetOffset(0, 40), 40);
		assert.equal(sheetOffset(0, -30), 0, "an upward drag stays at the place");
		assert.equal(sheetOffset(100, -30), 70, "picked up on its way in, from where it had reached");
		assert.equal(sheetOffset(20, -60), 0);
	});

	it("past a quarter of the height, letting go minimizes; short of it, it springs back", () => {
		assert.equal(sheetRelease(121, 480, 0), "close");
		assert.equal(sheetRelease(120, 480, 0), "back", "exactly a quarter is not past it");
		assert.equal(sheetRelease(60, 480, 0.3), "back");
	});

	it("a quick flick down minimizes: over 0.5 px/ms, and moved more than 12 px", () => {
		assert.equal(sheetRelease(40, 480, 0.6), "close");
		assert.equal(sheetRelease(40, 480, 0.5), "back", "0.5 px/ms is not over it");
		assert.equal(sheetRelease(12, 480, 2), "back", "12 px is not more than 12");
		assert.equal(sheetRelease(13, 480, 2), "close");
		assert.equal(sheetRelease(40, 480, -1), "back", "a flick back up");
	});

	it("takes the release speed from the finger's last 80 ms, and none if it had stopped", () => {
		// 60 px in the last 60 ms: 1 px/ms.
		const samples = [{ t: 0, y: 100 }, { t: 100, y: 110 }, { t: 130, y: 140 }, { t: 160, y: 170 }];
		assert.ok(Math.abs(sheetReleaseSpeed(samples, 165) - 1) < 1e-9);
		assert.equal(sheetReleaseSpeed(samples, 260), 0, "held still for 100 ms before lifting");
		assert.equal(sheetReleaseSpeed([{ t: 0, y: 0 }], 5), 0);
	});

	it("slides away in 260 ms from its place, less for what is left, never under 130", () => {
		assert.equal(sheetSlideMs(0, 480), 260);
		assert.equal(sheetSlideMs(120, 480), 195);
		assert.equal(sheetSlideMs(240, 480), 130);
		assert.equal(sheetSlideMs(400, 480), 130);
		assert.equal(sheetSlideMs(600, 480), 130);
	});

	it("fades the dim with the sheet", () => {
		assert.equal(sheetDimOpacity(0, 480), 1);
		assert.equal(sheetDimOpacity(120, 480), 0.75);
		assert.equal(sheetDimOpacity(480, 480), 0);
		assert.equal(sheetDimOpacity(900, 480), 0);
	});

	it("reads the place from a computed transform", () => {
		assert.equal(translateYOf("none"), 0);
		assert.equal(translateYOf("matrix(1, 0, 0, 1, 0, 123.5)"), 123.5);
		assert.equal(translateYOf("matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 42, 0, 1)"), 42);
		assert.equal(translateYOf("translateY(10px)"), null);
		assert.equal(translateYOf(""), null);
	});
});

// ── the touch driver ────────────────────────────────────────────────────

type Run = { el: Element; frames: Record<string, unknown>[]; options: { duration: number; easing: string }; onfinish: (() => void) | null; cancelled: boolean; cancel(): void };

function setup({ motion = true }: { motion?: boolean } = {}) {
	const dom = parseHTML(`<html><body>
		<div id="dim"></div>
		<div id="sheet">
			<div id="bar" ${SWIPE_BAR_ATTR}><div id="title">Tutor</div><button id="minus"><svg id="minus-icon"></svg></button></div>
			<div id="body"><div id="talk"><p id="words">An answer</p></div><div id="typing"><textarea id="box"></textarea></div></div>
		</div>
	</body></html>`);
	const { document } = dom;
	const el = (id: string) => document.getElementById(id) as unknown as HTMLElement;
	const sheet = el("sheet");
	const dim = el("dim");
	Object.defineProperty(sheet, "offsetHeight", { get: () => 480 });
	Object.assign(el("bar"), { getBoundingClientRect: () => ({ top: 312, bottom: 360, left: 0, right: 390, width: 390, height: 48 }) });
	const runs: Run[] = [];
	if (motion) {
		for (const target of [sheet, dim]) {
			Object.assign(target, {
				animate(this: Element, frames: Record<string, unknown>[], options: Run["options"]) {
					const run: Run = { el: this, frames, options, onfinish: null, cancelled: false, cancel() { run.cancelled = true; } };
					runs.push(run);
					return run;
				},
			});
		}
	}
	let clock = 0;
	const calls: string[] = [];
	const swipe = installTutorSheetSwipe(sheet, {
		dim: () => dim,
		onSwipeClose: () => {
			calls.push("close");
			// What the window's own close does on a phone.
			if (!swipe.slideAway()) calls.push("at once");
		},
		onGone: () => calls.push("gone"),
		now: () => clock,
	});
	const touch = (type: string, target: Element, points: { x: number; y: number }[], cancelable = true) => {
		const e = new dom.window.Event(type, { bubbles: true, cancelable });
		Object.assign(e, { touches: points.map((p) => ({ clientX: p.x, clientY: p.y })) });
		target.dispatchEvent(e);
		return e;
	};
	/** A one-finger swipe: down by each step, `ms` apart, then lifted after `hold` ms. */
	const swipeOn = (target: Element, steps: number[], { from = 330, ms = 16, hold = 0 } = {}) => {
		touch("touchstart", target, [{ x: 100, y: from }]);
		const moves: Event[] = [];
		for (const y of steps) {
			clock += ms;
			moves.push(touch("touchmove", target, [{ x: 100, y: from + y }]));
		}
		clock += hold;
		touch("touchend", target, []);
		return moves;
	};
	const ty = () => sheet.style.transform;
	return { dom, document, el, sheet, dim, runs, calls, swipe, touch, swipeOn, ty, tick: (ms: number) => void (clock += ms) };
}

describe("the touch driver", () => {
	it("a swipe on the top bar follows the finger, and past a quarter slides away, then the sheet is gone", () => {
		const t = setup();
		t.touch("touchstart", t.el("title"), [{ x: 100, y: 330 }]);
		const first = t.touch("touchmove", t.el("title"), [{ x: 100, y: 331 }]);
		assert.equal(first.defaultPrevented, true, "decided on the first movement: the page can't start scrolling");
		assert.equal(t.ty(), "translateY(1px)");
		t.tick(16);
		t.touch("touchmove", t.el("title"), [{ x: 100, y: 330 + 120 }]);
		assert.equal(t.ty(), "translateY(120px)");
		assert.equal(t.dim.style.opacity, "0.75", "the dim fades with it");
		t.tick(16);
		t.touch("touchmove", t.el("title"), [{ x: 100, y: 330 + 150 }]);
		t.tick(200); // held still: no flick, it is the distance that counts
		t.touch("touchend", t.el("title"), []);
		assert.deepEqual(t.calls, ["close"]);
		const slide = t.runs.find((run) => run.el === t.sheet)!;
		assert.deepEqual(slide.frames, [{ transform: "translateY(150px)" }, { transform: "translateY(100%)" }]);
		assert.equal(slide.options.duration, Math.round(260 * (1 - 150 / 480)));
		assert.equal(slide.options.easing, SHEET_EASE);
		assert.equal(SHEET_EASE, "cubic-bezier(0.2, 0.8, 0.2, 1)");
		const fade = t.runs.find((run) => run.el === t.dim)!;
		assert.deepEqual(fade.frames.map((f) => f.opacity), [sheetDimOpacity(150, 480), 0]);
		assert.equal(t.ty(), "translateY(100%)", "it stays down when the slide ends");
		slide.onfinish?.();
		assert.deepEqual(t.calls, ["close", "gone"]);
	});

	it("a short swipe springs back in 200 ms", () => {
		const t = setup();
		t.swipeOn(t.el("bar"), [10, 30, 60], { hold: 100 });
		assert.deepEqual(t.calls, []);
		const spring = t.runs.find((run) => run.el === t.sheet)!;
		assert.deepEqual(spring.frames, [{ transform: "translateY(60px)" }, { transform: "translateY(0px)" }]);
		assert.equal(spring.options.duration, SHEET_SPRING_MS);
		assert.equal(t.ty(), "");
		assert.equal(t.dim.style.opacity, "");
	});

	it("a quick flick down slides it away", () => {
		const t = setup();
		t.swipeOn(t.el("bar"), [15, 30, 45], { ms: 16 });
		assert.deepEqual(t.calls, ["close"]);
	});

	it("starts on the handle strip too, above the bar", () => {
		const t = setup();
		t.swipeOn(t.sheet, [40, 90, 150], { from: 304, hold: 100 });
		assert.deepEqual(t.calls, ["close"]);
	});

	it("never starts on the conversation, the typing row, the − button, or the sheet below the bar", () => {
		for (const id of ["words", "talk", "box", "typing", "minus", "minus-icon"]) {
			const t = setup();
			const moves = t.swipeOn(t.el(id), [40, 90, 200], { hold: 100 });
			assert.equal(t.ty(), "", id);
			assert.equal(moves.some((m) => m.defaultPrevented), false, `${id}: its own scrolling is left alone`);
			assert.deepEqual(t.calls, [], id);
		}
		// The sheet itself below the bar (the home-bar strip at its bottom).
		const t = setup();
		t.swipeOn(t.sheet, [40, 90, 200], { from: 780, hold: 100 });
		assert.equal(t.ty(), "");
	});

	it("an upward drag keeps it at its place", () => {
		const t = setup();
		t.touch("touchstart", t.el("bar"), [{ x: 100, y: 330 }]);
		t.touch("touchmove", t.el("bar"), [{ x: 100, y: 300 }]);
		assert.equal(t.ty(), "");
		t.touch("touchend", t.el("bar"), []);
		assert.deepEqual(t.calls, []);
	});

	it("a tap that doesn't move does nothing", () => {
		const t = setup();
		t.touch("touchstart", t.el("bar"), [{ x: 100, y: 330 }]);
		t.tick(80);
		t.touch("touchend", t.el("bar"), []);
		assert.equal(t.ty(), "");
		assert.deepEqual(t.calls, []);
		assert.equal(t.runs.length, 0);
	});

	it("a second finger cancels the drag: it springs back", () => {
		const t = setup();
		t.touch("touchstart", t.el("bar"), [{ x: 100, y: 330 }]);
		t.touch("touchmove", t.el("bar"), [{ x: 100, y: 330 + 200 }]);
		t.touch("touchstart", t.el("bar"), [{ x: 100, y: 530 }, { x: 200, y: 400 }]);
		assert.equal(t.ty(), "");
		t.touch("touchend", t.el("bar"), []);
		assert.deepEqual(t.calls, [], "past a quarter, but cancelled");
	});

	it("a cancelled touch springs back", () => {
		const t = setup();
		t.touch("touchstart", t.el("bar"), [{ x: 100, y: 330 }]);
		t.touch("touchmove", t.el("bar"), [{ x: 100, y: 330 + 200 }]);
		t.touch("touchcancel", t.el("bar"), []);
		assert.equal(t.ty(), "");
		assert.deepEqual(t.calls, []);
	});

	it("a move Safari has already taken (not cancelable) is left to it", () => {
		const t = setup();
		t.touch("touchstart", t.el("bar"), [{ x: 100, y: 330 }]);
		t.touch("touchmove", t.el("bar"), [{ x: 100, y: 400 }], false);
		t.touch("touchmove", t.el("bar"), [{ x: 100, y: 500 }]);
		assert.equal(t.ty(), "");
	});

	it("slideAway (the − button, the dim) slides from its place in 260 ms; nothing starts while it goes", () => {
		const t = setup();
		assert.equal(t.swipe.slideAway(), true);
		const slide = t.runs.find((run) => run.el === t.sheet)!;
		assert.deepEqual(slide.frames, [{ transform: "translateY(0px)" }, { transform: "translateY(100%)" }]);
		assert.equal(slide.options.duration, 260);
		assert.equal(t.swipe.slideAway(), true, "asked again: still the one slide");
		assert.equal(t.runs.filter((run) => run.el === t.sheet).length, 1);
		t.swipeOn(t.el("bar"), [10, 20], { hold: 100 });
		assert.equal(t.ty(), "translateY(100%)", "a touch on its way down does nothing");
		slide.onfinish?.();
		assert.deepEqual(t.calls, ["gone"]);
	});

	it("the typing box loses its focus as the slide starts, with or without motion; a box outside the sheet keeps it", () => {
		for (const motion of [true, false]) {
			const t = setup({ motion });
			const box = t.el("box");
			let blurred = 0;
			Object.defineProperty(t.sheet.ownerDocument, "activeElement", { get: () => box, configurable: true });
			Object.assign(box, { blur: () => { blurred++; } });
			t.swipe.slideAway();
			assert.equal(blurred, 1, motion ? "at the start of the slide" : "closing at once");
		}
		const t = setup();
		const outside = t.sheet.ownerDocument.createElement("textarea") as unknown as HTMLElement;
		t.sheet.ownerDocument.body.appendChild(outside as unknown as Node);
		let blurred = 0;
		Object.defineProperty(t.sheet.ownerDocument, "activeElement", { get: () => outside, configurable: true });
		Object.assign(outside, { blur: () => { blurred++; } });
		t.swipe.slideAway();
		assert.equal(blurred, 0);
	});

	it("asked to open while it slides away, it comes back up and stays", () => {
		const t = setup();
		t.swipe.slideAway();
		const slide = t.runs.find((run) => run.el === t.sheet)!;
		t.swipe.reopen();
		assert.equal(slide.cancelled, true);
		assert.equal(t.ty(), "");
		slide.onfinish?.();
		assert.deepEqual(t.calls, [], "the old slide's end doesn't minimize it");
	});

	it("with reduced motion: no slide; slideAway says so and the window closes at once; a swipe still minimizes", () => {
		const t = setup({ motion: false });
		assert.equal(t.swipe.slideAway(), false);
		t.swipeOn(t.el("bar"), [40, 90, 150], { hold: 100 });
		assert.deepEqual(t.calls, ["close", "at once"]);
		const short = setup({ motion: false });
		short.swipeOn(short.el("bar"), [20, 40], { hold: 100 });
		assert.equal(short.ty(), "", "short of the line it is back at once");
		assert.equal(short.runs.length, 0);
	});

	it("dispose removes the listeners and its styles; a slide under way ends minimized", () => {
		const t = setup();
		t.touch("touchstart", t.el("bar"), [{ x: 100, y: 330 }]);
		t.touch("touchmove", t.el("bar"), [{ x: 100, y: 360 }]);
		t.swipe.dispose();
		assert.equal(t.ty(), "");
		t.swipeOn(t.el("bar"), [40, 90, 150], { hold: 100 });
		assert.equal(t.ty(), "");
		assert.deepEqual(t.calls, []);
		const going = setup();
		going.swipe.slideAway();
		going.swipe.dispose();
		assert.deepEqual(going.calls, ["gone"]);
	});
});
