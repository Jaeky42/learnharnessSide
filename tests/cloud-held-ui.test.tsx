/**
 * Cloud sync (docs/cloud-sync.md), seamless sessions: a session another
 * device holds looks like any other. The page's shared sync state, the
 * session list's plain lines, and the floating box at the top of a lesson
 * (a failed move, sync trouble), which names no holder and offers no
 * Take over. fetch is scripted; no server. The wording is the
 * owner-approved wording.
 */

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import * as screens from "../src/core/sync/screens.ts";
import { SESSION_MOVE_FAILED_TEXT, SYNC_TROUBLE_BOX_TEXT, type SessionHolder } from "../src/core/sync/screens.ts";
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
const { SessionStrip, resetSessionBoxForTests } = await import("../components/cloud/session-strip.tsx");
const move = await import("../components/cloud/session-move.ts");
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
	resetSessionBoxForTests();
	move.resetSessionMoveForTests();
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
const strip = (host: Element) => byTest(host, "session-box") as HTMLElement | null;
const stripText = (host: Element) => byTest(host, "session-box-text")?.textContent ?? null;
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
		assert.equal(strip(host), null, "and no box in the lesson at all");
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

describe("the session list (seamless sessions)", () => {
	it("a session reads the same whichever device holds it: no Held by line", async () => {
		const { SessionRow } = await import("../components/sidebar.tsx");
		const chat = { id: "chat_1", title: "Circuits", updatedAt: new Date(NOW - 7_200_000).toISOString(), busy: false, pendingQuestion: true } as never;
		const plain = renderToStaticMarkup(<SessionRow chat={chat} active={false} onOpen={() => {}} />);
		assert.match(plain, /Waiting for input/);
		assert.match(plain, />Circuits</);
		assert.doesNotMatch(plain, /Held by|data-held/);
		const source = readFileSync(new URL("../components/sidebar.tsx", import.meta.url), "utf8");
		assert.doesNotMatch(source, /heldBy|heldByText|cloud\.held|HELD_TEXT/, "the list never reads who holds a session");
	});

	it("Rename and Delete are never greyed: Rename goes through fetchHere, Delete's dialog too", () => {
		const source = readFileSync(new URL("../components/sidebar.tsx", import.meta.url), "utf8");
		assert.doesNotMatch(source, /ctxHeld|disabled=\{ctx/, "no greyed menu items");
		assert.match(source, /await fetchHere\(id, `\/api\/chats\/\$\{id\}`/);
		const dialog = readFileSync(new URL("../components/delete-session-dialog.tsx", import.meta.url), "utf8");
		assert.match(dialog, /await fetchHere\(chat\.id,/);
	});

	it("the lesson greys nothing and never hides the message box", () => {
		const chat = readFileSync(new URL("../components/chat.tsx", import.meta.url), "utf8");
		assert.doesNotMatch(chat, /heldElsewhere|useSessionHeld|HELD_TEXT/);
		assert.doesNotMatch(chat, /lh-held-dock|data-held/, "the dock's wrapper has no class, data-held or inert");
	});
});

describe("the floating box (a failed move, sync trouble)", () => {
	/** A session that is held elsewhere whose move is refused: the flag goes up. */
	async function failMove(chatId = "chat_1") {
		await act(async () => { assert.equal(await move.ensureSessionHere(chatId), "failed"); });
		await settle();
	}

	it("a move that failed: the approved sentence, and the ✕ clears the flag", async () => {
		cookie = "lh_cloud=1";
		script(() => ({ role: "desktop", held: { chat_1: webApp }, sync: okSync }), () => ({ status: "refused" }));
		const host = await mount(<SessionStrip chatId="chat_1" title="Circuits" />);
		assert.equal(isOpen(host), false, "a session another device holds shows nothing by itself");
		await failMove();
		assert.equal(isOpen(host), true);
		assert.equal(stripText(host), "This session couldn't be continued here. Try again.");
		assert.equal(stripText(host), SESSION_MOVE_FAILED_TEXT);
		assert.equal(strip(host)?.getAttribute("data-box"), "failed");
		assert.equal(move.isMoveFailed("chat_1"), true);
		assert.deepEqual([...strip(host)!.querySelectorAll("button")].map((b) => b.getAttribute("aria-label")), ["Dismiss"], "no Take over, no Cancel");
		await click(byTest(host, "session-box-dismiss"));
		assert.equal(move.isMoveFailed("chat_1"), false, "the flag is down");
		assert.equal(isOpen(host), false);
		assert.equal(stripText(host), SESSION_MOVE_FAILED_TEXT, "the words stay while it fades out");
	});

	it("it is per session: another lesson shows nothing for it", async () => {
		cookie = "lh_cloud=1";
		script(() => ({ role: "desktop", held: { chat_1: webApp }, sync: okSync }), () => ({ status: "refused" }));
		const host = await mount(<><SessionStrip chatId="chat_1" title="Circuits" /><div data-other=""><SessionStrip chatId="chat_2" title="Motors" /></div></>);
		await failMove();
		assert.equal(isOpen(host.querySelector("[data-other]")!), false);
		assert.equal(isOpen(host), true);
	});

	it("a move that arrives lowers the flag, and the box goes", async () => {
		cookie = "lh_cloud=1";
		let answer: unknown = { status: "refused" };
		script(() => ({ role: "desktop", held: { chat_1: webApp }, sync: okSync }), () => answer);
		const host = await mount(<SessionStrip chatId="chat_1" title="Circuits" />);
		await failMove();
		assert.equal(isOpen(host), true);
		answer = { status: "moved" };
		await act(async () => { assert.notEqual(await move.ensureSessionHere("chat_1"), "failed"); });
		await settle();
		assert.equal(isOpen(host), false);
	});

	it("the failure wins over sync trouble, and the trouble comes back after it", async () => {
		cookie = "lh_cloud=1";
		script(() => ({ role: "desktop", held: { chat_1: webApp }, sync: { state: "paused", message: null, lastContactAt: NOW } }), () => ({ status: "refused" }));
		const host = await mount(<SessionStrip chatId="chat_1" title="Circuits" />);
		assert.equal(stripText(host), SYNC_TROUBLE_BOX_TEXT.paused);
		await failMove();
		assert.equal(stripText(host), SESSION_MOVE_FAILED_TEXT, "both apply: the failure shows");
		await click(byTest(host, "session-box-dismiss"));
		assert.equal(stripText(host), SYNC_TROUBLE_BOX_TEXT.paused, "the trouble was never dismissed, so it shows next");
		assert.equal(isOpen(host), true);
	});

	it("a dismissed trouble stays hidden while a failure shows and after it", async () => {
		cookie = "lh_cloud=1";
		script(() => ({ role: "desktop", held: { chat_1: webApp }, sync: { state: "paused", message: null, lastContactAt: NOW } }), () => ({ status: "refused" }));
		const host = await mount(<SessionStrip chatId="chat_1" title="Circuits" />);
		await click(byTest(host, "session-box-dismiss"));
		assert.equal(isOpen(host), false);
		await failMove();
		assert.equal(stripText(host), SESSION_MOVE_FAILED_TEXT);
		await click(byTest(host, "session-box-dismiss"));
		assert.equal(isOpen(host), false, "the trouble was dismissed before and is the same spell");
	});

	it("nothing is held, nothing fails, nothing is off: no box", async () => {
		cookie = "lh_cloud=1";
		script(() => ({ role: "desktop", held: { chat_other: webApp }, sync: okSync }));
		const host = await mount(<SessionStrip chatId="chat_1" title="Circuits" />);
		assert.equal(isOpen(host), false);
		assert.equal(stripText(host), null);
		assert.equal(strip(host)?.hasAttribute("inert"), true, "nothing in it can be reached");
		assert.equal(byTest(host, "take-over"), null);
	});

	it("looks like the update box and floats: a zero-height wrapper, 12 px under the top bar, below the Tutor", () => {
		const source = readFileSync(new URL("../components/cloud/session-strip.tsx", import.meta.url), "utf8");
		const banner = readFileSync(new URL("../components/update-banner.tsx", import.meta.url), "utf8");
		const card = "rounded-lg border border-border bg-popover px-4 py-3 shadow-lg";
		assert.ok(banner.includes(card), "the update box's look");
		assert.ok(source.includes(card));
		assert.match(source, /className="pointer-events-none relative z-20 h-0"/, "takes no room, takes no pointer");
		assert.match(source, /absolute inset-x-0 top-3 mx-auto w-\[min\(36rem,calc\(100%-2rem\)\)\]/, "12 px down, centred, at most 36rem and 16 px from each side");
		assert.match(source, /className="min-w-0 flex-1 text-sm"/);
		// Mine adds only `shrink-0`, so the ✕ keeps its size beside long words.
		const closeButton = (text: string) => /className="(?:shrink-0 )?(rounded-md p-1\.5 [^"]*)"/.exec(text)?.[1];
		assert.ok(closeButton(banner));
		assert.equal(closeButton(source), closeButton(banner), "the same ✕ button classes as the update box");
		assert.match(source, /<XIcon className="size-4" aria-hidden="true" \/>/);
		const tutor = readFileSync(new URL("../components/side-tutor.tsx", import.meta.url), "utf8");
		assert.match(tutor, /"fixed z-30"|fixed z-30/, "the Tutor is z-30, above the box's z-20");
	});

	it("the box sits inside the wrapper, which has no height", async () => {
		cookie = "lh_cloud=1";
		script(() => ({ role: "desktop", held: {}, sync: { state: "paused", message: null, lastContactAt: NOW } }));
		const host = await mount(<SessionStrip chatId="chat_1" title="Circuits" />);
		const anchor = byTest(host, "session-box-anchor")!;
		assert.ok(anchor.contains(strip(host)));
		assert.match(anchor.className, /\bh-0\b/);
		assert.match(anchor.className, /pointer-events-none/);
	});

	it("fades over 200 ms with the message box's easing, and at once with reduced motion", () => {
		const css = readFileSync(new URL("../app/cloud.css", import.meta.url), "utf8");
		assert.match(css, /\.lh-session-box\s*\{[^}]*opacity 200ms cubic-bezier\(0\.2, 0\.8, 0\.2, 1\)/s);
		assert.match(css, /\.lh-session-box\[data-open\]\s*\{[^}]*opacity: 1/s);
		assert.match(css, /prefers-reduced-motion: reduce\)\s*\{\s*\.lh-session-box\s*\{\s*transition: none/s);
		assert.doesNotMatch(css, /lh-strip|lh-held-dock/, "the old strip and dock rules are gone");
	});

	it("nothing of the take-over screens is left", () => {
		const source = readFileSync(new URL("../components/cloud/session-strip.tsx", import.meta.url), "utf8");
		assert.doesNotMatch(source, /take-over|Take over|TakeOver|holder|Held by/i);
		assert.equal(existsSync(new URL("../components/cloud/take-over-dialog.tsx", import.meta.url)), false);
		for (const name of ["HELD_TEXT", "heldByText", "heldStripText", "holderName", "askingText", "finishingText", "cannotTakeOverText", "takeOverWarning", "SYNC_TROUBLE_STRIP_TEXT", "WEB_APP_NAME"]) {
			assert.equal(name in screens, false, `${name} is removed`);
		}
	});
});
