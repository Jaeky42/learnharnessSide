/**
 * Settings → Obsidian and the notes drawer on the cloud server (cloud sync
 * Phase 4; docs/cloud-sync.md). fetch is scripted; no server. The wording
 * here is the owner-approved wording, so a change to it is a deliberate one.
 */

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { NotesTree } from "../src/core/notes.ts";
import { OBSIDIAN_TEXT, type ObsidianView } from "../src/core/obsidian-sync.ts";

const dom = parseHTML("<html><body></body></html>");
const storage = new Map<string, string>();
let cookie = "";
Object.assign(dom.window, {
	localStorage: {
		getItem: (k: string) => storage.get(k) ?? null,
		setItem: (k: string, v: string) => void storage.set(k, v),
		removeItem: (k: string) => void storage.delete(k),
	},
});
Object.defineProperty(dom.document, "cookie", { configurable: true, get: () => cookie });
Object.defineProperty(dom.document, "visibilityState", { configurable: true, get: () => "visible" });
Object.assign(globalThis, { window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent });
const originalFetch = globalThis.fetch;
const roots: { root: Root; host: HTMLElement }[] = [];

afterEach(async () => {
	for (const { root, host } of roots.splice(0)) {
		await act(async () => root.unmount());
		host.remove();
	}
	globalThis.fetch = originalFetch;
	storage.clear();
	cookie = "";
});

async function mount(node: React.ReactElement) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push({ root, host });
	await act(async () => root.render(node));
	await act(async () => new Promise((r) => setTimeout(r, 20)));
	return host;
}

const view = (over: Partial<ObsidianView> = {}): ObsidianView => ({
	phase: "connected",
	account: { name: "Test Learner", email: "learner@example.invalid" },
	vault: { id: "vault1", name: "Obsidian Vault" },
	sync: "up-to-date",
	lastSyncedAt: Date.now() - 60_000,
	leftOut: ["Untitled"],
	unsynced: false,
	busy: null,
	...over,
});

/** GET /api/obsidian answers `current`; POSTs are recorded and answered by `onPost`. */
function scriptObsidian(current: ObsidianView, onPost: (body: Record<string, unknown>) => { status?: number; body: Record<string, unknown> } = () => ({ body: { obsidian: current } })) {
	const posts: Record<string, unknown>[] = [];
	const requests: { url: string; method: string; header: string | null }[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		requests.push({ url, method, header: new Headers(init?.headers).get("x-learnharness-obsidian") });
		if (!url.startsWith("/api/obsidian")) return new Response(JSON.stringify({ error: "not scripted" }), { status: 404 });
		if (method === "GET") return Response.json({ obsidian: current });
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		posts.push(body);
		const reply = onPost(body);
		return Response.json(reply.body, { status: reply.status ?? 200 });
	}) as typeof fetch;
	return { posts, requests };
}

const click = async (el: Element | null | undefined) => {
	assert.ok(el, "the control exists");
	await act(async () => { (el as HTMLElement).click(); });
	await act(async () => new Promise((r) => setTimeout(r, 20)));
};
const button = (host: HTMLElement, label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);

describe("Settings → Obsidian", () => {
	it("asks for the Obsidian sign-in first", async () => {
		const { requests } = scriptObsidian(view({ phase: "signed-out", account: null, vault: null, sync: null, lastSyncedAt: null, leftOut: [] }));
		const { ObsidianSection } = await import("../components/settings/obsidian-section.tsx");
		const host = await mount(<ObsidianSection />);
		const text = host.textContent ?? "";
		assert.match(text, /Connect your Obsidian vault/);
		assert.match(text, /Only the LearnHarness folder is copied to this server\./);
		assert.match(text, /Obsidian email/);
		assert.match(text, /Obsidian password/);
		assert.match(text, /Two-step code/);
		assert.match(text, /Only if your Obsidian account asks for one\./);
		assert.match(text, /Your password goes straight to Obsidian’s sync program and is never saved here\./);
		assert.equal(host.querySelector("#obsidian-password")?.getAttribute("type"), "password");
		assert.equal(host.querySelector("[data-testid='obsidian-sign-in-submit']")?.hasAttribute("disabled"), true, "nothing typed yet");
		assert.ok(requests.every((r) => r.header === "1"), "every request carries the app's own header");
	});

	it("says so while the sync program is still installing", async () => {
		const { posts } = scriptObsidian(view({ phase: "installing", account: null, vault: null, sync: null, lastSyncedAt: null, leftOut: [] }));
		const { ObsidianSection } = await import("../components/settings/obsidian-section.tsx");
		const host = await mount(<ObsidianSection />);
		assert.match(host.textContent ?? "", new RegExp(OBSIDIAN_TEXT.installing.replaceAll(".", "\\.")));
		await click(button(host, "Check again"));
		assert.deepEqual(posts, [{ op: "retry" }]);
	});

	it("lists the vaults to choose from", async () => {
		const current = view({ phase: "signed-in", vault: null, sync: null, lastSyncedAt: null, leftOut: [] });
		const { posts } = scriptObsidian(current, (body) => body.op === "vaults"
			? { body: { obsidian: current, vaults: [{ id: "vault1", name: "Obsidian Vault" }, { id: "vault2", name: "Work" }] } }
			: { body: { obsidian: current } });
		const { ObsidianSection } = await import("../components/settings/obsidian-section.tsx");
		const host = await mount(<ObsidianSection />);
		const text = host.textContent ?? "";
		assert.match(text, /Signed in as Test Learner \(learner@example\.invalid\) · Sign out/);
		assert.match(text, /Choose your vault/);
		assert.match(text, /Pick the vault that holds your LearnHarness folder\./);
		assert.deepEqual([...host.querySelectorAll("input[type='radio']")].map((r) => r.getAttribute("value")), ["vault1", "vault2"]);
		assert.match(text, /Vault encryption password/);
		assert.match(text, /Leave it empty if this vault uses standard encryption\./);
		assert.ok(button(host, "Connect"));
		assert.deepEqual(posts, [{ op: "vaults" }]);
	});

	it("shows Obsidian's message when the account has no vaults", async () => {
		const current = view({ phase: "signed-in", vault: null, sync: null, lastSyncedAt: null, leftOut: [] });
		scriptObsidian(current, () => ({ status: 400, body: { obsidian: current, error: OBSIDIAN_TEXT.noVaults } }));
		const { ObsidianSection } = await import("../components/settings/obsidian-section.tsx");
		const host = await mount(<ObsidianSection />);
		assert.equal(host.querySelector("[data-testid='obsidian-error']")?.textContent, OBSIDIAN_TEXT.noVaults);
		assert.equal(button(host, "Connect"), undefined);
	});

	it("shows the everyday state and what is left out", async () => {
		scriptObsidian(view());
		const { ObsidianSection, lastSyncedText } = await import("../components/settings/obsidian-section.tsx");
		const host = await mount(<ObsidianSection />);
		const text = host.textContent ?? "";
		assert.match(text, /Connected to "Obsidian Vault"/);
		assert.match(text, /Signed in as learner@example\.invalid/);
		assert.equal(host.querySelector("[data-testid='obsidian-sync-state']")?.textContent, "Up to date");
		assert.match(text, /Last synced today, /);
		assert.match(text, /Left out of this server/);
		assert.equal(host.querySelector("[data-testid='obsidian-left-out']")?.textContent, "Untitled");
		assert.match(text, /Loose files at the top of your vault are copied too\. Obsidian Sync can only leave out folders\./);
		assert.equal(button(host, "Try again"), undefined);
		const now = new Date(2026, 10, 11, 15, 0).getTime();
		assert.match(lastSyncedText(new Date(2026, 10, 11, 14, 2).getTime(), now), /^today, /);
		assert.doesNotMatch(lastSyncedText(new Date(2026, 10, 9, 14, 2).getTime(), now), /today/);
	});

	it("asks before disconnecting, and again in stronger words when something is unsynced", async () => {
		const current = view();
		const { posts } = scriptObsidian(current, (body) => body.force === true
			? { body: { obsidian: view({ phase: "signed-out", account: null, vault: null, sync: null, lastSyncedAt: null, leftOut: [] }) } }
			: { status: 409, body: { obsidian: current, error: OBSIDIAN_TEXT.unsynced, unsynced: true } });
		const { ObsidianSection } = await import("../components/settings/obsidian-section.tsx");
		const host = await mount(<ObsidianSection />);
		await click(host.querySelector("[data-testid='obsidian-disconnect']"));
		assert.match(host.textContent ?? "", /Disconnect Obsidian\?/);
		assert.match(host.textContent ?? "", /The notes are removed from this server\. They stay in Obsidian and on your other devices\./);
		assert.equal(host.querySelector("[data-testid='obsidian-unsynced']"), null);
		assert.deepEqual(posts, [], "nothing happens until it's confirmed");
		// The server finds unsynced changes at the moment of the press.
		await click(host.querySelector("[data-testid='obsidian-disconnect-confirm-button']"));
		assert.deepEqual(posts, [{ op: "disconnect", force: false }]);
		assert.equal(host.querySelector("[data-testid='obsidian-unsynced']")?.textContent, OBSIDIAN_TEXT.unsynced);
		assert.equal(host.querySelector("[data-testid='obsidian-disconnect-confirm-button']")?.textContent, "Disconnect anyway");
		await click(host.querySelector("[data-testid='obsidian-disconnect-confirm-button']"));
		assert.deepEqual(posts[1], { op: "disconnect", force: true });
		assert.match(host.textContent ?? "", /Connect your Obsidian vault/);
	});

	it("offers to sign in again when the sign-in stopped being valid, keeping the notes", async () => {
		scriptObsidian(view({ sync: "needs-sign-in", account: null }));
		const { ObsidianSection } = await import("../components/settings/obsidian-section.tsx");
		const host = await mount(<ObsidianSection />);
		const text = host.textContent ?? "";
		assert.equal(host.querySelector("[data-testid='obsidian-sync-state']")?.textContent, "Sync stopped");
		assert.match(text, /Sign in to Obsidian again\./);
		assert.match(text, /Your notes stay on this server\. What you write here syncs once you’re signed in again\./);
		assert.equal(host.querySelector("[data-testid='obsidian-sign-in']"), null);
		await click(host.querySelector("[data-testid='obsidian-sign-in-again']"));
		assert.ok(host.querySelector("[data-testid='obsidian-sign-in']"), "the sign-in form, without disconnecting");
		assert.ok(button(host, "Cancel"));
	});

	it("explains a paused sync and offers only Disconnect", async () => {
		scriptObsidian(view({ sync: "paused" }));
		const { ObsidianSection } = await import("../components/settings/obsidian-section.tsx");
		const host = await mount(<ObsidianSection />);
		const text = host.textContent ?? "";
		assert.equal(host.querySelector("[data-testid='obsidian-sync-state']")?.textContent, "Sync is paused");
		assert.ok(text.includes(OBSIDIAN_TEXT.paused));
		assert.match(text, /Disconnect, then connect again to download a fresh copy\./);
		assert.equal(host.querySelector("[data-testid='obsidian-left-out']"), null);
		assert.equal(button(host, "Try again"), undefined);
		assert.ok(button(host, "Disconnect"));
	});

	it("offers Try again for an ended subscription and a crash loop, not for a missing vault", async () => {
		const { ObsidianSection } = await import("../components/settings/obsidian-section.tsx");
		for (const [sync, label, retry] of [
			["subscription", "Sync stopped. Your Obsidian Sync subscription has expired.", true],
			["failing", "Sync keeps stopping. The reason is in the server log.", true],
			["vault-gone", "Sync stopped. This vault no longer exists in Obsidian Sync.", false],
			["offline", "Can't reach Obsidian. Trying again.", false],
			["first-sync", "Downloading your notes…", false],
		] as const) {
			const { posts } = scriptObsidian(view({ sync }));
			const host = await mount(<ObsidianSection />);
			assert.equal(host.querySelector("[data-testid='obsidian-sync-state']")?.textContent, label);
			assert.equal(!!button(host, "Try again"), retry, sync);
			if (retry) { await click(button(host, "Try again")); assert.deepEqual(posts, [{ op: "retry" }]); }
		}
	});
});

describe("notes drawer on the cloud server", () => {
	const status = (over: Partial<NotesTree["status"]> = {}): NotesTree["status"] => ({
		configured: true, vaultPath: "/data/vault", vaultName: "vault", available: true, pending: 0, attachmentFolder: "LearnHarness/attachments", ...over,
	});
	function scriptNotes(tree: NotesTree) {
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.startsWith("/api/notes")) return Response.json(tree);
			if (url.startsWith("/api/chats/")) return Response.json({ homeFolder: null });
			return new Response(JSON.stringify({ error: "not scripted" }), { status: 404 });
		}) as typeof fetch;
	}

	it("points to Settings instead of asking for a folder path", async () => {
		cookie = "lh_server=1";
		scriptNotes({ status: status({ configured: false, vaultPath: null, vaultName: null, available: false }), folders: [], notes: [], backlinks: {} });
		const { NotesDrawer } = await import("../components/notes/notes-drawer.tsx");
		const host = await mount(<NotesDrawer chatId="chat_1" onClose={() => {}} />);
		const text = host.textContent ?? "";
		assert.ok(host.querySelector("[data-testid='notes-connect-obsidian']"));
		assert.match(text, /Connect your Obsidian vault/);
		assert.match(text, /Your notes live in your Obsidian vault\. Connect it in Settings and they’ll appear here\./);
		assert.ok(button(host, "Open Settings"));
		assert.doesNotMatch(text, /Use this folder/);
		assert.doesNotMatch(text, /full path/);
	});

	it("says when the notes aren't syncing, and only then", async () => {
		cookie = "lh_server=1";
		scriptNotes({ status: status({ sync: "stopped" }), folders: ["Inbox"], notes: [], backlinks: {} });
		const { NotesDrawer } = await import("../components/notes/notes-drawer.tsx");
		const stopped = await mount(<NotesDrawer chatId="chat_1" onClose={() => {}} />);
		assert.match(stopped.querySelector("[data-testid='notes-not-syncing']")?.textContent ?? "", new RegExp(`^${OBSIDIAN_TEXT.notSyncing.replaceAll(".", "\\.")} Settings$`));

		scriptNotes({ status: status({ sync: "ok" }), folders: ["Inbox"], notes: [], backlinks: {} });
		const fine = await mount(<NotesDrawer chatId="chat_2" onClose={() => {}} />);
		assert.equal(fine.querySelector("[data-testid='notes-not-syncing']"), null);
	});

	it("leaves the desktop's drawer exactly as it was", async () => {
		// No server marker: the path box, and no banner whatever the status says.
		scriptNotes({ status: status({ configured: false, vaultPath: null, vaultName: null, available: false }), folders: [], notes: [], backlinks: {} });
		const { NotesDrawer } = await import("../components/notes/notes-drawer.tsx");
		const setup = await mount(<NotesDrawer chatId="chat_1" onClose={() => {}} />);
		assert.match(setup.textContent ?? "", /Use this folder/);
		assert.equal(setup.querySelector("[data-testid='notes-connect-obsidian']"), null);

		scriptNotes({ status: status({ sync: "stopped" }), folders: ["Inbox"], notes: [], backlinks: {} });
		const drawer = await mount(<NotesDrawer chatId="chat_2" onClose={() => {}} />);
		assert.equal(drawer.querySelector("[data-testid='notes-not-syncing']"), null);
	});
});
