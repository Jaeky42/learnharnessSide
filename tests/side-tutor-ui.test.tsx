/**
 * SIDE TUTOR WINDOW PINS (owner's asks): the open window says one sentence
 * and nothing else, and minimized it is a round bubble with no words, at
 * the lesson's bottom right just above the question, on a computer as on a
 * phone. fetch is scripted; no server.
 */

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
const storage = new Map<string, string>();
Object.assign(dom.window, {
	innerWidth: 1280,
	innerHeight: 800,
	setInterval,
	clearInterval,
	setTimeout,
	clearTimeout,
	localStorage: {
		getItem: (k: string) => storage.get(k) ?? null,
		setItem: (k: string, v: string) => void storage.set(k, v),
		removeItem: (k: string) => void storage.delete(k),
	},
});
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
	cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});
// No layout here: give every element the window's default size.
Object.defineProperty(dom.window.HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 352 });
Object.defineProperty(dom.window.HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 480 });
const originalFetch = globalThis.fetch;
const roots: { root: Root; host: HTMLElement }[] = [];

afterEach(async () => {
	for (const { root, host } of roots.splice(0)) {
		await act(async () => root.unmount());
		host.remove();
	}
	for (const dock of [...document.querySelectorAll("[data-phone='dock']")]) dock.remove();
	globalThis.fetch = originalFetch;
	storage.clear();
});

/** The lesson's dock (message box / question area), with a made-up place on screen. */
function dockAt(top: number, right: number) {
	const dock = document.createElement("div");
	dock.setAttribute("data-phone", "dock");
	Object.assign(dock, { getBoundingClientRect: () => ({ top, right, left: 288, bottom: 800, width: right - 288, height: 800 - top, x: 288, y: top }) });
	document.body.appendChild(dock);
}

async function mountTutor() {
	globalThis.fetch = (async () => new Response(JSON.stringify({ entries: [], running: false }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
	const { SideTutor } = await import("../components/side-tutor.tsx");
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push({ root, host });
	await act(async () => root.render(<SideTutor chatId="chat_1" />));
	await act(async () => new Promise((r) => setTimeout(r, 20)));
	return host;
}
const minimize = async (host: HTMLElement) => {
	await act(async () => (host.querySelector("[aria-label='Minimize the side tutor']") as HTMLElement).click());
	await act(async () => new Promise((r) => setTimeout(r, 20)));
	return host.querySelector("[data-testid='side-tutor-toggle']") as HTMLElement;
};
const styleOf = (el: HTMLElement) => el.getAttribute("style") ?? "";

describe("the open window", () => {
	it("says one sentence and nothing else: no title, no tagline, no hint in the typing box", async () => {
		const host = await mountTutor();
		const panel = host.querySelector("[data-testid='side-tutor']") as HTMLElement;
		assert.ok(panel);
		assert.equal((panel.textContent ?? "").trim(), "Stuck on a term or a step? Ask here.");
		const box = panel.querySelector("textarea") as HTMLElement;
		assert.equal(box.getAttribute("placeholder"), null);
		// Still named for screen readers, and still with its two buttons.
		assert.equal(box.getAttribute("aria-label"), "Ask the side tutor");
		assert.equal(panel.getAttribute("aria-label"), "Side tutor");
		assert.ok(panel.querySelector("[aria-label='Clear side questions']"));
		assert.ok(panel.querySelector("[aria-label='Minimize the side tutor']"));
	});
});

describe("minimized", () => {
	it("is a round bubble with no words", async () => {
		dockAt(640, 900);
		const bubble = await minimize(await mountTutor());
		assert.ok(bubble);
		assert.equal((bubble.textContent ?? "").trim(), "");
		assert.equal(bubble.getAttribute("aria-label"), "Open the side tutor");
		assert.match(bubble.className, /rounded-full/);
		assert.match(bubble.className, /size-13/);
		assert.ok(bubble.querySelector("svg"));
		assert.equal(storage.get("lh:side-tutor:open"), "false");
	});

	it("sits at the lesson's bottom right, just above the question, wherever the window was", async () => {
		// The window had been dragged to the top left.
		storage.set("lh:side-tutor:pos", JSON.stringify({ left: 300, top: 90 }));
		// The lesson ends 380 px from the window's right edge (the notes drawer
		// is open), and the dock's top is at 640.
		dockAt(640, 900);
		const bubble = await minimize(await mountTutor());
		assert.equal(bubble.getAttribute("data-place"), "above-dock");
		assert.match(styleOf(bubble), /top:\s*576px/, "12 px above the dock, 52 px tall");
		assert.match(styleOf(bubble), /right:\s*396px/, "16 px in from the lesson's right edge");
		assert.doesNotMatch(styleOf(bubble), /left:/);
	});

	it("moves under the top bar while an opened question leaves no room above it", async () => {
		dockAt(110, 1280);
		const bubble = await minimize(await mountTutor());
		assert.equal(bubble.getAttribute("data-place"), "top");
		assert.match(styleOf(bubble), /top:\s*72px/);
		assert.match(styleOf(bubble), /right:\s*16px/);
	});

	it("opens the window again where it was left", async () => {
		storage.set("lh:side-tutor:pos", JSON.stringify({ left: 300, top: 90 }));
		dockAt(640, 900);
		const host = await mountTutor();
		const bubble = await minimize(host);
		await act(async () => bubble.click());
		const panel = host.querySelector("[data-testid='side-tutor']") as HTMLElement;
		assert.match(styleOf(panel), /left:\s*300px/);
		assert.match(styleOf(panel), /top:\s*90px/);
	});
});
