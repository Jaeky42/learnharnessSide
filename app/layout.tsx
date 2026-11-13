import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Source_Sans_3 } from "next/font/google";
import { connection } from "next/server";
import "katex/dist/katex.min.css";
import "./globals.css";
import "./phone.css";
import "./phone-flashcards.css";
import "./phone-rich-code-blocks.css";
import "./touch.css";
import "./tablet.css";
import "./cloud.css";
import "./offscreen.css";
import { AppShell, SidebarProvider } from "@/components/sidebar";
import { ActivityProvider } from "@/components/activity-dock";
import { ServerEventsProvider } from "@/components/server-events";
import { CloudProvider } from "@/components/cloud/cloud-state";
import { DiscardNotice } from "@/components/cloud/discard-notice";
import { AppearanceProvider } from "@/components/settings/appearance";
import UpdateBanner from "@/components/update-banner";
import { PhoneRuntime } from "@/components/phone/phone-runtime";
import { PluginsProvider } from "@/components/plugins";
import { readThemeBoot, richCodeBlocksBoot } from "@/src/server";

// Chrome = JetBrains Mono, teaching prose = Source Sans 3, titles = CMU
// Serif (the bundled lh-cmu @font-face in globals.css — no CDN).
const ui = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });
const prose = Source_Sans_3({ subsets: ["latin"], variable: "--font-sans3" });

export const metadata: Metadata = {
	// The name a browser shows for the site: on the tab, in its history and in
	// the address bar's suggestions. One word, as everywhere else (owner's ask;
	// upstream's two-word title was the only place that differed).
	title: "LearnHarness",
	description: "A teacher agent with a memory — sessions, quizzes, and a knowledge graph of what you know.",
	// PHONE (cloud sync Phase 3): the home-screen app on an iPhone — its
	// name and icon (app/manifest.ts covers Android). black-translucent lets
	// the app draw under the clock, so the session drawer and its dim run the
	// full height (owner's ask); every top edge pads by the safe-area inset.
	// It stays black-translucent on light themes too (white clock text): iOS
	// has no translucent style with dark text ("default" stops the page below
	// the clock, which the phone layout's --lh-safe-top/standaloneGap rely on),
	// and it reads the style only when the icon is added to the home screen.
	appleWebApp: { capable: true, title: "LearnHarness", statusBarStyle: "black-translucent" },
	icons: { apple: "/icons/apple-touch-icon.png" },
};

// PHONE (cloud sync Phase 3): viewport-fit=cover lets the app paint under the
// notch and home bar (app/phone.css pads with the safe-area insets), and
// resizes-content makes Android shrink the layout above its keyboard.
// Side-tutor fork (themes): the browser's bar colour is the saved theme's
// background, read per request like the <html> variables below.
export async function generateViewport(): Promise<Viewport> {
	await connection();
	return {
		width: "device-width",
		initialScale: 1,
		viewportFit: "cover",
		interactiveWidget: "resizes-content",
		themeColor: readThemeBoot().vars["--background"] ?? "#141414",
	};
}

// Also (fork, app/offscreen.css): ?offscreen=off turns off skipping off-screen messages, for this load only.
const ELECTRON_MARK = "try{var d=document.documentElement;if(navigator.userAgent.indexOf('Electron')!==-1)d.classList.add('lh-electron');if(/[?&]offscreen=off(&|$)/.test(location.search))d.setAttribute('data-lh-offscreen','off')}catch(e){}";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
	// The theme is server-rendered — its class AND its color variables —
	// so no first frame ever shows the wrong theme. connection(): the
	// record and the theme files are per-machine disk state — without it a
	// prerendered route (settings) would bake the BUILD machine's record.
	await connection();
	const { appearance, theme, vars } = readThemeBoot();
	// Side-tutor fork (phone): whether Rich code blocks is on, marked on <body>,
	// so a phone shows its spinner box from the first paint
	// (components/phone/rich-drawing-frame.tsx). No effect on a computer.
	const richCodeBlocks = await richCodeBlocksBoot();
	return (
		// suppressHydrationWarning: the script below adds a class to <html>
		// before React hydrates (one level only; children are still checked).
		<html
			lang="en"
			className={`${theme.mode} ${ui.variable} ${prose.variable}`}
			style={vars as React.CSSProperties}
			suppressHydrationWarning
		>
			<head>
				{/* PHONE (cloud sync Phase 3): mark the desktop app BEFORE the first
				    paint. app/phone.css only applies under html:not(.lh-electron);
				    without this, a zoomed-in desktop window at its minimum width
				    could flash the phone layout until the sidebar adds the class. */}
				<script dangerouslySetInnerHTML={{ __html: ELECTRON_MARK }} />
			</head>
			<body className="min-h-dvh antialiased" data-lh-rich-code-blocks={richCodeBlocks ? "on" : undefined}>
			{/* The notification channel rides OUTSIDE everything: sidebar, dock,
				 and pages all subscribe as the polls retire (push S3, 2026-10-02). */}
			<ServerEventsProvider>
				<PluginsProvider>
					<AppearanceProvider initialAppearance={appearance} initialTheme={theme}>
						{/* Cloud sync (Phase 6): which sessions another device holds, and
						    this PC's sync state. Asks nothing where sync isn't in use. */}
						<CloudProvider>
							<SidebarProvider>
								<ActivityProvider>
									<AppShell>
										{children}
										{/* What this PC had to discard after a take-over, said once.
										    Inside the shell, so it shares the app's dialog layers. */}
										<DiscardNotice />
									</AppShell>
								</ActivityProvider>
							</SidebarProvider>
						</CloudProvider>
					</AppearanceProvider>
				</PluginsProvider>
			</ServerEventsProvider>
			{/* Auto-update banner (Wave C): fixed card, Electron-only pushes. */}
			<UpdateBanner />
			<PhoneRuntime />
		</body>
		</html>
	);
}
