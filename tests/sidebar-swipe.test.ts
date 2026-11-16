/**
 * THE SESSION LIST DRAWER SWIPES LEFT TO CLOSE (phone; owner-approved design):
 * the rules in components/phone/sidebar-swipe.ts, and its touch driver with
 * scripted touch events and a scripted clock. What the drawer looks like on
 * the way needs real layout and is checked in a browser.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";

const {
	installSidebarSwipe,
	drawerDimOpacity,
	drawerOffset,
	drawerRelease,
	drawerReleaseSpeed,
	drawerSlideMs,
	drawerSwipeDecision,
	translateXOf,
	DRAWER_SPRING_MS,
} = await import("../components/phone/sidebar-swipe.ts");
const { SHEET_EASE } = await import("../components/phone/tutor-sheet-swipe.ts");

describe("the rules", () => {
	it("decides on the first movement: mostly sideways and to the left is a drag", () => {
		assert.equal(drawerSwipeDecision(0, 0, true), "wait");
		assert.equal(drawerSwipeDecision(-3, 1, true), "drag");
		assert.equal(drawerSwipeDecision(-2, 2, true), "no", "a diagonal is not mostly sideways");
		assert.equal(drawerSwipeDecision(1, -8, true), "no", "vertical scrolls the list");
		assert.equal(drawerSwipeDecision(8, 1, true), "no", "to the right is never a drag");
		assert.equal(drawerSwipeDecision(-8, 1, false), "no", "Safari already took it");
	});

	it("follows the finger to the left, never right of the drawer's place or past its width", () => {
		assert.equal(drawerOffset(0, -40, 300), 40);
		assert.equal(drawerOffset(0, 30, 300), 0, "a drag back right stays at the place");
		assert.equal(drawerOffset(100, 30, 300), 70, "picked up on its way, from where it had reached");
		assert.equal(drawerOffset(20, 60, 300), 0);
		assert.equal(drawerOffset(0, -900, 300), 300);
	});

	it("past a quarter of the width, letting go closes; short of it, it springs back", () => {
		assert.equal(drawerRelease(76, 300, 0), "close");
		assert.equal(drawerRelease(75, 300, 0), "back", "exactly a quarter is not past it");
		assert.equal(drawerRelease(40, 300, 0.3), "back");
	});

	it("a quick flick to the left closes: over 0.5 px/ms, and moved more than 12 px", () => {
		assert.equal(drawerRelease(40, 300, 0.6), "close");
		assert.equal(drawerRelease(40, 300, 0.5), "back", "0.5 px/ms is not over it");
		assert.equal(drawerRelease(12, 300, 2), "back", "12 px is not more than 12");
		assert.equal(drawerRelease(13, 300, 2), "close");
		assert.equal(drawerRelease(40, 300, -1), "back", "a flick back to the right");
	});

	it("takes the release speed from the finger's last 80 ms, leftward positive, none if it had stopped", () => {
		// x from 200 to 140 in the last 60 ms: 1 px/ms to the left.
		const samples = [{ t: 0, y: 220 }, { t: 100, y: 200 }, { t: 130, y: 170 }, { t: 160, y: 140 }];
		assert.ok(Math.abs(drawerReleaseSpeed(samples, 165) - 1) < 1e-9);
		assert.equal(drawerReleaseSpeed(samples, 260), 0, "held still for 100 ms before lifting");
		assert.equal(drawerReleaseSpeed([{ t: 0, y: 0 }], 5), 0);
		const right = [{ t: 0, y: 100 }, { t: 30, y: 130 }, { t: 60, y: 160 }];
		assert.ok(drawerReleaseSpeed(right, 65) < 0, "to the right is negative");
	});

	it("slides away in 200 ms from its place, less for what is left, never under 130", () => {
		assert.equal(drawerSlideMs(0, 300), 200);
		assert.equal(drawerSlideMs(75, 300), 150);
		assert.equal(drawerSlideMs(150, 300), 130);
		assert.equal(drawerSlideMs(290, 300), 130);
		assert.equal(drawerSlideMs(600, 300), 130);
	});

	it("fades the dim with the drawer", () => {
		assert.equal(drawerDimOpacity(0, 300), 1);
		assert.equal(drawerDimOpacity(75, 300), 0.75);
		assert.equal(drawerDimOpacity(300, 300), 0);
		assert.equal(drawerDimOpacity(900, 300), 0);
	});

	it("reads the place from a computed transform", () => {
		assert.equal(translateXOf("none"), 0);
		assert.equal(translateXOf("matrix(1, 0, 0, 1, -123.5, 0)"), -123.5);
		assert.equal(translateXOf("matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -42, 0, 0, 1)"), -42);
		assert.equal(translateXOf("translateX(-10px)"), null);
		assert.equal(translateXOf(""), null);
	});
});

// ── the touch driver ────────────────────────────────────────────────────

type Run = { el: Element; frames: Record<string, unknown>[]; options: { duration: number; easing: string }; onfinish: (() => void) | null; cancelled: boolean; cancel(): void };

function setup({ motion = true }: { motion?: boolean } = {}) {
	const dom = parseHTML(`<html><body>
		<div id="dim"></div>
		<aside id="drawer">
			<div id="head"><input id="search" /></div>
			<div id="list"><a id="row">A session</a><span id="label">text</span></div>
		</aside>
	</body></html>`);
	const { document } = dom;
	const el = (id: string) => document.getElementById(id) as unknown as HTMLElement;
	const drawer = el("drawer");
	const dim = el("dim");
	Object.defineProperty(drawer, "offsetWidth", { get: () => 300 });
	const runs: Run[] = [];
	if (motion) {
		for (const target of [drawer, dim]) {
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
	const swipe = installSidebarSwipe(drawer, {
		dim: () => dim,
		onClose: () => calls.push("close"),
		now: () => clock,
	});
	const touch = (type: string, target: Element, points: { x: number; y: number }[], cancelable = true) => {
		const e = new dom.window.Event(type, { bubbles: true, cancelable });
		Object.assign(e, { touches: points.map((p) => ({ clientX: p.x, clientY: p.y })) });
		target.dispatchEvent(e);
		return e;
	};
	/** A one-finger swipe: left by each step, `ms` apart, then lifted after `hold` ms. */
	const swipeOn = (target: Element, steps: number[], { from = 250, y = 300, ms = 16, hold = 0 } = {}) => {
		touch("touchstart", target, [{ x: from, y }]);
		const moves: Event[] = [];
		for (const dx of steps) {
			clock += ms;
			moves.push(touch("touchmove", target, [{ x: from + dx, y }]));
		}
		clock += hold;
		const end = touch("touchend", target, []);
		return { moves, end };
	};
	const click = (target: Element) => {
		// Counted above the drawer: a swallowed click stops there (linkedom has no
		// capture phase, so the drawer's capture listener runs as the click bubbles by).
		let reached = 0;
		const listener = () => reached++;
		document.body.addEventListener("click", listener);
		const e = new dom.window.Event("click", { bubbles: true, cancelable: true });
		target.dispatchEvent(e);
		document.body.removeEventListener("click", listener);
		return { e, reached };
	};
	const tx = () => drawer.style.transform;
	const drawerRuns = () => runs.filter((run) => run.el === drawer);
	return { dom, document, el, drawer, dim, runs, drawerRuns, calls, swipe, touch, swipeOn, click, tx, tick: (ms: number) => void (clock += ms) };
}

describe("the touch driver", () => {
	it("a swipe past a quarter follows the finger, slides away, and only then closes", () => {
		const t = setup();
		t.touch("touchstart", t.el("row"), [{ x: 250, y: 300 }]);
		const first = t.touch("touchmove", t.el("row"), [{ x: 249, y: 300 }]);
		assert.equal(first.defaultPrevented, true, "decided on the first movement: the page can't start scrolling");
		assert.equal(t.tx(), "translateX(-1px)");
		assert.equal(t.drawer.style.transition, "none", "the CSS transition stays out of the way");
		t.tick(16);
		t.touch("touchmove", t.el("row"), [{ x: 250 - 90, y: 301 }]);
		assert.equal(t.tx(), "translateX(-90px)");
		assert.equal(t.dim.style.opacity, "0.7", "the dim fades with it");
		t.tick(200); // held still: no flick, it is the distance that counts
		t.touch("touchend", t.el("row"), []);
		assert.deepEqual(t.calls, [], "not before the slide has ended");
		const slide = t.drawerRuns()[0]!;
		assert.deepEqual(slide.frames, [{ transform: "translateX(-90px)" }, { transform: "translateX(-100%)" }]);
		assert.equal(slide.options.duration, Math.round(200 * (1 - 90 / 300)));
		assert.equal(slide.options.easing, SHEET_EASE);
		const fade = t.runs.find((run) => run.el === t.dim)!;
		assert.deepEqual(fade.frames.map((f) => f.opacity), [drawerDimOpacity(90, 300), 0]);
		assert.equal(t.tx(), "translateX(-100%)", "it stays off screen when the slide ends");
		assert.equal(t.drawer.style.transition, "none", "so the CSS can't slide it back");
		slide.onfinish?.();
		assert.deepEqual(t.calls, ["close"], "once");
		assert.equal(t.tx(), "translateX(-100%)", "left for dispose, after React has committed the closed state");
		t.swipe.dispose();
		assert.equal(t.tx(), "");
		assert.equal(t.drawer.style.transition, "");
		assert.equal(t.dim.style.opacity, "");
		assert.deepEqual(t.calls, ["close"], "dispose calls nothing");
	});

	it("a short swipe springs back in 200 ms and clears its inline styles", () => {
		const t = setup();
		t.swipeOn(t.el("row"), [-10, -30, -60], { hold: 100 });
		assert.deepEqual(t.calls, []);
		const spring = t.drawerRuns()[0]!;
		assert.deepEqual(spring.frames, [{ transform: "translateX(-60px)" }, { transform: "translateX(0px)" }]);
		assert.equal(spring.options.duration, DRAWER_SPRING_MS);
		assert.equal(t.tx(), "");
		assert.equal(t.dim.style.opacity, "");
		assert.equal(t.drawer.style.transition, "none", "still out of the way while it springs");
		spring.onfinish?.();
		assert.equal(t.drawer.style.transition, "", "cleared once it is back");
	});

	it("a quick flick to the left closes it", () => {
		const t = setup();
		t.swipeOn(t.el("row"), [-15, -30, -45], { ms: 16 });
		t.drawerRuns()[0]!.onfinish?.();
		assert.deepEqual(t.calls, ["close"]);
	});

	it("a vertical first move never drags and prevents nothing", () => {
		const v = setup();
		v.touch("touchstart", v.el("row"), [{ x: 250, y: 300 }]);
		const first = v.touch("touchmove", v.el("row"), [{ x: 249, y: 330 }]);
		const second = v.touch("touchmove", v.el("row"), [{ x: 100, y: 340 }]);
		const end = v.touch("touchend", v.el("row"), []);
		assert.equal(first.defaultPrevented, false);
		assert.equal(second.defaultPrevented, false, "not a drag for the rest of the touch, even when it turns sideways");
		assert.equal(v.tx(), "");
		assert.equal(v.runs.length, 0);
		assert.deepEqual(v.calls, []);
		assert.equal(end.defaultPrevented, false);
	});

	it("a rightward first move never drags", () => {
		const t = setup();
		t.touch("touchstart", t.el("row"), [{ x: 100, y: 300 }]);
		const first = t.touch("touchmove", t.el("row"), [{ x: 130, y: 301 }]);
		const back = t.touch("touchmove", t.el("row"), [{ x: 10, y: 301 }]);
		t.touch("touchend", t.el("row"), []);
		assert.equal(first.defaultPrevented, false);
		assert.equal(back.defaultPrevented, false, "even when it then goes left");
		assert.equal(t.tx(), "");
		assert.deepEqual(t.calls, []);
	});

	it("a move Safari has already taken (not cancelable) is left to it", () => {
		const t = setup();
		t.touch("touchstart", t.el("row"), [{ x: 250, y: 300 }]);
		t.touch("touchmove", t.el("row"), [{ x: 200, y: 300 }], false);
		t.touch("touchmove", t.el("row"), [{ x: 100, y: 300 }]);
		assert.equal(t.tx(), "");
	});

	it("never goes right of its place, and the dim follows", () => {
		const t = setup();
		t.touch("touchstart", t.el("row"), [{ x: 250, y: 300 }]);
		t.touch("touchmove", t.el("row"), [{ x: 200, y: 300 }]);
		assert.equal(t.tx(), "translateX(-50px)");
		assert.equal(t.dim.style.opacity, String(drawerDimOpacity(50, 300)));
		t.tick(16);
		t.touch("touchmove", t.el("row"), [{ x: 290, y: 300 }]);
		assert.equal(t.tx(), "", "back to its place, no further");
		assert.equal(t.dim.style.opacity, "");
		t.tick(16);
		t.touch("touchmove", t.el("row"), [{ x: 0, y: 300 }]);
		assert.equal(t.tx(), "translateX(-250px)");
		t.tick(16);
		t.touch("touchmove", t.el("row"), [{ x: -400, y: 300 }]);
		assert.equal(t.tx(), "translateX(-300px)", "not past its own width");
	});

	it("a touch that starts in the search box is ignored", () => {
		for (const id of ["search"]) {
			const t = setup();
			const { moves } = t.swipeOn(t.el(id), [-40, -90, -200], { hold: 100 });
			assert.equal(t.tx(), "");
			assert.equal(moves.some((m) => m.defaultPrevented), false);
			assert.deepEqual(t.calls, []);
			assert.equal(t.runs.length, 0);
		}
	});

	it("a second finger springs it back and ends the drag", () => {
		const t = setup();
		t.touch("touchstart", t.el("row"), [{ x: 250, y: 300 }]);
		t.touch("touchmove", t.el("row"), [{ x: 100, y: 300 }]);
		t.touch("touchstart", t.el("row"), [{ x: 100, y: 300 }, { x: 200, y: 400 }]);
		assert.equal(t.tx(), "");
		t.touch("touchmove", t.el("row"), [{ x: 0, y: 300 }]);
		assert.equal(t.tx(), "", "the drag is over");
		t.touch("touchend", t.el("row"), []);
		assert.deepEqual(t.calls, [], "past a quarter, but cancelled");
	});

	it("a cancelled touch springs back", () => {
		const t = setup();
		t.touch("touchstart", t.el("row"), [{ x: 250, y: 300 }]);
		t.touch("touchmove", t.el("row"), [{ x: 100, y: 300 }]);
		t.touch("touchcancel", t.el("row"), []);
		assert.equal(t.tx(), "");
		assert.deepEqual(t.calls, []);
		assert.equal(t.drawerRuns()[0]!.frames[0]!.transform, "translateX(-150px)");
	});

	it("a press and hold during a drag (contextmenu) springs it back and ends the drag", () => {
		const t = setup();
		t.touch("touchstart", t.el("row"), [{ x: 250, y: 300 }]);
		t.touch("touchmove", t.el("row"), [{ x: 230, y: 300 }]);
		t.el("row").dispatchEvent(new t.dom.window.Event("contextmenu", { bubbles: true, cancelable: true }));
		assert.equal(t.tx(), "");
		t.touch("touchmove", t.el("row"), [{ x: 0, y: 300 }]);
		assert.equal(t.tx(), "", "the drag is over");
		t.touch("touchend", t.el("row"), []);
		assert.deepEqual(t.calls, []);
	});

	it("a contextmenu with no drag under way does nothing", () => {
		const t = setup();
		t.el("row").dispatchEvent(new t.dom.window.Event("contextmenu", { bubbles: true, cancelable: true }));
		assert.equal(t.runs.length, 0);
		assert.equal(t.tx(), "");
		assert.equal(t.drawer.style.transition, "");
	});

	it("after a drag the touch's end is prevented and the next click is swallowed, once", async () => {
		const t = setup();
		const { end } = t.swipeOn(t.el("row"), [-10, -30, -60], { hold: 100 });
		assert.equal(end.defaultPrevented, true);
		const first = t.click(t.el("row"));
		assert.equal(first.reached, 0, "the row under the finger doesn't open");
		assert.equal(first.e.defaultPrevented, true);
		const later = t.click(t.el("row"));
		assert.equal(later.reached, 1, "a later click is not swallowed");
		// A tap that never moved: nothing prevented, nothing swallowed.
		const tap = setup();
		tap.touch("touchstart", tap.el("row"), [{ x: 250, y: 300 }]);
		const tapEnd = tap.touch("touchend", tap.el("row"), []);
		assert.equal(tapEnd.defaultPrevented, false);
		assert.equal(tap.click(tap.el("row")).reached, 1);
		// A drag whose click never comes stops swallowing after 400 ms.
		const slow = setup();
		slow.swipeOn(slow.el("row"), [-10, -30], { hold: 100 });
		await new Promise((resolve) => setTimeout(resolve, 450));
		assert.equal(slow.click(slow.el("row")).reached, 1);
	});

	it("nothing happens while it slides away", () => {
		const t = setup();
		t.swipeOn(t.el("row"), [-40, -120, -200], { hold: 100 });
		const slide = t.drawerRuns()[0]!;
		const before = t.runs.length;
		t.swipeOn(t.el("row"), [-10, -20], { hold: 100 });
		assert.equal(t.runs.length, before, "no second animation");
		assert.equal(t.tx(), "translateX(-100%)");
		slide.onfinish?.();
		assert.deepEqual(t.calls, ["close"]);
	});

	it("with reduced motion the drawer still follows the finger; close and spring settle at once", () => {
		const t = setup({ motion: false });
		t.swipeOn(t.el("row"), [-40, -90, -150], { hold: 100 });
		assert.deepEqual(t.calls, ["close"], "closed at once");
		assert.equal(t.tx(), "translateX(-100%)");
		assert.equal(t.runs.length, 0);
		const short = setup({ motion: false });
		short.touch("touchstart", short.el("row"), [{ x: 250, y: 300 }]);
		short.touch("touchmove", short.el("row"), [{ x: 220, y: 300 }]);
		assert.equal(short.tx(), "translateX(-30px)", "follows the finger");
		short.tick(100);
		short.touch("touchend", short.el("row"), []);
		assert.equal(short.tx(), "", "short of the line it is back at once");
		assert.equal(short.drawer.style.transition, "");
		assert.deepEqual(short.calls, []);
	});

	it("dispose clears its styles and listeners and calls nothing", () => {
		const t = setup();
		t.touch("touchstart", t.el("row"), [{ x: 250, y: 300 }]);
		t.touch("touchmove", t.el("row"), [{ x: 200, y: 300 }]);
		t.swipe.dispose();
		assert.equal(t.tx(), "");
		assert.equal(t.drawer.style.transition, "");
		assert.equal(t.dim.style.opacity, "");
		t.swipeOn(t.el("row"), [-40, -120, -200], { hold: 100 });
		assert.equal(t.tx(), "", "the listeners are gone");
		assert.equal(t.runs.length, 0);
		assert.deepEqual(t.calls, []);
		// The pending click swallow goes too.
		const s = setup();
		s.swipeOn(s.el("row"), [-10, -30], { hold: 100 });
		s.swipe.dispose();
		assert.equal(s.click(s.el("row")).reached, 1);
	});
});
