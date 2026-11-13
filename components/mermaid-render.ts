/**
 * The app's ONE mermaid renderer (the chrome-melt wave, 2026-09-19): both the
 * in-chat block (components/md-blocks.tsx) and the session-scoped focus
 * overlay (components/session-overlay.tsx) render charts through this module
 * — one config per rendered mode, one plugin instance, unique render ids. This
 * REPLACES streamdown's internal mermaid path entirely: its fullscreen portal
 * was hard-wired `fixed inset-0` (covering the window-drag bar, X landing in
 * drag territory) with no styling hook, which is what drove the custom
 * component in the first place.
 */

import { createMermaidPlugin } from "@streamdown/mermaid";
import type { MermaidConfig } from "mermaid";
import type { RenderedMode } from "@/src/core";

/** The chart's base font size (px) — mermaid sizes ALL text relative to
 *  this, so it's the number the display-width cap (md-blocks) divides by:
 *  a chart shown at its natural width renders text at exactly this size.
 *  Pinned explicitly so a mermaid default change can't silently shift the
 *  cap (owner rule, chrome-melt tweaks wave, 2026-09-19: chart text must
 *  never render larger than the session's own text). */
export const MERMAID_FONT_SIZE = 16;

// Diagrams follow the rendered mode (light-mode wave, 2026-10-29): mermaid's
// dark theme in dark, its default theme in light. Callers pass the
// provider's resolvedMode and re-render when it changes. (Moved from
// ai-elements/message.tsx when the renderer became app-owned; the old
// `mermaid` prop wiring is retired.)
export function mermaidConfig(mode: RenderedMode): MermaidConfig {
	return {
		fontFamily: "ui-sans-serif, system-ui, sans-serif",
		fontSize: MERMAID_FONT_SIZE,
		securityLevel: "strict",
		theme: mode === "dark" ? "dark" : "default",
	};
}

const plugin = createMermaidPlugin();

// Side-tutor fork (performance). Two things the render path did on every call:
// it re-initialised mermaid with an identical config (a deep merge plus a
// theme build each time) and it rendered a chart it had already rendered.
// Mermaid resets to the site config at the start of every render, so the
// config only needs setting when the mode changes.
let configuredMode: RenderedMode | null = null;
function mermaidFor(mode: RenderedMode) {
	if (configuredMode === mode) return plugin.getMermaid();
	configuredMode = mode;
	return plugin.getMermaid(mermaidConfig(mode));
}

const newRenderId = () => `lh-mermaid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

/** Memoised renderer over a raw `(id, chart, mode) => svg` function. The same
 *  chart in the same mode (a session opened again, the full-screen view of a
 *  chart already on screen) reuses one render. Mermaid's svg carries its render
 *  id in its root id, its scoped style and its marker/clip ids, so every
 *  caller gets the svg with a fresh id of its own: two instances on one page
 *  never share an id. Failures are never cached. */
export function createMermaidRenderer(
	renderRaw: (id: string, chart: string, mode: RenderedMode) => Promise<string>,
	limits: { entries: number; chars: number } = { entries: 60, chars: 3_000_000 },
) {
	const cache = new Map<string, { id: string; svg: Promise<string>; size: number }>();
	let held = 0;
	const drop = (key: string) => { const entry = cache.get(key); if (entry) { cache.delete(key); held -= entry.size; } };
	const render = async (chart: string, mode: RenderedMode): Promise<string> => {
		const key = `${mode}\u0000${chart}`;
		let entry = cache.get(key);
		if (entry) { cache.delete(key); cache.set(key, entry); } // most recently used last
		else {
			const id = newRenderId();
			const created = { id, size: chart.length, svg: renderRaw(id, chart, mode) };
			entry = created;
			cache.set(key, created);
			held += created.size;
			created.svg.then(
				(svg) => {
					// The entry may have been dropped or replaced while rendering.
					if (cache.get(key) !== created) return;
					created.size = chart.length + svg.length; held += svg.length;
					for (const [oldest] of cache) {
						if (cache.size <= limits.entries && held <= limits.chars) break;
						drop(oldest);
					}
				},
				() => { if (cache.get(key) === created) drop(key); },
			);
		}
		const svg = await entry.svg;
		return svg.split(entry.id).join(newRenderId());
	};
	return { render, size: () => cache.size, clear: () => { cache.clear(); held = 0; } };
}

const renderer = createMermaidRenderer(async (id, chart, mode) => (await mermaidFor(mode).render(id, chart)).svg);

/** Render one chart source to an svg string. The id is unique per call —
 *  mermaid caches rendered ids, and a repeated id across charts/renders
 *  returns the stale svg (the bug streamdown's own id minting avoids). */
export function renderMermaid(chart: string, mode: RenderedMode): Promise<string> {
	return renderer.render(chart, mode);
}
