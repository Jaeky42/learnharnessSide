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
						assert.match(selector, /^html:not\(\.lh-electron\)( |$)/, `unscoped selector: ${selector}`);
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

describe("menus stay on a phone screen", async () => {
	const { clampMenuToScreen } = await import("../components/menu-shell.tsx");
	it("slides a menu that would open off the left edge back inside the margin", () => {
		const p = clampMenuToScreen({ side: "down", style: { right: 390 - 167, top: 100 }, maxHeight: 300 }, 208, 390);
		assert.deepEqual(p.style, { top: 100, left: 8, maxWidth: 374 });
	});
	it("leaves a menu that already fits where it was", () => {
		const p = clampMenuToScreen({ side: "up", style: { left: 40, bottom: 80 }, maxHeight: 300 }, 208, 390);
		assert.equal(p.style.left, 40);
	});
	it("keeps a menu wider than the screen inside both margins", () => {
		const p = clampMenuToScreen({ side: "up", style: { left: 0, bottom: 80 }, maxHeight: 300 }, 352, 360);
		assert.equal(p.style.left, 8);
		assert.equal(p.style.maxWidth, 344);
	});
});

describe("the app follows the visible area when the iPhone keyboard is up", async () => {
	const { viewportFit } = await import("../components/phone/phone-viewport.tsx");
	it("uses the visible height and Safari's pan", () => {
		assert.deepEqual(viewportFit({ height: 565.4, offsetTop: 320.2, scale: 1 }), { height: 565, top: 320 });
		assert.deepEqual(viewportFit({ height: 932, offsetTop: 0, scale: 1 }), { height: 932, top: 0 });
	});
	it("leaves the layout alone while the page is pinch-zoomed", () => {
		assert.equal(viewportFit({ height: 300, offsetTop: 120, scale: 2 }), null);
	});
});

describe("Safari tab bleed", async () => {
	const { bleedFor, keyboardUp, BLEED_PX } = await import("../components/phone/phone-viewport.tsx");
	const safari = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
	it("runs the page under the bars only in an iPhone Safari tab with the keyboard down", () => {
		assert.equal(bleedFor({ userAgent: safari, standalone: false, keyboard: false }), BLEED_PX);
		assert.equal(bleedFor({ userAgent: safari, standalone: true, keyboard: false }), 0, "the home-screen app already draws edge to edge");
		assert.equal(bleedFor({ userAgent: safari, standalone: false, keyboard: true }), 0, "keyboard handling stays as it was");
		assert.equal(bleedFor({ userAgent: safari.replace("Version/18.0", "CriOS/130.0"), standalone: false, keyboard: false }), 0);
		assert.equal(bleedFor({ userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36", standalone: false, keyboard: false }), 0);
	});
	it("takes the full height as soon as the keyboard starts closing", async () => {
		const { layoutHeight } = await import("../components/phone/phone-viewport.tsx");
		assert.equal(layoutHeight(470, 796, false), 470, "keyboard up: the visible part");
		assert.equal(layoutHeight(470, 796, true), 796, "closing: full height before Safari reports it");
		assert.equal(layoutHeight(796, 796, true), 796);
	});
	it("treats a focused text box as the keyboard, before its size arrives", async () => {
		const { typingTarget } = await import("../components/phone/phone-viewport.tsx");
		assert.equal(keyboardUp({ height: 796, top: 0 }, 796, true), true);
		assert.equal(typingTarget({ tagName: "TEXTAREA" }), true);
		assert.equal(typingTarget({ tagName: "INPUT", type: "text" }), true);
		assert.equal(typingTarget({ tagName: "INPUT", type: "search" }), true);
		assert.equal(typingTarget({ tagName: "INPUT", type: "range" }), false, "the confidence slider");
		assert.equal(typingTarget({ tagName: "INPUT", type: "checkbox" }), false);
		assert.equal(typingTarget({ tagName: "DIV", isContentEditable: true }), true, "the notes editor");
		assert.equal(typingTarget({ tagName: "BUTTON" }), false);
		assert.equal(typingTarget(null), false);
	});
	it("treats a pan or a much shorter visible area as the keyboard", () => {
		assert.equal(keyboardUp({ height: 796, top: 0 }, 796), false);
		assert.equal(keyboardUp({ height: 796, top: 12 }, 796), true);
		assert.equal(keyboardUp({ height: 470, top: 0 }, 796), true);
		assert.equal(keyboardUp({ height: 700, top: 0 }, 796), false);
	});
});

describe("drag on the dock scrolls the lesson", async () => {
	const { innerCanTake, flingStep } = await import("../components/phone/use-dock-touch-scroll.ts");
	const box = (scrollTop: number, scrollHeight = 600, clientHeight = 300) => ({ scrollTop, scrollHeight, clientHeight });
	it("keeps a drag in a panel that can still move that way", () => {
		assert.equal(innerCanTake([box(100)], 20), true, "finger down, panel not at its top");
		assert.equal(innerCanTake([box(0)], 20), false, "finger down, panel at its top: the lesson takes it");
		assert.equal(innerCanTake([box(300)], -20), false, "finger up, panel at its bottom");
		assert.equal(innerCanTake([box(0, 300, 300)], 20), false, "a box with nothing to scroll");
		assert.equal(innerCanTake([box(0), box(50)], 20), true, "an outer panel can still move");
	});
	it("decides on the drag's first movement, before Safari starts its own scrolling", async () => {
		const { dragDecision } = await import("../components/phone/use-dock-touch-scroll.ts");
		const none = () => false;
		assert.equal(dragDecision(0, 0, true, none), "wait");
		assert.equal(dragDecision(0, 1, true, none), "take", "one pixel down is enough");
		assert.equal(dragDecision(3, 1, true, none), "native", "sideways");
		assert.equal(dragDecision(0, 2, true, () => true), "native", "a panel under the finger can scroll");
		assert.equal(dragDecision(0, 2, false, none), "native", "Safari already scrolling: leave it");
	});
	it("replays a short tap that Safari swallowed because the lesson was moving", async () => {
		const { replayTap, TAP_MS } = await import("../components/phone/use-dock-touch-scroll.ts");
		assert.equal(replayTap(true, 120), true);
		assert.equal(replayTap(false, 120), false, "a still lesson: Safari's own click lands");
		assert.equal(replayTap(true, TAP_MS + 1), false, "a long press is not a tap");
	});
	it("slows a fling and stops it, by time rather than by frame", () => {
		assert.equal(flingStep(10), 9.5);
		assert.equal(flingStep(0.5), 0);
		assert.ok(Math.abs(flingStep(flingStep(10, 0.5), 0.5) - 9.5) < 1e-9, "two 120 fps frames = one 60 fps frame");
	});
	it("takes the throw from the last moments of the drag, not the last twitch", async () => {
		const { releaseVelocity, FLING_MAX } = await import("../components/phone/use-dock-touch-scroll.ts");
		// A steady flick down at 1px/ms, then a 3px twitch back 1ms later as the finger lifts.
		const flick = [0, 16, 32, 48, 64, 80].map((t) => ({ t, y: 100 + t }));
		const twitch = [...flick, { t: 81, y: 177 }];
		assert.ok(releaseVelocity(twitch, 82) > 0, "still a throw downwards");
		assert.equal(Math.round(releaseVelocity(flick, 82)), 16);
		assert.equal(releaseVelocity(flick, 200), 0, "the finger stopped before lifting");
		assert.equal(releaseVelocity([{ t: 0, y: 0 }, { t: 2, y: 5 }], 3), 0, "too short to measure");
		assert.equal(releaseVelocity([{ t: 0, y: 0 }, { t: 10, y: 400 }], 11), FLING_MAX, "capped");
	});
});
