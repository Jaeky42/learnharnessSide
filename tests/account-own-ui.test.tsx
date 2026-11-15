/**
 * Multi-account slice 5a: each person's Settings → Account, the new parts
 * (docs/multi-account-plan.md, "In each person's Settings → Account"). fetch
 * is scripted; no server. On a single-copy server the screen is exactly what
 * it was: the baseline below is the markup before this change, and the
 * request list is the one it always made (none from the section itself).
 */

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ACCOUNT_TEXT, ACCOUNTS_TEXT, RECOVERY_PAGE_TEXT, recoveryLeftText, signedInAs } from "../src/core/account-screens.ts";

class MemoryStorage {
	private readonly map = new Map<string, string>();
	get length() { return this.map.size; }
	key(i: number) { return [...this.map.keys()][i] ?? null; }
	getItem(k: string) { return this.map.get(k) ?? null; }
	setItem(k: string, v: string) { this.map.set(k, String(v)); }
	removeItem(k: string) { this.map.delete(k); }
	clear() { this.map.clear(); }
	keys() { return [...this.map.keys()].sort(); }
}

const dom = parseHTML("<html><body></body></html>");
let cookie = "";
Object.defineProperty(dom.document, "cookie", { configurable: true, get: () => cookie });
Object.defineProperty(dom.document, "visibilityState", { configurable: true, get: () => "visible" });
Object.assign(dom.document, { oninput: null }); // React hears typing through this
const local = new MemoryStorage();
const session = new MemoryStorage();
const replaced: string[] = [];
Object.assign(dom.window, { location: { origin: "https://learn.example.com", replace: (url: string) => { replaced.push(url); } }, localStorage: local, sessionStorage: session });
Object.assign(globalThis, { window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element });
const { createRoot } = await import("react-dom/client");
const { renderToStaticMarkup } = await import("react-dom/server");
const { InteractionLayersProvider } = await import("../components/interaction-layers.tsx");
const { installModalDom } = await import("./modal-dom.ts");
const { AccountSection, useServerAccount } = await import("../components/settings/account-section.tsx");
after(installModalDom(dom));

const originalFetch = globalThis.fetch;
const roots: { root: Root; host: HTMLElement }[] = [];
beforeEach(() => { local.clear(); session.clear(); replaced.length = 0; });
afterEach(async () => {
	for (const { root, host } of roots.splice(0)) { await act(async () => root.unmount()); host.remove(); }
	globalThis.fetch = originalFetch;
	cookie = "";
	for (const el of [...document.body.children]) el.remove();
});

const settle = () => act(async () => new Promise<void>((r) => setTimeout(r, 20)));
const byTest = (root: ParentNode, id: string) => root.querySelector(`[data-testid='${id}']`);
const click = async (el: Element | null | undefined) => { assert.ok(el, "the control exists"); await act(async () => { (el as HTMLElement).click(); }); await settle(); };
const type = async (el: Element | null | undefined, value: string) => {
	assert.ok(el, "the field exists");
	await act(async () => {
		Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(el, value);
		el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
	});
};
const submit = async (form: Element | null | undefined) => {
	assert.ok(form, "the form exists");
	await act(async () => { form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
	await settle();
};

const devices = [{ id: "a", label: "Chrome", createdAt: 1700000000000, lastSeenAt: 1700000100000, expiresAt: 1702600000000, current: true }];
type Info = { name: string; owner: boolean; recoveryCodesLeft: number };

const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
type Reply = { status?: number; body: unknown } | "network";
function script(reply: (url: string, body: Record<string, unknown> | null) => Reply) {
	calls.length = 0;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
		calls.push({ url, method: init?.method ?? "GET", body });
		const out = reply(url, body);
		if (out === "network") throw new TypeError("offline");
		return new Response(JSON.stringify(out.body), { status: out.status ?? 200, headers: { "content-type": "application/json" } });
	}) as typeof fetch;
}

let reloads = 0;
async function mount(info?: Info | null) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push({ root, host });
	reloads = 0;
	await act(async () => root.render(
		<InteractionLayersProvider><AccountSection devices={devices} reload={() => { reloads += 1; }} {...(info === undefined ? {} : { info })} /></InteractionLayersProvider>,
	));
	await settle();
	return host;
}
const buttons = (root: ParentNode) => [...root.querySelectorAll("button")].map((b) => b.textContent);
const buttonNamed = (root: ParentNode, label: string) => [...root.querySelectorAll("button")].find((b) => b.textContent === label);

const CODES = ["AAAA-1111", "BBBB-2222", "CCCC-3333", "DDDD-4444"];
const sam: Info = { name: "sam", owner: false, recoveryCodesLeft: 2 };
const SIGNED_OUT_TEXT = "Something went wrong. Try again.";

/** The markup of the screen before any of this was added (devices rendered with fixed times). */
const BASELINE = "<div data-testid=\"account-section\"><div data-testid=\"account-password\" class=\"mt-5 border-t border-border/60 pt-4 first:mt-0 first:border-t-0 first:pt-0\"><p class=\"mb-2 text-xs uppercase tracking-widest text-muted-foreground\">Password</p><div class=\"flex flex-col gap-2\"><form class=\"flex max-w-sm flex-col gap-2\"><label class=\"flex flex-col gap-1 text-xs text-muted-foreground\" for=\"account-current\">Current password<input id=\"account-current\" type=\"password\" autoComplete=\"current-password\" class=\"w-full rounded-sm border border-input bg-background px-2.5 py-1.5 font-ui text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring\" value=\"\"/></label><label class=\"flex flex-col gap-1 text-xs text-muted-foreground\" for=\"account-next\">New password (at least 8 characters)<input id=\"account-next\" type=\"password\" autoComplete=\"new-password\" class=\"w-full rounded-sm border border-input bg-background px-2.5 py-1.5 font-ui text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring\" value=\"\"/></label><label class=\"flex flex-col gap-1 text-xs text-muted-foreground\" for=\"account-confirm\">Type it again<input id=\"account-confirm\" type=\"password\" autoComplete=\"new-password\" class=\"w-full rounded-sm border border-input bg-background px-2.5 py-1.5 font-ui text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring\" value=\"\"/></label><button type=\"submit\" class=\"self-start rounded-sm border border-border px-3 py-1.5 font-ui text-sm text-foreground transition-colors hover:bg-accent disabled:opacity-50\" disabled=\"\">Change password</button></form></div></div><div data-testid=\"account-devices\" class=\"mt-5 border-t border-border/60 pt-4 first:mt-0 first:border-t-0 first:pt-0\"><p class=\"mb-2 text-xs uppercase tracking-widest text-muted-foreground\">Signed-in devices</p><div class=\"flex flex-col gap-2\"><ul class=\"flex flex-col gap-1.5\"><li class=\"font-ui text-sm\" data-testid=\"account-device\"><span class=\"text-foreground\">Chrome</span><span class=\"ml-2 text-xs text-muted-foreground\">(this device)</span><span class=\"block text-xs text-muted-foreground\">Signed in X</span></li></ul><div class=\"flex flex-wrap gap-2\"><button type=\"button\" class=\"self-start rounded-sm border border-border px-3 py-1.5 font-ui text-sm text-foreground transition-colors hover:bg-accent disabled:opacity-50\" data-testid=\"account-sign-out-here\">Sign out</button><button type=\"button\" class=\"self-start rounded-sm border border-border px-3 py-1.5 font-ui text-sm text-foreground transition-colors hover:bg-accent disabled:opacity-50\" data-testid=\"account-sign-out\">Sign out everywhere</button></div></div></div></div>";
const normalise = (html: string) => html.replace(/Signed in [^<]*/g, "Signed in X");

describe("a single-copy server: the screen as it was", () => {
	it("renders exactly the markup it did, with or without the new props", () => {
		assert.equal(normalise(renderToStaticMarkup(<AccountSection devices={devices} reload={() => {}} />)), BASELINE);
		assert.equal(normalise(renderToStaticMarkup(<AccountSection devices={devices} reload={() => {}} info={null} />)), BASELINE);
	});

	it("shows none of the new blocks and makes no request of its own", async () => {
		script(() => ({ body: {} }));
		const host = await mount(null);
		assert.equal(byTest(host, "account-signed-in-as"), null);
		for (const id of ["account-recovery", "account-data", "account-delete"]) assert.equal(byTest(host, id), null, id);
		assert.deepEqual(calls, []);
		assert.deepEqual(buttons(host), ["Change password", "Sign out", "Sign out everywhere"]);
	});

	it("Sign out and Sign out everywhere work as before and clear no storage", async () => {
		local.setItem("lh:notes-expanded", "[\"Physics\"]");
		session.setItem("lh.openingPrompt.chat_1", "{}");
		script(() => ({ body: { ok: true } }));
		const host = await mount(null);
		await click(byTest(host, "account-sign-out-here"));
		assert.deepEqual(calls.map((c) => [c.method, c.url]), [["POST", "/api/server-auth/logout"]]);
		assert.deepEqual(replaced, ["/login"]);
		await click(byTest(host, "account-sign-out"));
		await click(byTest(host, "account-sign-out-confirm"));
		assert.deepEqual(calls.map((c) => c.url), ["/api/server-auth/logout", "/api/server-auth/sign-out-everywhere"]);
		assert.deepEqual(replaced, ["/login", "/login"]);
		assert.deepEqual(local.keys(), ["lh:notes-expanded"]);
		assert.deepEqual(session.keys(), ["lh.openingPrompt.chat_1"]);
	});

	it("the hook asks the account route once, and a single-copy answer gives no info", async () => {
		cookie = "lh_server=1";
		script(() => ({ body: { devices, desktops: [] } }));
		let seen: ReturnType<typeof useServerAccount> | null = null;
		function Probe() { seen = useServerAccount(); return null; }
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		roots.push({ root, host });
		await act(async () => root.render(<Probe />));
		await settle();
		assert.deepEqual(calls.map((c) => [c.method, c.url]), [["GET", "/api/server-auth/account"]]);
		assert.equal(seen!.info, null);
		assert.equal(seen!.devices?.length, 1);
	});
});

describe("behind the gateway: Signed in as, and the three new blocks", () => {
	it("the settings dialog's own wiring (devices and reload only) is enough: the hook hands the rest over", async () => {
		cookie = "lh_server=1";
		script(() => ({ body: { devices, name: "sam", owner: false, recoveryCodesLeft: 3 } }));
		function Wired() {
			const account = useServerAccount();
			return account.devices ? <AccountSection devices={account.devices} reload={account.reload} /> : null;
		}
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		roots.push({ root, host });
		await act(async () => root.render(<InteractionLayersProvider><Wired /></InteractionLayersProvider>));
		await settle();
		assert.equal(byTest(host, "account-signed-in-as")?.textContent, "Signed in as sam");
		assert.equal(byTest(host, "account-recovery-left")?.textContent, "3 of 4 left.");
		assert.deepEqual(calls.map((c) => c.url), ["/api/server-auth/account"]);
	});

	it("shows the approved words", async () => {
		const host = await mount(sam);
		assert.equal(byTest(host, "account-signed-in-as")?.textContent, "Signed in as sam");
		assert.equal(byTest(host, "account-signed-in-as")?.textContent, signedInAs("sam"));
		const groups = (id: string) => byTest(host, id)!.textContent ?? "";
		assert.equal(groups("account-recovery"), "Recovery codes2 of 4 left.New recovery codes");
		assert.equal(groups("account-recovery"), ACCOUNT_TEXT.recoveryGroup + recoveryLeftText(2, 4) + ACCOUNT_TEXT.newRecoveryCodes);
		assert.equal(groups("account-data"), "Your dataDownload my dataYour sessions, graph and settings as one file.");
		assert.equal(byTest(host, "account-delete-open")?.textContent, "Delete my account");
		assert.deepEqual(buttons(host), ["Change password", "Sign out", "Sign out everywhere", "New recovery codes", "Delete my account"]);
		// the existing parts are still there, unchanged
		assert.ok(byTest(host, "account-password") && byTest(host, "account-devices") && byTest(host, "account-device"));
	});

	it("the owner doesn't get Delete my account", async () => {
		const host = await mount({ ...sam, name: "lee", owner: true });
		assert.equal(byTest(host, "account-signed-in-as")?.textContent, "Signed in as lee");
		assert.equal(byTest(host, "account-delete"), null);
		assert.equal(byTest(host, "account-delete-open"), null);
		assert.ok(byTest(host, "account-recovery") && byTest(host, "account-data"));
	});

	it("Download my data is a real link to the copy's export, with the name; no request is made", async () => {
		script(() => ({ body: {} }));
		const host = await mount({ ...sam, name: "sam-2" });
		const link = byTest(host, "account-download")!;
		assert.equal(link.tagName, "A");
		assert.equal(link.getAttribute("href"), "/api/account/export?name=sam-2");
		assert.ok(link.hasAttribute("download"));
		await click(link);
		assert.deepEqual(calls, [], "the browser downloads it; the page fetches nothing");
	});
});

describe("New recovery codes", () => {
	it("asks for the password in the approved box, then shows the four codes once, and the count updates", async () => {
		script((url) => (url === "/api/server-auth/recovery-codes" ? { body: { codes: CODES, recoveryCodesLeft: 4 } } : { body: {} }));
		const host = await mount(sam);
		await click(byTest(host, "account-new-recovery-codes"));
		const box = byTest(document, "account-codes-box")!;
		assert.ok(box, "a box");
		assert.equal(byTest(box, "account-codes-box-title")?.textContent, "New recovery codes?");
		assert.equal(byTest(box, "account-codes-box-body")?.textContent, "Your old codes stop working.");
		assert.equal(box.querySelector("label")?.textContent, "Password");
		assert.deepEqual(buttons(box), ["Cancel", "Make new codes"]);
		assert.equal(byTest(box, "account-codes-box-confirm")?.hasAttribute("disabled"), true, "needs a password first");
		await type(byTest(box, "account-codes-box-password"), "hunter2hunter2");
		await submit(box.querySelector("form"));
		assert.deepEqual(calls, [{ url: "/api/server-auth/recovery-codes", method: "POST", body: { password: "hunter2hunter2" } }]);
		assert.equal(byTest(document, "account-codes-box"), null, "the password box is gone");
		const shown = byTest(document, "account-new-codes-box")!;
		assert.equal(shown.querySelector("h2")?.textContent, RECOVERY_PAGE_TEXT.title);
		assert.equal(shown.querySelector("p")?.textContent, RECOVERY_PAGE_TEXT.body);
		assert.deepEqual([...byTest(shown, "account-new-codes")!.querySelectorAll("li")].map((li) => li.textContent), CODES);
		assert.deepEqual(buttons(shown), ["Copy", "Done"]);
		assert.equal(byTest(host, "account-recovery-left")?.textContent, "4 of 4 left.");
		assert.equal(reloads, 1);
		await click(byTest(shown, "account-new-codes-done"));
		assert.equal(byTest(document, "account-new-codes-box"), null);
	});

	it("Esc doesn't lose the codes: only Done closes them", async () => {
		script(() => ({ body: { codes: CODES, recoveryCodesLeft: 4 } }));
		const host = await mount(sam);
		await click(byTest(host, "account-new-recovery-codes"));
		await type(byTest(document, "account-codes-box-password"), "pw-long-enough");
		await submit(document.querySelector("[role=dialog] form"));
		const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(event, { key: "Escape" });
		await act(async () => { document.dispatchEvent(event); });
		await settle();
		assert.ok(byTest(document, "account-new-codes-box"), "still there");
	});

	it("Copy puts the codes on the clipboard", async () => {
		script(() => ({ body: { codes: CODES, recoveryCodesLeft: 4 } }));
		let copied = "";
		Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (text: string) => { copied = text; } } } });
		const host = await mount(sam);
		await click(byTest(host, "account-new-recovery-codes"));
		await type(byTest(document, "account-codes-box-password"), "pw-long-enough");
		await submit(document.querySelector("[role=dialog] form"));
		await click(byTest(document, "account-new-codes-copy"));
		assert.equal(copied, CODES.join("\n"));
	});

	it("a wrong password shows the server's words in the box and changes nothing", async () => {
		script(() => ({ status: 401, body: { error: "Your current password is wrong." } }));
		const host = await mount(sam);
		await click(byTest(host, "account-new-recovery-codes"));
		await type(byTest(document, "account-codes-box-password"), "not-it-at-all");
		await submit(document.querySelector("[role=dialog] form"));
		assert.equal(byTest(document, "account-codes-box-error")?.textContent, "Your current password is wrong.");
		assert.ok(byTest(document, "account-codes-box"), "the box stays");
		assert.equal(byTest(document, "account-new-codes-box"), null);
		assert.equal(byTest(host, "account-recovery-left")?.textContent, "2 of 4 left.");
		assert.equal(reloads, 0);
	});

	it("a refusal with no words, and a lost connection, show the app's usual lines", async () => {
		script(() => ({ status: 500, body: {} }));
		const host = await mount(sam);
		await click(byTest(host, "account-new-recovery-codes"));
		await type(byTest(document, "account-codes-box-password"), "whatever-it-is");
		await submit(document.querySelector("[role=dialog] form"));
		assert.equal(byTest(document, "account-codes-box-error")?.textContent, SIGNED_OUT_TEXT);
		script(() => "network");
		await submit(document.querySelector("[role=dialog] form"));
		assert.equal(byTest(document, "account-codes-box-error")?.textContent, "The server couldn't be reached. Check your connection and try again.");
	});

	it("Cancel closes the box and sends nothing", async () => {
		script(() => ({ body: {} }));
		const host = await mount(sam);
		await click(byTest(host, "account-new-recovery-codes"));
		await click(buttonNamed(byTest(document, "account-codes-box")!, "Cancel"));
		assert.equal(byTest(document, "account-codes-box"), null);
		assert.deepEqual(calls, []);
	});
});

describe("Delete my account", () => {
	it("asks in the approved box; with the password it deletes, clears the person's content from the browser and goes to /login", async () => {
		local.setItem("lh:notes-expanded", "[\"Physics\"]");
		local.setItem("lh:notes-open-note:chat_1", "\"Physics/Circuits.md\"");
		local.setItem("lh:side-tutor:pos", "{}");
		session.setItem("lh.openingPrompt.chat_1", "{\"text\":\"my words\"}");
		script(() => ({ body: { ok: true } }));
		const host = await mount(sam);
		await click(byTest(host, "account-delete-open"));
		const box = byTest(document, "account-delete-box")!;
		assert.equal(byTest(box, "account-delete-box-title")?.textContent, "Delete your account?");
		assert.equal(byTest(box, "account-delete-box-body")?.textContent, "Your account and everything in it are deleted now, for good. This can't be undone. Download your data first if you want to keep it.");
		assert.equal(byTest(box, "account-delete-box-title")?.textContent, ACCOUNT_TEXT.deleteBox.title);
		assert.equal(box.querySelector("label")?.textContent, "Password");
		assert.deepEqual(buttons(box), ["Cancel", "Delete my account"]);
		assert.ok(byTest(box, "account-delete-box-confirm")?.className.includes("bg-destructive"), "the red button");
		await type(byTest(box, "account-delete-box-password"), "hunter2hunter2");
		await submit(box.querySelector("form"));
		assert.deepEqual(calls, [{ url: "/api/server-auth/delete-account", method: "POST", body: { password: "hunter2hunter2" } }]);
		assert.deepEqual(replaced, ["/login"]);
		assert.deepEqual(local.keys(), ["lh:side-tutor:pos"]);
		assert.deepEqual(session.keys(), []);
	});

	it("a wrong password shows the server's words, deletes nothing, clears nothing and stays", async () => {
		local.setItem("lh:notes-expanded", "[]");
		script(() => ({ status: 401, body: { error: "Your current password is wrong." } }));
		const host = await mount(sam);
		await click(byTest(host, "account-delete-open"));
		await type(byTest(document, "account-delete-box-password"), "wrong-password");
		await submit(document.querySelector("[role=dialog] form"));
		assert.equal(byTest(document, "account-delete-box-error")?.textContent, "Your current password is wrong.");
		assert.deepEqual(replaced, []);
		assert.deepEqual(local.keys(), ["lh:notes-expanded"]);
		assert.equal(byTest(document, "account-delete-box-confirm")?.hasAttribute("disabled"), false, "it can be tried again");
	});

	it("Cancel closes the box and sends nothing", async () => {
		script(() => ({ body: {} }));
		const host = await mount(sam);
		await click(byTest(host, "account-delete-open"));
		await click(buttonNamed(byTest(document, "account-delete-box")!, "Cancel"));
		assert.equal(byTest(document, "account-delete-box"), null);
		assert.deepEqual(calls, []);
		assert.deepEqual(replaced, []);
	});
});

describe("sign-out clears the person's content, only behind the gateway", () => {
	const seed = () => {
		local.setItem("lh:notes-expanded", "[\"Physics\"]");
		local.setItem("lh:notes-open-note:chat_1", "\"Physics/Circuits.md\"");
		local.setItem("lh:notes-split-dismissed", "[]");
		local.setItem("lh:notes-width", "380");
		local.setItem("lh:side-tutor:size", "{}");
		local.setItem("lh.graph.camera.v1", "{}");
		session.setItem("lh.openingPrompt.chat_9", "{\"text\":\"unsent\"}");
	};
	const left = ["lh.graph.camera.v1", "lh:notes-width", "lh:side-tutor:size"];

	it("Sign out", async () => {
		seed();
		script(() => ({ body: { ok: true } }));
		const host = await mount(sam);
		await click(byTest(host, "account-sign-out-here"));
		assert.deepEqual(replaced, ["/login"]);
		assert.deepEqual(local.keys(), left);
		assert.deepEqual(session.keys(), []);
	});

	it("Sign out everywhere", async () => {
		seed();
		script(() => ({ body: { ok: true } }));
		const host = await mount(sam);
		await click(byTest(host, "account-sign-out"));
		await click(byTest(host, "account-sign-out-confirm"));
		assert.deepEqual(replaced, ["/login"]);
		assert.deepEqual(local.keys(), left);
		assert.deepEqual(session.keys(), []);
	});

	it("a refused sign-out clears nothing", async () => {
		seed();
		script(() => ({ status: 500, body: {} }));
		const host = await mount(sam);
		await click(byTest(host, "account-sign-out-here"));
		assert.deepEqual(replaced, []);
		assert.equal(local.length, 6);
		assert.equal(session.length, 1);
	});
});
