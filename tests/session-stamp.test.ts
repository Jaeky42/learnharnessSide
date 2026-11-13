/**
 * THE CLOUD CATCH-UP'S STAMP (fork, performance round): where cloud sync is
 * in use the lesson reads its record once more a second after opening and at
 * every reconnect of the live channel. That read is now first a cheap
 * `?only=stamp` check: when the server's stamp is the one of the record the
 * page shows, nothing more is downloaded. These pin, on the pure session
 * model, when that stamp is known and when it is forgotten (a needless full
 * read is the old behaviour; a skipped one would be a bug), and the
 * usage-only read that replaced syncTurns' whole-record read.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionModel, catchUpRead, sameJsonValue } from "../components/session-core.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

function userMsg(id: string, text: string): LhMessage {
	return { id, role: "user", content: text, timestamp: 1 } as unknown as LhMessage;
}
function assistantMsg(id: string, text: string): LhMessage {
	return {
		id, role: "assistant", content: [{ type: "text", text }], stopReason: "stop",
		usage: { input: 0, output: 0, total: 0, cacheReads: 0, cacheWrites: 0 }, timestamp: 0, provider: "openrouter", model: "test",
	} as unknown as LhMessage;
}
const lesson = [userMsg("u1", "Teach me circuits"), assistantMsg("a1", "Current flows.")];

interface Server { stamp: string | (() => Response); messages: LhMessage[]; turns?: unknown[]; pricing?: unknown; calls: string[] }
function serve(server: Server): typeof globalThis.fetch {
	return (async (input: RequestInfo | URL) => {
		const url = String(input);
		server.calls.push(url);
		if (url === "/api/chats/chat_x?only=stamp") return typeof server.stamp === "function" ? server.stamp() : Response.json({ stamp: server.stamp });
		if (url === "/api/chats/chat_x?only=turns") return Response.json({ turns: server.turns, pricing: server.pricing });
		if (url === "/api/chats/chat_x") return Response.json({ messages: server.messages, stamp: typeof server.stamp === "string" ? server.stamp : undefined, turns: server.turns, pricing: server.pricing });
		if (url === "/api/chat") return Response.json({ ok: true });
		if (url === "/api/chats/chat_x/stream") {
			return new Response([
				{ type: "agent_start" },
				{ type: "message_start", message: { role: "assistant", content: [] } },
				{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Yes." }], stopReason: "stop" } },
				{ type: "agent_end", messages: [] },
			].map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n", { status: 200 });
		}
		throw new Error(`unexpected fetch: ${url}`);
	}) as typeof globalThis.fetch;
}
function setup(stamp: Server["stamp"], initialStamp: string | null | undefined = "s1") {
	const server: Server = { stamp, messages: lesson, calls: [] };
	const model = new SessionModel({ chatId: "chat_x", initialMessages: lesson, initialStamp, fetch: serve(server) });
	return { server, model };
}

describe("the catch-up's stamp check", () => {
	it("the same stamp: only the stamp is asked for, and the page's messages are untouched", async () => {
		const { server, model } = setup("s1");
		const before = model.getState();
		assert.equal(model.knownStamp(), "s1");
		assert.equal(await model.recordUnchanged(), true);
		assert.deepEqual(server.calls, ["/api/chats/chat_x?only=stamp"]);
		const after = model.getState();
		assert.equal(after.nativeMessages, before.nativeMessages, "the same history, by identity");
		assert.equal(model.canonicalNow(), before.canonicalMessages);
	});

	it("a different stamp, a failed check, or an answer with no stamp: the full read is owed", async () => {
		assert.equal(await setup("s2").model.recordUnchanged(), false);
		assert.equal(await setup(() => new Response("boom", { status: 500 })).model.recordUnchanged(), false);
		assert.equal(await setup(() => { throw new TypeError("offline"); }).model.recordUnchanged(), false);
		assert.equal(await setup(() => Response.json({})).model.recordUnchanged(), false);
	});

	it("no stamp known (an older page, or none given): no stamp request, the full read", async () => {
		for (const initial of [undefined, null]) {
			const server: Server = { stamp: "s1", messages: lesson, calls: [] };
			const model = new SessionModel({ chatId: "chat_x", initialMessages: lesson, initialStamp: initial, fetch: serve(server) });
			assert.equal(model.knownStamp(), null);
			assert.equal(await model.recordUnchanged(), false);
			assert.deepEqual(server.calls, []);
		}
	});

	it("the page changing while the stamp is asked for answers false", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const { model } = setup(() => Response.json({ stamp: "s1" }));
		const realFetch = model.fetch;
		model.fetch = (async (...args: Parameters<typeof fetch>) => { await gate; return realFetch(...args); }) as typeof fetch;
		const asking = model.recordUnchanged();
		model.setMessages([...lesson, userMsg("u2", "More")]);
		release();
		assert.equal(await asking, false);
	});
});

describe("when the stamp is known and when it is forgotten", () => {
	it("the full sync's replace remembers the record's stamp; a later check of it skips", async () => {
		const { server, model } = setup("s2");
		await model.readRecord({ rememberStamp: true });
		assert.equal(model.knownStamp(), "s2");
		assert.equal(await model.recordUnchanged(), true);
		assert.equal(server.calls.at(-1), "/api/chats/chat_x?only=stamp");
	});

	it("any other replace (reconcile, stream recovery, error recovery) forgets it", async () => {
		const { model } = setup("s1");
		await model.readRecord();
		assert.equal(model.knownStamp(), null);
		const reconciled = setup("s1").model;
		await reconciled.reconcile();
		assert.equal(reconciled.knownStamp(), null);
	});

	it("an append adoption forgets it", async () => {
		const { server, model } = setup("s1");
		server.messages = [...lesson, assistantMsg("a2", "A steer landed.")];
		await model.readRecord({ adoption: "append" });
		assert.equal(model.getState().nativeMessages.length, 3);
		assert.equal(model.knownStamp(), null);
	});

	it("a read that adopts nothing keeps it (the page is as it was)", async () => {
		const { server, model } = setup("s9");
		server.messages = [...lesson, assistantMsg("a2", "Elsewhere.")];
		await model.readRecord({ adoption: "none" });
		assert.equal(model.knownStamp(), "s1");
	});

	it("a replace declined while a turn is submitted keeps the stamp of what is still shown, and the turn then forgets it", async () => {
		const { server, model } = setup("s1");
		server.messages = [...lesson, userMsg("u2", "Why?")];
		const sending = model.send({ type: "text", text: "Why?" });
		// The optimistic bubble already changed the page.
		assert.equal(model.knownStamp(), null);
		await sending;
		assert.equal(model.getState().status, "ready");
		assert.equal(model.knownStamp(), null, "after a locally streamed turn the next catch-up reads in full");
	});

	it("a full sync's replace while a turn streams is declined, so nothing is remembered", async () => {
		const { model } = setup("s5", null);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const realFetch = model.fetch;
		model.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input) === "/api/chats/chat_x/stream") await gate;
			return realFetch(input, init);
		}) as typeof fetch;
		const sending = model.send({ type: "text", text: "Why?" });
		await new Promise((r) => setTimeout(r, 5));
		assert.equal(await model.readRecord({ rememberStamp: true }), undefined, "declined while submitted/streaming");
		assert.equal(model.knownStamp(), null);
		release();
		await sending;
	});

	it("a local error, setMessages and adoptRecord each forget it", async () => {
		const a = setup("s1").model;
		a.setMessages([...lesson]);
		assert.equal(a.knownStamp(), null);
		const b = setup("s1").model;
		b.adoptRecord([...lesson, assistantMsg("a2", "x")]);
		assert.equal(b.knownStamp(), null);
		const c = setup("s1").model;
		c.clearError(); // nothing was set: the same null error
		assert.equal(c.knownStamp(), "s1");
		const d = new SessionModel({ chatId: "chat_x", initialMessages: lesson, initialError: "It failed.", initialStamp: "s1", fetch: serve({ stamp: "s1", messages: lesson, calls: [] }) });
		assert.equal(d.knownStamp(), "s1");
		d.clearError();
		assert.equal(d.knownStamp(), null, "dismissing a retained failure changes the page");
	});
});

describe("the usage-only read (syncTurns)", () => {
	it("asks for ?only=turns and returns what the full read carried", async () => {
		const { server, model } = setup("s1");
		server.turns = [{ id: "t1", messageId: "a1", at: "2026-11-13T00:00:00Z", model: "x:y", steps: [] }];
		server.pricing = { cost: 0.5, unpriced: 0, turnCosts: { t1: 0.5 } };
		const usage = await model.readUsage();
		assert.deepEqual(server.calls, ["/api/chats/chat_x?only=turns"]);
		assert.deepEqual(usage, { turns: server.turns, pricing: server.pricing });
		const full = await model.readRecord({ adoption: "none" });
		assert.deepEqual({ turns: full?.turns, pricing: full?.pricing }, usage);
	});

	it("a read overtaken by a newer adoption returns nothing (the old staleness rule)", async () => {
		const { model } = setup("s1");
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const realFetch = model.fetch;
		model.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).endsWith("?only=turns")) await gate;
			return realFetch(input, init);
		}) as typeof fetch;
		const reading = model.readUsage();
		await model.readRecord();
		release();
		assert.equal(await reading, undefined);
	});

	it("a failed read throws (syncTurns keeps the last figures)", async () => {
		const model = new SessionModel({ chatId: "chat_x", initialMessages: lesson, fetch: (async () => new Response("no", { status: 404 })) as typeof fetch });
		await assert.rejects(model.readUsage(), /no/);
	});
});

describe("sameJsonValue", () => {
	it("is exact structural equality of parsed JSON", () => {
		assert.equal(sameJsonValue([{ a: 1, b: [1, "x", null] }], [{ b: [1, "x", null], a: 1 }]), true);
		assert.equal(sameJsonValue(undefined, undefined), true);
		assert.equal(sameJsonValue({ a: 1 }, { a: 1, b: 2 }), false);
		assert.equal(sameJsonValue({ a: undefined }, {}), false);
		assert.equal(sameJsonValue([1, 2], [2, 1]), false);
		assert.equal(sameJsonValue([], {}), false);
		assert.equal(sameJsonValue({ a: { b: 1 } }, { a: { b: 2 } }), false);
		assert.equal(sameJsonValue(null, {}), false);
		assert.equal(sameJsonValue(0, -0), false);
	});
});

describe("catchUpRead (the catch-up before any usage read has landed)", () => {
	function drive(stamp: string, usageReadFails = false) {
		const { server, model } = setup(stamp);
		server.turns = [];
		const seen = { usage: false, continued: 0, full: 0 };
		const done = catchUpRead({
			recordUnchanged: () => model.recordUnchanged(),
			usageRead: () => seen.usage,
			readUsage: async () => { const u = usageReadFails ? undefined : await model.readUsage(); if (u) seen.usage = true; },
			continueOwed: () => { seen.continued++; },
			fullRead: () => { seen.full++; },
		});
		return { server, seen, done };
	}

	it("unchanged stamp, usage not read: no full GET, usage read cheaply, continuation checked", async () => {
		const { server, seen, done } = drive("s1");
		await done;
		assert.deepEqual(server.calls, ["/api/chats/chat_x?only=stamp", "/api/chats/chat_x?only=turns"]);
		assert.deepEqual(seen, { usage: true, continued: 1, full: 0 });
	});

	it("a changed stamp still does the full read", async () => {
		const { server, seen, done } = drive("s2");
		await done;
		assert.deepEqual(server.calls, ["/api/chats/chat_x?only=stamp"]);
		assert.deepEqual(seen, { usage: false, continued: 0, full: 1 });
	});

	it("a usage read that leaves the page without figures falls back to the full read", async () => {
		const { seen, done } = drive("s1", true);
		await done;
		assert.deepEqual(seen, { usage: false, continued: 0, full: 1 });
	});
});
