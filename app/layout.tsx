import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Source_Sans_3 } from "next/font/google";
import "katex/dist/katex.min.css";
import "./globals.css";
import "./phone.css";
import "./cloud.css";
import { AppShell, SidebarProvider } from "@/components/sidebar";
import { ActivityProvider } from "@/components/activity-dock";
import { ServerEventsProvider } from "@/components/server-events";
import { CloudProvider } from "@/components/cloud/cloud-state";
import { AppearanceProvider } from "@/components/settings/appearance";
import UpdateBanner from "@/components/update-banner";
import { PhoneRuntime } from "@/components/phone/phone-runtime";

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
	appleWebApp: { capable: true, title: "LearnHarness", statusBarStyle: "black-translucent" },
	icons: { apple: "/icons/apple-touch-icon.png" },
};

// PHONE (cloud sync Phase 3): viewport-fit=cover lets the app paint under the
// notch and home bar (app/phone.css pads with the safe-area insets), and
// resizes-content makes Android shrink the layout above its keyboard.
export const viewport: Viewport = {
	width: "device-width",
	initialScale: 1,
	viewportFit: "cover",
	interactiveWidget: "resizes-content",
	themeColor: "#141414",
};

const ELECTRON_MARK = "if(navigator.userAgent.indexOf('Electron')!==-1)document.documentElement.classList.add('lh-electron')";

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		// suppressHydrationWarning: the script below adds a class to <html>
		// before React hydrates (one level only; children are still checked).
		<html lang="en" className={`dark ${ui.variable} ${prose.variable}`} suppressHydrationWarning>
			<head>
				{/* PHONE (cloud sync Phase 3): mark the desktop app BEFORE the first
				    paint. app/phone.css only applies under html:not(.lh-electron);
				    without this, a zoomed-in desktop window at its minimum width
				    could flash the phone layout until the sidebar adds the class. */}
				<script dangerouslySetInnerHTML={{ __html: ELECTRON_MARK }} />
			</head>
			<body className="min-h-dvh antialiased">
			{/* The notification channel rides OUTSIDE everything: sidebar, dock,
				 and pages all subscribe as the polls retire (push S3, 2026-10-02). */}
			<ServerEventsProvider>
				<AppearanceProvider>
					{/* Cloud sync (Phase 6): which sessions another device holds, and
					    this PC's sync state. Asks nothing where sync isn't in use. */}
					<CloudProvider>
					<SidebarProvider>
						<ActivityProvider>
							<AppShell>{children}</AppShell>
						</ActivityProvider>
					</SidebarProvider>
					</CloudProvider>
				</AppearanceProvider>
			</ServerEventsProvider>
			{/* Auto-update banner (Wave C): fixed card, Electron-only pushes. */}
			<UpdateBanner />
			<PhoneRuntime />
		</body>
		</html>
	);
}
