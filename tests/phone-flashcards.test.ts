/**
 * FLASHCARDS ON A PHONE (docs/phone-plugins-plan.md, package B):
 * app/phone-flashcards.css and components/phone/flashcards-touch.ts.
 *
 * 1. The guard. The phone rules restyle upstream's markup (the plugin's own
 *    class names and the host components that render for it). Every class,
 *    data attribute, label and test id the stylesheet and the touch helper
 *    hang on is listed below with the upstream file that makes it; the test
 *    fails when upstream renames or drops one, and when the stylesheet grows
 *    a hook that isn't listed.
 * 2. The touch helper, driven with scripted events (as phone-hold-drag.test.ts):
 *    press and hold on a row opens that row's own ⚙ menu and the lift opens
 *    nothing else; the rename ✕ sends the plugin's own Esc without a blur;
 *    off the phone layout nothing is marked or answered.
 *
 * What it looks like and where boxes land with the keyboard up needs real
 * layout and is checked in a browser at iPhone size.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { parseHTML } from "linkedom";

const read = (file: string) => readFileSync(file, "utf8");
const pluginSources = readdirSync("plugins/flashcards/src").map((name) => join("plugins/flashcards/src", name));

// ── 1. The guard ─────────────────────────────────────────────────────────

/** Each hook, and the upstream files at least one of which must still make it. */
const PLUGIN = pluginSources;
const TREE = ["components/plugin-tree.tsx", "components/tree-presentation.tsx"];
const PICKER = ["components/chain-table.tsx", "components/source-folder-tree.tsx", "components/plugin-knowledge-picker.tsx", "components/tree-presentation.tsx"];
const HOOKS: Record<string, { files: string[]; as?: string }> = {
	// The plugin's own class names.
	"fc-root": { files: PLUGIN }, "fc-review-surface": { files: PLUGIN }, "fc-review-stage": { files: PLUGIN },
	"fc-review-card": { files: PLUGIN }, "fc-review-bottom": { files: PLUGIN }, "fc-review-footer": { files: PLUGIN },
	"fc-practice-surface": { files: PLUGIN }, "fc-practice-note": { files: PLUGIN }, "fc-actions": { files: PLUGIN },
	"fc-rating": { files: PLUGIN }, "fc-button": { files: PLUGIN }, "fc-shortcut": { files: PLUGIN },
	"fc-markdown": { files: PLUGIN }, "fc-answer": { files: PLUGIN }, "fc-tree-viewport": { files: PLUGIN },
	"fc-tree-inner": { files: PLUGIN }, "fc-tree-more": { files: PLUGIN }, "fc-tree-row-content": { files: PLUGIN },
	"fc-tree-label": { files: PLUGIN }, "fc-tree-name": { files: PLUGIN }, "fc-tree-rename": { files: PLUGIN },
	"fc-library": { files: PLUGIN }, "fc-dialog": { files: PLUGIN }, "fc-picker": { files: PLUGIN },
	"fc-check": { files: PLUGIN }, "fc-settings": { files: PLUGIN },
	// The plugin's labels on the rows' ⚙ (`${kind} actions`).
	"Deck actions": { files: ["plugins/flashcards/src/library-tree.js"], as: "'Deck'" },
	"Proposition actions": { files: ["plugins/flashcards/src/library-tree.js"], as: "'Proposition'" },
	"Cue actions": { files: ["plugins/flashcards/src/library-tree.js"], as: "'Cue'" },
	" actions": { files: ["plugins/flashcards/src/library-tree.js"], as: " actions`" },
	// The host's tree (the deck list).
	"data-plugin-tree": { files: TREE, as: "data-plugin-tree=" }, "data-plugin-tree-row": { files: TREE },
	"data-plugin-tree-depth": { files: TREE }, "data-plugin-tree-control": { files: TREE },
	"data-plugin-tree-column": { files: TREE }, "data-plugin-tree-cell": { files: TREE },
	"disclosure": { files: TREE, as: 'data-plugin-tree-control="disclosure"' },
	"selection": { files: TREE, as: 'data-plugin-tree-control="selection"' },
	"0": { files: TREE, as: "data-plugin-tree-depth={depth}" }, "1": { files: TREE, as: "data-plugin-tree-depth={depth}" },
	"2": { files: TREE, as: "data-plugin-tree-depth={depth}" },
	"aria-hidden": { files: TREE, as: 'aria-hidden="true"' }, "true": { files: TREE, as: 'aria-hidden="true"' },
	"border-b": { files: ["components/tree-presentation.tsx"] }, "h-5": { files: ["components/plugin-tree.tsx"] },
	"size-3\\.5": { files: ["components/tree-presentation.tsx"], as: "size-3.5 shrink-0" },
	// The host's button, surface, dialog, menu, page and pickers.
	"data-slot": { files: ["components/ui/button.tsx"], as: 'data-slot="button"' },
	"data-size": { files: ["components/ui/button.tsx"] }, "data-variant": { files: ["components/ui/button.tsx"] },
	"data-plugin-ui-widget": { files: ["components/plugin-ui-host.tsx"], as: "pluginUiWidget" },
	"data-plugin-session-surface-frame": { files: ["components/plugin-surface-shell.tsx"] },
	"Close": { files: ["components/plugin-surface-shell.tsx"], as: 'aria-label="Close"' },
	"data-plugin-ui-dialog": { files: ["components/plugin-ui-host.tsx"] },
	"data-plugin-ui-dialog-scroll": { files: ["components/plugin-ui-host.tsx"] },
	"Close dialog": { files: ["components/plugin-ui-host.tsx"], as: 'aria-label="Close dialog"' },
	"plugin-menu": { files: ["components/plugin-ui-host.tsx"], as: 'testid="plugin-menu"' },
	"Plugin settings": { files: ["components/plugin-view.tsx"], as: 'aria-label="Plugin settings"' },
	"data-plugin-model-picker": { files: ["components/plugin-model-picker.tsx"] },
	"data-plugin-thinking-picker": { files: ["components/plugin-model-picker.tsx"] },
	// The knowledge picker (the host's chain table).
	"data-plugin-knowledge-picker-pane": { files: ["components/plugin-knowledge-picker.tsx"] },
	"data-chain-nav-row": { files: PICKER }, "data-source-icon": { files: PICKER },
	"chain-table-search": { files: PICKER }, "add-source-folder": { files: PICKER }, "chain-table-close": { files: PICKER },
	"chain-selection-bar": { files: PICKER }, "sort-": { files: PICKER, as: 'data-testid="sort-' },
	"cluster-toggle-": { files: PICKER }, "chain-toggle-": { files: PICKER }, "folder-toggle-": { files: PICKER },
	"cluster-thread-": { files: PICKER }, "chain-thread-": { files: PICKER }, "prop-row-": { files: PICKER },
	"Rename": { files: PICKER, as: 'title="Rename"' },
	"px-3": { files: ["components/tree-presentation.tsx"] }, "pl-12": { files: ["components/tree-presentation.tsx"] },
	"pl-21": { files: ["components/tree-presentation.tsx"] }, "w-14": { files: PICKER }, "w-20": { files: PICKER },
	"relative": { files: ["components/chain-table.tsx"] },
	// The app's own (phone.css and the fork's runtime).
	"data-phone": { files: ["components/top-bar.tsx"], as: 'data-phone="topbar"' },
	"topbar": { files: ["components/top-bar.tsx"], as: 'data-phone="topbar"' },
	"data-phone-press": { files: ["components/phone/long-press.ts"] },
	"button": { files: ["components/ui/button.tsx"], as: 'data-slot="button"' },
	"custom": { files: ["components/ui/button.tsx"], as: '"custom"' },
	"icon-sm": { files: ["components/ui/button.tsx"], as: '"icon-sm"' },
	"icon-xs": { files: ["components/ui/button.tsx"], as: '"icon-xs"' },
	"icon": { files: ["components/ui/button.tsx"], as: "icon: " },
};
/** Hooks that are KaTeX's (math in the cards), the fork's own, or a
 *  plain element or ARIA role, not upstream's markup. */
const NOT_UPSTREAM = new Set(["lh-electron", "katex", "katex-display", "flashcards-rename-cancel", "aria-label", "data-testid", "role", "menu", "menuitem", "title", "type", "checkbox", "hidden"]);

/** The class names, attribute names and quoted attribute values in the stylesheet. */
function cssHooks(css: string): Set<string> {
	const body = css.replace(/\/\*[\s\S]*?\*\//g, "");
	const selectors = [...body.matchAll(/([^{}]+)\{/g)].map((m) => m[1] ?? "").filter((s) => !s.trim().startsWith("@"));
	const hooks = new Set<string>();
	for (const s of selectors) {
		for (const m of s.matchAll(/\.((?:[a-zA-Z_-]|\\.)(?:[\w-]|\\.)*)/g)) if (m[1]) hooks.add(m[1]);
		for (const m of s.matchAll(/\[([\w-]+)(?:[~^$*|]?="([^"]*)")?\]/g)) { if (m[1]) hooks.add(m[1]); if (m[2]) hooks.add(m[2]); }
	}
	return hooks;
}

describe("the guard: what the phone rules hang on still exists upstream", () => {
	const css = read("app/phone-flashcards.css");

	it("every hook in app/phone-flashcards.css is listed here", () => {
		const unlisted = [...cssHooks(css)].filter((hook) => !(hook in HOOKS) && !NOT_UPSTREAM.has(hook));
		assert.deepEqual(unlisted, [], "a new hook: add it to HOOKS with the upstream file that makes it");
	});

	it("every listed hook still occurs in the upstream file that makes it", () => {
		const missing: string[] = [];
		for (const [hook, { files, as }] of Object.entries(HOOKS)) {
			const needle = as ?? hook;
			if (!files.some((file) => read(file).includes(needle))) missing.push(`${hook} (looked for ${JSON.stringify(needle)} in ${files.join(", ")})`);
		}
		assert.deepEqual(missing, []);
	});

	it("KaTeX's two class names are KaTeX's", () => {
		const katex = read("node_modules/katex/dist/katex.css");
		assert.ok(katex.includes(".katex-display"));
		assert.ok(katex.includes(".katex "));
	});

	it("the touch helper's selectors are among the hooks", async () => {
		const touch = await import("../components/phone/flashcards-touch.ts");
		for (const selector of [touch.FLASHCARDS_ROOT, touch.FLASHCARDS_ROW, touch.ROW_MENU_BUTTON, touch.RENAME_INPUT]) {
			for (const hook of cssHooks(`${selector} {}`)) {
				if (NOT_UPSTREAM.has(hook)) continue;
				assert.ok(hook in HOOKS, `${hook} (from ${selector}) is listed`);
			}
		}
		assert.match(read("plugins/flashcards/src/library-tree.js"), /className = 'fc-tree-rename'|'fc-tree-rename'/);
		// The plugin cancels its rename on Esc and saves on Enter and on blur:
		// the ✕ sends that Esc.
		const tree = read("plugins/flashcards/src/library-tree.js");
		assert.match(tree, /event\.key === 'Escape'/);
		assert.match(tree, /event\.key === 'Enter'/);
		assert.match(tree, /addEventListener\('blur'/);
		// The ⚙ opens the row's menu with ctx.ui.openMenu on click.
		assert.match(tree, /ctx\.ui\.openMenu\(more/);
	});

	it("the stylesheet is loaded by the root layout", () => {
		assert.match(read("app/layout.tsx"), /import "\.\/phone-flashcards\.css";/);
	});
});

// ── 2. The touch helper ──────────────────────────────────────────────────

const dom = parseHTML(`<html><body>
	<div class="fc-root fc-library"><div data-plugin-tree="">
		<div data-plugin-tree-row="deck:1" id="deck"><input type="checkbox" id="deck-check"><div class="fc-tree-row-content">
			<span class="fc-tree-name" id="deck-name"><button class="fc-tree-label" id="deck-label">Physics</button></span>
			<span class="fc-tree-more"><button aria-label="Create card" id="deck-plus"></button><button aria-label="Deck actions" id="deck-gear"></button></span>
		</div></div>
		<div class="relative">
			<div data-plugin-tree-row="deck:1:p:1" id="prop"><div class="fc-tree-row-content"><span class="fc-tree-label" id="prop-label">Ohm's law</span>
				<span class="fc-tree-more"><button aria-label="Proposition actions" id="prop-gear"></button></span></div></div>
			<div data-plugin-tree-row="deck:1:p:1:cue:1" id="cue"><div class="fc-tree-row-content"><button class="fc-tree-label" id="cue-label">What is V?</button>
				<span class="fc-tree-more"><button aria-label="Cue actions" id="cue-gear"></button></span></div></div>
		</div>
		<div data-plugin-tree-row="archive" id="archive"><div class="fc-tree-row-content"><span class="fc-tree-label">Archive</span></div></div>
	</div></div>
	<div data-plugin-tree-row="elsewhere" id="elsewhere"><span class="fc-tree-more"><button aria-label="Deck actions"></button></span></div>
</body></html>`);
const { document } = dom;
const win = dom.window as unknown as Record<string, unknown>;

let phone = true;
class FakeMouseEvent extends dom.window.Event {
	clientX: number; clientY: number; button: number;
	/** As in a browser: an event the page makes itself isn't trusted. */
	readonly isTrusted = false;
	constructor(type: string, init: { bubbles?: boolean; cancelable?: boolean; clientX?: number; clientY?: number; button?: number } = {}) {
		super(type, init);
		this.clientX = init.clientX ?? 0; this.clientY = init.clientY ?? 0; this.button = init.button ?? 0;
	}
}
class FakeKeyboardEvent extends dom.window.Event {
	key: string; code: string;
	constructor(type: string, init: { bubbles?: boolean; cancelable?: boolean; key?: string; code?: string } = {}) {
		super(type, init);
		this.key = init.key ?? ""; this.code = init.code ?? "";
	}
}
Object.assign(win, {
	matchMedia: (query: string) => ({ matches: phone && query.includes("max-width"), addEventListener() {}, removeEventListener() {} }),
	KeyboardEvent: FakeKeyboardEvent,
	FocusEvent: dom.window.Event,
	MouseEvent: FakeMouseEvent,
	requestAnimationFrame: () => 0,
	cancelAnimationFrame: () => {},
	MutationObserver: undefined,
});
Object.assign(globalThis, { window: dom.window, document, CustomEvent: dom.window.CustomEvent, MouseEvent: FakeMouseEvent });

const { HOLD_MS, installLongPress } = await import("../components/phone/long-press.ts");
const { installFlashcardsTouch, PRESS_MARK, RENAME_CANCEL, RENAME_CANCEL_LABEL, rowMenuButton, scrollDelta, syncFlashcardsTouch } = await import("../components/phone/flashcards-touch.ts");

const el = (id: string) => document.getElementById(id)!;
function pointer(type: string, target: Element, over: Record<string, unknown> = {}) {
	const e = new dom.window.Event(type, { bubbles: true, cancelable: true });
	Object.assign(e, { pointerType: "touch", isPrimary: true, pointerId: 1, clientX: 100, clientY: 200, ...over });
	target.dispatchEvent(e);
	return e;
}
function plain(type: string, target: Element, init: Record<string, unknown> = {}) {
	const e = new dom.window.Event(type, { bubbles: true, cancelable: true });
	Object.assign(e, init);
	target.dispatchEvent(e);
	return e;
}
/** The buttons whose click listeners ran. */
const clicks: string[] = [];
const onClick = (e: Event) => { clicks.push((e.currentTarget as Element).id); };
const CLICKABLE = ["deck-gear", "prop-gear", "cue-gear", "deck-plus", "deck-label", "cue-label"];

let uninstall = () => {};
beforeEach(() => {
	phone = true;
	clicks.length = 0;
	mock.timers.enable({ apis: ["setTimeout"] });
	const offHold = installLongPress(document as unknown as Document);
	const offTouch = installFlashcardsTouch(document as unknown as Document);
	uninstall = () => { offTouch(); offHold(); };
	for (const id of CLICKABLE) el(id).addEventListener("click", onClick);
});
afterEach(() => {
	uninstall();
	for (const id of CLICKABLE) el(id).removeEventListener("click", onClick);
	mock.timers.reset();
});

describe("press and hold on a deck list row (decision 5b)", () => {
	it("marks only the plugin's rows that have a ⚙", () => {
		for (const id of ["deck", "prop", "cue"]) assert.equal(el(id).getAttribute("data-phone-press"), PRESS_MARK, id);
		assert.equal(el("archive").hasAttribute("data-phone-press"), false, "the archive row has no menu");
		assert.equal(el("elsewhere").hasAttribute("data-phone-press"), false, "outside the plugin");
		assert.equal(rowMenuButton(el("deck"))?.id, "deck-gear", "the row's own ⚙, not the + beside it");
	});

	for (const [row, target, gear] of [["deck", "deck-label", "deck-gear"], ["prop", "prop-label", "prop-gear"], ["cue", "cue-label", "cue-gear"]] as const) {
		it(`a hold on the ${row} row opens its own ⚙ menu, and the lift opens nothing else`, () => {
			pointer("pointerdown", el(target));
			mock.timers.tick(HOLD_MS);
			assert.deepEqual(clicks, [gear], "the ⚙ was pressed");
			pointer("pointerup", el(target));
			assert.equal(plain("touchend", el(target)).defaultPrevented, true, "no tap follows the lift");
			// A browser that sends the tap anyway: swallowed, so the card
			// doesn't open and the rename doesn't start. (long-press.ts stops
			// it at the document before the button sees it; linkedom has no
			// capture phase, so here that shows as a prevented click.)
			const tap = plain("click", el(target));
			assert.equal(tap.defaultPrevented, true);
		});
	}

	it("a short tap is still a tap", () => {
		pointer("pointerdown", el("cue-label"));
		mock.timers.tick(HOLD_MS - 100);
		pointer("pointerup", el("cue-label"));
		plain("click", el("cue-label"));
		assert.deepEqual(clicks, ["cue-label"]);
	});

	it("off the phone layout nothing is marked and a right-click isn't answered", () => {
		uninstall();
		phone = false;
		uninstall = (() => { const a = installLongPress(document as unknown as Document); const b = installFlashcardsTouch(document as unknown as Document); return () => { b(); a(); }; })();
		for (const id of ["deck", "prop", "cue"]) assert.equal(el(id).hasAttribute("data-phone-press"), false);
		const menu = new FakeMouseEvent("contextmenu", { bubbles: true, cancelable: true });
		el("deck-label").dispatchEvent(menu);
		assert.equal(menu.defaultPrevented, false);
		assert.deepEqual(clicks, []);
	});

	it("uninstalling takes the marks away", () => {
		uninstall();
		uninstall = () => {};
		assert.equal(document.querySelectorAll(`[data-phone-press="${PRESS_MARK}"]`).length, 0);
	});
});

describe("the rename ✕ (decision 5c)", () => {
	let input: HTMLInputElement;
	const plugin = { escapes: 0, enters: 0, blurs: 0 };
	beforeEach(() => {
		plugin.escapes = 0; plugin.enters = 0; plugin.blurs = 0;
		input = document.createElement("input") as unknown as HTMLInputElement;
		input.className = "fc-tree-rename";
		input.addEventListener("keydown", (e: Event) => {
			const key = (e as unknown as FakeKeyboardEvent).key;
			if (key === "Escape") plugin.escapes++;
			if (key === "Enter") plugin.enters++;
		});
		input.addEventListener("blur", () => { plugin.blurs++; });
		el("deck-name").prepend(input);
		syncFlashcardsTouch(document as unknown as Document, true);
	});
	afterEach(() => {
		input.remove();
		syncFlashcardsTouch(document as unknown as Document, true);
	});
	const cancel = () => input.nextElementSibling as HTMLElement;

	it("sits right after the open rename box, labelled Cancel, and goes with it", () => {
		assert.equal(cancel()?.getAttribute("data-phone"), RENAME_CANCEL);
		assert.equal(cancel().getAttribute("aria-label"), RENAME_CANCEL_LABEL);
		assert.equal(RENAME_CANCEL_LABEL, "Cancel");
		syncFlashcardsTouch(document as unknown as Document, true);
		assert.equal(document.querySelectorAll(`[data-phone="${RENAME_CANCEL}"]`).length, 1, "added once");
		input.remove();
		syncFlashcardsTouch(document as unknown as Document, true);
		assert.equal(document.querySelectorAll(`[data-phone="${RENAME_CANCEL}"]`).length, 0);
		el("deck-name").prepend(input);
		syncFlashcardsTouch(document as unknown as Document, true);
	});

	// The blur held back during a press (a capture listener ahead of the
	// plugin's own) needs a real browser's event phases: checked in the
	// browser run, with a blur forced while the finger is on the ✕.
	it("a tap sends the plugin's own Esc, and the press doesn't take the focus", () => {
		const down = pointer("pointerdown", cancel());
		assert.equal(down.defaultPrevented, true, "the press keeps the focus in the box");
		assert.equal(plain("mousedown", cancel()).defaultPrevented, true);
		pointer("pointerup", cancel());
		const click = plain("click", cancel());
		assert.equal(click.defaultPrevented, true);
		assert.equal(plugin.escapes, 1, "cancelled: the old name stays");
		assert.equal(plugin.enters, 0);
		assert.equal(plugin.blurs, 0, "no save");
	});

	it("a hold on the ✕ is the row's hold, not a cancel", () => {
		pointer("pointerdown", cancel());
		mock.timers.tick(HOLD_MS);
		assert.deepEqual(clicks, ["deck-gear"]);
		pointer("pointerup", cancel());
		plain("click", cancel());
		assert.equal(plugin.escapes, 0);
	});

	it("isn't there off the phone layout", () => {
		syncFlashcardsTouch(document as unknown as Document, false);
		assert.equal(document.querySelectorAll(`[data-phone="${RENAME_CANCEL}"]`).length, 0);
	});
});

describe("the keyboard: a focused box into the visible part", () => {
	it("scrolls only as far as needed, keeping a tall box's top in view", () => {
		const band = { top: 60, bottom: 328 };
		assert.equal(scrollDelta({ top: 100, bottom: 140 }, band), 0, "already visible");
		assert.equal(scrollDelta({ top: 342, bottom: 366 }, band), 46, "the rename box under the keyboard (the look: y 342 with 328 visible)");
		assert.equal(scrollDelta({ top: 20, bottom: 44 }, band), -48, "above the visible part");
		assert.equal(scrollDelta({ top: 278, bottom: 678 }, band), 210, "taller than the band: its top comes to the band's top");
	});
});
