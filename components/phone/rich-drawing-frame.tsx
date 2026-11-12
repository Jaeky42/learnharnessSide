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
 * The copy is wrapped in the plugin's own `rich-code-blocks` class, so the
 * plugin's stylesheet still gives its ink the theme's colours (the
 * `--rich-code-blocks-*` variables) and its fonts apply. Its ids are renamed,
 * so the copy never shares an id with the drawing in the lesson.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { MaximizeIcon } from "lucide-react";
import { useIsPhone } from "@/components/phone/use-phone";
import { useSessionMermaid } from "@/components/session-overlay";
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
	if (!phone || !RICH_DRAWING_LANGUAGES.includes(language)) return <>{children}</>;
	return <PhoneFrame>{children}</PhoneFrame>;
}

function PhoneFrame({ children }: { children: ReactNode }) {
	const overlay = useSessionMermaid();
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
		<div ref={frameRef} data-testid="rich-drawing-frame" className="group/md relative">
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
