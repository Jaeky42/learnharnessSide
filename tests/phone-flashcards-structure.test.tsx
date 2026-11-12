/**
 * FLASHCARDS ON A PHONE, THE STRUCTURE GUARD (app/phone-flashcards.css,
 * components/phone/flashcards-touch.ts). tests/phone-flashcards.test.ts
 * checks that the names the phone rules hang on still exist upstream; this
 * file checks the STRUCTURE the rules assume (children, siblings, order),
 * on real renders:
 *
 *   - the plugin's own screens (plugins/flashcards/src, bundled as the
 *     plugin's tests do), mounted on the plugin's own test host
 *     (plugins/flashcards/tests/ui-fixture.cjs): the library rows, the
 *     rename box, the review and practice surfaces, the loading moment;
 *   - the host's tree (components/plugin-tree.tsx) and the knowledge
 *     picker's table (components/chain-table.tsx), rendered on the server
 *     as their own tests do.
 *
 * Not rendered here, and so guarded by name only: the host's wrappers
 * around the plugin's widgets (the dialog frame and its close button, the
 * surface frame and its close button, the button's data-slot wrapper, the
 * plugin menu, the model pickers, the picker's pane). They live in portals
 * and interaction layers that need a full app; the browser run at iPhone
 * size covers them.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";
import { buildSync } from "esbuild";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { PluginTree } from "../components/plugin-tree.tsx";
import { ChainTableBody, type ChainSort } from "../components/chain-table.tsx";
import type { GraphChain, GraphNode } from "../src/core/contracts.ts";
import type { PluginTreeRow } from "../src/core/plugin-tree.ts";
import { LOADING_TEXT, reviewLoading, syncFlashcardsTouch } from "../components/phone/flashcards-touch.ts";

const require = createRequire(import.meta.url);
const { fixture, flush, deferred, createDocument } = require("../plugins/flashcards/tests/ui-fixture.cjs");
const source = buildSync({ entryPoints: [path.resolve("plugins/flashcards/src/main.js")], bundle: true, platform: "browser", format: "esm", write: false }).outputFiles[0]!.text;
const pluginUrl = "data:text/javascript;base64," + Buffer.from(source).toString("base64");

/** Each selector of the stylesheet (or the touch helper) that assumes
 *  structure, with the element it must find. */
const must = (root: ParentNode, selector: string, why: string) => assert.ok(root.querySelector(selector), `${why}: nothing matches ${selector}`);

async function plugin() {
	const document = createDocument();
	const { activate } = await import(pluginUrl);
	const h = fixture(document);
	activate(h.ctx); h.mount(); await flush();
	return { h, document: document as Document };
}
const click = (root: ParentNode, name: string) => {
	const button = [...root.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || b.textContent) === name);
	assert.ok(button, `button ${name}`);
	(button as HTMLButtonElement).click();
};

describe("the plugin's library (real plugin code on its own test host)", () => {
	it("rows: name, Review and the + / ⚙ group sit where the phone rules expect", async () => {
		const { h, document } = await plugin();
		must(document, ".fc-root.fc-library .fc-tree-viewport > .fc-tree-inner", "the list fits: .fc-tree-inner min-width");
		const deck = document.querySelector("[data-fc-occurrence='deck:d1']")!;
		assert.ok(deck.matches(".fc-tree-row-content"), "a row's content is .fc-tree-row-content");
		must(deck, ":scope > .fc-tree-name > button.fc-tree-label", "the name button (40 px tall)");
		must(deck, ":scope > .fc-button", "Review is a direct child (its size; hidden while renaming)");
		must(deck, ":scope > .fc-tree-more > .fc-button button[aria-label='Create card']", "the + (hidden while renaming)");
		must(deck, ":scope > .fc-tree-more button[aria-label='Deck actions']", "the ⚙ (the hold presses it)");
		h.dispose();
	});

	it("the rename box: input.fc-tree-rename is a direct child of .fc-tree-name, and the plugin's own Esc cancels it", async () => {
		const { h, document } = await plugin();
		const deck = () => document.querySelector("[data-fc-occurrence='deck:d1']")!;
		(deck().querySelector("button.fc-tree-label") as HTMLButtonElement).click();
		await flush();
		must(deck(), ":scope > .fc-tree-name > input.fc-tree-rename", "the rename rules (:has(> .fc-tree-name > .fc-tree-rename))");
		const input = deck().querySelector("input.fc-tree-rename") as HTMLInputElement;
		input.value = "Half typed"; input.dispatchEvent(new document.defaultView!.Event("input"));
		// The touch helper adds its ✕ right after the box.
		syncFlashcardsTouch(document, true);
		assert.equal(input.nextElementSibling?.getAttribute("data-phone"), "flashcards-rename-cancel");
		// What the ✕ sends: a keydown Escape. The plugin cancels; no save.
		const Esc = class extends document.defaultView!.Event { key = "Escape"; code = "Escape"; };
		input.dispatchEvent(new Esc("keydown", { bubbles: true, cancelable: true }));
		await flush();
		assert.equal(deck().querySelector("input.fc-tree-rename"), null, "closed");
		assert.equal(deck().querySelector("button.fc-tree-label")!.textContent, "Notes", "the old name stays");
		assert.ok(!h.calls.some(([op]: [string]) => op === "save-deck"), "nothing saved");
		syncFlashcardsTouch(document, true);
		assert.equal(document.querySelector("[data-phone='flashcards-rename-cancel']"), null, "the ✕ goes with the box");
		h.dispose();
	});
});

describe("the plugin's review and practice surfaces (real plugin code)", () => {
	it("card, count and footer are the stage's children; ratings sit in .fc-actions > .fc-rating", async () => {
		const { h, document } = await plugin();
		click(h.app, "Review all"); await flush();
		const surface = document.querySelector(".fc-review-surface")!;
		must(surface.parentElement!, ":scope > .fc-review-surface > .fc-review-stage > .fc-review-card:not([hidden])", "the pinned layout's :has(> .fc-review-stage > .fc-review-card:not([hidden]))");
		must(surface, ":scope > .fc-review-stage > .fc-review-bottom", "the count under the card");
		must(surface, ":scope > .fc-review-stage > .fc-review-footer .fc-actions > .fc-rating > .fc-button", "Reveal answer, full width");
		must(surface, ".fc-rating > .fc-shortcut", "the keyboard hint (hidden)");
		click(surface, "Reveal answer"); await flush();
		const ratings = [...surface.querySelectorAll(".fc-review-footer .fc-actions > .fc-rating > .fc-button button")].map((b) => b.textContent);
		assert.deepEqual(ratings.map((t) => t?.split(" ·")[0]), ["Again", "Hard", "Good", "Easy"], "stacked in this order");
		h.dispose();
	});

	it("between cards the stage is marked loading; the true end state is not", async () => {
		const wait = deferred();
		const { h, document } = await plugin();
		let calls = 0;
		h.overrides["next-review"] = async () => {
			calls++;
			if (calls === 1) return { ticket: { id: "t1", propositionName: "Fact one", question: "Question **one**?" }, remaining: 1 };
			await wait.promise;
			return { ticket: null };
		};
		h.overrides["reveal-review"] = async () => ({ answer: "SECRET ANSWER", intervals: { 1: 60000, 2: 300000, 3: 600000, 4: 86400000 } });
		h.overrides["rate-review"] = async () => ({ ok: true });
		click(h.app, "Review all"); await flush();
		const stage = () => document.querySelector(".fc-review-stage")!;
		syncFlashcardsTouch(document, true);
		assert.equal(stage().hasAttribute("data-phone-review"), false, "a card shows: the card rule applies");
		click(stage(), "Reveal answer"); await flush();
		const good = [...stage().querySelectorAll("button")].find((b) => b.textContent?.startsWith("Good"))!;
		(good as HTMLButtonElement).click(); await flush();
		// The plugin now waits for the next card: card hidden, the loading line.
		assert.equal(stage().querySelector(".fc-review-card")!.hasAttribute("hidden"), true);
		assert.equal(stage().querySelector(".fc-review-footer")!.textContent, LOADING_TEXT);
		assert.equal(reviewLoading(stage()), true);
		syncFlashcardsTouch(document, true);
		assert.equal(stage().getAttribute("data-phone-review"), "loading");
		wait.resolve(); await flush(); await flush();
		assert.equal(stage().querySelector(".fc-review-footer")!.textContent, "No cards due in this selection.");
		syncFlashcardsTouch(document, true);
		assert.equal(stage().hasAttribute("data-phone-review"), false, "the end state keeps upstream's layout");
		h.dispose();
	});

	it("practice: the note is the surface's child, after the stage", async () => {
		const { h, document } = await plugin();
		click(h.app, "Practice all"); await flush();
		must(document, ".fc-practice-surface > .fc-review-stage + .fc-practice-note", "the practice note under the stage");
		h.dispose();
	});
});

// ── The host's tree and the picker's table, rendered on the server ─────────

function ssr(node: React.ReactElement) {
	return parseHTML(`<html><body>${renderToStaticMarkup(<InteractionLayersProvider>{node}</InteractionLayersProvider>)}</body></html>`).document;
}

describe("the host's tree (the deck list)", () => {
	const rows: PluginTreeRow[] = [
		{ key: "deck", content: "Deck", selection: { label: "Select deck", checked: false, onChange() {} }, cells: { due: "1" },
			disclosure: { label: "Toggle deck", expanded: true, onChange() {} },
			children: [{ key: "prop", content: "Prop", selection: { label: "Select prop", checked: false, onChange() {} },
				disclosure: { label: "Toggle prop", expanded: true, onChange() {} },
				children: [{ key: "cue", content: "Cue", selection: { label: "Select cue", checked: false, onChange() {} } }] }] },
		{ key: "archive", content: "Archive" },
	];
	const doc = ssr(<PluginTree label="Flashcards library" header="Name" rows={rows} columns={[{ key: "due", header: "Due", width: "3rem" }]} signal={new AbortController().signal} renderContent={() => null} />);

	it("the header is a direct child with the two spacers and the columns", () => {
		must(doc, "[data-plugin-tree] > div.border-b", "the header row's padding");
		must(doc, "[data-plugin-tree] > div.border-b > span[aria-hidden='true'][class~='size-3.5']", "the checkbox column's spacer");
		must(doc, "[data-plugin-tree] > div.border-b > span[aria-hidden='true'][class~='h-5']", "the arrow column's spacer");
		must(doc, "[data-plugin-tree] > div.border-b [data-plugin-tree-column]", "the hidden column headers");
	});

	it("rows: depth, the two controls, the cells; a guide right after an open row; spacers where a control is missing", () => {
		for (const depth of ["0", "1", "2"]) must(doc, `[data-plugin-tree-row][data-plugin-tree-depth='${depth}']`, `depth ${depth}`);
		must(doc, "[data-plugin-tree-row] > [data-plugin-tree-control='selection']", "the drawn checkbox");
		must(doc, "[data-plugin-tree-row] > [data-plugin-tree-control='disclosure']", "the 40 px arrow");
		must(doc, "[data-plugin-tree-row] [data-plugin-tree-cell]", "the hidden cells");
		for (const depth of ["0", "1"]) must(doc, `[data-plugin-tree-row][data-plugin-tree-depth='${depth}'] + div[aria-hidden='true']`, `the guide under an open depth-${depth} row`);
		must(doc, "[data-plugin-tree-row][data-plugin-tree-depth='2'] > span[aria-hidden='true'][class~='h-5']", "a cue row's arrow spacer");
		must(doc, "[data-plugin-tree-row='archive'] > span[aria-hidden='true'][class~='size-3.5']", "a row without a checkbox");
	});
});

describe("the knowledge picker's table", () => {
	const node = (id: string, name: string, chatId: string) => ({ id, name, statement: `Statement ${name}.`, aliases: [], state: "new", createdAt: "2026-09-20T10:00:00.000Z", provenance: [{ chatId, messageId: `m_${id}` }] }) as unknown as GraphNode;
	const nodes = [node("a", "Premise", "chat1"), node("c", "Conclusion", "chat1")];
	const chains: GraphChain[] = [{ id: "c1", premises: ["a"], conclusion: "c", provenance: [], createdAt: "2026-09-20T10:00:00.000Z" } as GraphChain];
	const noop = () => {};
	const doc = ssr(<ChainTableBody nodes={nodes} chains={chains} sessions={{ chat1: "A lesson" }} fileSources={{}} query="" onQuery={noop}
		sort={{ col: "name", dir: 1 } as ChainSort} onSort={noop} selection={new Set(["a"])} selectMode pickerChrome
		expandedClusters={new Set(["chat1"])} expandedChains={new Set(["c1"])} onToggleCluster={noop} onToggleChain={noop} onToggleNodes={noop}
		onClear={noop} onDelete={noop} onClose={noop} onSelect={noop} />);

	it("the top bar: the count first, then the search's wrapper, then the close button", () => {
		must(doc, "header[data-phone='topbar'] > span:first-child", "the count (not cut)");
		must(doc, "header[data-phone='topbar'] > div.relative > [data-testid='chain-table-search']", "the search takes the rest");
		must(doc, "header[data-phone='topbar'] > [data-testid='chain-table-close']", "the 40 px close");
	});

	it("rows: the staircase classes, the number cells as the rows' children, the two sort headers, the guides", () => {
		must(doc, "[data-chain-nav-row][class~='px-3']", "a source row");
		must(doc, "[data-chain-nav-row][class~='pl-12']", "a chain row");
		must(doc, "[data-chain-nav-row][class~='pl-21']", "a node row");
		must(doc, "[data-chain-nav-row] > span[class~='w-14']", "the Props cells (hidden)");
		must(doc, "[data-chain-nav-row] > span[class~='w-20']", "the Created cells (hidden)");
		must(doc, "[data-testid='sort-props']", "the Props header (hidden)");
		must(doc, "[data-testid='sort-created']", "the Created header (hidden)");
		must(doc, "[data-testid='sort-name']", "sorting by name stays");
		must(doc, "[data-chain-nav-row] input[type='checkbox']", "the drawn checkbox");
		must(doc, "[data-chain-nav-row] [data-source-icon]", "the book icon");
		must(doc, "[data-testid^='cluster-toggle-']", "the source's arrow");
		must(doc, "[data-testid^='chain-toggle-']", "the chain's arrow");
		must(doc, "[data-testid^='cluster-thread-']", "the source's guide");
		must(doc, "[data-testid^='chain-thread-']", "the chain's guide");
		must(doc, "[data-testid='chain-selection-bar'] button", "the selection bar's buttons");
	});
});
