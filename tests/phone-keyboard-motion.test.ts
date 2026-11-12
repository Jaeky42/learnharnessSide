/**
 * IN STEP WITH THE KEYBOARD (owner's choice "B · In step", iPhone): the app's
 * height (--lh-vvh) glides with the on-screen keyboard instead of snapping
 * after it. The rules (components/phone/phone-viewport.tsx) are driven here
 * with a scripted clock, frames and storage, the way the page drives them.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	CATCH_UP_MS,
	CORRECTION_MS,
	GLIDE_BOXES,
	GLIDE_SHELLS,
	KEYBOARD_EASE,
	KEYBOARD_MAX_SHARE,
	KEYBOARD_MIN_PX,
	KEYBOARD_MS,
	KEYBOARD_STORE_KEY,
	NO_KEYBOARD_MS,
	createHeightGlide,
	createKeyboardMotion,
	cubicBezier,
	keyboardSlot,
	plausibleKeyboard,
	recallKeyboard,
	rememberKeyboard,
	type HeightReport,
	TOUCH_FOCUS_MS,
	focusFromTouch,
	focusLost,
	heightEventInFrame,
} from "../components/phone/phone-viewport.tsx";

/** A scripted clock: frames every 16 ms, timers on the same clock. */
function clock() {
	let t = 0;
	let nextId = 1;
	const frames = new Map<number, () => void>();
	const timers = new Map<number, { at: number; cb: () => void }>();
	const api = {
		now: () => t,
		frame: (cb: () => void) => {
			const id = nextId++;
			frames.set(id, cb);
			return id;
		},
		cancelFrame: (id: number) => void frames.delete(id),
		later: (cb: () => void, ms: number) => {
			const id = nextId++;
			timers.set(id, { at: t + ms, cb });
			return id;
		},
		cancelLater: (id: number) => void timers.delete(id),
		/** Runs frames and timers until `ms` has passed. */
		advance(ms: number) {
			const end = t + ms;
			while (t < end) {
				t = Math.min(end, t + 16);
				for (const [id, timer] of [...timers]) {
					if (timer.at <= t) {
						timers.delete(id);
						timer.cb();
					}
				}
				const due = [...frames];
				frames.clear();
				for (const [, cb] of due) cb();
			}
		},
		pendingFrames: () => frames.size,
	};
	return api;
}

const FULL = 664;
const KEYBOARD = 336;
const SLOT = "tab-portrait";

function rig(opts: { remembered?: number; reduced?: boolean } = {}) {
	const c = clock();
	const applied: Array<{ at: number; px: number }> = [];
	const store = new Map<string, number>();
	if (opts.remembered !== undefined) store.set(SLOT, opts.remembered);
	const motion = createKeyboardMotion({
		...c,
		apply: (px) => applied.push({ at: c.now(), px }),
		reduced: () => opts.reduced === true,
		recall: (slot) => store.get(slot) ?? null,
		remember: (slot, cut, full) => {
			const px = plausibleKeyboard(cut, full);
			if (px !== null) store.set(slot, px);
		},
	});
	/** The page's report: as phone-viewport.tsx builds it from the visible height. */
	const report = (visible: number, flags: { typing: boolean; closing?: boolean }): HeightReport => {
		const keyboard = FULL - visible > KEYBOARD_MIN_PX;
		const closing = flags.closing === true;
		return { target: closing ? Math.max(visible, FULL) : visible, full: Math.max(visible, FULL), visible, keyboard, typing: flags.typing, closing, slot: SLOT };
	};
	const last = () => applied.at(-1)?.px;
	return { c, motion, applied, store, report, last };
}

describe("the curve", () => {
	it("is the CSS cubic-bezier", () => {
		const ease = cubicBezier(KEYBOARD_EASE);
		assert.equal(ease(0), 0);
		assert.equal(ease(1), 1);
		const linear = cubicBezier([0, 0, 1, 1]);
		for (const t of [0.1, 0.25, 0.5, 0.9]) assert.ok(Math.abs(linear(t) - t) < 1e-4);
		// The keyboard's curve is front-loaded and never runs backwards.
		assert.ok(ease(0.25) > 0.5, `ease(0.25) = ${ease(0.25)}`);
		let prev = 0;
		for (let t = 0.02; t <= 1; t += 0.02) {
			const v = ease(t);
			assert.ok(v >= prev - 1e-9);
			prev = v;
		}
	});
});

describe("the remembered keyboard", () => {
	it("is kept per orientation and per Safari tab or home-screen app", () => {
		assert.equal(keyboardSlot({ standalone: false, innerWidth: 390, innerHeight: 664 }), "tab-portrait");
		assert.equal(keyboardSlot({ standalone: true, innerWidth: 390, innerHeight: 664 }), "app-portrait");
		assert.equal(keyboardSlot({ standalone: false, innerWidth: 568, innerHeight: 320 }), "tab-landscape");
	});
	it("is only a plausible height", () => {
		assert.equal(plausibleKeyboard(336.4, 664), 336);
		assert.equal(plausibleKeyboard(KEYBOARD_MIN_PX, 664), null, "the hardware keyboard's bar, a pan");
		assert.equal(plausibleKeyboard(664 * KEYBOARD_MAX_SHARE + 2, 664), null, "more than the share of the screen");
		assert.equal(plausibleKeyboard(Number.NaN, 664), null);
		assert.equal(plausibleKeyboard(300, 0), null);
	});
	it("lives in the browser's storage, and a broken storage changes nothing", () => {
		const data = new Map<string, string>();
		const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
		assert.equal(recallKeyboard(store, SLOT, FULL), null);
		assert.equal(rememberKeyboard(store, SLOT, 336, FULL), true);
		assert.equal(rememberKeyboard(store, SLOT, 336, FULL), false, "the same height isn't written again");
		assert.equal(rememberKeyboard(store, "tab-landscape", 180, 320), true);
		assert.deepEqual(JSON.parse(data.get(KEYBOARD_STORE_KEY) ?? ""), { "tab-portrait": 336, "tab-landscape": 180 }, "nothing but the heights");
		assert.equal(recallKeyboard(store, SLOT, FULL), 336);
		assert.equal(rememberKeyboard(store, SLOT, 40, FULL), false, "an implausible height isn't stored");
		data.set(KEYBOARD_STORE_KEY, "{not json");
		assert.equal(recallKeyboard(store, SLOT, FULL), null);
		const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
		assert.equal(recallKeyboard(throwing, SLOT, FULL), null);
		assert.equal(rememberKeyboard(throwing, SLOT, 336, FULL), false);
		assert.equal(recallKeyboard(null, SLOT, FULL), null);
		data.set(KEYBOARD_STORE_KEY, JSON.stringify({ [SLOT]: 600 }));
		assert.equal(recallKeyboard(store, SLOT, FULL), null, "a stored height that no longer fits this screen");
	});
});

describe("the glide", () => {
	it("moves in whole pixels, keeps its time when retargeted, and never jumps", () => {
		const c = clock();
		const out: number[] = [];
		const glide = createHeightGlide({ ...c, apply: (px) => out.push(px) });
		glide.set(664);
		glide.to(328, 300, KEYBOARD_EASE);
		c.advance(100);
		const mid = out.at(-1) ?? 0;
		assert.ok(mid < 664 && mid > 328, `mid-glide ${mid}`);
		glide.to(300, 50, KEYBOARD_EASE); // a correction while 200 ms are left
		c.advance(150);
		assert.ok((out.at(-1) ?? 0) > 300, "still on its way after 150 of the 200 ms left");
		c.advance(80);
		assert.equal(out.at(-1), 300);
		assert.equal(glide.running(), false);
		for (let i = 1; i < out.length; i++) assert.ok(Math.abs((out[i] ?? 0) - (out[i - 1] ?? 0)) <= 120, `a step of ${out[i - 1]} → ${out[i]}`);
		assert.ok(out.every((px) => Number.isInteger(px)));
	});
	it("says when it has settled: the last frame and every change at once", () => {
		const c = clock();
		const out: Array<[number, boolean]> = [];
		const glide = createHeightGlide({ ...c, apply: (px, moving) => out.push([px, moving]) });
		glide.set(664);
		glide.to(328, 300, KEYBOARD_EASE);
		c.advance(400);
		assert.deepEqual(out[0], [664, false]);
		assert.deepEqual(out.at(-1), [328, false]);
		assert.ok(out.slice(1, -1).every(([, moving]) => moving), "everything between is moving");
		glide.set(500);
		assert.deepEqual(out.at(-1), [500, false]);
	});
});

describe("what a glide moves", () => {
	it("covers every rule of app/phone.css that reads --lh-vvh", () => {
		const css = readFileSync(new URL("../app/phone.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
		const boxes = GLIDE_BOXES.split(", ");
		const seen: string[] = [];
		for (const [, selectorText = "", body = ""] of css.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
			if (!body.includes("--lh-vvh")) continue;
			for (const raw of selectorText.split(/,(?![^(]*\))/)) {
				const selector = raw.trim().replace(/^html:not\(\.lh-electron\)\s*/, "");
				// A single :is(…) at the start stands for each of its parts.
				const is = /^:is\((.*)\)$/.exec(selector);
				for (const part of is ? (is[1] ?? "").split(/,\s*/) : [selector]) {
					seen.push(part);
					if (part === GLIDE_SHELLS || part === "body" || part.startsWith("body[data-lh-bleed]")) continue;
					const base = part.replace(/\[data-phone-layer="sheet"\]$/, "");
					assert.ok(boxes.includes(part) || boxes.includes(base), `phone.css reads --lh-vvh in ${part}, which a glide doesn't move`);
				}
			}
		}
		assert.ok(seen.includes(".h-dvh") && seen.includes('[data-phone="tutor-sheet"]'), seen.join(" | "));
	});
});

describe("opening the keyboard", () => {
	it("with a remembered height: moves at focus, in step, before Safari reports anything", () => {
		const { c, motion, applied, report, last } = rig({ remembered: KEYBOARD });
		motion.report(report(FULL, { typing: false }));
		assert.equal(last(), FULL);
		// Focus: the page calls focus(), then report() with the same size.
		motion.focus(report(FULL, { typing: true }));
		motion.report(report(FULL, { typing: true }));
		c.advance(KEYBOARD_MS / 2);
		const half = last() ?? 0;
		assert.ok(half < FULL - KEYBOARD / 2, `half way through the keyboard's time the app is more than half way: ${half}`);
		c.advance(KEYBOARD_MS / 2 + 16);
		assert.equal(last(), FULL - KEYBOARD, "the predicted height");
		// Safari reports the same height: nothing more moves.
		const count = applied.length;
		motion.report(report(FULL - KEYBOARD, { typing: true }));
		c.advance(400);
		assert.equal(applied.length, count);
		assert.equal(last(), FULL - KEYBOARD);
	});
	it("a remembered height that is off: a short glide to the real one, never a jump", () => {
		const { c, motion, applied, report, last, store } = rig({ remembered: 300 });
		motion.report(report(FULL, { typing: false }));
		motion.focus(report(FULL, { typing: true }));
		motion.report(report(FULL, { typing: true }));
		c.advance(KEYBOARD_MS + 16);
		assert.equal(last(), FULL - 300);
		const before = applied.length;
		motion.report(report(FULL - 380, { typing: true })); // another keyboard: 380 px
		assert.equal(applied.length, before, "nothing lands in the same frame");
		c.advance(CORRECTION_MS / 2);
		const mid = last() ?? 0;
		assert.ok(mid < FULL - 300 && mid > FULL - 380, `half way: ${mid}`);
		c.advance(CORRECTION_MS);
		assert.equal(last(), FULL - 380);
		assert.equal(store.get(SLOT), 380, "the new height is remembered");
	});
	it("Safari's height arriving mid-glide retargets it without a jump", () => {
		const { c, motion, applied, report, last } = rig({ remembered: 300 });
		motion.report(report(FULL, { typing: false }));
		motion.focus(report(FULL, { typing: true }));
		motion.report(report(FULL, { typing: true }));
		c.advance(96);
		motion.report(report(FULL - 340, { typing: true }));
		c.advance(KEYBOARD_MS);
		assert.equal(last(), FULL - 340);
		const steps = applied.map((a) => a.px);
		for (let i = 1; i < steps.length; i++) assert.ok((steps[i] ?? 0) <= (steps[i - 1] ?? 0), "only ever down");
	});
	it("nothing remembered (the first time): waits for Safari, glides to it, then remembers it", () => {
		const { c, motion, report, last, store, applied } = rig();
		motion.report(report(FULL, { typing: false }));
		motion.focus(report(FULL, { typing: true }));
		motion.report(report(FULL, { typing: true }));
		c.advance(KEYBOARD_MS);
		assert.equal(last(), FULL, "nothing moves before the size is known");
		motion.report(report(FULL - KEYBOARD, { typing: true }));
		c.advance(CATCH_UP_MS / 3);
		const mid = last() ?? 0;
		assert.ok(mid < FULL && mid > FULL - KEYBOARD, `a glide, not a jump: ${mid}`);
		c.advance(CATCH_UP_MS);
		assert.equal(last(), FULL - KEYBOARD);
		assert.equal(store.get(SLOT), KEYBOARD);
		assert.ok(applied.length > 5);
	});
	it("no keyboard after all (a hardware keyboard): back to the real height after the wait", () => {
		const { c, motion, report, last, store } = rig({ remembered: KEYBOARD });
		motion.report(report(FULL, { typing: true }));
		motion.focus(report(FULL, { typing: true }));
		motion.report(report(FULL, { typing: true }));
		c.advance(KEYBOARD_MS + 16);
		assert.equal(last(), FULL - KEYBOARD);
		c.advance(NO_KEYBOARD_MS - KEYBOARD_MS - 16 - 64);
		assert.equal(last(), FULL - KEYBOARD, "held through the wait");
		c.advance(64 + CORRECTION_MS + 32);
		assert.equal(last(), FULL, "back to the full height");
		assert.equal(store.get(SLOT), KEYBOARD, "nothing new remembered");
	});
	it("a hardware keyboard's small bar ends the wait at once", () => {
		const { c, motion, report, last } = rig({ remembered: KEYBOARD });
		motion.report(report(FULL, { typing: false }));
		motion.focus(report(FULL, { typing: true }));
		motion.report(report(FULL, { typing: true }));
		c.advance(KEYBOARD_MS + 16);
		motion.report(report(FULL - 55, { typing: true })); // the shortcuts bar
		c.advance(CORRECTION_MS + 32);
		assert.equal(last(), FULL - 55, "today's height for it");
		assert.equal(motion.predicting(), false);
	});
	it("a pan alone doesn't end the prediction", () => {
		const { c, motion, report, last } = rig({ remembered: KEYBOARD });
		motion.report(report(FULL, { typing: false }));
		motion.focus(report(FULL, { typing: true }));
		motion.report(report(FULL, { typing: true }));
		c.advance(KEYBOARD_MS + 16);
		motion.report({ ...report(FULL, { typing: true }), keyboard: true }); // Safari panned
		c.advance(100);
		assert.equal(last(), FULL - KEYBOARD);
		assert.equal(motion.predicting(), true);
	});
});

describe("closing the keyboard", () => {
	it("glides back to the full height over the keyboard's time, and Safari's late height changes nothing", () => {
		const { c, motion, applied, report, last } = rig({ remembered: KEYBOARD });
		motion.report(report(FULL - KEYBOARD, { typing: true }));
		// Blur: the page marks it closing (the visible part is still short).
		motion.report(report(FULL - KEYBOARD, { typing: false, closing: true }));
		c.advance(16);
		assert.ok((last() ?? 0) > FULL - KEYBOARD && (last() ?? 0) < FULL, "on its way at the first frame");
		c.advance(KEYBOARD_MS);
		assert.equal(last(), FULL);
		const count = applied.length;
		motion.report(report(FULL, { typing: false }));
		c.advance(100);
		assert.equal(applied.length, count);
	});
	it("a blur before the keyboard was reported glides back too", () => {
		const { c, motion, report, last } = rig({ remembered: KEYBOARD });
		motion.report(report(FULL, { typing: false }));
		motion.focus(report(FULL, { typing: true }));
		motion.report(report(FULL, { typing: true }));
		c.advance(KEYBOARD_MS / 2);
		motion.report(report(FULL, { typing: false }));
		assert.equal(motion.predicting(), false);
		c.advance(KEYBOARD_MS + 16);
		assert.equal(last(), FULL);
	});
	it("focus moving to another text box keeps the keyboard's height", () => {
		const { c, motion, applied, report, last } = rig({ remembered: KEYBOARD });
		motion.report(report(FULL - KEYBOARD, { typing: true }));
		const count = applied.length;
		// The page ignores a focusout towards another text box; the focusin
		// finds typing already on, so nothing reaches the motion but reports.
		motion.report(report(FULL - KEYBOARD, { typing: true }));
		c.advance(400);
		assert.equal(applied.length, count);
		assert.equal(last(), FULL - KEYBOARD);
	});
	it("a blur and a focus in the same moment (no related target) don't move the app", () => {
		const { c, motion, report, last, applied } = rig({ remembered: KEYBOARD });
		motion.report(report(FULL - KEYBOARD, { typing: true }));
		const count = applied.length;
		motion.report(report(FULL - KEYBOARD, { typing: false, closing: true }));
		motion.focus(report(FULL - KEYBOARD, { typing: true }));
		motion.report(report(FULL - KEYBOARD, { typing: true }));
		c.advance(400);
		assert.equal(last(), FULL - KEYBOARD);
		assert.equal(applied.length, count, "no frame painted elsewhere");
	});
});

describe("what doesn't glide", () => {
	it("reduced motion: every change lands at once, as before, and nothing is remembered", () => {
		const { c, motion, report, applied, store } = rig({ reduced: true, remembered: KEYBOARD });
		motion.report(report(FULL, { typing: false }));
		motion.focus(report(FULL, { typing: true }));
		motion.report(report(FULL, { typing: true }));
		c.advance(KEYBOARD_MS);
		assert.deepEqual(applied.map((a) => a.px), [FULL], "nothing before Safari's height");
		motion.report(report(FULL - 340, { typing: true }));
		assert.deepEqual(applied.map((a) => a.px), [FULL, FULL - 340], "in the same moment");
		motion.report(report(FULL - 340, { typing: false, closing: true }));
		assert.deepEqual(applied.map((a) => a.px), [FULL, FULL - 340, FULL]);
		assert.equal(c.pendingFrames(), 0);
		assert.equal(store.get(SLOT), KEYBOARD, "unchanged");
	});
	it("a change that isn't the keyboard (a rotation, Safari's bars, Android's own resize) lands at once", () => {
		const { motion, report, applied } = rig({ remembered: KEYBOARD });
		motion.report(report(FULL, { typing: false }));
		motion.report(report(FULL - 50, { typing: false }));
		assert.deepEqual(applied.map((a) => a.px), [FULL, FULL - 50]);
		// Android: the layout shrinks with the keyboard, so the visible part
		// never runs short of it and no keyboard is seen by size.
		const android = (h: number, typing: boolean): HeightReport => ({ target: h, full: h, visible: h, keyboard: false, typing, closing: false, slot: SLOT });
		motion.report(android(FULL, false));
		motion.report(android(FULL, true));
		motion.report(android(FULL - KEYBOARD, true));
		assert.equal(applied.at(-1)?.px, FULL - KEYBOARD);
	});
});

describe("only the learner's own tap is met in step", () => {
	/** A tiny tree: a box with a line inside it, a wrapper around it, and a link elsewhere. */
	const node = (name: string, parent: { kids: unknown[] } | null = null) => {
		const n = {
			name,
			kids: [] as unknown[],
			contains(other: unknown): boolean {
				return other === n || n.kids.some((k) => (k as { contains(o: unknown): boolean }).contains(other));
			},
		};
		parent?.kids.push(n);
		return n;
	};
	const wrapper = node("wrapper");
	const box = node("box", wrapper);
	const line = node("line", box);
	const link = node("link");
	const at = (target: unknown, ms: number) => ({ target: target as Node, at: ms });
	it("a touch that ended on the box, inside it, or on what holds it, just before the focus", () => {
		assert.equal(focusFromTouch(at(box, 1000), box as unknown as Node, 1004), true);
		assert.equal(focusFromTouch(at(line, 1000), box as unknown as Node, 1010), true, "a line inside the notes editor");
		assert.equal(focusFromTouch(at(wrapper, 1000), box as unknown as Node, 1010), true, "the padding around the message box");
		assert.equal(focusFromTouch(at(box, 1000), box as unknown as Node, 1000 + TOUCH_FOCUS_MS), true);
	});
	it("not a focus by code: no touch, a touch elsewhere (the Home link before autoFocus), or one too long ago", () => {
		assert.equal(focusFromTouch(null, box as unknown as Node, 1000), false, "the message box after a dictation");
		assert.equal(focusFromTouch(at(link, 1000), box as unknown as Node, 1080), false, "a navigation, then autoFocus");
		assert.equal(focusFromTouch(at(box, 1000), box as unknown as Node, 1001 + TOUCH_FOCUS_MS), false);
		assert.equal(focusFromTouch(at(box, 1000), box as unknown as Node, 900), false);
		assert.equal(focusFromTouch(at(null, 1000), box as unknown as Node, 1001), false);
	});
	it("by code the motion isn't asked to predict, so nothing moves until Safari reports", () => {
		const { c, motion, report, last } = rig({ remembered: KEYBOARD });
		motion.report(report(FULL, { typing: false }));
		motion.report(report(FULL, { typing: true })); // focus() not called
		c.advance(1600);
		assert.equal(last(), FULL);
		motion.report(report(FULL - KEYBOARD, { typing: true }));
		c.advance(CATCH_UP_MS / 3);
		assert.ok((last() ?? 0) < FULL && (last() ?? 0) > FULL - KEYBOARD, "the catch-up glide");
	});
});

describe("a focused box that disappears without a blur", () => {
	const textarea = { tagName: "TEXTAREA" };
	const body = { tagName: "BODY" };
	it("counts as a blur when nothing typeable has focus any more, or the box left the page", () => {
		assert.equal(focusLost(true, { isConnected: true }, body), true, "WebKit: the box removed, focus on the body");
		assert.equal(focusLost(true, { isConnected: false }, textarea), true, "removed, even if something else looks typeable");
		assert.equal(focusLost(true, { isConnected: true }, textarea), false);
		assert.equal(focusLost(true, null, { tagName: "DIV", isContentEditable: true }), false);
		assert.equal(focusLost(false, null, body), false);
	});
});

describe("the height event", () => {
	it("may be rendered at once only when sent from a glide's own frame", () => {
		assert.equal(heightEventInFrame(Object.assign(new Event("x"), { detail: { frame: true } })), true);
		assert.equal(heightEventInFrame(Object.assign(new Event("x"), { detail: { frame: false } })), false);
		assert.equal(heightEventInFrame(new Event("x")), false);
	});
});
