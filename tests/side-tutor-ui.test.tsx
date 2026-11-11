/**
 * SIDE TUTOR WINDOW PINS (owner's asks): the open window's few words, its
 * Dictate button, and the minimized tutor, a round bubble with no words at
 * the lesson's bottom right just above the question, on a computer as on a
 * phone. fetch is scripted; no server, no microphone.
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

type FakeDictation = import("../components/dictation.tsx").Dictation & { calls: string[] };
/** The page's dictation run, scripted: no microphone, no Deepgram. */
function fakeDictation(over: Partial<FakeDictation> = {}): FakeDictation {
	const calls: string[] = [];
	return {
		phase: "idle",
		error: null,
		levelRef: { current: 0.2 },
		active: false,
		toggle: () => void calls.push("toggle"),
		stop: () => void calls.push("stop"),
		finish: async () => void calls.push("finish"),
		cancel: () => void calls.push("cancel"),
		clearError: () => void calls.push("clearError"),
		calls,
		...over,
	};
}

const posted: string[] = [];
async function mountTutor(dictation?: FakeDictation) {
	posted.length = 0;
	globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
		if (init?.method === "POST") {
			posted.push(String((JSON.parse(String(init.body)) as { question?: string }).question));
			return new Response("", { status: 200 });
		}
		return new Response(JSON.stringify({ entries: [], running: false }), { status: 200, headers: { "Content-Type": "application/json" } });
	}) as typeof fetch;
	const { SideTutor } = await import("../components/side-tutor.tsx");
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push({ root, host });
	const render = (d?: FakeDictation) => act(async () => root.render(<SideTutor chatId="chat_1" dictation={d} />));
	await render(dictation);
	await act(async () => new Promise((r) => setTimeout(r, 20)));
	return Object.assign(host, { rerender: render });
}
/** Minimizes the window and returns the bubble, wherever it is drawn. */
const minimize = async (host: HTMLElement) => {
	await act(async () => (host.querySelector("[aria-label='Minimize the side tutor']") as HTMLElement).click());
	await act(async () => new Promise((r) => setTimeout(r, 20)));
	return document.querySelector("[data-testid='side-tutor-toggle']") as HTMLElement;
};
const styleOf = (el: HTMLElement) => el.getAttribute("style") ?? "";

describe("the open window", () => {
	it("says Tutor at the top, one sentence in the middle, and Ask a follow-up… in the typing box; nothing else", async () => {
		const host = await mountTutor();
		const panel = host.querySelector("[data-testid='side-tutor']") as HTMLElement;
		assert.ok(panel);
		// Every word shown: the title, then the sentence. No tagline, no
		// explanation of what the tutor can see.
		assert.deepEqual([...panel.querySelectorAll("div, p")].map((el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent?.trim()).join("")).filter(Boolean), ["Tutor", "Stuck on a term or a step? Ask here."]);
		assert.equal((panel.textContent ?? "").trim(), "TutorStuck on a term or a step? Ask here.");
		const box = panel.querySelector("textarea") as HTMLElement;
		assert.equal(box.getAttribute("placeholder"), "Ask a follow-up…");
		assert.ok(panel.querySelector("[aria-label='Clear side questions']"));
		assert.ok(panel.querySelector("[aria-label='Minimize the side tutor']"));
	});

	it("has a middle that is closer to black and more see-through than its bars", async () => {
		const host = await mountTutor();
		const panel = host.querySelector("[data-testid='side-tutor']") as HTMLElement;
		const classes = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/);
		const [bar, body, row] = [...panel.children];
		assert.equal(body, panel.querySelector("[data-testid='side-tutor-body']"));
		assert.ok(classes(body!).includes("bg-black/60"));
		// The bars keep the app's background, nearly solid.
		assert.ok(classes(bar!).includes("bg-background/95"));
		assert.ok(classes(row!).includes("bg-background/95"));
		// The window has no background of its own (it would sit behind the
		// middle and close it up), only the blur of what is behind it.
		assert.deepEqual(classes(panel).filter((c) => c.startsWith("bg-")), []);
		assert.ok(classes(panel).includes("backdrop-blur"));
	});

	it("sizes Dictate and Send from the one-line typing box, and makes the hint a little smaller", async () => {
		const host = await mountTutor(fakeDictation());
		const panel = host.querySelector("[data-testid='side-tutor']") as HTMLElement;
		const classes = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/);
		const row = panel.lastElementChild as HTMLElement;
		const box = row.querySelector("textarea") as HTMLElement;
		// One line of the box's text, plus its padding (py-2) and border.
		assert.match(styleOf(row), /--lh-tutor-line:\s*calc\(var\(--lh-tutor-text, var\(--lh-prose-size\)\) \* var\(--lh-prose-leading\)\)/);
		assert.match(styleOf(row), /--lh-tutor-row:\s*calc\(var\(--lh-tutor-line\) \+ 1rem \+ 2px\)/);
		assert.ok(classes(box).includes("py-2") && classes(box).includes("border"));
		assert.ok(classes(box).includes("min-h-(--lh-tutor-row)"));
		for (const name of ["[data-testid='side-tutor-dictate']", "[aria-label='Ask']"]) {
			assert.ok(classes(row.querySelector(name)!).includes("size-(--lh-tutor-row)"), name);
		}
		// The hint: seven eighths of the typed size, on the typed text's line.
		assert.match(styleOf(row), /--lh-tutor-hint:\s*calc\(var\(--lh-tutor-text, var\(--lh-prose-size\)\) \* 0\.875\)/);
		assert.ok(classes(box).includes("placeholder:text-(length:--lh-tutor-hint)"));
		assert.ok(classes(box).includes("placeholder:leading-(--lh-tutor-line)"));
	});
});

describe("speaking to the tutor", () => {
	const state = () => import("../components/side-tutor-dictation-state.ts");
	const button = (host: HTMLElement) => host.querySelector("[data-testid='side-tutor-dictate']") as HTMLElement;
	afterEach(async () => (await state()).releaseSideDictation());

	it("has a Dictate button between the typing box and Send", async () => {
		const host = await mountTutor(fakeDictation());
		const row = (host.querySelector("textarea") as HTMLElement).parentElement as HTMLElement;
		assert.deepEqual([...row.children].map((el) => el.getAttribute("aria-label")), ["Ask the side tutor", "Start dictation", "Ask"]);
		assert.equal(host.querySelector("[data-testid='side-tutor-meter']"), null);
		// Without the page's dictation (a practice page has no tutor at all) there is no button.
		assert.equal(button(await mountTutor()), null);
	});

	it("starts the page's run for itself: the words will go to the tutor's box, not the lesson's", async () => {
		const dictation = fakeDictation();
		const host = await mountTutor(dictation);
		assert.equal((await state()).sideDictationTarget(), null);
		await act(async () => button(host).click());
		assert.deepEqual(dictation.calls, ["toggle"]);
		assert.equal(typeof (await state()).sideDictationTarget(), "function");
	});

	it("while it listens: a small live waveform and a red Stop; the words land in the box when it ends", async () => {
		const dictation = fakeDictation();
		const host = await mountTutor(dictation);
		await act(async () => button(host).click());
		const live = fakeDictation({ phase: "recording", active: true });
		await host.rerender(live);
		assert.equal(host.querySelectorAll("[data-testid='side-tutor-meter'] span").length, 14);
		assert.equal(button(host).getAttribute("aria-label"), "Stop dictation");
		assert.match(button(host).className, /text-destructive/);
		// Stop and the waveform are as tall as the typing box, like Dictate and Send.
		assert.ok(button(host).className.split(/\s+/).includes("size-(--lh-tutor-row)"));
		assert.ok((host.querySelector("[data-testid='side-tutor-meter']") as HTMLElement).className.split(/\s+/).includes("h-(--lh-tutor-row)"));
		await act(async () => button(host).click());
		assert.deepEqual(live.calls, ["toggle"]);
		// The run ends: dictation.tsx hands the transcript to whoever claimed it.
		await act(async () => { (await state()).sideDictationTarget()?.("what is a mole"); });
		assert.equal((host.querySelector("textarea") as HTMLTextAreaElement).value, "what is a mole");
		// More words join what is there.
		await act(async () => { (await state()).sideDictationTarget()?.("exactly"); });
		assert.equal((host.querySelector("textarea") as HTMLTextAreaElement).value, "what is a mole exactly");
	});

	it("Send while still listening ends the run first, then asks with the spoken words", async () => {
		const host = await mountTutor(fakeDictation());
		await act(async () => button(host).click());
		const s = await state();
		const live = fakeDictation({ phase: "recording", active: true });
		live.finish = async () => {
			live.calls.push("finish");
			s.sideDictationTarget()?.("why does it fold");
		};
		await host.rerender(live);
		const send = host.querySelector("[aria-label='Ask']") as HTMLButtonElement;
		assert.equal(send.hasAttribute("disabled"), false, "sendable with an empty box while it listens");
		await act(async () => send.click());
		await act(async () => new Promise((r) => setTimeout(r, 20)));
		assert.deepEqual(live.calls, ["finish"]);
		assert.deepEqual(posted, ["why does it fold"]);
	});

	it("is off while the lesson itself is dictating, and leads to the key when there is none", async () => {
		// The lesson's run: not the tutor's (nothing claimed).
		const host = await mountTutor(fakeDictation({ phase: "recording", active: true }));
		assert.equal(button(host).hasAttribute("disabled"), true);
		assert.equal(host.querySelector("[data-testid='side-tutor-meter']"), null);
		// No Deepgram key: the button says so, and a click doesn't start a run.
		const keyless = fakeDictation({ error: "Dictation needs a Deepgram key" });
		const other = await mountTutor(keyless);
		assert.equal(button(other).getAttribute("title"), "Dictation needs a Deepgram key");
		await act(async () => button(other).click());
		assert.deepEqual(keyless.calls, ["clearError"]);
		assert.equal((await state()).sideDictationTarget(), null);
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

	it("is drawn inside the dock, off to the side above the question bar, wherever the window was", async () => {
		// The window had been dragged to the top left.
		storage.set("lh:side-tutor:pos", JSON.stringify({ left: 300, top: 90 }));
		dockAt(640, 900);
		const bubble = await minimize(await mountTutor());
		assert.equal(bubble.getAttribute("data-place"), "above-dock");
		// Inside the dock: it moves with the bar by itself, with nothing to
		// measure while the lesson scrolls or a question opens and folds.
		assert.equal(bubble.parentElement, document.querySelector("[data-phone='dock']"));
		assert.match(bubble.className, /\babsolute\b/);
		assert.match(bubble.className, /pointer-events-auto/);
		assert.doesNotMatch(bubble.className, /\bfixed\b/);
		// The owner's placing: 20 px above the bar and 16 px in from the lesson's
		// right edge (the dock spans the lesson), as far right as its place
		// under the top bar.
		assert.match(styleOf(bubble), /bottom:\s*calc\(100% \+ 20px\)/);
		assert.match(styleOf(bubble), /right:\s*16px/);
		assert.doesNotMatch(styleOf(bubble), /top:|left:/);
	});

	it("moves under the top bar while an opened question leaves no room above it", async () => {
		dockAt(110, 1280);
		const host = await mountTutor();
		const bubble = await minimize(host);
		assert.equal(bubble.getAttribute("data-place"), "top");
		assert.ok(host.contains(bubble), "not inside the dock");
		assert.match(bubble.className, /\bfixed\b/);
		assert.match(styleOf(bubble), /top:\s*72px/);
		assert.match(styleOf(bubble), /right:\s*16px/);
		// With the notes drawer open, the lesson ends 380 px from the window's edge.
		for (const dock of [...document.querySelectorAll("[data-phone='dock']")]) dock.remove();
		dockAt(110, 900);
		await act(async () => new Promise((r) => setTimeout(r, 650)));
		assert.match(styleOf(document.querySelector("[data-testid='side-tutor-toggle']") as HTMLElement), /right:\s*396px/);
	});

	it("opens the window again where it was left", async () => {
		storage.set("lh:side-tutor:pos", JSON.stringify({ left: 300, top: 90 }));
		dockAt(640, 900);
		const host = await mountTutor();
		const bubble = await minimize(host);
		await act(async () => bubble.click());
		assert.equal(document.querySelector("[data-testid='side-tutor-toggle']"), null);
		const panel = host.querySelector("[data-testid='side-tutor']") as HTMLElement;
		assert.match(styleOf(panel), /left:\s*300px/);
		assert.match(styleOf(panel), /top:\s*90px/);
	});
});
