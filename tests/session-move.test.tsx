/**
 * SEAMLESS SESSIONS (owner's decision; components/cloud/session-move.ts): a
 * session another device holds moves here by itself: at the first typed
 * character in the lesson's boxes, at a press on Dictate, and before any
 * action that changes it. Scripted fetch; no server.
 *
 *   - nothing is asked where sync isn't in use or the session isn't held;
 *   - the move is POST /api/cloud {op:"take-over", chatId, force:true};
 *     waiting is asked again every 2 s; yours / moved / continued-offline
 *     are "here"; anything else fails;
 *   - every caller of one session shares one move;
 *   - a move an action needed that failed raises the session's flag;
 *   - SessionModel: a send waits for the move with nothing in the transcript
 *     and goes out on arrival, unless the session arrived with turns the page
 *     hadn't shown (then it is dropped and the text stays); a write refused
 *     with session_held_elsewhere moves the session and is tried once more.
 */

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { LhMessage } from "../src/core/native-messages.ts";

const dom = parseHTML("<html><body></body></html>");
let cookie = "";
Object.defineProperty(dom.document, "cookie", { configurable: true, get: () => cookie });
Object.defineProperty(dom.document, "visibilityState", { configurable: true, get: () => "visible" });
Object.assign(globalThis, { window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent });

const move = await import("../components/cloud/session-move.ts");
const { SessionModel } = await import("../components/session-core.ts");

const originalFetch = globalThis.fetch;
const realTimers = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval };
/** The 2-second "ask again" timers, run by hand. */
let asks: Array<{ run: () => void; ms: number }> = [];
beforeEach(() => {
	asks = [];
	globalThis.setTimeout = ((run: () => void, ms?: number) => {
		if (ms === move.MOVE_ASK_AGAIN_MS) { const entry = { run, ms }; asks.push(entry); return entry; }
		return realTimers.setTimeout(run, ms);
	}) as unknown as typeof setTimeout;
	globalThis.clearTimeout = ((entry: unknown) => {
		if (asks.includes(entry as never)) asks = asks.filter((t) => t !== entry);
		else realTimers.clearTimeout(entry as never);
	}) as unknown as typeof clearTimeout;
});
afterEach(() => {
	move.resetSessionMoveForTests();
	Object.assign(globalThis, realTimers);
	globalThis.fetch = originalFetch;
	cookie = "";
	for (const el of [...document.body.children]) el.remove();
});

const tick = () => new Promise<void>((r) => realTimers.setTimeout(r, 5));
const askAgain = async () => {
	const due = asks.splice(0);
	assert.ok(due.length > 0, "an ask-again was waiting");
	for (const entry of due) entry.run();
	await tick();
};

interface Call { method: string; url: string; body: Record<string, unknown> | null }
/** A scripted server: /api/cloud answers from `answers` in turn (the last
 *  one repeats); everything else from `routes`. */
function serve(answers: Array<Record<string, unknown> | null>, routes: (call: Call) => Response | Promise<Response> = () => Response.json({})) {
	const calls: Call[] = [];
	const queue = [...answers];
	const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const call: Call = { method: init?.method ?? "GET", url: String(input), body: typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null };
		calls.push(call);
		if (call.url === "/api/cloud" && call.method === "POST") {
			const answer = queue.length > 1 ? queue.shift()! : queue[0] ?? null;
			return answer === null ? new Response("{}", { status: 500 }) : Response.json(answer);
		}
		return routes(call);
	}) as typeof globalThis.fetch;
	globalThis.fetch = fetch;
	const moves = () => calls.filter((c) => c.url === "/api/cloud");
	return { calls, moves, fetch };
}

/** The cloud state as session-move sees it. */
function cloud(held: Set<string>) {
	let snapshot = { held: [...held] };
	let refreshes = 0;
	const disconnect = move.connectCloudSource({
		held: (chatId) => held.has(chatId),
		snapshot: () => snapshot,
		refresh: () => { refreshes++; },
	});
	return {
		disconnect,
		refreshes: () => refreshes,
		/** The next poll's answer: a new snapshot. */
		update: (next: Set<string>) => { held.clear(); for (const id of next) held.add(id); snapshot = { held: [...held] }; },
	};
}

describe("asking nothing where nothing has to move", () => {
	it("no cloud state connected (sync not in use): here at once, no request", async () => {
		const server = serve([{ status: "moved" }]);
		assert.equal(await move.ensureSessionHere("chat_1"), "here");
		move.prewarmSessionMove("chat_1");
		await tick();
		assert.deepEqual(server.calls, []);
	});

	it("a session that isn't held: here at once, no request", async () => {
		const server = serve([{ status: "moved" }]);
		cloud(new Set(["chat_other"]));
		assert.equal(move.sessionNeedsMove("chat_1"), false);
		assert.equal(await move.ensureSessionHere("chat_1"), "here");
		assert.deepEqual(server.calls, []);
	});

	it("the real cloud state: an unpaired app asks nothing; a paired one with the session held moves it", async () => {
		const { createRoot } = await import("react-dom/client");
		const { ServerEventsProvider } = await import("../components/server-events.tsx");
		const { CloudProvider } = await import("../components/cloud/cloud-state.tsx");
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		const live = { connect: () => ({ close() {}, onOpen() {}, onEvent() {} }) };
		const state = { role: "desktop", held: { chat_1: { id: "dev_x", name: "Desktop" } }, sync: { state: "ok", message: null, lastContactAt: Date.now() }, notices: [] };
		const server = serve([{ status: "moved" }], (call) => call.url === "/api/cloud" ? Response.json(state) : Response.json({}));
		try {
			await act(async () => root.render(<ServerEventsProvider connect={live.connect}><CloudProvider><span /></CloudProvider></ServerEventsProvider>));
			await act(tick);
			assert.equal(await move.ensureSessionHere("chat_1"), "here");
			assert.deepEqual(server.calls, [], "never paired: no request at all");
			await act(async () => root.unmount());

			cookie = "lh_cloud=1";
			const again = createRoot(host);
			await act(async () => again.render(<ServerEventsProvider connect={live.connect}><CloudProvider><span /></CloudProvider></ServerEventsProvider>));
			await act(tick);
			assert.equal(move.sessionNeedsMove("chat_1"), true);
			assert.equal(move.sessionNeedsMove("chat_2"), false);
			assert.equal(await move.ensureSessionHere("chat_2"), "here");
			assert.equal(server.moves().filter((c) => c.method === "POST").length, 0);
			assert.equal(await act(() => move.ensureSessionHere("chat_1")), "here");
			assert.deepEqual(server.moves().filter((c) => c.method === "POST").map((c) => c.body), [{ op: "take-over", chatId: "chat_1", force: true }]);
			await act(async () => again.unmount());
		} finally { host.remove(); }
	});
});

describe("the move", () => {
	it("asks with force:true and resolves on moved, yours or continued-offline; the state is asked again", async () => {
		for (const status of ["moved", "yours", "continued-offline"]) {
			move.resetSessionMoveForTests();
			const server = serve([{ status }]);
			const c = cloud(new Set(["chat_1"]));
			assert.equal(await move.ensureSessionHere("chat_1"), "here", status);
			assert.deepEqual(server.moves().map((m) => m.body), [{ op: "take-over", chatId: "chat_1", force: true }]);
			assert.equal(c.refreshes(), 1, "the cloud state is asked again");
			// Here now: until the cloud state changes, nothing more is asked.
			assert.equal(await move.ensureSessionHere("chat_1"), "here");
			assert.equal(server.moves().length, 1);
		}
	});

	it("waiting is asked again every 2 seconds, with no cap, until it moves", async () => {
		const server = serve([{ status: "waiting", reason: "reply" }, { status: "waiting", reason: "handing-over" }, { status: "waiting" }, { status: "waiting" }, { status: "moved" }]);
		cloud(new Set(["chat_1"]));
		let result: string | null = null;
		void move.ensureSessionHere("chat_1").then((r) => { result = r; });
		await tick();
		assert.equal(server.moves().length, 1);
		assert.deepEqual(asks.map((a) => a.ms), [2000]);
		for (let n = 2; n <= 5; n++) {
			await askAgain();
			assert.equal(server.moves().length, n);
		}
		await tick();
		assert.equal(result, "here");
		assert.deepEqual(asks, []);
	});

	it("every caller of one session shares one move", async () => {
		const server = serve([{ status: "waiting" }, { status: "moved" }]);
		cloud(new Set(["chat_1"]));
		move.prewarmSessionMove("chat_1");
		const a = move.ensureSessionHere("chat_1");
		const b = move.ensureSessionHere("chat_1");
		move.prewarmSessionMove("chat_1");
		await tick();
		assert.equal(server.moves().length, 1);
		await askAgain();
		assert.deepEqual(await Promise.all([a, b]), ["here", "here"]);
		assert.equal(server.moves().length, 2);
	});

	it("a refusal, an unknown answer, a server error or no network: failed", async () => {
		for (const answer of [{ status: "warning" }, { status: "nope" }, null]) {
			move.resetSessionMoveForTests();
			serve([answer]);
			cloud(new Set(["chat_1"]));
			assert.equal(await move.ensureSessionHere("chat_1"), "failed");
		}
		move.resetSessionMoveForTests();
		globalThis.fetch = (async () => { throw new TypeError("offline"); }) as typeof fetch;
		cloud(new Set(["chat_1"]));
		assert.equal(await move.ensureSessionHere("chat_1"), "failed");
	});

	it("the open lesson's arrival check: turns it hadn't shown make it here-changed", async () => {
		serve([{ status: "moved" }]);
		cloud(new Set(["chat_1"]));
		let checks = 0;
		const off = move.onSessionArrival("chat_1", async () => { checks++; return true; });
		assert.equal(await move.ensureSessionHere("chat_1"), "here-changed");
		assert.equal(checks, 1);
		off();
	});

	it("an abandoned move (the lesson closed) stops asking, fails quietly and raises nothing", async () => {
		const server = serve([{ status: "waiting" }]);
		cloud(new Set(["chat_1"]));
		const pending = move.ensureSessionHere("chat_1");
		await tick();
		move.abandonSessionMove("chat_1");
		assert.equal(await pending, "failed");
		assert.deepEqual(asks, []);
		assert.equal(server.moves().length, 1);
		assert.equal(move.isMoveFailed("chat_1"), false);
	});
});

describe("the move-failed flag", () => {
	it("an action's failed move raises it; a later move that arrives lowers it; so does clearMoveFailed", async () => {
		serve([{ status: "nope" }, { status: "moved" }]);
		cloud(new Set(["chat_1"]));
		assert.equal(await move.ensureSessionHere("chat_1"), "failed");
		assert.equal(move.isMoveFailed("chat_1"), true);
		assert.equal(move.isMoveFailed("chat_2"), false);
		assert.equal(await move.ensureSessionHere("chat_1"), "here");
		assert.equal(move.isMoveFailed("chat_1"), false, "a later successful move clears it");

		serve([{ status: "nope" }]);
		const c = cloud(new Set(["chat_3"]));
		assert.equal(await move.ensureSessionHere("chat_3"), "failed");
		assert.equal(move.isMoveFailed("chat_3"), true);
		move.clearMoveFailed("chat_3");
		assert.equal(move.isMoveFailed("chat_3"), false, "the learner closed the box");
		c.disconnect();
	});

	it("a failed pre-warm (typing, Dictate) alone raises nothing", async () => {
		const server = serve([{ status: "nope" }]);
		cloud(new Set(["chat_1"]));
		move.prewarmSessionMove("chat_1");
		await tick();
		assert.equal(server.moves().length, 1);
		assert.equal(move.isMoveFailed("chat_1"), false);
	});
});

describe("the triggers", () => {
	function lesson() {
		document.body.innerHTML = `
			<div data-phone="dock"><textarea id="box"></textarea><input id="range" type="range"><button data-testid="dictation-toggle" id="dictate"><svg id="mic"></svg></button><button data-kbdrow="0" id="option"><span id="option-text">A</span></button><button id="send">Send</button></div>
			<div data-phone="tutor-typing"><textarea id="tutor"></textarea><button data-lh-move-press="" id="tutor-dictate"></button></div>
			<div data-testid="notes"><textarea id="notes"></textarea></div>
			<input id="search" type="search">`;
		return (id: string) => document.getElementById(id)!;
	}
	const fire = (el: Element, type: string) => el.dispatchEvent(new dom.window.Event(type, { bubbles: true }));

	it("the first typed character (or a paste) in the lesson's boxes starts the move; focus alone doesn't", async () => {
		const server = serve([{ status: "moved" }]);
		cloud(new Set(["chat_1"]));
		const el = lesson();
		const uninstall = move.installMoveTriggers("chat_1");
		fire(el("box"), "focus");
		fire(el("box"), "focusin");
		fire(el("box"), "click");
		await tick();
		assert.equal(server.moves().length, 0, "focus and a click on the box start nothing");
		fire(el("box"), "input");
		await tick();
		assert.equal(server.moves().length, 1, "the first character");
		uninstall();
	});

	it("a paste, the Tutor's box, the confidence bar: each starts it; the notes, the session search: never", async () => {
		for (const [id, type, expected] of [["box", "paste", 1], ["tutor", "input", 1], ["range", "input", 1], ["notes", "input", 0], ["search", "input", 0]] as const) {
			move.resetSessionMoveForTests();
			const server = serve([{ status: "moved" }]);
			cloud(new Set(["chat_1"]));
			const el = lesson();
			const uninstall = move.installMoveTriggers("chat_1");
			fire(el(id), type);
			await tick();
			assert.equal(server.moves().length, expected, `${type} in #${id}`);
			uninstall();
		}
	});

	it("a press on Dictate (the lesson's, the Tutor's) or an answer option starts it; Send's press alone doesn't (Send waits for the move itself)", async () => {
		for (const [id, expected] of [["mic", 1], ["tutor-dictate", 1], ["option-text", 1], ["send", 0]] as const) {
			move.resetSessionMoveForTests();
			const server = serve([{ status: "moved" }]);
			cloud(new Set(["chat_1"]));
			const el = lesson();
			const uninstall = move.installMoveTriggers("chat_1");
			fire(el(id), "click");
			await tick();
			assert.equal(server.moves().length, expected, `a press on #${id}`);
			uninstall();
		}
	});

	it("installed but nothing held: typing and Dictate ask nothing", async () => {
		const server = serve([{ status: "moved" }]);
		cloud(new Set());
		const el = lesson();
		const uninstall = move.installMoveTriggers("chat_1");
		fire(el("box"), "input");
		fire(el("dictate"), "click");
		await tick();
		assert.deepEqual(server.calls, []);
		uninstall();
	});
});

describe("fetchHere (Rename, Delete, the model, the artifact switch, extraction, the Tutor's Ask)", () => {
	it("a session that is here: one plain fetch", async () => {
		const server = serve([{ status: "moved" }], () => Response.json({ ok: true }));
		cloud(new Set());
		const res = await move.fetchHere("chat_1", "/api/chats/chat_1", { method: "PUT", body: "{}" });
		assert.equal(res.status, 200);
		assert.deepEqual(server.calls.map((c) => `${c.method} ${c.url}`), ["PUT /api/chats/chat_1"]);
	});

	it("held: the move first, then the write", async () => {
		const server = serve([{ status: "moved" }], () => Response.json({ ok: true }));
		cloud(new Set(["chat_1"]));
		const res = await move.fetchHere("chat_1", "/api/chats/chat_1", { method: "PUT", body: "{}" });
		assert.equal(res.status, 200);
		assert.deepEqual(server.calls.map((c) => `${c.method} ${c.url}`), ["POST /api/cloud", "PUT /api/chats/chat_1"]);
	});

	it("the safety net: a write refused as held elsewhere moves the session and is tried once more", async () => {
		let writes = 0;
		const server = serve([{ status: "moved" }], () => ++writes === 1 ? Response.json({ code: "session_held_elsewhere" }, { status: 409 }) : Response.json({ ok: true }));
		const c = cloud(new Set());
		const res = await move.fetchHere("chat_1", "/api/chats/chat_1", { method: "PUT", body: "{}" });
		assert.equal(res.status, 200);
		assert.deepEqual(server.calls.map((call) => `${call.method} ${call.url}`), ["PUT /api/chats/chat_1", "POST /api/cloud", "PUT /api/chats/chat_1"]);
		assert.ok(c.refreshes() >= 1, "the cloud state is asked again");
	});

	it("only once: refused again, the refusal is the answer; another 409 is left alone", async () => {
		const server = serve([{ status: "moved" }], () => Response.json({ code: "session_held_elsewhere" }, { status: 409 }));
		cloud(new Set());
		const res = await move.fetchHere("chat_1", "/x", { method: "POST" });
		assert.equal(res.status, 409);
		assert.equal(server.calls.filter((c) => c.url === "/x").length, 2);

		const busy = serve([{ status: "moved" }], () => Response.json({ code: "turn_in_flight" }, { status: 409 }));
		const plain = await move.fetchHere("chat_1", "/x", { method: "POST" });
		assert.equal(plain.status, 409);
		assert.deepEqual(busy.calls.map((c) => c.url), ["/x"]);
	});

	it("a move that fails: no write, a 409 held refusal, and the flag", async () => {
		const server = serve([{ status: "nope" }], () => Response.json({ ok: true }));
		cloud(new Set(["chat_1"]));
		const res = await move.fetchHere("chat_1", "/x", { method: "POST" });
		assert.equal(res.status, 409);
		assert.equal(await move.isHeldRefusal(res), true);
		assert.deepEqual(server.calls.map((c) => c.url), ["/api/cloud"]);
		assert.equal(move.isMoveFailed("chat_1"), true);
	});
});

// ── SessionModel's gate ────────────────────────────────────────────────────

function userMsg(id: string, text: string): LhMessage {
	return { id, role: "user", content: text, timestamp: 1 } as unknown as LhMessage;
}
function assistantMsg(id: string, text: string): LhMessage {
	return {
		id, role: "assistant", content: [{ type: "text", text }], stopReason: "stop",
		usage: { input: 0, output: 0, total: 0, cacheReads: 0, cacheWrites: 0 }, timestamp: 0, provider: "openrouter", model: "test",
	} as unknown as LhMessage;
}
const LESSON = [userMsg("u1", "Teach me circuits"), assistantMsg("a1", "Current flows.")];

/** The session's routes, with /api/chat answering from `chat` in turn. */
function sessionRoutes(chat: Array<() => Response>) {
	let n = 0;
	return (call: Call): Response => {
		if (call.url === "/api/chat") return (chat[Math.min(n++, chat.length - 1)] ?? (() => Response.json({ ok: true })))();
		if (call.url === "/api/chats/chat_x") return Response.json({ messages: LESSON });
		if (call.url === "/api/chats/chat_x/stream") return new Response(`data: ${JSON.stringify({ type: "turn-settled" })}\n\n`, { status: 200 });
		if (call.url.startsWith("/api/chats/chat_x/")) return Response.json({ ok: true });
		if (call.url.startsWith("/api/jobs")) return Response.json({ turnInFlight: false });
		throw new Error(`unexpected fetch: ${call.method} ${call.url}`);
	};
}
const held = () => Response.json({ code: "session_held_elsewhere", error: "This session is held by another device." }, { status: 409 });

function model(fetch: typeof globalThis.fetch) {
	return new SessionModel({ chatId: "chat_x", initialMessages: LESSON, fetch, moveGate: move.sessionMoveGate("chat_x"), pollMs: 1, waitMaxMs: 5 });
}
const userTexts = (m: InstanceType<typeof SessionModel>) => m.getState().nativeMessages.filter((x) => x.role === "user").map((x) => (x as { content: unknown }).content);

describe("SessionModel: a send before the session has arrived", () => {
	it("nothing goes out and nothing shows in the transcript until the move arrives; then it is sent", async () => {
		const server = serve([{ status: "waiting" }, { status: "moved" }], sessionRoutes([() => Response.json({ ok: true })]));
		cloud(new Set(["chat_x"]));
		move.onSessionArrival("chat_x", async () => false);
		const m = model(server.fetch);
		let accepted = 0, settled = 0;
		const sent = m.send({ type: "text", text: "Why?" }, () => { accepted++; }, undefined, () => { settled++; });
		await tick();
		assert.equal(server.calls.filter((c) => c.url === "/api/chat").length, 0, "no POST yet");
		assert.deepEqual(userTexts(m), ["Teach me circuits"], "no optimistic bubble: the text stays in its box");
		assert.equal(m.getState().status, "ready");
		assert.equal(settled, 0, "delivery not settled: the composer keeps its busy look");
		await askAgain();
		assert.equal(await sent, true);
		assert.equal(accepted, 1);
		assert.equal(settled, 1);
		const chat = server.calls.filter((c) => c.url === "/api/chat");
		assert.equal(chat.length, 1);
		assert.deepEqual(chat[0]!.body, { chatId: "chat_x", input: { type: "text", text: "Why?" } });
	});

	it("the session arrived with turns this page hadn't shown: the send is dropped and the text stays", async () => {
		const server = serve([{ status: "moved" }], sessionRoutes([() => Response.json({ ok: true })]));
		cloud(new Set(["chat_x"]));
		move.onSessionArrival("chat_x", async () => true);
		const m = model(server.fetch);
		let accepted = 0, settled = 0;
		assert.equal(await m.send({ type: "text", text: "Why?" }, () => { accepted++; }, undefined, () => { settled++; }), false);
		assert.equal(server.calls.filter((c) => c.url === "/api/chat").length, 0);
		assert.equal(accepted, 0, "never accepted: the composer keeps the text");
		assert.equal(settled, 1, "the busy look ends");
		assert.equal(m.getState().error, null, "no error banner");
		assert.equal(m.getState().status, "ready");
	});

	it("the move fails: dropped, the text kept, and the flag raised", async () => {
		const server = serve([{ status: "nope" }], sessionRoutes([]));
		cloud(new Set(["chat_x"]));
		const m = model(server.fetch);
		let accepted = 0;
		assert.equal(await m.send({ type: "text", text: "Why?" }, () => { accepted++; }), false);
		assert.equal(accepted, 0);
		assert.equal(server.calls.filter((c) => c.url === "/api/chat").length, 0);
		assert.equal(move.isMoveFailed("chat_x"), true);
	});

	it("an automatic continuation never moves a session", async () => {
		const server = serve([{ status: "moved" }], sessionRoutes([]));
		cloud(new Set(["chat_x"]));
		const m = model(server.fetch);
		assert.equal(await m.send({ type: "continue" }), false);
		assert.deepEqual(server.calls, []);
	});

	it("steer, dismiss and dismiss-problem wait for the move too; changed on arrival drops them", async () => {
		const server = serve([{ status: "moved" }], sessionRoutes([]));
		const c = cloud(new Set(["chat_x"]));
		move.onSessionArrival("chat_x", async () => true);
		const m = model(server.fetch);
		assert.equal(await m.steer("Faster"), false);
		assert.equal(server.calls.filter((call) => call.url.endsWith("/steer")).length, 0);
		c.update(new Set(["chat_x"]));
		await m.dismissProblem("call_1");
		assert.equal(server.calls.filter((call) => call.url.endsWith("/dismiss")).length, 0);

		move.resetSessionMoveForTests();
		const ok = serve([{ status: "moved" }], sessionRoutes([]));
		cloud(new Set(["chat_x"]));
		move.onSessionArrival("chat_x", async () => false);
		const m2 = model(ok.fetch);
		assert.equal(await m2.steer("Faster"), true);
		assert.deepEqual(ok.calls.map((call) => `${call.method} ${call.url}`), ["POST /api/cloud", "POST /api/chats/chat_x/steer"]);
	});
});

describe("SessionModel: the safety net", () => {
	it("a send refused as held elsewhere (the page's held was stale): moved, then sent once more", async () => {
		const server = serve([{ status: "moved" }], sessionRoutes([held, () => Response.json({ ok: true })]));
		const c = cloud(new Set());
		move.onSessionArrival("chat_x", async () => false);
		const m = model(server.fetch);
		let accepted = 0, settled = 0;
		assert.equal(await m.send({ type: "text", text: "Why?" }, () => { accepted++; }, undefined, () => { settled++; }), true);
		assert.deepEqual(server.calls.filter((call) => call.method === "POST").map((call) => call.url), ["/api/chat", "/api/cloud", "/api/chat"]);
		assert.equal(accepted, 1);
		assert.equal(settled, 1);
		assert.equal(m.getState().error, null, "not 'a turn is already running'");
		assert.ok(c.refreshes() >= 1);
		assert.equal(server.calls.filter((call) => call.url.startsWith("/api/jobs")).length, 0, "no waiting for a turn that isn't running");
	});

	it("only once: refused again, the send ends with the text kept", async () => {
		const server = serve([{ status: "moved" }], sessionRoutes([held, held, held]));
		cloud(new Set());
		move.onSessionArrival("chat_x", async () => false);
		const m = model(server.fetch);
		let accepted = 0;
		assert.equal(await m.send({ type: "text", text: "Why?" }, () => { accepted++; }), false);
		assert.equal(server.calls.filter((call) => call.url === "/api/chat").length, 2);
		assert.equal(server.calls.filter((call) => call.url === "/api/cloud").length, 1);
		assert.equal(accepted, 0);
		assert.deepEqual(userTexts(m), ["Teach me circuits"], "the optimistic bubble is gone");
	});

	it("refused, and the session arrives changed: dropped, the bubble gone, no error", async () => {
		const server = serve([{ status: "moved" }], sessionRoutes([held, () => Response.json({ ok: true })]));
		cloud(new Set());
		move.onSessionArrival("chat_x", async () => true);
		const m = model(server.fetch);
		assert.equal(await m.send({ type: "text", text: "Why?" }), false);
		assert.equal(server.calls.filter((call) => call.url === "/api/chat").length, 1);
		assert.deepEqual(userTexts(m), ["Teach me circuits"]);
		assert.equal(m.getState().error, null);
		assert.equal(m.getState().status, "ready");
	});

	it("without the gate (an app that isn't wired for it) a held 409 is upstream's busy refusal, as before", async () => {
		const server = serve([], sessionRoutes([held]));
		const m = new SessionModel({ chatId: "chat_x", initialMessages: LESSON, fetch: server.fetch, pollMs: 1, waitMaxMs: 3 });
		assert.equal(await m.send({ type: "text", text: "Why?" }), false);
		assert.match(m.getState().error?.message ?? "", /A turn is already running/);
		assert.equal(server.calls.filter((call) => call.url === "/api/cloud").length, 0);
	});

	it("a dismissal refused as held elsewhere: moved, then dismissed once more", async () => {
		let dismisses = 0;
		const server = serve([{ status: "moved" }], (call) => call.url.endsWith("/dismiss") ? (++dismisses === 1 ? held() : Response.json({ ok: true })) : sessionRoutes([])(call));
		cloud(new Set());
		move.onSessionArrival("chat_x", async () => false);
		const m = model(server.fetch);
		await m.dismissProblem("call_1");
		assert.equal(dismisses, 2);
		assert.equal(m.getState().error, null);
	});
});
