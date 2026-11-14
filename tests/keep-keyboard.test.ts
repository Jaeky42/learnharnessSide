/**
 * KEEP THE KEYBOARD PINS (owner's decision, iPhone): a tap beside the box
 * being typed in acts and leaves the keyboard up; a tap anywhere else acts
 * and the keyboard closes. The rules in components/phone/keep-keyboard.ts,
 * the listener driven with scripted mousedowns, and phone-viewport.tsx's
 * keyboard-closing step (one frame later, so the tap lands; and a focused box
 * that leaves the page counts as a lost focus), mounted with a fake visual
 * viewport.
 */

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML(`<html><body>
	<div id="topbar"><button id="top-button">Menu</button></div>
	<div id="lesson"><p id="lesson-text">Text</p></div>
	<div data-phone="dock" id="dock">
		<textarea id="box"></textarea>
		<textarea id="box2"></textarea>
		<input id="text-input" type="text" />
		<button id="send">Send</button>
		<span id="send-icon"></span>
		<select id="pick"><option>a</option></select>
		<input id="range" type="range" min="0" max="100" step="1" value="50" />
		<input id="range-off" type="range" min="0" max="100" step="1" value="50" disabled />
		<div id="bubble" data-phone="tutor-bubble"><span id="bubble-icon"></span></div>
		<div class="cm-editor"><div id="cm" contenteditable="true"></div></div>
	</div>
	<div data-phone="tutor-sheet" id="sheet">
		<div id="sheet-bar"><button id="sheet-minimize">Minimize</button></div>
		<div id="passage" data-phone="tutor-typing"><button id="drop">x</button></div>
		<div id="typing-row" data-phone="tutor-typing"><textarea id="ask"></textarea><button id="ask-send">Send</button></div>
	</div>
</body></html>`);
const { document } = dom;

let phone = true;
let touch = true;
let active: Element | null = null;
Object.defineProperty(document, "activeElement", { configurable: true, get: () => active ?? document.body });

// A visual viewport the tests resize, and a frame queue they step by hand.
const vvListeners = new Map<string, Set<() => void>>();
const visual = {
	height: 800,
	offsetTop: 0,
	scale: 1,
	addEventListener: (type: string, fn: () => void) => void (vvListeners.get(type) ?? vvListeners.set(type, new Set()).get(type)!).add(fn),
	removeEventListener: (type: string, fn: () => void) => void vvListeners.get(type)?.delete(fn),
};
const frames = new Map<number, () => void>();
let frameId = 0;
const runFrames = () => {
	const due = [...frames.entries()];
	frames.clear();
	for (const [, fn] of due) fn();
};
Object.assign(dom.window, {
	innerWidth: 390,
	innerHeight: 800,
	scrollY: 0,
	scrollTo() {},
	screen: { width: 390, height: 844 },
	visualViewport: visual,
	setTimeout,
	clearTimeout,
	requestAnimationFrame: (fn: () => void) => {
		frames.set(++frameId, fn);
		return frameId;
	},
	cancelAnimationFrame: (id: number) => void frames.delete(id),
	matchMedia: (query: string) => ({
		matches: query.includes("max-width") ? phone : query === "(pointer: coarse)" ? touch : false,
		addEventListener() {},
		removeEventListener() {},
	}),
});
Object.assign(globalThis, {
	window: dom.window,
	document,
	MutationObserver: dom.window.MutationObserver,
	CustomEvent: dom.window.CustomEvent,
});

const { boxGone, PhoneViewport } = await import("../components/phone/phone-viewport.tsx");
const { installKeepKeyboard, keepsKeyboard, rangeValueAt, KEEP_BLOCKS, KEEP_EXCEPT, RANGE_THUMB_PX } = await import("../components/phone/keep-keyboard.ts");

const el = (id: string) => document.getElementById(id)!;

describe("which presses keep the keyboard", () => {
	it("keeps it for a button, a slider and an icon in the dock beside the focused box", () => {
		assert.equal(keepsKeyboard(el("box"), el("send")), true);
		assert.equal(keepsKeyboard(el("box"), el("send-icon")), true, "inside a button's contents too, found by its block");
		assert.equal(keepsKeyboard(el("box"), el("range")), true);
	});
	it("leaves a press in the focused box, on another text box, a select or the editor alone", () => {
		assert.equal(keepsKeyboard(el("box"), el("box")), false);
		assert.equal(keepsKeyboard(el("box"), el("box2")), false);
		assert.equal(keepsKeyboard(el("box"), el("text-input")), false);
		assert.equal(keepsKeyboard(el("box"), el("pick")), false);
		assert.equal(keepsKeyboard(el("box"), el("cm")), false);
	});
	it("closes the keyboard for a press outside the focused box's block", () => {
		assert.equal(keepsKeyboard(el("box"), el("top-button")), false);
		assert.equal(keepsKeyboard(el("box"), el("lesson-text")), false);
		assert.equal(keepsKeyboard(el("box"), el("sheet-minimize")), false, "the sheet's top bar");
		assert.equal(keepsKeyboard(el("box"), el("ask-send")), false, "another block");
	});
	it("needs a typing box to have the focus, and a target that is an element", () => {
		assert.equal(keepsKeyboard(null, el("send")), false);
		assert.equal(keepsKeyboard(el("send"), el("send")), false, "a button focused");
		assert.equal(keepsKeyboard(el("range"), el("send")), false, "a slider focused");
		assert.equal(keepsKeyboard(el("box"), null), false);
		assert.equal(keepsKeyboard(el("box"), document as unknown as EventTarget), false);
	});
	it("lets the Tutor's bubble act and close the keyboard", () => {
		assert.equal(keepsKeyboard(el("box"), el("bubble")), false);
		assert.equal(keepsKeyboard(el("box"), el("bubble-icon")), false);
	});
	it("keeps it in the Tutor sheet's typing row and its sibling passage row, not its top bar", () => {
		assert.equal(keepsKeyboard(el("ask"), el("ask-send")), true);
		assert.equal(keepsKeyboard(el("ask"), el("drop")), true, "the waiting passage's ✕");
		assert.equal(keepsKeyboard(el("ask"), el("ask")), false);
		assert.equal(keepsKeyboard(el("ask"), el("sheet-minimize")), false);
		assert.equal(keepsKeyboard(el("ask"), el("send")), false, "the lesson's dock is another block");
	});
	it("names its blocks as the code and the Tutor's markup do", () => {
		assert.equal(KEEP_BLOCKS, '[data-phone="dock"], [data-phone="tutor-typing"]');
		assert.equal(KEEP_EXCEPT, '[data-phone="tutor-bubble"]');
		const tutor = readFileSync(path.resolve(import.meta.dirname, "../components/side-tutor.tsx"), "utf8");
		assert.match(tutor, /data-testid="side-tutor-passage" data-phone="tutor-typing"/);
		assert.match(tutor, /data-phone="tutor-typing" className=\{cn\("flex items-end gap-2 p-2"/);
		assert.match(tutor, /data-phone=\{?"tutor-bubble"/);
	});
});

describe("a slider's value from where it was pressed", () => {
	const rect = { left: 100, width: 216 }; // 200 px of travel with the 16 px knob
	it("follows the knob's centre, clamped at both ends", () => {
		assert.equal(rangeValueAt(100, rect, 0, 100, 1), 0);
		assert.equal(rangeValueAt(0, rect, 0, 100, 1), 0, "left of the slider");
		assert.equal(rangeValueAt(200 + RANGE_THUMB_PX / 2, rect, 0, 100, 1), 50, "the middle");
		assert.equal(rangeValueAt(316, rect, 0, 100, 1), 100);
		assert.equal(rangeValueAt(900, rect, 0, 100, 1), 100, "right of the slider");
	});
	it("rounds to the step from the minimum, and treats a bad step as 1", () => {
		assert.equal(rangeValueAt(100 + 8 + 47, rect, 0, 100, 25), 25);
		assert.equal(rangeValueAt(100 + 8 + 47, rect, 10, 110, 25), 35);
		assert.equal(rangeValueAt(100 + 8 + 100.4, rect, 0, 100, 0), 50);
		assert.equal(rangeValueAt(100 + 8 + 100.4, rect, 0, 100, NaN), 50);
	});
	it("copes with a slider no wider than its knob", () => {
		assert.equal(rangeValueAt(5, { left: 0, width: 10 }, 0, 10, 1), 0);
	});
});

describe("the mousedown listener", () => {
	let uninstall = () => {};
	afterEach(() => {
		uninstall();
		uninstall = () => {};
		active = null;
		phone = true;
		touch = true;
	});
	function press(target: Element, clientX = 0) {
		const e = new dom.window.Event("mousedown", { bubbles: true, cancelable: true });
		Object.assign(e, { clientX, clientY: 0, button: 0 });
		target.dispatchEvent(e);
		return e;
	}

	it("stops the focus leaving the box when a button beside it is pressed, and nothing else", () => {
		uninstall = installKeepKeyboard(document);
		active = el("box");
		assert.equal(press(el("send")).defaultPrevented, true);
		assert.equal(press(el("top-button")).defaultPrevented, false);
		assert.equal(press(el("box")).defaultPrevented, false);
		assert.equal(press(el("bubble")).defaultPrevented, false);
	});
	it("does nothing off a touch phone, or when the listener is removed", () => {
		uninstall = installKeepKeyboard(document);
		active = el("box");
		phone = false;
		assert.equal(press(el("send")).defaultPrevented, false, "the computer layout");
		phone = true;
		touch = false;
		assert.equal(press(el("send")).defaultPrevented, false, "a phone-width window with a mouse");
		touch = true;
		uninstall();
		uninstall = () => {};
		assert.equal(press(el("send")).defaultPrevented, false, "removed");
	});
	it("sets a slider from the press point with exactly one bubbling input event", () => {
		uninstall = installKeepKeyboard(document);
		active = el("box");
		const range = el("range") as HTMLInputElement;
		Object.assign(range, { getBoundingClientRect: () => ({ left: 100, width: 216, top: 0, height: 20 }) });
		const seen: string[] = [];
		const onInput = (e: Event) => seen.push(`${(e.target as HTMLInputElement).value}:${e.bubbles}`);
		document.addEventListener("input", onInput);
		try {
			assert.equal(press(range, 100 + 8 + 50).defaultPrevented, true);
			assert.equal(range.value, "25");
			assert.deepEqual(seen, ["25:true"]);
			press(range, 100 + 8 + 50);
			assert.equal(seen.length, 1, "the same value again announces nothing");
		} finally {
			document.removeEventListener("input", onInput);
			range.value = "50";
		}
	});
	it("gives a disabled slider no value", () => {
		uninstall = installKeepKeyboard(document);
		active = el("box");
		const range = el("range-off") as HTMLInputElement;
		Object.assign(range, { getBoundingClientRect: () => ({ left: 100, width: 216, top: 0, height: 20 }) });
		let inputs = 0;
		const onInput = () => void inputs++;
		document.addEventListener("input", onInput);
		try {
			press(range, 100 + 8 + 20);
			assert.equal(range.value, "50");
			assert.equal(inputs, 0);
		} finally {
			document.removeEventListener("input", onInput);
		}
	});
});

describe("the keyboard's closing step (phone-viewport.tsx)", () => {
	const roots: { root: Root; host: HTMLElement }[] = [];
	const vvh = () => document.documentElement.style.getPropertyValue("--lh-vvh");
	function focusEvent(type: "focusin" | "focusout", target: Element, relatedTarget: Element | null = null) {
		const e = new dom.window.Event(type, { bubbles: true });
		Object.assign(e, { relatedTarget });
		target.dispatchEvent(e);
	}
	async function mount() {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		roots.push({ root, host });
		await act(async () => root.render(React.createElement(PhoneViewport)));
	}
	/** A box in the page that a test may remove again. */
	function addBox(id: string) {
		const box = document.createElement("textarea");
		box.id = id;
		el("dock").appendChild(box);
		return box;
	}
	afterEach(async () => {
		for (const { root, host } of roots.splice(0)) {
			await act(async () => root.unmount());
			host.remove();
		}
		visual.height = 800;
		active = null;
		frames.clear();
		for (const id of ["tmp", "tmp2"]) document.getElementById(id)?.remove();
	});

	it("keeps the keyboard-up height through the focus change and takes the full height one frame later", async () => {
		await mount();
		visual.height = 500; // the keyboard is up
		active = el("box");
		focusEvent("focusin", el("box"));
		assert.equal(vvh(), "500px");
		active = null;
		focusEvent("focusout", el("box"));
		assert.equal(vvh(), "500px", "a tap's mouseup and click still find the button where it was");
		assert.equal(frames.size, 1, "one frame is waiting");
		await act(async () => runFrames());
		assert.equal(vvh(), "800px");
	});
	it("does the same when the focused box leaves the page with no blur", async () => {
		await mount();
		visual.height = 500;
		const box = addBox("tmp");
		active = box;
		focusEvent("focusin", box);
		box.remove();
		active = null;
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
		assert.equal(frames.size, 1, "noticed without a focusout");
		assert.equal(vvh(), "500px");
		await act(async () => runFrames());
		assert.equal(vvh(), "800px");
	});
	it("takes no full height when focus moves to another text box before the frame", async () => {
		await mount();
		visual.height = 500;
		active = el("box");
		focusEvent("focusin", el("box"));
		active = null;
		focusEvent("focusout", el("box"));
		active = el("box2");
		focusEvent("focusin", el("box2"));
		assert.equal(frames.size, 0, "the pending frame was cancelled");
		await act(async () => runFrames());
		assert.equal(vvh(), "500px");
	});
	it("takes a new box after the old one was removed without a blur", async () => {
		await mount();
		visual.height = 500;
		const first = addBox("tmp");
		active = first;
		focusEvent("focusin", first);
		first.remove();
		const second = addBox("tmp2");
		active = second;
		focusEvent("focusin", second);
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
		await act(async () => runFrames());
		assert.equal(vvh(), "500px", "the keyboard is still up for the new box");
		second.remove();
		active = null;
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
		await act(async () => runFrames());
		assert.equal(vvh(), "800px");
	});
	it("cancels the pending frame when the page unmounts", async () => {
		await mount();
		visual.height = 500;
		active = el("box");
		focusEvent("focusin", el("box"));
		active = null;
		focusEvent("focusout", el("box"));
		assert.equal(frames.size, 1);
		const { root, host } = roots.pop()!;
		await act(async () => root.unmount());
		host.remove();
		assert.equal(frames.size, 0);
	});
	it("knows a box that left the page", () => {
		assert.equal(boxGone({ isConnected: false }), true);
		assert.equal(boxGone({ isConnected: true }), false);
		assert.equal(boxGone(null), false);
	});
});
