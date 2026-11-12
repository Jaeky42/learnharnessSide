/**
 * THE SIDE TUTOR WINDOW'S SIZE RULES (owner's ask): the left, right and bottom
 * sides and the two bottom corners resize it; the top never moves in a resize.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MORPH_CLOSE_MS, MORPH_EASE, MORPH_OPEN_MS, morphStart, resizeTutorRect, storedTutorSize, TUTOR_EDGE, TUTOR_MIN_HEIGHT, TUTOR_MIN_WIDTH, TUTOR_RESIZE_EDGES } from "../components/side-tutor-window.ts";

const viewport = { width: 1280, height: 800 };
/** A window in the middle of the app window. */
const start = { left: 400, top: 100, width: 352, height: 480 };

describe("which edges resize the window", () => {
	it("the left, right and bottom sides and the two bottom corners; nothing at the top", () => {
		assert.deepEqual([...TUTOR_RESIZE_EDGES], ["left", "right", "bottom", "bottom-left", "bottom-right"]);
	});

	it("the right side makes it wider or narrower; the left edge and the height stay", () => {
		assert.deepEqual(resizeTutorRect(start, "right", 60, 40, viewport), { left: 400, top: 100, width: 412, height: 480 });
		assert.deepEqual(resizeTutorRect(start, "right", -30, -40, viewport), { left: 400, top: 100, width: 322, height: 480 });
	});

	it("the left side moves the left edge; the right edge stays where it was", () => {
		const wider = resizeTutorRect(start, "left", -100, 40, viewport);
		assert.deepEqual(wider, { left: 300, top: 100, width: 452, height: 480 });
		assert.equal(wider.left + wider.width, start.left + start.width);
		const narrower = resizeTutorRect(start, "left", 40, 0, viewport);
		assert.deepEqual(narrower, { left: 440, top: 100, width: 312, height: 480 });
		assert.equal(narrower.left + narrower.width, start.left + start.width);
	});

	it("the bottom side makes it taller or shorter; the top and the width stay", () => {
		assert.deepEqual(resizeTutorRect(start, "bottom", 90, 70, viewport), { left: 400, top: 100, width: 352, height: 550 });
		assert.deepEqual(resizeTutorRect(start, "bottom", 0, -100, viewport), { left: 400, top: 100, width: 352, height: 380 });
	});

	it("a bottom corner changes the width and the height together", () => {
		assert.deepEqual(resizeTutorRect(start, "bottom-right", 50, 60, viewport), { left: 400, top: 100, width: 402, height: 540 });
		assert.deepEqual(resizeTutorRect(start, "bottom-left", -50, 60, viewport), { left: 350, top: 100, width: 402, height: 540 });
	});

	it("never moves the top", () => {
		for (const edge of TUTOR_RESIZE_EDGES) {
			for (const [dx, dy] of [[-500, -500], [500, 500], [37, -12]] as const) assert.equal(resizeTutorRect(start, edge, dx, dy, viewport).top, start.top, `${edge} ${dx},${dy}`);
		}
	});
});

describe("how far it resizes", () => {
	it("no smaller than the smallest window", () => {
		assert.equal(resizeTutorRect(start, "right", -1000, 0, viewport).width, TUTOR_MIN_WIDTH);
		assert.equal(resizeTutorRect(start, "bottom", 0, -1000, viewport).height, TUTOR_MIN_HEIGHT);
		// From the left, the right edge still stays put at the smallest width.
		const squeezed = resizeTutorRect(start, "left", 1000, 0, viewport);
		assert.deepEqual([squeezed.left, squeezed.width], [start.left + start.width - TUTOR_MIN_WIDTH, TUTOR_MIN_WIDTH]);
		const corner = resizeTutorRect(start, "bottom-left", 1000, -1000, viewport);
		assert.deepEqual(corner, { left: start.left + start.width - TUTOR_MIN_WIDTH, top: 100, width: TUTOR_MIN_WIDTH, height: TUTOR_MIN_HEIGHT });
	});

	it("no further than the app window's edges, less the margin", () => {
		const right = resizeTutorRect(start, "right", 5000, 0, viewport);
		assert.equal(right.left + right.width, viewport.width - TUTOR_EDGE);
		const left = resizeTutorRect(start, "left", -5000, 0, viewport);
		assert.deepEqual([left.left, left.left + left.width], [TUTOR_EDGE, start.left + start.width]);
		const bottom = resizeTutorRect(start, "bottom", 0, 5000, viewport);
		assert.equal(bottom.top + bottom.height, viewport.height - TUTOR_EDGE);
	});

	it("a window hanging off the bottom of a small app window can still be made no shorter than the smallest", () => {
		// Dragged low: only its top is on screen, so there is no room below the top.
		const low = { left: 400, top: 700, width: 352, height: 480 };
		assert.equal(resizeTutorRect(low, "bottom", 0, -1000, viewport).height, TUTOR_MIN_HEIGHT);
		assert.equal(resizeTutorRect(low, "bottom", 0, 1000, viewport).height, TUTOR_MIN_HEIGHT);
	});
});

describe("the remembered size", () => {
	it("is used as stored", () => {
		assert.deepEqual(storedTutorSize({ width: 500, height: 600 }), { width: 500, height: 600 });
	});

	it("is never smaller than the smallest window", () => {
		assert.deepEqual(storedTutorSize({ width: 10, height: 10 }), { width: TUTOR_MIN_WIDTH, height: TUTOR_MIN_HEIGHT });
	});

	it("is ignored when it isn't a size", () => {
		for (const raw of [null, undefined, "big", 7, {}, { width: 400 }, { width: "400", height: 500 }, { width: Number.NaN, height: 500 }, { width: 400, height: Number.POSITIVE_INFINITY }]) {
			assert.equal(storedTutorSize(raw), null, JSON.stringify(raw));
		}
	});
});

describe("the morph: the window squeezed onto the bubble (owner's pick)", () => {
	it("puts the window's box exactly over the bubble's, round, with the icon at its own size", () => {
		const bubble = { left: 832, top: 568, width: 52, height: 52 };
		const panel = { left: 470, top: 60, width: 352, height: 480 };
		const at = morphStart(bubble, panel)!;
		// Centre to centre: (858, 594) from (646, 300).
		assert.equal(at.transform, "translate(212px, 294px) scale(0.148, 0.108)");
		// Squeezed by those scales, 176 × 240 px corners are a 26 px circle.
		assert.equal(at.borderRadius, "176px / 240px");
		assert.equal(at.iconTransform, "scale(6.769, 9.231)");
	});

	it("works wherever the window was dragged to, also left of and above the bubble", () => {
		const at = morphStart({ left: 100, top: 100, width: 52, height: 52 }, { left: 600, top: 300, width: 400, height: 400 })!;
		assert.equal(at.transform, "translate(-674px, -374px) scale(0.13, 0.13)");
	});

	it("is nothing when a box has no size (nothing to measure yet)", () => {
		assert.equal(morphStart({ left: 0, top: 0, width: 0, height: 0 }, { left: 0, top: 0, width: 352, height: 480 }), null);
		assert.equal(morphStart({ left: 0, top: 0, width: 52, height: 52 }, { left: 0, top: 0, width: 0, height: 0 }), null);
	});

	it("opens in 260 ms and folds back in 210, with the sync strip's easing", () => {
		assert.deepEqual([MORPH_OPEN_MS, MORPH_CLOSE_MS, MORPH_EASE], [260, 210, "cubic-bezier(0.2, 0.8, 0.2, 1)"]);
	});
});
