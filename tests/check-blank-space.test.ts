/**
 * SCROLL INTO A CHECK: the pure rules (components/check-blank-space.ts). The
 * wiring with the real use-stick-to-bottom is in dock-touch-reveal.test.tsx.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import {
	backToRest,
	blankSpaceExtra,
	bottomTarget,
	checkOpensOnScroll,
	createCheckSpace,
	measureOpenCheck,
	noteCheckPlace,
	offerCheckSpace,
	openCheckBlockHeight,
	resetCheckSpace,
	restingTarget,
} from "../components/check-blank-space.ts";
import { dockHeightBudget } from "../components/dock-height.ts";

describe("the open check's height", () => {
	it("the folded body with the bar swapped for the form, plus what sits outside the viewport", () => {
		assert.equal(openCheckBlockHeight({ columnHeight: 900, outsideHeight: 60, bodyHeight: 140, contentHeight: 56, formHeight: 380 }), 60 + 140 - 56 + 380);
	});

	it("capped as the open dock's budget caps it, so the estimate matches the open dock in a short window", () => {
		const m = { columnHeight: 500, outsideHeight: 60, bodyHeight: 140, contentHeight: 56, formHeight: 700 };
		const open = openCheckBlockHeight(m);
		// dockHeightBudget for the open dock with the same parts: the viewport
		// is capped at its viewportMaxHeight, the block is that plus the outside.
		const budget = dockHeightBudget({ columnHeight: 500, outsideHeight: 60, beforeShellHeight: 82, shellBorderHeight: 2, contentHeight: 700, questionHeight: 600, questionPaddingHeight: 12 });
		assert.equal(open, 60 + budget.viewportMaxHeight);
		assert.equal(open, 500 - 32);
	});

	it("never negative", () => {
		assert.equal(openCheckBlockHeight({ columnHeight: 10, outsideHeight: 60, bodyHeight: 0, contentHeight: 50, formHeight: 0 }), 60);
	});
});

describe("the blank space and the resting point", () => {
	it("the blank space is the reserve beyond the folded dock", () => {
		assert.equal(blankSpaceExtra(526, 130, 96), 300);
		assert.equal(blankSpaceExtra(200, 130, 96), 0);
	});
	it("the resting point is the real target less the blank space, never above the top", () => {
		assert.equal(restingTarget(9000, 300), 8700);
		assert.equal(restingTarget(100, 300), 0);
	});
});

describe("when reaching the bottom opens the waiting check", () => {
	const EXPAND = 16;
	it("only once the blank space is there, the lesson was seen away from the bottom, and the scroll moved down into it", () => {
		const s = createCheckSpace();
		noteCheckPlace(s, 1000, 0, EXPAND, 700);
		assert.equal(checkOpensOnScroll(s, 0, EXPAND), false, "no blank space yet");
		offerCheckSpace(s, 300);
		assert.equal(s.ready, true);
		assert.equal(checkOpensOnScroll(s, 0, EXPAND), false, "never seen away since");
		noteCheckPlace(s, 700, 300, EXPAND, 700); // the resting point: up from 1000
		assert.equal(s.away, true);
		assert.equal(s.movedDown, false);
		noteCheckPlace(s, 990, 10, EXPAND, 700);
		assert.equal(checkOpensOnScroll(s, 10, EXPAND), true, "scrolled down into it");
		assert.equal(checkOpensOnScroll(s, 20, EXPAND), false, "not yet within reach");
	});

	it("a clamp that moves the lesson up to its bottom doesn't open it", () => {
		const s = createCheckSpace();
		offerCheckSpace(s, 300);
		noteCheckPlace(s, 700, 300, EXPAND, 700);
		noteCheckPlace(s, 850, 150, EXPAND, 700);
		noteCheckPlace(s, 650, 0, EXPAND, 700); // the scroller grew: clamped up
		assert.equal(checkOpensOnScroll(s, 0, EXPAND), false);
	});

	it("a look with the lesson unmoved keeps the last direction", () => {
		const s = createCheckSpace();
		offerCheckSpace(s, 300);
		noteCheckPlace(s, 700, 300, EXPAND, 700);
		noteCheckPlace(s, 995, 5, EXPAND, 700);
		noteCheckPlace(s, 995, 5, EXPAND, 700);
		assert.equal(checkOpensOnScroll(s, 5, EXPAND), true);
	});

	it("an offer again keeps what was seen; a new question starts again", () => {
		const s = createCheckSpace();
		offerCheckSpace(s, 300);
		noteCheckPlace(s, 700, 300, EXPAND, 700);
		offerCheckSpace(s, 360);
		assert.equal(s.away, true);
		assert.equal(s.extra, 360);
		resetCheckSpace(s);
		assert.deepEqual(s, createCheckSpace());
	});
});

describe("keeping the lesson at its resting point", () => {
	const EXPAND = 16;
	it("at rest, what is under it got shorter (nothing moved it): back to the rest", () => {
		const s = createCheckSpace();
		offerCheckSpace(s, 300);
		noteCheckPlace(s, 700, 300, EXPAND, 700);
		// 400 px of the text came out shorter than estimated: the rest is now 300.
		assert.equal(backToRest(s, 700, 300), true);
		// The browser clamped it up a little on the way: still back to the rest.
		assert.equal(backToRest(s, 690, 300), true);
	});
	it("a learner who scrolled into the blank space, or is scrolling down now, is left where they are", () => {
		const s = createCheckSpace();
		offerCheckSpace(s, 300);
		noteCheckPlace(s, 850, 150, EXPAND, 700);
		assert.equal(backToRest(s, 850, 500), false, "in the blank space");
	});
	it("at rest, scroll anchoring moved it down while the text under it got shorter: back to the rest", () => {
		const s = createCheckSpace();
		offerCheckSpace(s, 300);
		noteCheckPlace(s, 700, 300, EXPAND, 700);
		// A message above grew by 545 (scrollTop with it), the ones below shrank by 332.
		assert.equal(backToRest(s, 1245, 913), true);
	});
	it("not before a first look, and not when it is still at or above the rest", () => {
		const s = createCheckSpace();
		assert.equal(backToRest(s, 700, 300), false);
		noteCheckPlace(s, 500, 500, EXPAND, 700);
		assert.equal(backToRest(s, 500, 600), false);
	});
	it("the real target is use-stick-to-bottom's: 1 px short of the bottom", () => {
		assert.equal(bottomTarget({ scrollHeight: 2000, clientHeight: 600 }), 1399);
	});
});

describe("measuring the open form while folded", () => {
	it("reads the hidden form, with its question area's natural height", () => {
		const { document } = parseHTML(`<div id="column"></div><div id="block"><div id="viewport"><div id="body"><div id="content"><button></button><div data-dock-open-form=""><div id="form"><div id="area" data-dock-scroll-area=""></div></div></div></div></div></div></div>`);
		const rect = (h: number) => () => ({ height: h }) as DOMRect;
		const el = (id: string) => document.getElementById(id) as unknown as HTMLElement;
		Object.defineProperty(el("column"), "clientHeight", { value: 900 });
		el("block").getBoundingClientRect = rect(200);
		el("viewport").getBoundingClientRect = rect(140);
		el("body").getBoundingClientRect = rect(140);
		el("content").getBoundingClientRect = rect(56);
		el("form").getBoundingClientRect = rect(400);
		el("area").getBoundingClientRect = rect(300); // capped at 55dvh while folded
		Object.defineProperty(el("area"), "scrollHeight", { value: 360 });
		const h = measureOpenCheck({ column: el("column"), block: el("block"), viewport: el("viewport"), body: el("body"), content: el("content") });
		assert.equal(h, 60 + 140 - 56 + 460);
	});

	it("nothing to measure without the form (a malformed question)", () => {
		const { document } = parseHTML(`<div id="content"><p>Malformed</p></div>`);
		const content = document.getElementById("content") as unknown as HTMLElement;
		assert.equal(measureOpenCheck({ column: content, block: content, viewport: content, body: content, content }), null);
	});
});
