/**
 * PLUGINS ON A PHONE (fork; components/phone/phone-plugins.ts and
 * docs/phone-plugins-plan.md). Flashcards and Rich code blocks are
 * phone-ready: Flashcards' session-list entry and page show, and Settings
 * lists Core plugins and both plugins' own pages. Every other plugin stays
 * hidden: its page reads "Open this on a computer.", its Settings page isn't
 * listed, its switch on the Core plugins page is greyed and its settings
 * button hidden. Plugin questions and problems stay parked, and the phone's
 * Enter rule holds in upstream's new text boxes. The phone layout is played
 * by a scripted matchMedia; everything else is the real components. The
 * sentences here are the owner's wording.
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
const { DISMISS_PLUGIN_QUESTION_TEXT, isPhoneReadyPlugin, PARKED_PLUGIN_PROBLEM_TEXT, PARKED_PLUGIN_QUESTION_TEXT, PHONE_READY_PLUGINS, PHONE_SIDEBAR_ENTRIES, PLUGIN_PAGE_PHONE_TEXT } = await import("../components/phone/phone-plugins.ts");
const { PhonePluginPage } = await import("../components/phone/phone-plugin-page.tsx");
const { PhonePluginProblemDock, PhonePluginQuestionDock } = await import("../components/phone/parked-plugin-question.tsx");
const { SettingsDialogBody, SettingsDialogProvider, useSettingsDialog } = await import("../components/settings/settings-dialog.tsx");
const { InteractionLayersProvider } = await import("../components/interaction-layers.tsx");
const { ServerEventsProvider } = await import("../components/server-events.tsx");
const { createPluginWindowOwner, PluginsProvider } = await import("../components/plugins.tsx");
const { PluginSidebarActions } = await import("../components/plugin-chrome.tsx");
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
/** React's own handler for an element (linkedom's click doesn't reach React here). */
const press = async (element: Element) => {
	const key = Object.keys(element).find((k) => k.startsWith("__reactProps$"))!;
	await act(async () => { (element as unknown as Record<string, { onClick(): void }>)[key]!.onClick(); });
	await settle();
};

/** The four core plugins and one community plugin, each with a settings
 *  page, through the real plugin manager. Flashcards places its session-list
 *  entry as the real plugin does. */
const CORE = [["flashcards", "Flashcards"], ["rich-code-blocks", "Rich code blocks"], ["drawing-pad", "Drawing Pad"], ["coding-questions", "Coding questions"]] as const;
function info(id: string, name: string, origin: "core" | "community", enabled: boolean): PluginInfo {
	return { id, origin, enabled, status: enabled ? "active" : "disabled", revision: "one", manifest: { apiVersion: 1, id, name, version: "1.0.0", minAppVersion: "0.3.7", main: "main.js" } };
}
/** The requests the manager sent to switch a plugin on or off. */
let switched: string[] = [];
function withPlugins(children: React.ReactNode, off: string[] = []) {
	const settings = (label: string): PluginFrontendModule => ({ activate(ctx) { ctx.registerSettings({ rows: [{ key: "on", label, type: "toggle", value: false, onChange() {} }] }); } });
	const modules: Record<string, PluginFrontendModule> = {
		flashcards: { activate(ctx) {
			ctx.registerSettings({ rows: [{ key: "on", label: "Flashcards preference", type: "toggle", value: false, onChange() {} }] });
			ctx.registerAction({ id: "open", name: "Flashcards", run() {} });
			ctx.placeAction({ id: "open-sidebar", actionId: "open", location: "sidebar" });
		} },
		"rich-code-blocks": settings("Rich code blocks preference"),
		"drawing-pad": settings("Drawing Pad preference"),
		"coding-questions": settings("Coding questions preference"),
		fixture: settings("Fixture preference"),
	};
	const infos = [...CORE.map(([id, name]) => info(id, name, "core", !off.includes(id))), info("fixture", "Plugin fixture", "community", true)];
	switched = [];
	window.__lhPluginWindow = createPluginWindowOwner({
		fetch: async (url, init) => {
			if (init?.method === "PUT") switched.push(String(url));
			return Response.json({ plugins: infos, directory: "/fixtures/plugins", conflicts: [] });
		},
		importModule: async (url) => modules[decodeURIComponent(url.split("/")[3]!)]!,
		pathname: () => "/", navigate() {},
	});
	const router = { bfcacheId: "fixture", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, async prefetch() {} };
	const connect = () => ({ close() {}, onOpen() {}, onEvent() {} });
	return <InteractionLayersProvider><AppRouterContext.Provider value={router}><ServerEventsProvider connect={connect}><PluginsProvider>{children}</PluginsProvider></ServerEventsProvider></AppRouterContext.Provider></InteractionLayersProvider>;
}

describe("the phone-ready plugins", () => {
	it("are Flashcards and Rich code blocks, and only Flashcards' session-list entry shows", () => {
		assert.deepEqual(PHONE_READY_PLUGINS, ["flashcards", "rich-code-blocks"]);
		assert.equal(isPhoneReadyPlugin("flashcards"), true);
		assert.equal(isPhoneReadyPlugin("rich-code-blocks"), true);
		for (const other of ["drawing-pad", "coding-questions", "ui-showcase", "fixture"]) assert.equal(isPhoneReadyPlugin(other), false, other);
		assert.deepEqual(PHONE_SIDEBAR_ENTRIES, ["flashcards/open-sidebar"]);
	});

	it("Flashcards' session-list entry carries the key app/phone.css keeps", async () => {
		await mount(withPlugins(<PluginSidebarActions><button type="button" data-testid="new-session">Teaching</button></PluginSidebarActions>));
		const keys = [...document.querySelectorAll('[data-testid="sidebar-actions"] > [data-plugin-action]')].map((b) => b.getAttribute("data-plugin-action"));
		assert.deepEqual(keys, ["flashcards/open-sidebar"]);
	});
});

describe("Settings on a phone", () => {
	it("the computer keeps every plugin row and their dividers", async () => {
		await mount(withPlugins(<SettingsDialogBody onClose={() => {}} />));
		assert.deepEqual(navIds(), ["keys", "agent", "appearance", "graph", "keyboard", "general", "cloud", "core-plugins", "plugins",
			"plugin:flashcards", "plugin:rich-code-blocks", "plugin:drawing-pad", "plugin:coding-questions", "plugin:fixture"]);
		assert.equal(document.querySelectorAll('[data-testid="settings-nav"] > hr').length, 2);
	});

	it("a phone lists Core plugins, then Flashcards and Rich code blocks, after the app's own rows; no Community plugins row, no other plugin's page, no divider", async () => {
		layout = "touch";
		await mount(withPlugins(<SettingsDialogBody onClose={() => {}} />));
		assert.deepEqual(navIds(), ["keys", "agent", "appearance", "graph", "general", "cloud", "core-plugins", "plugin:flashcards", "plugin:rich-code-blocks"]);
		assert.equal(document.querySelectorAll('[data-testid="settings-nav"] > hr').length, 0);
		assert.equal(document.querySelector('[data-phone="settings"]')?.getAttribute("data-phone-screen"), "list");
		// Each row is the label in a span; app/phone.css hides the icon.
		assert.deepEqual(["keys", "core-plugins", "plugin:flashcards", "plugin:rich-code-blocks"].map((id) => document.querySelector(`[data-testid="settings-nav-${id}"] > span`)?.textContent),
			["Providers", "Core plugins", "Flashcards", "Rich code blocks"]);
	});

	it("a phone-ready plugin's row shows only while that plugin is on", async () => {
		layout = "touch";
		await mount(withPlugins(<SettingsDialogBody onClose={() => {}} />, ["flashcards"]));
		assert.deepEqual(navIds(), ["keys", "agent", "appearance", "graph", "general", "cloud", "core-plugins", "plugin:rich-code-blocks"]);
	});

	it("a link to a listed section opens it; a link to any other plugin section lands on the list", async () => {
		layout = "touch";
		let settings!: ReturnType<typeof useSettingsDialog>;
		function Probe() { settings = useSettingsDialog(); return null; }
		await mount(withPlugins(<SettingsDialogProvider><Probe /></SettingsDialogProvider>));
		const close = async () => {
			await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="settings-close"]')!.click());
			await settle();
		};
		for (const section of ["plugin:drawing-pad", "plugin:coding-questions", "plugin:fixture", "plugins"]) {
			await act(async () => settings.open(section));
			await settle();
			assert.equal(document.querySelector('[data-phone="settings"]')?.getAttribute("data-phone-screen"), "list", section);
			assert.equal(document.querySelector('[data-testid="settings-nav-keys"]')?.getAttribute("aria-current"), "true", section);
			assert.doesNotMatch(document.querySelector('[data-testid="settings-content"]')?.textContent ?? "", /preference|Community plugins/, `${section}: no plugin page behind the list`);
			await close();
		}
		for (const [section, text] of [["core-plugins", "Core plugins"], ["plugin:flashcards", "Flashcards preference"], ["plugin:rich-code-blocks", "Rich code blocks preference"]] as const) {
			await act(async () => settings.open(section));
			await settle();
			assert.equal(document.querySelector('[data-phone="settings"]')?.getAttribute("data-phone-screen"), "section", section);
			assert.equal(document.querySelector(`[data-testid="settings-nav-${section}"]`)?.getAttribute("aria-current"), "true", section);
			assert.match(document.querySelector('[data-testid="settings-content"]')?.textContent ?? "", new RegExp(text), section);
			await close();
		}
		// The app's own sections still open, as before.
		await act(async () => settings.open("appearance"));
		await settle();
		assert.equal(document.querySelector('[data-phone="settings"]')?.getAttribute("data-phone-screen"), "section");
	});

	it("on a computer every plugin link still opens the plugin's page", async () => {
		let settings!: ReturnType<typeof useSettingsDialog>;
		function Probe() { settings = useSettingsDialog(); return null; }
		await mount(withPlugins(<SettingsDialogProvider><Probe /></SettingsDialogProvider>));
		for (const id of ["drawing-pad", "fixture", "flashcards"]) {
			await act(async () => settings.open(`plugin:${id}`));
			await settle();
			assert.equal(document.querySelector(`[data-testid="settings-nav-plugin:${id}"]`)?.getAttribute("aria-current"), "true", id);
		}
	});
});

describe("Core plugins on a phone", () => {
	const row = (id: string) => document.querySelector(`[data-testid="plugin-${id}"]`)!;
	const toggle = (id: string) => row(id).querySelector('[role="switch"]')!;
	const gear = (id: string) => row(id).querySelector('[data-phone="plugin-settings-link"]');
	async function openCorePlugins(off: string[] = []) {
		await mount(withPlugins(<SettingsDialogBody onClose={() => {}} initialSection="core-plugins" phoneOpensSection />, off));
		return document.querySelector('[data-testid="section-core-plugins"]')!;
	}

	it("Coding questions and Drawing Pad: greyed switches that show on or off and can't be changed, and no settings button", async () => {
		layout = "touch";
		await openCorePlugins(["coding-questions"]);
		for (const [id, on] of [["drawing-pad", "true"], ["coding-questions", "false"]] as const) {
			assert.equal(toggle(id).hasAttribute("disabled"), true, id);
			assert.equal(toggle(id).getAttribute("aria-checked"), on, `${id} still shows whether it is on`);
			assert.equal(toggle(id).parentElement?.getAttribute("data-phone"), "plugin-locked", `${id} is greyed (app/phone.css)`);
			assert.equal(gear(id), null, `${id} has no settings button`);
			await press(toggle(id));
			assert.equal(toggle(id).getAttribute("aria-checked"), on, `${id} is unchanged`);
		}
		assert.deepEqual(switched, [], "nothing was switched");
	});

	it("Flashcards and Rich code blocks: working switches and settings buttons", async () => {
		layout = "touch";
		await openCorePlugins();
		for (const id of ["flashcards", "rich-code-blocks"]) {
			assert.equal(toggle(id).hasAttribute("disabled"), false, id);
			assert.notEqual(toggle(id).parentElement?.getAttribute("data-phone"), "plugin-locked", id);
			assert.ok(gear(id), `${id} has its settings button`);
		}
		await press(gear("flashcards")!);
		assert.equal(document.querySelector('[data-testid="settings-nav-plugin:flashcards"]')?.getAttribute("aria-current"), "true");
		assert.match(document.querySelector('[data-testid="settings-content"]')?.textContent ?? "", /Flashcards preference/);
	});

	it("a phone-ready switch still works on a phone", async () => {
		layout = "touch";
		await openCorePlugins();
		await press(toggle("rich-code-blocks"));
		assert.deepEqual(switched, ["/api/plugins/rich-code-blocks"]);
	});

	it("says nothing more than on a computer: no explaining text", async () => {
		const computer = (await openCorePlugins()).textContent;
		for (const { root, host } of roots.splice(0)) { await act(async () => root.unmount()); host.remove(); }
		layout = "touch";
		assert.equal((await openCorePlugins()).textContent, computer);
	});

	it("on a computer every switch works and every plugin that is on has its settings button", async () => {
		await openCorePlugins();
		for (const [id] of CORE) {
			assert.equal(toggle(id).hasAttribute("disabled"), false, id);
			assert.ok(gear(id), id);
		}
		assert.equal(document.querySelectorAll('[data-phone="plugin-locked"]').length, 0);
	});
});

describe("a plugin page opened on a phone", () => {
	const view = <div data-testid="the-plugin-view">plugin</div>;
	it("another plugin's page shows only the sentence, under a top bar with nothing but the session-list button", async () => {
		layout = "phone";
		const host = await mount(<PhonePluginPage pluginId="drawing-pad">{view}</PhonePluginPage>);
		assert.equal(host.querySelector('[data-testid="the-plugin-view"]'), null);
		assert.equal(host.querySelector('[data-testid="plugin-page-phone"] > p')?.textContent, "Open this on a computer.");
		assert.equal(PLUGIN_PAGE_PHONE_TEXT, "Open this on a computer.");
		const bar = host.querySelector('[data-phone="topbar"]');
		assert.ok(bar);
		assert.deepEqual([...bar.querySelectorAll("button")].map((b) => b.getAttribute("aria-label")), ["Open sidebar"]);
	});
	it("Flashcards' page and Rich code blocks' pages render on a phone", async () => {
		layout = "phone";
		for (const id of ["flashcards", "rich-code-blocks"]) {
			const host = await mount(<PhonePluginPage pluginId={id}>{view}</PhonePluginPage>);
			assert.ok(host.querySelector('[data-testid="the-plugin-view"]'), id);
			assert.equal(host.querySelector('[data-testid="plugin-page-phone"]'), null, id);
		}
	});
	it("is the plugin's page on a computer, and in the server's first render", async () => {
		assert.match(renderToStaticMarkup(<PhonePluginPage pluginId="drawing-pad">{view}</PhonePluginPage>), /the-plugin-view/);
		const host = await mount(<PhonePluginPage pluginId="drawing-pad">{view}</PhonePluginPage>);
		assert.ok(host.querySelector('[data-testid="the-plugin-view"]'));
		assert.equal(host.querySelector('[data-testid="plugin-page-phone"]'), null);
	});
	it("is wired into the plugin route, with the route's plugin id", async () => {
		const { readFileSync } = await import("node:fs");
		const page = readFileSync(new URL("../app/plugins/[pluginId]/[viewId]/page.tsx", import.meta.url), "utf8");
		assert.match(page, /<PhonePluginPage pluginId=\{pluginId\}><PluginViewScreen /);
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
	/** React's own handler for the button (linkedom's click doesn't reach React here). */
	const press = async (button: Element) => {
		const key = Object.keys(button).find((k) => k.startsWith("__reactProps$"))!;
		await act(async () => { (button as unknown as Record<string, { onClick(): void }>)[key]!.onClick(); });
		await settle();
	};

	it("shows the sentence in place of the question box, with upstream's way to dismiss it", async () => {
		layout = "touch";
		calls.length = 0;
		const host = await mount(<PhonePluginQuestionDock {...props} />);
		assert.equal(host.querySelector('[data-testid="plugin-question-parked"] [role="status"]')?.textContent,
			"This question needs a bigger screen. Open this session on a computer to answer it.");
		assert.equal(PARKED_PLUGIN_QUESTION_TEXT, "This question needs a bigger screen. Open this session on a computer to answer it.");
		assert.equal(host.querySelector('[data-testid="plugin-question-dock"]'), null, "the plugin's box isn't mounted");
		const button = host.querySelector('[data-testid="plugin-question-parked-dismiss"]')!;
		assert.equal(button.textContent, "Dismiss question");
		assert.equal(DISMISS_PLUGIN_QUESTION_TEXT, "Dismiss question");
		assert.equal(button.hasAttribute("disabled"), false);
		assert.deepEqual(calls, [], "nothing is answered, dismissed or sent by parking");

		await press(button);
		assert.deepEqual(calls, ["dismiss"], "the button is upstream's dismissal, once");
	});

	it("the button waits until the session is ready, as upstream's does", async () => {
		layout = "touch";
		calls.length = 0;
		const host = await mount(<PhonePluginQuestionDock {...props} ready={false} />);
		assert.equal(host.querySelector('[data-testid="plugin-question-parked-dismiss"]')!.hasAttribute("disabled"), true);
		assert.deepEqual(calls, []);
	});

	it("is upstream's question dock on a computer", () => {
		const html = renderToStaticMarkup(<PhonePluginQuestionDock {...props} />);
		assert.match(html, /data-testid="plugin-question-dock"/);
		assert.doesNotMatch(html, /plugin-question-parked/);
	});
});

describe("a plugin's practice problem on a phone is parked", () => {
	const calls: string[] = [];
	const props = {
		snapshot: { protocolVersion: 1, pluginId: "fixture", typeId: "code", label: "Code", problemId: "p1", contractVersion: 1, input: { statement: "Write a loop." } } as unknown as import("../src/core/index.ts").PluginProblemSnapshot,
		occurrence: { messageId: "a", contentIndex: 0, toolCallId: "call", toolName: "code" } as unknown as import("../src/core/index.ts").PluginSubmissionOccurrence,
		chatId: "chat", draft: { submission: { status: "empty" as const }, thinking: "" } as unknown as import("../components/session-core.ts").PluginProblemDraft,
		expanded: true, onExpand: () => calls.push("expand"), ready: true, available: true, reconciliation: "ready" as const,
		send: async () => { calls.push("send"); return true; },
	};

	it("shows the sentence and nothing else: no editor, no button", async () => {
		layout = "touch";
		calls.length = 0;
		const host = await mount(<PhonePluginProblemDock {...props} />);
		assert.equal(host.querySelector('[data-testid="plugin-problem-parked"] [role="status"]')?.textContent,
			"This problem needs a bigger screen. Open this session on a computer to answer it.");
		assert.equal(PARKED_PLUGIN_PROBLEM_TEXT, "This problem needs a bigger screen. Open this session on a computer to answer it.");
		assert.equal(host.querySelectorAll("button, textarea, input").length, 0);
		assert.deepEqual(calls, [], "nothing is submitted or changed by parking");
	});

	it("is upstream's problem dock on a computer", async () => {
		const host = await mount(withPlugins(<PhonePluginProblemDock {...props} />));
		assert.equal(host.querySelector('[data-testid="plugin-problem-parked"]'), null);
		assert.ok(host.innerHTML.length > 0, "upstream's dock rendered");
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
