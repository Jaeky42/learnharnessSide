# Sealed box test (spikes 1 to 3 of `docs/own-coding-plugin-plan.md`)

A throwaway test page, kept so the result can be reproduced and the working recipe isn't lost. It is not part of the app and nothing imports it.

- `page.html`: the page. It builds the sealed frame, runs each check and prints the results. Written for a host that wraps it in a document (no `<html>` or `<body>` of its own).
- `worker-entry.js`: the engine worker's source. Bundled into one classic script, `engines/worker.bundle.js`.

## What it proved

Run in Chromium (headless, the development sandbox) and on the owner's iPad (WebKit, inside the Claude app's web view; iPadOS, 8 cores). Every check passed on both.

| Check | Chromium | iPad |
|---|---|---|
| A `sandbox="allow-scripts"` `srcdoc` frame starts; its origin is `null` | yes | yes |
| From the frame: the parent page, storage, a request to another site and a request to the host's own site are all refused | yes | yes |
| A classic `blob:` worker starts inside the frame | yes | yes |
| A module `blob:` worker starts inside the frame (not needed) | no | yes |
| From the worker: `fetch`, `XMLHttpRequest`, `WebSocket` and `indexedDB` are refused; WebAssembly runs | yes | yes |
| JavaScript answer and tests in a fresh worker | yes | yes |
| An endless loop is ended by `terminate()` and the frame still answers | yes | yes |
| sql.js from handed-over bytes: start / query | 12 ms / 29 ms | 15 ms / 7 ms |
| MicroPython from handed-over bytes: start / 2 million loop steps | 22 ms / 1.2 s | 16 ms / 0.4 s |
| Pyodide from handed-over bytes: start / 2 million loop steps | 2.1 s / 0.24 s | 0.83 s / 0.16 s |
| Pyodide after a timeout: stopped, then started again | 1.4 s | 1.0 s |
| Pyodide holds a 150 MB `bytearray` | yes | yes |
| Pyodide's standard library, `sqlite3` included | yes | yes |

**Cookies.** Chromium throws on `document.cookie` in the sealed frame. WebKit returns an empty string and silently drops a write (`read "", after writing ""`): the frame has no cookie jar, which is the same protection. A test for the real plugin must check the value, not expect an exception. On the test page's host the page itself could not keep a cookie either, so "the box can't see the page's cookie" was only shown in Chromium.

**Not covered:** Safari itself on the iPad (same engine, not run), an iPhone, the packaged desktop app, and the page served by the real app (the plugin's own asset route).

## The recipe that worked

- **Frame policy:** `default-src 'none'; script-src 'unsafe-inline' blob: 'wasm-unsafe-eval'; worker-src blob:; connect-src 'none'`. No `'unsafe-eval'` was needed by any of the three engines. `'unsafe-inline'` is for the frame's own start-up script; a hash would be stricter.
- **One classic worker script, no imports at run time.** The engines' JavaScript is bundled with the worker's code into one IIFE (esbuild). The frame makes a `blob:` of that text and starts a classic worker. No module worker and no dynamic `import()` are needed, which is what failed in Chromium.
- **Pyodide 314.0.7 without a network:**
  - `createPyodideModule`: pass the default export of `pyodide.asm.mjs` (bundled in), so it isn't imported from a URL;
  - `lockFileContents`: pass the parsed `pyodide-lock.json`, so it isn't fetched;
  - `indexURL` and `packageBaseUrl`: any absolute address that is never used (`https://sealed.invalid/py/`);
  - `self.fetch` is replaced before start-up by a function that answers `pyodide.asm.wasm` and `python_stdlib.zip` from the handed-over bytes (with `content-type: application/wasm` for the first, so streaming compilation works) and refuses everything else.
- **MicroPython 1.29.0-6** (`@micropython/micropython-webassembly-pyscript`): its `.mjs` ends in a Node-only block with top-level `await`, which an IIFE bundle can't hold. A copy with that block removed bundles fine. `loadMicroPython({ url })` then fetches the wasm through the same replaced `fetch`.
- **sql.js 1.16.0:** `initSqlJs({ wasmBinary })`.
- **JavaScript:** no engine. The frame builds a fresh `blob:` worker whose source is a small harness, the learner's code and the tests, so nothing is evaluated from a string.
- **Stopping:** the frame owns the timer, because the worker's thread is the one that is stuck. `terminate()`, then a new worker; Python starts cold again from the bytes the page still holds (the page hands over copies).

## Rebuilding it

```
npm install pyodide@314.0.7 sql.js@1.16.0 @micropython/micropython-webassembly-pyscript@1.29.0-6
# copy micropython.mjs to micropython.patched.mjs without its trailing Node-only block
npx esbuild@0.24.2 worker-entry.js --bundle --format=iife --platform=browser --target=safari15 --minify \
  --external:node:* --external:ws --external:fs --external:path --external:url --external:module \
  --external:crypto --external:child_process --external:vm --external:worker_threads \
  --define:import.meta.url='"https://sealed.invalid/py/x.mjs"' --outfile=engines/worker.bundle.js
```

Beside the page, in `engines/`: `worker.bundle.js`, `sql-wasm.wasm`, `micropython.wasm`, `pyodide.asm.wasm`, `pyodide-lock.json`, and `python_stdlib.zip` as base64 text (`python_stdlib.b64.txt`; the test page's host serves no archives).

Sizes: `pyodide.asm.wasm` 9.2 MB, `python_stdlib.zip` 2.4 MB, the bundled worker 1.2 MB (Pyodide's own script is 1.25 MB of it before minifying), `sql-wasm.wasm` 0.7 MB, `micropython.wasm` 0.45 MB.
