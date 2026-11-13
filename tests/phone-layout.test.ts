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
import { edgeScrollStep, HOLD_SLOP, stillHolding } from "../components/phone/long-press.ts";

const root = path.resolve(import.meta.dirname, "..");
/** A stylesheet without its comments. */
const readCss = (file: string) => readFileSync(path.join(root, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const css = readCss("app/phone.css");
/** The fork's phone-only stylesheets: phone.css, and one per phone-ready
 *  plugin (docs/phone-plugins-plan.md), which may have no rules yet. */
const PHONE_STYLESHEETS = ["app/phone.css", "app/phone-flashcards.css", "app/phone-rich-code-blocks.css"];

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
	assert.equal(depth, 0, "the stylesheet has unbalanced braces");
	assert.equal(src.slice(preludeStart).trim(), "", "the stylesheet has a rule outside every block");
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

for (const file of PHONE_STYLESHEETS) describe(`${file} can't reach the desktop`, () => {
	const top = blocks(readCss(file));

	if (file === "app/phone.css") it("has rules", () => assert.ok(top.length > 0));

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
		if (file === "app/phone.css") assert.ok(checked > 10);
	});

	it("is loaded by the root layout", () => {
		assert.ok(readFileSync(path.join(root, "app/layout.tsx"), "utf8").includes(`import "./${path.basename(file)}";`));
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

	it("the tutor sheet leaves its middle see-through, and sizes its typing row from the phone's 16px text", () => {
		const sheet = /\[data-phone="tutor-sheet"\] \{([^}]*)\}/.exec(css)?.[1] ?? "";
		// The window's parts paint themselves (the middle is darker and
		// see-through); a solid sheet behind them would close the middle up.
		// The sheet fills only the strip around its handle and the home-bar strip.
		const background = /(?:^|;)\s*background:([^;]*);/.exec(sheet)?.[1] ?? "";
		assert.match(background, /top \/ 100% 0\.75rem no-repeat/);
		assert.match(background, /bottom \/ 100% env\(safe-area-inset-bottom, 0px\) no-repeat/);
		assert.equal((background.match(/linear-gradient/g) ?? []).length, 2, "nothing else is painted");
		// Text boxes are 16px on a phone whatever the reading size, so the
		// Dictate and Send buttons take their height from that.
		assert.match(sheet, /--lh-tutor-text: 16px;/);
		assert.match(css, /:is\(textarea,[^{]*\{\s*font-size: 16px;/);
	});

	it("the dim behind the tutor sheet covers only the lesson above it, so the sheet's middle shows the lesson", () => {
		const sheet = /\[data-phone="tutor-sheet"\] \{([^}]*)\}/.exec(css)?.[1] ?? "";
		const dim = /\[data-phone="backdrop"\]\[data-phone-layer="sheet"\] \{([^}]*)\}/.exec(css)?.[1] ?? "";
		// The sheet starts 26% down and has rounded top corners; the dim ends
		// one corner radius below that, behind the sheet's solid top.
		assert.match(sheet, /top: calc\(var\(--lh-vvh, 100dvh\) \* 0\.26\);/);
		assert.match(sheet, /border-radius: 1\.125rem 1\.125rem 0 0;/);
		assert.match(dim, /height: calc\(var\(--lh-vvh, 100dvh\) \* 0\.26 \+ 1\.125rem\);/);
	});

	it("a hold survives a small drift but not a scroll", () => {
		assert.equal(stillHolding({ x: 100, y: 100 }, { x: 104, y: 106 }), true);
		assert.equal(stillHolding({ x: 100, y: 100 }, { x: 100, y: 100 + HOLD_SLOP + 1 }), false);
	});
});

describe("a dragged note scrolls the list near its edges", () => {
	// A list from y = 100 to y = 500; the scroll zones are the top and bottom 56 px.
	it("doesn't scroll while the finger is in the middle", () => {
		assert.equal(edgeScrollStep(300, 100, 500), 0);
		assert.equal(edgeScrollStep(156, 100, 500), 0);
		assert.equal(edgeScrollStep(444, 100, 500), 0);
	});
	it("scrolls up near the top and down near the bottom, faster towards the edge", () => {
		assert.equal(edgeScrollStep(128, 100, 500), -7);
		assert.equal(edgeScrollStep(100, 100, 500), -14);
		assert.equal(edgeScrollStep(472, 100, 500), 7);
		assert.equal(edgeScrollStep(500, 100, 500), 14);
	});
	it("never goes faster than its top speed, even with the finger past the list", () => {
		assert.equal(edgeScrollStep(20, 100, 500), -14);
		assert.equal(edgeScrollStep(700, 100, 500), 14);
	});
	it("leaves a list too short for two scroll zones alone", () => {
		assert.equal(edgeScrollStep(105, 100, 200), 0);
		assert.equal(edgeScrollStep(195, 100, 200), 0);
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
	it("adds the clock strip back in the home-screen app, only when it is what's missing", async () => {
		const { standaloneGap } = await import("../components/phone/phone-viewport.tsx");
		const iphone = { innerWidth: 440, screenWidth: 440, screenHeight: 956, safeTop: 62 };
		assert.equal(standaloneGap({ ...iphone, standalone: true, innerHeight: 894 }), 62, "the owner's iPhone");
		assert.equal(standaloneGap({ ...iphone, standalone: true, innerHeight: 956 }), 0, "no quirk: nothing added");
		assert.equal(standaloneGap({ ...iphone, standalone: false, innerHeight: 796 }), 0, "a Safari tab");
		assert.equal(standaloneGap({ ...iphone, standalone: true, innerHeight: 894, safeTop: 0 }), 0);
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
	it("an Apple Pencil first moves 12 px, so its taps' wobble doesn't cancel the click (owner's iPad)", async () => {
		const { dragDecision, PENCIL_SLOP, isPencilTouch } = await import("../components/phone/use-dock-touch-scroll.ts");
		const none = () => false;
		assert.equal(PENCIL_SLOP, 12);
		assert.equal(dragDecision(0, 4, true, none, true), "wait", "a Pencil tap's wobble");
		assert.equal(dragDecision(6, 9, true, none, true), "wait", "under 12 px in any direction");
		assert.equal(dragDecision(0, 12, true, none, true), "take", "from 12 px it is a drag, decided as before");
		assert.equal(dragDecision(20, 5, true, none, true), "native", "a sideways Pencil drag");
		assert.equal(dragDecision(0, 4, false, none, true), "native", "Safari already scrolling");
		assert.equal(dragDecision(0, 1, true, none), "take", "a finger: unchanged");
		assert.equal(isPencilTouch({ touchType: "stylus" } as unknown as Touch), true);
		assert.equal(isPencilTouch({ touchType: "direct" } as unknown as Touch), false);
		assert.equal(isPencilTouch({} as Touch), false, "a browser that doesn't label touches: a finger");
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
	it("a glide to the bottom: arrived within the fold machine's reach, ended by a scroll back up, once more when it ends short, then gives up (owner's choice)", async () => {
		const { glideStep, GLIDE_ARRIVED_PX, GLIDE_QUIET_MS, GLIDE_RETRIES, GLIDE_PULLED_BACK_PX } = await import("../components/phone/use-dock-touch-scroll.ts");
		assert.equal(GLIDE_ARRIVED_PX, 16, "chat.tsx's EXPAND_DIST: where the question opens");
		assert.equal(GLIDE_RETRIES, 2);
		const g = (distance: number, quietMs: number, retries = 0, pulledBack = 0) => glideStep({ distance, quietMs, retries, pulledBack });
		assert.equal(g(10, 0), "arrived");
		assert.equal(g(GLIDE_ARRIVED_PX + 1, GLIDE_QUIET_MS - 1), "wait", "still moving");
		assert.equal(g(4000, GLIDE_QUIET_MS), "again", "ended short with nobody touching");
		assert.equal(g(4000, GLIDE_QUIET_MS, GLIDE_RETRIES - 1), "again");
		assert.equal(g(4000, GLIDE_QUIET_MS, GLIDE_RETRIES), "give-up");
		assert.equal(g(4000, 0, 0, GLIDE_PULLED_BACK_PX + 1), "interrupted", "something moved it back up: not a reason to glide again");
		assert.equal(g(4000, GLIDE_QUIET_MS, 0, GLIDE_PULLED_BACK_PX + 1), "interrupted");
		assert.equal(g(4000, GLIDE_QUIET_MS, 0, GLIDE_PULLED_BACK_PX), "again", "a rounding wobble isn't a scroll back up");
		assert.equal(g(10, 0, 0, 500), "arrived", "arrived wins");
	});
	it("a glide in flight is re-aimed when the bottom moves away: once it has slowed, more than a few px, at most every 100 ms, never once it has ended", async () => {
		const { shouldRetarget, glideSpeed, GLIDE_RETARGET_PX, GLIDE_RETARGET_MS, GLIDE_RETARGET_SLOW, GLIDE_QUIET_MS } = await import("../components/phone/use-dock-touch-scroll.ts");
		assert.equal(GLIDE_RETARGET_MS, 100);
		assert.equal(GLIDE_RETARGET_SLOW, 0.6, "px per ms: 10 px a frame at 60 Hz, 5 at 120 Hz");
		const r = (bottom: number, aimed: number | null, sinceAimMs = GLIDE_RETARGET_MS, quietMs = 0, speed = 0.3, moved = true) => shouldRetarget({ bottom, aimed, moved, sinceAimMs, quietMs, speed });
		assert.equal(r(10000, 9000), true, "the lesson grew under a glide that has slowed");
		assert.equal(r(10000, 9000, GLIDE_RETARGET_MS, 0, 6), false, "still fast: a re-aim now could be a brake from full speed");
		assert.equal(r(10000, 9000, GLIDE_RETARGET_MS, 0, GLIDE_RETARGET_SLOW), false);
		assert.equal(r(10000, 9000, GLIDE_RETARGET_MS, 0, 0), true, "just come to a stop, not yet at rest");
		// The speed over the last frame or two, so one long frame doesn't read as slow.
		assert.equal(glideSpeed([{ t: 0, top: 0 }, { t: 8, top: 40 }, { t: 48, top: 60 }]), 1.25, "a 40 ms frame after a fast one");
		assert.equal(glideSpeed([{ t: 0, top: 100 }, { t: 8, top: 104 }, { t: 16, top: 108 }]), 0.5, "120 Hz, 4 px a frame");
		assert.equal(glideSpeed([{ t: 0, top: 100 }]), 0);
		assert.equal(r(9000 + GLIDE_RETARGET_PX, 9000), false, "a few px");
		assert.equal(r(9000, 9500), false, "the bottom came closer: the scroll ends there anyway");
		assert.equal(r(10000, 9000, GLIDE_RETARGET_MS - 1), false, "not more often than every 100 ms");
		assert.equal(r(10000, 9000, GLIDE_RETARGET_MS, GLIDE_QUIET_MS), false, "it has ended: the retry rule's case");
		assert.equal(r(10000, null), false, "not asked for yet (the stop's hidden frame still to come)");
		assert.equal(r(10000, 9000, GLIDE_RETARGET_MS, 0, 0, false), false, "asked for but not moving yet: its speed of 0 isn't \"slowed\"");
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

describe("model menu order (fork)", async () => {
	const { compareModels } = await import("../components/settings/model-menu.tsx");
	it("keeps the Claude Code models together at the bottom, alphabetically", () => {
		const models = [
			{ provider: "claude-code", id: "sonnet" }, { provider: "openai-codex", id: "gpt-6-astra" }, { provider: "claude-code", id: "fable" },
			{ provider: "claude-code", id: "haiku" }, { provider: "openrouter", id: "qwen-3" }, { provider: "claude-code", id: "opus" },
		];
		assert.deepEqual([...models].sort(compareModels).map((m) => m.id), ["gpt-6-astra", "qwen-3", "fable", "haiku", "opus", "sonnet"]);
	});
});

describe("upstream 0.6.0 on a phone", async () => {
	const { isPhoneHiddenSettingsSection, isPluginSettingsSection, PHONE_SIDEBAR_ENTRIES } = await import("../components/phone/phone-plugins.ts");
	/** The declarations of the rule whose selector list contains `needle`. */
	const ruleWith = (needle: string) => {
		for (const media of blocks(css)) for (const rule of blocks(media.body)) if (rule.prelude.includes(needle)) return rule.body;
		return "";
	};
	/** The declarations of the rule whose whole selector is `selector`. */
	const ruleFor = (selector: string) => {
		for (const media of blocks(css)) for (const rule of blocks(media.body)) if (rule.prelude === `html:not(.lh-electron) ${selector}`) return rule.body;
		return "";
	};

	it("hides every way into a plugin but Flashcards' session-list entry: the top bar's buttons, the other entries and the graph's buttons", () => {
		const hide = ruleWith('[data-testid="plugin-top-bar-actions"]');
		assert.match(hide, /display: none;/);
		const kept = PHONE_SIDEBAR_ENTRIES.map((key) => `:not([data-plugin-action="${key}"])`).join("");
		assert.deepEqual(PHONE_SIDEBAR_ENTRIES, ["flashcards/open-sidebar"]);
		for (const way of ['[data-testid="plugin-graph-actions"]', `[data-testid="sidebar-actions"] > [data-plugin-action]${kept})`]) {
			assert.ok(ruleWith(way) === hide, `${way} is hidden with the others`);
		}
		// The key's shape: `<plugin id>/<placement id>`, and Flashcards' placement id.
		assert.match(readFileSync(path.join(root, "components/plugin-chrome.tsx"), "utf8"), /key: `\$\{plugin\.info\.id\}\/\$\{placement\.id\}`/);
		assert.match(readFileSync(path.join(root, "plugins/flashcards/src/main.js"), "utf8"), /placeAction\(\{ id: 'open-sidebar', actionId: 'open', location: 'sidebar' \}\)/);
		assert.match(ruleFor('[data-testid="sidebar-actions"]'), /grid-template-columns: minmax\(0, 1fr\);/, "Teaching, Practice and Flashcards stay stacked");
	});

	it("the plugin sections of Settings are the management rows and every plugin's own page", () => {
		assert.equal(isPluginSettingsSection("core-plugins"), true);
		assert.equal(isPluginSettingsSection("plugins"), true);
		assert.equal(isPluginSettingsSection("plugin:flashcards"), true);
		for (const own of ["keys", "appearance", "general", "cloud", "account", "obsidian"]) assert.equal(isPluginSettingsSection(own), false, own);
	});

	it("a phone lists Core plugins and the phone-ready plugins' pages, and hides the other plugin sections", () => {
		for (const listed of ["core-plugins", "plugin:flashcards", "plugin:rich-code-blocks", "keys", "account"]) assert.equal(isPhoneHiddenSettingsSection(listed), false, listed);
		for (const hidden of ["plugins", "plugin:drawing-pad", "plugin:coding-questions", "plugin:fixture"]) assert.equal(isPhoneHiddenSettingsSection(hidden), true, hidden);
	});

	it("the plugin pages of Settings: a locked switch is greyed, the settings button and every switch's touch area are 40 px", () => {
		assert.match(ruleWith('[data-phone="plugin-locked"] > [role="switch"]'), /opacity: 0\.4;/);
		const link = ruleWith('[data-phone="plugin-settings-link"]');
		assert.match(link, /width: 2\.5rem;/);
		assert.match(link, /height: 2\.5rem;/);
		const area = ruleWith('[role="switch"]::after');
		assert.ok(ruleWith('[data-testid="section-core-plugins"]') === area && ruleWith('[data-testid^="section-plugin-"]') === area);
		// The switch is 32 × 18 with a 1 px border (controls.tsx); its ::after
		// spans its inside (30 × 16) plus the insets: 40 × 40.
		assert.match(area, /inset: -0\.75rem -0\.3125rem;/);
		assert.match(readFileSync(path.join(root, "components/settings/controls.tsx"), "utf8"), /"relative h-4\.5 w-8 shrink-0 rounded-full border border-border/);
	});

	it("Settings rows read as before the merge: no icon, the label at the left", () => {
		assert.match(ruleWith('[data-testid="settings-nav"] > button > svg'), /display: none;/);
	});

	it("the theme cards and the color rows of Appearance take one column", () => {
		assert.match(ruleWith('[data-testid="row-theme"]'), /grid-template-columns: minmax\(0, 1fr\);/);
		assert.ok(ruleWith('[data-testid="group-colors"]') === ruleWith('[data-testid="row-theme"]'));
	});

	it("a dialog's dim and box follow the visible height", () => {
		const dim = ruleFor('[data-interaction-layer][role="dialog"] > div > div.fixed');
		assert.match(dim, /bottom: auto;/);
		assert.match(dim, /height: var\(--lh-vvh, 100dvh\);/);
		assert.match(ruleFor('[data-interaction-layer][role="dialog"] > div > div.fixed > *'), /max-height: calc\(var\(--lh-vvh, 100dvh\) \* 0\.85\);/);
		// The shape those selectors rely on: HostDialog's boundary, then its isolation box, then the caller's backdrop.
		const host = readFileSync(path.join(root, "components/host-dialog.tsx"), "utf8");
		assert.match(host, /data-interaction-layer=\{layer\.id\}/);
		assert.match(host, /<div style=\{\{ isolation: "isolate" \}\}><div \{\.\.\.composedBackdrop\}>\{visual\}<\/div><\/div>/);
	});
});

describe("phone menus above their anchor are pinned by their top", async () => {
	const { phoneTopPlacement } = await import("../components/menu-shell.tsx");
	it("sits the menu's bottom just above the anchor, whatever the frame's height", () => {
		const up = { side: "up" as const, style: { left: 22, bottom: 43 }, maxHeight: 228 };
		assert.deepEqual(phoneTopPlacement(up, 341, 124).style, { left: 22, top: 341 - 4 - 124 });
		assert.deepEqual(phoneTopPlacement(up, 341, 900).style, { left: 22, top: 341 - 4 - 228 }, "capped at maxHeight");
		assert.deepEqual(phoneTopPlacement(up, 60, 400).style, { left: 22, top: 8 }, "never above the screen edge");
	});
	it("leaves a menu that opens downward alone", () => {
		const down = { side: "down" as const, style: { left: 22, top: 120 }, maxHeight: 300 };
		assert.deepEqual(phoneTopPlacement(down, 100, 200), down);
	});
});
