/**
 * RICH CODE BLOCKS ON A PHONE (fork; docs/phone-plugins-plan.md, decisions
 * 7 and 8; app/phone-rich-code-blocks.css and
 * components/phone/rich-drawing-frame.tsx).
 *
 * - The guard: every name of the plugin's and the host's that the fork's CSS
 *   and frame rely on still occurs in their source, so an upstream rename
 *   fails here instead of quietly turning the phone rules off.
 * - The enlarge button: phone only, on every drawn block of the three kinds,
 *   none while a block is drawn or after it failed; it opens the lesson's
 *   viewer with a themed copy of the picture.
 * - Pending and failed, with the plugin's real renderer: a block being drawn
 *   matches the spinner rule; one that failed (bad TikZ, the 10-second limit)
 *   is removed by the plugin, so nothing matches it and no spinner is left.
 *
 * The phone layout is played by a scripted matchMedia (linkedom has no CSS);
 * the CSS selectors are read from the stylesheet and run against the DOM.
 */

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, it, mock } from "node:test";
import { parseHTML } from "linkedom";

const root = path.resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const pluginSource = readdirSync(path.join(root, "plugins/rich-code-blocks/src")).map((f) => read(`plugins/rich-code-blocks/src/${f}`)).join("\n");
const css = read("app/phone-rich-code-blocks.css").replace(/\/\*[\s\S]*?\*\//g, "");

const dom = parseHTML("<!doctype html><html><head></head><body></body></html>");
let phone = false;
Object.assign(dom.window, {
	matchMedia: (query: string) => ({ matches: phone && query.includes("max-width"), addEventListener() {}, removeEventListener() {} }),
	getSelection: () => ({ anchorNode: null, focusNode: null, anchorOffset: 0, focusOffset: 0, rangeCount: 0 }),
});
Object.assign(globalThis, {
	window: dom.window, self: dom.window, document: dom.document, DOMParser: dom.window.DOMParser, XMLSerializer: dom.window.XMLSerializer,
	HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { renderToStaticMarkup } = await import("react-dom/server");
const { PhoneRichDrawingFrame, drawingCopy, RICH_DRAWING_LANGUAGES, RICH_BLOCK_CLASS, RICH_RENDERED_CLASS } = await import("../components/phone/rich-drawing-frame.tsx");
const { SessionMermaidContext, MermaidOverlay } = await import("../components/session-overlay.tsx");
const { InteractionLayersProvider } = await import("../components/interaction-layers.tsx");
const { RenderService } = await import("../plugins/rich-code-blocks/src/render.ts");

const roots: { root: import("react-dom/client").Root; host: HTMLElement }[] = [];
afterEach(async () => {
	for (const { root: r, host } of roots.splice(0)) {
		await act(async () => r.unmount());
		host.remove();
	}
	phone = false;
});
const settle = () => act(async () => new Promise<void>((r) => setTimeout(r, 10)));
async function mount(node: React.ReactNode) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const r = createRoot(host);
	roots.push({ root: r, host });
	await act(async () => r.render(node));
	await settle();
	return host;
}
const press = async (element: Element) => {
	const key = Object.keys(element).find((k) => k.startsWith("__reactProps$"))!;
	await act(async () => { (element as unknown as Record<string, { onClick(e: { detail: number; currentTarget: null }): void }>)[key]!.onClick({ detail: 0, currentTarget: null }); });
	await settle();
};

/** The selectors of one stylesheet rule set, without the phone scope and
 *  pseudo-elements, ready for querySelector. */
function cssSelectors(): string[] {
	return [...css.matchAll(/(html:not\(\.lh-electron\)[^{]+)\{/g)].flatMap((m) => m[1]!.split(","))
		.map((s) => s.trim().replace(/^html:not\(\.lh-electron\)\s+/, "").replace(/::after$/, "").replace(/\s*>\s*(pre|svg)$/, ""));
}
const SPINNER = cssSelectors().find((s) => s.includes(":not("))!;
const SHRINK = cssSelectors().find((s) => s.includes("[data-language]"))!;

describe("the guard: the names the phone rules rely on", () => {
	it("the plugin still draws into .rich-code-blocks, marks a drawn block --rendered with its data-language, and shows source in a pre until then", () => {
		assert.match(pluginSource, /root\.className = "rich-code-blocks"/);
		assert.match(pluginSource, /root\.classList\.add\("rich-code-blocks--rendered"\)/);
		assert.match(pluginSource, /root\.dataset\.language = block\.language/);
		assert.match(pluginSource, /document\.createElement\("pre"\)/);
		assert.match(pluginSource, /root\.replaceChildren\(safe\)/, "the drawn picture replaces the source");
		assert.equal(RICH_BLOCK_CLASS, "rich-code-blocks");
		assert.equal(RICH_RENDERED_CLASS, "rich-code-blocks--rendered");
	});
	it("a failure still removes the plugin's block and leaves the error and source to the host", () => {
		assert.match(pluginSource, /block\.signal\.removeEventListener\("abort", abort\); root\.remove\(\);/);
		assert.match(pluginSource, /throw error; \/\/ The public host renderer boundary supplies error \+ readable raw source\./);
		assert.match(read("components/plugin-renderers.tsx"), /data-plugin-renderer=\{label\}/);
		assert.match(read("components/plugin-renderers.tsx"), /\{failed && <p role="alert"/);
	});
	it("the theme's ink still comes from the plugin's block class, so the viewer's copy follows the theme", () => {
		assert.match(pluginSource, /\.rich-code-blocks \{[^}]*--rich-code-blocks-black: var\(--foreground, currentColor\)/);
		assert.match(pluginSource, /var\(--rich-code-blocks-black\)/);
		assert.match(pluginSource, /\.rich-code-blocks--rendered\[data-language="tikz"\] > svg \{\s*max-width: none;/, "the rule the phone's shrink outranks");
	});
	it("the three languages are the plugin's own", () => {
		assert.deepEqual(RICH_DRAWING_LANGUAGES, ["smiles", "abc", "tikz"]);
		assert.match(pluginSource, /chemicalStructures: "smiles", musicalNotation: "abc", technicalDiagrams: "tikz"/);
	});
	it("every class and attribute in the phone stylesheet occurs in the plugin's or the host's source", () => {
		const host = read("components/plugin-renderers.tsx");
		const names = new Set([...css.matchAll(/\.([a-z][\w-]*)|\[([a-z-]+)/g)].map((m) => m[1] ?? m[2]!).filter((n) => n !== "lh-electron"));
		assert.ok(names.size >= 3);
		for (const name of names) assert.ok(pluginSource.includes(name) || host.includes(name), `${name} is no longer in the plugin or the host`);
	});
	it("the button is the lesson's own (md-blocks' mermaid control), and md-blocks mounts the frame around the plugin's block", () => {
		const md = read("components/md-blocks.tsx");
		const frame = read("components/phone/rich-drawing-frame.tsx");
		const own = /label="Open full-screen"[\s\S]*?aria-label="Expand diagram"[\s\S]*?className="(flex size-6 items-center justify-center rounded-md text-muted-foreground\/70) opacity-0 (transition-opacity hover:bg-accent hover:text-foreground) group-hover\/md:opacity-100"[\s\S]*?<MaximizeIcon className="size-3\.5" \/>/.exec(md);
		assert.ok(own, "md-blocks' enlarge button");
		assert.ok(frame.includes(`className="${own[1]} ${own[2]}"`), "the same look, always shown");
		assert.match(frame, /<Hint label="Open full-screen" side="bottom">/);
		assert.match(md, /<PhoneRichDrawingFrame language=\{language\}><PluginCodeBlock /);
		assert.match(read("components/chat.tsx"), /openDrawing: drawing => setFigureFocus\(\{ drawing \}\)/);
	});
});

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 50" width="400pt" height="50pt"><defs><clipPath id="c1"><path d="M0 0L5 5"/></clipPath></defs><g clip-path="url(#c1)"><path d="M0 0L10 10" fill="var(--rich-code-blocks-black)"/></g></svg>';
/** A plugin block as the plugin leaves it: drawing (source in a pre) or drawn. */
function pluginBlock(state: "drawing" | "drawn", language = "tikz"): HTMLElement {
	const block = document.createElement("div");
	block.className = "rich-code-blocks";
	block.dataset.language = language;
	if (state === "drawing") block.innerHTML = "<pre><code>\\begin{tikzpicture}</code></pre>";
	else { block.classList.add("rich-code-blocks--rendered"); block.innerHTML = SVG; }
	return block;
}
function Lesson({ language, opened, into }: { language: string; opened?: string[]; into?: (el: HTMLDivElement | null) => void }) {
	const value = { openMermaid() {}, openFigure() {}, ...(opened ? { openDrawing: (d: string) => { opened.push(d); } } : {}) };
	return <SessionMermaidContext.Provider value={value}><PhoneRichDrawingFrame language={language}><div data-plugin-renderer={`Plugin code block (${language})`} ref={into} /></PhoneRichDrawingFrame></SessionMermaidContext.Provider>;
}

describe("the enlarge button", () => {
	it("is not there on a computer: the frame adds nothing to the page", async () => {
		phone = false;
		const html = renderToStaticMarkup(<Lesson language="tikz" opened={[]} />);
		assert.equal(html, '<div data-plugin-renderer="Plugin code block (tikz)"></div>');
		let mountPoint: HTMLDivElement | null = null;
		const host = await mount(<Lesson language="tikz" opened={[]} into={(el) => { mountPoint = el; }} />);
		mountPoint!.append(pluginBlock("drawn"));
		await settle();
		assert.equal(host.querySelector('[data-testid="rich-drawing-frame"]'), null);
		assert.equal(host.querySelector('[aria-label="Expand diagram"]'), null);
	});

	it("is not there for an ordinary code fence on a phone", async () => {
		phone = true;
		const host = await mount(<Lesson language="js" opened={[]} />);
		assert.equal(host.querySelector('[data-testid="rich-drawing-frame"]'), null);
	});

	for (const language of ["smiles", "abc", "tikz"]) it(`shows on a drawn ${language} block on a phone, never while it is drawn or after it failed`, async () => {
		phone = true;
		const opened: string[] = [];
		let mountPoint: HTMLDivElement | null = null;
		const host = await mount(<Lesson language={language} opened={opened} into={(el) => { mountPoint = el; }} />);
		const block = pluginBlock("drawing", language);
		mountPoint!.append(block);
		await settle();
		assert.equal(host.querySelector('[aria-label="Expand diagram"]'), null, "no button while the block is drawn");
		block.classList.add("rich-code-blocks--rendered");
		block.innerHTML = SVG;
		await settle();
		const button = host.querySelector('[data-testid="rich-drawing-expand"]');
		assert.ok(button, "the button once the picture is there");
		assert.equal(button.getAttribute("aria-label"), "Expand diagram");
		await press(button);
		assert.equal(opened.length, 1);
		assert.match(opened[0]!, /^<div class="rich-code-blocks"><svg /, "a copy inside the plugin's block class, so the theme's ink applies");
		assert.ok(opened[0]!.includes('viewBox="0 0 400 50"'));
		assert.ok(host.querySelector("svg")!.outerHTML.includes('id="c1"'), "the lesson's drawing is untouched");
		block.remove();
		await settle();
		assert.equal(host.querySelector('[aria-label="Expand diagram"]'), null, "the plugin removed a failed block: no button");
	});

	it("is not there where no lesson viewer is mounted", async () => {
		phone = true;
		let mountPoint: HTMLDivElement | null = null;
		const host = await mount(<Lesson language="tikz" into={(el) => { mountPoint = el; }} />);
		mountPoint!.append(pluginBlock("drawn"));
		await settle();
		assert.equal(host.querySelector('[aria-label="Expand diagram"]'), null);
	});

	it("the copy's ids are renamed, with every reference to them", () => {
		const holder = document.createElement("div");
		holder.innerHTML = SVG;
		const copy = drawingCopy(holder.querySelector("svg")!);
		const id = /<clipPath id="([^"]+)"/i.exec(copy)![1]!;
		assert.notEqual(id, "c1");
		assert.ok(copy.includes(`clip-path="url(#${id})"`));
		assert.ok(!copy.includes("#c1"));
	});

	it("the lesson's viewer shows the copy as it is, in the page (the inline chart branch)", () => {
		const markup = `<div class="rich-code-blocks">${SVG}</div>`;
		const html = renderToStaticMarkup(<InteractionLayersProvider><MermaidOverlay drawing={markup} onClose={() => {}} /></InteractionLayersProvider>);
		assert.ok(html.includes('data-testid="mermaid-overlay"'));
		assert.match(html, /<div data-lh-overlay-chart="true" class="\[&amp;_svg\]:h-auto \[&amp;_svg\]:w-full"><div class="rich-code-blocks"><svg /);
		assert.ok(html.includes('aria-label="Zoom in"') && html.includes('aria-label="Zoom out"'));
		assert.ok(!html.includes("bg-white"), "not the figure mode's white stage");
	});
});

describe("drawing and failed, with the plugin's real renderer", () => {
	/** A TeX worker the test plays: answers with an svg, an error, or never. */
	function fakeWorker(answer: "svg" | "error" | "never") {
		return class {
			onmessage: ((e: { data: unknown }) => void) | null = null;
			onerror = null; onmessageerror = null;
			postMessage(message: { id: number }) {
				if (answer === "never") return;
				queueMicrotask(() => this.onmessage?.({ data: answer === "svg" ? { id: message.id, svg: SVG } : { id: message.id, error: "! Undefined control sequence." } }));
			}
			terminate() {}
		};
	}
	async function draw(answer: "svg" | "error" | "never", timers = false) {
		const OldWorker = (globalThis as { Worker?: unknown }).Worker;
		(globalThis as { Worker?: unknown }).Worker = fakeWorker(answer);
		const page = document.createElement("div");
		page.innerHTML = '<div data-plugin-renderer="Plugin code block (tikz)"></div>';
		document.body.append(page);
		const container = page.firstElementChild as HTMLElement;
		const service = new RenderService();
		const controller = new AbortController();
		const result = service.mount(container, { language: "tikz", source: "\\begin{tikzpicture}\\draw (0,0) -- (1,1);\\end{tikzpicture}", meta: "", incomplete: false, signal: controller.signal });
		const drawing = { spinner: page.querySelector(SPINNER), source: page.querySelector(`${SPINNER} > pre`) };
		if (timers) mock.timers.tick(10_000);
		const outcome = await result.then(() => "drawn", (e: Error) => e.message);
		const after = { spinner: page.querySelector(SPINNER), drawn: page.querySelector(`${SHRINK} > svg`) };
		service.dispose(); page.remove();
		(globalThis as { Worker?: unknown }).Worker = OldWorker;
		return { drawing, outcome, after };
	}

	it("a block being drawn matches the spinner rule, with its source hidden", async () => {
		// linkedom can't parse the picture, so the plugin's own check refuses it
		// afterwards (the drawn state is seen in the browser run); either way
		// the block leaves the spinner rule once the drawing has settled.
		const { drawing, after } = await draw("svg");
		assert.ok(drawing.spinner, "the spinner box");
		assert.ok(drawing.source, "the plugin's source, which the rule hides");
		assert.equal(after.spinner, null);
	});

	it("bad TikZ: the plugin removes its block, so no spinner is left", async () => {
		const { outcome, after } = await draw("error");
		assert.equal(outcome, "! Undefined control sequence.");
		assert.equal(after.spinner, null);
	});

	it("over the 10-second limit: the same, no spinner is left", async () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		try {
			const { drawing, outcome, after } = await draw("never", true);
			assert.ok(drawing.spinner);
			assert.equal(outcome, "TeX rendering exceeded 10 seconds.");
			assert.equal(after.spinner, null);
		} finally { mock.timers.reset(); }
	});

	it("the selectors are the stylesheet's: the spinner never matches a drawn block, the shrink only a drawn one", () => {
		assert.equal(SPINNER, "[data-plugin-renderer] .rich-code-blocks:not(.rich-code-blocks--rendered)");
		assert.equal(SHRINK, ".rich-code-blocks--rendered[data-language]");
		const page = document.createElement("div");
		page.innerHTML = '<div data-plugin-renderer="x"></div>';
		page.firstElementChild!.append(pluginBlock("drawn"));
		assert.equal(page.querySelector(SPINNER), null);
		assert.ok(page.querySelector(`${SHRINK} > svg`));
		const viewer = document.createElement("div");
		viewer.innerHTML = `<div data-lh-overlay-chart><div class="rich-code-blocks">${SVG}</div></div>`;
		assert.equal(viewer.querySelector(SPINNER), null, "the viewer's copy never gets the spinner box");
	});
});
