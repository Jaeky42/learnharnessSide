/**
 * A REFETCH THAT CHANGED NOTHING RE-RENDERS NOTHING (fork, performance round).
 * After a reconnect of the live channel a burst of reads lands together, and
 * several used to replace state with equal data, which re-rendered the whole
 * lesson. Pinned here through the real hooks and components, with a scripted
 * server and a controllable live channel:
 *   - useSideThread (the lesson screen's Tutor hook): an equal list sets no
 *     state and dispatches nothing; a changed one does, and the open
 *     conversation's snapshot still lands;
 *   - the coverage block reads `?only=coverage` and shows the same numbers.
 * The lesson's jobs list and usage (chat.tsx) and the session list
 * (sidebar.tsx) use sameJsonValue (pinned in session-stamp.test.ts); those
 * components are not mounted in tests.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(dom.window, { setTimeout, clearTimeout, setInterval, clearInterval });
Object.assign(globalThis, { window: dom.window, document: dom.document });

type SideChatThread = import("../src/core/index.ts").SideChatThread;
type LhMessage = import("../src/core/index.ts").LhMessage;
const { useSideThread } = await import("../components/use-side-thread.ts");
const { ServerEventsProvider } = await import("../components/server-events.tsx");
const { CoverageMenuBlock } = await import("../components/extraction-coverage.tsx");

const originalFetch = globalThis.fetch;
const roots: { root: Root; host: HTMLElement }[] = [];
afterEach(async () => {
	for (const { root, host } of roots.splice(0)) {
		await act(async () => root.unmount());
		host.remove();
	}
	globalThis.fetch = originalFetch;
});

const LESSON = [
	{ id: "u1", role: "user", content: "teach me", timestamp: 1 },
	{ id: "a1", role: "assistant", content: [{ type: "text", text: "A first step." }], timestamp: 2 },
] as unknown as LhMessage[];
const thread = (text: string): SideChatThread => ({
	id: "side_a1", open: false, createdAt: "2026-11-10T10:00:00.000Z",
	anchor: { messageId: "a1", partId: "a1-t0", blockIndex: 0, blockText: "This teaching segment and its question." },
	messages: [{ id: "q1", role: "user", text, at: "2026-11-10T10:00:01.000Z" }],
});

async function mountSide() {
	const server = { threads: [thread("Why?")], answering: {} as Record<string, string>, reads: 0 };
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.endsWith("/side-chats")) { server.reads++; return Response.json({ threads: server.threads, answering: server.answering }); }
		const watched = server.threads.find((entry) => url.endsWith(`/side-chats/${entry.id}`));
		if (watched) return new Response(`${JSON.stringify({ type: "done", thread: watched })}\n`, { status: 200 });
		throw new Error(`unexpected fetch: ${url}`);
	}) as typeof fetch;
	let reconnect = () => {};
	const connect = () => ({ close() {}, onOpen(cb: () => void) { reconnect = cb; }, onEvent() {} });
	const probe = { renders: 0, side: null as ReturnType<typeof useSideThread> | null };
	function Lesson() {
		probe.renders++;
		probe.side = useSideThread("chat_1", LESSON);
		return null;
	}
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push({ root, host });
	await act(async () => root.render(<ServerEventsProvider connect={connect}><Lesson /></ServerEventsProvider>));
	const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)));
	await settle();
	const resync = async () => { await act(async () => reconnect()); await settle(); };
	return { server, probe, resync, settle };
}

describe("useSideThread after a reconnect", () => {
	it("an equal list re-renders nothing; a changed one is adopted", async () => {
		const { server, probe, resync } = await mountSide();
		assert.equal(probe.side!.threads[0]!.messages[0]!.text, "Why?");
		const shown = probe.side!.threads;
		const renders = probe.renders;
		await resync();
		await resync();
		assert.equal(server.reads, 3, "each reconnect still reads the list");
		assert.equal(probe.renders, renders, "no render for an equal list");
		assert.equal(probe.side!.threads, shown, "the same array on screen");
		server.threads = [thread("Why not?")];
		await resync();
		assert.ok(probe.renders > renders, "a changed list renders");
		assert.equal(probe.side!.threads[0]!.messages[0]!.text, "Why not?");
	});

	it("with the conversation open: an equal snapshot dispatches nothing, a changed answering state lands", async () => {
		const { server, probe, resync, settle } = await mountSide();
		await act(async () => probe.side!.open({ anchor: { kind: "composer" }, sourceMessageId: "a1" }));
		await settle();
		assert.equal(probe.side!.state?.threadId, "side_a1");
		await resync(); // the first read after opening may still align answering/streamText
		const renders = probe.renders;
		const state = probe.side!.state;
		await resync();
		assert.equal(probe.renders, renders, "nothing changed: no render");
		assert.equal(probe.side!.state, state);
		server.answering = { side_a1: "Because" };
		await resync();
		assert.ok(probe.renders > renders);
		assert.equal(probe.side!.state?.answering, true);
		assert.equal(probe.side!.state?.streamText, "Because");
		// And back: the same list text as an earlier read, but the snapshot now
		// differs from the state, so it is dispatched.
		server.answering = {};
		await resync();
		assert.equal(probe.side!.state?.answering, false);
		assert.equal(probe.side!.state?.streamText, "");
	});
});

describe("the coverage block reads the coverage field alone", () => {
	it("asks for ?only=coverage and shows the numbers it carried", async () => {
		const urls: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			urls.push(String(input));
			return Response.json({ coverage: { totalMessages: 12, coveredCount: 7, uncoveredCount: 5, coveredTokens: 30_000, uncoveredTokens: 2_048, running: false, lastFoldedAt: null } });
		}) as typeof fetch;
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		roots.push({ root, host });
		await act(async () => root.render(<CoverageMenuBlock chatId="chat 1" />));
		await act(async () => new Promise((r) => setTimeout(r, 20)));
		assert.deepEqual(urls, ["/api/chats/chat%201?only=coverage"]);
		assert.match(host.textContent ?? "", /5/);
		assert.match(host.textContent ?? "", /2(\.0)?k|2,048|2048/);
	});
});
