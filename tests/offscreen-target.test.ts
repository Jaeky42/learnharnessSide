/**
 * OFFSCREEN TARGET: a jump into a message the browser skipped drawing
 * (app/offscreen.css) draws it before measuring, checks once after the layout
 * has settled, and leaves nothing behind.
 *
 * The DOM is linkedom with a scripted layout: rows stack in a scroller whose
 * top is at 100 px; a skipped message has its estimate's height and a passage
 * inside it measures as all zeros, as in Chromium; a drawn one has its real
 * height. Frames run only when the test says so.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import {
	DRAW_ATTRIBUTE, OFFSCREEN_BLOCK_SELECTORS, RELEASE_FALLBACK_MS, SETTLE_MAX_FRAMES, revealOffscreenTarget,
} from "../components/offscreen-target.ts";
import { scrollSessionTarget, type SessionScrollContext } from "../components/session-navigation.tsx";

const MAIN_TOP = 100;
const MAIN_HEIGHT = 700;
const WINDOW_HEIGHT = 800;

type Row = { el: HTMLElement; real: number; estimate: number; drawn: boolean; remembered: number | null; block: boolean };

function setup({ rows: specs, off = false, browserApis = true }: {
	rows: Array<{ kind: "user" | "assistant" | "card"; real: number; estimate?: number; drawn?: boolean }>;
	off?: boolean;
	browserApis?: boolean;
}) {
	const html = specs.map((spec, i) => spec.kind === "user"
		? `<div data-testid="user-message" id="r${i}"><p>learner ${i}</p></div>`
		: spec.kind === "assistant" ? `<div class="is-assistant" id="r${i}"><p>teacher ${i}</p></div>`
		: `<div class="card" id="r${i}"><p>card ${i}</p></div>`).join("");
	const { window, document } = parseHTML(`<html${off ? ' data-lh-offscreen="off"' : ""}><body><div id="main"><div data-session-find-root="">${html}</div></div></body></html>`);
	const main = document.getElementById("main") as unknown as HTMLElement;
	const rows: Row[] = specs.map((spec, i) => ({
		el: document.getElementById(`r${i}`) as unknown as HTMLElement,
		real: spec.real,
		estimate: spec.estimate ?? (spec.kind === "card" ? spec.real : 600),
		drawn: spec.drawn ?? spec.kind === "card",
		remembered: null,
		block: spec.kind !== "card",
	}));
	const ruleOn = () => !off;
	const isDrawn = (row: Row) => !row.block || !ruleOn() || row.drawn || row.el.hasAttribute(DRAW_ATTRIBUTE);
	const height = (row: Row) => {
		if (isDrawn(row)) { row.remembered = row.real; return row.real; }
		return row.remembered ?? row.estimate;
	};
	let scrollTop = 0;
	const scrolls: number[] = [];
	const contentHeight = () => rows.reduce((sum, row) => sum + height(row), 0);
	Object.defineProperty(main, "scrollTop", { get: () => scrollTop, set: (v: number) => { scrollTop = v; } });
	Object.defineProperty(main, "scrollHeight", { get: () => contentHeight() });
	Object.defineProperty(main, "clientHeight", { get: () => MAIN_HEIGHT });
	(main as unknown as { scrollTo(o: { top: number }): void }).scrollTo = ({ top }) => {
		scrollTop = Math.max(0, Math.min(top, contentHeight() - MAIN_HEIGHT));
		scrolls.push(scrollTop);
	};
	const rowTop = (row: Row) => {
		let y = MAIN_TOP - scrollTop;
		for (const other of rows) { if (other === row) return y; y += height(other); }
		throw new Error("no row");
	};
	const rect = (top: number, h: number) => ({ top, bottom: top + h, height: h, left: 0, right: 900, width: 900, x: 0, y: top });
	const proto = window.HTMLElement.prototype as unknown as { getBoundingClientRect(this: HTMLElement): unknown; checkVisibility(this: HTMLElement): boolean };
	proto.getBoundingClientRect = function () {
		if (this === main) return rect(MAIN_TOP, MAIN_HEIGHT);
		const row = rows.find((r) => r.el === this || r.el.contains(this));
		if (!row) return rect(0, 0);
		return row.el === this ? rect(rowTop(row), height(row)) : rect(rowTop(row) + 10, 20);
	};
	proto.checkVisibility = function () {
		const row = rows.find((r) => r.el !== this && r.el.contains(this));
		return row ? isDrawn(row) : true;
	};
	let frames = new Map<number, () => void>();
	let nextFrame = 1;
	const timers = new Map<number, () => void>();
	let nextTimer = 1;
	if (browserApis) {
		Object.assign(window, {
			innerHeight: WINDOW_HEIGHT,
			getComputedStyle: (el: HTMLElement) => {
				const row = rows.find((r) => r.el === el);
				const auto = !!row?.block && ruleOn() && !el.hasAttribute(DRAW_ATTRIBUTE);
				return { contentVisibility: auto ? "auto" : "visible", overflowY: el === main ? "auto" : "visible" };
			},
			requestAnimationFrame: (cb: () => void) => { const id = nextFrame++; frames.set(id, cb); return id; },
			cancelAnimationFrame: (id: number) => { frames.delete(id); },
		});
	}
	// Timers are scripted too, so a fallback runs only when the test says.
	Object.assign(window, {
		setTimeout: (cb: () => void) => { const id = nextTimer++; timers.set(id, cb); return id; },
		clearTimeout: (id: number) => { timers.delete(id); },
	});
	/** Runs one frame. `browser` changes the layout first, as the browser's
	 *  own drawing would between two frames; then the browser keeps drawing
	 *  the messages that are on screen, as content-visibility: auto does. */
	const frame = (browser?: () => void) => {
		browser?.();
		for (const row of rows) {
			if (!row.block) continue;
			const top = rowTop(row);
			row.drawn = top < MAIN_TOP + MAIN_HEIGHT && top + height(row) > MAIN_TOP;
		}
		const run = [...frames.values()];
		frames = new Map();
		for (const cb of run) cb();
	};
	const runTimers = () => { const all = [...timers.values()]; timers.clear(); for (const cb of all) cb(); };
	/** A passage inside a message: zeros while the message is skipped. */
	const passage = (index: number) => {
		const row = rows[index]!;
		const text = row.el.querySelector("p")!.firstChild!;
		return {
			startContainer: text,
			getBoundingClientRect: () => isDrawn(row) ? rect(rowTop(row) + 40, 20) : rect(0, 0),
		} as unknown as Range;
	};
	const topOf = (target: { getBoundingClientRect(): { top: number } }) => target.getBoundingClientRect().top - MAIN_TOP;
	const context = { scrollRef: { current: main }, stopScroll: () => {} } as unknown as SessionScrollContext;
	return {
		window, document, main, rows, scrolls, frame, runTimers, passage, topOf, context,
		pendingFrames: () => frames.size,
		drawnAttributes: () => document.querySelectorAll(`[${DRAW_ATTRIBUTE}]`).length,
		scrollTo: (top: number) => { scrollTop = top; },
	};
}

/** A long lesson: 30 messages, scrolled to the bottom; the browser has drawn
 *  the last eight (the screen and its margin). */
function lesson(extra: Parameters<typeof setup>[0] extends infer T ? Partial<T> : never = {}) {
	const rows = Array.from({ length: 30 }, (_, i) => ({
		kind: i % 2 ? "assistant" as const : "user" as const,
		real: i % 2 ? 900 : 50,
		drawn: i >= 22,
	}));
	const env = setup({ rows, ...extra });
	env.scrollTo(1e9);
	env.main.scrollTo({ top: 1e9 });
	env.scrolls.length = 0;
	return env;
}

describe("a jump into a skipped message", () => {
	it("measures zeros without the helper's draw (the bug), and lands exactly with it", () => {
		const off = lesson();
		const before = off.main.scrollTop;
		// The bare loop of scrollSessionTarget, with a zero rect: it moves by -116.
		const zero = off.passage(5);
		off.main.scrollTo({ top: off.main.scrollTop + zero.getBoundingClientRect().top - MAIN_TOP - 16 });
		assert.equal(off.main.scrollTop, before - MAIN_TOP - 16);

		const env = lesson();
		const target = env.passage(5);
		scrollSessionTarget(target, env.main, env.context);
		assert.equal(env.topOf(target), 16);
		assert.equal(env.rows[5]!.el.hasAttribute(DRAW_ATTRIBUTE), true);
	});

	it("also draws the skipped messages it brings on screen, and the ones just above", () => {
		const env = lesson();
		const target = env.passage(9);
		scrollSessionTarget(target, env.main, env.context);
		assert.equal(env.topOf(target), 16);
		const drawn = env.rows.flatMap((row, i) => row.el.hasAttribute(DRAW_ATTRIBUTE) ? [i] : []);
		// The target (taller than the screen) and the messages within two
		// window heights above it; nothing below the screen, nothing far up.
		assert.ok(drawn.includes(9) && drawn.includes(8) && drawn.includes(7), String(drawn));
		assert.ok(!drawn.includes(0) && !drawn.includes(10) && !drawn.includes(20), String(drawn));
	});

	it("checks once after the layout settles and puts the passage back if it moved", () => {
		// A card far above whose image loads after the jump: the browser's own
		// layout change, which the helper didn't draw.
		const rows = [{ kind: "card" as const, real: 300 }, ...Array.from({ length: 20 }, (_, i) => ({ kind: i % 2 ? "assistant" as const : "user" as const, real: i % 2 ? 900 : 50 }))];
		const env = setup({ rows });
		env.scrollTo(1e9);
		const target = env.passage(16);
		scrollSessionTarget(target, env.main, env.context);
		assert.equal(env.topOf(target), 16);
		const placed = env.scrolls.length;
		env.frame();
		env.frame(() => { env.rows[0]!.real = 500; });
		assert.equal(env.topOf(target), 216, "moved by the card");
		for (let i = 0; i < SETTLE_MAX_FRAMES && env.pendingFrames(); i++) env.frame();
		assert.equal(env.pendingFrames(), 0);
		assert.equal(env.topOf(target), 16, "put back");
		assert.ok(env.scrolls.length > placed, "a correction scroll");
		assert.equal(env.drawnAttributes(), 0, "nothing left behind");
		// Once: a later change is not followed.
		const after = env.scrolls.length;
		env.rows[0]!.real = 800;
		env.frame();
		assert.equal(env.scrolls.length, after);
	});

	it("doesn't correct when nothing moved", () => {
		const env = lesson();
		const target = env.passage(5);
		scrollSessionTarget(target, env.main, env.context);
		const placed = env.scrolls.length;
		for (let i = 0; i < SETTLE_MAX_FRAMES && env.pendingFrames(); i++) env.frame();
		assert.equal(env.scrolls.length, placed);
		assert.equal(env.topOf(target), 16);
		assert.equal(env.drawnAttributes(), 0);
	});

	it("doesn't correct after the learner scrolls, and still removes the attribute", () => {
		const rows = [{ kind: "card" as const, real: 300 }, ...Array.from({ length: 20 }, (_, i) => ({ kind: i % 2 ? "assistant" as const : "user" as const, real: i % 2 ? 900 : 50 }))];
		const env = setup({ rows });
		env.scrollTo(1e9);
		const target = env.passage(16);
		scrollSessionTarget(target, env.main, env.context);
		const placed = env.scrolls.length;
		env.frame();
		env.main.dispatchEvent(new env.window.Event("wheel", { bubbles: true }));
		assert.ok(env.drawnAttributes() > 0, "kept for two more frames");
		env.frame(() => { env.rows[0]!.real = 500; });
		env.frame();
		for (let i = 0; i < SETTLE_MAX_FRAMES; i++) env.frame();
		assert.equal(env.scrolls.length, placed, "no correction");
		assert.equal(env.topOf(target), 216);
		assert.equal(env.drawnAttributes(), 0);
	});

	it("a wheel or a touch on the dock, the lesson's sibling, cancels the check too", () => {
		for (const type of ["wheel", "touchstart", "pointerdown"]) {
			const rows = [{ kind: "card" as const, real: 300 }, ...Array.from({ length: 20 }, (_, i) => ({ kind: i % 2 ? "assistant" as const : "user" as const, real: i % 2 ? 900 : 50 }))];
			const env = setup({ rows });
			env.scrollTo(1e9);
			const target = env.passage(16);
			scrollSessionTarget(target, env.main, env.context);
			const placed = env.scrolls.length;
			env.frame();
			// The dock forwards the gesture by setting the lesson's scrollTop.
			const dock = env.document.createElement("div");
			env.document.body.appendChild(dock);
			dock.dispatchEvent(new env.window.Event(type, { bubbles: true }));
			env.frame(() => { env.rows[0]!.real = 500; });
			for (let i = 0; i < SETTLE_MAX_FRAMES; i++) env.frame();
			assert.equal(env.scrolls.length, placed, `${type}: no correction`);
			assert.equal(env.drawnAttributes(), 0, type);
		}
	});

	it("a scrolling key cancels the check, typing in a box doesn't", () => {
		const env = lesson();
		const target = env.passage(5);
		scrollSessionTarget(target, env.main, env.context);
		const input = env.document.createElement("input");
		env.document.body.appendChild(input);
		const key = (el: EventTarget, k: string) => { const e = new env.window.Event("keydown", { bubbles: true }); Object.defineProperty(e, "key", { value: k }); el.dispatchEvent(e); };
		key(input, "ArrowDown");
		assert.ok(env.pendingFrames() > 0, "still watching");
		key(env.document.body, "PageDown");
		env.frame();
		env.frame();
		assert.equal(env.pendingFrames(), 0);
		assert.equal(env.drawnAttributes(), 0);
	});

	it("another jump takes over: the first one's attributes go at once", () => {
		const env = lesson();
		scrollSessionTarget(env.passage(5), env.main, env.context);
		assert.equal(env.rows[5]!.el.hasAttribute(DRAW_ATTRIBUTE), true);
		const second = env.passage(21);
		scrollSessionTarget(second, env.main, env.context);
		assert.equal(env.rows[5]!.el.hasAttribute(DRAW_ATTRIBUTE), false);
		assert.equal(env.rows[21]!.el.hasAttribute(DRAW_ATTRIBUTE), true);
		assert.equal(env.topOf(second), 16);
		for (let i = 0; i < SETTLE_MAX_FRAMES && env.pendingFrames(); i++) env.frame();
		assert.equal(env.drawnAttributes(), 0);
	});

	it("a hidden tab (no frames) still loses the attribute, after the fallback", () => {
		const env = lesson();
		scrollSessionTarget(env.passage(5), env.main, env.context);
		assert.ok(env.drawnAttributes() > 0);
		env.runTimers();
		assert.equal(env.drawnAttributes(), 0);
		assert.ok(RELEASE_FALLBACK_MS >= 500);
	});

	it("an element target (the whole-message fallback, a link to a message) gets the same", () => {
		const env = lesson();
		const message = env.rows[7]!.el.querySelector("p") as unknown as HTMLElement;
		scrollSessionTarget(message, env.main, env.context);
		assert.equal(env.topOf(message), 16);
		assert.equal(env.rows[7]!.el.hasAttribute(DRAW_ATTRIBUTE), true);
	});
});

describe("when it does nothing more than the plain jump", () => {
	it("the rule is off: one placement, no attribute, no frame", () => {
		const env = lesson({ off: true });
		const target = env.passage(5);
		scrollSessionTarget(target, env.main, env.context);
		assert.equal(env.topOf(target), 16);
		assert.equal(env.scrolls.length, 1);
		assert.equal(env.drawnAttributes(), 0);
		assert.equal(env.pendingFrames(), 0);
	});

	it("everything near the passage is drawn already: no attribute, no frame", () => {
		const env = lesson();
		const target = env.passage(28);
		scrollSessionTarget(target, env.main, env.context);
		assert.equal(env.drawnAttributes(), 0);
		assert.equal(env.pendingFrames(), 0);
		assert.equal(env.scrolls.length, 1);
	});

	it("a DOM without computed styles or frames (the other tests'): place only", () => {
		const env = lesson({ browserApis: false });
		let placed = 0;
		revealOffscreenTarget(env.passage(5), env.main, () => { placed++; });
		assert.equal(placed, 1);
		assert.equal(env.drawnAttributes(), 0);
	});

	it("no scroller, or a target outside the lesson column: place only", () => {
		const env = lesson();
		let placed = 0;
		revealOffscreenTarget(env.passage(5), null, () => { placed++; });
		const outside = env.document.createElement("div");
		env.document.body.appendChild(outside);
		revealOffscreenTarget(outside as unknown as HTMLElement, env.main, () => { placed++; });
		assert.equal(placed, 2);
		assert.equal(env.drawnAttributes(), 0);
	});
});

describe("the helper and app/offscreen.css name the same messages", () => {
	const css = readFileSync(path.resolve(import.meta.dirname, "../app/offscreen.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
	const prefix = 'html:not([data-lh-offscreen="off"]) ';
	const selectorLists = [...css.matchAll(/([^{}@]+)\{[^{}]*content-visibility:\s*(auto|visible)[^{}]*\}/g)]
		.map((m) => ({ value: m[2], selectors: (m[1] ?? "").split(",").map((s) => s.trim()) }));
	it("the skipped messages are exactly OFFSCREEN_BLOCK_SELECTORS", () => {
		const auto = selectorLists.filter((l) => l.value === "auto").flatMap((l) => l.selectors);
		assert.deepEqual(auto, OFFSCREEN_BLOCK_SELECTORS.map((s) => prefix + s));
	});
	it("the draw attribute makes exactly those visible", () => {
		const visible = selectorLists.filter((l) => l.value === "visible").flatMap((l) => l.selectors);
		assert.deepEqual(visible, OFFSCREEN_BLOCK_SELECTORS.map((s) => `${prefix}${s}[${DRAW_ATTRIBUTE}]`));
	});
});
