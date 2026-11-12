/**
 * TOUCH TABLET PINS (owner's ask, iPad): a tablet in a browser gets the
 * computer layout, and the page still never moves under a finger there, as on
 * a phone. Two parts: app/touch.css (the page's bounce is off) and the window
 * lock (components/phone/window-lock.ts), which now holds at any width in a
 * browser and never in the desktop app.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";

const dom = parseHTML(`<html><body>
	<header id="bar">Top bar</header>
	<div id="lesson" data-overflow="auto"><p id="text">Lesson text</p></div>
	<div id="dock">An open question</div>
</body></html>`);
const { document } = dom;

// A wide screen: no phone layout. The user agent decides browser or desktop app.
let userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15";
Object.assign(dom.window, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
Object.defineProperty(globalThis, "navigator", { configurable: true, get: () => ({ userAgent }) });
Object.assign(globalThis, {
	window: dom.window,
	document,
	Element: dom.window.Element,
	getComputedStyle: (el: Element) => ({ overflowY: el.getAttribute("data-overflow") ?? "visible" }),
});

const { installWindowLock } = await import("../components/phone/window-lock.ts");
const { isBrowserNow, isPhoneNow } = await import("../components/phone/use-phone.ts");

const el = (id: string) => document.getElementById(id)!;
/** How far the lesson can scroll, and where it is. */
function lesson(scrollTop: number, scrollHeight = 2000, clientHeight = 600) {
	Object.defineProperties(el("lesson"), {
		scrollTop: { configurable: true, value: scrollTop },
		scrollHeight: { configurable: true, value: scrollHeight },
		clientHeight: { configurable: true, value: clientHeight },
	});
}
function touch(type: string, target: Element, points: [number, number][]) {
	const e = new dom.window.Event(type, { bubbles: true, cancelable: true });
	Object.assign(e, { touches: points.map(([clientX, clientY]) => ({ clientX, clientY })) });
	target.dispatchEvent(e);
	return e;
}
/** One finger down on `target`, moved by (dx, dy): was the page's own move stopped? */
function drag(target: Element, dx: number, dy: number, fingers = 1): boolean {
	const at = (x: number, y: number): [number, number][] => Array.from({ length: fingers }, (_, i) => [x + i * 40, y]);
	touch("touchstart", target, at(300, 300));
	const move = touch("touchmove", target, at(300 + dx, 300 + dy));
	touch("touchend", target, []);
	return move.defaultPrevented;
}

let uninstall = () => {};
afterEach(() => {
	uninstall();
	userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15";
});

describe("the page never moves under a finger on a tablet (computer layout, in a browser)", () => {
	it("this is not the phone layout, and it is a browser", () => {
		assert.equal(isPhoneNow(), false);
		assert.equal(isBrowserNow(), true);
	});

	it("a drag that starts where nothing can scroll is stopped: the top bar, the dock", () => {
		uninstall = installWindowLock(document as unknown as Document);
		assert.equal(drag(el("bar"), 0, 60), true, "pulling down on the top bar doesn't pull the page");
		assert.equal(drag(el("bar"), 0, -60), true);
		assert.equal(drag(el("dock"), 2, 80), true, "nor on an open question");
	});

	it("the lesson still scrolls by itself, and only its ends hand nothing to the page", () => {
		uninstall = installWindowLock(document as unknown as Document);
		lesson(400);
		assert.equal(drag(el("text"), 0, 60), false, "mid-way: the lesson's own scrolling");
		assert.equal(drag(el("text"), 0, -60), false);
		lesson(0);
		assert.equal(drag(el("text"), 0, 60), true, "at its top, pulling down would pull the page: stopped");
		assert.equal(drag(el("text"), 0, -60), false, "pushing up still scrolls the lesson");
		lesson(1400);
		assert.equal(drag(el("text"), 0, -60), true, "at its bottom, pushing up is stopped");
	});

	it("sideways drags and two fingers (a pinch) are left alone", () => {
		uninstall = installWindowLock(document as unknown as Document);
		assert.equal(drag(el("bar"), 80, 10), false);
		assert.equal(drag(el("bar"), 0, 60, 2), false);
	});

	it("the desktop app is never touched, also on a PC with a touch screen", () => {
		userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Electron/38.0.0 Safari/537.36";
		assert.equal(isBrowserNow(), false);
		uninstall = installWindowLock(document as unknown as Document);
		assert.equal(drag(el("bar"), 0, 60), false);
	});
});

describe("which screens count as touch screens", () => {
	it("the phone layout, or a wider browser screen that can be touched; never the desktop app", async () => {
		const { isTouchScreenNow } = await import("../components/phone/use-phone.ts");
		const media = (on: string[]) => Object.assign(dom.window, { matchMedia: (q: string) => ({ matches: on.some((x) => q.includes(x)), addEventListener() {}, removeEventListener() {} }) });
		try {
			media([]);
			assert.equal(isTouchScreenNow(), false, "a computer with a mouse");
			media(["any-pointer: coarse"]);
			assert.equal(isTouchScreenNow(), true, "a tablet, also with a trackpad attached");
			media(["max-width"]);
			assert.equal(isTouchScreenNow(), true, "the phone layout, as before");
			media(["any-pointer: coarse"]);
			userAgent = "Mozilla/5.0 (Windows NT 10.0) Chrome/140.0.0.0 Electron/38.0.0 Safari/537.36";
			assert.equal(isTouchScreenNow(), false, "the desktop app on a touch-screen PC");
		} finally {
			media([]);
		}
	});
});

describe("app/touch.css", () => {
	const css = fs.readFileSync(path.join(import.meta.dirname, "..", "app", "touch.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

	it("every rule is for touch screens only and never for the desktop app", () => {
		const outside = css.replace(/@media \(any-pointer: coarse\)\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, "");
		assert.equal(outside.trim(), "", "nothing outside @media (any-pointer: coarse)");
		const selectors = [...css.matchAll(/([^{}@]+)\{[^{}]*\}/g)].map((m) => m[1]!.trim()).filter(Boolean);
		assert.ok(selectors.length > 0);
		for (const selector of selectors) assert.match(selector, /^html:not\(\.lh-electron\)/, selector);
	});

	it("press-and-hold rows can't be selected, and the hover-only buttons show (owner's choice)", () => {
		assert.match(css, /html:not\(\.lh-electron\) \[data-phone-press\]\s*\{[^}]*user-select:\s*none;[^}]*-webkit-touch-callout:\s*none;/);
		assert.match(css, /\[data-testid="md-copy"\][^{]*\[data-testid="md-mermaid-expand"\][^{]*\{\s*opacity:\s*1;/);
	});

	it("changes nothing about the layout: no width rule, and the page's bounce is off", () => {
		assert.doesNotMatch(css, /max-width|min-width/);
		assert.match(css, /html:not\(\.lh-electron\)\s*\{\s*overscroll-behavior-y:\s*none;\s*\}/);
	});

	it("is loaded by the root layout", () => {
		assert.match(fs.readFileSync(path.join(import.meta.dirname, "..", "app", "layout.tsx"), "utf8"), /import "\.\/touch\.css";/);
	});
});
