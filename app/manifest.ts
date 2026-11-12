import type { MetadataRoute } from "next";
import { readThemeBoot } from "@/src/server";

/**
 * THE HOME-SCREEN APP (cloud sync Phase 3): what a phone needs to install
 * LearnHarness from the browser ("Add to Home Screen"). Served at
 * /manifest.webmanifest; Next links it from every page. The server's login
 * gate leaves it and /icons/ open, because phones fetch them without the
 * login cookie; they hold only the name and the icon.
 *
 * Name: the owner's choice. No service worker: the app needs the server for
 * everything, so there is nothing useful to keep offline.
 *
 * Colours (side-tutor fork, themes): the splash screen and the browser's bar
 * take the saved theme's background, overrides included, so the manifest is
 * read per request (force-dynamic), not baked at build time. Nothing but
 * that colour comes from the server's data.
 */
export const dynamic = "force-dynamic";

const DEFAULT_BACKGROUND = "#141414";

/** The saved theme's background, or the Default theme's. */
function manifestBackground(): string {
	try {
		const background = readThemeBoot().vars["--background"];
		return background && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(background) ? background : DEFAULT_BACKGROUND;
	} catch {
		return DEFAULT_BACKGROUND;
	}
}

export default function manifest(): MetadataRoute.Manifest {
	const background = manifestBackground();
	return {
		id: "/",
		name: "LearnHarness",
		short_name: "LearnHarness",
		description: "A teacher agent with a memory: sessions, quizzes, and a knowledge graph of what you know.",
		start_url: "/",
		scope: "/",
		display: "standalone",
		background_color: background,
		theme_color: background,
		icons: [
			{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
			{ src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
			{ src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
		],
	};
}
