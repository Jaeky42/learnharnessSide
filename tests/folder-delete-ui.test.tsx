/**
 * Cloud sync (docs/fork/cloud-sync.md), seamless sessions, and upstream
 * 0.7.0's folder Delete. Owner's decision, "move here, then delete": when
 * Delete is pressed, every session in the folder that another device holds
 * is moved to this device first, silently, then the folder is deleted. All
 * or nothing: a session that can't be moved deletes nothing and the box's
 * failure line reads the approved sentence. The net: a DELETE refused as
 * held elsewhere moves the sessions and is tried once more. An app where
 * sync isn't in use makes exactly upstream's request. fetch is scripted.
 */

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { FOLDER_DELETE_FAILED_TEXT } from "../src/core/sync/screens.ts";
import type { NotifySource } from "../components/server-events.tsx";
import type { FolderDeletionScope } from "../src/core/index.ts";

const dom = parseHTML("<html><body></body></html>");
let cookie = "";
Object.defineProperty(dom.document, "cookie", { configurable: true, get: () => cookie });
Object.defineProperty(dom.document, "visibilityState", { configurable: true, get: () => "visible" });
Object.assign(globalThis, { window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent });
const { createRoot } = await import("react-dom/client");
const { ServerEventsProvider } = await import("../components/server-events.tsx");
const { CloudProvider } = await import("../components/cloud/cloud-state.tsx");
const move = await import("../components/cloud/session-move.ts");
const { DeleteFolderDialog, folderDeleteCopy } = await import("../components/delete-session-dialog.tsx");
const { InteractionLayersProvider } = await import("../components/interaction-layers.tsx");
const { installModalDom } = await import("./modal-dom.ts");
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
	move.resetSessionMoveForTests();
	cookie = "";
	for (const el of [...document.body.children]) el.remove();
});

const settle = () => act(async () => new Promise<void>((r) => realTimers.setTimeout(r, 20)));
const byTest = (id: string) => document.querySelector(`[data-testid='${id}']`);
const click = async (el: Element | null | undefined) => { assert.ok(el, "the control exists"); await act(async () => { (el as HTMLElement).click(); }); await settle(); };
const fireTimeout = async (ms: number) => {
	const due = timeouts.filter((t) => t.ms === ms);
	timeouts = timeouts.filter((t) => t.ms !== ms);
	await act(async () => { for (const t of due) t.run(); });
	await settle();
};

function channel() {
	const source: NotifySource = { close: () => {}, onOpen: () => {}, onEvent: () => {} };
	return () => source;
}

const SCOPE: FolderDeletionScope = { parentId: null, folderIds: ["fold_1", "fold_2"], chatIds: ["chat_1", "chat_2", "chat_3"], noteIds: ["book"] };
const FOLDER_URL = "/api/graph/sources/folders/fold_1?mode=preserve-graph";
const holder = { id: "dev_aaaaaaaaaaaaaaaa", name: "Desktop" };
const okSync = { state: "ok", message: null, lastContactAt: Date.now() };

type Call = { method: string; url: string; body: unknown };
/** The server, scripted. `deletes` answers each DELETE in turn (the last one repeats). */
function script(opts: { held?: Record<string, unknown>; take?: (chatId: string) => unknown; deletes?: Array<{ status: number; body: unknown }>; check?: string; deleteUrl?: string }) {
	const calls: Call[] = [];
	let deleteIndex = 0;
	const deletes = opts.deletes ?? [{ status: 200, body: { ok: true, deletedChatIds: SCOPE.chatIds, graphRevision: 7 } }];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const method = init?.method ?? "GET";
		const url = String(input);
		const body = init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown;
		calls.push({ method, url, body });
		if (url === "/api/cloud" && method === "GET") return Response.json({ role: "desktop", held: opts.held ?? {}, sync: okSync, notices: [] });
		if (url === "/api/cloud" && method === "POST" && (body as { op?: string }).op === "check") {
			return Response.json({ role: "desktop", paired: true, sync: { state: opts.check ?? "ok", message: null, lastContactAt: null, offlineSince: null } });
		}
		if (url === "/api/cloud" && method === "POST") {
			const reply = (opts.take ?? (() => ({ status: "moved" })))(String((body as { chatId: string }).chatId));
			return reply === null ? new Response("{}", { status: 500 }) : Response.json(reply);
		}
		if (method === "DELETE") {
			const answer = deletes[Math.min(deleteIndex++, deletes.length - 1)]!;
			return Response.json(answer.body, { status: answer.status });
		}
		throw new Error(`unexpected request ${method} ${url}`);
	}) as typeof fetch;
	const work = () => calls.filter((c) => !(c.url === "/api/cloud" && c.method === "GET"));
	const takes = () => work().filter((c) => c.method === "POST" && (c.body as { op?: string }).op === "take-over").map((c) => c.body);
	const checks = () => work().filter((c) => c.method === "POST" && (c.body as { op?: string }).op === "check").length;
	const deletesMade = () => work().filter((c) => c.method === "DELETE");
	return { calls, work, takes, checks, deletesMade };
}

async function mount() {
	const outcome: { deleted: unknown[]; stale: string[]; closed: number } = { deleted: [], stale: [], closed: 0 };
	const folder = { id: "fold_1", name: "Physics", copy: folderDeleteCopy({ sessions: 3, subfolders: 1, notes: 1, parentName: null }), scope: SCOPE };
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push({ root, host });
	await act(async () => root.render(<InteractionLayersProvider><ServerEventsProvider connect={channel()}><CloudProvider>
		<DeleteFolderDialog folder={folder} onClose={() => { outcome.closed++; }} onStale={(message) => outcome.stale.push(message)} onDeleted={(result) => outcome.deleted.push(result)} />
	</CloudProvider></ServerEventsProvider></InteractionLayersProvider>));
	await settle();
	return outcome;
}
const failureText = () => byTest("delete-failure")?.querySelector("span")?.textContent ?? null;

describe("the folder Delete where sync isn't in use", () => {
	it("makes exactly upstream's one request", async () => {
		const server = script({});
		const outcome = await mount();
		await click(byTest("delete-confirm"));
		assert.deepEqual(server.calls, [{ method: "DELETE", url: FOLDER_URL, body: SCOPE }], "no request about sync, before or after");
		assert.deepEqual(outcome.deleted, [{ deletedChatIds: SCOPE.chatIds, graphRevision: 7 }]);
	});

	it("upstream's failures still show the server's words, and a stale scope still goes to onStale", async () => {
		script({ deletes: [
			{ status: 409, body: { code: "turn_in_flight", error: "A turn is running in “Circuits” — try again when it finishes" } },
			{ status: 409, body: { code: "folder_scope_changed", error: "The folder changed. Nothing was deleted. Open Delete again to review its current contents." } },
		] });
		const outcome = await mount();
		await click(byTest("delete-confirm"));
		assert.equal(failureText(), "A turn is running in “Circuits” — try again when it finishes");
		await click(byTest("delete-retry"));
		assert.deepEqual(outcome.stale, ["The folder changed. Nothing was deleted. Open Delete again to review its current contents."]);
		assert.deepEqual(outcome.deleted, []);
	});
});

describe("the folder Delete where sync is in use", () => {
	it("a session another device holds is moved here first, then the folder is deleted", async () => {
		cookie = "lh_cloud=1";
		const server = script({ held: { chat_2: holder } });
		const outcome = await mount();
		await click(byTest("delete-confirm"));
		assert.deepEqual(server.work().map((c) => `${c.method} ${c.url} ${(c.body as { op?: string } | undefined)?.op ?? ""}`), ["POST /api/cloud check", "POST /api/cloud take-over", `DELETE ${FOLDER_URL} `], "the server is reached, the move, then the delete");
		assert.deepEqual(server.takes(), [{ op: "take-over", chatId: "chat_2", force: true }], "only the held session moves");
		assert.deepEqual(server.deletesMade()[0]!.body, SCOPE, "the reviewed scope, unchanged");
		assert.equal(outcome.deleted.length, 1);
	});

	it("a holder that is finishing a reply is asked again, and the folder goes once it is here", async () => {
		cookie = "lh_cloud=1";
		let answers = 0;
		const server = script({ held: { chat_1: holder, chat_3: holder }, take: (chatId) => (chatId === "chat_3" && answers++ === 0 ? { status: "waiting", reason: "reply" } : { status: "moved" }) });
		const outcome = await mount();
		await click(byTest("delete-confirm"));
		assert.equal(server.deletesMade().length, 0, "nothing is deleted while one is still on its way");
		assert.equal(byTest("delete-confirm")?.textContent, "Deleting…");
		await fireTimeout(move.MOVE_ASK_AGAIN_MS);
		assert.deepEqual(server.takes().map((b) => (b as { chatId: string }).chatId).sort(), ["chat_1", "chat_3", "chat_3"]);
		assert.equal(server.deletesMade().length, 1);
		assert.equal(outcome.deleted.length, 1);
	});

	it("a session that can't be moved deletes nothing, and the box reads the approved sentence", async () => {
		cookie = "lh_cloud=1";
		const server = script({ held: { chat_1: holder, chat_2: holder }, take: (chatId) => (chatId === "chat_2" ? { status: "refused" } : { status: "moved" }) });
		const outcome = await mount();
		await click(byTest("delete-confirm"));
		assert.equal(server.deletesMade().length, 0, "all or nothing: no DELETE");
		assert.equal(failureText(), FOLDER_DELETE_FAILED_TEXT);
		assert.equal(failureText(), "This folder couldn't be deleted right now. Nothing was deleted.");
		assert.equal(byTest("delete-retry")?.textContent, "Try again", "upstream's Try again follows it");
		assert.doesNotMatch(byTest("delete-failure")?.textContent ?? "", /held by|Take it over|continued here/i);
		assert.deepEqual(outcome.deleted, []);
		assert.equal(byTest("delete-confirm")?.hasAttribute("disabled"), false, "the box can be used again");
	});

	it("the net: a DELETE refused as held elsewhere moves every session and is tried once more", async () => {
		cookie = "lh_cloud=1";
		const server = script({ held: {}, deletes: [
			{ status: 409, body: { code: "session_held_elsewhere", error: "This session is held by another device. Take it over to continue it here." } },
			{ status: 200, body: { ok: true, deletedChatIds: SCOPE.chatIds, graphRevision: 9 } },
		] });
		const outcome = await mount();
		const cloudReads = server.calls.filter((c) => c.url === "/api/cloud" && c.method === "GET").length;
		await click(byTest("delete-confirm"));
		assert.deepEqual(server.work().map((c) => c.method), ["DELETE", "POST", "POST", "POST", "POST", "DELETE"]);
		assert.equal(server.checks(), 1);
		assert.deepEqual(server.takes().map((b) => (b as { chatId: string }).chatId).sort(), SCOPE.chatIds);
		assert.ok(server.calls.filter((c) => c.url === "/api/cloud" && c.method === "GET").length > cloudReads, "the cloud state is asked again");
		assert.deepEqual(outcome.deleted, [{ deletedChatIds: SCOPE.chatIds, graphRevision: 9 }]);
	});

	it("the net tries once only, and the server's held sentence is never shown", async () => {
		cookie = "lh_cloud=1";
		const server = script({ held: {}, deletes: [{ status: 409, body: { code: "session_held_elsewhere", error: "This session is held by another device. Take it over to continue it here." } }] });
		const outcome = await mount();
		await click(byTest("delete-confirm"));
		assert.equal(server.deletesMade().length, 2);
		assert.equal(failureText(), FOLDER_DELETE_FAILED_TEXT);
		assert.doesNotMatch(document.body.textContent ?? "", /held by another device|Take it over/);
		assert.deepEqual(outcome.deleted, []);
	});

	it("a move that fails in the net deletes nothing more", async () => {
		cookie = "lh_cloud=1";
		const server = script({ held: {}, take: () => ({ status: "refused" }), deletes: [{ status: 409, body: { code: "session_held_elsewhere", error: "This session is held by another device. Take it over to continue it here." } }] });
		await mount();
		await click(byTest("delete-confirm"));
		assert.equal(server.deletesMade().length, 1, "no second DELETE");
		assert.equal(failureText(), FOLDER_DELETE_FAILED_TEXT);
	});

	it("a scope that changed after the move keeps upstream's behaviour", async () => {
		cookie = "lh_cloud=1";
		script({ held: { chat_2: holder }, deletes: [{ status: 409, body: { code: "folder_scope_changed", error: "The folder changed. Nothing was deleted. Open Delete again to review its current contents." } }] });
		const outcome = await mount();
		await click(byTest("delete-confirm"));
		assert.deepEqual(outcome.stale, ["The folder changed. Nothing was deleted. Open Delete again to review its current contents."]);
		assert.equal(byTest("delete-failure"), null);
	});

	it("nothing held: exactly upstream's request besides the page's own cloud reads", async () => {
		cookie = "lh_cloud=1";
		const server = script({ held: { chat_other: holder } });
		const outcome = await mount();
		await click(byTest("delete-confirm"));
		assert.deepEqual(server.work(), [{ method: "DELETE", url: FOLDER_URL, body: SCOPE }]);
		assert.equal(outcome.deleted.length, 1);
	});
});

describe("the folder Delete while the PC can't reach its server (owner's decision)", () => {
	it("a folder with a session another device holds deletes nothing, and nothing is asked to move", async () => {
		cookie = "lh_cloud=1";
		const server = script({ held: { chat_2: holder }, check: "offline" });
		const outcome = await mount();
		await click(byTest("delete-confirm"));
		assert.equal(server.checks(), 1);
		assert.deepEqual(server.takes(), [], "no take-over: nothing is marked this PC's");
		assert.equal(server.deletesMade().length, 0);
		assert.equal(failureText(), FOLDER_DELETE_FAILED_TEXT);
		assert.equal(byTest("delete-retry")?.textContent, "Try again");
		assert.deepEqual(outcome.deleted, []);
	});

	it("paused or removed by the server counts the same", async () => {
		for (const state of ["paused", "needs-pairing"]) {
			cookie = "lh_cloud=1";
			const server = script({ held: { chat_2: holder }, check: state });
			await mount();
			await click(byTest("delete-confirm"));
			assert.equal(server.deletesMade().length, 0, state);
			assert.equal(failureText(), FOLDER_DELETE_FAILED_TEXT, state);
			for (const { root, host } of roots.splice(0)) { await act(async () => root.unmount()); host.remove(); }
			move.resetSessionMoveForTests();
		}
	});

	it("a move that answers continued-offline (the server went away in between) deletes nothing", async () => {
		cookie = "lh_cloud=1";
		const server = script({ held: { chat_1: holder, chat_2: holder }, take: (chatId) => (chatId === "chat_2" ? { status: "continued-offline" } : { status: "moved" }) });
		await mount();
		await click(byTest("delete-confirm"));
		assert.equal(server.takes().length, 2);
		assert.equal(server.deletesMade().length, 0);
		assert.equal(failureText(), FOLDER_DELETE_FAILED_TEXT);
	});

	it("a folder whose sessions all live on this PC still deletes offline, with no extra request", async () => {
		cookie = "lh_cloud=1";
		const server = script({ held: { chat_elsewhere: holder }, check: "offline" });
		const outcome = await mount();
		await click(byTest("delete-confirm"));
		assert.deepEqual(server.work(), [{ method: "DELETE", url: FOLDER_URL, body: SCOPE }]);
		assert.equal(outcome.deleted.length, 1);
	});
});

describe("a folder Delete's failure stays in its box", () => {
	it("no session is left flagged, so no lesson shows a failed move afterwards", async () => {
		cookie = "lh_cloud=1";
		script({ held: { chat_1: holder, chat_2: holder }, take: () => ({ status: "refused" }) });
		await mount();
		await click(byTest("delete-confirm"));
		assert.equal(failureText(), FOLDER_DELETE_FAILED_TEXT);
		assert.equal(move.isMoveFailed("chat_1"), false);
		assert.equal(move.isMoveFailed("chat_2"), false);
	});

	it("nor after the net's move fails", async () => {
		cookie = "lh_cloud=1";
		script({ held: {}, take: () => ({ status: "refused" }), deletes: [{ status: 409, body: { code: "session_held_elsewhere", error: "This session is held by another device. Take it over to continue it here." } }] });
		await mount();
		await click(byTest("delete-confirm"));
		assert.ok(SCOPE.chatIds.every((chatId) => !move.isMoveFailed(chatId)));
	});
});

describe("the single-session Delete's net (fetchHere)", () => {
	it("a refusal whose move then fails shows the approved sentence, never the retired one", async () => {
		cookie = "lh_cloud=1";
		const { DeleteSessionDialog } = await import("../components/delete-session-dialog.tsx");
		const { SESSION_MOVE_FAILED_TEXT } = await import("../src/core/sync/screens.ts");
		const server = script({ held: {}, take: () => ({ status: "refused" }), deletes: [{ status: 409, body: { code: "session_held_elsewhere", error: "This session is held by another device. Take it over to continue it here." } }] });
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		roots.push({ root, host });
		await act(async () => root.render(<InteractionLayersProvider><ServerEventsProvider connect={channel()}><CloudProvider>
			<DeleteSessionDialog chat={{ id: "chat_1", title: "Circuits" }} onClose={() => {}} onDeleted={() => {}} />
		</CloudProvider></ServerEventsProvider></InteractionLayersProvider>));
		await settle();
		await click(byTest("delete-confirm"));
		assert.equal(server.deletesMade().length, 1, "tried once; the move failed, so not again");
		assert.equal(failureText(), SESSION_MOVE_FAILED_TEXT);
		assert.doesNotMatch(document.body.textContent ?? "", /held by another device|Take it over/);
	});

	it("fetchHere answers the made-up refusal: same status and code, the approved sentence", async () => {
		cookie = "lh_cloud=1";
		const { SESSION_MOVE_FAILED_TEXT } = await import("../src/core/sync/screens.ts");
		script({ held: {}, take: () => ({ status: "refused" }), deletes: [{ status: 409, body: { code: "session_held_elsewhere", error: "This session is held by another device. Take it over to continue it here." } }] });
		await mount(); // connects the cloud state
		const response = await move.fetchHere("chat_9", "/api/chats/chat_9", { method: "DELETE" });
		assert.equal(response.status, 409);
		assert.equal(await move.isHeldRefusal(response), true, "callers that look for the refusal (manual extraction) still see one");
		assert.deepEqual(await response.json(), { code: "session_held_elsewhere", error: SESSION_MOVE_FAILED_TEXT });
		assert.equal(move.isMoveFailed("chat_9"), true, "a single session's failed move still raises its flag, as before");
	});
});
