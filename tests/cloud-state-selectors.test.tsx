/**
 * useSessionHeld / useSessionHolder re-render their component only when
 * their own answer changes, not at every poll that differs elsewhere.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
let cookie = "lh_cloud=1";
Object.defineProperty(dom.document, "cookie", { configurable: true, get: () => cookie });
Object.defineProperty(dom.document, "visibilityState", { configurable: true, get: () => "visible" });
Object.assign(globalThis, { window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent });
const { createRoot } = await import("react-dom/client");
const { ServerEventsProvider } = await import("../components/server-events.tsx");
const { CloudProvider, useCloud, useSessionHeld, useSessionHolder } = await import("../components/cloud/cloud-state.tsx");

const originalFetch = globalThis.fetch;
const realInterval = globalThis.setInterval;
const realClear = globalThis.clearInterval;
let intervals: Array<{ run: () => void }> = [];
let roots: { root: Root; host: HTMLElement }[] = [];
let answer: unknown = {};
let heldRenders = 0;
let holderRenders = 0;

const settle = () => act(async () => new Promise<void>((r) => setTimeout(r, 20)));
const poll = async () => { await act(async () => { for (const i of [...intervals]) i.run(); }); await settle(); };

function Probe() {
	heldRenders++;
	const held = useSessionHeld("a");
	return <span data-testid="held">{String(held)}</span>;
}
function HolderProbe() {
	holderRenders++;
	const holder = useSessionHolder("a");
	return <span data-testid="holder">{holder?.name ?? "none"}</span>;
}

beforeEach(async () => {
	cookie = "lh_cloud=1"; heldRenders = 0; holderRenders = 0; intervals = [];
	globalThis.setInterval = ((run: () => void) => { const e = { run }; intervals.push(e); return e; }) as unknown as typeof setInterval;
	globalThis.clearInterval = ((e: unknown) => { intervals = intervals.filter((i) => i !== e); }) as unknown as typeof clearInterval;
	globalThis.fetch = (async () => Response.json(answer)) as typeof fetch;
});
afterEach(async () => {
	for (const { root, host } of roots.splice(0)) { await act(async () => root.unmount()); host.remove(); }
	globalThis.setInterval = realInterval; globalThis.clearInterval = realClear; globalThis.fetch = originalFetch;
});

async function mount() {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push({ root, host });
	const connect = () => ({ close() {}, onOpen() {}, onEvent() {} });
	await act(async () => root.render(<ServerEventsProvider connect={connect}><CloudProvider><Probe /><HolderProbe /></CloudProvider></ServerEventsProvider>));
	await settle();
	return host;
}

describe("cloud state selectors", () => {
	it("useCloud().refresh is the real, stable refresh from the first render on", async () => {
		const seen: Array<() => void> = [];
		let fetches = 0;
		answer = { role: "server", held: {} };
		globalThis.fetch = (async () => { fetches++; return Response.json(answer); }) as typeof fetch;
		function Grab() { seen.push(useCloud().refresh); return null; }
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		roots.push({ root, host });
		const connect = () => ({ close() {}, onOpen() {}, onEvent() {} });
		await act(async () => root.render(<ServerEventsProvider connect={connect}><CloudProvider><Grab /></CloudProvider></ServerEventsProvider>));
		const first = seen[0]!;
		await settle();
		const before = fetches;
		await act(async () => { first(); });
		await settle();
		assert.equal(fetches, before + 1, "the very first render's refresh asks the server");
		assert.ok(seen.every((r) => r === first), "the same function in every state");
		cookie = "";
	});

	it("desktop: lastContactAt changes don't re-render", async () => {
		const sync = (t: number) => ({ state: "ok", message: null, lastContactAt: t });
		answer = { role: "desktop", held: { a: { id: "d", name: "Desktop" } }, sync: sync(1) };
		const host = await mount();
		assert.equal(host.querySelector("[data-testid=held]")!.textContent, "true");
		const [h, o] = [heldRenders, holderRenders];
		for (const t of [2, 3, 4]) { answer = { role: "desktop", held: { a: { id: "d", name: "Desktop" } }, sync: sync(t) }; await poll(); }
		assert.equal(heldRenders, h);
		assert.equal(holderRenders, o);
	});

	it("server: lastSeenAt changes don't re-render the held flag", async () => {
		answer = { role: "server", held: { a: { id: "d", name: "Desktop", online: true, lastSeenAt: 1 }, b: { id: "d", name: "Desktop", lastSeenAt: 1 } } };
		await mount();
		const h = heldRenders;
		answer = { role: "server", held: { a: { id: "d", name: "Desktop", online: true, lastSeenAt: 2 }, b: { id: "d", name: "Desktop", lastSeenAt: 5 } } };
		await poll();
		assert.equal(heldRenders, h);
		answer = { role: "server", held: { a: { id: "d", name: "Desktop", online: true, lastSeenAt: 3 }, b: { id: "d", name: "Desktop", lastSeenAt: 5 } } };
		await poll();
		assert.equal(heldRenders, h);
	});

	it("re-renders when the session becomes held or stops being held; the holder re-renders on a value change", async () => {
		answer = { role: "server", held: {} };
		const host = await mount();
		assert.equal(host.querySelector("[data-testid=held]")!.textContent, "false");
		answer = { role: "server", held: { a: { id: "d", name: "Desktop" } } };
		await poll();
		assert.equal(host.querySelector("[data-testid=held]")!.textContent, "true");
		assert.equal(host.querySelector("[data-testid=holder]")!.textContent, "Desktop");
		answer = { role: "server", held: { a: { id: "e", name: "Laptop" } } };
		await poll();
		assert.equal(host.querySelector("[data-testid=holder]")!.textContent, "Laptop");
		answer = { role: "server", held: {} };
		await poll();
		assert.equal(host.querySelector("[data-testid=held]")!.textContent, "false");
		assert.equal(host.querySelector("[data-testid=holder]")!.textContent, "none");
	});
});
