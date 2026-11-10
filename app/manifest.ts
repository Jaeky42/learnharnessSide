import type { MetadataRoute } from "next";

/**
 * THE HOME-SCREEN APP (cloud sync Phase 3): what a phone needs to install
 * LearnHarness from the browser ("Add to Home Screen"). Served at
 * /manifest.webmanifest; Next links it from every page. The server's login
 * gate leaves it and /icons/ open, because phones fetch them without the
 * login cookie; they hold only the name and the icon.
 *
 * Name: the owner's choice. No service worker: the app needs the server for
 * everything, so there is nothing useful to keep offline.
 */
export default function manifest(): MetadataRoute.Manifest {
	return {
		id: "/",
		name: "LearnHarness",
		short_name: "LearnHarness",
		description: "A teacher agent with a memory: sessions, quizzes, and a knowledge graph of what you know.",
		start_url: "/",
		scope: "/",
		display: "standalone",
		background_color: "#141414",
		theme_color: "#141414",
		icons: [
			{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
			{ src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
			{ src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
		],
	};
}
