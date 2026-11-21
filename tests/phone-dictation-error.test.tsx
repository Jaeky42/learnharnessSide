/**
 * A FAILED DICTATE RUN ON A PHONE (fork; components/phone/dictation-error-line.tsx).
 * The idle Dictate button is icon-only on a phone, so the reason shows as one
 * short line for five seconds, with the words exactly as the dictation gives
 * them. Off the phone layout nothing is rendered. The phone layout is played
 * by a scripted matchMedia; everything else is the real component. The mic's
 * error colour (app/phone.css) hangs on the button's data-dictation-error
 * attribute; the stylesheet's phone-only law is pinned in phone-layout.test.ts.
 */

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it, mock } from "node:test";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><head></head><body></body></html>");
let phone = true;
const layoutListeners = new Set<() => void>();
Object.assign(dom.window, {
	matchMedia: (query: string) => ({
		matches: phone && query.includes("max-width"),
		addEventListener(_type: string, listener: () => void) { layoutListeners.add(listener); },
		removeEventListener(_type: string, listener: () => void) { layoutListeners.delete(listener); },
	}),
});
Object.assign(globalThis, {
	window: dom.window, self: dom.window, document: dom.document,
	HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { DICTATION_ERROR_MS, DictationErrorLine, LINE_TOP_GAP, lineDrop } = await import("../components/phone/dictation-error-line.tsx");

const roots: { root: import("react-dom/client").Root; host: HTMLElement }[] = [];
async function mount(error: string | null) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push({ root, host });
	const render = (next: string | null) => act(async () => root.render(<div className="relative"><DictationErrorLine error={next} /></div>));
	await render(error);
	return { host, render };
}
const line = (host: HTMLElement) => host.querySelector("[data-testid='dictation-error-line']") as HTMLElement | null;

afterEach(async () => {
	mock.timers.reset();
	for (const { root, host } of roots.splice(0)) {
		await act(async () => root.unmount());
		host.remove();
	}
	phone = true;
});

describe("the short line above the message box", () => {
	it("shows the error as it is, as an alert, clamped to three lines", async () => {
		const { host } = await mount("Microphone permission denied");
		const el = line(host)!;
		assert.ok(el);
		assert.equal(el.getAttribute("role"), "alert");
		assert.equal(el.textContent, "Microphone permission denied", "the words exactly, no prefix");
		assert.ok(el.querySelector(".line-clamp-3"));
		// It floats: it can never move the message box or the lesson.
		const classes = (el.getAttribute("class") ?? "").split(/\s+/);
		assert.ok(classes.includes("absolute") && classes.includes("pointer-events-none"));
		// Clear of the Tutor's bubble at the right.
		assert.ok(classes.some((c) => c.startsWith("max-w-[calc(100%-")));
	});

	it("shows nothing while there is no error", async () => {
		const { host } = await mount(null);
		assert.equal(line(host), null);
	});

	it("renders nothing off the phone layout (a computer, a tablet, the desktop app)", async () => {
		phone = false;
		const { host } = await mount("Microphone permission denied");
		assert.equal(line(host), null);
	});

	it("goes after five seconds, and shows again for the next failure", async () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		const { host, render } = await mount("Microphone permission denied");
		assert.ok(line(host));
		await act(async () => mock.timers.tick(DICTATION_ERROR_MS - 1));
		assert.ok(line(host), "still there just before five seconds");
		await act(async () => mock.timers.tick(1));
		assert.equal(line(host), null, "gone at five seconds");
		assert.equal(DICTATION_ERROR_MS, 5000);
		// The next tap clears the error, the next failure shows it again.
		await render(null);
		await render("Microphone permission denied");
		assert.ok(line(host), "a new failure shows again");
		await act(async () => mock.timers.tick(DICTATION_ERROR_MS));
		assert.equal(line(host), null);
	});

	it("goes at once when the error clears (the next tap), and a different failure restarts the five seconds", async () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		const { host, render } = await mount("First reason");
		await act(async () => mock.timers.tick(3000));
		await render("Second reason");
		assert.equal(line(host)!.textContent, "Second reason");
		await act(async () => mock.timers.tick(3000));
		assert.ok(line(host), "the second failure has its own five seconds");
		await act(async () => mock.timers.tick(2000));
		assert.equal(line(host), null);
		await render("Third reason");
		assert.ok(line(host));
		await render(null);
		assert.equal(line(host), null, "cleared with the error");
	});
});

describe("never behind the top bar (an opened question fills the screen)", () => {
	it("the rule: down to the gap under the top bar's end, and not at all when there is room", () => {
		assert.equal(LINE_TOP_GAP, 8);
		// Found in a real Firefox: the line's top 15 px from the screen's top, the top bar ending at 60.
		assert.equal(lineDrop(15, 60), 53);
		// The home-screen app's taller top bar (148 points).
		assert.equal(lineDrop(15, 148), 141);
		// A plain message box: the line is far below the top bar and stays.
		assert.equal(lineDrop(575, 60), 0);
		assert.equal(lineDrop(68, 60), 0, "exactly at the gap: not moved");
		assert.equal(lineDrop(67.4, 60), 1, "whole pixels, never short of the gap");
		// No top bar (home, new session): only the screen's own top counts.
		assert.equal(lineDrop(575, null), 0);
		assert.equal(lineDrop(-20, null), 28);
	});

	// linkedom lays nothing out: the boxes are scripted. The line's box follows
	// its own transform, as a real one does.
	const boxes = { bar: 60, line: 15 };
	const proto = dom.window.HTMLElement.prototype as unknown as { getBoundingClientRect?: () => { top: number; bottom: number } };
	const script = () => {
		proto.getBoundingClientRect = function (this: HTMLElement) {
			if (this.getAttribute("data-phone") === "topbar") return { top: 0, bottom: boxes.bar };
			if (this.getAttribute("data-testid") === "dictation-error-line") {
				const moved = Number(/translateY\(([-\d.]+)px\)/.exec(this.style.transform ?? "")?.[1] ?? 0);
				return { top: boxes.line + moved, bottom: boxes.line + moved + 30 };
			}
			return { top: 1000, bottom: 1000 };
		};
	};
	const addBar = () => {
		const bar = document.createElement("div");
		bar.setAttribute("data-phone", "topbar");
		document.body.appendChild(bar);
		return bar;
	};
	afterEach(() => {
		delete proto.getBoundingClientRect;
		document.querySelector("[data-phone='topbar']")?.remove();
		boxes.bar = 60;
		boxes.line = 15;
	});

	it("a line that would sit behind the top bar is moved to just under it, with a transform only", async () => {
		script();
		addBar();
		const { host } = await mount("Deepgram token grant failed (403)");
		const el = line(host)!;
		assert.equal(el.style.transform, "translateY(53px)", "15 px down to 68: the top bar's 60 plus the gap");
		assert.equal(el.getBoundingClientRect().top, boxes.bar + LINE_TOP_GAP);
		const classes = (el.getAttribute("class") ?? "").split(/\s+/);
		assert.ok(classes.includes("absolute") && classes.includes("bottom-full"), "its anchor is unchanged, so nothing else moves");
	});

	it("with a plain message box it stays where it was", async () => {
		script();
		addBar();
		boxes.line = 575;
		const { host } = await mount("Microphone permission denied");
		assert.equal(line(host)!.style.transform ?? "", "");
	});

	it("follows the block while it shows: a question opening moves it down, folding puts it back", async () => {
		script();
		addBar();
		boxes.line = 575;
		const { host } = await mount("Microphone permission denied");
		const el = line(host)!;
		boxes.line = 15; // the question opened and the block grew to the top bar
		await act(async () => { dom.window.dispatchEvent(new dom.window.Event("resize")); });
		assert.equal(el.style.transform, "translateY(53px)");
		await act(async () => { dom.window.dispatchEvent(new dom.window.Event("resize")); });
		assert.equal(el.style.transform, "translateY(53px)", "measured from its unmoved place: it doesn't creep");
		boxes.line = 575;
		await act(async () => { dom.window.dispatchEvent(new dom.window.Event("resize")); });
		assert.equal(el.style.transform ?? "", "");
	});

	it("a long unbroken reason wraps inside the line", async () => {
		const { host } = await mount('Deepgram token grant failed (403): {"err_code":"FORBIDDEN","err_msg":"Insufficient permissions."}');
		const span = line(host)!.querySelector("span")!;
		const classes = (span.getAttribute("class") ?? "").split(/\s+/);
		assert.ok(classes.includes("line-clamp-3") && classes.includes("[overflow-wrap:anywhere]"));
	});
});

describe("what the screens hand it", () => {
	const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
	it("the lesson, home and new-session screens each mount it with their dictation's error", () => {
		assert.match(read("components/chat.tsx"), /dictationError=\{dictation\.error\}/);
		assert.match(read("components/chat.tsx"), /<DictationErrorLine error=\{dictationError\}/);
		assert.match(read("components/home.tsx"), /<DictationErrorLine error=\{dictation\.error\}/);
		assert.match(read("components/new-session.tsx"), /<DictationErrorLine error=\{dictation\.error\}/);
	});
	it("the mic's error colour is phone.css's, from the button's attribute", () => {
		const css = read("app/phone.css");
		assert.match(css, /\[data-dictation-error\] \{\s*color: var\(--lh-error\);/);
		assert.match(read("components/dictation.tsx"), /data-dictation-error=\{error \? "" : undefined\}/);
		assert.match(read("components/side-tutor-dictation.tsx"), /data-dictation-error=\{error \? "" : undefined\}/);
	});
});
