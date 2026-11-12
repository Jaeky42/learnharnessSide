"use client";

/**
 * A PLUGIN PAGE ON A PHONE (fork; see phone-plugins.ts). Opened directly
 * (a link, a bookmark, the address bar), app/plugins/[pluginId]/[viewId]
 * shows only the owner's sentence in place of the plugin. The top bar stays,
 * with nothing in it but the session-list button, so the home-screen app
 * (which has no back button) isn't left on a dead end.
 *
 * Off a phone the page renders exactly as upstream's. The server and the
 * hydration render answer "not a phone" (use-phone.ts); the plugin mounts
 * only after the plugin manager has started, which comes later than the
 * phone answer, so a phone never mounts the plugin's view.
 */

import type { ReactNode } from "react";
import { TopBar } from "@/components/top-bar";
import { useIsPhone } from "@/components/phone/use-phone";
import { PLUGIN_PAGE_PHONE_TEXT } from "@/components/phone/phone-plugins";

export function PhonePluginPage({ children }: { children: ReactNode }) {
	const phone = useIsPhone();
	if (!phone) return <>{children}</>;
	return (
		<div data-testid="plugin-page-phone" className="flex h-dvh min-w-0 flex-col">
			<TopBar />
			<p className="px-5 py-4 text-sm text-muted-foreground">{PLUGIN_PAGE_PHONE_TEXT}</p>
		</div>
	);
}
