/**
 * FORK (theme default, owner): a demo's or figure's Invert switch that the
 * learner never flipped follows the theme's mode (on for a dark theme, off
 * for a light one), live; a saved flip sticks on every theme.
 */
import React, { act } from "react";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { BUILTIN_THEMES, type Theme } from "../src/core/index.ts";
import { AppearanceProvider, useAppearance } from "../components/settings/appearance.tsx";
import { DemoOutputCard } from "../components/artifacts/demo-card.tsx";
import { VisualOutputCard } from "../components/artifacts/visual-card.tsx";
import { SubagentSteerCard } from "../components/artifacts/steer-card.tsx";
import { buildSubagentSteer, setSteerUiInverted } from "../src/core/contracts.ts";
import { projectView as projectNative } from "../src/core/view.ts";

(globalThis as Record<string, unknown>).React = React;

const DARK = BUILTIN_THEMES.find((t) => t.id === "catppuccin-mocha")!;
const LIGHT = BUILTIN_THEMES.find((t) => t.id === "catppuccin-latte")!;
const DEMO = { title: "Waves", html: "<!doctype html><html><body><p>demo</p></body></html>", tested: true as const };
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><circle cx="50" cy="50" r="20"/></svg>';
const FILTER = "hue-rotate";

function themed(theme: Theme, node: React.ReactNode) {
	return renderToStaticMarkup(
		<AppearanceProvider initialAppearance={{ theme: theme.id }} initialTheme={theme}>{node}</AppearanceProvider>,
	);
}

function switchChecked(html: string, kind: "demo" | "figure"): boolean {
	const at = html.indexOf(`data-testid="toggle-invert-${kind}-brightness"`);
	assert.ok(at >= 0, "the switch renders");
	const tag = html.slice(html.lastIndexOf("<", at), html.indexOf(">", at));
	return /aria-checked="true"/.test(tag);
}

describe("demos and figures follow the theme until flipped", () => {
	it("the two themes used here are one dark and one light", () => {
		assert.equal(DARK.mode, "dark");
		assert.equal(LIGHT.mode, "light");
	});

	for (const [label, render, kind] of [
		["demo", (saved?: boolean) => <DemoOutputCard output={DEMO} savedInverted={saved} />, "demo"],
		["figure", (saved?: boolean) => <VisualOutputCard output={{ svg: SVG }} savedInverted={saved} />, "figure"],
	] as const) {
		it(`${label}: never flipped → inverted on a dark theme, not on a light one`, () => {
			const dark = themed(DARK, render());
			assert.ok(dark.includes(FILTER));
			assert.equal(switchChecked(dark, kind), true);
			const light = themed(LIGHT, render());
			assert.ok(!light.includes(FILTER));
			assert.equal(switchChecked(light, kind), false);
		});

		it(`${label}: a saved choice wins over the theme, both ways`, () => {
			assert.ok(!themed(DARK, render(false)).includes(FILTER), "saved off stays light on a dark theme");
			assert.equal(switchChecked(themed(DARK, render(false)), kind), false);
			assert.ok(themed(LIGHT, render(true)).includes(FILTER), "saved on stays inverted on a light theme");
			assert.equal(switchChecked(themed(LIGHT, render(true)), kind), true);
		});
	}

	it("the steer card hands the saved value through, and nothing when never flipped", () => {
		const steer = buildSubagentSteer({ id: "j1", kind: "demo", toolCallId: "c1" }, DEMO);
		const fresh = projectNative([steer])[0] as never;
		assert.ok(themed(DARK, <SubagentSteerCard message={fresh} />).includes(FILTER));
		assert.ok(!themed(LIGHT, <SubagentSteerCard message={fresh} />).includes(FILTER));
		const [flippedOff] = setSteerUiInverted([steer] as never, steer.id, false);
		assert.ok(!themed(DARK, <SubagentSteerCard message={projectNative([flippedOff as never])[0] as never} />).includes(FILTER));

		const visual = buildSubagentSteer({ id: "j2", kind: "visual", toolCallId: "c2" }, { svg: SVG });
		assert.ok(themed(DARK, <SubagentSteerCard message={projectNative([visual])[0] as never} />).includes(FILTER));
		assert.ok(!themed(LIGHT, <SubagentSteerCard message={projectNative([visual])[0] as never} />).includes(FILTER));
	});

	it("live: a theme switch moves an unflipped card; a flip sticks through the next switch and is saved", async () => {
		const dom = parseHTML("<html><body><div id='root'></div></body></html>");
		const posts: unknown[] = [];
		const globals = {
			window: dom.window, document: dom.document, HTMLElement: dom.window.HTMLElement,
			Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true,
			ResizeObserver: class { observe() {} disconnect() {} },
			fetch: async (input: unknown, init?: RequestInit) => {
				if (String(input) === "/api/themes") return Response.json({ themes: BUILTIN_THEMES });
				posts.push(init?.body);
				return Response.json({});
			},
		};
		const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
		for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
		const { createRoot } = await import("react-dom/client");
		const container = document.getElementById("root")!;
		const root = createRoot(container);
		let live!: ReturnType<typeof useAppearance>;
		function Probe() { live = useAppearance(); return null; }
		const shown = () => {
			const holder = container.querySelector('[data-testid="visual-svg"]') as HTMLElement;
			return holder.getAttribute("style")?.includes(FILTER) ?? false;
		};
		try {
			await act(async () => root.render(
				<AppearanceProvider initialAppearance={{ theme: DARK.id }} initialTheme={DARK}>
					<Probe /><VisualOutputCard output={{ svg: SVG }} />
				</AppearanceProvider>,
			));
			assert.equal(shown(), true, "dark theme: inverted");
			await act(async () => live.onAppearanceChange({ theme: LIGHT.id }));
			assert.equal(live.resolvedMode, "light");
			assert.equal(shown(), false, "switched to light: back to light at once");
			await act(async () => (container.querySelector('[data-testid="toggle-invert-figure-brightness"]') as HTMLElement).click());
			assert.equal(shown(), true, "flipped on");
			await act(async () => live.onAppearanceChange({ theme: DARK.id }));
			await act(async () => live.onAppearanceChange({ theme: LIGHT.id }));
			assert.equal(shown(), true, "the flip sticks through theme switches");
			// No chat page here, so nothing is posted (local-only, as before).
			assert.equal(posts.length, 0);
		} finally {
			await act(async () => root.unmount());
			for (const [key, descriptor] of saved) {
				if (descriptor) Object.defineProperty(globalThis, key, descriptor);
				else delete (globalThis as Record<string, unknown>)[key];
			}
		}
	});
});
