/**
 * The pages outside the app follow the saved theme (side-tutor fork, after
 * upstream 0.6.0's themes): the server's sign-in pages, the home-screen
 * app's manifest, and the browser bar's colour. They paint with the theme
 * the settings record selects, overrides included, exactly like the app's
 * first paint (readThemeBoot), and give away nothing but colours.
 *
 * LH_DATA_DIR is redirected to a temp dir BEFORE the first config import.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-themed-pages-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { readThemeBoot, writeSettingsRecord, themeStore } = await import("../src/server/index.ts");
const { authPagePalette, DEFAULT_AUTH_PAGE_PALETTE } = await import("../src/server/server-auth-theme.ts");
const pages = await import("../src/server/server-auth-pages.ts");
const { default: manifest } = await import("../app/manifest.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));
beforeEach(() => fs.rmSync(path.join(TMP_DATA, "settings.json"), { force: true }));

/** What the app's first paint uses, for comparison. */
function boot() {
	const { theme, vars } = readThemeBoot();
	return {
		mode: theme.mode,
		background: vars["--background"], surface: vars["--card"], border: vars["--border"],
		text: vars["--foreground"], textMuted: vars["--muted-foreground"], error: vars["--lh-error"],
	};
}

describe("the sign-in pages", () => {
	it("no record: the Default dark theme, the colours they always had (the error line takes the theme's error colour)", () => {
		assert.deepEqual(authPagePalette(), DEFAULT_AUTH_PAGE_PALETTE);
		assert.deepEqual(DEFAULT_AUTH_PAGE_PALETTE, { mode: "dark", background: "#141414", surface: "#1c1c1c", border: "#434343", text: "#e6e6e6", textMuted: "#8d8d8d", error: "#ef4444" });
		for (const html of [pages.loginPageHtml(), pages.setupPageHtml()]) {
			assert.match(html, /:root \{ color-scheme: dark; --bg: #141414; --card: #1c1c1c; --fg: #e6e6e6; --muted: #8d8d8d; --border: #434343; --error: #ef4444; \}/);
			assert.match(html, /<meta name="theme-color" content="#141414">/);
		}
	});

	it("a light preset: its mode and colours, the same as the app's first paint", () => {
		writeSettingsRecord({ version: 1, appearance: { theme: "rose-pine-dawn" } });
		const palette = authPagePalette();
		assert.deepEqual(palette, boot());
		assert.equal(palette.mode, "light");
		assert.equal(palette.background, "#faf4ed");
		const html = pages.loginPageHtml();
		assert.match(html, /color-scheme: light; --bg: #faf4ed;/);
		assert.match(html, /<meta name="theme-color" content="#faf4ed">/);
	});

	it("an imported theme with an override: as on screen", () => {
		themeStore.writeTheme("my-paper", {
			name: "My Paper",
			mode: "light",
			colors: {
				background: "#fdfdfd", surface: "#ffffff", border: "#dddddd", text: "#222222", textMuted: "#666666",
				accent: "#3366ff", bold: "#222222", italic: "#222222", code: "#aa5500",
				error: "#cc0000", success: "#008800", warning: "#aa7700",
			},
		});
		writeSettingsRecord({ version: 1, appearance: { theme: "my-paper", colors: { error: "#990000" } } });
		assert.deepEqual(authPagePalette(), boot());
		assert.equal(authPagePalette().error, "#990000");
	});

	it("only colours reach the page: a value that isn't a plain hex colour is replaced", () => {
		const html = pages.loginPageHtml({ ...DEFAULT_AUTH_PAGE_PALETTE, mode: "light" });
		assert.match(html, /color-scheme: light;/);
		// authPagePalette is the only caller that reads data; it checks each value.
		const source = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "server", "server-auth-theme.ts"), "utf8");
		for (const key of ["background", "surface", "border", "text", "textMuted", "error"]) assert.match(source, new RegExp(`${key}: hex\\(colors\\.${key}, d\\.${key}\\)`), key);
	});

	it("the pages still work under their CSP: one inline <style>, no other style source", () => {
		const html = pages.setupPageHtml();
		assert.equal(html.match(/<style>/g)?.length, 1);
		assert.doesNotMatch(html, /<link rel="stylesheet"|style="/);
	});
});

describe("the home-screen app and the browser bar", () => {
	it("the manifest's colours are the saved theme's background; nothing else changes", () => {
		assert.equal(manifest().background_color, "#141414");
		assert.equal(manifest().theme_color, "#141414");
		writeSettingsRecord({ version: 1, appearance: { theme: "rose-pine-dawn", background: "#fefefe" } });
		const m = manifest();
		assert.equal(m.background_color, "#fefefe", "the background override wins, as on screen");
		assert.equal(m.theme_color, "#fefefe");
		assert.deepEqual(Object.keys(m).sort(), ["background_color", "description", "display", "icons", "id", "name", "scope", "short_name", "start_url", "theme_color"]);
	});

	it("the manifest is read per request, not baked at build time", async () => {
		const mod = await import("../app/manifest.ts");
		assert.equal(mod.dynamic, "force-dynamic");
	});

	it("the browser bar's colour (viewport themeColor) is the saved theme's background; the status bar style is unchanged", () => {
		const layout = fs.readFileSync(path.join(import.meta.dirname, "..", "app", "layout.tsx"), "utf8");
		assert.match(layout, /export async function generateViewport\(\): Promise<Viewport> \{/);
		assert.match(layout, /themeColor: readThemeBoot\(\)\.vars\["--background"\]/);
		assert.doesNotMatch(layout, /export const viewport/);
		assert.match(layout, /statusBarStyle: "black-translucent"/);
	});
});
