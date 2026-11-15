/**
 * The gateway's pages before sign-in (/login, /setup; the next slices add
 * /invite, /reset and the recovery codes with `pageShell`), built like
 * src/server/server-auth-pages.ts: self-contained HTML, one inline style and
 * one inline script, the same CSP. Always in the app's standard dark theme
 * (the owner's decision), never anyone's saved theme. Every word comes from
 * src/core/account-screens.ts.
 */

import {
	PASSWORDS_DONT_MATCH,
	SETUP_TEXT,
	SIGN_IN_TEXT,
	USE_AT_LEAST,
} from "../src/core/account-screens.ts";
import { PASSWORD_MIN_LENGTH } from "../src/core/server-auth.ts";
import { DEFAULT_THEME } from "../src/core/themes.ts";
import { NO_STORE } from "./gate.ts";

export interface PagePalette {
	mode: "dark" | "light";
	background: string;
	surface: string;
	border: string;
	text: string;
	textMuted: string;
	error: string;
}

/** The Default theme's colours (what a single-copy server shows with no saved theme). */
export const STANDARD_DARK_PALETTE: PagePalette = {
	mode: "dark",
	background: DEFAULT_THEME.colors.background,
	surface: DEFAULT_THEME.colors.surface,
	border: DEFAULT_THEME.colors.border,
	text: DEFAULT_THEME.colors.text,
	textMuted: DEFAULT_THEME.colors.textMuted,
	error: DEFAULT_THEME.colors.error,
};

/** The pages' CSP and headers, as today's (src/server/server-auth.ts `html`). */
export const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; manifest-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

export function htmlResponse(body: string, status = 200): Response {
	return new Response(body, {
		status,
		headers: { ...NO_STORE, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": PAGE_CSP, "Referrer-Policy": "no-referrer" },
	});
}

export function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** A string as a JavaScript literal that is safe inside an inline <script>. */
export function jsString(text: string): string {
	return JSON.stringify(text).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

const colors = (p: PagePalette): string =>
	`:root { color-scheme: ${p.mode}; --bg: ${p.background}; --card: ${p.surface}; --fg: ${p.text}; --muted: ${p.textMuted}; --border: ${p.border}; --error: ${p.error}; }`;

const STYLE = `
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 "JetBrains Mono", ui-monospace, "Cascadia Mono", Consolas, monospace;
  display: grid; place-items: center; padding: max(16px, env(safe-area-inset-left)) max(16px, env(safe-area-inset-right)); }
main { width: 100%; max-width: 360px; background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 24px; display: flex; flex-direction: column; gap: 16px; }
h1 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: .02em; }
p { margin: 0; color: var(--muted); font-size: 13px; }
form { display: flex; flex-direction: column; gap: 12px; }
label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--muted); }
.help { font-size: 12px; color: var(--muted); }
input { font: inherit; font-size: 16px; color: var(--fg); background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; width: 100%; }
input:focus-visible, button:focus-visible, a:focus-visible { outline: 2px solid var(--muted); outline-offset: 2px; }
button { font: inherit; font-weight: 600; color: var(--bg); background: var(--fg); border: 0; border-radius: 6px; padding: 10px 12px; cursor: pointer; min-height: 40px; }
button[disabled] { opacity: .6; cursor: default; }
.error { color: var(--error); font-size: 13px; min-height: 1.5em; }
nav { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px 16px; font-size: 13px; }
a { color: var(--muted); }
`;

export interface ShellOptions {
	/** The <title> before " · LearnHarness". */
	title: string;
	/** The inside of <main>; one <form data-action> with a #error line and a submit button. */
	body: string;
	/**
	 * A JavaScript function expression `(form) => payload | string`; a string
	 * is shown in the error line instead of sending. `value(id)` reads a field
	 * (form.name would be the form's own name, not the field).
	 */
	payload: string;
	/**
	 * A JavaScript function expression `(body) => void` run after a 2xx answer
	 * with its JSON; by default the page goes to "/".
	 */
	onSuccess?: string;
	palette?: PagePalette;
}

/** The one page shell every gateway page uses. */
export function pageShell(options: ShellOptions): string {
	const palette = options.palette ?? STANDARD_DARK_PALETTE;
	const onSuccess = options.onSuccess ?? `function () { window.location.replace("/"); }`;
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="${palette.background}">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="LearnHarness">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>${escapeHtml(options.title)} · LearnHarness</title>
<style>${colors(palette)}${STYLE}</style>
</head>
<body>
<main>
${options.body}
</main>
<script>
(function () {
  var form = document.querySelector("form");
  var error = document.getElementById("error");
  var button = form.querySelector("button[type=submit]");
  var done = (${onSuccess});
  function value(id) { return document.getElementById(id).value; }
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    error.textContent = "";
    button.disabled = true;
    var payload = (${options.payload})(form);
    if (typeof payload === "string") { error.textContent = payload; button.disabled = false; return; }
    fetch(form.getAttribute("data-action"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      credentials: "same-origin"
    }).then(function (response) {
      if (response.ok) { return response.json().then(done, function () { done({}); }); }
      return response.json().then(function (body) { error.textContent = body.error || "Something went wrong. Try again."; },
        function () { error.textContent = "Something went wrong. Try again."; });
    }, function () {
      error.textContent = "The server couldn't be reached. Check your connection and try again.";
    }).then(function () { button.disabled = false; });
  });
})();
</script>
</body>
</html>`;
}

export interface FieldOptions {
	id: string;
	label: string;
	type?: "text" | "password";
	autocomplete: string;
	/** Lines under the label. */
	help?: string[];
	autofocus?: boolean;
	minlength?: number;
	placeholder?: string;
	/** A code: capitals, no spell check. */
	code?: boolean;
	/** A name: no capitals added, no spell check. */
	plain?: boolean;
}

export function field(o: FieldOptions): string {
	const attrs = [
		`id="${o.id}"`, `name="${o.id}"`, `type="${o.type ?? "text"}"`, `autocomplete="${o.autocomplete}"`,
		o.code ? `autocapitalize="characters" spellcheck="false"` : "",
		o.plain ? `autocapitalize="none" autocorrect="off" spellcheck="false"` : "",
		o.placeholder ? `placeholder="${escapeHtml(o.placeholder)}"` : "",
		o.minlength ? `minlength="${o.minlength}"` : "",
		"required",
		o.autofocus ? "autofocus" : "",
	].filter(Boolean).join(" ");
	const help = (o.help ?? []).map((line) => `\n    <span class="help">${escapeHtml(line)}</span>`).join("");
	return `  <label for="${o.id}">${escapeHtml(o.label)}${help}
    <input ${attrs}>
  </label>`;
}

export function form(action: string, fields: string[], submit: string): string {
	return `<form data-action="${escapeHtml(action)}" novalidate>
${fields.join("\n")}
  <div id="error" class="error" role="alert"></div>
  <button type="submit">${escapeHtml(submit)}</button>
</form>`;
}

/** The client-side check of a new password and its repeat (today's two sentences). */
export function newPasswordCheck(passwordId: string, confirmId: string): string {
	return `if (value(${jsString(passwordId)}) !== value(${jsString(confirmId)})) return ${jsString(PASSWORDS_DONT_MATCH)};
    if (Array.from(value(${jsString(passwordId)})).length < ${PASSWORD_MIN_LENGTH}) return ${jsString(USE_AT_LEAST)};`;
}

export function loginPageHtml(): string {
	return pageShell({
		title: SIGN_IN_TEXT.submit,
		body: `
<h1>${escapeHtml(SIGN_IN_TEXT.title)}</h1>
${form("/api/server-auth/login", [
		field({ id: "name", label: SIGN_IN_TEXT.nameLabel, autocomplete: "username", plain: true, autofocus: true }),
		field({ id: "password", label: SIGN_IN_TEXT.passwordLabel, type: "password", autocomplete: "current-password" }),
	], SIGN_IN_TEXT.submit)}
<nav>
  <a href="/invite">${escapeHtml(SIGN_IN_TEXT.inviteLink)}</a>
  <a href="/reset">${escapeHtml(SIGN_IN_TEXT.forgotLink)}</a>
</nav>`,
		payload: `function () { return { name: value("name"), password: value("password") }; }`,
	});
}

export function setupPageHtml(): string {
	return pageShell({
		title: "Set up",
		body: `
<h1>${escapeHtml(SETUP_TEXT.title)}</h1>
<p>${escapeHtml(SETUP_TEXT.intro)}</p>
${form("/api/server-auth/setup", [
		field({ id: "code", label: SETUP_TEXT.codeLabel, autocomplete: "one-time-code", code: true, placeholder: "XXXX-XXXX", autofocus: true }),
		field({ id: "name", label: SETUP_TEXT.nameLabel, autocomplete: "username", plain: true, help: [SETUP_TEXT.nameHelp] }),
		field({ id: "password", label: SETUP_TEXT.passwordLabel, type: "password", autocomplete: "new-password", minlength: PASSWORD_MIN_LENGTH }),
		field({ id: "confirm", label: SETUP_TEXT.confirmLabel, type: "password", autocomplete: "new-password" }),
	], SETUP_TEXT.submit)}`,
		payload: `function (form) {
    ${newPasswordCheck("password", "confirm")}
    return { code: value("code"), name: value("name"), password: value("password") };
  }`,
	});
}

// ─── The home-screen app's manifest ──────────────────────────────────────────

/** app/manifest.ts's content, in the standard dark colours always. */
export function manifestJson(): Record<string, unknown> {
	const background = STANDARD_DARK_PALETTE.background;
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

export function manifestResponse(): Response {
	return new Response(JSON.stringify(manifestJson()), {
		headers: { ...NO_STORE, "Content-Type": "application/manifest+json; charset=utf-8" },
	});
}
