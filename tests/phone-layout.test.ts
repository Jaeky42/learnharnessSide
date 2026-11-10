/**
 * PHONE LAYOUT PINS (cloud sync Phase 3): the desktop can never get phone
 * styling, and the small rules the phone layout runs on.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { isPhoneViewport, PHONE_MAX_WIDTH, PHONE_QUERY } from "../components/phone/use-phone.ts";
import { enterSendsRule } from "../components/phone/enter-key.ts";
import { BUBBLE_SIZE, dockAnchor } from "../components/phone/use-dock-anchor.ts";
import { HOLD_SLOP, stillHolding } from "../components/phone/long-press.ts";

const root = path.resolve(import.meta.dirname, "..");
const css = readFileSync(path.join(root, "app/phone.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Top-level blocks of a stylesheet: { prelude, body }. */
function blocks(src: string): { prelude: string; body: string }[] {
	const out: { prelude: string; body: string }[] = [];
	let depth = 0;
	let preludeStart = 0;
	let bodyStart = 0;
	for (let i = 0; i < src.length; i++) {
		const c = src[i];
		if (c === "{") {
			if (depth === 0) bodyStart = i + 1;
			depth++;
		} else if (c === "}") {
			depth--;
			if (depth === 0) {
				out.push({ prelude: src.slice(preludeStart, bodyStart - 1).trim(), body: src.slice(bodyStart, i) });
				preludeStart = i + 1;
			}
		}
	}
	assert.equal(depth, 0, "phone.css has unbalanced braces");
	assert.equal(src.slice(preludeStart).trim(), "", "phone.css has a rule outside every block");
	return out;
}

/** Split a selector list on its top-level commas only. */
function selectors(list: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let from = 0;
	for (let i = 0; i < list.length; i++) {
		const c = list[i];
		if (c === "(" || c === "[") depth++;
		else if (c === ")" || c === "]") depth--;
		else if (c === "," && depth === 0) {
			out.push(list.slice(from, i).trim());
			from = i + 1;
		}
	}
	out.push(list.slice(from).trim());
	return out;
}

describe("app/phone.css can't reach the desktop", () => {
	const top = blocks(css);

	it("has rules", () => assert.ok(top.length > 0));

	it("puts every block inside the phone media query", () => {
		for (const b of top) assert.match(b.prelude, /^@media \(max-width: 639\.98px\)/, `outside the phone query: ${b.prelude}`);
	});

	it("matches the JS phone rule", () => {
		assert.equal(PHONE_QUERY, "(max-width: 639.98px)");
		assert.equal(PHONE_MAX_WIDTH, 640);
	});

	it("scopes every selector under html:not(.lh-electron), so the desktop app never matches", () => {
		let checked = 0;
		for (const media of top) {
			for (const rule of blocks(media.body)) {
				if (rule.prelude.startsWith("@keyframes")) continue;
				for (const selector of selectors(rule.prelude)) {
						assert.match(selector, /^html:not\(\.lh-electron\) /, `unscoped selector: ${selector}`);
					checked++;
				}
			}
		}
		assert.ok(checked > 10);
	});

	it("is loaded by the root layout", () => {
		assert.match(readFileSync(path.join(root, "app/layout.tsx"), "utf8"), /import "\.\/phone\.css";/);
	});
});

describe("phone rules", () => {
	it("the phone layout is a browser below 640 px, never the desktop app", () => {
		assert.equal(isPhoneViewport(390, false), true);
		assert.equal(isPhoneViewport(639, false), true);
		assert.equal(isPhoneViewport(640, false), false);
		assert.equal(isPhoneViewport(1280, false), false);
		// A zoomed-in desktop window can be narrower than 640 CSS px.
		assert.equal(isPhoneViewport(512, true), false);
	});

	it("Enter: the desktop sends, a touch phone makes a new line, ⌘/Ctrl+Enter always sends", () => {
		const k = (o: Partial<{ key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }>) => ({ key: "Enter", shiftKey: false, metaKey: false, ctrlKey: false, ...o });
		assert.equal(enterSendsRule(k({}), false), true);
		assert.equal(enterSendsRule(k({ shiftKey: true }), false), false);
		assert.equal(enterSendsRule(k({ ctrlKey: true }), false), true);
		assert.equal(enterSendsRule(k({}), true), false);
		assert.equal(enterSendsRule(k({ shiftKey: true }), true), false);
		assert.equal(enterSendsRule(k({ metaKey: true }), true), true);
		assert.equal(enterSendsRule(k({ key: "a" }), false), false);
	});

	it("the tutor bubble sits above the dock, or under the top bar when a question leaves no room", () => {
		assert.deepEqual(dockAnchor(560), { place: "above-dock", top: 560 - 12 - BUBBLE_SIZE });
		// The bubble's top must clear the 60px bar plus a 12px gap.
		assert.deepEqual(dockAnchor(60 + 12 + BUBBLE_SIZE + 12), { place: "above-dock", top: 72 });
		assert.deepEqual(dockAnchor(60 + 12 + BUBBLE_SIZE + 11), { place: "top" });
		assert.deepEqual(dockAnchor(null), { place: "top" });
	});

	it("a hold survives a small drift but not a scroll", () => {
		assert.equal(stillHolding({ x: 100, y: 100 }, { x: 104, y: 106 }), true);
		assert.equal(stillHolding({ x: 100, y: 100 }, { x: 100, y: 100 + HOLD_SLOP + 1 }), false);
	});
});
