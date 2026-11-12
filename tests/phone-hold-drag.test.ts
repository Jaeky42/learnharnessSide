/**
 * HOLD, THEN MOVE PINS: the touch rules in components/phone/long-press.ts,
 * driven with scripted pointer and touch events. Press and hold opens a
 * row's menu; on rows that can be dragged (notes and folders in the notes
 * drawer), moving the finger afterwards is a drag (owner's choice).
 *
 * What the notes list does with a drag (the label, the folder under the
 * finger, the drop) needs real layout and is checked in a browser.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { parseHTML } from "linkedom";

const dom = parseHTML(`<html><body>
	<div id="note" data-phone-press data-phone-drag><span id="label">Ohm's law</span></div>
	<div id="session" data-phone-press><span id="title">A session</span></div>
	<div id="plain">Not a row</div>
</body></html>`);
const { document } = dom;

let phone = true;
class FakeMouseEvent extends dom.window.Event {
	clientX: number;
	clientY: number;
	button: number;
	constructor(type: string, init: { bubbles?: boolean; cancelable?: boolean; clientX?: number; clientY?: number; button?: number } = {}) {
		super(type, init);
		this.clientX = init.clientX ?? 0;
		this.clientY = init.clientY ?? 0;
		this.button = init.button ?? 0;
	}
}
Object.assign(dom.window, {
	matchMedia: (query: string) => ({ matches: phone && query.includes("max-width"), addEventListener() {}, removeEventListener() {} }),
});
Object.assign(globalThis, { window: dom.window, document, CustomEvent: dom.window.CustomEvent, MouseEvent: FakeMouseEvent });

const { HOLD_DRAG_EVENT, HOLD_MS, installLongPress } = await import("../components/phone/long-press.ts");
type Detail = import("../components/phone/long-press.ts").HoldDragDetail;

const el = (id: string) => document.getElementById(id)!;
function pointer(type: string, target: Element, x: number, y: number, over: Record<string, unknown> = {}) {
	const e = new dom.window.Event(type, { bubbles: true, cancelable: true });
	Object.assign(e, { pointerType: "touch", isPrimary: true, pointerId: 1, clientX: x, clientY: y, ...over });
	target.dispatchEvent(e);
	return e;
}
function plain(type: string, target: Element) {
	const e = new dom.window.Event(type, { bubbles: true, cancelable: true });
	target.dispatchEvent(e);
	return e;
}

let uninstall = () => {};
let menus: { row: string; x: number; y: number; button: number }[] = [];
let drags: { phase: Detail["phase"]; x: number; y: number; row: string }[] = [];
const onMenu = (e: Event) => {
	const m = e as unknown as FakeMouseEvent;
	menus.push({ row: (e.currentTarget as Element).id, x: m.clientX, y: m.clientY, button: m.button });
};
const onDrag = (e: Event) => {
	const d = (e as CustomEvent<Detail>).detail;
	drags.push({ phase: d.phase, x: d.x, y: d.y, row: d.row.id });
};

beforeEach(() => {
	phone = true;
	menus = [];
	drags = [];
	mock.timers.enable({ apis: ["setTimeout"] });
	uninstall = installLongPress(document as unknown as Document);
	for (const id of ["note", "session", "plain"]) el(id).addEventListener("contextmenu", onMenu);
	document.addEventListener(HOLD_DRAG_EVENT, onDrag);
});
afterEach(() => {
	uninstall();
	for (const id of ["note", "session", "plain"]) el(id).removeEventListener("contextmenu", onMenu);
	document.removeEventListener(HOLD_DRAG_EVENT, onDrag);
	mock.timers.reset();
});

/** Finger down on a row and held until the menu opens. */
function hold(target: Element, x = 100, y = 200) {
	pointer("pointerdown", target, x, y);
	mock.timers.tick(HOLD_MS);
}

describe("press and hold", () => {
	it("opens the row's menu after half a second, where the finger is", () => {
		pointer("pointerdown", el("label"), 100, 200);
		mock.timers.tick(HOLD_MS - 1);
		assert.deepEqual(menus, []);
		mock.timers.tick(1);
		assert.deepEqual(menus, [{ row: "note", x: 100, y: 200, button: 2 }]);
	});

	it("lifting the finger leaves the menu open: no tap follows, and nothing is dragged", () => {
		hold(el("label"));
		pointer("pointerup", el("label"), 100, 200);
		assert.equal(plain("touchend", el("label")).defaultPrevented, true);
		// Browsers that send the tap anyway: it is swallowed once.
		assert.equal(plain("click", el("label")).defaultPrevented, true);
		assert.equal(plain("click", el("label")).defaultPrevented, false);
		assert.deepEqual(drags, []);
		assert.equal(menus.length, 1);
	});

	it("a finger that moves before the half second is scrolling: no menu, and the page may scroll", () => {
		pointer("pointerdown", el("label"), 100, 200);
		pointer("pointermove", el("label"), 100, 230);
		assert.equal(plain("touchmove", el("label")).defaultPrevented, false);
		mock.timers.tick(HOLD_MS * 2);
		assert.deepEqual(menus, []);
		assert.deepEqual(drags, []);
	});

	it("only for a finger, only on rows that ask for it", () => {
		pointer("pointerdown", el("plain"), 100, 200);
		mock.timers.tick(HOLD_MS);
		pointer("pointerdown", el("label"), 100, 200, { pointerType: "mouse" });
		mock.timers.tick(HOLD_MS);
		assert.deepEqual(menus, []);
	});

	it("on a tablet too: a wider screen in a browser has no right-click either (owner's choice)", () => {
		phone = false;
		pointer("pointerdown", el("label"), 100, 200);
		mock.timers.tick(HOLD_MS);
		assert.deepEqual(menus.map((m) => m.row), ["note"]);
	});

	it("never in the desktop app, also on a PC with a touch screen", () => {
		phone = false;
		const real = Object.getOwnPropertyDescriptor(globalThis, "navigator");
		Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/140.0.0.0 Electron/38.0.0 Safari/537.36" } });
		try {
			pointer("pointerdown", el("label"), 100, 200);
			mock.timers.tick(HOLD_MS);
			assert.deepEqual(menus, []);
		} finally {
			if (real) Object.defineProperty(globalThis, "navigator", real);
			else delete (globalThis as { navigator?: unknown }).navigator;
		}
	});
});

describe("hold, then move (dragging notes and folders on a phone)", () => {
	it("a small drift after the menu opens isn't a drag yet, but the page is already held still", () => {
		hold(el("label"));
		pointer("pointermove", el("label"), 104, 206);
		assert.deepEqual(drags, []);
		assert.equal(plain("touchmove", el("label")).defaultPrevented, true);
	});

	it("moving further starts the drag, follows the finger, and ends where it lifts", () => {
		hold(el("label"));
		pointer("pointermove", el("label"), 100, 230);
		pointer("pointermove", el("label"), 110, 300);
		assert.equal(plain("touchmove", el("label")).defaultPrevented, true);
		pointer("pointerup", el("label"), 120, 340);
		assert.deepEqual(drags, [
			{ phase: "start", x: 100, y: 230, row: "note" },
			{ phase: "move", x: 110, y: 300, row: "note" },
			{ phase: "end", x: 120, y: 340, row: "note" },
		]);
		// The drag is over: later movement means nothing, the page scrolls
		// again, and the lift still sends no tap.
		pointer("pointermove", el("label"), 130, 400);
		assert.equal(drags.length, 3);
		assert.equal(plain("touchend", el("label")).defaultPrevented, true);
		pointer("pointerdown", el("plain"), 10, 10);
		assert.equal(plain("touchmove", el("plain")).defaultPrevented, false);
		assert.equal(menus.length, 1);
	});

	it("a row that can't be dragged (a session) opens its menu and never drags", () => {
		hold(el("title"));
		pointer("pointermove", el("title"), 100, 300);
		assert.equal(plain("touchmove", el("title")).defaultPrevented, false);
		pointer("pointerup", el("title"), 100, 300);
		assert.deepEqual(menus, [{ row: "session", x: 100, y: 200, button: 2 }]);
		assert.deepEqual(drags, []);
	});

	it("a touch the phone takes away cancels the drag: nothing is moved", () => {
		hold(el("label"));
		pointer("pointermove", el("label"), 100, 260);
		pointer("pointercancel", el("label"), 100, 260);
		assert.deepEqual(drags.map((d) => d.phase), ["start", "cancel"]);
	});

	it("another finger doesn't steer the drag, and a new touch cancels it", () => {
		hold(el("label"));
		pointer("pointermove", el("label"), 100, 260);
		pointer("pointermove", el("label"), 300, 500, { pointerId: 2, isPrimary: false });
		pointer("pointerup", el("label"), 300, 500, { pointerId: 2, isPrimary: false });
		assert.deepEqual(drags.map((d) => d.phase), ["start"]);
		pointer("pointerdown", el("plain"), 300, 500, { pointerId: 3 });
		assert.deepEqual(drags.map((d) => d.phase), ["start", "cancel"]);
		pointer("pointerup", el("label"), 100, 260);
		assert.deepEqual(drags.map((d) => d.phase), ["start", "cancel"]);
	});
});
