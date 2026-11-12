/**
 * Cloud sync Phase 6, slice 3 (docs/cloud-sync.md): the desktop's own
 * notices. The sync chip at the foot of the session list, the offline
 * heads-up strip in a session the PC can continue, the 30-second quiet
 * rule, and the discard box. fetch is scripted; no server. The wording is
 * the owner-approved wording.
 */

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import {
	discardBox, discardedText, OFFLINE_QUIET_MS, SYNC_CHIP_TEXT, SYNC_TROUBLE_STRIP_TEXT, syncTrouble, syncTroubleDueIn, type SessionHolder,
} from "../src/core/sync/screens.ts";
import type { NotifySource } from "../components/server-events.tsx";

const dom = parseHTML("<html><body></body></html>");
let cookie = "";
Object.defineProperty(dom.document, "cookie", { configurable: true, get: () => cookie });
Object.defineProperty(dom.document, "visibilityState", { configurable: true, get: () => "visible" });
Object.assign(globalThis, { window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent });
const { createRoot } = await import("react-dom/client");
const { renderToStaticMarkup } = await import("react-dom/server");
const { ServerEventsProvider } = await import("../components/server-events.tsx");
const { CloudProvider } = await import("../components/cloud/cloud-state.tsx");
const { SessionStrip } = await import("../components/cloud/session-strip.tsx");
const { SyncChip } = await import("../components/cloud/sync-chip.tsx");
const { DiscardNotice } = await import("../components/cloud/discard-notice.tsx");
const { InteractionLayersProvider } = await import("../components/interaction-layers.tsx");
const { installModalDom } = await import("./modal-dom.ts");
// The boxes sit on the host's dialog layer (HostDialog), which uses a few
// browser APIs linkedom lacks.
Object.assign(globalThis, { HTMLElement: dom.window.HTMLElement, Element: dom.window.Element });
after(installModalDom(dom));

const originalFetch = globalThis.fetch;
const realTimers = { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
const roots: { root: Root; host: HTMLElement }[] = [];

/** Repeating checks and "ask again" timers, run by hand. */
let intervals: Array<{ run: () => void; ms: number }> = [];
let timeouts: Array<{ run: () => void; ms: number }> = [];
beforeEach(() => {
	intervals = []; timeouts = [];
	globalThis.setInterval = ((run: () => void, ms: number) => { const entry = { run, ms }; intervals.push(entry); return entry; }) as unknown as typeof setInterval;
	globalThis.clearInterval = ((entry: unknown) => { intervals = intervals.filter((i) => i !== entry); }) as unknown as typeof clearInterval;
	globalThis.setTimeout = ((run: () => void, ms?: number) => {
		// React and the test's own short waits keep the real clock.
		if (ms === undefined || ms < 1000) return realTimers.setTimeout(run, ms);
		const entry = { run, ms }; timeouts.push(entry); return entry;
	}) as unknown as typeof setTimeout;
	globalThis.clearTimeout = ((entry: unknown) => {
		if (timeouts.includes(entry as never)) timeouts = timeouts.filter((t) => t !== entry);
		else realTimers.clearTimeout(entry as never);
	}) as unknown as typeof clearTimeout;
});

afterEach(async () => {
	for (const { root, host } of roots.splice(0)) {
		await act(async () => root.unmount());
		host.remove();
	}
	Object.assign(globalThis, realTimers);
	globalThis.fetch = originalFetch;
	cookie = "";
	for (const el of [...document.body.children]) el.remove();
});

const settle = () => act(async () => new Promise<void>((r) => realTimers.setTimeout(r, 20)));

/** The app's live channel, driven by hand. */
function channel() {
	const handlers = new Map<string, (data: string) => void>();
	const source: NotifySource = { close: () => {}, onOpen: () => {}, onEvent: (name, cb) => { handlers.set(name, cb); } };
	return { connect: () => source, fire: async (name: string) => { await act(async () => handlers.get(name)?.("{}")); await settle(); } };
}

type Sync = { state: string; message: string | null; lastContactAt: number | null; offlineSince?: number | null };
type Cloud = { role: "server" | "desktop"; held: Record<string, SessionHolder>; sync?: Sync; notices?: unknown[]; desktops?: unknown[] };

function script(current: () => Cloud, onPost: (body: Record<string, unknown>) => unknown = () => ({ status: "moved" })) {
	const posts: Record<string, unknown>[] = [];
	const gets: string[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		if ((init?.method ?? "GET") === "GET") { gets.push(String(input)); return Response.json(current()); }
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		posts.push(body);
		const reply = onPost(body);
		return reply === null ? new Response("{}", { status: 500 }) : Response.json(reply);
	}) as typeof fetch;
	return { posts, gets };
}

async function mount(node: React.ReactElement, live = channel()) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push({ root, host });
	await act(async () => root.render(<InteractionLayersProvider><ServerEventsProvider connect={live.connect}><CloudProvider>{node}</CloudProvider></ServerEventsProvider></InteractionLayersProvider>));
	await settle();
	return Object.assign(host, { live });
}

/** A press-and-release on an element, the way the host's backdrop reads one. */
const press = async (target: Element) => {
	for (const type of ["pointerdown", "pointerup", "click"]) {
		await act(async () => {
			const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
			Object.assign(event, { pointerId: 1, isPrimary: true, button: 0 });
			target.dispatchEvent(event);
		});
	}
	await settle();
};
const escape = async () => {
	const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
	Object.assign(event, { key: "Escape" });
	await act(async () => { document.dispatchEvent(event); });
	await settle();
	return event;
};
const byTest = (root: ParentNode, id: string) => root.querySelector(`[data-testid='${id}']`);
const click = async (el: Element | null | undefined) => { assert.ok(el, "the control exists"); await act(async () => { (el as HTMLElement).click(); }); await settle(); };
const strip = (host: Element) => byTest(host, "session-strip") as HTMLElement | null;
const stripText = (host: Element) => byTest(host, "session-strip-text")?.textContent ?? null;
const isOpen = (host: Element) => strip(host)?.hasAttribute("data-open") === true;

const NOW = 1_800_000_000_000;
const realNow = Date.now;
let clock = NOW;
beforeEach(() => { clock = NOW; Date.now = () => clock; cookie = "lh_cloud=1"; });
afterEach(() => { Date.now = realNow; });

/** Move the clock, and run the long timers (the quiet rule's) that came due. */
const pass = async (ms: number) => {
	clock += ms;
	for (const t of timeouts) t.ms -= ms;
	const due = timeouts.filter((t) => t.ms <= 0);
	timeouts = timeouts.filter((t) => !due.includes(t));
	await act(async () => { for (const t of due) t.run(); });
	await settle();
};

const sync = (state: string, more: Partial<Sync> = {}): Sync => ({ state, message: null, lastContactAt: NOW - 5000, offlineSince: null, ...more });
const pc = (s: Sync, more: Partial<Cloud> = {}): Cloud => ({ role: "desktop", held: {}, sync: s, notices: [], ...more });
const chip = (host: Element) => byTest(host, "sync-chip") as HTMLElement | null;
const webApp: SessionHolder = { id: "cloud", name: null };

describe("the approved words", () => {
	it("the chip reads Offline, Sync paused or Not paired", () => {
		assert.deepEqual(SYNC_CHIP_TEXT, { offline: "Offline", paused: "Sync paused", "needs-pairing": "Not paired" });
	});

	it("the heads-up strip, for each reason", () => {
		assert.equal(SYNC_TROUBLE_STRIP_TEXT.offline, "This PC can't reach the server. If this session is taken over on another device before it reconnects, what you add here now is discarded.");
		assert.equal(SYNC_TROUBLE_STRIP_TEXT.paused, "Sync is paused. If this session is taken over on another device before sync is back, what you add here now is discarded.");
		assert.equal(SYNC_TROUBLE_STRIP_TEXT["needs-pairing"], "This PC isn't paired any more. If this session is taken over on another device before you pair again, what you add here now is discarded.");
	});

	it("the discard box for one session", () => {
		assert.deepEqual(discardBox([{ title: "Circuits", turns: 3 }]), {
			title: "“Circuits” was taken over",
			before: "It was taken over on another device while this PC was offline.",
			lines: ["3 messages you sent here never reached the server and were discarded."],
			after: "The session now shows the server's version.",
		});
		assert.equal(discardedText(1), "1 message you sent here never reached the server and was discarded.");
		assert.equal(discardedText(0), "Changes made here that hadn't reached the server were discarded.");
		assert.equal(discardBox([{ title: "  ", turns: 0 }])?.title, "“Untitled session” was taken over");
		assert.equal(discardBox([]), null);
	});

	it("the discard box for several sessions: one box, one line each", () => {
		const box = discardBox([{ title: "Circuits", turns: 3 }, { title: "Motors", turns: 1 }, { title: "Waves", turns: 0 }]);
		assert.equal(box?.title, "Sessions were taken over");
		assert.deepEqual(box?.lines, [
			"“Circuits”: 3 messages you sent here never reached the server and were discarded.",
			"“Motors”: 1 message you sent here never reached the server and was discarded.",
			"“Waves”: Changes made here that hadn't reached the server were discarded.",
		]);
	});
});

describe("quiet for short blips", () => {
	it("paused and removed show at once; all in step, starting and unpaired show nothing", () => {
		assert.deepEqual(syncTroubleDueIn(sync("paused"), NOW), { trouble: "paused", inMs: 0 });
		assert.deepEqual(syncTroubleDueIn(sync("needs-pairing"), NOW), { trouble: "needs-pairing", inMs: 0 });
		for (const state of ["ok", "starting", "unpaired", "off"]) assert.equal(syncTroubleDueIn(sync(state), NOW), null, state);
		assert.equal(syncTroubleDueIn(null, NOW), null);
	});

	it("offline shows 30 seconds after the first failure", () => {
		assert.equal(OFFLINE_QUIET_MS, 30_000);
		assert.deepEqual(syncTroubleDueIn(sync("offline", { offlineSince: NOW - 10_000 }), NOW), { trouble: "offline", inMs: 20_000 });
		assert.equal(syncTrouble(sync("offline", { offlineSince: NOW - 29_999 }), NOW), null);
		assert.equal(syncTrouble(sync("offline", { offlineSince: NOW - 30_000 }), NOW), "offline");
	});

	it("offline shows at once when the app started with no connection", () => {
		assert.equal(syncTrouble(sync("offline", { lastContactAt: null, offlineSince: NOW - 100 }), NOW), "offline");
	});
});

describe("the sync chip", () => {
	const mountChip = async (opened: string[] = []) => mount(<SyncChip onOpen={() => opened.push("cloud")} />);

	it("a PC that was never paired: no request, no chip", async () => {
		cookie = "";
		const { gets } = script(() => pc(sync("offline", { lastContactAt: null })));
		const host = await mountChip();
		assert.equal(chip(host), null);
		assert.deepEqual(gets, []);
		assert.deepEqual(intervals, []);
	});

	it("all in step: no chip at all", async () => {
		script(() => pc(sync("ok")));
		const host = await mountChip();
		assert.equal(chip(host), null);
	});

	it("offline since the app started: the chip at once, and a click opens Settings → Cloud", async () => {
		script(() => pc(sync("offline", { lastContactAt: null, offlineSince: NOW - 200 })));
		const opened: string[] = [];
		const host = await mountChip(opened);
		assert.equal(chip(host)?.textContent, "Offline");
		assert.equal(chip(host)?.getAttribute("data-state"), "offline");
		assert.match(chip(host)?.className ?? "", /uppercase/);
		assert.match(chip(host)?.className ?? "", /text-warning/, "the theme's warning colour (amber on the Default theme)");
		assert.ok(chip(host)?.querySelector("svg"), "the outline ring");
		await click(chip(host));
		assert.deepEqual(opened, ["cloud"]);
	});

	it("a short blip shows nothing; after 30 seconds the chip appears by itself", async () => {
		script(() => pc(sync("offline", { offlineSince: NOW - 4000 })));
		const host = await mountChip();
		assert.equal(chip(host), null);
		await pass(20_000);
		assert.equal(chip(host), null, "24 seconds in");
		await pass(6100);
		assert.equal(chip(host)?.textContent, "Offline");
	});

	it("goes as soon as the PC is back, on the live channel's word", async () => {
		let state = sync("offline", { offlineSince: NOW - 60_000 });
		script(() => pc(state));
		const host = await mountChip();
		assert.equal(chip(host)?.textContent, "Offline");
		state = sync("ok");
		await host.live.fire("cloud-changed");
		assert.equal(chip(host), null);
	});

	it("Sync paused, and Not paired when the server removed this PC", async () => {
		let state = sync("paused", { message: "Update the server to continue syncing" });
		script(() => pc(state));
		const host = await mountChip();
		assert.equal(chip(host)?.textContent, "Sync paused");
		state = sync("needs-pairing");
		await host.live.fire("cloud-changed");
		assert.equal(chip(host)?.textContent, "Not paired");
	});

	it("never after the learner's own Unpair, and never on the server's site", async () => {
		let answer: Cloud = pc(sync("unpaired"));
		script(() => answer);
		const host = await mountChip();
		assert.equal(chip(host), null);
		answer = { role: "server", held: {}, desktops: [] };
		await host.live.fire("cloud-changed");
		assert.equal(chip(host), null);
	});
});

describe("the offline heads-up strip", () => {
	it("in a session the PC can continue, while it can't reach the server: the words, and no button", async () => {
		script(() => pc(sync("offline", { offlineSince: NOW - 45_000 })));
		const host = await mount(<SessionStrip chatId="chat_1" title="Circuits" />);
		assert.equal(isOpen(host), true);
		assert.equal(strip(host)?.getAttribute("data-strip"), "sync-offline");
		assert.equal(stripText(host), SYNC_TROUBLE_STRIP_TEXT.offline);
		assert.equal(byTest(host, "take-over"), null);
		assert.equal(byTest(host, "take-over-cancel"), null);
	});

	it("waits out the first 30 seconds, then opens; closes when the PC is back", async () => {
		let state = sync("offline", { offlineSince: NOW - 1000 });
		script(() => pc(state));
		const host = await mount(<SessionStrip chatId="chat_1" title="Circuits" />);
		assert.equal(isOpen(host), false);
		await pass(29_100);
		assert.equal(isOpen(host), true);
		state = sync("ok");
		await host.live.fire("cloud-changed");
		assert.equal(isOpen(host), false);
	});

	it("paused, and removed by the server", async () => {
		let state = sync("paused");
		script(() => pc(state));
		const host = await mount(<SessionStrip chatId="chat_1" title="Circuits" />);
		assert.equal(stripText(host), SYNC_TROUBLE_STRIP_TEXT.paused);
		state = sync("needs-pairing");
		await host.live.fire("cloud-changed");
		assert.equal(stripText(host), SYNC_TROUBLE_STRIP_TEXT["needs-pairing"]);
		assert.equal(strip(host)?.getAttribute("data-strip"), "sync-needs-pairing");
	});

	it("a held session keeps its own strip, not the heads-up", async () => {
		script(() => pc(sync("offline", { offlineSince: NOW - 45_000 }), { held: { chat_1: webApp } }));
		const host = await mount(<SessionStrip chatId="chat_1" title="Circuits" />);
		assert.equal(stripText(host), "Held by the web app");
		assert.equal(strip(host)?.getAttribute("data-strip"), "held");
	});

	it("never on the server's site, and never after the learner's own Unpair", async () => {
		let answer: Cloud = { role: "server", held: {}, desktops: [] };
		script(() => answer);
		const host = await mount(<SessionStrip chatId="chat_1" title="Circuits" />);
		assert.equal(isOpen(host), false);
		answer = pc(sync("unpaired"));
		await host.live.fire("cloud-changed");
		assert.equal(isOpen(host), false);
	});
});

describe("the discard box", () => {
	const box = () => byTest(document, "discard-dialog");
	const one = { chatId: "chat_1", title: "Circuits", turns: 3, at: NOW - 1000 };
	const two = { chatId: "chat_2", title: "Motors", turns: 1, at: NOW - 900 };

	it("nothing to say: no box", async () => {
		script(() => pc(sync("ok")));
		await mount(<DiscardNotice />);
		assert.equal(box(), null);
	});

	it("one session: its name, what went, and OK clears it for good", async () => {
		let notices = [one];
		const { posts } = script(() => pc(sync("ok"), { notices }), (body) => { notices = []; return { notices: [], echoed: body.op }; });
		await mount(<DiscardNotice />);
		assert.equal(byTest(document, "discard-title")?.textContent, "“Circuits” was taken over");
		assert.equal(byTest(document, "discard-body")?.textContent, "It was taken over on another device while this PC was offline. 3 messages you sent here never reached the server and were discarded. The session now shows the server's version.");
		assert.equal(byTest(document, "discard-ok")?.textContent, "OK");
		await click(byTest(document, "discard-ok"));
		assert.deepEqual(posts, [{ op: "dismiss-notice", chatId: "chat_1", at: one.at }]);
		assert.equal(box(), null);
	});

	it("stays away while the server is told, even if the page looks again first", async () => {
		const { posts } = script(() => pc(sync("ok"), { notices: [one] }));
		const host = await mount(<DiscardNotice />);
		await click(byTest(document, "discard-ok"));
		await host.live.fire("chats-changed");
		assert.equal(posts.length, 1);
		assert.equal(box(), null, "read once, shown once");
	});

	it("several sessions: one box, one line each, and OK clears them all", async () => {
		const { posts } = script(() => pc(sync("ok"), { notices: [one, two] }));
		await mount(<DiscardNotice />);
		assert.equal(byTest(document, "discard-title")?.textContent, "Sessions were taken over");
		assert.deepEqual([...document.querySelectorAll("[data-testid='discard-line']")].map((li) => li.textContent), [
			"“Circuits”: 3 messages you sent here never reached the server and were discarded.",
			"“Motors”: 1 message you sent here never reached the server and was discarded.",
		]);
		await click(byTest(document, "discard-ok"));
		assert.deepEqual(posts.map((p) => p.chatId), ["chat_1", "chat_2"]);
		assert.equal(box(), null);
	});

	it("a notice that arrives later opens the box then", async () => {
		let notices: unknown[] = [];
		script(() => pc(sync("ok"), { notices }));
		const host = await mount(<DiscardNotice />);
		assert.equal(box(), null);
		notices = [one];
		await host.live.fire("cloud-changed");
		assert.equal(byTest(document, "discard-title")?.textContent, "“Circuits” was taken over");
	});

	it("only OK closes it: Esc and a click outside do nothing, and the Esc goes no further", async () => {
		const { posts } = script(() => pc(sync("ok"), { notices: [one] }));
		await mount(<DiscardNotice />);
		const layer = document.querySelector("[role='dialog'][data-interaction-layer]");
		assert.ok(layer?.contains(box()), "on the host's dialog layer");
		assert.equal(layer?.getAttribute("aria-label"), "“Circuits” was taken over");
		assert.equal(document.activeElement, byTest(document, "discard-ok"), "OK has the focus, as before");
		const event = await escape();
		assert.equal(event.defaultPrevented, true, "a refusing box still takes the Esc");
		assert.ok(box());
		await press(byTest(document, "discard-backdrop")!);
		assert.ok(box());
		assert.deepEqual(posts, []);
		await click(byTest(document, "discard-ok"));
		assert.equal(box(), null);
	});

	it("mounted outside the app's layers, it brings its own and still shows", async () => {
		script(() => pc(sync("ok"), { notices: [one] }));
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		roots.push({ root, host });
		const live = channel();
		await act(async () => root.render(<ServerEventsProvider connect={live.connect}><CloudProvider><DiscardNotice /></CloudProvider></ServerEventsProvider>));
		await settle();
		assert.equal(byTest(document, "discard-title")?.textContent, "“Circuits” was taken over");
		await escape();
		assert.ok(box());
	});

	it("never on the server's site", async () => {
		script(() => ({ role: "server", held: {}, desktops: [], notices: [one] }));
		await mount(<DiscardNotice />);
		assert.equal(box(), null);
	});
});
