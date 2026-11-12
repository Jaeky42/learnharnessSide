/**
 * SIDE TUTOR WINDOW PINS (owner's asks): the open window's few words, its
 * Dictate button, and the minimized tutor, a round bubble with no words at
 * the lesson's bottom right just above the question, on a computer as on a
 * phone. And its contents since upstream 0.6.0: upstream's side conversations,
 * read through upstream's real hook (useSideThread), all in one scroll.
 * fetch and the live channel are scripted; no server, no microphone.
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
// No layout here: every element has the window's default size, unless it or
// the box it fills (the window fills its frame) was given a size.
function measured(el: Element, prop: "width" | "height", fallback: number): number {
	for (const box of [el, el.parentElement]) {
		const found = new RegExp(`(?:^|;)\\s*${prop}:\\s*([\\d.]+)px`).exec(box?.getAttribute("style") ?? "");
		if (found) return Number(found[1]);
	}
	return fallback;
}
Object.defineProperty(dom.window.HTMLElement.prototype, "offsetWidth", { configurable: true, get(this: Element) { return measured(this, "width", 352); } });
Object.defineProperty(dom.window.HTMLElement.prototype, "offsetHeight", { configurable: true, get(this: Element) { return measured(this, "height", 480); } });
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

type DictationDestination = import("../components/dictation.tsx").DictationDestination;
type FakeDictation = import("../components/dictation.tsx").Dictation & { calls: string[]; destinations: DictationDestination[] };
/** The page's shared recorder, scripted: no microphone, no Deepgram. A run
 *  started for a destination is recorded in `destinations`, so a test can
 *  deliver the transcript the way dictation.tsx does when the run ends. */
function fakeDictation(over: Partial<FakeDictation> = {}): FakeDictation {
	const calls: string[] = [];
	const destinations: DictationDestination[] = [];
	return {
		phase: "idle",
		destinationId: "main",
		error: null,
		levelRef: { current: 0.2 },
		active: false,
		toggle: () => void calls.push("toggle"),
		toggleFor: (destination) => {
			calls.push(`toggleFor:${destination.id}`);
			destinations.push(destination);
		},
		finishFor: async (id) => void calls.push(`finishFor:${id}`),
		stop: () => void calls.push("stop"),
		finish: async () => void calls.push("finish"),
		cancel: () => void calls.push("cancel"),
		clearError: () => void calls.push("clearError"),
		calls,
		destinations,
		...over,
	};
}

type LhMessage = import("../src/core/index.ts").LhMessage;
type SideChatThread = import("../src/core/index.ts").SideChatThread;
type SideChatMessage = import("../src/core/index.ts").SideChatMessage;
type TutorSide = import("../components/side-tutor.tsx").TutorSide;

/** A lesson of two steps: each starts at the teacher's first message after a learner turn. */
const LESSON = [
	{ id: "u1", role: "user", content: "teach me eigenvalues", timestamp: 1 },
	{ id: "a1", role: "assistant", content: [{ type: "text", text: "A few **special vectors** only get stretched. For those, $A\\mathbf{v} = \\lambda \\mathbf{v}$." }], timestamp: 2 },
	{ id: "u2", role: "user", content: "ok", timestamp: 3 },
	{ id: "a2", role: "assistant", content: [{ type: "text", text: "Exactly. And a negative eigenvalue flips the vector." }], timestamp: 4 },
] as unknown as LhMessage[];
const STEP_1 = "A few special vectors only get stretched. For those…";
const STEP_2 = "Exactly. And a negative eigenvalue flips the vector.";

const said = (id: string, role: "user" | "assistant", text: string, extra: Partial<SideChatMessage> = {}): SideChatMessage => ({ id, role, text, at: "2026-11-10T10:00:00.000Z", ...extra });
const conversation = (step: string, messages: SideChatMessage[]): SideChatThread => ({
	id: `side_${step}`, open: false, createdAt: `2026-11-10T10:00:0${step.slice(1)}.000Z`, messages,
	anchor: { messageId: step, partId: `${step}-t0`, blockIndex: 0, blockText: "This teaching segment and its question." },
});

/** What the scripted server holds, and what was sent to it. */
const server: { threads: SideChatThread[]; answering: Record<string, string>; posts: Array<Record<string, unknown>>; stops: string[]; send: ((line: object) => void) | null; end: (() => void) | null } =
	{ threads: [], answering: {}, posts: [], stops: [], send: null, end: null };
/** The questions asked, as text (what the older tests read). */
const posted: string[] = [];
const ndjson = (lines: object[]) => new Response(lines.map((line) => `${JSON.stringify(line)}\n`).join(""), { status: 200 });

let side: TutorSide | null = null;
async function mountTutor(dictation?: FakeDictation, lesson: LhMessage[] = LESSON) {
	posted.length = 0;
	Object.assign(server, { posts: [], stops: [], send: null, end: null });
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith("/stop")) {
			server.stops.push(url);
			return Response.json({ ok: true });
		}
		if (init?.method === "POST") {
			const body = JSON.parse(String(init.body)) as Record<string, unknown>;
			server.posts.push(body);
			posted.push(String(body.text));
			// The answer is written while the test watches: lines are sent by hand.
			const encoder = new TextEncoder();
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					server.send = (line) => controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
					server.end = () => controller.close();
				},
			});
			return new Response(stream, { status: 200 });
		}
		if (url.endsWith("/side-chats")) return Response.json({ threads: server.threads, answering: server.answering });
		// One conversation, watched: what is saved, and nothing more to come.
		const thread = server.threads.find((entry) => url.endsWith(`/side-chats/${entry.id}`));
		return thread ? ndjson([{ type: "done", thread }]) : Response.json({ error: "Unknown" }, { status: 404 });
	}) as typeof fetch;
	const { SideTutor } = await import("../components/side-tutor.tsx");
	const { useSideThread } = await import("../components/use-side-thread.ts");
	const { ServerEventsProvider } = await import("../components/server-events.tsx");
	function Lesson({ dictation, held, openRequest }: { dictation?: FakeDictation; held?: boolean; openRequest?: number }) {
		side = useSideThread("chat_1", lesson);
		return <SideTutor chatId="chat_1" messages={lesson} side={side} dictation={dictation} held={held} openRequest={openRequest} />;
	}
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push({ root, host });
	const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)));
	const render = async (d?: FakeDictation, more: { held?: boolean; openRequest?: number } = {}) => {
		await act(async () => root.render(<ServerEventsProvider connect={() => ({ close() {}, onOpen() {}, onEvent() {} })}><Lesson dictation={d} {...more} /></ServerEventsProvider>));
		await settle();
	};
	await render(dictation);
	return Object.assign(host, { rerender: render, settle });
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
		// Nothing can be deleted from a side conversation (owner's choice of upstream's rule).
		assert.equal(panel.querySelector("[aria-label='Clear side questions']"), null);
		assert.ok(panel.querySelector("[aria-label='Minimize the side tutor']"));
	});

	it("has a middle that is closer to black and more see-through than its bars", async () => {
		const host = await mountTutor();
		const panel = host.querySelector("[data-testid='side-tutor']") as HTMLElement;
		const classes = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/);
		const [bar, body, row] = [...panel.children];
		assert.equal(body, panel.querySelector("[data-testid='side-tutor-body']"));
		// On a dark theme: black at 60% (the owner's pick). On a light theme:
		// the theme's background, see-through, a little darker than the bars.
		assert.ok(classes(body!).includes("dark:bg-black/60"));
		assert.ok(classes(body!).some((c) => c.startsWith("bg-[color-mix(") && c.includes("var(--background)") && c.includes("transparent")));
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

describe("the conversations (upstream's side conversations, in the fork's window)", () => {
	const panelOf = (host: HTMLElement) => host.querySelector("[data-testid='side-tutor']") as HTMLElement;
	const steps = (host: HTMLElement) => [...host.querySelectorAll("[data-testid='side-tutor-step']")] as HTMLElement[];
	const dividers = (host: HTMLElement) => [...host.querySelectorAll("[data-testid='side-tutor-divider']")].map((el) => el.textContent);
	/** Types into the box through React's own handler (linkedom fires no input events React hears). */
	const type = async (host: HTMLElement, text: string) => {
		const box = host.querySelector("textarea") as HTMLTextAreaElement;
		const props = (box as unknown as Record<string, { onChange: (event: { target: { value: string } }) => void }>)[Object.keys(box).find((key) => key.startsWith("__reactProps$"))!]!;
		await act(async () => props.onChange({ target: { value: text } }));
	};
	type Mounted = Awaited<ReturnType<typeof mountTutor>>;
	const settle = (host: Mounted) => host.settle();
	const send = async (host: Mounted) => {
		await act(async () => (host.querySelector("[aria-label='Ask']") as HTMLElement).click());
		await host.settle();
	};

	it("shows every step's conversation in one scroll, in lesson order, each under its step's first words", async () => {
		server.answering = {};
		// Saved out of order: the window orders them by the lesson.
		server.threads = [
			conversation("a2", [said("q2", "user", "Why flips?"), said("r2", "assistant", "Because it is negative.")]),
			conversation("a1", [said("q1", "user", "What is det?"), said("r1", "assistant", "The determinant.")]),
		];
		const host = await mountTutor();
		assert.deepEqual(dividers(host), [STEP_1, STEP_2]);
		assert.deepEqual(steps(host).map((step) => step.getAttribute("data-step")), ["a1", "a2"]);
		assert.match(steps(host)[0]!.textContent ?? "", /What is det\?.*The determinant\./);
		assert.match(steps(host)[1]!.textContent ?? "", /Why flips\?.*Because it is negative\./);
		assert.doesNotMatch(panelOf(host).textContent ?? "", /Stuck on a term/, "the empty sentence is only for an empty window");
		assert.equal(host.querySelector("[data-testid='side-tutor-retry']"), null);
	});

	it("a question is about the step the lesson is on: it shows at once, then the answer as it is written", async () => {
		server.threads = [];
		server.answering = {};
		const host = await mountTutor();
		await type(host, "why negative?");
		await send(host);
		assert.equal(server.posts.length, 1);
		assert.equal(server.posts[0]!.text, "why negative?");
		assert.equal((server.posts[0]!.anchor as { messageId: string }).messageId, "a2", "the current step");
		assert.deepEqual(server.posts[0]!.quotes, []);
		assert.deepEqual(dividers(host), [STEP_2]);
		assert.match(steps(host)[0]!.textContent ?? "", /why negative\?/, "shown before the server has answered");
		assert.equal((host.querySelector("textarea") as HTMLTextAreaElement).value, "", "the box is cleared once the question is accepted");
		assert.ok(host.querySelector("[aria-label='Stop the answer']"), "Send is Stop while it answers");
		const asked = conversation("a2", [said("q", "user", "why negative?")]);
		await act(async () => { server.send!({ type: "thread", thread: asked }); server.send!({ type: "text", text: "It points" }); });
		await settle(host);
		assert.match(steps(host)[0]!.textContent ?? "", /why negative\?.*It points/);
		assert.equal(steps(host)[0]!.textContent!.split("why negative?").length, 2, "the question isn't shown twice");
		const done = conversation("a2", [said("q", "user", "why negative?"), said("r", "assistant", "It points the other way.")]);
		server.threads = [done];
		await act(async () => { server.send!({ type: "done", thread: done }); server.end!(); });
		await settle(host);
		assert.match(steps(host)[0]!.textContent ?? "", /It points the other way\./);
		assert.ok(host.querySelector("[aria-label='Ask']"), "Send is back");
	});

	it("Stop asks upstream to stop the answer; a stopped answer keeps its words and says Stopped.", async () => {
		server.threads = [conversation("a2", [said("q", "user", "show one"), said("r", "assistant", "Take A = (2 1; 1 2)", { stopped: true })])];
		server.answering = {};
		const host = await mountTutor();
		assert.match(steps(host)[0]!.textContent ?? "", /Take A = \(2 1; 1 2\).*Stopped\./);
		await type(host, "and then?");
		await send(host);
		await act(async () => (host.querySelector("[aria-label='Stop the answer']") as HTMLElement).click());
		assert.equal(server.stops.length, 1);
		assert.match(server.stops[0]!, /\/api\/chats\/chat_1\/side-chats\/side_a2\/stop$/);
	});

	it("a failed answer shows upstream's reason in the error colour, with Retry; Retry asks again in that conversation", async () => {
		// The failed one is at an EARLIER step than the one the lesson is on.
		server.threads = [conversation("a1", [said("q", "user", "a 3×3 one?"), said("r", "assistant", "", { error: "The side answer failed." })])];
		server.answering = {};
		const host = await mountTutor();
		const reason = [...steps(host)[0]!.querySelectorAll("div")].filter((el) => el.textContent === "The side answer failed.").at(-1)!;
		assert.match(reason.getAttribute("class") ?? "", /text-error/);
		const retry = host.querySelector("[data-testid='side-tutor-retry']") as HTMLElement;
		assert.equal(retry.textContent, "Retry");
		await act(async () => retry.click());
		await settle(host);
		assert.equal(server.posts.length, 1);
		assert.equal(server.posts[0]!.retry, true);
		assert.equal(server.posts[0]!.threadId, "side_a1");
	});

	it("a highlighted passage waits above the typing box; its question joins that passage's step; ✕ drops it", async () => {
		server.threads = [];
		server.answering = {};
		const host = await mountTutor();
		const ask = async () => {
			await act(async () => side!.open({ anchor: { kind: "composer" }, passage: { text: "only get stretched", sourceMessageId: "a1", selector: { start: 22, end: 40, prefix: "", suffix: "" } } }));
			await host.rerender(undefined, { openRequest: 1 });
		};
		await ask();
		const chip = host.querySelector("[data-testid='side-tutor-passage']") as HTMLElement;
		assert.match(chip.textContent ?? "", /only get stretched/);
		await act(async () => (chip.querySelector("[aria-label='Remove the passage']") as HTMLElement).click());
		await settle(host);
		assert.equal(host.querySelector("[data-testid='side-tutor-passage']"), null, "dropped");
		await ask();
		await type(host, "stretched how?");
		await send(host);
		assert.equal((server.posts[0]!.anchor as { messageId: string }).messageId, "a1", "the passage's step, not the current one");
		assert.deepEqual(server.posts[0]!.quotes, ["only get stretched"]);
		assert.equal((server.posts[0]!.quoteCitations as string[]).length, 1);
		assert.equal(host.querySelector("[data-testid='side-tutor-passage']"), null, "the chip goes once the question is accepted");
		assert.deepEqual(dividers(host), [STEP_1]);
		assert.match(steps(host)[0]!.textContent ?? "", /only get stretched.*stretched how\?/, "the passage sits above the question");
		// Answered: the next question is about the current step again.
		const done = conversation("a1", [said("q", "user", "stretched how?", { quotes: ["only get stretched"] }), said("r", "assistant", "Scaled.")]);
		server.threads = [done];
		await act(async () => { server.send!({ type: "done", thread: done }); server.end!(); });
		await settle(host);
		await type(host, "and now?");
		await send(host);
		assert.equal((server.posts[1]!.anchor as { messageId: string }).messageId, "a2");
	});

	it("opens from the bubble when the lesson's Ask is used", async () => {
		server.threads = [];
		const host = await mountTutor();
		await minimize(host);
		assert.equal(host.querySelector("[data-testid='side-tutor']"), null);
		await host.rerender(undefined, { openRequest: 1 });
		assert.ok(host.querySelector("[data-testid='side-tutor']"));
	});

	it("an answer still being written when the page loads: a spinner in its conversation and on the bubble, and no Retry", async () => {
		server.threads = [conversation("a1", [said("q", "user", "still there?")])];
		server.answering = { side_a1: "So far" };
		const host = await mountTutor();
		assert.ok(steps(host)[0]!.querySelector("[aria-label='Answering'], [role='status']") ?? /Answering/.test(steps(host)[0]!.innerHTML), "the conversation shows it is being answered");
		assert.equal(host.querySelector("[data-testid='side-tutor-retry']"), null);
		assert.equal((host.querySelector("[aria-label='Ask']") as HTMLButtonElement).hasAttribute("disabled"), true, "one answer at a time");
		// It lands: the spinner goes.
		const done = conversation("a1", [said("q", "user", "still there?"), said("r", "assistant", "Yes.")]);
		server.threads = [done];
		server.answering = {};
		await act(async () => side!.open({ anchor: { kind: "composer" }, sourceMessageId: "a1" }));
		await settle(host);
		assert.match(steps(host)[0]!.textContent ?? "", /Yes\./);
	});

	it("the typing box is off until the teacher has said something", async () => {
		server.threads = [];
		server.answering = {};
		const host = await mountTutor(undefined, [{ id: "u1", role: "user", content: "hello", timestamp: 1 }] as unknown as LhMessage[]);
		assert.equal((host.querySelector("textarea") as HTMLTextAreaElement).hasAttribute("disabled"), true);
		assert.equal((host.querySelector("[aria-label='Ask']") as HTMLButtonElement).hasAttribute("disabled"), true);
		assert.equal(panelOf(host).querySelector("p")?.textContent, "Stuck on a term or a step? Ask here.");
	});
});

describe("speaking to the tutor", () => {
	const button = (host: HTMLElement) => host.querySelector("[data-testid='side-tutor-dictate']") as HTMLElement;
	/** The tutor's destination in the shared recorder (components/side-tutor-dictation.tsx). */
	const TUTOR = "side-tutor";

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
		await act(async () => button(host).click());
		// Its own destination, never the lesson's plain toggle.
		assert.deepEqual(dictation.calls, [`toggleFor:${TUTOR}`]);
		assert.equal(dictation.destinations[0]?.id, TUTOR);
		assert.equal(typeof dictation.destinations[0]?.append, "function");
	});

	it("while it listens: a small live waveform and a red Stop; the words land in the box when it ends", async () => {
		const dictation = fakeDictation();
		const host = await mountTutor(dictation);
		await act(async () => button(host).click());
		const live = fakeDictation({ phase: "recording", active: true, destinationId: TUTOR });
		await host.rerender(live);
		assert.equal(host.querySelectorAll("[data-testid='side-tutor-meter'] span").length, 14);
		assert.equal(button(host).getAttribute("aria-label"), "Stop dictation");
		assert.match(button(host).className, /text-destructive/);
		// Stop and the waveform are as tall as the typing box, like Dictate and Send.
		assert.ok(button(host).className.split(/\s+/).includes("size-(--lh-tutor-row)"));
		assert.ok((host.querySelector("[data-testid='side-tutor-meter']") as HTMLElement).className.split(/\s+/).includes("h-(--lh-tutor-row)"));
		await act(async () => button(host).click());
		assert.deepEqual(live.calls, ["stop"]);
		// The run ends: dictation.tsx hands the transcript to the run's destination.
		const append = dictation.destinations[0]!.append;
		await act(async () => { await append("what is a mole"); });
		assert.equal((host.querySelector("textarea") as HTMLTextAreaElement).value, "what is a mole");
		// More words join what is there.
		await act(async () => { await append("exactly"); });
		assert.equal((host.querySelector("textarea") as HTMLTextAreaElement).value, "what is a mole exactly");
	});

	it("Send while still listening ends the run first, then asks with the spoken words", async () => {
		const dictation = fakeDictation();
		const host = await mountTutor(dictation);
		await act(async () => button(host).click());
		const live = fakeDictation({ phase: "recording", active: true, destinationId: TUTOR });
		live.finishFor = async (id) => {
			live.calls.push(`finishFor:${id}`);
			await dictation.destinations[0]!.append("why does it fold");
		};
		await host.rerender(live);
		const send = host.querySelector("[aria-label='Ask']") as HTMLButtonElement;
		assert.equal(send.hasAttribute("disabled"), false, "sendable with an empty box while it listens");
		await act(async () => send.click());
		await act(async () => new Promise((r) => setTimeout(r, 20)));
		assert.deepEqual(live.calls, [`finishFor:${TUTOR}`]);
		assert.deepEqual(posted, ["why does it fold"]);
	});

	it("is off while the lesson itself is dictating, and leads to the key when there is none", async () => {
		// The lesson's run: the recorder is busy for the main input, not the tutor.
		const host = await mountTutor(fakeDictation({ phase: "recording", active: true, destinationId: "main" }));
		assert.equal(button(host).hasAttribute("disabled"), true);
		assert.equal(host.querySelector("[data-testid='side-tutor-meter']"), null);
		// No Deepgram key: the button says so, and a click doesn't start a run.
		const keyless = fakeDictation({ error: "Dictation needs a Deepgram key", destinationId: TUTOR });
		const other = await mountTutor(keyless);
		assert.equal(button(other).getAttribute("title"), "Dictation needs a Deepgram key");
		await act(async () => button(other).click());
		assert.deepEqual(keyless.calls, ["clearError"]);
		assert.deepEqual(keyless.destinations, []);
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
		const frame = host.querySelector("[data-testid='side-tutor-frame']") as HTMLElement;
		assert.match(styleOf(frame), /left:\s*300px/);
		assert.match(styleOf(frame), /top:\s*90px/);
	});
});

describe("on a session another device holds (cloud sync)", () => {
	it("the window closes to a greyed bubble that can't be pressed, and comes back after a take-over", async () => {
		const host = await mountTutor();
		assert.ok(host.querySelector("[data-testid='side-tutor']"), "open, as the learner left it");
		await host.rerender(undefined, { held: true });
		assert.equal(document.querySelector("[data-testid='side-tutor']"), null, "no window while it is held elsewhere");
		const bubble = document.querySelector("[data-testid='side-tutor-toggle']") as HTMLElement;
		assert.ok(bubble);
		assert.equal(bubble.getAttribute("data-held"), "");
		assert.equal(bubble.getAttribute("aria-disabled"), "true");
		assert.equal(bubble.getAttribute("title"), "Take this session over first");
		assert.match(bubble.getAttribute("class") ?? "", /opacity-40/);
		await act(async () => bubble.click());
		assert.equal(document.querySelector("[data-testid='side-tutor']"), null, "a press does nothing");
		// Taken over: the tutor is as the learner left it.
		await host.rerender(undefined);
		assert.ok(document.querySelector("[data-testid='side-tutor']"));
	});
});

describe("moving and resizing (computer)", () => {
	const frameOf = (host: HTMLElement) => host.querySelector("[data-testid='side-tutor-frame']") as HTMLElement;
	const zone = (host: HTMLElement, edge: string) => host.querySelector(`[data-testid='side-tutor-resize-${edge}']`) as HTMLElement;
	const classes = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/);
	const px = (el: HTMLElement, prop: string) => Number(new RegExp(`(?:^|;)\\s*${prop}:\\s*(-?[\\d.]+)px`).exec(styleOf(el))?.[1] ?? Number.NaN);
	/** A pointer event React will hear, at a place on screen. */
	const pointer = (el: Element, type: string, x: number, y: number) =>
		act(async () => {
			const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
			Object.assign(event, { clientX: x, clientY: y, pointerId: 1, button: 0 });
			el.dispatchEvent(event);
		});
	/** Press an element, move the pointer by (dx, dy) in two steps, and let go. */
	const drag = async (el: Element, dx: number, dy: number) => {
		await pointer(el, "pointerdown", 500, 400);
		await pointer(el, "pointermove", 500 + dx / 2, 400 + dy / 2);
		await pointer(el, "pointermove", 500 + dx, 400 + dy);
		await pointer(el, "pointerup", 500 + dx, 400 + dy);
	};
	// The test's window is 1280 x 800, and every element measures 352 x 480.
	const at = (left: number, top: number) => storage.set("lh:side-tutor:pos", JSON.stringify({ left, top }));

	it("has five resize zones around the window: the sides, the bottom and the bottom corners; none at the top", async () => {
		const host = await mountTutor();
		const frame = frameOf(host);
		const panel = host.querySelector("[data-testid='side-tutor']") as HTMLElement;
		assert.equal(panel.parentElement, frame);
		// The zones are beside the window, not in it: its parts are still its only children.
		assert.equal(panel.children.length, 3);
		assert.deepEqual([...frame.children].slice(1).map((el) => el.getAttribute("data-testid")), ["side-tutor-resize-left", "side-tutor-resize-right", "side-tutor-resize-bottom", "side-tutor-resize-bottom-left", "side-tutor-resize-bottom-right"]);
		// Each shows the pointer for its direction.
		assert.ok(classes(zone(host, "left")).includes("cursor-ew-resize"));
		assert.ok(classes(zone(host, "right")).includes("cursor-ew-resize"));
		assert.ok(classes(zone(host, "bottom")).includes("cursor-ns-resize"));
		assert.ok(classes(zone(host, "bottom-left")).includes("cursor-nesw-resize"));
		assert.ok(classes(zone(host, "bottom-right")).includes("cursor-nwse-resize"));
		// The side strips start under the top bar, which is for moving the window.
		for (const edge of ["left", "right"]) assert.ok(classes(zone(host, edge)).includes("top-10"), edge);
		// The strips sit ON the window's edges (owner's ask: mostly outside it,
		// they were hard to find): 12 px thick, 4 px of it outside the edge and
		// 8 px inside, over the window's own empty rim.
		for (const [edge, out, thick] of [["left", "-left-1", "w-3"], ["right", "-right-1", "w-3"], ["bottom", "-bottom-1", "h-3"]] as const) {
			assert.ok(classes(zone(host, edge)).includes(out) && classes(zone(host, edge)).includes(thick), edge);
		}
		// A corner is an L, 32 px along each arm from its outer tip, with its
		// inner square cut away so the typing box and Send keep their corners.
		for (const edge of ["bottom-left", "bottom-right"]) {
			assert.ok(classes(zone(host, edge)).includes("size-8") && classes(zone(host, edge)).includes("-bottom-1"), edge);
			assert.match(styleOf(zone(host, edge)), /clip-path:\s*polygon\(/, edge);
		}
		assert.match(styleOf(zone(host, "bottom-left")), /polygon\(0 0, 12px 0, 12px 20px, 32px 20px, 32px 32px, 0 32px\)/);
		assert.match(styleOf(zone(host, "bottom-right")), /polygon\(20px 0, 32px 0, 32px 32px, 0 32px, 0 20px, 20px 20px\)/);
		// The strips where the corners end: 28 px along the window's edges.
		for (const edge of ["left", "right"]) assert.ok(classes(zone(host, edge)).includes("bottom-7"), edge);
		assert.ok(classes(zone(host, "bottom")).includes("left-7") && classes(zone(host, "bottom")).includes("right-7"));
		for (const edge of ["left", "right", "bottom"]) assert.doesNotMatch(styleOf(zone(host, edge)), /clip-path/, edge);
		// The conversation's scrollbar stays clear of the right strip: the
		// scrolling part ends 8 px short of the edge, and gives the words
		// those 8 px back from its right padding.
		const scroll = panel.querySelector("[data-testid='side-tutor-scroll']") as HTMLElement;
		assert.equal(scroll.parentElement, panel.querySelector("[data-testid='side-tutor-body']"));
		for (const c of ["mr-2", "pl-3", "pr-1", "overflow-y-auto"]) assert.ok(classes(scroll).includes(c), c);
		assert.ok(!classes(scroll).includes("px-3"));
		// Nothing is drawn, and nothing is read out.
		for (const el of [...frame.children].slice(1)) {
			assert.equal(el.getAttribute("aria-hidden"), "true");
			assert.deepEqual(classes(el).filter((c) => /^(bg|border|ring|shadow)-/.test(c)), []);
		}
		// The browser's own corner grip is gone.
		assert.ok(!classes(panel).includes("resize") && !classes(frame).includes("resize"));
	});

	it("the right side makes it wider and the bottom taller; the top left corner stays", async () => {
		at(400, 100);
		const host = await mountTutor();
		const frame = frameOf(host);
		// Until it is resized, the size is the frame's own.
		assert.doesNotMatch(styleOf(frame), /width:|height:/);
		await drag(zone(host, "right"), 80, 33);
		assert.deepEqual([px(frame, "left"), px(frame, "top"), px(frame, "width"), px(frame, "height")], [400, 100, 432, 480]);
		await drag(zone(host, "bottom"), 55, 60);
		assert.deepEqual([px(frame, "left"), px(frame, "top"), px(frame, "width"), px(frame, "height")], [400, 100, 432, 540]);
	});

	it("the left side moves the left edge and keeps the right edge", async () => {
		at(400, 100);
		const host = await mountTutor();
		const frame = frameOf(host);
		await drag(zone(host, "left"), -120, 50);
		assert.deepEqual([px(frame, "left"), px(frame, "top"), px(frame, "width"), px(frame, "height")], [280, 100, 472, 480]);
		assert.equal(px(frame, "left") + px(frame, "width"), 400 + 352);
	});

	it("a bottom corner changes the width and the height together", async () => {
		at(400, 100);
		const host = await mountTutor();
		const frame = frameOf(host);
		await drag(zone(host, "bottom-left"), -48, 40);
		assert.deepEqual([px(frame, "left"), px(frame, "top"), px(frame, "width"), px(frame, "height")], [352, 100, 400, 520]);
	});

	it("stops at the smallest window and at the app window's edges", async () => {
		at(400, 100);
		const host = await mountTutor();
		const frame = frameOf(host);
		await drag(zone(host, "bottom-right"), -2000, -2000);
		assert.deepEqual([px(frame, "left"), px(frame, "top"), px(frame, "width"), px(frame, "height")], [400, 100, 288, 224]);
		await drag(zone(host, "bottom-right"), 5000, 5000);
		assert.deepEqual([px(frame, "left") + px(frame, "width"), px(frame, "top") + px(frame, "height")], [1280 - 8, 800 - 8]);
	});

	it("remembers the size: after minimizing, and after a reload", async () => {
		at(400, 100);
		const host = await mountTutor();
		await drag(zone(host, "bottom-right"), 100, 50);
		assert.deepEqual(JSON.parse(storage.get("lh:side-tutor:size") ?? "null"), { width: 452, height: 530 });
		const bubble = await minimize(host);
		await act(async () => bubble.click());
		assert.deepEqual([px(frameOf(host), "width"), px(frameOf(host), "height")], [452, 530]);
		// A reload: a new window reads what was stored.
		const again = await mountTutor();
		assert.deepEqual([px(frameOf(again), "left"), px(frameOf(again), "top"), px(frameOf(again), "width"), px(frameOf(again), "height")], [400, 100, 452, 530]);
	});

	it("remembers where a resize from the left put the window", async () => {
		at(400, 100);
		const host = await mountTutor();
		await drag(zone(host, "left"), -100, 0);
		assert.deepEqual(JSON.parse(storage.get("lh:side-tutor:pos") ?? "null"), { left: 300, top: 100 });
		assert.deepEqual(JSON.parse(storage.get("lh:side-tutor:size") ?? "null"), { width: 452, height: 480 });
	});

	it("the top bar still moves the window, and changes no size", async () => {
		at(400, 100);
		const host = await mountTutor();
		const frame = frameOf(host);
		const bar = (host.querySelector("[data-testid='side-tutor']") as HTMLElement).firstElementChild as HTMLElement;
		Object.assign(bar, { setPointerCapture() {}, releasePointerCapture() {} });
		await drag(bar, 70, -40);
		assert.deepEqual([px(frame, "left"), px(frame, "top")], [470, 60]);
		assert.doesNotMatch(styleOf(frame), /width:|height:/);
		assert.equal(storage.get("lh:side-tutor:size"), undefined);
	});

	it("on a phone there is no frame box and nothing to resize", async () => {
		Object.assign(dom.window, { matchMedia: (query: string) => ({ matches: query.includes("max-width"), addEventListener() {}, removeEventListener() {} }) });
		try {
			storage.set("lh:side-tutor:size", JSON.stringify({ width: 600, height: 600 }));
			const host = await mountTutor();
			// A phone starts with the tutor closed: open the sheet.
			await act(async () => (document.querySelector("[data-testid='side-tutor-toggle']") as HTMLElement).click());
			const frame = frameOf(host);
			const sheet = host.querySelector("[data-testid='side-tutor']") as HTMLElement;
			assert.deepEqual(classes(frame), ["contents"]);
			assert.equal(styleOf(frame), "");
			assert.equal(frame.children.length, 1, "only the sheet");
			assert.equal(host.querySelectorAll("[data-testid^='side-tutor-resize-']").length, 0);
			// The sheet is its own fixed box, placed and sized by app/phone.css.
			assert.ok(classes(sheet).includes("fixed"));
			assert.equal(styleOf(sheet), "");
			// Its conversation runs the full width, with the same space on both sides.
			const scroll = sheet.querySelector("[data-testid='side-tutor-scroll']") as HTMLElement;
			assert.ok(classes(scroll).includes("px-3") && !classes(scroll).includes("mr-2"));
			// app/phone.css sets the text size on the sheet's second part; the
			// scrolling part inside it must not set one of its own.
			assert.equal(scroll.parentElement, sheet.children[1]);
			assert.deepEqual(classes(scroll).filter((c) => /^text-/.test(c)), []);
		} finally {
			delete (dom.window as unknown as Record<string, unknown>).matchMedia;
		}
	});
});
