/**
 * IN STEP WITH THE KEYBOARD, through the mounted PhoneViewport: a fake
 * visualViewport stands in for the iPhone keyboard (its height is set and a
 * resize fired, as Safari does once the keyboard is up), focus events come
 * from real text boxes, and frames and the clock are scripted. What is
 * checked is --lh-vvh on <html>, frame by frame.
 */

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const FULL = 664;
const dom = parseHTML("<html><body></body></html>");
const storage = new Map<string, string>();
let now = 0;
let frames: Array<() => void> = [];
const timers: Array<{ at: number; cb: () => void; id: number }> = [];
let timerId = 1;
let reduced = false;
let visible = FULL;
const vvListeners = new Map<string, Set<() => void>>();
const fakeVV = {
	get height() { return visible; },
	get width() { return 390; },
	offsetTop: 0,
	offsetLeft: 0,
	scale: 1,
	addEventListener: (t: string, f: () => void) => { if (!vvListeners.has(t)) vvListeners.set(t, new Set()); vvListeners.get(t)?.add(f); },
	removeEventListener: (t: string, f: () => void) => void vvListeners.get(t)?.delete(f),
};
const mql = (query: string) => ({
	get matches() { return query.includes("max-width") ? true : query.includes("reduced-motion") ? reduced : false; },
	media: query,
	addEventListener() {},
	removeEventListener() {},
});
Object.assign(dom.window, {
	innerWidth: 390,
	innerHeight: FULL,
	scrollY: 0,
	scrollTo() {},
	screen: { width: 390, height: 844 },
	visualViewport: fakeVV,
	matchMedia: mql,
	requestAnimationFrame: (cb: () => void) => { frames.push(cb); return frames.length; },
	cancelAnimationFrame: () => {},
	setTimeout: (cb: () => void, ms: number) => { const id = timerId++; timers.push({ at: now + ms, cb, id }); return id; },
	clearTimeout: (id: number) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
	localStorage: {
		getItem: (k: string) => storage.get(k) ?? null,
		setItem: (k: string, v: string) => void storage.set(k, v),
		removeItem: (k: string) => void storage.delete(k),
	},
});
Object.defineProperty(performance, "now", { value: () => now, configurable: true, writable: true });
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
});
Object.defineProperty(globalThis, "Event", { value: dom.window.Event, configurable: true, writable: true });
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" }, configurable: true, writable: true });

const { PhoneViewport, KEYBOARD_MS, KEYBOARD_STORE_KEY, CORRECTION_MS, phoneLayoutHeight } = await import("../components/phone/phone-viewport.tsx");

/** <html>'s --lh-vvh: where the app rests. */
const vvh = () => Number.parseFloat(dom.document.documentElement.style.getPropertyValue("--lh-vvh"));
/** The height of this frame, mid-glide too. */
const live = () => phoneLayoutHeight() ?? Number.NaN;
/** Advances the clock frame by frame, recording --lh-vvh after each frame. */
function advance(ms: number): number[] {
	const seen: number[] = [];
	const end = now + ms;
	while (now < end) {
		now = Math.min(end, now + 16);
		for (const t of [...timers].sort((a, b) => a.at - b.at)) {
			if (t.at <= now) {
				timers.splice(timers.indexOf(t), 1);
				t.cb();
			}
		}
		const due = frames;
		frames = [];
		for (const f of due) f();
		seen.push(live());
	}
	return seen;
}
const keyboard = (px: number) => {
	visible = FULL - px;
	for (const f of vvListeners.get("resize") ?? []) f();
};
const focusOn = (el: Element) => el.dispatchEvent(new dom.window.Event("focusin", { bubbles: true }));
const blurFrom = (el: Element) => el.dispatchEvent(new dom.window.Event("focusout", { bubbles: true }));

let root: Root | null = null;
let box: Element;
beforeEach(async () => {
	now = 0;
	frames = [];
	timers.length = 0;
	visible = FULL;
	reduced = false;
	dom.document.body.innerHTML = '<div class="h-dvh"><textarea></textarea><button>b</button></div><div data-phone="tutor-sheet"></div>';
	box = dom.document.querySelector("textarea") as Element;
	const host = dom.document.createElement("div");
	dom.document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root?.render(<PhoneViewport />));
	advance(32);
});
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	storage.clear();
});

describe("the app's height with the iPhone keyboard", () => {
	it("the first time: nothing until Safari's height, then a glide; the next focus moves in step", () => {
		assert.equal(vvh(), FULL);
		focusOn(box);
		assert.deepEqual([...new Set(advance(KEYBOARD_MS))], [FULL], "nothing is known yet");
		keyboard(336);
		const glide = advance(300);
		const [g0 = Number.NaN] = glide;
		assert.ok(glide.length > 5 && g0 < FULL && g0 > FULL - 336, `glides: ${glide.slice(0, 4).join(", ")}…`);
		assert.equal(vvh(), FULL - 336);
		assert.deepEqual(JSON.parse(storage.get(KEYBOARD_STORE_KEY) ?? "{}"), { "tab-portrait": 336 });
		// Blur: back to full over the keyboard's time, before Safari reports it.
		blurFrom(box);
		const [back0 = Number.NaN] = advance(KEYBOARD_MS + 32);
		assert.ok(back0 > FULL - 336 && back0 < FULL);
		assert.equal(vvh(), FULL);
		keyboard(0);
		advance(100);
		assert.equal(vvh(), FULL);
		// Second focus: the glide starts at focus, before any resize.
		focusOn(box);
		const [inStep0 = Number.NaN] = advance(96);
		assert.ok(inStep0 < FULL, "moving from the first frame");
		// Mid-glide <html> keeps its value; the shell and the sheet move.
		const shell = dom.document.querySelector(".h-dvh") as HTMLElement;
		const sheet = dom.document.querySelector('[data-phone="tutor-sheet"]') as HTMLElement;
		assert.equal(vvh(), FULL);
		assert.equal(shell.style.getPropertyValue("height"), `${live()}px`);
		assert.equal(sheet.style.getPropertyValue("--lh-vvh"), `${live()}px`);
		advance(KEYBOARD_MS);
		assert.equal(shell.style.getPropertyValue("height"), "", "handed back to <html> at the end");
		assert.equal(sheet.style.getPropertyValue("--lh-vvh"), "");
		assert.equal(vvh(), FULL - 336, "there when the keyboard is");
		keyboard(336);
		assert.deepEqual([...new Set(advance(200))], [FULL - 336], "Safari agrees: nothing more moves");
	});
	it("a different keyboard is corrected with a short glide", () => {
		storage.set(KEYBOARD_STORE_KEY, JSON.stringify({ "tab-portrait": 300 }));
		focusOn(box);
		advance(KEYBOARD_MS + 32);
		assert.equal(vvh(), FULL - 300);
		keyboard(380);
		const [fix0 = Number.NaN] = advance(CORRECTION_MS + 32);
		assert.ok(fix0 < FULL - 300 && fix0 > FULL - 380, `a glide: ${fix0}`);
		assert.equal(vvh(), FULL - 380);
	});
	it("with reduced motion every step lands at once, as before", () => {
		reduced = true;
		storage.set(KEYBOARD_STORE_KEY, JSON.stringify({ "tab-portrait": 336 }));
		focusOn(box);
		assert.deepEqual([...new Set(advance(KEYBOARD_MS))], [FULL]);
		keyboard(336);
		assert.equal(vvh(), FULL - 336, "at the resize itself");
		blurFrom(box);
		assert.equal(vvh(), FULL, "at the blur itself");
	});
});
