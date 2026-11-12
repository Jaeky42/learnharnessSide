/**
 * PLUGINS ON A PHONE (fork, upstream 0.6.0 merge; components/phone/phone-plugins.ts).
 * The owner's decision "Hide the ways in, park plugin questions", and the
 * phone's Enter rule on upstream's new text boxes. The phone layout is
 * played by a scripted matchMedia; everything else is the real components.
 * The sentences here are the owner's wording.
 */

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { installModalDom } from "./modal-dom.ts";
import type { PluginFrontendModule, PluginInfo } from "../src/core/index.ts";
import type { PluginQuestionSnapshot } from "../src/core/plugin-questions.ts";

const dom = parseHTML("<!doctype html><html><head></head><body></body></html>");
Object.defineProperty(dom.document, "oninput", { configurable: true, value: null });
/** "desktop": no query matches; "phone": narrow, mouse; "touch": narrow, finger. */
let layout: "desktop" | "phone" | "touch" = "desktop";
Object.assign(dom.window, {
	matchMedia: (query: string) => ({
		matches: layout !== "desktop" && (query.includes("max-width") || (query.includes("pointer: coarse") && layout === "touch")),
		addEventListener() {}, removeEventListener() {},
	}),
	// React reads the selection on key events.
	getSelection: () => ({ anchorNode: null, focusNode: null, anchorOffset: 0, focusOffset: 0, rangeCount: 0 }),
});
Object.assign(globalThis, {
	window: dom.window, self: dom.window, document: dom.document,
	HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true,
});
const restoreModalDom = installModalDom(dom);
const { createRoot } = await import("react-dom/client");
const { renderToStaticMarkup } = await import("react-dom/server");
const { PARKED_PLUGIN_QUESTION_TEXT, PLUGIN_PAGE_PHONE_TEXT } = await import("../components/phone/phone-plugins.ts");
const { PhonePluginPage } = await import("../components/phone/phone-plugin-page.tsx");
const { PhonePluginQuestionDock } = await import("../components/phone/parked-plugin-question.tsx");
const { SettingsDialogBody, SettingsDialogProvider, useSettingsDialog } = await import("../components/settings/settings-dialog.tsx");
const { InteractionLayersProvider } = await import("../components/interaction-layers.tsx");
const { ServerEventsProvider } = await import("../components/server-events.tsx");
const { createPluginWindowOwner, PluginsProvider } = await import("../components/plugins.tsx");
const { CitationCommentEditor } = await import("../components/citation-comment-editor.tsx");
const { useEnterSubmits } = await import("../components/enter-submits.ts");
const { capturePluginQuestionKey, ownPluginQuestionKeys } = await import("../components/plugin-question-keys.ts");

const originalFetch = globalThis.fetch;
const roots: { root: import("react-dom/client").Root; host: HTMLElement }[] = [];
beforeEach(() => {
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url === "/api/settings") return Response.json({ settings: { version: 1 } });
		if (url === "/api/keys") return Response.json({ keys: [] });
		if (url === "/api/models") return Response.json({ models: [], slots: {}, providers: [] });
		if (url === "/api/themes") return Response.json({ themes: [] });
		if (url === "/api/cloud") return Response.json({ role: "desktop", sync: { state: "off" } });
		return Response.json({});
	}) as typeof fetch;
});
afterEach(async () => {
	for (const { root, host } of roots.splice(0)) {
		await act(async () => root.unmount());
		host.remove();
	}
	globalThis.fetch = originalFetch;
	layout = "desktop";
	delete (window as { __lhPluginWindow?: unknown }).__lhPluginWindow;
});
process.on("exit", restoreModalDom);

const settle = () => act(async () => new Promise<void>((r) => setTimeout(r, 20)));
async function mount(node: React.ReactNode) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push({ root, host });
	await act(async () => root.render(node));
	await settle();
	return host;
}
const navIds = () => [...document.querySelectorAll('[data-testid="settings-nav"] > button')].map((b) => b.getAttribute("data-testid")!.slice("settings-nav-".length));

/** One enabled community plugin with a settings page, through the real plugin manager. */
function info(id: string): PluginInfo {
	return { id, origin: "community", enabled: true, status: "active", revision: "one", manifest: { apiVersion: 1, id, name: `Plugin ${id}`, version: "1.0.0", minAppVersion: "0.3.7", main: "main.js" } };
}
function withPlugins(children: React.ReactNode) {
	const modules: Record<string, PluginFrontendModule> = {
		fixture: { activate(ctx) { ctx.registerSettings({ rows: [{ key: "on", label: "Fixture preference", type: "toggle", value: false, onChange() {} }] }); } },
	};
	window.__lhPluginWindow = createPluginWindowOwner({
		fetch: async () => Response.json({ plugins: [info("fixture")], directory: "/fixtures/plugins", conflicts: [] }),
		importModule: async (url) => modules[decodeURIComponent(url.split("/")[3]!)]!,
		pathname: () => "/", navigate() {},
	});
	const router = { bfcacheId: "fixture", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, async prefetch() {} };
	const connect = () => ({ close() {}, onOpen() {}, onEvent() {} });
	return <InteractionLayersProvider><AppRouterContext.Provider value={router}><ServerEventsProvider connect={connect}><PluginsProvider>{children}</PluginsProvider></ServerEventsProvider></AppRouterContext.Provider></InteractionLayersProvider>;
}

describe("Settings on a phone has no plugin rows", () => {
	it("the computer keeps the plugin rows and their dividers", async () => {
		await mount(withPlugins(<SettingsDialogBody onClose={() => {}} />));
		assert.deepEqual(navIds(), ["keys", "agent", "appearance", "graph", "keyboard", "general", "cloud", "core-plugins", "plugins", "plugin:fixture"]);
		assert.equal(document.querySelectorAll('[data-testid="settings-nav"] > hr').length, 2);
	});

	it("a phone lists only the app's own rows, with no divider and no Keyboard row", async () => {
		layout = "touch";
		await mount(withPlugins(<SettingsDialogBody onClose={() => {}} />));
		assert.deepEqual(navIds(), ["keys", "agent", "appearance", "graph", "general", "cloud"]);
		assert.equal(document.querySelectorAll('[data-testid="settings-nav"] > hr').length, 0);
		assert.equal(document.querySelector('[data-phone="settings"]')?.getAttribute("data-phone-screen"), "list");
		// Each row is the label in a span; app/phone.css hides the icon, so it reads as before the merge.
		assert.equal(document.querySelector('[data-testid="settings-nav-keys"] > span')?.textContent, "Providers");
	});

	it("a link to a plugin section opens Settings on the list instead", async () => {
		layout = "touch";
		let settings!: ReturnType<typeof useSettingsDialog>;
		function Probe() { settings = useSettingsDialog(); return null; }
		await mount(withPlugins(<SettingsDialogProvider><Probe /></SettingsDialogProvider>));
		for (const section of ["plugin:fixture", "core-plugins", "plugins"]) {
			await act(async () => settings.open(section));
			await settle();
			const frame = document.querySelector('[data-phone="settings"]');
			assert.equal(frame?.getAttribute("data-phone-screen"), "list", section);
			assert.equal(document.querySelector('[data-testid="settings-nav-keys"]')?.getAttribute("aria-current"), "true", section);
			assert.equal(document.querySelector('[data-testid="settings-content"]')?.textContent?.includes("Fixture preference"), false, `${section}: no plugin page behind the list`);
			await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="settings-close"]')!.click());
			await settle();
		}
		// Other links still open their section, as before.
		await act(async () => settings.open("appearance"));
		await settle();
		assert.equal(document.querySelector('[data-phone="settings"]')?.getAttribute("data-phone-screen"), "section");
	});

	it("on a computer the same link still opens the plugin's page", async () => {
		let settings!: ReturnType<typeof useSettingsDialog>;
		function Probe() { settings = useSettingsDialog(); return null; }
		await mount(withPlugins(<SettingsDialogProvider><Probe /></SettingsDialogProvider>));
		await act(async () => settings.open("plugin:fixture"));
		await settle();
		assert.equal(document.querySelector('[data-testid="settings-nav-plugin:fixture"]')?.getAttribute("aria-current"), "true");
	});
});

describe("a plugin page opened on a phone", () => {
	const view = <div data-testid="the-plugin-view">plugin</div>;
	it("shows only the sentence, under a top bar with nothing but the session-list button", async () => {
		layout = "phone";
		const host = await mount(<PhonePluginPage>{view}</PhonePluginPage>);
		assert.equal(host.querySelector('[data-testid="the-plugin-view"]'), null);
		assert.equal(host.querySelector('[data-testid="plugin-page-phone"] > p')?.textContent, "Open this on a computer.");
		assert.equal(PLUGIN_PAGE_PHONE_TEXT, "Open this on a computer.");
		const bar = host.querySelector('[data-phone="topbar"]');
		assert.ok(bar);
		assert.deepEqual([...bar.querySelectorAll("button")].map((b) => b.getAttribute("aria-label")), ["Open sidebar"]);
	});
	it("is the plugin's page on a computer, and in the server's first render", async () => {
		assert.match(renderToStaticMarkup(<PhonePluginPage>{view}</PhonePluginPage>), /the-plugin-view/);
		const host = await mount(<PhonePluginPage>{view}</PhonePluginPage>);
		assert.ok(host.querySelector('[data-testid="the-plugin-view"]'));
		assert.equal(host.querySelector('[data-testid="plugin-page-phone"]'), null);
	});
	it("is wired into the plugin route", async () => {
		const { readFileSync } = await import("node:fs");
		const page = readFileSync(new URL("../app/plugins/[pluginId]/[viewId]/page.tsx", import.meta.url), "utf8");
		assert.match(page, /<PhonePluginPage><PluginViewScreen /);
	});
});

describe("a plugin question on a phone is parked", () => {
	const snapshot: PluginQuestionSnapshot = { protocolVersion: 1, pluginId: "fixture", typeId: "code", label: "Code", variant: "probe", questionId: "q1", contractVersion: 1, occurrence: { messageId: "a", contentIndex: 0, toolCallId: "call", toolName: "code" }, input: { question: "Public question", payload: {} }, questionSchema: { type: "object" }, answerSchema: { type: "string" }, showThinking: false, requiresAnswerRefinement: false };
	const calls: string[] = [];
	const props = {
		snapshot, chatId: "chat", draft: { answer: { status: "empty" as const }, thinking: "", readingThinking: "" }, expanded: true, reveal: false, onExpand: () => calls.push("expand"),
		ready: true, reconciliation: "ready" as const, available: true, readingRef: { current: null },
		onMicAvailable: (on: boolean) => calls.push(`mic:${on}`), send: async () => { calls.push("send"); return true; }, dismiss: async () => { calls.push("dismiss"); },
	};
	const composer = <div data-testid="composer">message box</div>;

	it("shows the sentence in place of the question box, and the message box under it", async () => {
		layout = "touch";
		calls.length = 0;
		const host = await mount(<PhonePluginQuestionDock {...props} composer={composer} />);
		assert.equal(host.querySelector('[data-testid="plugin-question-parked"] [role="status"]')?.textContent,
			"This question needs a bigger screen. Open this session on a computer to answer it.");
		assert.equal(PARKED_PLUGIN_QUESTION_TEXT, "This question needs a bigger screen. Open this session on a computer to answer it.");
		assert.ok(host.querySelector('[data-testid="composer"]'), "the message box stays");
		assert.equal(host.querySelector('[data-testid="plugin-question-dock"]'), null, "the plugin's box isn't mounted");
		assert.deepEqual(calls, [], "nothing is answered, dismissed or sent by parking");
	});

	it("is upstream's question dock on a computer, without the extra message box", () => {
		const html = renderToStaticMarkup(<PhonePluginQuestionDock {...props} composer={composer} />);
		assert.match(html, /data-testid="plugin-question-dock"/);
		assert.doesNotMatch(html, /plugin-question-parked|data-testid="composer"/);
	});
});

describe("Enter on a touch phone makes a new line in upstream's new boxes", () => {
	const enter = (target: EventTarget, extra: Partial<KeyboardEventInit> = {}) => {
		const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(event, { key: "Enter", shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, keyCode: 13, ...extra });
		target.dispatchEvent(event);
		return event;
	};

	it("the citation comment: Enter saves on a computer; on a touch phone it is a new line, ⌘/Ctrl+Enter still saves and sends", async () => {
		const saves: [string, boolean][] = [];
		const editor = <CitationCommentEditor initial="note" onDraftChange={() => {}} onSave={(c, send) => saves.push([c, send])} onCancel={() => {}} />;
		let host = await mount(editor);
		await act(async () => { enter(host.querySelector("textarea")!); });
		assert.deepEqual(saves, [["note", false]]);

		layout = "touch";
		host = await mount(editor);
		let event!: Event;
		await act(async () => { event = enter(host.querySelector("textarea")!); });
		assert.equal(event.defaultPrevented, false, "the textarea takes the new line");
		assert.deepEqual(saves, [["note", false]]);
		await act(async () => { enter(host.querySelector("textarea")!, { ctrlKey: true }); });
		assert.deepEqual(saves, [["note", false], ["note", true]]);
	});

	it("Enter from anywhere (enter-submits.ts) submits on a computer, not on a touch phone", async () => {
		let submits = 0;
		function Dock() { useEnterSubmits(() => { submits++; }); return <div />; }
		await mount(<Dock />);
		await act(async () => { enter(document.body); });
		assert.equal(submits, 1);
		layout = "touch";
		await act(async () => { enter(document.body); });
		assert.equal(submits, 1);
	});

	it("inside a plugin's answer editor, Enter is the host's submit on a computer and the editor's own on a touch phone", () => {
		const editor = document.createElement("textarea");
		document.body.appendChild(editor);
		let submits = 0;
		const off = ownPluginQuestionKeys({ eligible: () => true, contains: (t) => t === editor, key: () => "pass", submit: () => { submits++; }, cycle() {} });
		try {
			const press = () => { const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true }); Object.assign(event, { key: "Enter", target: editor }); Object.defineProperty(event, "target", { value: editor }); capturePluginQuestionKey(event as unknown as KeyboardEvent); return event; };
			assert.equal(press().defaultPrevented, true);
			assert.equal(submits, 1);
			layout = "touch";
			assert.equal(press().defaultPrevented, false, "the new line is the editor's");
			assert.equal(submits, 1);
		} finally {
			off();
			editor.remove();
		}
	});
});
