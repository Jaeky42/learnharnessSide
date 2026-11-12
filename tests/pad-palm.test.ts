/**
 * DRAWING PAD PALM REJECTION PINS (owner's iPad): a palm resting on the pad
 * became one big text selection the Pencil couldn't get past. Finger and palm
 * touches on the pad's drawing area are cancelled, the Pencil never is, any
 * touch there clears a stuck selection, and the pad can't be selected
 * (components/phone/pad-palm.ts, app/touch.css). Upstream's Drawing Pad is
 * unchanged.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";

const dom = parseHTML(`<html><body>
	<div data-plugin-session-surface-frame="">
		<div class="drawing-pad-root">
			<div class="drawing-pad-tools"><span><button id="pen">Pen</button></span></div>
			<div class="drawing-pad-viewport"><div class="drawing-pad-paper"><canvas id="ink"></canvas></div></div>
		</div>
		<button id="close">Close</button>
	</div>
	<textarea id="tutor-box"></textarea>
	<p id="lesson">Lesson text</p>
</body></html>`);
const { document } = dom;

let userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15";
Object.defineProperty(globalThis, "navigator", { configurable: true, get: () => ({ userAgent }) });
Object.assign(dom.window, { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
Object.assign(globalThis, { window: dom.window, document, Element: dom.window.Element });

// A selection of page text that can be cleared.
let ranges = 1;
let cleared = 0;
Object.assign(document, { getSelection: () => ({ get rangeCount() { return ranges; }, removeAllRanges() { ranges = 0; cleared++; } }) });

const { installPadPalm } = await import("../components/phone/pad-palm.ts");

const el = (id: string) => document.getElementById(id)!;
type Point = { id: number; type: "direct" | "stylus" };
function touch(type: string, target: Element, changed: Point[], down: Point[] = changed) {
	const e = new dom.window.Event(type, { bubbles: true, cancelable: true });
	const shape = (p: Point) => ({ identifier: p.id, clientX: 100, clientY: 100, touchType: p.type, target });
	Object.assign(e, { changedTouches: changed.map(shape), touches: down.map(shape) });
	target.dispatchEvent(e);
	return e;
}
const finger = (id = 1): Point => ({ id, type: "direct" });
const pencil = (id = 9): Point => ({ id, type: "stylus" });

let uninstall = () => {};
afterEach(() => {
	uninstall();
	ranges = 1;
	cleared = 0;
	userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15";
	(document.activeElement as HTMLElement | null)?.blur?.();
});

describe("a palm or finger on the pad's drawing area", () => {
	it("is cancelled from the moment it lands until it lifts, and clears a stuck selection", () => {
		uninstall = installPadPalm(document as unknown as Document);
		assert.equal(touch("touchstart", el("ink"), [finger()]).defaultPrevented, true, "no press and hold, so no selection");
		assert.equal(cleared, 1, "the stuck selection goes");
		assert.equal(touch("touchmove", el("ink"), [finger()]).defaultPrevented, true);
		touch("touchend", el("ink"), [finger()], []);
		assert.equal(touch("touchmove", el("lesson"), [finger(2)]).defaultPrevented, false, "after it lifts, other touches are left alone");
	});

	it("never cancels the Pencil, which still clears a selection", () => {
		uninstall = installPadPalm(document as unknown as Document);
		assert.equal(touch("touchstart", el("ink"), [pencil()]).defaultPrevented, false);
		assert.equal(cleared, 1);
		assert.equal(touch("touchmove", el("ink"), [pencil()]).defaultPrevented, false);
	});

	it("leaves a touch alone that carries the Pencil and a palm together", () => {
		uninstall = installPadPalm(document as unknown as Document);
		assert.equal(touch("touchstart", el("ink"), [finger(), pencil()]).defaultPrevented, false);
	});

	it("a palm already down doesn't stop the Pencil that follows", () => {
		uninstall = installPadPalm(document as unknown as Document);
		assert.equal(touch("touchstart", el("ink"), [finger()]).defaultPrevented, true);
		assert.equal(touch("touchstart", el("ink"), [pencil()], [finger(), pencil()]).defaultPrevented, false);
		assert.equal(touch("touchmove", el("ink"), [pencil()], [finger(), pencil()]).defaultPrevented, false, "the Pencil's moves");
		assert.equal(touch("touchmove", el("ink"), [finger()], [finger(), pencil()]).defaultPrevented, true, "the palm's moves");
	});
});

describe("everything else", () => {
	it("the pad's buttons and its ✕ still take a finger tap", () => {
		uninstall = installPadPalm(document as unknown as Document);
		assert.equal(touch("touchstart", el("pen"), [finger()]).defaultPrevented, false);
		assert.equal(touch("touchstart", el("close"), [finger()]).defaultPrevented, false);
		assert.equal(cleared, 0);
	});

	it("outside the pad nothing changes: the lesson's text can still be selected", () => {
		uninstall = installPadPalm(document as unknown as Document);
		assert.equal(touch("touchstart", el("lesson"), [finger()]).defaultPrevented, false);
		assert.equal(cleared, 0);
	});

	it("doesn't clear a selection while the cursor is in a text box (the Tutor's)", () => {
		uninstall = installPadPalm(document as unknown as Document);
		Object.defineProperty(document, "activeElement", { configurable: true, get: () => el("tutor-box") });
		try {
			touch("touchstart", el("ink"), [pencil()]);
			assert.equal(cleared, 0);
		} finally {
			delete (document as unknown as Record<string, unknown>).activeElement;
		}
	});

	it("does nothing in the desktop app", () => {
		userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Electron/38.0.0 Safari/537.36";
		uninstall = installPadPalm(document as unknown as Document);
		assert.equal(touch("touchstart", el("ink"), [finger()]).defaultPrevented, false);
		assert.equal(cleared, 0);
	});
});

describe("the pad itself", () => {
	const root = path.join(import.meta.dirname, "..");
	it("can't be selected, and iOS's press-and-hold menu is off on it (app/touch.css)", () => {
		const css = fs.readFileSync(path.join(root, "app", "touch.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
		assert.match(css, /html:not\(\.lh-electron\) \.drawing-pad-root,\s*html:not\(\.lh-electron\) \[data-plugin-session-surface-frame\]:has\(\.drawing-pad-root\)\s*\{[^}]*-webkit-user-select:\s*none;[^}]*user-select:\s*none;[^}]*-webkit-touch-callout:\s*none;/);
	});

	it("still has the class names this relies on (upstream's plugins/drawing-pad)", () => {
		const sheet = fs.readFileSync(path.join(root, "plugins", "drawing-pad", "src", "sheet.ts"), "utf8");
		assert.match(sheet, /className = "drawing-pad-root"/);
		assert.match(sheet, /className = "drawing-pad-viewport"/);
		assert.match(sheet, /className = "drawing-pad-tools"/, "the toolbar is outside the drawing area");
		const surface = fs.readFileSync(path.join(root, "components", "plugin-surface-shell.tsx"), "utf8");
		assert.match(surface, /data-plugin-session-surface-frame=""/);
	});

	it("is switched on with the other touch helpers", () => {
		assert.match(fs.readFileSync(path.join(root, "components", "phone", "phone-runtime.tsx"), "utf8"), /useEffect\(\(\) => installPadPalm\(\), \[\]\);/);
	});
});
