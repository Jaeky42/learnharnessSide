/**
 * SETTINGS → APPEARANCE ON A PHONE (fork; owner's decision at the upstream
 * v0.7.0 merge). Upstream added three rows: "Compact session list",
 * "Transcript width" and "Adapt question layout". In the phone layout only
 * "Compact session list" shows; a tablet and a computer show all three.
 * Hiding is display only: the settings keep their values and still apply.
 * The phone layout is played by a scripted matchMedia, as in
 * tests/phone-plugins-ui.test.tsx.
 */

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { DEFAULT_THEME, type AppearanceSettings } from "../src/core/index.ts";
import { AppearanceProvider, appearanceVars, resolveAppearance, useAppearance } from "../components/settings/appearance.tsx";
import { AppearanceSection } from "../components/settings/appearance-section.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";

type Layout = "desktop" | "phone" | "tablet";

async function render(layout: Layout, initial: AppearanceSettings, run: (page: Document) => Promise<void> | void) {
	const dom = parseHTML(`<!doctype html><html><body><div id="root"></div></body></html>`);
	const { document } = dom;
	// A tablet: wide, touch. A phone: narrow. A computer: neither.
	const window = Object.assign(dom.window, {
		matchMedia: (query: string) => ({
			matches: layout === "phone" ? query.includes("max-width") : layout === "tablet" ? query.includes("any-pointer: coarse") : false,
			addEventListener() {},
			removeEventListener() {},
		}),
	});
	const previous = new Map<string, PropertyDescriptor | undefined>();
	const globals = globalThis as Record<string, unknown>;
	for (const [key, value] of Object.entries({
		window, document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async () => Response.json({ themes: [DEFAULT_THEME] }),
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(document.getElementById("root")!);
	function Panel() {
		const { delta, onAppearanceChange } = useAppearance();
		return <AppearanceSection appearance={delta} onSectionChange={(next) => { onAppearanceChange(next); return true; }} />;
	}
	try {
		await act(async () => root.render(
			<InteractionLayersProvider><AppearanceProvider initialAppearance={initial} initialTheme={DEFAULT_THEME}><Panel /></AppearanceProvider></InteractionLayersProvider>,
		));
		await run(document as unknown as Document);
	} finally {
		await act(async () => root.unmount());
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globals[key];
		}
	}
}

const rows = (page: Document) => ({
	compact: page.querySelector('[data-testid="row-compact-session-list"]') !== null,
	width: page.querySelector('[data-testid="row-transcript-width"]') !== null,
	adaptive: page.querySelector('[data-testid="row-adaptive-questions"]') !== null,
});

describe("Settings → Appearance by layout", () => {
	it("a phone shows Compact session list and neither of the other two", async () => {
		await render("phone", {}, (page) => {
			assert.deepEqual(rows(page), { compact: true, width: false, adaptive: false });
			assert.ok(page.querySelector('[role="switch"][aria-label="Compact session list"]'));
			assert.equal(page.querySelector('[data-testid="input-transcript-width"]'), null);
			assert.equal(page.querySelector('[role="switch"][aria-label="Adapt question layout"]'), null);
		});
	});

	it("a computer shows all three", async () => {
		await render("desktop", {}, (page) => {
			assert.deepEqual(rows(page), { compact: true, width: true, adaptive: true });
		});
	});

	it("a tablet (the computer layout on a touch screen) shows all three", async () => {
		await render("tablet", {}, (page) => {
			assert.deepEqual(rows(page), { compact: true, width: true, adaptive: true });
		});
	});

	it("Compact session list still writes on a phone", async () => {
		await render("phone", {}, async (page) => {
			const toggle = () => page.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Compact session list"]')!;
			const before = toggle().getAttribute("aria-checked");
			await act(async () => toggle().click());
			assert.notEqual(toggle().getAttribute("aria-checked"), before);
		});
	});

	it("hiding is display only: the stored values still resolve and apply", async () => {
		const stored: AppearanceSettings = { transcriptMaxWidth: 64, adaptiveQuestions: false };
		await render("phone", stored, (page) => {
			assert.equal(rows(page).width, false);
			assert.equal(rows(page).adaptive, false);
		});
		const resolved = resolveAppearance(stored);
		assert.equal(resolved.transcriptMaxWidth, 64);
		assert.equal(resolved.adaptiveQuestions, false);
		assert.equal(appearanceVars(resolved, DEFAULT_THEME)["--lh-transcript-max"], "64rem");
	});
});
