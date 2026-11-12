/**
 * The two pages a signed-out visitor can see in server mode: /login and
 * /setup (src/server/server-auth.ts). Self-contained HTML on purpose: the
 * app's root layout mounts the sidebar and the live event stream, which
 * would only call APIs the gate refuses before sign-in. They paint with the
 * server's saved theme (server-auth-theme.ts), so they look like the app.
 * The colours go into the page's own inline <style>, the one source the
 * pages' CSP allows ('unsafe-inline', src/server/server-auth.ts).
 */

import { PASSWORD_MIN_LENGTH } from "../core/server-auth.ts";
import { authPagePalette, type AuthPagePalette } from "./server-auth-theme.ts";

/** The theme's colours as the page's variables. Exported for tests. */
export function authPageColors(p: AuthPagePalette): string {
	return `:root { color-scheme: ${p.mode}; --bg: ${p.background}; --card: ${p.surface}; --fg: ${p.text}; --muted: ${p.textMuted}; --border: ${p.border}; --error: ${p.error}; }`;
}

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
input { font: inherit; font-size: 16px; color: var(--fg); background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; width: 100%; }
input:focus-visible, button:focus-visible { outline: 2px solid var(--muted); outline-offset: 2px; }
button { font: inherit; font-weight: 600; color: var(--bg); background: var(--fg); border: 0; border-radius: 6px; padding: 10px 12px; cursor: pointer; min-height: 40px; }
button[disabled] { opacity: .6; cursor: default; }
.error { color: var(--error); font-size: 13px; min-height: 1.5em; }
`;

function page(title: string, body: string, script: string, palette: AuthPagePalette): string {
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
<title>${title} · LearnHarness</title>
<style>${authPageColors(palette)}${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
<script>
(function () {
  var form = document.querySelector("form");
  var error = document.getElementById("error");
  var button = form.querySelector("button");
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    error.textContent = "";
    button.disabled = true;
    var payload = (${script})(form);
    if (typeof payload === "string") { error.textContent = payload; button.disabled = false; return; }
    fetch(form.getAttribute("data-action"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      credentials: "same-origin"
    }).then(function (response) {
      if (response.ok) { window.location.replace("/"); return; }
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

export function loginPageHtml(palette: AuthPagePalette = authPagePalette()): string {
	return page("Sign in", `
<h1>LearnHarness</h1>
<form data-action="/api/server-auth/login" novalidate>
  <label for="password">Password
    <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
  </label>
  <div id="error" class="error" role="alert"></div>
  <button type="submit">Sign in</button>
</form>`, `function (form) { return { password: form.password.value }; }`, palette);
}

export function setupPageHtml(palette: AuthPagePalette = authPagePalette()): string {
	return page("Set up", `
<h1>Set up LearnHarness</h1>
<p>Enter the setup code from the server log, then choose a password of at least ${PASSWORD_MIN_LENGTH} characters.</p>
<form data-action="/api/server-auth/setup" novalidate>
  <label for="code">Setup code
    <input id="code" name="code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX" required autofocus>
  </label>
  <label for="password">New password
    <input id="password" name="password" type="password" autocomplete="new-password" minlength="${PASSWORD_MIN_LENGTH}" required>
  </label>
  <label for="confirm">Type it again
    <input id="confirm" name="confirm" type="password" autocomplete="new-password" required>
  </label>
  <div id="error" class="error" role="alert"></div>
  <button type="submit">Create password</button>
</form>`, `function (form) {
    if (form.password.value !== form.confirm.value) return "The two passwords don't match.";
    if (Array.from(form.password.value).length < ${PASSWORD_MIN_LENGTH}) return "Use at least ${PASSWORD_MIN_LENGTH} characters.";
    return { code: form.code.value, password: form.password.value };
  }`, palette);
}
