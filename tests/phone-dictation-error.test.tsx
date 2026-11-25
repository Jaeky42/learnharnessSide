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
const { DICTATION_ERROR_BESIDE_BUBBLE, DICTATION_ERROR_MS, DictationErrorLine } = await import("../components/phone/dictation-error-line.tsx");

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

	it("is centred on the screen (owner's ask), and beside the Tutor's bubble keeps its room on both sides", async () => {
		const { host } = await mount("Microphone didn't start. Try again.");
		const classes = (line(host)!.getAttribute("class") ?? "").split(/\s+/);
		for (const c of ["inset-x-0", "mx-auto", "w-fit", "text-center", "max-w-[calc(100%-2rem)]"]) assert.ok(classes.includes(c), c);
		assert.ok(!classes.some((c) => c.startsWith("left-")), "no left-aligned place");
		// The lesson's line: the bubble's 5.5rem on both sides, still centred.
		const lesson = document.createElement("div");
		document.body.appendChild(lesson);
		const root = createRoot(lesson);
		roots.push({ root, host: lesson });
		await act(async () => root.render(<div className="relative"><DictationErrorLine error="x" className={`mb-12 ${DICTATION_ERROR_BESIDE_BUBBLE}`} /></div>));
		const beside = (line(lesson)!.getAttribute("class") ?? "").split(/\s+/);
		assert.ok(beside.includes("max-w-[calc(100%-11rem)]") && !beside.includes("max-w-[calc(100%-2rem)]"));
		assert.ok(beside.includes("mx-auto") && beside.includes("inset-x-0") && beside.includes("mb-12"));
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
