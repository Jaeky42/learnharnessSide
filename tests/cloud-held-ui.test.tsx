/**
 * Cloud sync Phase 6, slice 2 (docs/cloud-sync.md): a session another
 * device holds. The page's shared sync state, the "Held by …" line in the
 * session list, the strip under the top bar, Take over with its waiting
 * lines and Cancel, and the warning box. fetch is scripted; no server. The
 * wording is the owner-approved wording.
 */

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import {
	askingText, cannotTakeOverText, finishingText, HELD_TEXT, heldByText, heldStripText, holderName, takeOverWarning, type SessionHolder,
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
const { CloudProvider, useCloud } = await import("../components/cloud/cloud-state.tsx");
const { SessionStrip } = await import("../components/cloud/session-strip.tsx");

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

type Cloud = { role: "server" | "desktop"; held: Record<string, SessionHolder>; sync?: { state: string; message: string | null; lastContactAt: number | null }; notices?: unknown[]; desktops?: unknown[] };

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
	await act(async () => root.render(<ServerEventsProvider connect={live.connect}><CloudProvider>{node}</CloudProvider></ServerEventsProvider>));
	await settle();
	return Object.assign(host, { live });
}

const byTest = (root: ParentNode, id: string) => root.querySelector(`[data-testid='${id}']`);
const click = async (el: Element | null | undefined) => { assert.ok(el, "the control exists"); await act(async () => { (el as HTMLElement).click(); }); await settle(); };
const strip = (host: Element) => byTest(host, "session-strip") as HTMLElement | null;
const stripText = (host: Element) => byTest(host, "session-strip-text")?.textContent ?? null;
const isOpen = (host: Element) => strip(host)?.hasAttribute("data-open") === true;
const fireTimeout = async (ms: number) => {
	const due = timeouts.filter((t) => t.ms === ms);
	timeouts = timeouts.filter((t) => t.ms !== ms);
	await act(async () => { for (const t of due) t.run(); });
	await settle();
};

const NOW = Date.now();
const desk = (over: Partial<SessionHolder> = {}): SessionHolder => ({ id: "dev_aaaaaaaaaaaaaaaa", name: "Desktop", online: false, lastSeenAt: NOW - 3 * 3_600_000, ...over });
const webApp: SessionHolder = { id: "cloud", name: null };
const okSync = { state: "ok", message: null, lastContactAt: NOW };

function Probe() {
	const cloud = useCloud();
	return <output data-testid="probe">{JSON.stringify({ role: cloud.role, held: Object.keys(cloud.held), sync: cloud.sync?.state ?? null })}</output>;
}
const probe = (host: Element) => JSON.parse(byTest(host, "probe")?.textContent ?? "{}") as { role: string | null; held: string[]; sync: string | null };

describe("the approved words for a held session", () => {
	it("names the holder: a PC by its name, the server as the web app", () => {
		assert.equal(holderName(desk()), "Desktop");
		assert.equal(holderName(webApp), "the web app");
		assert.equal(heldByText(desk()), "Held by Desktop");
		assert.equal(heldByText(webApp), "Held by the web app");
		assert.equal(heldByText({ id: "dev_cccccccccccccccc", name: null }), "Held by another device", "a PC whose name isn't known");
	});

	it("the strip: the server's site says online or offline since when; a desktop app knows only the name", () => {
		assert.equal(heldStripText(desk({ online: true }), null), "Held by Desktop · online");
		assert.equal(heldStripText(desk(), "today, 14:02"), "Held by Desktop · offline since today, 14:02");
		assert.equal(heldStripText(desk({ lastSeenAt: null }), null), "Held by Desktop · offline");
		assert.equal(heldStripText({ id: "cloud", name: null }, null), "Held by the web app");
		assert.equal(heldStripText({ id: "dev_bbbbbbbbbbbbbbbb", name: "Laptop" }, null), "Held by Laptop");
	});

	it("the waiting lines, for a PC and for the web app", () => {
		assert.equal(askingText(desk()), "Asking Desktop to hand it over…");
		assert.equal(finishingText(desk()), "Desktop is finishing a reply. This session moves here when it's done.");
		assert.equal(askingText(webApp), "Asking the web app to hand it over…");
		assert.equal(finishingText(webApp), "The web app is finishing a reply. This session moves here when it's done.");
	});

	it("the warning box, the buttons and the tooltip", () => {
		assert.deepEqual(takeOverWarning("Circuits", desk(), "today, 14:02"), {
			title: "Take over “Circuits”?",
			body: "Desktop has been offline since today, 14:02, and may have turns that never reached the server. If you take over, those turns are discarded when Desktop is back online.",
		});
		assert.equal(takeOverWarning("Circuits", desk(), null).body, "Desktop is offline and may have turns that never reached the server. If you take over, those turns are discarded when Desktop is back online.");
		assert.deepEqual(HELD_TEXT, { takeOver: "Take over", cancel: "Cancel", failed: "Couldn't take it over. Try again.", blocked: "Take this session over first", takeOverAnyway: "Take over anyway" });
	});

	it("why a PC can't take over right now", () => {
		assert.equal(cannotTakeOverText("offline"), "This PC can't reach the server, so it can't be taken over right now.");
		assert.equal(cannotTakeOverText("paused"), "Sync is paused, so it can't be taken over right now.");
		assert.equal(cannotTakeOverText("needs-pairing"), "This PC is no longer paired, so it can't be taken over right now.");
		assert.equal(cannotTakeOverText("ok"), null);
		assert.equal(cannotTakeOverText("starting"), null);
		assert.equal(cannotTakeOverText(undefined), null);
	});
});

describe("what the page knows about sync", () => {
	it("an app that isn't paired asks nothing and sets no timer", async () => {
		const { gets } = script(() => ({ role: "desktop", held: {} }));
		const live = channel();
		const host = await mount(<><Probe /><SessionStrip chatId="chat_1" title="Circuits" /></>, live);
		await live.fire("chats-changed");
		await live.fire("cloud-changed");
		assert.deepEqual(gets, [], "no marker: not one request about sync");
		assert.deepEqual(intervals, []);
		assert.deepEqual(probe(host), { role: null, held: [], sync: null });
		assert.equal(strip(host), null, "and no strip in the lesson at all");
	});

	it("where sync is in use it asks at the start, when the live channel says so, and every 10 seconds", async () => {
		cookie = "lh_cloud=1";
		let held: Record<string, SessionHolder> = {};
		const { gets } = script(() => ({ role: "desktop", held, sync: okSync, notices: [] }));
		const live = channel();
		const host = await mount(<Probe />, live);
		assert.deepEqual(gets, ["/api/cloud"]);
		assert.deepEqual(probe(host), { role: "desktop", held: [], sync: "ok" });
		assert.deepEqual(intervals.map((i) => i.ms), [10_000]);
		held = { chat_1: webApp };
		await live.fire("chats-changed");
		assert.deepEqual(probe(host).held, ["chat_1"]);
		held = {};
		await live.fire("cloud-changed");
		assert.deepEqual(probe(host).held, []);
		held = { chat_2: desk() };
		await act(async () => { intervals[0]!.run(); });
		await settle();
		assert.deepEqual(probe(host).held, ["chat_2"]);
		assert.equal(gets.length, 4);
	});

	it("Settings → Cloud pairing or unpairing switches it on and off at once", async () => {
		const { gets } = script(() => ({ role: "desktop", held: { chat_1: webApp }, sync: okSync }));
		const { announceSyncInUse } = await import("../components/cloud/sync-marker.ts");
		const host = await mount(<Probe />);
		assert.deepEqual(gets, []);
		await act(async () => announceSyncInUse(true));
		await settle();
		assert.deepEqual(probe(host).held, ["chat_1"]);
		await act(async () => announceSyncInUse(false));
		await settle();
		assert.deepEqual(probe(host), { role: null, held: [], sync: null }, "after Unpair nothing is held and nothing is asked");
		assert.deepEqual(intervals, []);
	});
});

describe("the session list", () => {
	it("a held session's second line reads Held by … in place of the time", async () => {
		const { SessionRow } = await import("../components/sidebar.tsx");
		const chat = { id: "chat_1", title: "Circuits", updatedAt: new Date(NOW - 7_200_000).toISOString(), busy: false, pendingQuestion: true } as never;
		const plain = renderToStaticMarkup(<SessionRow chat={chat} active={false} onOpen={() => {}} />);
		assert.match(plain, /Waiting for input/);
		assert.doesNotMatch(plain, /Held by/);
		const held = renderToStaticMarkup(<SessionRow chat={chat} active={false} onOpen={() => {}} heldBy="Held by Desktop" />);
		assert.match(held, />Held by Desktop</);
		assert.doesNotMatch(held, /Waiting for input|ago/);
		assert.match(held, />Circuits</);
	});
});

describe("the strip under the top bar", () => {
	it("on the server's site: who holds it, online or offline since when, and Take over", async () => {
		cookie = "lh_cloud=1";
		let holder = desk({ online: true });
		script(() => ({ role: "server", held: { chat_1: holder }, desktops: [] }));
		const live = channel();
		const host = await mount(<SessionStrip chatId="chat_1" title="Circuits" />, live);
		assert.equal(isOpen(host), true);
		assert.equal(stripText(host), "Held by Desktop · online");
		assert.equal(byTest(host, "take-over")?.textContent, "Take over");
		assert.equal(byTest(host, "take-over")?.hasAttribute("disabled"), false);
		assert.equal(byTest(host, "session-strip-note"), null);
		holder = desk();
		await live.fire("chats-changed");
		assert.match(stripText(host) ?? "", /^Held by Desktop · offline since .+/);
	});

	it("on a desktop app: only the holder's name", async () => {
		cookie = "lh_cloud=1";
		script(() => ({ role: "desktop", held: { chat_1: webApp, chat_2: { id: "dev_bbbbbbbbbbbbbbbb", name: "Laptop" } }, sync: okSync }));
		const host = await mount(<><SessionStrip chatId="chat_1" title="Circuits" /><div data-other=""><SessionStrip chatId="chat_2" title="Motors" /></div></>);
		assert.equal(stripText(host), "Held by the web app");
		assert.equal(stripText(host.querySelector("[data-other]")!), "Held by Laptop");
	});

	it("a session this copy can continue has no strip showing", async () => {
		cookie = "lh_cloud=1";
		script(() => ({ role: "desktop", held: { chat_other: webApp }, sync: okSync }));
		const host = await mount(<SessionStrip chatId="chat_1" title="Circuits" />);
		assert.equal(isOpen(host), false);
		assert.equal(stripText(host), null);
		assert.equal(byTest(host, "take-over"), null);
		assert.equal(strip(host)?.hasAttribute("inert"), true, "nothing in it can be reached");
	});

	it("opens and closes by an attribute, so it can fade and slide both ways, and keeps its words while it closes", async () => {
		cookie = "lh_cloud=1";
		let held: Record<string, SessionHolder> = {};
		script(() => ({ role: "desktop", held, sync: okSync }));
		const live = channel();
		const host = await mount(<SessionStrip chatId="chat_1" title="Circuits" />, live);
		assert.equal(isOpen(host), false);
		held = { chat_1: webApp };
		await live.fire("chats-changed");
		assert.equal(isOpen(host), true);
		assert.equal(strip(host)?.className, "lh-strip", "the motion is app/cloud.css's");
		held = {};
		await live.fire("chats-changed");
		assert.equal(isOpen(host), false);
		assert.equal(stripText(host), "Held by the web app", "still there to slide away");
	});

	it("a PC that can't reach its server: Take over is off, and the strip says why", async () => {
		cookie = "lh_cloud=1";
		const { posts } = script(() => ({ role: "desktop", held: { chat_1: webApp }, sync: { state: "offline", message: null, lastContactAt: NOW - 60_000 } }));
		const host = await mount(<SessionStrip chatId="chat_1" title="Circuits" />);
		assert.equal(stripText(host), "Held by the web app");
		assert.equal(byTest(host, "session-strip-note")?.textContent, "This PC can't reach the server, so it can't be taken over right now.");
		assert.equal(byTest(host, "take-over")?.hasAttribute("disabled"), true);
		await click(byTest(host, "take-over"));
		assert.deepEqual(posts, []);
	});
});

describe("Take over", () => {
	it("an idle holder: one request, and the strip goes when the session is here", async () => {
		cookie = "lh_cloud=1";
		let held: Record<string, SessionHolder> = { chat_1: webApp };
		const { posts } = script(() => ({ role: "desktop", held, sync: okSync }), () => { held = {}; return { status: "moved" }; });
		const host = await mount(<SessionStrip chatId="chat_1" title="Circuits" />);
		await click(byTest(host, "take-over"));
		assert.deepEqual(posts, [{ op: "take-over", chatId: "chat_1", force: false }]);
		assert.equal(isOpen(host), false, "the page asked again and the session is no longer held");
		assert.equal(byTest(document, "take-over-dialog"), null);
	});

	it("an online holder: the strip changes in place and the app asks again every 2 seconds", async () => {
		cookie = "lh_cloud=1";
		let held: Record<string, SessionHolder> = { chat_1: desk({ online: true }) };
		const answers: unknown[] = [{ status: "waiting", reason: "handing-over" }, { status: "waiting", reason: "reply" }, { status: "moved" }];
		const { posts } = script(() => ({ role: "server", held }), () => { const next = answers.shift(); if ((next as { status: string }).status === "moved") held = {}; return next; });
		const host = await mount(<SessionStrip chatId="chat_1" title="Circuits" />);
		await click(byTest(host, "take-over"));
		assert.equal(stripText(host), "Asking Desktop to hand it over…");
		assert.equal(byTest(host, "take-over"), null);
		assert.equal(byTest(host, "take-over-cancel")?.textContent, "Cancel");
		assert.equal(strip(host)?.getAttribute("data-strip"), "waiting-handing-over");
		assert.deepEqual(timeouts.map((t) => t.ms), [2000]);
		await fireTimeout(2000);
		assert.equal(stripText(host), "Desktop is finishing a reply. This session moves here when it's done.");
		assert.equal(strip(host)?.getAttribute("data-strip"), "waiting-reply", "new words, so they cross-fade");
		await fireTimeout(2000);
		assert.equal(posts.length, 3);
		assert.ok(posts.every((p) => p.force === false), "nothing is ever forced while waiting");
		assert.equal(isOpen(host), false);
	});

	it("Cancel stops asking and leaves the session with its holder", async () => {
		cookie = "lh_cloud=1";
		const { posts } = script(() => ({ role: "server", held: { chat_1: desk({ online: true }) } }), () => ({ status: "waiting", reason: "handing-over" }));
		const host = await mount(<SessionStrip chatId="chat_1" title="Circuits" />);
		await click(byTest(host, "take-over"));
		await click(byTest(host, "take-over-cancel"));
		assert.equal(stripText(host), "Held by Desktop · online");
		assert.ok(byTest(host, "take-over"));
		assert.deepEqual(timeouts.filter((t) => t.ms === 2000), [], "no further request is due");
		assert.equal(posts.length, 1);
	});

	it("the web app as the holder, writing a reply", async () => {
		cookie = "lh_cloud=1";
		script(() => ({ role: "desktop", held: { chat_1: webApp }, sync: okSync }), () => ({ status: "waiting", reason: "reply" }));
		const host = await mount(<SessionStrip chatId="chat_1" title="Circuits" />);
		await click(byTest(host, "take-over"));
		assert.equal(stripText(host), "The web app is finishing a reply. This session moves here when it's done.");
	});

	it("an offline holder that may have unsent turns: the warning box, then Take over anyway", async () => {
		cookie = "lh_cloud=1";
		let held: Record<string, SessionHolder> = { chat_1: desk() };
		const { posts } = script(() => ({ role: "server", held }), (body) => {
			if (body.force === true) { held = {}; return { status: "moved" }; }
			return { status: "warning", heldBy: { ...desk(), word: "unsent" } };
		});
		const host = await mount(<SessionStrip chatId="chat_1" title="Circuits" />);
		await click(byTest(host, "take-over"));
		const box = byTest(document, "take-over-dialog")!;
		assert.ok(box, "a box over the lesson");
		assert.equal(byTest(box, "take-over-title")?.textContent, "Take over “Circuits”?");
		assert.match(byTest(box, "take-over-body")?.textContent ?? "", /^Desktop has been offline since .+, and may have turns that never reached the server\. If you take over, those turns are discarded when Desktop is back online\.$/);
		assert.deepEqual([...box.querySelectorAll("button")].map((b) => b.textContent), ["Cancel", "Take over anyway"]);
		assert.equal(stripText(host), "Held by Desktop · offline since " + (stripText(host) ?? "").split("since ")[1], "the strip stays as it was behind the box");
		await click(byTest(box, "take-over-anyway"));
		assert.deepEqual(posts, [{ op: "take-over", chatId: "chat_1", force: false }, { op: "take-over", chatId: "chat_1", force: true }]);
		assert.equal(byTest(document, "take-over-dialog"), null);
		assert.equal(isOpen(host), false);
	});

	it("Cancel in the box takes nothing", async () => {
		cookie = "lh_cloud=1";
		const { posts } = script(() => ({ role: "server", held: { chat_1: desk() } }), () => ({ status: "warning", heldBy: desk() }));
		const host = await mount(<SessionStrip chatId="chat_1" title="Circuits" />);
		await click(byTest(host, "take-over"));
		await click([...byTest(document, "take-over-dialog")!.querySelectorAll("button")].find((b) => b.textContent === "Cancel"));
		assert.equal(byTest(document, "take-over-dialog"), null);
		assert.equal(posts.length, 1);
		assert.equal(byTest(host, "take-over")?.hasAttribute("disabled"), false);
	});

	it("a request that fails says so, and Take over is offered again", async () => {
		cookie = "lh_cloud=1";
		for (const answer of [null, { status: "offline" }, { status: "refused", error: "x" }, { status: "not-paired" }]) {
			script(() => ({ role: "desktop", held: { chat_1: webApp }, sync: okSync }), () => answer);
			const host = await mount(<SessionStrip chatId="chat_1" title="Circuits" />);
			await click(byTest(host, "take-over"));
			assert.equal(stripText(host), "Couldn't take it over. Try again.");
			assert.equal(byTest(host, "take-over")?.hasAttribute("disabled"), false);
		}
	});
});
