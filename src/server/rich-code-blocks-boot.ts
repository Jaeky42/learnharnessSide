/**
 * RICH CODE BLOCKS ON A PHONE: THE SERVER'S MARK (fork;
 * docs/phone-plugins-plan.md, decision 8 and the owner's "spinner from the
 * start").
 *
 * Whether the Rich code blocks plugin is switched on and installed, read from
 * the plugin host while the page is rendered. The root layout puts it on
 * <body> (`data-lh-rich-code-blocks="on"`), so on a phone a smiles, abc or
 * tikz fence can show the spinner box from the first paint, before the
 * page's own plugin list arrives. It says nothing about which kinds are
 * switched on (only the plugin knows); components/phone/rich-drawing-frame.tsx
 * takes over as soon as the page runs.
 *
 * Never holds a page up: if the plugin host isn't ready within a moment, or
 * fails, the answer is "not on" (the page then shows code until it knows).
 */

import type { PluginInfo } from "../core/index.ts";
import { getPluginHost } from "./plugins.ts";

export const RICH_CODE_BLOCKS_PLUGIN_ID = "rich-code-blocks";

/** Pure: is the plugin on and loadable, by the host's list? */
export function richCodeBlocksOnIn(plugins: readonly Pick<PluginInfo, "id" | "enabled" | "status">[]): boolean {
	return plugins.some((info) => info.id === RICH_CODE_BLOCKS_PLUGIN_ID && info.enabled && info.status === "active");
}

export async function richCodeBlocksBoot(waitMs = 300): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const host = await Promise.race([
			getPluginHost(),
			new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), waitMs); }),
		]);
		return host ? richCodeBlocksOnIn(host.list()) : false;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}
