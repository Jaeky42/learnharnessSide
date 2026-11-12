/**
 * The server's saved theme, for the two signed-out pages (/login and /setup,
 * server-auth-pages.ts). Side-tutor fork: they used to repeat the Default
 * theme's dark colours; they now take the theme the server's settings
 * record selects, with the learner's colour overrides, the same palette
 * app/layout.tsx paints the app with (readThemeBoot in theme-boot.ts).
 *
 * The same resolution as readThemeBoot, from the modules themselves rather
 * than the core barrel: proxy.ts loads server-auth.ts, which loads the pages,
 * and the barrel would pull the whole core into the proxy.
 *
 * These pages are served before sign-in, so only colours leave this module,
 * each one checked to be a plain hex colour before it reaches the page.
 */

import { DEFAULT_THEME, effectiveColors, isBuiltinThemeId, resolveTheme, type ThemeColors } from "../core/themes.ts";
import { readSettings } from "../store/settings.ts";
import { themeStore } from "../store/themes.ts";

/** What the sign-in pages paint with: the theme's mode and six colours. */
export interface AuthPagePalette {
	mode: "dark" | "light";
	background: string;
	surface: string;
	border: string;
	text: string;
	textMuted: string;
	error: string;
}

const pick = (mode: "dark" | "light", c: ThemeColors): AuthPagePalette => ({
	mode, background: c.background, surface: c.surface, border: c.border, text: c.text, textMuted: c.textMuted, error: c.error,
});

/** The Default theme's palette, for when nothing else can be read. */
export const DEFAULT_AUTH_PAGE_PALETTE: AuthPagePalette = pick("dark", DEFAULT_THEME.colors);

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const hex = (value: string | undefined, fallback: string): string => (value && HEX.test(value) ? value : fallback);

/** The saved theme's colours for the sign-in pages; the Default theme's
 *  when the record or the theme file can't be read. */
export function authPagePalette(): AuthPagePalette {
	try {
		const appearance = readSettings()?.appearance;
		const id = appearance?.theme;
		const custom = id && !isBuiltinThemeId(id) ? themeStore.readTheme(id) : null;
		const theme = resolveTheme(id, custom ? [custom] : []);
		const colors = effectiveColors(theme, appearance);
		const d = DEFAULT_AUTH_PAGE_PALETTE;
		return {
			mode: theme.mode === "light" ? "light" : "dark",
			background: hex(colors.background, d.background),
			surface: hex(colors.surface, d.surface),
			border: hex(colors.border, d.border),
			text: hex(colors.text, d.text),
			textMuted: hex(colors.textMuted, d.textMuted),
			error: hex(colors.error, d.error),
		};
	} catch {
		return DEFAULT_AUTH_PAGE_PALETTE;
	}
}
