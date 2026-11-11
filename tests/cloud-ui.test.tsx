/**
 * Settings → Cloud (cloud sync Phase 6, slice 1; docs/cloud-sync.md): the
 * desktop app's pairing form and sync state, and the server's list of
 * paired desktop apps. fetch is scripted; no server. The wording here is the
 * owner-approved wording, so a change to it is a deliberate one.
 */

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { CLOUD_SERVER_TEXT, CLOUD_TEXT, codeTimeLeft, heldByExample, recentlyText, removeConfirm, serverNotTold } from "../src/core/sync/screens.ts";

const dom = parseHTML("<html><body></body></html>");
let cookie = "";
Object.defineProperty(dom.document, "cookie", { configurable: true, get: () => cookie });
Object.defineProperty(dom.document, "visibilityState", { configurable: true, get: () => "visible" });
Object.assign(dom.document, { oninput: null });
Object.assign(dom.window, { location: { origin: "https://learn.example.com" } });
Object.assign(globalThis, { window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent });
// React decides how it hears typing when it loads, so it loads after the page exists.
const { createRoot } = await import("react-dom/client");
const { renderToStaticMarkup } = await import("react-dom/server");
const originalFetch = globalThis.fetch;
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;
const roots: { root: Root; host: HTMLElement }[] = [];

/** The components' repeating checks, run by hand instead of by the clock. */
let intervals: Array<{ run: () => void; ms: number }> = [];
beforeEach(() => {
	intervals = [];
	globalThis.setInterval = ((run: () => void, ms: number) => { const entry = { run, ms }; intervals.push(entry); return entry; }) as unknown as typeof setInterval;
	globalThis.clearInterval = ((entry: unknown) => { intervals = intervals.filter((i) => i !== entry); }) as unknown as typeof clearInterval;
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
});

const settle = () => act(async () => new Promise<void>((r) => setTimeout(r, 20)));

async function mount(node: React.ReactElement) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push({ root, host });
	await act(async () => root.render(node));
	await settle();
	return host;
}

async function tick(ms: number) {
	await act(async () => { for (const interval of intervals.filter((i) => i.ms === ms)) interval.run(); });
	await settle();
}

const click = async (el: Element | null | undefined) => {
	assert.ok(el, "the control exists");
	await act(async () => { (el as HTMLElement).click(); });
	await settle();
};
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
const byTest = (host: Element, id: string) => host.querySelector(`[data-testid='${id}']`);
const button = (host: Element, label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
const value = (host: Element, id: string) => (host.querySelector(`#${id}`) as HTMLInputElement | null)?.value;

// ─── The desktop app ─────────────────────────────────────────────────────────

type View = { role: "desktop"; paired: boolean; server: string | null; device: { id: string; name: string } | null; sync: { state: string; message: string | null; lastContactAt: number | null } };
const SERVER = "https://learn.example.com";
const off: View = { role: "desktop", paired: false, server: null, device: null, sync: { state: "off", message: null, lastContactAt: null } };
const paired = (sync: Partial<View["sync"]> = {}): View => ({
	role: "desktop", paired: true, server: SERVER, device: { id: "dev_aaaaaaaaaaaaaaaa", name: "Desktop" },
	sync: { state: "ok", message: null, lastContactAt: Date.now() - 2 * 60_000, ...sync },
});
const unpaired = (state: "unpaired" | "needs-pairing"): View => ({ ...paired({ state, lastContactAt: null }), paired: false });

/** GET /api/cloud answers `current()`; POSTs are recorded and answered by `onPost`. */
function scriptCloud(current: () => unknown, onPost: (body: Record<string, unknown>) => { status?: number; body: unknown } = () => ({ body: current() })) {
	const posts: Record<string, unknown>[] = [];
	const requests: string[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		requests.push(`${method} ${url}`);
		if (method === "GET") return url === "/api/cloud" ? Response.json(current()) : new Response("{}", { status: 404 });
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		posts.push(body);
		const reply = onPost(body);
		return Response.json(reply.body, { status: reply.status ?? 200 });
	}) as typeof fetch;
	return { posts, requests };
}

describe("Settings → Cloud on a desktop app that isn't paired", () => {
	it("shows the pairing form in the approved words, with the name filled in", async () => {
		const { requests } = scriptCloud(() => off);
		const { CloudSection } = await import("../components/settings/cloud-section.tsx");
		const host = await mount(<CloudSection />);
		const text = host.textContent ?? "";
		assert.match(text, /Cloud sync/i);
		assert.ok(text.includes("Keep this PC's sessions, graph and settings in step with your LearnHarness server."));
		assert.ok(text.includes("Server address"));
		assert.ok(text.includes("Pairing code"));
		assert.ok(text.includes("On the server's site: Settings → Cloud → Add a desktop app."));
		assert.ok(text.includes("This PC's name"));
		assert.ok(text.includes("Your other devices show it: “Held by Desktop”."));
		assert.ok(text.includes("Pairing combines this PC's sessions with the server's. Nothing is deleted, and a backup is made first."));
		assert.equal(value(host, "cloud-address"), "");
		assert.equal(value(host, "cloud-code"), "");
		assert.equal(value(host, "cloud-name"), "Desktop");
		assert.equal(byTest(host, "cloud-pair")?.textContent, "Pair");
		assert.equal(byTest(host, "cloud-pair")?.hasAttribute("disabled"), true, "nothing typed yet");
		assert.equal(byTest(host, "cloud-status"), null, "no status line on a PC that was never paired");
		assert.doesNotMatch(text, /no longer paired/);
		assert.deepEqual(requests, ["GET /api/cloud"], "one look at its own state");
		assert.deepEqual(intervals, [], "and no repeating check");
	});

	it("the line under the name box follows what is typed", async () => {
		scriptCloud(() => off);
		const { CloudSection } = await import("../components/settings/cloud-section.tsx");
		const host = await mount(<CloudSection />);
		await type(host.querySelector("#cloud-name"), "Laptop");
		assert.equal(byTest(host, "cloud-name-help")?.textContent, "Your other devices show it: “Held by Laptop”.");
		assert.equal(heldByExample("  "), "Your other devices show it: “Held by Desktop”.");
	});

	it("pairs: the three fields go to the app's own server, and the paired screen takes the form's place", async () => {
		let now: View = off;
		const { posts } = scriptCloud(() => now, (body) => { if (body.op === "pair") now = paired({ lastContactAt: Date.now() }); return { body: now }; });
		const { CloudSection } = await import("../components/settings/cloud-section.tsx");
		const { SYNC_MARKER_EVENT } = await import("../components/cloud/sync-marker.ts");
		const heard: unknown[] = [];
		const listen = (event: Event) => heard.push((event as CustomEvent).detail);
		window.addEventListener(SYNC_MARKER_EVENT, listen);
		const host = await mount(<CloudSection />);
		await type(host.querySelector("#cloud-address"), "learn.example.com");
		await type(host.querySelector("#cloud-code"), "k7qm-2xrd");
		assert.equal(byTest(host, "cloud-pair")?.hasAttribute("disabled"), false);
		await submit(byTest(host, "cloud-pair-form"));
		window.removeEventListener(SYNC_MARKER_EVENT, listen);
		assert.deepEqual(posts, [{ op: "pair", server: "learn.example.com", code: "k7qm-2xrd", name: "Desktop" }]);
		assert.equal(byTest(host, "cloud-pair-form"), null);
		assert.equal(byTest(host, "cloud-status")?.textContent, "Up to date");
		assert.equal(byTest(host, "cloud-server")?.textContent, SERVER);
		assert.equal(byTest(host, "cloud-device")?.textContent, "Desktop");
		assert.deepEqual(heard, [{ inUse: true }], "the rest of the app learns that sync is in use");
	});

	it("a refused pairing shows the server's reason in red and keeps what was typed", async () => {
		const reason = "That pairing code isn't right, or it has run out. Get a new one from the server's site.";
		scriptCloud(() => off, () => ({ status: 401, body: { error: reason } }));
		const { CloudSection } = await import("../components/settings/cloud-section.tsx");
		const host = await mount(<CloudSection />);
		await type(host.querySelector("#cloud-address"), SERVER);
		await type(host.querySelector("#cloud-code"), "AAAA-BBBB");
		await submit(byTest(host, "cloud-pair-form"));
		assert.equal(byTest(host, "cloud-error")?.textContent, reason);
		assert.equal(value(host, "cloud-address"), SERVER);
		assert.equal(value(host, "cloud-code"), "AAAA-BBBB");
		assert.equal(byTest(host, "cloud-pair")?.textContent, "Pair");
	});

	it("says so when its own server can't be asked", async () => {
		globalThis.fetch = (async () => { throw new Error("down"); }) as typeof fetch;
		const { CloudSection } = await import("../components/settings/cloud-section.tsx");
		const host = await mount(<CloudSection />);
		assert.match(host.textContent ?? "", /Cloud sync couldn’t be checked\. Try again\./);
		assert.ok(button(host, "Check again"));
	});
});

describe("Settings → Cloud on a paired desktop app", () => {
	it("shows the state, when it last synced, the server and this PC's name", async () => {
		scriptCloud(() => paired());
		const { CloudSection } = await import("../components/settings/cloud-section.tsx");
		const host = await mount(<CloudSection />);
		assert.equal(byTest(host, "cloud-status")?.textContent, "Up to date");
		assert.equal(byTest(host, "cloud-last-synced")?.textContent, "Last synced 2 minutes ago");
		assert.equal(byTest(host, "cloud-server")?.textContent, SERVER);
		assert.equal(byTest(host, "cloud-device")?.textContent, "Desktop");
		assert.ok(button(host, "Sync now"));
		assert.ok(button(host, "Unpair this PC"));
		assert.equal(byTest(host, "cloud-pair-form"), null);
		assert.deepEqual(intervals.map((i) => i.ms), [5000], "a paired PC keeps the state fresh while the section is open");
	});

	it("each state in its approved words", async () => {
		const { CloudSection } = await import("../components/settings/cloud-section.tsx");
		const cases: Array<[Partial<View["sync"]>, string]> = [
			[{ state: "starting", lastContactAt: null }, "Starting…"],
			[{ state: "offline" }, "Can't reach the server. Trying again."],
			[{ state: "paused", message: "Update the server to continue syncing" }, "Update the server to continue syncing"],
			[{ state: "paused", message: "Update LearnHarness to continue syncing" }, "Update LearnHarness to continue syncing"],
		];
		for (const [sync, words] of cases) {
			scriptCloud(() => paired(sync));
			const host = await mount(<CloudSection />);
			assert.equal(byTest(host, "cloud-status")?.textContent, words);
			assert.equal(byTest(host, "cloud-last-synced") === null, sync.lastContactAt === null, "no \"last synced\" before the first contact");
		}
	});

	it("\"last synced\" reads just now, minutes ago, then a time", async () => {
		const { lastContactText } = await import("../components/settings/cloud-section.tsx");
		const now = new Date(2026, 10, 12, 15, 0).getTime();
		assert.equal(lastContactText(now - 20_000, now), "just now");
		assert.equal(lastContactText(now - 60_000, now), "1 minute ago");
		assert.equal(lastContactText(now - 59 * 60_000, now), "59 minutes ago");
		assert.match(lastContactText(now - 3 * 3_600_000, now), /^today, /);
		assert.doesNotMatch(lastContactText(now - 3 * 24 * 3_600_000, now), /today/);
		assert.equal(recentlyText(now - 60 * 60_000, now), null);
	});

	it("follows a change of state at its next look", async () => {
		let now = paired();
		scriptCloud(() => now);
		const { CloudSection } = await import("../components/settings/cloud-section.tsx");
		const host = await mount(<CloudSection />);
		now = paired({ state: "offline" });
		await tick(5000);
		assert.equal(byTest(host, "cloud-status")?.textContent, "Can't reach the server. Trying again.");
	});

	it("Sync now runs one round and shows the state it ends in", async () => {
		const after = paired({ lastContactAt: Date.now() });
		const { posts } = scriptCloud(() => paired({ state: "offline" }), () => ({ body: { round: {}, status: after } }));
		const { CloudSection } = await import("../components/settings/cloud-section.tsx");
		const host = await mount(<CloudSection />);
		await click(byTest(host, "cloud-sync-now"));
		assert.deepEqual(posts, [{ op: "sync" }]);
		assert.equal(byTest(host, "cloud-status")?.textContent, "Up to date");
		assert.equal(byTest(host, "cloud-last-synced")?.textContent, "Last synced just now");
	});

	it("Unpair this PC asks once more, then the form is back with the address and the name", async () => {
		let now: View = paired();
		const { posts } = scriptCloud(() => now, (body) => { if (body.op === "unpair") now = unpaired("unpaired"); return { body: { status: now, told: true } }; });
		const { CloudSection } = await import("../components/settings/cloud-section.tsx");
		const { SYNC_MARKER_EVENT } = await import("../components/cloud/sync-marker.ts");
		const heard: unknown[] = [];
		const listen = (event: Event) => heard.push((event as CustomEvent).detail);
		window.addEventListener(SYNC_MARKER_EVENT, listen);
		const host = await mount(<CloudSection />);
		await click(byTest(host, "cloud-unpair"));
		assert.deepEqual(posts, [], "nothing happens before the second press");
		assert.ok((byTest(host, "cloud-unpair-confirm")?.textContent ?? "").includes("Syncing stops. Nothing on this PC is deleted, and every session can be continued here."));
		assert.ok(button(byTest(host, "cloud-unpair-confirm")!, "Cancel"));
		await click(byTest(host, "cloud-unpair-yes"));
		window.removeEventListener(SYNC_MARKER_EVENT, listen);
		assert.deepEqual(posts, [{ op: "unpair" }]);
		assert.ok(byTest(host, "cloud-pair-form"));
		assert.equal(value(host, "cloud-address"), SERVER);
		assert.equal(value(host, "cloud-name"), "Desktop");
		assert.equal(value(host, "cloud-code"), "", "only a new code is needed");
		assert.equal(byTest(host, "cloud-status"), null, "after the learner's own Unpair nothing says \"no longer paired\"");
		assert.equal(byTest(host, "cloud-notice"), null);
		assert.deepEqual(heard, [{ inUse: false }]);
		assert.deepEqual(intervals, [], "an unpaired PC stops looking");
	});

	it("Cancel leaves it paired", async () => {
		const { posts } = scriptCloud(() => paired());
		const { CloudSection } = await import("../components/settings/cloud-section.tsx");
		const host = await mount(<CloudSection />);
		await click(byTest(host, "cloud-unpair"));
		await click(button(host, "Cancel"));
		assert.deepEqual(posts, []);
		assert.ok(byTest(host, "cloud-unpair"));
	});

	it("unpaired without a connection: says the server couldn't be told", async () => {
		let now: View = paired({ state: "offline" });
		scriptCloud(() => now, () => { now = unpaired("unpaired"); return { body: { status: now, told: false } }; });
		const { CloudSection } = await import("../components/settings/cloud-section.tsx");
		const host = await mount(<CloudSection />);
		await click(byTest(host, "cloud-unpair"));
		await click(byTest(host, "cloud-unpair-yes"));
		assert.equal(byTest(host, "cloud-notice")?.textContent, "The server couldn't be told. Remove “Desktop” there too: Settings → Cloud.");
		assert.equal(serverNotTold("Laptop"), "The server couldn't be told. Remove “Laptop” there too: Settings → Cloud.");
	});
});

describe("Settings → Cloud on a PC that was paired before", () => {
	it("removed by the server: says so, and the form is ready for a new code", async () => {
		scriptCloud(() => unpaired("needs-pairing"));
		const { CloudSection } = await import("../components/settings/cloud-section.tsx");
		const host = await mount(<CloudSection />);
		assert.equal(byTest(host, "cloud-status")?.textContent, "This PC is no longer paired.");
		assert.equal(value(host, "cloud-address"), SERVER);
		assert.equal(value(host, "cloud-name"), "Desktop");
		assert.deepEqual(intervals, []);
	});

	it("pairing with the same server again says what happens to sessions continued on both sides", async () => {
		const again = "This PC was paired with this server before. Where a session was continued on both sides since, the server's version is kept and what this PC added is discarded. A backup is made first.";
		assert.equal(CLOUD_TEXT.pairingAgain, again);
		for (const state of ["unpaired", "needs-pairing"] as const) {
			scriptCloud(() => unpaired(state));
			const { CloudSection } = await import("../components/settings/cloud-section.tsx");
			const host = await mount(<CloudSection />);
			assert.equal(byTest(host, "cloud-pair-note")?.textContent, again);
			// Another server is a first pairing there.
			await type(host.querySelector("#cloud-address"), "https://other.example.org");
			assert.equal(byTest(host, "cloud-pair-note")?.textContent, CLOUD_TEXT.firstPairing);
			await type(host.querySelector("#cloud-address"), "learn.example.com/");
			assert.equal(byTest(host, "cloud-pair-note")?.textContent, again, "the same server however it is typed");
		}
	});
});

// ─── The server's site ───────────────────────────────────────────────────────

type Desktop = { id: string; name: string; pairedAt: number; online: boolean; lastSeenAt: number };
const NOW = Date.now();
const desk: Desktop = { id: "dev_aaaaaaaaaaaaaaaa", name: "Desktop", pairedAt: NOW - 3_600_000, online: true, lastSeenAt: NOW - 2000 };
const laptop: Desktop = { id: "dev_bbbbbbbbbbbbbbbb", name: "Laptop", pairedAt: NOW - 9 * 24 * 3_600_000, online: false, lastSeenAt: NOW - 3 * 24 * 3_600_000 };

function scriptServer(desktops: () => Desktop[], onPost: (body: Record<string, unknown>) => { status?: number; body: unknown } = () => ({ body: { ok: true } })) {
	const posts: Record<string, unknown>[] = [];
	const requests: string[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		requests.push(`${method} ${url}`);
		if (method === "GET") return url === "/api/cloud" ? Response.json({ role: "server", held: {}, desktops: desktops() }) : new Response("{}", { status: 404 });
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		posts.push(body);
		const reply = onPost(body);
		return Response.json(reply.body, { status: reply.status ?? 200 });
	}) as typeof fetch;
	return { posts, requests };
}

describe("Settings → Cloud on the server's site", () => {
	it("with no desktop paired: says so, and offers Add a desktop app", async () => {
		const { requests } = scriptServer(() => []);
		const { CloudServerSection } = await import("../components/settings/cloud-server-section.tsx");
		const host = await mount(<CloudServerSection />);
		assert.match(host.textContent ?? "", /Desktop apps/i);
		assert.equal(byTest(host, "cloud-no-desktops")?.textContent, "No desktop app is paired.");
		assert.equal(byTest(host, "cloud-add")?.textContent, "Add a desktop app");
		assert.equal(byTest(host, "cloud-code-box"), null);
		assert.deepEqual(requests, ["GET /api/cloud"]);
	});

	it("lists each paired PC: its name, when it was paired, and online or last seen", async () => {
		scriptServer(() => [desk, laptop]);
		const { CloudServerSection, desktopLine } = await import("../components/settings/cloud-server-section.tsx");
		const host = await mount(<CloudServerSection />);
		const rows = [...host.querySelectorAll("[data-testid='cloud-desktop']")].map((row) => row.textContent ?? "");
		assert.equal(rows.length, 2);
		assert.match(rows[0]!, /^Desktop/);
		assert.match(rows[0]!, /Paired .+ · online now/);
		assert.match(rows[1]!, /^Laptop/);
		assert.match(rows[1]!, /Paired .+ · last seen .+, \d/);
		assert.match(desktopLine({ ...laptop, lastSeenAt: NOW - 60_000 }, NOW), /last seen today, /);
		assert.equal(host.querySelectorAll("[data-testid='cloud-remove']").length, 2);
		assert.equal(byTest(host, "cloud-no-desktops"), null);
	});

	it("Add a desktop app shows the code, how long it works, and this server's address", async () => {
		let made = 0;
		const { posts } = scriptServer(() => [], () => ({ body: { code: made++ === 0 ? "K7QM-2XRD" : "PPPP-QQQQ", expiresAt: Date.now() + 9 * 60_000 + 41_000 } }));
		const { CloudServerSection } = await import("../components/settings/cloud-server-section.tsx");
		const host = await mount(<CloudServerSection />);
		await click(byTest(host, "cloud-add"));
		assert.deepEqual(posts, [{ op: "code" }]);
		const box = byTest(host, "cloud-code-box")!;
		assert.equal(byTest(box, "cloud-code")?.textContent, "K7QM-2XRD");
		assert.match(byTest(box, "cloud-code-time")?.textContent ?? "", /^Works once, for 9:4[01]$/);
		assert.equal(byTest(box, "cloud-server-address")?.textContent, "https://learn.example.com");
		assert.ok((box.textContent ?? "").includes("Pairing code"));
		assert.ok((box.textContent ?? "").includes("Server address"));
		assert.ok((box.textContent ?? "").includes("In the desktop app, open Settings → Cloud and enter both."));
		assert.equal(byTest(host, "cloud-add"), null, "the button gives way to the code");
		await click(button(box, "New code"));
		assert.equal(byTest(host, "cloud-code")?.textContent, "PPPP-QQQQ", "a new code takes the old one's place");
		await click(button(byTest(host, "cloud-code-box")!, "Done"));
		assert.equal(byTest(host, "cloud-code-box"), null);
		assert.ok(byTest(host, "cloud-add"));
	});

	it("the time a code has left, to the second", () => {
		assert.equal(codeTimeLeft(10 * 60_000, 0), "Works once, for 10:00");
		assert.equal(codeTimeLeft(10 * 60_000, 19_000), "Works once, for 9:41");
		assert.equal(codeTimeLeft(10 * 60_000, 9 * 60_000 + 55_000), "Works once, for 0:05");
		assert.equal(codeTimeLeft(10 * 60_000, 10 * 60_000), null);
	});

	it("a code that has run out says so, and a new one can be made", async () => {
		scriptServer(() => [], () => ({ body: { code: "K7QM-2XRD", expiresAt: Date.now() - 1000 } }));
		const { CloudServerSection } = await import("../components/settings/cloud-server-section.tsx");
		const host = await mount(<CloudServerSection />);
		await click(byTest(host, "cloud-add"));
		assert.equal(byTest(host, "cloud-code-gone")?.textContent, "This code has run out.");
		assert.equal(byTest(host, "cloud-code"), null);
		assert.ok(button(host, "New code"));
	});

	it("when a PC uses the code, the code box closes and the PC is in the list", async () => {
		let list: Desktop[] = [laptop];
		scriptServer(() => list, () => ({ body: { code: "K7QM-2XRD", expiresAt: Date.now() + 10 * 60_000 } }));
		const { CloudServerSection } = await import("../components/settings/cloud-server-section.tsx");
		const host = await mount(<CloudServerSection />);
		await click(byTest(host, "cloud-add"));
		await tick(3000);
		assert.ok(byTest(host, "cloud-code-box"), "nobody has used it yet");
		list = [{ ...desk, pairedAt: Date.now(), lastSeenAt: Date.now() }, laptop];
		await tick(3000);
		assert.equal(byTest(host, "cloud-code-box"), null);
		assert.equal(host.querySelectorAll("[data-testid='cloud-desktop']").length, 2);
	});

	it("the same PC pairing again with the code also closes the box", async () => {
		let list: Desktop[] = [laptop];
		scriptServer(() => list, () => ({ body: { code: "K7QM-2XRD", expiresAt: Date.now() + 10 * 60_000 } }));
		const { CloudServerSection } = await import("../components/settings/cloud-server-section.tsx");
		const host = await mount(<CloudServerSection />);
		await click(byTest(host, "cloud-add"));
		list = [{ ...laptop, pairedAt: Date.now() + 1000, online: true }];
		await tick(3000);
		assert.equal(byTest(host, "cloud-code-box"), null);
	});

	it("Remove asks once more in the approved words, then removes that PC", async () => {
		let list: Desktop[] = [desk, laptop];
		const { posts } = scriptServer(() => list, (body) => { list = list.filter((d) => d.id !== body.id); return { body: { ok: true } }; });
		const { CloudServerSection } = await import("../components/settings/cloud-server-section.tsx");
		const host = await mount(<CloudServerSection />);
		await click(host.querySelectorAll("[data-testid='cloud-remove']")[0]);
		assert.deepEqual(posts, []);
		const confirm = byTest(host, "cloud-remove-confirm")!;
		assert.ok((confirm.textContent ?? "").includes("“Desktop” stops syncing. Nothing on that PC is deleted."));
		assert.equal(removeConfirm("Laptop"), "“Laptop” stops syncing. Nothing on that PC is deleted.");
		await click(button(confirm, "Cancel"));
		assert.equal(byTest(host, "cloud-remove-confirm"), null);
		await click(host.querySelectorAll("[data-testid='cloud-remove']")[0]);
		await click(byTest(host, "cloud-remove-yes"));
		assert.deepEqual(posts, [{ op: "remove", id: desk.id }]);
		assert.deepEqual([...host.querySelectorAll("[data-testid='cloud-desktop']")].map((row) => row.querySelector("span span")?.textContent), ["Laptop"]);
	});

	it("shows the server's reason when a code can't be made", async () => {
		const reason = "This server already has 10 desktop apps paired. Remove one first.";
		scriptServer(() => [desk], () => ({ status: 409, body: { error: reason } }));
		const { CloudServerSection } = await import("../components/settings/cloud-server-section.tsx");
		const host = await mount(<CloudServerSection />);
		await click(byTest(host, "cloud-add"));
		assert.equal(byTest(host, "cloud-error")?.textContent, reason);
		assert.equal(byTest(host, "cloud-code-box"), null);
	});

	it("the wording of the server's screen", () => {
		assert.deepEqual(CLOUD_SERVER_TEXT, {
			group: "Desktop apps",
			none: "No desktop app is paired.",
			add: "Add a desktop app",
			codeLabel: "Pairing code",
			addressLabel: "Server address",
			codeHelp: "In the desktop app, open Settings → Cloud and enter both.",
			codeGone: "This code has run out.",
			newCode: "New code",
			done: "Done",
			remove: "Remove",
			cancel: "Cancel",
			onlineNow: "online now",
		});
	});
});

// ─── The Settings list ───────────────────────────────────────────────────────

describe("the Cloud row in Settings", () => {
	const navIds = (html: string) => [...html.matchAll(/data-testid="settings-nav-([^"]+)"/g)].map((m) => m[1]);

	it("the desktop app: one new row, Cloud, under General", async () => {
		const { SettingsDialogBody } = await import("../components/settings/settings-dialog.tsx");
		const html = renderToStaticMarkup(<SettingsDialogBody onClose={() => {}} />);
		// Since upstream 0.6.0 the plugin rows follow, under a divider.
		assert.deepEqual(navIds(html), ["keys", "agent", "appearance", "graph", "keyboard", "general", "cloud", "core-plugins", "plugins"]);
		assert.match(html, />Cloud<\/span><\/button>/);
	});

	it("the server's site: Cloud sits between Obsidian and Account", async () => {
		cookie = "lh_server=1";
		const { SettingsDialogBody } = await import("../components/settings/settings-dialog.tsx");
		const ids = navIds(renderToStaticMarkup(<SettingsDialogBody onClose={() => {}} />));
		assert.deepEqual(ids.slice(ids.indexOf("general")), ["general", "obsidian", "cloud", "core-plugins", "plugins"], "Account joins the list, after Cloud, once the device list has loaded");
	});

	it("the desktop app opens its own Cloud section, the server's site the list of desktop apps", async () => {
		const { SettingsDialogBody } = await import("../components/settings/settings-dialog.tsx");
		const settings = (extra: (url: string) => Response | null) => {
			globalThis.fetch = (async (input: RequestInfo | URL) => extra(String(input)) ?? Response.json({ settings: { version: 1 } })) as typeof fetch;
		};
		settings((url) => url === "/api/cloud" ? Response.json(off) : null);
		const desktop = await mount(<SettingsDialogBody onClose={() => {}} initialSection="cloud" />);
		assert.ok(byTest(desktop, "cloud-section"));
		assert.equal(byTest(desktop, "cloud-server-section"), null);
		assert.ok(byTest(desktop, "cloud-pair-form"));

		cookie = "lh_server=1";
		settings((url) => url === "/api/cloud" ? Response.json({ role: "server", held: {}, desktops: [] }) : url.startsWith("/api/server-auth") ? Response.json({ devices: [], desktops: [] }) : null);
		const server = await mount(<SettingsDialogBody onClose={() => {}} initialSection="cloud" />);
		assert.ok(byTest(server, "cloud-server-section"));
		assert.equal(byTest(server, "cloud-section"), null);
		assert.equal(byTest(server, "cloud-pair-form"), null, "the server never pairs itself");
	});
});
