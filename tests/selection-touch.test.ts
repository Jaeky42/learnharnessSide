/**
 * HIGHLIGHT, THEN ASK ON A TOUCH SCREEN (side-tutor fork; owner's iPhone and
 * iPad: a press-and-hold selection showed only the system's own Copy / Look
 * Up box, never the app's Cite and Ask). The rules are in
 * components/phone/touch-selection.ts; the timing in
 * components/selection-actions.ts. A mouse is pinned unchanged here too.
 */

import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Quote } from "lucide-react";
import { SelectionToolbarButtons } from "../components/selection-toolbar.tsx";
import { describe, it } from "node:test";
import { observeSelectionActions, resolveSelectionActionPosition, type SelectionActionPoint } from "../components/selection-actions.ts";
import {
	resolveTouchSelectionPosition, systemBoxBelow, SYSTEM_BOX_CLEARANCE, SYSTEM_BOX_SWITCH, TOUCH_ACTION_RELEASE_MS,
	TOUCH_FINGER_WAIT_MS, TOUCH_HANDLE_GAP, TOUCH_SETTLE_MS, TOUCH_TOOLBAR_HEIGHT,
	fixedFrameTop, touchSelectionHere, touchToolbarTop, visibleLessonBounds,
} from "../components/phone/touch-selection.ts";

/** The owner's iPhone, home-screen app: 440 × 956 points; the lesson runs
 *  from the top bar's bottom (147) to the question bar (about 830). */
const phone = { bounds: { left: 0, top: 147, right: 440, bottom: 830 }, visible: { top: 0, height: 956 }, viewportWidth: 440 };
const word = (centre: number, left = 120, right = 190) => ({ left, right, top: centre - 12, bottom: centre + 12 });
const fiveLines = { first: { left: 20, right: 420, top: 404, bottom: 428 }, last: { left: 20, right: 200, top: 499, bottom: 523 } };

describe("where the system's box goes (the owner's measurements)", () => {
	const rows: [string, ReturnType<typeof word>, ReturnType<typeof word>, boolean][] = [
		["one word at 327", word(327), word(327), true],
		["one word at 414", word(414), word(414), true],
		["five lines, 404 to 523", fiveLines.first, fiveLines.last, true],
		["one word at 550", word(550), word(550), false],
		["one word at 646", word(646), word(646), false],
	];
	for (const [name, first, last, below] of rows) {
		it(`${name}: the system's box ${below ? "below" : "above"}, the buttons ${below ? "above the start" : "below the end"}`, () => {
			assert.equal(systemBoxBelow(first, last, phone.visible), below);
			const at = resolveTouchSelectionPosition({ ...phone, firstLine: first, lastLine: last });
			if (below) assert.deepEqual(at, { x: first.left, y: first.top - TOUCH_HANDLE_GAP - TOUCH_TOOLBAR_HEIGHT, side: "above-start" });
			else assert.deepEqual(at, { x: last.right, y: last.bottom + TOUCH_HANDLE_GAP, side: "below-end" });
		});
	}
	it("the middle is the visible height's (clock strip counted), not innerHeight's: 894 would put the five lines above", () => {
		assert.equal(SYSTEM_BOX_SWITCH, 0.5);
		assert.equal(systemBoxBelow(fiveLines.first, fiveLines.last, { top: 0, height: 894 }), false);
		assert.equal(systemBoxBelow(fiveLines.first, fiveLines.last, { top: 0, height: 956 }), true);
	});
	it("the gap clears the handle knobs (about 12 points beyond the line), a tiny bit closer than at first", () => {
		assert.equal(TOUCH_HANDLE_GAP, 18);
		assert.ok(TOUCH_HANDLE_GAP > 12);
	});
	it("beyond the system's box (about 43 pt tall, 15 to 19 pt from the text) clears it", () => {
		assert.equal(SYSTEM_BOX_CLEARANCE, 70);
		assert.ok(SYSTEM_BOX_CLEARANCE > 19 + 43);
	});
});

describe("the touch buttons' size (owner: a little bigger)", () => {
	const capture = { messageId: "m", range: {} as Range, selector: { text: "x", start: 0, end: 1, prefix: "", suffix: "" } };
	const actions = [{ id: "cite", label: "Cite", ariaLabel: "Cite", icon: Quote, visible: () => true, onSelect: () => true }];
	const classes = (touch?: boolean) => /class="([^"]*)"/.exec(renderToStaticMarkup(createElement(SelectionToolbarButtons, { capture, actions, onDone: () => {}, touch })))![1]!
		.replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").split(/\s+/);
	it("32 px tall, 15 px text, a 16 px icon, more side padding, on touch only", () => {
		assert.equal(TOUCH_TOOLBAR_HEIGHT, 32);
		const touch = classes(true);
		for (const c of ["h-8", "text-[15px]", "[&_svg]:size-4", "px-3", "has-[>svg]:px-3"]) assert.ok(touch.includes(c), c);
		for (const c of ["h-6", "text-xs", "has-[>svg]:px-1.5"]) assert.ok(!touch.includes(c), c);
		assert.ok(touch.includes("bg-popover") && touch.includes("dark:bg-popover"), "same look");
	});
	it("a mouse's buttons keep upstream's xs size", () => {
		const mouse = classes();
		for (const c of ["h-6", "text-xs"]) assert.ok(mouse.includes(c), c);
		assert.ok(!mouse.includes("h-8"));
	});
});

describe("resolveTouchSelectionPosition when the buttons' side has no room", () => {
	it("a selection right under the top bar: below the end, beyond the system's box", () => {
		const first = word(165);
		assert.deepEqual(resolveTouchSelectionPosition({ ...phone, firstLine: first, lastLine: first }),
			{ x: first.right, y: first.bottom + SYSTEM_BOX_CLEARANCE, side: "below-end" });
	});
	it("a selection right above the dock: above the start, beyond the system's box", () => {
		const last = word(812);
		assert.deepEqual(resolveTouchSelectionPosition({ ...phone, firstLine: last, lastLine: last }),
			{ x: last.left, y: last.top - SYSTEM_BOX_CLEARANCE - TOUCH_TOOLBAR_HEIGHT, side: "above-start" });
	});
	it("a selection that fills the lesson: under the end, clamped inside the lesson and the screen", () => {
		const first = { left: 20, right: 420, top: 100, bottom: 124 };
		const last = { left: 20, right: 300, top: 880, bottom: 904 };
		assert.deepEqual(resolveTouchSelectionPosition({ ...phone, firstLine: first, lastLine: last }),
			{ x: 300, y: 830 - 8 - TOUCH_TOOLBAR_HEIGHT, side: "clamped" });
	});
	it("x stays 8 px inside the lesson; the measured height is used when known", () => {
		const first = word(300, -40, 10);
		assert.equal(resolveTouchSelectionPosition({ ...phone, firstLine: first, lastLine: first }).x, 8);
		assert.equal(resolveTouchSelectionPosition({ ...phone, firstLine: first, lastLine: first, toolbarHeight: 30 }).y, first.top - TOUCH_HANDLE_GAP - 30);
	});
	it("a mouse's placement is unchanged: the pointer, or 4 px under the end", () => {
		const bounds = { left: 100, top: 50, right: 700, bottom: 650 };
		const viewport = { width: 1000, height: 800 };
		assert.deepEqual(resolveSelectionActionPosition({ bounds, selectionRect: { left: 200, top: 100, right: 300, bottom: 120 }, pointer: { x: 250, y: 110 }, viewport }), { x: 250, y: 110 });
		assert.deepEqual(resolveSelectionActionPosition({ bounds, selectionRect: { left: 200, top: 100, right: 300, bottom: 120 }, pointer: null, viewport }), { x: 300, y: 124 });
	});
});

// A scripted page: one lesson element, a toolbar, and a clock moved by hand.
class FakeNode extends EventTarget {
	constructor(readonly kids: FakeNode[] = []) { super(); }
	contains(other: unknown): boolean { return other === this || this.kids.some((kid) => kid.contains(other)); }
	closest() { return null; }
}
function page(userAgent?: string) {
	let now = 0;
	let nextId = 1;
	const timers = new Map<number, { at: number; fn: () => void }>();
	const add = (fn: () => void, ms: number) => { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; };
	const view = Object.assign(new EventTarget(), {
		Node: FakeNode,
		navigator: userAgent === undefined ? undefined : { userAgent },
		setTimeout: (fn: () => void, ms = 0) => add(fn, ms),
		clearTimeout: (id: number) => void timers.delete(id),
		requestAnimationFrame: (fn: () => void) => add(fn, 16),
		cancelAnimationFrame: (id: number) => void timers.delete(id),
	});
	const doc = Object.assign(new EventTarget(), { defaultView: view });
	const text = new FakeNode();
	const element = Object.assign(new FakeNode([text]), { ownerDocument: doc });
	const button = new FakeNode();
	const toolbar = new FakeNode([button]);
	const log: string[] = [];
	const shown: { pointer: SelectionActionPoint | null; touch?: boolean; at: number }[] = [];
	const realNow = Date.now;
	Date.now = () => now;
	const observer = observeSelectionActions({
		element: element as unknown as HTMLElement,
		getActionElement: () => toolbar as unknown as HTMLElement,
		restoreAfterScroll: true,
		onSelection: (pointer, touch) => { shown.push({ pointer, touch, at: now }); log.push(touch ? "show touch" : "show"); },
		onDismiss: (reason) => log.push(`dismiss ${reason}`),
	});
	const advance = (ms: number) => {
		const end = now + ms;
		for (;;) {
			const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
			if (!due) break;
			timers.delete(due[0]);
			now = due[1].at;
			due[1].fn();
		}
		now = end;
	};
	const fire = (on: EventTarget, type: string, props: Record<string, unknown>) => {
		const event = new Event(type, { bubbles: true, cancelable: true });
		for (const [key, value] of Object.entries(props)) Object.defineProperty(event, key, { value });
		on.dispatchEvent(event);
	};
	return {
		observer, log, shown, advance, button,
		down: (pointerType: string, pointerId = 1, target: unknown = text) => fire(doc, "pointerdown", { pointerType, pointerId, button: 0, target, isPrimary: true }),
		up: (pointerType: string, pointerId = 1, target: unknown = text) => fire(doc, "pointerup", { pointerType, pointerId, button: 0, target }),
		cancel: (pointerType: string, pointerId = 1) => fire(view, "pointercancel", { pointerType, pointerId, target: text }),
		mouseup: (detail = 1, x = 50, y = 60) => fire(doc, "mouseup", { button: 0, detail, clientX: x, clientY: y, target: text }),
		click: (target: unknown) => fire(doc, "click", { target }),
		scroll: () => fire(element, "scroll", {}),
		contextmenu: () => fire(element, "contextmenu", {}),
		/** iOS's press and hold: the system takes the touch, then selects. */
		hold(pointerId = 1) { this.down("touch", pointerId); this.cancel("touch", pointerId); observer.selectionChanged(); },
		done() { observer.dispose(); Date.now = realNow; },
	};
}
const SHOW = TOUCH_SETTLE_MS + 16; // the settle time, then a frame

describe("observeSelectionActions on a touch screen", () => {
	it("a press-and-hold selection (pointerdown, pointercancel, no mouseup) shows once it has rested", () => {
		const p = page();
		p.down("touch");
		p.observer.selectionChanged();
		p.cancel("touch");
		p.observer.selectionChanged();
		p.advance(TOUCH_SETTLE_MS - 1);
		assert.equal(p.shown.length, 0);
		p.advance(17);
		assert.deepEqual(p.shown, [{ pointer: null, touch: true, at: SHOW }]);
		// Nothing stays stuck after the first touch (pointerDown used to).
		p.hold(2);
		p.advance(SHOW);
		assert.equal(p.shown.length, 2);
		p.done();
	});

	it("waits while a finger is down in the lesson", () => {
		const p = page();
		p.down("touch");
		p.observer.selectionChanged();
		p.advance(900);
		assert.equal(p.shown.length, 0);
		p.up("touch");
		p.advance(SHOW);
		assert.equal(p.shown.length, 1);
		p.done();
	});

	it("a finger that never reports lifting holds it back for a while only", () => {
		const p = page();
		p.down("touch");
		p.observer.selectionChanged();
		p.advance(TOUCH_FINGER_WAIT_MS + SHOW);
		assert.equal(p.shown.length, 1);
		p.done();
	});

	it("handle drags (selectionchange only) hide it, and it comes back once they rest", () => {
		const p = page();
		p.hold();
		p.advance(SHOW);
		assert.deepEqual(p.log, ["show touch"]);
		for (let i = 0; i < 5; i++) { p.observer.selectionChanged(); p.advance(100); }
		assert.deepEqual(p.log, ["show touch", "dismiss cancel"]);
		p.advance(SHOW - 100);
		assert.deepEqual(p.log, ["show touch", "dismiss cancel", "show touch"]);
		p.done();
	});

	it("a tap on a toolbar button keeps it while iOS collapses the selection, until its click has landed", () => {
		const p = page();
		p.hold();
		p.advance(SHOW);
		p.down("touch", 7, p.button);
		p.observer.selectionChanged(); // the tap cleared the selection first
		p.advance(1000);
		p.up("touch", 7, p.button);
		p.advance(10);
		assert.deepEqual(p.log, ["show touch"], "no dismiss before the click");
		p.click(p.button); // the action runs here, with the passage captured at show
		p.advance(0);
		assert.deepEqual(p.log, ["show touch", "dismiss cancel"]);
		// Then the selection is looked at again (the toolbar finds none and closes).
		p.advance(SHOW);
		assert.deepEqual(p.log, ["show touch", "dismiss cancel", "show touch"]);
		p.done();
	});

	it("a press on the toolbar that never clicks lets go after its release time", () => {
		const p = page();
		p.hold();
		p.advance(SHOW);
		p.down("touch", 7, p.button);
		p.observer.selectionChanged();
		p.up("touch", 7, p.button);
		p.advance(TOUCH_ACTION_RELEASE_MS - 1);
		assert.deepEqual(p.log, ["show touch"]);
		p.advance(1);
		assert.deepEqual(p.log, ["show touch", "dismiss cancel"]);
		p.done();
	});

	it("a press on the toolbar with the selection unchanged leaves it alone (a held session's greyed buttons)", () => {
		const p = page();
		p.hold();
		p.advance(SHOW);
		p.down("touch", 7, p.button);
		p.up("touch", 7, p.button);
		p.click(p.button);
		p.advance(2000);
		assert.deepEqual(p.log, ["show touch"]);
		p.done();
	});

	it("comes back after a scroll that cancelled the touch", () => {
		const p = page();
		p.hold();
		p.advance(SHOW);
		p.down("touch", 3);
		p.cancel("touch", 3);
		p.scroll();
		p.advance(1000);
		assert.equal(p.log.at(-1), "show touch");
		assert.equal(p.log.filter((entry) => entry === "show touch").length, 2);
		p.done();
	});

	it("a tap that leaves the selection as it was shows it again", () => {
		const p = page();
		p.hold();
		p.advance(SHOW);
		p.down("touch", 4);
		p.up("touch", 4);
		p.advance(SHOW);
		assert.deepEqual(p.log, ["show touch", "dismiss interaction", "show touch"]);
		p.done();
	});

	it("Android: a long press's contextmenu, then the selection, still shows", () => {
		const p = page();
		p.down("touch");
		p.observer.selectionChanged();
		p.contextmenu();
		p.cancel("touch");
		p.advance(SHOW);
		assert.equal(p.shown.length, 1);
		p.done();
	});

	it("a pen (Apple Pencil) counts as touch, and its compatibility mouseup changes nothing", () => {
		const p = page();
		p.down("pen");
		p.observer.selectionChanged();
		p.up("pen");
		p.mouseup();
		p.advance(16);
		assert.equal(p.shown.length, 0);
		p.advance(SHOW);
		assert.deepEqual(p.shown.map((s) => s.touch), [true]);
		p.done();
	});
});

describe("observeSelectionActions with a mouse (unchanged)", () => {
	it("a single click release: a timer of 0, then a frame, at the pointer", () => {
		const p = page();
		p.down("mouse");
		p.observer.selectionChanged(); // still dragging: nothing yet
		p.advance(1000);
		assert.equal(p.shown.length, 0);
		p.mouseup(1, 50, 60);
		p.advance(15);
		assert.equal(p.shown.length, 0);
		p.advance(1);
		assert.deepEqual(p.shown, [{ pointer: { x: 50, y: 60 }, touch: undefined, at: 1016 }]);
		p.done();
	});
	it("a double or triple click waits 500 ms", () => {
		const p = page();
		p.down("mouse");
		p.mouseup(2, 5, 6);
		p.advance(515);
		assert.equal(p.shown.length, 0);
		p.advance(1);
		assert.deepEqual(p.shown, [{ pointer: { x: 5, y: 6 }, touch: undefined, at: 516 }]);
		p.done();
	});
	it("after a touch, a mouse gesture is timed as before", () => {
		const p = page();
		p.hold();
		p.advance(SHOW);
		p.down("mouse", 9);
		p.observer.selectionChanged();
		p.mouseup(1, 10, 20);
		p.advance(16);
		assert.deepEqual(p.shown.at(-1), { pointer: { x: 10, y: 20 }, touch: undefined, at: SHOW + 16 });
		p.done();
	});
	it("a mouse pointercancel and a scroll still dismiss as before", () => {
		const p = page();
		p.down("mouse"); p.mouseup(); p.advance(16);
		p.cancel("mouse");
		assert.deepEqual(p.log, ["show", "dismiss cancel"]);
		p.down("mouse", 2); p.mouseup(); p.advance(16);
		p.scroll();
		p.advance(150 + 16);
		assert.deepEqual(p.log, ["show", "dismiss cancel", "show", "dismiss cancel", "show"]);
		p.done();
	});
});

// Review fixes: the dock, the desktop app, the shifted body.

/** An iPhone 13 in a Safari tab: lesson 60 to 664, top bar 0 to 60, dock 562 to 664. */
const phone13 = { lesson: { left: 0, top: 60, right: 390, bottom: 664 }, topBar: { left: 0, top: 0, right: 390, bottom: 60 }, dock: { left: 0, top: 562, right: 390, bottom: 664 } };
const lessonAt = (bounds: { left: number; top: number; right: number; bottom: number }, firstLine: { left: number; right: number; top: number; bottom: number }, lastLine = firstLine) =>
	resolveTouchSelectionPosition({ bounds, firstLine, lastLine, visible: { top: 0, height: 664 }, viewportWidth: 390 });

describe("visibleLessonBounds: the dock and the top bar cut the lesson's box", () => {
	it("the message box cuts the bottom at its top", () => {
		assert.deepEqual(visibleLessonBounds(phone13.lesson, phone13), { left: 0, right: 390, top: 60, bottom: 562 });
	});
	it("a tall dock (an open question) cuts higher", () => {
		assert.equal(visibleLessonBounds(phone13.lesson, { ...phone13, dock: { left: 0, top: 300, right: 390, bottom: 664 } }).bottom, 300);
	});
	it("no dock, or one not shown (no size), cuts nothing", () => {
		assert.deepEqual(visibleLessonBounds(phone13.lesson, {}), phone13.lesson);
		assert.deepEqual(visibleLessonBounds(phone13.lesson, { dock: { left: 0, top: 0, right: 0, bottom: 0 }, topBar: null }), phone13.lesson);
	});
	it("a top bar over the lesson's top cuts it at the bar's bottom", () => {
		assert.equal(visibleLessonBounds({ ...phone13.lesson, top: 0 }, phone13).top, 60);
	});
	it("a selection ending just above the message box: the buttons go above the start (the box's side), not over the message box", () => {
		const line = { left: 24, right: 120, top: 530, bottom: 552 };
		// Before: judged against the lesson's whole box, they sat on the message box.
		const before = lessonAt(phone13.lesson, line);
		assert.equal(before.side, "below-end");
		assert.ok(before.y + TOUCH_TOOLBAR_HEIGHT > phone13.dock.top);
		const after = lessonAt(visibleLessonBounds(phone13.lesson, phone13), line);
		assert.deepEqual(after, { x: 24, y: 530 - SYSTEM_BOX_CLEARANCE - TOUCH_TOOLBAR_HEIGHT, side: "above-start" });
	});
	it("with an open question the same rule holds above the question", () => {
		const bounds = visibleLessonBounds(phone13.lesson, { ...phone13, dock: { left: 0, top: 400, right: 390, bottom: 664 } });
		const at = lessonAt(bounds, { left: 24, right: 120, top: 350, bottom: 372 });
		assert.equal(at.side, "above-start");
		assert.ok(at.y + TOUCH_TOOLBAR_HEIGHT <= 400);
	});
	it("with no dock the lower half still goes below the end", () => {
		assert.equal(lessonAt(visibleLessonBounds(phone13.lesson, { topBar: phone13.topBar }), { left: 24, right: 120, top: 530, bottom: 552 }).side, "below-end");
	});
});

describe("the shifted body (iPhone keyboard up, Safari panned)", () => {
	const doc = (keyboard: boolean, top: number) => ({ body: { dataset: (keyboard ? { lhKeyboard: "" } : {}) as Record<string, string | undefined>, getBoundingClientRect: () => ({ top }) } });
	it("the fixed frame is the body's top while the keyboard is up, the screen otherwise", () => {
		assert.equal(fixedFrameTop(doc(true, 120)), 120);
		assert.equal(fixedFrameTop(doc(false, 120)), 0);
	});
	it("the toolbar's top is moved into the frame; with no shift it is upstream's clamp exactly", () => {
		for (const y of [-20, 5, 300, 900]) {
			assert.equal(touchToolbarTop({ y, height: 32, innerHeight: 664, shift: 0 }), Math.max(8, Math.min(y, 664 - 32 - 8)));
		}
		assert.equal(touchToolbarTop({ y: 300, height: 32, innerHeight: 664, shift: 120 }), 180);
	});
});

describe("the desktop app keeps upstream's behaviour for every gesture (a touch-screen PC too)", () => {
	const electron = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Electron/37.0.0 Safari/537.36";
	it("only a browser gets the touch path", () => {
		assert.equal(touchSelectionHere({ navigator: { userAgent: electron } }), false);
		assert.equal(touchSelectionHere({ navigator: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1" } }), true);
	});
	it("a finger selection waits for its mouseup and shows at the pointer, at once, as upstream's", () => {
		const p = page(electron);
		p.down("touch");
		p.observer.selectionChanged();
		p.advance(2000);
		assert.equal(p.shown.length, 0);
		p.mouseup(1, 70, 80);
		p.advance(16);
		assert.deepEqual(p.shown, [{ pointer: { x: 70, y: 80 }, touch: undefined, at: 2016 }]);
		p.done();
	});
	it("a pen there is upstream's too, and a touch pointercancel dismisses as before", () => {
		const p = page(electron);
		p.down("pen");
		p.mouseup();
		p.advance(16);
		assert.deepEqual(p.log, ["show"]);
		p.cancel("touch");
		assert.deepEqual(p.log, ["show", "dismiss cancel"]);
		p.done();
	});
});
