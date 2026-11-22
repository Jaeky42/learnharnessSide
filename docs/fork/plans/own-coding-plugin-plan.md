# Plan: the fork's own coding questions plugin (runs in the browser, sealed)

**Status: a draft for the owner to approve. Nothing is built; spikes 1 to 3 are done and passed** (`docs/spikes/sealed-box/`). Written at the end of the upstream 0.6.0 session, for the next session to pick up. That session is led by one orchestrator at high effort, with worker agents at high effort; the owner names the models when starting it. Per `AGENTS.md`: investigate, ask the owner the open decisions one at a time, get this plan approved (changed where the owner says), and only then build.

## Why

- Upstream's **Coding questions** plugin runs a program the teacher model wrote, on the machine, with no sandbox, when the learner submits (`plugins/coding-questions/src/runner.ts`; its README says so). On the server that program could read `/data`: notes, sign-ins, keys. The facts are in `docs/upstream-0.6.0.md`, "Plugin security".
- The owner's choice: **write our own plugin so it is safe**, instead of sandboxing upstream's on the server. Languages (owner): **Python, JavaScript and SQL**.
- Safe means: the learner's code and the teacher's tests run **in the learner's browser, inside a sealed frame**. Nothing runs on the server or in the desktop app's server process. That is safe on the Windows PC too, where no sandbox for programs is practical.

## What is decided, and what is not

- **Decided by the owner:** own plugin; Python, JavaScript, SQL; built by agents under one orchestrator.
- **Not decided** (section "Decisions to ask the owner"): everything about names, wording, when tests run, which Python engine, what happens to upstream's plugin, limits.
- **Still open from the security list** and separate from this plan: fix 1 (the server refuses community plugins) and fix 2 (test programs get an emptied environment). Fix 2 stops mattering if upstream's plugin is taken out of the catalog.

## Facts this plan rests on

Read from the code on the shipped commit. Lines marked *(not verified)* were not run.

**The plugin contract**

- A question type needs a back end: `registerQuestionType` exists only on the back-end context (`docs/plugin-question-contract.md`). The host builds the posing tools from the plugin's `{toolName, description}`. Practice problems use `registerProblemType`. Prompt text is added with `ctx.registerInstructions`.
- **Grading is optional and, when present, runs in the server process** (`gradeAnswer`, `processSubmission`; `src/server/plugin-questions.ts`, `plugin-problems.ts`). The host sets no time limit there.
- **The browser can run the tests and the back end can execute nothing, with the public API only.** Three shapes:
  - (a) the result travels inside the answer: `answerSchema` is an object such as `{code, run}`, the editor reports "ready" only after a run of the current code, and there is no `gradeAnswer`;
  - (b) a submit-time interceptor (`registerSubmissionInterceptor`, `src/core/plugin-submissions.ts`) runs the tests when Submit is pressed and rewrites the answer. The host shows no progress during it, and Retry/Continue are never intercepted;
  - (c) either, plus a `gradeAnswer` that only checks the shape of the result and copies it into `grading`. It executes nothing.
- The agent sees the whole saved answer as JSON, including `grading`.
- The front end receives the full question payload, **model solution included**. It must not be passed into the sealed frame.
- Payload limits are the plugin's own schema. Upstream caps output at 64 KiB per stream.

**Upstream's plugin as a starting point**

- About 870 lines of TypeScript and 111 of CSS. Tied to running programs: `runner.ts`, `backend.ts`, the `tests: {program, args, code}` recipe and the instruction text in `contract.ts`. Reusable: `editor.ts` (CodeMirror 6), `diagnostics.ts`, `result-view.ts` (the badge and the output disclosure), `solution-view.ts`, `question-view.ts`, `disclosure.ts`, `styles.css`.
- Its build bundles CodeMirror's whole language catalogue (1.8 MB of chunks). Three language modes would be much smaller *(not verified)*.
- **Licence:** the plugin and the repository are AGPL-3.0-only. A copy may be changed and shipped if it stays AGPL-3.0, keeps the notices, and its source stays public (the fork is public). Its README says a fork needs its own id and its own tool names.

**Shipping a plugin the fork owns**

- The core plugins are listed in **`core-plugins.json`**, read by `src/server/plugins.ts`, `scripts/build-core-plugins.mjs`, `scripts/build-server.mjs` and `scripts/smoke-core-plugins.mjs`. `npm run plugins:setup` runs `npm ci` in every `plugins/*` that has a `package.json` and needs a lockfile there.
- Hard-coded lists that must learn of a fifth plugin: `tests/desktop-payload.test.ts` (the exact four), `scripts/build-plugin-authoring.mjs` (`AUTHORING_PROJECTS`), `tests/helpers/plugin-authoring-fixture.ts`, and the word "four" in `scripts/smoke-core-plugins.mjs`.
- Every core plugin starts off, per device (`plugins-state.json`). There is no "hidden" state: a plugin is in the catalog or it isn't.
- **Tool names are global per turn.** On a clash, the plugin whose id sorts later loses all its contributions for that turn. The new plugin must not use `coding_question` or `coding_problem`.
- Taking upstream's plugin out of the catalog frees its id; saved sessions with its questions then show "Question unavailable" with Dismiss.
- As a community plugin instead (`<data>/plugins`): installed by hand on each device, not updated with releases, shown under the trust warning. Not recommended.

**Frames and assets**

- Plugin files are served only from `/api/plugins/<id>/assets/…`, with `Cache-Control: no-store`. `.wasm`, `.mjs`, `.zip` and `.gz` are served as `application/octet-stream`. Every file of every discovered plugin is held in the server's memory.
- **A sandboxed frame cannot fetch those files**, on the desktop (the API secret is added only to requests of the app window's main frame; `electron/desktop-api.cjs`) or on the server (no login cookie reaches an opaque origin) *(the server half not verified)*. So the plugin's own code, in the page, fetches the bytes and hands them to the frame.
- The model to copy is the interactive demo's frame (`components/artifacts/demo-card.tsx`): `sandbox="allow-scripts"` only, `srcDoc`, messages accepted only from the frame's own window.
- The app sends no Content-Security-Policy and no cross-origin isolation headers, so there is no `SharedArrayBuffer`. A runaway run can only be stopped by ending its worker.
- Rich code blocks already ships a wasm engine in a worker (`plugins/rich-code-blocks/src/tex-runner.ts`): one job at a time, 10 s limit, `terminate()` on timeout. Its worker is same-origin, so it is not a model for sealing, only for packaging and limits.
- **A plain same-origin worker is not sealed:** its requests carry the login cookie and pass the server's same-origin rule. Learner and teacher code must never run in one.

**Engines** (npm metadata; none is a dependency today)

| Engine | Licence | Size | Notes |
|---|---|---|---|
| Pyodide (CPython in wasm) | MPL-2.0 | about 14 MB | Full standard library. No interrupt without `SharedArrayBuffer`: stop = end the worker, then a cold start. `sqlite3` is in the standard library (run in the spike). |
| MicroPython (wasm) | MIT | about 2.4 MB | Small and fast to start; not the full standard library. |
| sql.js (SQLite in wasm) | MIT | under 1 MB needed | |
| QuickJS (wasm) | MIT | about 0.65 MB | Its own interrupt and memory limits. Alternative to running JavaScript directly in the worker. |

**Rules that already cover any plugin** (nothing to build)

- Under 640 px in a browser a plugin's question and problem are parked (`components/phone/parked-plugin-question.tsx`). An iPad gets the computer layout.
- On a session another device holds, the dock is gone and the server refuses answers (`tests/sync-plugins-gate.test.ts`).
- Plugin on/off and plugin data are per device. A plugin question's answer is part of the chat record, in the existing format: **no sync protocol change**.

## Proposed design (for the owner to approve or change)

- **A core plugin of the fork**, in `plugins/<new id>`, added to `core-plugins.json`. Its source starts as a copy of upstream's plugin's reusable front-end files, under AGPL-3.0 with the notices kept.
- **Back end:** registers one teaching question type and one practice problem type under new tool names, and the instruction text for the teacher and the practice agent. It imports no `child_process`. Recommended: shape (c), a `gradeAnswer` / `processSubmission` that checks the result's shape and size and copies it, so the result sits where the teacher already looks.
- **The payload the teacher writes** (proposal): `{language: "python" | "javascript" | "sql", starterCode?, modelSolution, tests: {code}}`, plus for SQL a `setup` script. There is no `program` and no `args`: nothing names an executable any more.
  - Python and JavaScript: the test code runs after the learner's code in the same module and fails by raising.
  - SQL: `setup` builds the tables, the learner's statement runs, and the test is either an expected result table or a checking query. To be settled with the owner.
- **Front end:** the editor with three language modes, a way to run (decision below), the result badge and output, the model solution after submitting, as upstream shows them.
- **The sealed runner:**
  - an `<iframe sandbox="allow-scripts">` with `srcdoc`, never `allow-same-origin`;
  - a meta Content-Security-Policy in that document: nothing loads from the network (`default-src 'none'`, `connect-src 'none'`), workers only from `blob:`, scripts only from `blob:` plus `'wasm-unsafe-eval'` (the spike needed no `'unsafe-eval'`);
  - **the learner's code runs only in a worker started inside the frame**, never on the frame's own thread, so a busy loop can't freeze the app;
  - the plugin's page code fetches the engine's files from its own assets and transfers the bytes to the frame, which passes them to the worker. The engine starts from those bytes, with no network;
  - one run at a time; a time limit, an output limit and a code-size limit; on timeout the worker is ended and a fresh one started;
  - messages are accepted only from the frame's own window, and every field of a result is checked before it is shown or saved;
  - the frame receives the learner's code, the tests and (SQL) the setup. Never the model solution, the session, or anything else.
- **Keeping the download small:** the engine's files are cached in the browser between visits (the asset route says `no-store`), keyed by the plugin's revision. Python's engine loads only when a Python question is opened.
- **What the result is:** an observation reported by the learner's own browser. It can be forged, and the tests share a realm with the learner's code. For self-study that is acceptable; the instruction text should tell the teacher so (upstream's already says tests are observations, not proof).

## Spikes

**Spikes 1 to 3 are done and passed**, in Chromium and on the owner's iPad. The page, the worker's source, the numbers and the recipe that worked are in `docs/spikes/sealed-box/`. Read its README before building the runner: it is the starting point for work packages B and C.

1. ✅ **A worker inside a sealed frame.** A classic `blob:` worker starts in an opaque-origin `srcdoc` frame under a strict policy, and from the frame and from the worker the page, storage and the network are refused. Chromium and the iPad's WebKit (inside the Claude app's web view).
   - **Left to check:** Safari itself on the iPad (same engine), the packaged desktop app, and the frame fed from the plugin's real asset route.
2. ✅ **Python from handed-over bytes.** Pyodide starts with no network in 0.8 s on the iPad (2.1 s in the sandbox's Chromium), is stopped by ending the worker, starts again in 1.0 s, and held a 150 MB program. MicroPython starts in 16 ms and ran the test loop 2.5 to 5 times slower. **On these numbers full Python needs no fallback on the iPad**; the choice is still the owner's (decision 3).
3. ✅ **SQL.** sql.js from handed-over bytes: 15 ms to start. Pyodide's own `sqlite3` is there too.
4. **Weight** (not done). What the engine's files add to the installer, the server image and the server's memory (every plugin file is held in memory), and how long the first load takes from the real server to the iPad. On the test page's host the 11.6 MB came down in 1.3 s. Fallback: ship the Python engine compressed.
5. **The submit flow** (not done). Shapes (a), (b) and (c) tried against the real host with a stand-in model (recipe below): which one gives a result the teacher sees and a flow that feels right. The owner picks from what is shown.

## Decisions to ask the owner (one per question, with pictures where it is about a screen)

1. The plugin's name in Settings, its description, and its id.
2. What happens to upstream's Coding questions: taken out of the catalog (recommended: it is the unsafe one, and two coding plugins confuse the teacher), or left listed and off.
3. Python engine: full Python (large download, slow first start) or MicroPython (small, fast, not every library). Show the spike's numbers.
4. When tests run: a **Run** button in the editor (the learner sees results before submitting, and may fix and re-run), at **Submit** only, or both.
5. SQL: how a test is written and shown (expected table, or a checking query), and which SQL dialect notes the teacher is given.
6. Limits: seconds per run, output size, code size.
7. The wording: the tool descriptions and the instruction text for the teacher and the practice agent (prompt wording is the owner's), the badge texts, the Run button, error and timeout messages, the "loading Python" line.
8. Whether the result is saved as upstream saves it (so old and new questions look alike in a lesson) and how a timeout or a crashed engine reads.
9. On a phone: stays parked like every plugin question (default), or a phone layout in a later round.
10. Whether fix 1 (the server refuses community plugins) ships with this.

## Work packages (after the spikes and the owner's answers)

One agent per package, each owning its own files; the orchestrator merges, runs the checks and talks to the owner. Agents never decide wording or behaviour: anything undecided goes into their report under "Open questions".

| # | Package | Owns | Depends on |
|---|---|---|---|
| A | **Scaffold and catalog.** New `plugins/<id>` (package.json, lockfile, build script, manifest, licence and third-party notices), `core-plugins.json`, the four hard-coded lists, `tests/desktop-payload.test.ts`. If upstream's plugin leaves the catalog: its entry, and the three host tests that import its source. | repo-level plugin lists, the new plugin's build files | decisions 1, 2 |
| B | **The sealed runner.** The frame document, the worker, the message protocol, limits, timeout and restart, the byte transfer, the browser cache. Unit tests for the protocol and the result checker. | `plugins/<id>/src/runner/**` | spikes 1, 4 |
| C | **Engines.** Python, JavaScript and SQL adapters inside the worker; how tests and learner code are combined per language; output capture. Tests that run real code in a headless browser. | `plugins/<id>/src/engines/**` | B, spikes 2, 3, decisions 3, 5 |
| D | **Contract and back end.** Schemas, the question and problem types, the copy-only grading, the instruction text exactly as approved. Tests: the back end imports no process or file module; a malformed result is refused. | `plugins/<id>/src/contract.ts`, `backend.ts` | decisions 4, 6, 7, 8 |
| E | **Screens.** The editor with three modes, Run, results, model solution, loading and error states, keyboard handling, themes (theme tokens only), the tablet touch rules. | `plugins/<id>/src/main.ts`, views, CSS | B, D, decisions 4, 7 |
| F | **Adversarial review** (a fresh agent, given only the built plugin and the security requirements below): try to reach the app's API, the cookie, storage, the network, the model solution; forge or flood results; freeze the app. Every finding fixed or shown to the owner. | nothing (read and report) | A–E |
| G | **Checks and docs.** `npm test`, typecheck, lint, the plugin's own tests, a real-browser run with the stand-in model on a computer and in the iPad set-up, both workflows as dry runs, `docs/` updated, a "what to try" list for the owner. | docs, workflow test lists | all |

## Security requirements (the acceptance list)

1. No file of the plugin's back end imports `child_process`, `worker_threads`, `vm`, or writes outside its own settings. A test reads the built `backend.cjs` for those.
2. Learner and teacher code executes only inside the worker inside the sealed frame. A test asserts the frame's `sandbox` is exactly `allow-scripts` and that the CSP is present.
3. From inside the frame, with real code: a request to the app's API fails; a request to any other site fails; `document.cookie`, `localStorage` and `indexedDB` of the app are unreachable.
4. The model solution and session content never appear in any message sent to the frame.
5. A result is accepted only from the frame's own window, only in the expected shape, and cut to the output limit.
6. An endless loop, a memory hog and a flood of output each end in the timeout or error state within the limit, and the app stays usable.
7. Nothing the plugin shows from a run is treated as HTML.

## How to check it without a real model

A stand-in for an OpenAI-compatible provider makes the teacher pose a question on demand. Worked out in the 0.6.0 session:

- **Settings in a scratch data folder:** `customProvider` with a `baseUrl` on `127.0.0.1`, one model with a large `context`, `authMode: "keyless"`, and its binding record in the auth file; the `strong`, `cheap` and `vision` slots and the test session's own `settings.model` pointing at it, with `thinkingLevel: "off"` (a stand-in model refuses a thinking level).
- **The stand-in server** answers `/v1/models`, and streams chat completions as `chat.completion.chunk` events. To pose a question it returns one `tool_calls` delta naming the plugin's tool with JSON arguments, then `finish_reason: "tool_calls"`. It can log each request's `tools` to learn the exact schema.
- A practice problem's arguments are `{statement, mode, modelSolution, payload}`; a teaching question's are `{type, nodeId, question, payload}` with a `nodeId` from the session's plan map (the golden teaching chat in `tests/fixtures/golden-data` has one). A teaching "check" waits closed behind **Open**.
- Switch plugins on in the scratch folder's `plugins-state.json`.
- An iPad set-up: Playwright `devices["iPad Pro 11 landscape"]`, touch through CDP `Input.dispatchTouchEvent`, a pen as `Input.dispatchMouseEvent` with `pointerType: "pen"`.
- Scripts that stop helper processes must not contain the process's name on their own command line (`pkill -f` matches the shell that runs it): keep them in files.

## Shipping

- Both the desktop release and the server image carry the plugin. Each push to `side-tutor` and to the server's branch needs the owner's approval, after both workflows pass as dry runs.
- No sync protocol change. The plugin is off until switched on, per device.
- Tell the owner what the engine adds to the download and to the first load on the iPad.

## Risks

- ~~Safari may not start a worker inside a sealed frame, or may run out of memory with full Python on an iPad.~~ Answered by spikes 1 and 2: it works on the owner's iPad. An iPhone has less memory and was not tried (plugin questions are parked on a phone anyway).
- Full Python is a large download each time the browser's cache is empty, and a cold start after every timeout.
- The teacher model must write tests in the new, smaller format; the instruction text needs a round of tries with a real model, which only the owner's devices have.
- A copy of upstream's plugin doesn't get upstream's later fixes by a merge; changes there have to be read and carried over by hand.
- Results can be forged by the learner. Accepted for self-study; say so in the instruction text.

## Not in this plan

- Other languages (C, C++, Java, Rust): a browser can't run them in any practical way.
- A phone layout for the plugin.
- A Content-Security-Policy for the app's own pages (security fix 4), and approving community plugins by hash (fix 5).
