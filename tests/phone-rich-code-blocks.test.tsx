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
const { PhoneRichDrawingFrame, drawingCopy, richFenceState, RICH_DRAWING_LANGUAGES, RICH_BLOCK_CLASS, RICH_RENDERED_CLASS, RICH_WAIT_CEILING_MS } = await import("../components/phone/rich-drawing-frame.tsx");
const { richCodeBlocksOnIn } = await import("../src/server/rich-code-blocks-boot.ts");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const { ServerEventsProvider } = await import("../components/server-events.tsx");
const { createPluginWindowOwner, PluginsProvider } = await import("../components/plugins.tsx");
const { PluginCodeBlock } = await import("../components/plugin-renderers.tsx");
const { MessageResponse } = await import("../components/ai-elements/message.tsx");
const { HostMarkdown } = await import("../components/host-markdown.tsx");
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
		// The host's mount, md-blocks' fallback mark, the root layout's server mark and the fork's frame.
		const host = ["components/plugin-renderers.tsx", "components/md-blocks.tsx", "app/layout.tsx", "components/phone/rich-drawing-frame.tsx", "src/server/rich-code-blocks-boot.ts"].map(read).join("\n");
		const names = new Set([...css.matchAll(/\.([a-z][\w-]*)|\[([a-z-]+)/g)].map((m) => m[1] ?? m[2]!).filter((n) => n !== "lh-electron"));
		assert.ok(names.size >= 6);
		for (const name of names) assert.ok(pluginSource.includes(name) || host.includes(name), `${name} is no longer in the plugin or the host`);
		assert.match(read("components/md-blocks.tsx"), /data-testid="md-code" data-lh-rich-fence=\{!displayOnly && isRichDrawingLanguage\(language\) \? "" : undefined\}/);
		assert.match(read("app/layout.tsx"), /<body className="min-h-dvh antialiased" data-lh-rich-code-blocks=\{richCodeBlocks \? "on" : undefined\}>/);
		assert.match(read("components/phone/rich-drawing-frame.tsx"), /data-lh-rich-state=\{state\}/);
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

// ── Waiting for the plugin (owner's decision: the spinner from the start) ──

type Snapshot = Parameters<typeof richFenceState>[0];
const plugin = (enabled: boolean, phase: "disabled" | "loading" | "active" | "error") => ({ info: { id: "rich-code-blocks", enabled }, phase }) as unknown as Snapshot["plugins"][number];
const snap = (over: Partial<Snapshot> = {}): Snapshot => ({ codeBlocks: [], plugins: [], loading: false, ...over });
const tikzRenderer = { pluginId: "rich-code-blocks", renderer: { language: "tikz", mount() {} } } as unknown as Snapshot["codeBlocks"][number];

describe("which fences wait for the plugin (richFenceState)", () => {
	it("on and not yet started: the spinner box", () => {
		assert.equal(richFenceState(snap({ plugins: [plugin(true, "loading")] }), "tikz", false, false), "waiting");
	});
	it("before the page's plugin list arrives, the server's mark decides", () => {
		assert.equal(richFenceState(snap({ loading: true }), "tikz", true, false), "waiting");
		assert.equal(richFenceState(snap({ loading: true }), "tikz", false, false), "code", "switched off on the server: code, no spinner");
		assert.equal(richFenceState(snap({ loading: false, error: "Request failed (500)" }), "tikz", true, false), "code", "the list couldn't be read: code");
	});
	it("started with this kind switched off: code", () => {
		assert.equal(richFenceState(snap({ plugins: [plugin(true, "active")] }), "abc", true, false), "code");
	});
	it("started with it on: the plugin's own block", () => {
		assert.equal(richFenceState(snap({ plugins: [plugin(true, "active")], codeBlocks: [tikzRenderer] }), "tikz", true, false), "plugin");
		assert.equal(richFenceState(snap({ plugins: [plugin(true, "loading")], codeBlocks: [tikzRenderer] }), "tikz", true, false), "plugin", "a renderer registered during activation");
	});
	it("switched off, or failed to load: code", () => {
		assert.equal(richFenceState(snap({ plugins: [plugin(false, "disabled")] }), "tikz", true, false), "code", "the page's list beats a stale server mark");
		assert.equal(richFenceState(snap({ plugins: [plugin(true, "error")] }), "tikz", true, false), "code");
	});
	it("never endless: past the ceiling a waiting fence shows code", () => {
		assert.equal(richFenceState(snap({ plugins: [plugin(true, "loading")] }), "tikz", true, true), "code");
		assert.equal(RICH_WAIT_CEILING_MS, 15_000);
	});
	it("the server's mark: on only when the plugin is switched on and installed", () => {
		assert.equal(richCodeBlocksOnIn([{ id: "rich-code-blocks", enabled: true, status: "active" }]), true);
		assert.equal(richCodeBlocksOnIn([{ id: "rich-code-blocks", enabled: false, status: "disabled" }]), false);
		assert.equal(richCodeBlocksOnIn([{ id: "rich-code-blocks", enabled: true, status: "error" }]), false);
		assert.equal(richCodeBlocksOnIn([{ id: "flashcards", enabled: true, status: "active" }]), false);
	});
});

describe("md-blocks marks the fallback of a rich fence", () => {
	it("smiles, abc and tikz fences in a lesson, not other code, and not display-only Markdown", () => {
		const html = renderToStaticMarkup(<MessageResponse mode="static">{"```tikz\n\\draw (0,0);\n```\n\n```js\nconst x = 1;\n```\n\n```abc\nX:1\n```\n\n```smiles\nCCO\n```"}</MessageResponse>);
		assert.equal(html.match(/data-lh-rich-fence=""/g)?.length, 3);
		const marked = [...html.matchAll(/data-testid="md-code"( data-lh-rich-fence="")?/g)].map((m) => !!m[1]);
		assert.deepEqual(marked, [true, false, true, true]);
		const host = renderToStaticMarkup(<HostMarkdown text={"```tikz\n\\draw (0,0);\n```"} />);
		assert.ok(host.includes('data-testid="md-code"'));
		assert.ok(!host.includes("data-lh-rich-fence"), "a Flashcards card never draws, so never waits");
	});
});

/** The real plugin manager, with Rich code blocks in the page's plugin list
 *  as the test says, and its front end started when the test says so. */
function withRichPlugin(children: React.ReactNode, opts: { enabled: boolean; status?: "active" | "error"; languages?: string[]; fail?: boolean }) {
	let start!: () => void;
	const started = new Promise<void>((resolve) => { start = resolve; });
	const info = { id: "rich-code-blocks", origin: "core", enabled: opts.enabled, status: opts.status ?? (opts.enabled ? "active" : "disabled"), revision: "one",
		manifest: { apiVersion: 1, id: "rich-code-blocks", name: "Rich code blocks", version: "1.0.0", minAppVersion: "0.3.7", main: "main.js" } };
	window.__lhPluginWindow = createPluginWindowOwner({
		fetch: async () => Response.json({ plugins: [info], directory: "/fixtures/plugins", conflicts: [] }),
		importModule: async () => {
			await started;
			if (opts.fail) throw new Error("Plugin module could not be loaded");
			return { activate(ctx) {
				for (const language of opts.languages ?? []) ctx.registerCodeBlock({ language, mount(container) {
					const block = document.createElement("div"); block.className = "rich-code-blocks"; block.innerHTML = "<pre><code>source</code></pre>"; container.append(block);
				} });
			} };
		},
		pathname: () => "/", navigate() {},
	});
	const router = { bfcacheId: "fixture", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, async prefetch() {} };
	const connect = () => ({ close() {}, onOpen() {}, onEvent() {} });
	const node = <InteractionLayersProvider><AppRouterContext.Provider value={router}><ServerEventsProvider connect={connect}><PluginsProvider>{children}</PluginsProvider></ServerEventsProvider></AppRouterContext.Provider></InteractionLayersProvider>;
	return { node, start };
}
const fence = (language: string) => <PhoneRichDrawingFrame language={language}><PluginCodeBlock language={language} source="\draw (0,0);" meta="" incomplete={false} fallback={<div data-testid="md-code" data-lh-rich-fence="">code</div>} /></PhoneRichDrawingFrame>;
const stateOf = (host: HTMLElement) => host.querySelector("[data-lh-rich-state]")?.getAttribute("data-lh-rich-state");

describe("a phone fence while the plugin starts (the real plugin manager)", () => {
	afterEach(() => { delete (window as { __lhPluginWindow?: unknown }).__lhPluginWindow; document.body.removeAttribute("data-lh-rich-code-blocks"); });

	it("on and not yet started → the spinner box; started → the plugin's own block", async () => {
		phone = true;
		const { node, start } = withRichPlugin(fence("tikz"), { enabled: true, languages: ["tikz"] });
		const host = await mount(node);
		assert.equal(stateOf(host), "waiting");
		assert.ok(host.querySelector('[data-lh-rich-state="waiting"] > [data-lh-rich-fence]'), "the code fallback sits where the spinner rule draws its box");
		await act(async () => start());
		await settle();
		assert.equal(stateOf(host), "plugin");
		assert.ok(host.querySelector("[data-plugin-renderer] .rich-code-blocks"), "the plugin's own block (its own spinner state)");
		assert.equal(host.querySelector("[data-lh-rich-fence]"), null);
	});

	it("started with the family off → code", async () => {
		phone = true;
		const { node, start } = withRichPlugin(fence("abc"), { enabled: true, languages: ["tikz"] });
		const host = await mount(node);
		assert.equal(stateOf(host), "waiting");
		await act(async () => start());
		await settle();
		assert.equal(stateOf(host), "code");
		assert.ok(host.querySelector('[data-lh-rich-state="code"] > [data-lh-rich-fence]'));
	});

	it("plugin off → code from the start, even with a stale server mark", async () => {
		phone = true;
		document.body.setAttribute("data-lh-rich-code-blocks", "on");
		const { node } = withRichPlugin(fence("tikz"), { enabled: false });
		const host = await mount(node);
		assert.equal(stateOf(host), "code");
	});

	it("plugin failed to load → code, no spinner", async () => {
		phone = true;
		const { node, start } = withRichPlugin(fence("tikz"), { enabled: true, fail: true });
		const host = await mount(node);
		assert.equal(stateOf(host), "waiting");
		await act(async () => start());
		await settle();
		assert.equal(stateOf(host), "code");
	});

	it("installed but broken on the server → code at once", async () => {
		phone = true;
		const { node } = withRichPlugin(fence("smiles"), { enabled: true, status: "error" });
		const host = await mount(node);
		assert.equal(stateOf(host), "code");
	});

	it("before the plugin list arrives, the frame follows the server's mark", async () => {
		phone = true;
		document.body.setAttribute("data-lh-rich-code-blocks", "on");
		const on = await mount(fence("tikz"));
		assert.equal(stateOf(on), "waiting", "no plugin list yet, and the server says on");
		document.body.removeAttribute("data-lh-rich-code-blocks");
		const off = await mount(fence("tikz"));
		assert.equal(stateOf(off), "code");
	});

	it("the computer is untouched: no frame, no state", async () => {
		phone = false;
		const { node } = withRichPlugin(fence("tikz"), { enabled: true, languages: ["tikz"] });
		const host = await mount(node);
		assert.equal(host.querySelector("[data-lh-rich-state]"), null);
	});
});

describe("the stylesheet's waiting and touch-area rules", () => {
	it("draws the spinner box for a waiting fence, and for an undecided one only under the server's mark", () => {
		assert.match(css, /html:not\(\.lh-electron\) body\[data-lh-rich-code-blocks="on"\] \[data-lh-rich-fence\]:not\(\[data-lh-rich-state\] > \*\),\s*html:not\(\.lh-electron\) \[data-lh-rich-state="waiting"\] > \[data-lh-rich-fence\] \{[^}]*min-height: 7\.5rem;/);
		assert.match(css, /\[data-lh-rich-state="waiting"\] > \[data-lh-rich-fence\] > \* \{\s*display: none;/);
		assert.match(css, /\[data-lh-rich-state="waiting"\] > \[data-lh-rich-fence\]::after \{\s*animation: none;/, "reduced motion");
		assert.ok(!/data-lh-rich-state="code"/.test(css), "a fence the frame says is code shows as it is");
	});
	it("gives the rich blocks' enlarge button a 40 x 40 touch area, and leaves the lesson's mermaid button alone", () => {
		assert.match(css, /\[data-testid="rich-drawing-expand"\] \{\s*position: relative;\s*\}/);
		assert.match(css, /\[data-testid="rich-drawing-expand"\]::after \{\s*content: "";\s*position: absolute;\s*inset: -0\.5rem 0 -0\.5rem -1rem;\s*\}/, "24 px plus 8 above and below, plus 16 to the left (the lesson clips its right): 40 x 40");
		assert.match(read("components/phone/rich-drawing-frame.tsx"), /data-testid="rich-drawing-expand"\s+className="flex size-6 /);
		assert.ok(!css.includes("md-mermaid-expand"));
	});
});
