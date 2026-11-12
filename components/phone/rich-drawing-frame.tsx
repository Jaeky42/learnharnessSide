"use client";

/**
 * RICH CODE BLOCKS ON A PHONE: THE ENLARGE BUTTON (fork;
 * docs/phone-plugins-plan.md, decision 7 and "Enlarging a drawing").
 *
 * In the phone layout every drawn Rich code blocks block (smiles, abc, tikz)
 * gets the lesson's own enlarge control, the one its other diagrams have
 * (md-blocks' "Expand diagram"), at the block's top right. It opens the
 * lesson's existing diagram viewer (components/session-overlay.tsx: drag,
 * pinch, − / +) with a copy of the drawn picture.
 *
 * The plugin draws into its own DOM, outside React: this frame watches for
 * the drawn picture (`.rich-code-blocks--rendered > svg`) and shows the
 * button only once it is there. While a block is drawn, or after it failed
 * (the plugin removes its block and the host shows its error and the
 * source), there is no button.
 *
 * Outside the phone layout, and for every other fence, the frame is no box
 * at all: it renders its children as they are, so the computer, a tablet
 * and the desktop app are untouched.
 *
 * WAITING FOR THE PLUGIN (owner's decision, after decision 8): while Rich
 * code blocks is switched on but its front end hasn't started, a fence shows
 * the same spinner box instead of the host's code fallback, from the first
 * paint of a page load. The frame says which state its fence is in
 * (`data-lh-rich-state`, see richFenceState) and app/phone-rich-code-blocks.css
 * draws the box. Before the frame runs (the server-rendered page, before
 * hydration) the box comes from the server's own mark that the plugin is on
 * (`data-lh-rich-code-blocks="on"` on <body>, app/layout.tsx) and the
 * fallback's `data-lh-rich-fence` (md-blocks.tsx).
 *
 * The copy is wrapped in the plugin's own `rich-code-blocks` class, so the
 * plugin's stylesheet still gives its ink the theme's colours (the
 * `--rich-code-blocks-*` variables) and its fonts apply. Its ids are renamed,
 * so the copy never shares an id with the drawing in the lesson.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { MaximizeIcon } from "lucide-react";
import { useIsPhone } from "@/components/phone/use-phone";
import { useSessionMermaid } from "@/components/session-overlay";
import { usePlugins } from "@/components/plugins";
import type { PluginSnapshot } from "@/components/plugin-manager";
import { blurAfterPointerClick } from "@/components/focus-hygiene";
import { Hint } from "@/components/ui/hint";

/** The fence languages Rich code blocks draws (its three families). */
export const RICH_DRAWING_LANGUAGES: readonly string[] = ["smiles", "abc", "tikz"];

/** The plugin's names this file relies on; tests/phone-rich-code-blocks.test.tsx
 *  checks that the plugin's source still uses each of them. */
export const RICH_BLOCK_CLASS = "rich-code-blocks";
export const RICH_RENDERED_CLASS = "rich-code-blocks--rendered";
/** The drawn picture inside a block. */
export const RICH_DRAWING_SELECTOR = `.${RICH_RENDERED_CLASS} > svg`;

/** The plugin's id, and the server's mark on <body> that it is switched on
 *  and installed (app/layout.tsx, richCodeBlocksBoot in src/server). */
export const RICH_PLUGIN_ID = "rich-code-blocks";
export const RICH_BOOT_ATTRIBUTE = "data-lh-rich-code-blocks";
/** The longest a fence waits for the plugin's front end to start before it
 *  shows its code: the spinner is never endless, even if the plugin's files
 *  never arrive. */
export const RICH_WAIT_CEILING_MS = 15_000;

export function isRichDrawingLanguage(language: string): boolean {
	return RICH_DRAWING_LANGUAGES.includes(language);
}

/** What one rich fence shows on a phone:
 *  - "plugin": the plugin has a renderer for this language, so the block is
 *    the plugin's own (drawing, drawn, or, if it failed, the host's error and
 *    code);
 *  - "waiting": the plugin is switched on and its front end hasn't started:
 *    the spinner box;
 *  - "code": anything else, the host's code fallback (the plugin is off, it
 *    started without this kind, it failed to load, the list of plugins
 *    couldn't be read, or the wait ran past its ceiling).
 *  Before the page's plugin list has arrived, the server's mark decides. */
export function richFenceState(snapshot: Pick<PluginSnapshot, "codeBlocks" | "plugins" | "loading" | "error">, language: string, serverOn: boolean, timedOut: boolean): "plugin" | "waiting" | "code" {
	if (snapshot.codeBlocks.some((entry) => entry.renderer.language === language)) return "plugin";
	if (timedOut) return "code";
	const plugin = snapshot.plugins.find((entry) => entry.info.id === RICH_PLUGIN_ID);
	if (plugin) return plugin.info.enabled && plugin.phase === "loading" ? "waiting" : "code";
	return snapshot.loading && !snapshot.error && serverOn ? "waiting" : "code";
}

function serverSaysOn(): boolean {
	return typeof document !== "undefined" && document.body?.getAttribute(RICH_BOOT_ATTRIBUTE) === "on";
}

let serial = 0;

/** A copy of a drawn picture for the viewer: the svg's markup, its ids
 *  renamed (and every `#id` reference with them), inside the plugin's own
 *  block class so the theme's ink and the plugin's fonts still apply. */
export function drawingCopy(svg: Element): string {
	const copy = svg.cloneNode(true) as Element;
	const prefix = `lh-rich-view-${++serial}-`;
	const ids = new Map<string, string>();
	const all = [copy, ...copy.querySelectorAll("*")];
	for (const element of all) {
		const id = element.getAttribute("id");
		if (!id) continue;
		if (!ids.has(id)) ids.set(id, prefix + ids.size);
		element.setAttribute("id", ids.get(id)!);
	}
	if (ids.size) {
		for (const element of all) {
			for (const attribute of [...element.attributes]) {
				if (attribute.name === "id") continue;
				const value = attribute.value;
				let next = value.replace(/url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g, (match, _quote: string, id: string) =>
					ids.has(id) ? `url(#${ids.get(id)})` : match);
				if ((attribute.localName === "href") && next.startsWith("#") && ids.has(next.slice(1))) next = `#${ids.get(next.slice(1))}`;
				if (next !== value) element.setAttributeNS(attribute.namespaceURI, attribute.name, next);
			}
		}
	}
	return `<div class="${RICH_BLOCK_CLASS}">${copy.outerHTML}</div>`;
}

/** Wraps one fence's plugin block (md-blocks' MarkdownCode). */
export function PhoneRichDrawingFrame({ language, children }: { language: string; children: ReactNode }) {
	const phone = useIsPhone();
	if (!phone || !isRichDrawingLanguage(language)) return <>{children}</>;
	return <PhoneFrame language={language}>{children}</PhoneFrame>;
}

function PhoneFrame({ language, children }: { language: string; children: ReactNode }) {
	const overlay = useSessionMermaid();
	const { snapshot } = usePlugins();
	const [timedOut, setTimedOut] = useState(false);
	const state = richFenceState(snapshot, language, serverSaysOn(), timedOut);
	useEffect(() => {
		if (state !== "waiting") return;
		const timer = window.setTimeout(() => setTimedOut(true), RICH_WAIT_CEILING_MS);
		return () => window.clearTimeout(timer);
	}, [state]);
	const frameRef = useRef<HTMLDivElement>(null);
	const [drawn, setDrawn] = useState(false);
	useEffect(() => {
		const frame = frameRef.current;
		if (!frame) return;
		const check = () => setDrawn(frame.querySelector(RICH_DRAWING_SELECTOR) !== null);
		check();
		if (typeof MutationObserver === "undefined") return;
		const observer = new MutationObserver(check);
		observer.observe(frame, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
		return () => observer.disconnect();
	}, []);
	const open = overlay?.openDrawing;
	return (
		<div ref={frameRef} data-testid="rich-drawing-frame" data-lh-rich-state={state} className="group/md relative">
			{children}
			{drawn && open && (
				<div className="absolute top-0 right-0 flex items-start">
					{/* The lesson's own enlarge control (md-blocks' mermaid button):
					    the same label, tooltip, icon and look. Hover-only buttons
					    always show on a phone, so this one is never hidden. */}
					<Hint label="Open full-screen" side="bottom">
						<button
							type="button"
							aria-label="Expand diagram"
							data-testid="rich-drawing-expand"
							className="flex size-6 items-center justify-center rounded-md text-muted-foreground/70 transition-opacity hover:bg-accent hover:text-foreground"
							onClick={(e) => {
								blurAfterPointerClick(e);
								const svg = frameRef.current?.querySelector(RICH_DRAWING_SELECTOR);
								if (svg) open(drawingCopy(svg));
							}}
						>
							<MaximizeIcon className="size-3.5" />
						</button>
					</Hint>
				</div>
			)}
		</div>
	);
}
