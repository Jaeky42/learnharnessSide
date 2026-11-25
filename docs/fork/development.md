# Development notes and recipes

## Commands, Node versions and known test failures

- CI uses Node 26 with npm 11. Use npm 11 for lockfile changes (`npx npm@11 install …`); npm 10 rewrites the lockfile's `libc` fields.
- A local `npm run build` needs network access to Google Fonts (next/font).
- **`npm run plugins:setup`** after `npm ci`, or the build and several tests fail.
- **Upstream's plugin SDK type tests** (`tests/plugin-*types.test.ts`) each run the TypeScript compiler with a 30-second limit. Beside the fork's larger suite on GitHub's runner one of them ran out of time, twice in a row. `server-image.yml` runs those seven on their own first, one at a time, then every other test. `npm test` locally still runs everything together.
- **`docs/plugin-api/`** is generated: `node scripts/build-plugin-types.mjs <dir>`, then `node scripts/build-plugin-api-reference.mjs <dir> docs/plugin-api`. A test fails when it is stale, which happens whenever the fork adds an event (`cloud-changed`).
- **On Node 22**, `tests/subscription-auth.test.ts` has one known failure. CI uses Node 26.
- On Node 22, `tests/subscription-auth.test.ts` has one failure that also happens without any fork changes (a Node-version difference).
- **Known test failures in the development sandbox** (Node 22, no IPv6): `tests/safe-fetch.test.ts` hangs and must be left out of a full run; `tests/safe-fetch-connector.test.ts`, `tests/passive-tooltip.test.tsx` and one case of `tests/plugin-document-proxy.test.ts` fail. All four behave the same on an untouched upstream v0.6.0 checkout. And one case of `tests/subscription-auth.test.ts` fails (on Node 22.23: 19 tests, 18 pass), a Node-version difference (the two bullets above). CI (Node 26) runs them all.
- **A gateway test that makes its state on the helpers' fixed clock must give the gateway that clock too** (`now: () => h.clock.now` in `startGateway`'s options; the helpers' clock starts on 15 November 2026, `T0` in `tests/helpers/gateway-fakes.ts`). Two cases of `tests/gateway-review.test.ts` redeemed an invite code through a gateway on the real clock: from 22 November 2026 12:00 UTC the invite (7 days) had run out, the redeem was refused and the test waited forever, which hung the server image workflow's test step until its 30-minute limit. One case of `tests/gateway-lifecycle.test.ts` would have failed the same way from 15 December (a session's 30 days). To look for more: run the gateway and accounts tests with the clock moved ahead (a `--require` preload that shifts `Date`); `review 7: the backup beside the accounts file` fails under such a preload only because file times can't be shifted.
- **Known CI flake:** `tests/notes-import-route.test.ts` (first test, "out-of-order completion remains supported") depends on timer order and fails now and then on GitHub's runners. It isn't related to this work: re-run the failed job. A separate task to make it deterministic was offered to the owner.
- **`assert.equal` on two DOM nodes that differ can hang** while it builds its message (it tried to diff linkedom nodes: 1.4 GB, 100% CPU). Compare ids or text.

## Coding gotchas

- **Colouring a border:** `app/globals.css` sets `* { border-color }` outside any layer, which beats Tailwind's `border-<colour>` utilities. Use a separate element with a background colour (see `Notice` in `obsidian-section.tsx`).
- **Desktop must not change:** server-only UI keys off `isServerMode()` (the `lh_server` cookie) with no extra requests. `tests/claude-code-status-ui.test.tsx` pins the desktop's exact request list.

## Running server mode locally

- **Run server mode locally:** `LH_SERVER_MODE=1 LH_DATA_DIR=<tmp>/data LH_AUTH_FILE=<tmp>/secrets/auth.json npx next dev -p 3100`.
  - The setup code is printed in the log.
  - The login cookie is `Secure`, which browsers accept on `http://localhost`.
  - `next dev` rewrites one line of `AGENTS.md`; run `git checkout -- AGENTS.md` before committing.
- **The dev server keeps server objects across code reloads.** After editing `src/server/obsidian-sync.ts`, restart `next dev`; otherwise routes call methods the old manager object doesn't have.
- **The local dev server** (`next dev` on port 3100) doesn't survive between turns in a cloud session; start it with `setsid nohup … &` and check it answers before each browser run.
- **`next dev` only:** upstream's lesson screen assigns to a ref's property during render, which React's development server renderer refuses ("object is not extensible"). The lesson page's server render answers 500 and the page then renders in the browser. Production builds aren't affected. It is upstream's, not the merge's.

## The development sandbox: network and Docker

- **Never run real `claude auth login/logout` in a cloud dev session.** It can sign out the session's own Claude Code. Put a stand-in `claude` script first on `PATH` (see `tests/server-sign-in.test.ts` for one that mimics the real output).
- **Sandbox network:**
  - `auth.openai.com` and `claude.ai` are usually blocked, so real sign-ins can only be tested on the VPS.
  - Docker works after starting `dockerd`. Builds need the sandbox CA and proxy passed in from outside: a local Dockerfile copy adding `COPY --from=ca ca-bundle.crt` and `NODE_EXTRA_CA_CERTS`, `--build-context ca=/root/.ccr`, `--network host`, plus the proxy build args. Never change the real Dockerfile for this.
  - Docker Hub may answer 429 (rate limit), and `apt` can't run (the proxy is HTTPS-only), so test entrypoint changes on top of an image that's already built.
- **`pkill -f` in a cloud session matches the shell that runs it** when the pattern is on its own command line. Put such commands in a script file.
- **All processes in a cloud session share one memory limit.** Five workers running tests at once got test processes killed; run test files one at a time.

## Two copies for a sync run

- **Two real copies for a sync run:** `npx next build`, then `node scripts/build-server.mjs`, then start `.next/standalone/server.js` twice.
  - `build-server.mjs` refuses when `.next/standalone/data` exists. That happens when the repo has a local `data/` folder (tests that don't set `LH_DATA_DIR` leave one): the tracer sweeps it in. Delete `.next/standalone/data` and run the script again. A clean checkout (CI, the image) has no `data/`.
  - The server process is titled `next-server`; `pkill -f "node server.js"` doesn't find it.
  - Plain `http` works between the two because the desktop accepts it for `127.0.0.1`.
- **A full two-copy run with the loop on:** start both copies as above (`NODE_ENV=production`), pair through `POST /api/cloud {op:"pair", …}` from a page of the desktop copy (the code comes from `POST /api/server-auth/desktops {op:"code"}` in a signed-in page of the server copy), and then only watch: compare the two data folders' files. `LH_SYNC_LOOP=off` on the desktop copy turns the timed rounds off for a run that calls `{op:"sync"}` itself.
  - To play "the server is away", stop only the copy on the server's port (find it by `PORT=` in `/proc/<pid>/environ`) and start it again with the same folders.
  - With a page of the desktop copy open on the home screen, the graph view settles new concepts and saves their places a few seconds after a sync; the places are equal on both sides one round later, not at once.
  - A local `next build` rewrites `next-env.d.ts` and `AGENTS.md`; put both back before committing (`git checkout -- AGENTS.md next-env.d.ts`).
- **Browser runs of the sync screens (Phase 6):**
  - Stop a copy with `kill -9`, as Windows does to the app's server. A plain `kill` lets it run on for a while, still syncing, so the other side never sees it go offline.
  - The server counts a PC as offline 30 seconds after it last heard from it; wait at least that long before expecting "offline since …" or the warning box.
  - The warning box needs the holder's last word to be "unsent" or "busy". A PC that was idle when it stopped said "all sent", and the session then moves with no box; set `report.word` in the server's `sync/authority.json` to see the box.
  - A discard: stop the PC copy, add messages to its chat file by hand (a user message and an assistant message each; a record that ends on a user message makes the page try to continue the turn), take the session over on the server, start the PC copy.
  - The setup code works once, so a second script run against the same data folders isn't signed in on the server copy. Start each run from fresh folders, or pass the first context's `storageState()` on.
  - The live channel (`/api/events`) sends nothing until its first event or its 25-second ping, so the page's "open" can be that late. Don't wait on it in a script, and don't hang anything urgent on `useServerResync` alone.
  - A lesson's first messages come from the server-side render (`initialMessages`), not from a fetch.

## Browser runs: phone size, touch, the keyboard, dictation

- **Testing these without an iPhone:** Playwright `devices["iPhone 13"]` (iOS Safari user agent, so the Safari-tab bleed turns on); real touch through CDP `Input.dispatchTouchEvent`; the keyboard by replacing `window.visualViewport` with a fake whose `height` you set and fire `resize` on (an init script); the home-screen app by overriding `navigator.standalone` (Chromium has no clock strip, so `env(safe-area-inset-top)` is 0 there and `standaloneGap` stays 0). Chromium never shows iOS's rubber band, its top blur, its swallowed taps or its keyboard pan, so anything touching those needs the owner's phone; a temporary on-screen readout (`?scrolldebug=1`, since removed) was the way to see what the phone did.
- **Sample data for UI screenshots:** copy `tests/fixtures/golden-data` to a scratch `LH_DATA_DIR`. Truncating a copy of the teaching chat right after a `quiz` tool call gives a session with an open question. Phone screenshots: Playwright `devices["iPhone 13"]`; real touch (press and hold, pinch) through CDP `Input.dispatchTouchEvent`.
- **Dictation in a browser run:** launch Chromium with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`, grant the `microphone` permission, answer `/api/stt/token` with `{ "token": "…" }` through `context.route`, and replace `window.WebSocket` for Deepgram's address in an init script (it opens; on the `CloseStream` message it sends one `Results` message with `is_final` and closes).
- **The owner's phone screenshots are the ground truth for iPhone behaviour.** Measure them (PIL: pixel rows and columns; a full iPhone screenshot is 3 px per point, a cropped or resized one scales from the status-bar icons) before deciding what iOS does; several early guesses about Safari's bars were wrong until measured.

## Notes drawer and Tutor runs

- Playwright hides scrollbars by default; launch with `ignoreDefaultArgs: ["--hide-scrollbars"]` to get real ones. The run of the larger zones did, and dragged the conversation's scrollbar thumb beside the right strip.
- **A Tutor conversation for screenshots:** put threads in the chat record's `sideChats` (upstream's shape in `src/core/contracts/chat.ts`). The old `side-tutor/<chatId>.json` recipe ("A side tutor thread for screenshots" below) no longer applies.
- **A side tutor thread for screenshots** (**obsolete**: before the upstream 0.6.0 merge only; now put threads in the chat record's `sideChats`, as in the bullet above; the `localStorage` tip at the end still holds): write `<data>/side-tutor/<chatId>.json` (`{ "version": 1, "chatId": …, "entries": [{ "id", "question", "answer", "status": "done", "askedAt" }] }`) before loading the page. On a computer, `localStorage["lh:side-tutor:pos"]` (`{ left, top }`) puts the window over the lesson's text, which is what shows through its middle.
- **Browser runs of the notes drawer:**
  - A drag starts only after the pointer has moved a little (10 px after the hold on a phone, 5 px with the mouse), so the dragged row's centre isn't under the pointer. To rest the line on something, measure the row's centre and move the pointer by the difference.
  - `locator.dispatchEvent("contextmenu")` sends an event without a position, so the row menu lands off screen. Use a real press and hold (or a right-click) instead.
  - At desktop width the side tutor's floating window opens over the notes list and swallows clicks there. Minimise it first (the button labelled "Minimize the side tutor").
  - Playwright's `devices["iPhone 13"]` screen is 390 × 664 CSS px (Safari's bars are taken off), not 844 high.
  - The topic list is a short box above the note. A row below its visible part can't be pressed: scroll it into view first, and clear the notes earlier runs left in the scratch vault so the list stays short.
  - To have notes for a run, write files into the server's vault folder and wait until they show in the stand-in's `remote.json`; a later deletion then shows there as a record with `deleted: true`.

## Obsidian sync tests

- **The Obsidian sync tests need the real `ob` program.** It isn't a dependency of the app (licence; and its native add-on would ride into the desktop build). Install it once into a scratch folder and point the tests at it:
  - `npm install -g --prefix <scratch>/ob --allow-scripts=better-sqlite3 obsidian-headless@0.0.14` (the entrypoint's command; newer npm versions refuse `--allow-scripts` without `-g`)
  - `LH_TEST_OB_CLI=<scratch>/ob/lib/node_modules/obsidian-headless/cli.js npm test`
  - Its add-on is built for the Node that ran the install, so use the same Node for both.
  - Without `LH_TEST_OB_CLI` the end-to-end tests are skipped; CI always runs them.
- **Obsidian's servers (`api.obsidian.md`) are blocked in the sandbox.** To see Settings → Obsidian work in a browser, run server mode with the stand-in: a wrapper script `exec node --require tests/fixtures/obsidian-fake/preload.cjs <cli.js> "$@"` as `LH_OB_BINARY`, `LH_FAKE_OBSIDIAN=<remote.json>` (its shape is described at the top of the preload file), plus `LH_VAULT_DIR` and `XDG_CONFIG_HOME` in scratch folders.

## The accounts stack

- **Two workers must never run Docker stacks at once:** they tore down each other's containers (names, networks and volumes are shared by the daemon). Never start a second worker on a job because a report arrived twice.
- **The image builds in the sandbox only from a generated local copy of the Dockerfile:** the proxy's CA is added to the build and the run stage's `apt-get` step is replaced (Debian mirrors answer 403), so the sandbox image has no curl, Chromium or fonts. The base image comes from `mirror.gcr.io` (Docker Hub answers 429), tagged with its real name so the `FROM` lines are unchanged. Never change the real Dockerfile for this.
- **Compose runs from a scratch copy of `deploy/`** with `LH_DOMAIN=localhost` (Caddy's internal CA; copy the root certificate out with `docker cp lh-caddy:/data/caddy/pki/authorities/local/root.crt .`) and an override file that sets `pull_policy: never` on the four services (`COMPOSE_FILE=compose.yaml:<override>`), so `update.sh` runs unedited. `make-secrets.sh` refuses root, as designed; in the sandbox `.env` was first copied from `.env.example` (the script's allowed root path).
- **The gateway and maker tests need no Docker:** the maker is driven against a stand-in Docker Engine API on a unix socket, the gateway against stand-ins for the maker and Caddy's relay (`tests/helpers/gateway-fakes.ts`).
- **The crossing tests against a running stack:** `node deploy/test/crossing.mjs --list`, then `--base https://<LH_DOMAIN> --ca <root.crt> --compose-dir <the stack's deploy folder>`. They need two free slots and Docker on the same machine; they remove the two members they make ("Crossing tests" is `deploy/test/README.md`).
- **A real Caddy with stand-in gateway and copies** (the Caddyfile unmodified, `LH_DOMAIN=localhost:<port>`) is the quick way to re-prove a Caddyfile change.
- **The gateway's setup code** is in `docker compose logs gateway`; don't paste it anywhere.
- **Node:** the image runs Node 26; the sandbox's tests run on Node 22. The known sandbox failures (four tests, plus one case of `tests/subscription-auth.test.ts`) are listed in "Known test failures in the development sandbox" above.
  - **Check file-handling code on Node 26 before a dry run:** a file handle closed by the garbage collector is an error there and only a warning on 22. A Node 26 binary for one run: `npm install node@26` into a scratch folder, then `NODE_ENV=test <scratch>/node_modules/.bin/node --import tsx --test tests/<file>`.
  - **Start a test stack from a folder that isn't named `deploy`** (CI uses `stack`): the folder's name is the compose project's, and a fault that depended on it stayed hidden under `deploy`.
- **`reset-password` on a server with a gateway** is `docker compose exec gateway reset-password` (the gateway's container has `LH_GATEWAY_FILE`). In the owner's copy's container the same command is still the copy's own single-copy reset of `server-login.json`, which the gateway never uses.
- **Sandbox workarounds, in the scratch folder only:** a hosts entry for the test domain; account POSTs sent through Playwright's own client, because Chromium on the Docker host aborts requests in flight when Docker adds a network interface; the lockout table emptied between refusal screenshots.

## Performance measurements

- **The audit's scripts and synthetic data are not in the repo.** To rebuild the data: repeat the golden teaching chat's messages N times with unique ids, and give every dispatch card a job record, or each one shows a spinner that animates forever and distorts idle and scroll measurements.
- **Measure a lesson only once it has settled.** A long lesson keeps working for tens of seconds after it first reacts. A first sync-poll measurement taken 6 s after opening showed freezes in its control too; the one that held waited a minute and tied each freeze to a poll answer.
