/**
 * Cloud sync and upstream 0.6.0: on a session another device holds, the new
 * controls that would change it are greyed out like Rename and Delete
 * (owner's decision): the plugin buttons in the lesson's top bar (and its
 * overflow menu) and the highlight toolbar's buttons (Cite, Ask, …). Each
 * keeps its label and icon, has the tooltip "Take this session over first",
 * and does nothing when pressed. Without `blocked`, upstream's behaviour is
 * unchanged.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MessageCircleQuestion, Quote } from "lucide-react";
import { PluginTopBarActions } from "../components/plugin-chrome.tsx";
import { SelectionToolbarButtons, type SelectionAction } from "../components/selection-toolbar.tsx";
import type { CapturedSelection } from "../components/selection-text.ts";
import { TopBar } from "../components/top-bar.tsx";
import type { PluginActionContext } from "../src/core/plugins.ts";
import type { PluginSurfaceTarget } from "../src/core/plugin-ui.ts";
import { createPluginSessionActionContext } from "../src/core/plugin-view-context.ts";
import { HELD_TEXT } from "../src/core/sync/screens.ts";
import { mountPluginChrome } from "./helpers/plugin-chrome.tsx";

const BLOCKED = HELD_TEXT.blocked;
const surfaceTarget = Object.freeze({}) as PluginSurfaceTarget;
const session = createPluginSessionActionContext({ placement: "top-bar", surface: "session", sessionId: "session-1", kind: "teaching", surfaceTarget }, () => ({
	sessionId: "session-1", kind: "teaching", title: "Session", messages: [], transcript: [], status: "ready", reconciliation: "ready", busy: false, compacting: false, phase: "probe", contextTokens: null, queuedSteers: [], composer: { text: "" }, input: { type: "text", sessionId: "session-1", sessionKind: "teaching", surfaceTarget, channels: ["content"] },
}));

function topBar(blocked?: string) {
	return <TopBar><h1 data-plugin-chrome-title>Session</h1><div className="min-w-4 flex-1" aria-hidden="true" /><PluginTopBarActions context={session} blocked={blocked} /></TopBar>;
}

describe("plugin buttons in a held session's top bar", () => {
	it("keep their name and icon, are greyed with the tooltip, and do nothing; the overflow menu opens with its items greyed", async () => {
		const runs: PluginActionContext[] = [];
		const f = await mountPluginChrome({ activate(ctx) {
			ctx.registerAction({ id: "draw", name: "Draw", icon: '<svg viewBox="0 0 24 24"><path data-fixture-svg="true" d="M0 0h24v24H0z" /></svg>', run(value) { runs.push(value); } });
			ctx.placeAction({ id: "top", actionId: "draw", location: "top-bar", sessions: ["teaching"] });
		} }, topBar(BLOCKED));
		try {
			const button = f.document.querySelector<HTMLButtonElement>('[data-plugin-action="fixture/top"]')!;
			assert.ok(button, "the action is still shown");
			assert.equal(button.textContent, "Draw");
			assert.equal(button.getAttribute("aria-label"), "Draw");
			assert.ok(button.querySelector("[data-fixture-svg]"), "its icon stays");
			assert.equal(button.getAttribute("title"), BLOCKED);
			assert.equal(button.getAttribute("aria-disabled"), "true");
			assert.ok(button.hasAttribute("data-held"));
			assert.equal(button.disabled, false, "not natively disabled, so the tooltip shows");
			for (const name of ["aria-disabled:opacity-40", "aria-disabled:cursor-default", "aria-disabled:hover:bg-transparent"]) assert.ok(button.classList.contains(name), name);
			await f.click(button);
			assert.deepEqual(runs, [], "a press runs nothing");

			// The overflow menu: it opens (it changes nothing), and its items are greyed too.
			await f.resize(280);
			const trigger = f.document.querySelector<HTMLButtonElement>('[aria-label="More plugin actions"]')!;
			assert.ok(trigger);
			await f.click(trigger);
			const item = f.document.querySelector<HTMLButtonElement>('[data-testid="plugin-top-bar-menu"] [data-plugin-action="fixture/top"]')!;
			assert.ok(item, "the menu shows the action");
			assert.equal(item.getAttribute("role"), "menuitem");
			assert.equal(item.textContent, "Draw");
			assert.equal(item.getAttribute("title"), BLOCKED);
			assert.equal(item.getAttribute("aria-disabled"), "true");
			await f.click(item);
			assert.deepEqual(runs, []);
			assert.ok(f.document.querySelector('[data-testid="plugin-top-bar-menu"]'), "the menu stays open, as the session menu does");

			// Taken over: the same buttons work again.
			await f.resize(900);
			await f.render(topBar());
			const free = f.document.querySelector<HTMLButtonElement>('[data-plugin-action="fixture/top"]')!;
			assert.equal(free.getAttribute("title"), "Draw");
			assert.equal(free.hasAttribute("aria-disabled"), false);
			assert.equal(free.hasAttribute("data-held"), false);
			await f.click(free);
			assert.equal(runs.length, 1);
		} finally { await f.close(); }
	});
});

const capture = { messageId: "m", range: {} as Range, selector: { text: "x", start: 0, end: 1, prefix: "", suffix: "" } } satisfies CapturedSelection;

describe("the highlight toolbar on a held session", () => {
	it("Cite and Ask keep their labels and icons, are greyed with the tooltip, and a press does nothing", async () => {
		const selected: string[] = [];
		let done = 0;
		const actions: SelectionAction[] = [
			{ id: "cite", label: "Cite", ariaLabel: "Cite selection in your input", icon: Quote, visible: () => true, onSelect: () => { selected.push("cite"); return true; } },
			{ id: "side-ask", label: "Ask", ariaLabel: "Ask a side question about this selection", icon: MessageCircleQuestion, visible: () => true, onSelect: () => { selected.push("ask"); return true; } },
			{ id: "long", label: "Long", ariaLabel: "Long", icon: Quote, visible: () => true, disabledLabel: () => "Shorten selection", onSelect: () => { selected.push("long"); return true; } },
		];
		const toolbar = (blocked?: string) => <div role="toolbar"><SelectionToolbarButtons capture={capture} actions={actions} onDone={() => { done++; }} blocked={blocked} /></div>;
		const f = await mountPluginChrome({ activate() {} }, toolbar(BLOCKED));
		try {
			const buttons = [...f.document.querySelectorAll<HTMLButtonElement>('[role="toolbar"] button')];
			assert.deepEqual(buttons.map((b) => b.textContent), ["Cite", "Ask", "Shorten selection"]);
			for (const button of buttons) {
				assert.equal(button.getAttribute("title"), BLOCKED);
				assert.equal(button.getAttribute("aria-disabled"), "true");
				assert.ok(button.hasAttribute("data-held"));
				assert.equal(button.disabled, false);
				assert.ok(button.querySelector("svg"), "its icon stays");
				assert.ok(button.classList.contains("opacity-40") && button.classList.contains("cursor-default"));
				await f.click(button);
			}
			assert.deepEqual(selected, []);
			assert.equal(done, 0);

			await f.render(toolbar());
			const free = [...f.document.querySelectorAll<HTMLButtonElement>('[role="toolbar"] button')];
			assert.equal(free[0]!.hasAttribute("title"), false);
			assert.equal(free[0]!.hasAttribute("aria-disabled"), false);
			assert.equal(free[2]!.disabled, true, "upstream's own disabled state is back");
			await f.click(free[0]!);
			await f.click(free[1]!);
			assert.deepEqual(selected, ["cite", "ask"]);
			assert.equal(done, 2);
		} finally { await f.close(); }
	});
});
