/**
 * One more push at the end opens a folded question (components/push-at-end.ts):
 * the pure rules. The hook itself runs in tests/dock-touch-reveal.test.tsx,
 * with chat.tsx's wiring over a scripted lesson.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	atEnd, graceOver, touchPushMove, touchPushStart, wheelPushStep, wheelPx, WHEEL_START,
	PUSH_END_PX, PUSH_GRACE_MS, PUSH_TOUCH_PX, PUSH_WHEEL_PAUSE_MS, PUSH_WHEEL_PX, type TouchPush,
} from "../components/push-at-end.ts";

describe("the constants (owner-approved)", () => {
	it("are as approved", () => {
		assert.deepEqual([PUSH_END_PX, PUSH_TOUCH_PX, PUSH_WHEEL_PX, PUSH_WHEEL_PAUSE_MS, PUSH_GRACE_MS], [16, 24, 100, 250, 500]);
	});
});

describe("atEnd", () => {
	it("within 16 px of the bottom, inclusive", () => {
		assert.equal(atEnd({ scrollHeight: 1000, clientHeight: 600, scrollTop: 400 }), true);
		assert.equal(atEnd({ scrollHeight: 1000, clientHeight: 600, scrollTop: 384 }), true);
		assert.equal(atEnd({ scrollHeight: 1000, clientHeight: 600, scrollTop: 383 }), false);
	});
});

describe("graceOver", () => {
	it("nothing counts for 500 ms after arming", () => {
		assert.equal(graceOver(1000, 1000), false);
		assert.equal(graceOver(1000, 1499), false);
		assert.equal(graceOver(1000, 1500), true);
	});
});

describe("wheelPx", () => {
	it("px, lines (×16) and pages (×the lesson's height)", () => {
		assert.equal(wheelPx(40, 0, 600), 40);
		assert.equal(wheelPx(3, 1, 600), 48);
		assert.equal(wheelPx(1, 2, 600), 600);
	});
});

describe("wheelPushStep", () => {
	const feed = (events: [px: number, t: number, counts?: boolean][]) => {
		let s = WHEEL_START;
		const pushes: number[] = [];
		for (const [px, t, counts = true] of events) {
			const r = wheelPushStep(s, px, t, counts);
			s = r.state;
			if (r.push) pushes.push(t);
		}
		return { s, pushes };
	};

	it("adds up to 100 px, then pushes once and starts again", () => {
		const { s, pushes } = feed([[40, 0], [40, 50], [40, 100], [40, 150]]);
		assert.deepEqual(pushes, [100]);
		assert.equal(s.sum, 40);
	});

	it("one big step pushes at once", () => {
		assert.equal(wheelPushStep(WHEEL_START, 120, 0, true).push, true);
	});

	it("a pause longer than 250 ms starts the sum again", () => {
		assert.deepEqual(feed([[60, 0], [60, 251]]).pushes, []);
		assert.deepEqual(feed([[60, 0], [60, 250]]).pushes, [250]);
	});

	it("an event that doesn't count (up, a pinch, not at the end, a box under the pointer) starts again", () => {
		assert.deepEqual(feed([[60, 0], [60, 10, false], [60, 20]]).pushes, []);
		assert.deepEqual(feed([[60, 0], [-10, 10], [60, 20]]).pushes, []);
	});
});

describe("touchPushMove", () => {
	const feed = (moves: [x: number, y: number, end?: boolean, inner?: boolean][], start: [number, number] = [100, 400]) => {
		let s: TouchPush = touchPushStart(...start);
		let pushes = 0;
		for (const [x, y, end = true, inner = false] of moves) {
			const r = touchPushMove(s, x, y, end, inner);
			s = r.state;
			if (r.push) pushes++;
		}
		return { s, pushes };
	};

	it("a finger moving up the screen by 24 px at the end pushes, once", () => {
		assert.equal(feed([[100, 390], [100, 376]]).pushes, 1);
		const { s, pushes } = feed([[100, 390], [100, 376], [100, 300], [100, 200]]);
		assert.equal(pushes, 1, "the rest of the touch is ignored");
		assert.equal(s.axis, "done");
	});

	it("23 px doesn't", () => {
		assert.equal(feed([[100, 390], [100, 377]]).pushes, 0);
	});

	it("no movement waits; a tap never pushes", () => {
		const { s, pushes } = feed([[100, 400], [100, 400]]);
		assert.equal(pushes, 0);
		assert.equal(s.axis, "wait");
	});

	it("the other way (down the screen) never counts, and starts the sum again", () => {
		assert.equal(feed([[100, 450], [100, 500]]).pushes, 0);
		assert.equal(feed([[100, 385], [100, 390], [100, 375]]).pushes, 0, "15 up, 5 back, 15 up");
		assert.equal(feed([[100, 385], [100, 390], [100, 366]]).pushes, 1, "then 24 up from the turn");
	});

	it("movement while the lesson isn't at its end starts the sum again", () => {
		assert.equal(feed([[100, 385, false], [100, 370]]).pushes, 0);
		assert.equal(feed([[100, 385, false], [100, 361]]).pushes, 1);
	});

	it("movement a scroll box under the finger can still take doesn't count", () => {
		assert.equal(feed([[100, 380, true, true], [100, 360, true, true]]).pushes, 0);
		assert.equal(feed([[100, 380, true, true], [100, 356]]).pushes, 1, "once the box is at its end");
	});

	it("a first movement more sideways than vertical ignores the rest of the touch", () => {
		const { s, pushes } = feed([[130, 395], [130, 300], [130, 200]]);
		assert.equal(s.axis, "sideways");
		assert.equal(pushes, 0);
	});

	it("a first movement more vertical than sideways counts, and later sideways drift doesn't matter", () => {
		assert.equal(feed([[105, 390], [160, 370]]).pushes, 1);
	});
});
