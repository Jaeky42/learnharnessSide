/**
 * The GPT-Live trial page (voice plan, Phase 0): the page is not found outside
 * server mode, and the screen asks the server nothing by itself; the ChatGPT
 * plan check runs only from its button. fetch is scripted; no server.
 */

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.defineProperty(dom.document, "visibilityState", { configurable: true, get: () => "visible" });
Object.assign(dom.window, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
Object.assign(globalThis, { window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent });
if (!("navigator" in globalThis) || !globalThis.navigator?.userAgent) Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "test" } });
const { createRoot } = await import("react-dom/client");
const { VoiceTrial } = await import("../components/voice/voice-trial.tsx");

const originalFetch = globalThis.fetch;
const roots: { root: Root; host: HTMLElement }[] = [];
afterEach(async () => {
	for (const { root, host } of roots.splice(0)) {
		await act(async () => root.unmount());
		host.remove();
	}
	globalThis.fetch = originalFetch;
});

const settle = () => act(async () => new Promise<void>((r) => setTimeout(r, 20)));

describe("the voice trial screen", () => {
	it("asks nothing on load; the ChatGPT plan check runs once per tap", async () => {
		const calls: string[] = [];
		globalThis.fetch = (async (url: string | URL | Request) => {
			calls.push(String(url));
			return Response.json({ signedIn: true, live: [] });
		}) as typeof fetch;
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		roots.push({ root, host });
		await act(async () => root.render(<VoiceTrial />));
		await settle();
		assert.deepEqual(calls, [], "no request when the page opens");
		const button = host.querySelector("[data-testid='voice-chatgpt-check']") as HTMLElement | null;
		assert.ok(button);
		assert.equal(button.textContent?.trim(), "Check my ChatGPT plan for voice models");
		await act(async () => { button.click(); });
		await settle();
		assert.deepEqual(calls, ["/api/voice-trial/chatgpt-models"]);
		assert.match(host.querySelector("[data-testid='voice-chatgpt-result']")?.textContent ?? "", /none$/);
		await act(async () => { button.click(); });
		await settle();
		assert.equal(calls.length, 2);
	});
});

describe("the page", () => {
	it("is not found outside server mode", async () => {
		const before = process.env.LH_SERVER_MODE;
		const { default: VoiceTrialPage } = await import("../app/voice-trial/page.tsx");
		try {
			delete process.env.LH_SERVER_MODE;
			assert.throws(() => VoiceTrialPage(), (error: unknown) => String((error as { digest?: string }).digest ?? "").includes("404"));
			process.env.LH_SERVER_MODE = "1";
			const element = VoiceTrialPage();
			assert.equal(element.type, VoiceTrial);
		} finally {
			if (before === undefined) delete process.env.LH_SERVER_MODE;
			else process.env.LH_SERVER_MODE = before;
		}
	});
});
