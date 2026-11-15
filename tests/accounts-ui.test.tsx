/**
 * Settings → Accounts (several accounts on one server; docs/multi-account-plan.md,
 * "The owner's screen" and "The approved words"): the owner's list of accounts,
 * invite codes and removed accounts, its ⋯ menu and confirm boxes, and where it
 * sits in Settings (a row under Account on a computer, a group inside Account
 * on a phone). fetch is scripted; no server. The wording is the owner-approved
 * wording (src/core/account-screens.ts), so most sentences are checked twice:
 * against the constants and against the literal text from the plan.
 */

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { installModalDom } from "./modal-dom.ts";
import type { AccountsView } from "../src/core/accounts.ts";
import {
	ACCOUNTS_TEXT,
	accountStatusText,
	dayText,
	deleteNowConfirm,
	inviteBox,
	inviteUntilText,
	pauseConfirm,
	removeConfirm,
	removedText,
	resetCodeBox,
	resetConfirm,
	restoreFullText,
	serverFullText,
	usedText,
} from "../src/core/account-screens.ts";

const dom = parseHTML("<html><body></body></html>");
let cookie = "";
/** "desktop": no query matches; "phone": a narrow touch screen. */
let layout: "desktop" | "phone" = "desktop";
const layoutListeners = new Set<() => void>();
Object.defineProperty(dom.document, "cookie", { configurable: true, get: () => cookie });
Object.defineProperty(dom.document, "visibilityState", { configurable: true, get: () => "visible" });
Object.assign(dom.document, { oninput: null });
Object.assign(dom.window, {
	location: { origin: "https://learn.example.com" },
	matchMedia: (query: string) => ({
		matches: layout === "phone" && (query.includes("max-width") || query.includes("pointer: coarse")),
		addEventListener(_type: string, listener: () => void) { layoutListeners.add(listener); },
		removeEventListener(_type: string, listener: () => void) { layoutListeners.delete(listener); },
	}),
	getSelection: () => ({ anchorNode: null, focusNode: null, anchorOffset: 0, focusOffset: 0, rangeCount: 0 }),
});
Object.assign(globalThis, { window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element });
// The boxes and the ⋯ menu sit on the host's layers (HostDialog, MenuShell).
const restoreModalDom = installModalDom(dom);
Object.assign(dom.window, { innerWidth: 1280, innerHeight: 800 });
const modalStyle = globalThis.getComputedStyle;
const withVars = ((el: Element) => Object.assign(modalStyle(el), { getPropertyValue: () => "" })) as typeof getComputedStyle;
Object.assign(globalThis, { getComputedStyle: withVars, ResizeObserver: class { observe() {} disconnect() {} } });
Object.assign(dom.window, { getComputedStyle: withVars });
// React decides how it hears typing when it loads, so it loads after the page exists.
const { createRoot } = await import("react-dom/client");
const { InteractionLayersProvider } = await import("../components/interaction-layers.tsx");
const { AccountsSection } = await import("../components/settings/accounts-section.tsx");
const { isOwnerMode } = await import("../components/settings/owner-mode.ts");
const { SettingsDialogBody } = await import("../components/settings/settings-dialog.tsx");

const originalFetch = globalThis.fetch;
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;
const roots: { root: Root; host: HTMLElement }[] = [];
const clipboard: string[] = [];

/** The components' repeating checks, run by hand instead of by the clock. */
let intervals: Array<{ run: () => void; ms: number }> = [];
beforeEach(() => {
	intervals = [];
	clipboard.length = 0;
	globalThis.setInterval = ((run: () => void, ms: number) => { const entry = { run, ms }; intervals.push(entry); return entry; }) as unknown as typeof setInterval;
	globalThis.clearInterval = ((entry: unknown) => { intervals = intervals.filter((i) => i !== entry); }) as unknown as typeof clearInterval;
	Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { clipboard.push(text); } } });
});
afterEach(async () => {
	for (const { root, host } of roots.splice(0)) {
		await act(async () => root.unmount());
		host.remove();
	}
	globalThis.fetch = originalFetch;
	globalThis.setInterval = originalSetInterval;
	globalThis.clearInterval = originalClearInterval;
	cookie = "";
	layout = "desktop";
});
process.on("exit", restoreModalDom);

const settle = () => act(async () => new Promise<void>((r) => setTimeout(r, 20)));
async function mount(node: React.ReactElement) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push({ root, host });
	await act(async () => root.render(<InteractionLayersProvider>{node}</InteractionLayersProvider>));
	await settle();
	return host;
}
async function unmountAll() {
	for (const { root, host } of roots.splice(0)) { await act(async () => root.unmount()); host.remove(); }
}
const tick = async (ms: number) => {
	await act(async () => { for (const interval of intervals.filter((i) => i.ms === ms)) interval.run(); });
	await settle();
};
const click = async (el: Element | null | undefined) => {
	assert.ok(el, "the control exists");
	await act(async () => { (el as HTMLElement).click(); });
	await settle();
};
const escape = async () => {
	const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
	Object.assign(event, { key: "Escape" });
	await act(async () => { document.dispatchEvent(event); });
	await settle();
};
const byTest = (root: ParentNode, id: string) => root.querySelector<HTMLElement>(`[data-testid='${id}']`);
const allByTest = (root: ParentNode, id: string) => [...root.querySelectorAll<HTMLElement>(`[data-testid='${id}']`)];
const text = (el: Element | null | undefined) => el?.textContent ?? "";
const buttonIn = (root: ParentNode, label: string) => [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as HTMLElement | undefined;

// ─── A scripted server ───────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 10, 15, 12, 0, 0).getTime();
const accountRow = (id: string, name: string, extra: Partial<AccountsView["accounts"][number]> = {}): AccountsView["accounts"][number] =>
	({ id, name, role: "member", state: "active", signedInNow: false, lastSeenAt: null, ...extra });
const OWNER = accountRow("acc_owner", "ada", { role: "owner", signedInNow: true });
const SAM = accountRow("acc_sam", "sam", { lastSeenAt: NOW - 6 * DAY });
const view = (extra: Partial<AccountsView> = {}): AccountsView => ({ accounts: [OWNER, SAM], invites: [], removed: [], used: 2, cap: 4, ...extra });

type Reply = { status?: number; body: unknown };
/** GET /api/accounts answers `current()`; each POST is recorded and answered by `onPost`. */
function script(current: () => AccountsView | null, onPost: (body: Record<string, unknown>) => Reply = () => ({ body: { view: current() } })) {
	const posts: Record<string, unknown>[] = [];
	const requests: string[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		requests.push(`${method} ${url}`);
		if (method === "GET") {
			const now = current();
			return url === "/api/accounts" && now ? Response.json(now) : new Response("{}", { status: now ? 404 : 500 });
		}
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		posts.push(body);
		const reply = onPost(body);
		return Response.json(reply.body, { status: reply.status ?? 200 });
	}) as typeof fetch;
	return { posts, requests };
}
const owner = () => { cookie = "lh_server=1; lh_owner=1"; };
async function mountSection() {
	owner();
	return mount(<AccountsSection />);
}
const rows = (host: ParentNode) => allByTest(host, "accounts-row").map((row) => [text(byTest(row, "accounts-name")), text(byTest(row, "accounts-status"))]);
const menuLabels = () => [...document.querySelectorAll("[role='menu'] [role='menuitem']")].map((b) => b.textContent);
const menuItem = (label: string) => [...document.querySelectorAll("[role='menu'] [role='menuitem']")].find((b) => b.textContent === label) as HTMLElement;
const openMenuOf = async (host: ParentNode, name: string) => {
	const row = allByTest(host, "accounts-row").find((r) => text(byTest(r, "accounts-name")) === name);
	await click(row && byTest(row, "accounts-menu-button"));
};
const dialog = () => document.querySelector<HTMLElement>("[role='dialog']");
const dialogButton = (label: string) => [...document.querySelectorAll("[role='dialog'] button")].find((b) => b.textContent?.trim() === label) as HTMLElement | undefined;

// ─── The list ────────────────────────────────────────────────────────────────

describe("Settings → Accounts: the list", () => {
	it("shows loading, then one line per account in the approved words, and how many are used", async () => {
		const withMembers = view({
			accounts: [OWNER, SAM, accountRow("acc_lee", "lee", { signedInNow: true }), accountRow("acc_new", "kim"), accountRow("acc_p", "pat", { state: "paused", lastSeenAt: NOW - DAY })],
			used: 5, cap: 6,
		});
		script(() => withMembers);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const answer = globalThis.fetch;
		globalThis.fetch = (async (...args: Parameters<typeof fetch>) => { await gate; return answer(...args); }) as typeof fetch;
		owner();
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		roots.push({ root, host });
		await act(async () => root.render(<InteractionLayersProvider><AccountsSection /></InteractionLayersProvider>));
		assert.equal(text(byTest(host, "accounts-loading")), "Loading…", "while the first answer is on its way");
		release();
		await settle();
		assert.equal(byTest(host, "accounts-loading"), null);
		assert.equal(text(host.querySelector("[data-testid='accounts-list'] > p")), ACCOUNTS_TEXT.group);
		assert.equal(ACCOUNTS_TEXT.group, "Accounts");
		const lines = rows(host);
		assert.deepEqual(lines.map((l) => l[0]), ["ada", "sam", "lee", "kim", "pat"]);
		assert.equal(lines[0]![1], "Owner · signed in now", "the plan's literal");
		assert.equal(lines[0]![1], accountStatusText(OWNER, NOW));
		assert.equal(lines[2]![1], "Signed in now");
		assert.equal(lines[3]![1], "Never signed in");
		assert.match(lines[1]![1]!, /^Last seen .+/);
		assert.equal(lines[1]![1], accountStatusText(SAM, Date.now()));
		assert.equal(lines[4]![1], "Paused");
		assert.equal(text(byTest(host, "accounts-used")), "5 of 6 accounts used.");
		assert.equal(text(byTest(host, "accounts-used")), usedText(5, 6));
		assert.equal(usedText(3, 4), "3 of 4 accounts used.");
	});

	it("the owner's own line has no menu", async () => {
		script(() => view());
		const host = await mountSection();
		const [first, second] = allByTest(host, "accounts-row");
		assert.equal(byTest(first!, "accounts-menu-button"), null);
		assert.ok(byTest(second!, "accounts-menu-button"));
	});

	it("a member's ⋯ menu: Reset password, Pause, Remove (red, last); a paused one has Resume instead of Pause", async () => {
		script(() => view({ accounts: [OWNER, SAM, accountRow("acc_p", "pat", { state: "paused" })] }));
		const host = await mountSection();
		await openMenuOf(host, "sam");
		assert.deepEqual(menuLabels(), ["Reset password", "Pause", "Remove"]);
		assert.deepEqual(menuLabels(), [ACCOUNTS_TEXT.menu.reset, ACCOUNTS_TEXT.menu.pause, ACCOUNTS_TEXT.menu.remove]);
		assert.match(menuItem("Remove").className, /text-error/);
		assert.doesNotMatch(menuItem("Reset password").className, /text-error/);
		await escape();
		assert.equal(document.querySelector("[role='menu']"), null, "Esc closes the menu");
		await openMenuOf(host, "pat");
		assert.deepEqual(menuLabels(), ["Reset password", "Resume", "Remove"]);
	});
});

// ─── The four confirm boxes, and Resume ──────────────────────────────────────

describe("Settings → Accounts: the owner's confirm boxes", () => {
	it("Pause: the approved box; Cancel posts nothing; Pause posts and the list follows the answer", async () => {
		const paused = view({ accounts: [OWNER, { ...SAM, state: "paused" }] });
		const { posts } = script(() => view(), () => ({ body: { view: paused } }));
		const host = await mountSection();
		await openMenuOf(host, "sam");
		await click(menuItem("Pause"));
		assert.equal(menuLabels().length, 0, "the menu closes");
		assert.equal(text(byTest(document, "accounts-confirm-title")), "Pause “sam”?");
		assert.equal(text(byTest(document, "accounts-confirm-body")), "sam can't sign in and their copy stops. Nothing is deleted.");
		assert.equal(text(byTest(document, "accounts-confirm-title")), pauseConfirm("sam").title);
		assert.deepEqual([...document.querySelectorAll("[role='dialog'] button")].map((b) => b.textContent), ["Cancel", "Pause"]);
		await click(dialogButton("Cancel"));
		assert.equal(dialog(), null);
		assert.deepEqual(posts, []);
		await openMenuOf(host, "sam");
		await click(menuItem("Pause"));
		assert.doesNotMatch(dialogButton("Pause")!.className, /bg-destructive/, "not red");
		await click(dialogButton("Pause"));
		assert.deepEqual(posts, [{ op: "pause", id: "acc_sam" }]);
		assert.equal(dialog(), null);
		assert.equal(rows(host)[1]![1], "Paused", "from the view the answer carried");
	});

	it("Resume acts at once, with no box", async () => {
		const { posts } = script(() => view({ accounts: [OWNER, { ...SAM, state: "paused" }] }), () => ({ body: { view: view() } }));
		const host = await mountSection();
		await openMenuOf(host, "sam");
		await click(menuItem("Resume"));
		assert.equal(dialog(), null);
		assert.deepEqual(posts, [{ op: "resume", id: "acc_sam" }]);
		assert.match(rows(host)[1]![1]!, /^Last seen/);
	});

	it("Remove: the approved red box; the account moves to Removed", async () => {
		const after = view({ accounts: [OWNER], used: 1, removed: [{ id: "acc_sam", name: "sam", removedAt: NOW, deletedAt: NOW + 30 * DAY }] });
		const { posts } = script(() => view(), () => ({ body: { view: after } }));
		const host = await mountSection();
		assert.equal(byTest(host, "accounts-removed"), null, "no Removed group while nothing is removed");
		await openMenuOf(host, "sam");
		await click(menuItem("Remove"));
		assert.equal(text(byTest(document, "accounts-confirm-title")), "Remove “sam”?");
		assert.equal(text(byTest(document, "accounts-confirm-body")), "The account stops now. Its data is kept for 30 days, then deleted for good.");
		assert.equal(text(byTest(document, "accounts-confirm-body")), removeConfirm("sam").body);
		assert.match(dialogButton("Remove")!.className, /bg-destructive/, "red");
		await click(dialogButton("Remove"));
		assert.deepEqual(posts, [{ op: "remove", id: "acc_sam" }]);
		assert.deepEqual(rows(host).map((r) => r[0]), ["ada"]);
		assert.ok(byTest(host, "accounts-removed"));
		assert.equal(text(byTest(host, "accounts-used")), "1 of 4 accounts used.");
	});

	it("Reset: the approved box, then the code box with Copy and Done that only Done closes", async () => {
		const { posts } = script(() => view(), () => ({ body: { code: "ABCD-EFGH", expiresAt: NOW + DAY, view: view() } }));
		const host = await mountSection();
		await openMenuOf(host, "sam");
		await click(menuItem("Reset password"));
		assert.equal(text(byTest(document, "accounts-confirm-title")), "Reset “sam”’s password?");
		assert.equal(text(byTest(document, "accounts-confirm-body")), "You get a code to pass on. It works once, for 24 hours. When it is used, sam is signed out everywhere and pairs their desktop apps again.");
		assert.equal(text(byTest(document, "accounts-confirm-body")), resetConfirm("sam").body);
		assert.deepEqual([...document.querySelectorAll("[role='dialog'] button")].map((b) => b.textContent), ["Cancel", "Get reset code"]);
		await click(dialogButton("Get reset code"));
		assert.deepEqual(posts, [{ op: "reset", id: "acc_sam" }]);
		assert.equal(text(byTest(document, "accounts-code-title")), "Reset code for “sam”");
		assert.equal(text(byTest(document, "accounts-code-title")), resetCodeBox("sam").title);
		assert.equal(text(byTest(document, "accounts-code")), "ABCD-EFGH");
		assert.equal(text(byTest(document, "accounts-code-body")), "Works once, for 24 hours.");
		assert.deepEqual([...document.querySelectorAll("[role='dialog'] button")].map((b) => b.textContent), ["Copy", "Done"]);
		await click(byTest(document, "accounts-code-copy"));
		assert.deepEqual(clipboard, ["ABCD-EFGH"]);
		await escape();
		assert.ok(dialog(), "Esc doesn't lose a code that can't be shown again");
		await click(byTest(document, "accounts-code-done"));
		assert.equal(dialog(), null);
		assert.equal(text(byTest(host, "accounts-list")).includes("ABCD-EFGH"), false, "the code is gone from the page");
	});

	it("Delete now: the approved red box, from the Removed group", async () => {
		const before = view({ accounts: [OWNER], used: 1, removed: [{ id: "acc_lee", name: "lee", removedAt: NOW - 2 * DAY, deletedAt: NOW + 28 * DAY }] });
		const { posts } = script(() => before, () => ({ body: { view: view({ accounts: [OWNER], used: 1 }) } }));
		const host = await mountSection();
		await click(byTest(host, "accounts-delete-now"));
		assert.equal(text(byTest(document, "accounts-confirm-title")), "Delete “lee” now?");
		assert.equal(text(byTest(document, "accounts-confirm-body")), "This deletes the account's data for good.");
		assert.equal(text(byTest(document, "accounts-confirm-title")), deleteNowConfirm("lee").title);
		assert.deepEqual([...document.querySelectorAll("[role='dialog'] button")].map((b) => b.textContent), ["Cancel", "Delete"]);
		assert.match(dialogButton("Delete")!.className, /bg-destructive/);
		await click(dialogButton("Delete"));
		assert.deepEqual(posts, [{ op: "delete-now", id: "acc_lee" }]);
		assert.equal(byTest(host, "accounts-removed"), null, "the group goes with its last line");
	});
});

// ─── Invite codes ────────────────────────────────────────────────────────────

describe("Settings → Accounts: invite codes", () => {
	it("New invite code shows the code once in its box; the waiting code is listed and can be cancelled", async () => {
		const expires = NOW + 7 * DAY;
		const withInvite = view({ invites: [{ id: "inv_1", expiresAt: expires }] });
		const { posts } = script(() => view(), (body) => ({ body: body.op === "invite" ? { code: "WXYZ-1234", expiresAt: expires, view: withInvite } : { view: view() } }));
		const host = await mountSection();
		assert.equal(text(byTest(host, "accounts-new-invite")), "New invite code");
		assert.equal(allByTest(host, "accounts-invite").length, 0);
		await click(byTest(host, "accounts-new-invite"));
		assert.deepEqual(posts, [{ op: "invite" }]);
		assert.equal(text(byTest(document, "accounts-code-title")), "Invite code");
		assert.equal(text(byTest(document, "accounts-code")), "WXYZ-1234");
		assert.equal(text(byTest(document, "accounts-code-body")), inviteBox(expires).body);
		assert.match(text(byTest(document, "accounts-code-body")), /^Works once, until .+\. Send it to the person with this site's address\.$/, "the plan's sentence");
		assert.deepEqual([...document.querySelectorAll("[role='dialog'] button")].map((b) => b.textContent), ["Copy", "Done"]);
		await click(byTest(document, "accounts-code-copy"));
		assert.deepEqual(clipboard, ["WXYZ-1234"]);
		await click(byTest(document, "accounts-code-done"));
		assert.equal(dialog(), null);
		// The waiting code: its sentence, never the code itself.
		const [waiting] = allByTest(host, "accounts-invite");
		assert.match(text(waiting), /^Works once, until .+Cancel$/);
		assert.ok(text(waiting).includes(inviteUntilText(expires)));
		assert.equal(text(host).includes("WXYZ-1234"), false);
		await click(byTest(host, "accounts-cancel-invite"));
		assert.deepEqual(posts.at(-1), { op: "cancel-invite", id: "inv_1" });
		assert.equal(allByTest(host, "accounts-invite").length, 0);
	});

	it("with no free slot the button is greyed and the full-server sentence shows", async () => {
		const { posts } = script(() => view({ used: 4, cap: 4 }));
		const host = await mountSection();
		assert.equal((byTest(host, "accounts-new-invite") as HTMLButtonElement).disabled, true);
		assert.equal(text(byTest(host, "accounts-full")), "All 4 accounts are used. Remove one to invite someone.");
		assert.equal(text(byTest(host, "accounts-full")), serverFullText(4));
		await click(byTest(host, "accounts-new-invite"));
		assert.deepEqual(posts, []);
	});

	it("a server that answers 'full' to an invite shows the same sentence", async () => {
		let current = view();
		script(() => current, () => { current = view({ used: 4 }); return { status: 409, body: { error: "full", code: "full" } }; });
		const host = await mountSection();
		await click(byTest(host, "accounts-new-invite"));
		assert.equal(dialog(), null);
		assert.equal(text(byTest(host, "accounts-full")), "All 4 accounts are used. Remove one to invite someone.");
		assert.equal((byTest(host, "accounts-new-invite") as HTMLButtonElement).disabled, true, "the list was read again");
	});
});

// ─── Removed ─────────────────────────────────────────────────────────────────

describe("Settings → Accounts: removed accounts", () => {
	const removed = [{ id: "acc_lee", name: "lee", removedAt: NOW - 2 * DAY, deletedAt: NOW + 28 * DAY }];

	it("lists the name, when it was removed and when it is deleted, with Restore and Delete now", async () => {
		script(() => view({ removed }));
		const host = await mountSection();
		const group = byTest(host, "accounts-removed")!;
		assert.equal(text(group.querySelector("p")), "Removed");
		assert.equal(text(byTest(group, "accounts-removed-line")), removedText(removed[0]!.removedAt, removed[0]!.deletedAt));
		assert.match(text(byTest(group, "accounts-removed-line")), /^Removed .+ · deleted for good on .+$/, "the plan's shape");
		assert.ok(text(byTest(group, "accounts-removed-line")).includes(dayText(NOW + 28 * DAY)));
		assert.deepEqual([...group.querySelectorAll("button")].map((b) => b.textContent), ["Restore", "Delete now"]);
	});

	it("Restore acts at once and the account is back in the list", async () => {
		const { posts } = script(() => view({ removed }), () => ({ body: { view: view({ accounts: [OWNER, SAM, accountRow("acc_lee", "lee")], used: 3 }) } }));
		const host = await mountSection();
		await click(byTest(host, "accounts-restore"));
		assert.equal(dialog(), null, "no box");
		assert.deepEqual(posts, [{ op: "restore", id: "acc_lee" }]);
		assert.deepEqual(rows(host).map((r) => r[0]), ["ada", "sam", "lee"]);
		assert.equal(byTest(host, "accounts-removed"), null);
	});

	it("Restore with no room shows the approved sentence", async () => {
		script(() => view({ removed, used: 4 }), () => ({ status: 409, body: { error: "full", code: "full" } }));
		const host = await mountSection();
		await click(byTest(host, "accounts-restore"));
		const sentence = text(byTest(byTest(host, "accounts-removed")!, "accounts-error"));
		assert.equal(sentence, "All 4 accounts are used. Remove one first.");
		assert.equal(sentence, restoreFullText(4));
		assert.ok(byTest(host, "accounts-removed-row"), "still removed");
	});
});

// ─── Refusals, load failures, refreshing ─────────────────────────────────────

describe("Settings → Accounts: refusals and refreshing", () => {
	it("a refusal shows the server's words when it sent some, the app's usual line when not, and a lost connection says so", async () => {
		let reply: Reply = { status: 400, body: { error: "That account can't be paused." } };
		script(() => view(), () => reply);
		const host = await mountSection();
		const pause = async () => { await openMenuOf(host, "sam"); await click(menuItem("Pause")); await click(dialogButton("Pause")); };
		await pause();
		assert.equal(dialog(), null);
		assert.equal(text(byTest(byTest(host, "accounts-list")!, "accounts-error")), "That account can't be paused.");
		reply = { status: 500, body: {} };
		await pause();
		assert.equal(text(byTest(byTest(host, "accounts-list")!, "accounts-error")), "Something went wrong. Try again.");
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method === "POST") throw new TypeError("offline");
			return Response.json(view());
		}) as typeof fetch;
		await pause();
		assert.equal(text(byTest(byTest(host, "accounts-list")!, "accounts-error")), "The server couldn't be reached. Check your connection and try again.");
		assert.equal(rows(host)[1]![1]!.startsWith("Last seen"), true, "the list is as it was");
	});

	it("a failed first read says so with a way to try again", async () => {
		let up = false;
		const { requests } = script(() => up ? view() : null);
		const host = await mountSection();
		assert.equal(text(byTest(host, "accounts-failed")!.querySelector("p")), "Something went wrong. Try again.");
		up = true;
		await click(buttonIn(host, "Try again"));
		assert.equal(byTest(host, "accounts-failed"), null);
		assert.deepEqual(rows(host).map((r) => r[0]), ["ada", "sam"]);
		assert.equal(requests.length, 2);
	});

	it("reads the list when it opens and every 10 seconds, and keeps the list when a refresh fails", async () => {
		let current: AccountsView | null = view();
		const { requests } = script(() => current);
		const host = await mountSection();
		assert.deepEqual(requests, ["GET /api/accounts"]);
		assert.deepEqual(intervals.map((i) => i.ms), [10_000]);
		current = view({ accounts: [OWNER, SAM, accountRow("acc_lee", "lee", { signedInNow: true })], used: 3 });
		await tick(10_000);
		assert.equal(requests.length, 2);
		assert.deepEqual(rows(host).map((r) => r[0]), ["ada", "sam", "lee"]);
		current = null;
		await tick(10_000);
		assert.equal(requests.length, 3);
		assert.deepEqual(rows(host).map((r) => r[0]), ["ada", "sam", "lee"], "a failed refresh doesn't blank the screen");
		await unmountAll();
		assert.deepEqual(intervals, [], "the timer goes with the screen");
	});
});

// ─── Who sees it ─────────────────────────────────────────────────────────────

describe("Settings → Accounts: who sees it", () => {
	it("the owner marker is the plain cookie lh_owner=1", () => {
		assert.equal(isOwnerMode("lh_server=1; lh_owner=1"), true);
		assert.equal(isOwnerMode("lh_owner=1"), true);
		assert.equal(isOwnerMode("lh_server=1"), false);
		assert.equal(isOwnerMode("lh_owner=0"), false);
		assert.equal(isOwnerMode("xlh_owner=1"), false);
		assert.equal(isOwnerMode(undefined), false);
	});

	it("without the markers the section renders nothing and asks nothing", async () => {
		const { requests } = script(() => view());
		for (const jar of ["", "lh_server=1", "lh_owner=1"]) {
			cookie = jar;
			const host = await mount(<AccountsSection />);
			assert.equal(host.textContent, "", jar || "no cookies");
		}
		assert.deepEqual(requests, []);
		assert.deepEqual(intervals, []);
	});
});

// ─── The Settings rows ───────────────────────────────────────────────────────

describe("Settings: where Accounts sits", () => {
	const navIds = () => [...document.querySelectorAll('[data-testid="settings-nav"] > button')].map((b) => b.getAttribute("data-testid")!.slice("settings-nav-".length));
	const screen = () => document.querySelector('[data-phone="settings"]')?.getAttribute("data-phone-screen");
	let requests: string[] = [];
	beforeEach(() => {
		requests = [];
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			requests.push(`${init?.method ?? "GET"} ${url}`);
			if (url === "/api/settings") return Response.json({ settings: { version: 1 } });
			if (url === "/api/cloud") return Response.json(cookie.includes("lh_server") ? { role: "server", held: {}, desktops: [] } : { role: "desktop", sync: { state: "off" } });
			if (url === "/api/server-auth/account") return cookie.includes("lh_server") ? Response.json({ devices: [], desktops: [] }) : new Response(null, { status: 404 });
			if (url === "/api/accounts") return cookie.includes("lh_owner") ? Response.json(view()) : new Response("{}", { status: 404 });
			return Response.json({});
		}) as typeof fetch;
	});
	const turn = async (next: typeof layout) => {
		layout = next;
		await act(async () => { for (const listener of [...layoutListeners]) listener(); });
		await settle();
	};
	const accountsRequests = () => requests.filter((r) => r.includes("/api/accounts"));

	it("a computer, the owner on the server's site: one row, Accounts, directly under Account", async () => {
		owner();
		await mount(<SettingsDialogBody onClose={() => {}} initialSection="accounts" />);
		const ids = navIds();
		assert.equal(ids[ids.indexOf("account") + 1], "accounts");
		assert.equal(text(document.querySelector('[data-testid="settings-nav-accounts"] > span')), "Accounts");
		assert.equal(document.querySelector('[data-testid="settings-nav-accounts"]')?.getAttribute("aria-current"), "true");
		assert.ok(document.querySelector('[data-testid="section-accounts"] [data-testid="accounts-section"]'));
		assert.equal(document.querySelector('[data-testid="section-account"]'), null);
		assert.deepEqual(accountsRequests(), ["GET /api/accounts"]);
	});

	it("no row for a member, on a single-copy server, in the desktop app, or on a phone", async () => {
		const noRow = async (jar: string, where: string) => {
			cookie = jar;
			await mount(<SettingsDialogBody onClose={() => {}} />);
			assert.equal(navIds().includes("accounts"), false, where);
			await unmountAll();
		};
		await noRow("lh_server=1", "a member (no owner marker)");
		await noRow("", "the desktop app and a single-copy server's browser (no markers)");
		await noRow("lh_owner=1", "a stray owner marker without server mode");
		assert.deepEqual(accountsRequests(), [], "nothing asked of the gateway");
		// A link to it from a member lands on nothing of the owner's.
		cookie = "lh_server=1";
		await mount(<SettingsDialogBody onClose={() => {}} initialSection="accounts" />);
		assert.equal(document.querySelector('[data-testid="section-accounts"]'), null);
		assert.deepEqual(accountsRequests(), []);
	});

	it("nothing is asked while another section is open", async () => {
		owner();
		await mount(<SettingsDialogBody onClose={() => {}} initialSection="general" />);
		assert.ok(navIds().includes("accounts"));
		assert.deepEqual(accountsRequests(), []);
	});

	it("a phone: no row (the list stays at eight), and the owner's Account page ends with the Accounts group", async () => {
		owner();
		layout = "phone";
		await mount(<SettingsDialogBody onClose={() => {}} />);
		assert.deepEqual(navIds(), ["keys", "agent", "appearance", "graph", "general", "cloud", "account", "core-plugins"]);
		assert.equal(navIds().length, 8);
		await unmountAll();
		await mount(<SettingsDialogBody onClose={() => {}} initialSection="account" phoneOpensSection />);
		const section = document.querySelector('[data-testid="section-account"]')!;
		assert.ok(byTest(section, "account-section"), "the Account section's own groups");
		const group = byTest(section, "accounts-section")!;
		assert.ok(group, "Accounts as a second group");
		assert.equal(group.previousElementSibling?.hasAttribute("hidden"), true, "only a hidden marker sits between them");
		assert.equal(group.previousElementSibling?.previousElementSibling?.getAttribute("data-testid"), "account-section");
		assert.ok(group.className.includes("border-t"), "under a divider");
		assert.equal(text(group.querySelector("[data-testid='accounts-list'] > p")), "Accounts");
		assert.deepEqual(rows(group).map((r) => r[0]), ["ada", "sam"]);
		assert.ok(byTest(group, "accounts-new-invite"));
		assert.equal(document.querySelector('[data-testid="section-accounts"]'), null, "no section of its own");
	});

	it("a phone, a member: Account has no Accounts group and nothing is asked", async () => {
		cookie = "lh_server=1";
		layout = "phone";
		await mount(<SettingsDialogBody onClose={() => {}} initialSection="account" phoneOpensSection />);
		assert.ok(document.querySelector('[data-testid="section-account"]'));
		assert.equal(document.querySelector('[data-testid="accounts-section"]'), null);
		assert.deepEqual(accountsRequests(), []);
	});

	it("a link to Accounts on a phone opens Account with the group scrolled to the top, then leaves it alone", async () => {
		owner();
		layout = "phone";
		const proto = dom.window.HTMLElement.prototype as unknown as Record<string, unknown>;
		const own = { rect: Object.getOwnPropertyDescriptor(proto, "getBoundingClientRect"), scroll: Object.getOwnPropertyDescriptor(proto, "scrollTop") };
		// The page's geometry: the scrolling column's top at 100, the group's at 300.
		Object.defineProperty(proto, "getBoundingClientRect", { configurable: true, value(this: HTMLElement) {
			const id = this.getAttribute("data-testid");
			const top = id === "accounts-section" ? 300 - (document.querySelector<HTMLElement>('[data-testid="settings-content"]')!.scrollTop) : id === "settings-content" ? 100 : 0;
			return { top, bottom: top, left: 0, right: 0, width: 0, height: 0 };
		} });
		const scrolled = new WeakMap<object, number>();
		Object.defineProperty(proto, "scrollTop", { configurable: true, get(this: object) { return scrolled.get(this) ?? 0; }, set(this: object, value: number) { scrolled.set(this, value); } });
		try {
			await mount(<SettingsDialogBody onClose={() => {}} initialSection="accounts" phoneOpensSection />);
			assert.equal(screen(), "section");
			assert.equal(text(document.querySelector('[data-phone="settings-back"]')), "Account");
			assert.ok(document.querySelector('[data-testid="section-account"] [data-testid="accounts-section"]'));
			assert.equal(document.querySelector<HTMLElement>('[data-testid="settings-content"]')!.scrollTop, 200);
			assert.deepEqual(navIds(), ["keys", "agent", "appearance", "graph", "general", "cloud", "account", "core-plugins"]);
		} finally {
			for (const [name, descriptor] of [["getBoundingClientRect", own.rect], ["scrollTop", own.scroll]] as const) {
				if (descriptor) Object.defineProperty(proto, name, descriptor); else delete proto[name];
			}
		}
	});

	it("the layout turning into the phone one on Accounts shows Account with the group; turning wide again, Account stays", async () => {
		owner();
		await mount(<SettingsDialogBody onClose={() => {}} initialSection="accounts" />);
		assert.ok(document.querySelector('[data-testid="section-accounts"]'));
		await turn("phone");
		assert.equal(document.querySelector('[data-testid="section-accounts"]'), null);
		assert.ok(document.querySelector('[data-testid="section-account"] [data-testid="accounts-section"]'));
		await turn("desktop");
		assert.equal(document.querySelector('[data-testid="settings-nav-account"]')?.getAttribute("aria-current"), "true");
		assert.equal(document.querySelector('[data-testid="accounts-section"]'), null, "the group belongs to the phone layout");
		const ids = navIds();
		assert.equal(ids[ids.indexOf("account") + 1], "accounts", "the row is back on a wide screen");
	});

	it("the phone's group is the same screen: its ⋯ menu and boxes work inside Account", async () => {
		owner();
		layout = "phone";
		const posts: Record<string, unknown>[] = [];
		const base = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method === "POST" && String(input) === "/api/accounts") { posts.push(JSON.parse(String(init.body))); return Response.json({ view: view({ accounts: [OWNER, { ...SAM, state: "paused" }] }) }); }
			return base(input, init);
		}) as typeof fetch;
		await mount(<SettingsDialogBody onClose={() => {}} initialSection="account" phoneOpensSection />);
		const group = byTest(document, "accounts-section")!;
		await openMenuOf(group, "sam");
		await click(menuItem("Pause"));
		assert.equal(text(byTest(document, "accounts-confirm-title")), pauseConfirm("sam").title);
		await click(dialogButton("Pause"));
		assert.deepEqual(posts, [{ op: "pause", id: "acc_sam" }]);
		assert.equal(rows(group)[1]![1], "Paused");
	});

});
