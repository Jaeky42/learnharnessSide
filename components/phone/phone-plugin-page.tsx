"use client";

/**
 * A PLUGIN PAGE ON A PHONE (fork; see phone-plugins.ts). Opened on a phone,
 * app/plugins/[pluginId]/[viewId] renders the page of a phone-ready plugin
 * (Flashcards, Rich code blocks) as on a computer. Any other plugin's page
 * shows only the owner's sentence in its place. The top bar stays, with
 * nothing in it but the session-list button, so the home-screen app (which
 * has no back button) isn't left on a dead end.
 *
 * Off a phone the page renders exactly as upstream's. The server and the
 * hydration render answer "not a phone" (use-phone.ts); the plugin mounts
 * only after the plugin manager has started, which comes later than the
 * phone answer, so a phone never mounts the view of a plugin that isn't
 * phone-ready.
 */

import type { ReactNode } from "react";
import { TopBar } from "@/components/top-bar";
import { useIsPhone } from "@/components/phone/use-phone";
import { isPhoneReadyPlugin, PLUGIN_PAGE_PHONE_TEXT } from "@/components/phone/phone-plugins";

export function PhonePluginPage({ pluginId, children }: { pluginId: string; children: ReactNode }) {
	const phone = useIsPhone();
	if (!phone || isPhoneReadyPlugin(pluginId)) return <>{children}</>;
	return (
		<div data-testid="plugin-page-phone" className="flex h-dvh min-w-0 flex-col">
			<TopBar />
			<p className="px-5 py-4 text-sm text-muted-foreground">{PLUGIN_PAGE_PHONE_TEXT}</p>
		</div>
	);
}
