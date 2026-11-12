/**
 * TABLET HOME-SCREEN APP PINS (owner's iPad): iOS blurs the top of a
 * home-screen web app, under its clock. On a tablet (the computer layout) the
 * top edges move below it, as on the iPhone: app/tablet.css, with the marker
 * body[data-lh-standalone] set by components/phone/phone-viewport.tsx at any
 * width in a browser. A Safari tab, the phone layout and the desktop app are
 * untouched.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const root = path.join(import.meta.dirname, "..");
const css = fs.readFileSync(path.join(root, "app", "tablet.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const MEDIA = "@media (any-pointer: coarse) and (min-width: 640px)";

describe("app/tablet.css", () => {
	it("every rule is for a touch screen wider than a phone, in the home-screen app in a browser", () => {
		const start = css.indexOf(MEDIA);
		assert.ok(start >= 0, MEDIA);
		const outside = css.replace(/@media \(any-pointer: coarse\) and \(min-width: 640px\)\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, "");
		assert.equal(outside.trim(), "", "nothing outside the media query");
		const selectors = [...css.matchAll(/([^{}@]+)\{[^{}]*\}/g)].map((m) => m[1]!.trim()).filter(Boolean);
		assert.ok(selectors.length >= 5);
		for (const selector of selectors) assert.match(selector, /^html:not\(\.lh-electron\) body\[data-lh-standalone\]/, selector);
	});

	it("moves the top edges by the clock strip plus 32 points, the 32 only where there is a clock strip (owner's choice)", () => {
		assert.match(css, /--lh-tablet-top:\s*calc\(env\(safe-area-inset-top, 0px\) \+ min\(32px, env\(safe-area-inset-top, 0px\) \* 100\)\);/);
		for (const part of ['[data-phone="topbar"]', '[data-phone="sidebar"] > div', '[data-phone="notes"]', '[data-phone="corner-header"]', '[data-phone="graph-chrome"]']) {
			const rule = new RegExp(`${part.replace(/[[\]">]/g, "\\$&")}\\s*\\{[^}]*var\\(--lh-tablet-top\\)`);
			assert.match(css, rule, part);
		}
		assert.match(css, /\[data-phone="topbar"\]\s*\{[^}]*height:\s*calc\(3\.75rem \+ var\(--lh-tablet-top\)\);/);
	});

	it("is loaded by the root layout", () => {
		assert.match(fs.readFileSync(path.join(root, "app", "layout.tsx"), "utf8"), /import "\.\/tablet\.css";/);
	});
});

describe("the home-screen app's marker", () => {
	it("is set in a browser's home-screen app at any width, never in a Safari tab or the desktop app", async () => {
		const { standaloneMarker } = await import("../components/phone/phone-viewport.tsx");
		assert.equal(standaloneMarker({ browser: true, standalone: true }), true, "the home-screen app, phone or tablet");
		assert.equal(standaloneMarker({ browser: true, standalone: false }), false, "a Safari tab");
		assert.equal(standaloneMarker({ browser: false, standalone: true }), false, "the desktop app");
	});

	it("isn't tied to the phone layout any more", () => {
		const src = fs.readFileSync(path.join(root, "components", "phone", "phone-viewport.tsx"), "utf8");
		// Set in its own effect, not in the phone-only one, and not cleared when the phone layout ends.
		assert.equal((src.match(/body\.dataset\.lhStandalone = ""/g) ?? []).length, 1);
		assert.match(src, /standaloneMarker\(\{ browser: isBrowserNow\(\), standalone: standaloneNow\(\) \}\)/);
	});
});
