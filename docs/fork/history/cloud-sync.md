# History and records: Cloud sync

## Sessions and leases

### Sessions and leases: real runs (Phase 5, slices 2 and 3)

- **Real run:** two copies of the built app (`next build`, `scripts/build-server.mjs`, then `.next/standalone/server.js` twice with different `PORT`, `LH_DATA_DIR` and `LH_AUTH_FILE`, one with `LH_SERVER_MODE=1`), paired and synced through browsers.
- **Real run:** between two built copies: an online hand-over, taking it back, and a take-over during the desktop's silence followed by the discard and its notice.

## Seamless sessions

### What was checked

- **An independent review of the engine part** (read-only), in two passes. The first said "changes required": one confirmed way to overwrite another desktop's turn (after Unpair and pairing again, a take that answered "waiting", then a turn added and a hand-over), and four narrower ones (a write landing between the look and the take, a take-over racing a round, the notice's count, a lost answer to a send). All are fixed; the second pass said "ship" and found no new way to overwrite, wrongly discard or strand a session.
- **An independent test pass:** 46 test files, one at a time, no failure: every `tests/sync-*.test.ts` (20 files; the new `sync-seamless` has 28 cases), `session-move` (31), `cloud-held-ui` (16), `cloud-notices-ui` (30), `side-tutor-ui` (43), `session-core` (102), and the phone, sidebar and artifact files that read the changed code. Typecheck clean; lint with its one existing warning. `SYNC_PROTOCOL_VERSION` is 3 and nothing under `src/core/sync/` changed a wire shape. **Not run:** the whole suite (the two workflows run it before they publish).
- **Two built copies in a browser** (one as the PC, one in server mode; the loop on; a stand-in model; 1280 × 800 and iPhone 13 size), by an independent verifier:
  - never paired: typing and a rename sent no request to `/api/cloud` or `/api/sync`;
  - a session the PC holds, on the server's site: no "Held by" line, the message box there, the Tutor's bubble enabled, Rename and Delete enabled;
  - focus sent nothing; one typed character sent the request with `force: true`, asked again at 2 s and 4 s (`waiting`), and the session arrived after about 3 s; with Send pressed at once the text stayed in the box and went out once, about 8 s later;
  - the other way, on the PC: here after 128 ms, one request;
  - Rename from the session list with no typing: one request, then the rename;
  - the server stopped: the box 30.8 s later, centred, 12 px under the top bar, with the approved sentence; the lesson's messages at the same place before and after; ✕ hid it, also in another lesson, with the chip still there; a reload showed it again; an open Tutor window was on top of it;
  - carrying on offline: `continued-offline`, a rename, and after the server came back its copy had the PC's title and named the PC as holder, with no notice;
  - both sides changed: the discard box with the new words;
  - take-back: two messages added on a stopped PC, one character typed on the server's site, the PC started: no discard box, the messages on both sides, the PC the holder again;
  - `POST /api/cloud` blocked: the failure sentence in the box, the typed text kept, ✕ cleared it; 576 px wide on a computer, 358 px at iPhone size.

## The graph log

### The graph log: real run (Phase 5, slice 4)

- **Real run:** two built copies with the test library on the desktop and two concepts on the server: first sync (ledgers identical on both), a concept deleted on each side, and a session deleted with its concepts.

## Settings and the other small files

### Settings and the small files: real run (Phase 5, slice 5)

- **Real run:** two built copies: a first sync (the desktop's settings on both, the server's model and font untouched, 371 node places and the sliders equal), a setting changed on each side, and a chains-view folder made on the server showing on the desktop.

## Timing, pictures sent once, and the loop

### Phase 5, slice 6: the full run

- **The full run** (two built copies, nobody pressing "sync"; a desktop copy with the test library, a session with two pictures and a vault folder; a server copy with one session, two concepts and its own settings):
  - before pairing: two libraries, no `sync/` folder on either side, the desktop's state `off`;
  - 0.6 s after pairing: all four sessions on both, every chat file identical (the 1.7 MB one with pictures too), 300 concepts on both, a backup made on each side, the vault's folder names on the server;
  - a rename on the desktop reached the server in 2.2 s; a setting changed on the server reached the desktop in 10 s, as did a concept deleted there;
  - the server asked for a session the online desktop held: handed over in 2 s; the server's rename reached the desktop in 2 s; the desktop's own rename was refused (409);
  - the server was stopped: the desktop showed `offline` within 2 s and kept working; 16 s after the server was back it had the rename made meanwhile;
  - at the end: chat files, ledgers, node places and sliders identical on both, and 30 idle seconds without a single file written.

## The sync screens

### Phase 6, slice 1: run between two built copies

- **Run between two built copies** in a browser, at computer and phone size: pairing, the first sync, Sync now, Unpair, pairing again, Remove on the server, a code running out.

### Phase 6, slice 2: retired by seamless sessions

Retired by seamless sessions ("Removed from the page" under "What was built: the page" in `docs/fork/cloud-sync.md`). What is still built of this slice (`CloudProvider`, `cloud-changed`) is in `docs/fork/cloud-sync.md`.

#### Slice 2: what is built
- **The session list** (`components/sidebar.tsx`): a held session's second line reads "Held by Desktop" in place of the time. In its menu, Rename and Delete are greyed out with the tooltip; the other items work.
- **The strip** (`components/cloud/session-strip.tsx`, mounted under the top bar in `components/chat.tsx`): always in the page, closed and `inert` while there is nothing to say, so opening and closing can be animated. Its states: held (with **Take over**), asking, waiting for a reply or a hand-over (with **Cancel**), failed.
  - Take over sends `POST /api/cloud {op:"take-over", chatId, force:false}`; while the answer is `waiting` it asks again every 2 seconds; `warning` opens the box; `moved` or `yours` re-reads the state, and the strip goes when the session is no longer in `held`.
  - **The warning box** is `components/cloud/take-over-dialog.tsx` (removed with seamless sessions). **Take over anyway** sends the same request with `force: true`.
  - On a PC that can't ask the server, Take over is off and a second line says why.
- **The motion** is in `app/cloud.css` (fork-owned, like `phone.css`): the strip's row opens from 0 to its height with a fade over 200 ms, its words fade in over 150 ms when they change, and the message box's block (`.lh-held-dock`) fades over 150 ms and is `inert` while hidden. All at once with reduced motion.
- **In the lesson** (`components/chat.tsx`): the whole dock (message box, an open question, model and thinking pickers) goes on a held session. The title can't be clicked to rename, and F2 does nothing; its tooltip reads "Take this session over first".
- **The side tutor** (`components/side-tutor.tsx`, prop `held`): an open window closes to the bubble; the bubble is greyed out, has the tooltip and ignores a click. With the dock gone it can't sit against the question bar, so it sits at the lesson's bottom right (16 px in, 20 px up), where it is with a one-line message box.
- **Wording added while building, beyond the plan page, for the owner to review:**
  - "another device" as the holder's name when a PC's name isn't known ("Held by another device");
  - the second line when a PC can't take over for a reason other than being offline: "Sync is paused, so it can't be taken over right now." and "This PC is no longer paired, so it can't be taken over right now.";
  - "Desktop is offline and may have turns …" in the warning when the server has no time for the holder.
- **Read while building:**
  - Times follow the device's own format, as in Settings → Obsidian: "offline since today, 14:02" or "… today, 2:02 PM".
  - The title on a held session looks as usual (it isn't greyed); it just can't be clicked.
  - The folder a held session is in can still be changed, and the notes drawer works, as decided in Phase 5.
- **Tests:** `tests/cloud-held-ui.test.tsx` (the words, the provider asking nothing where sync isn't in use, the list line, every state of the strip, the warning box, Cancel), a held session in `tests/side-tutor-ui.test.tsx`, and a removed PC keeping its name in `tests/sync-unpair.test.ts`.
- **Run between two built copies** with the loop on, at computer and phone size: the list lines and the strip on the server's site; the greyed bubble and menu items; a rename refused; a hand-over from the online PC (6.6 s: the PC hears of it at its next 10-second check); the PC showing "Held by the web app" and taking it back (0.3 s); the PC stopped, "offline since …" after 30 seconds, the warning box, Take over anyway, and the PC showing the server's version when it came back.

### Phase 6 words and rules retired by seamless sessions

Retired by seamless sessions: no screen shows "Held by", offers Take over or warns, and the heads-up is a floating box. The words now on screen are "The approved words" under "Seamless sessions" in `docs/fork/cloud-sync.md`, and the Settings → Cloud words that stayed are in Phase 6's "The approved words" there.

**The approved words, as approved in Phase 6**

- **Slice 2, the strip.** "Held by Desktop" (the server's site and phone add " · online" or " · offline since today, 14:02"; a desktop app knows only the name). Waiting: "Asking Desktop to hand it over…" and "Desktop is finishing a reply. This session moves here when it's done." (with "the web app" as the holder: "Asking the web app to hand it over…", "The web app is finishing a reply. …"). A failure: "Couldn't take it over. Try again." On a PC that can't reach the server, Take over is off and the strip adds "This PC can't reach the server, so it can't be taken over right now."
- **Slice 2, the warning box.** Title `Take over “Circuits”?` / "Desktop has been offline since today, 14:02, and may have turns that never reached the server. If you take over, those turns are discarded when Desktop is back online." / Cancel, **Take over anyway**.
- **Slice 3, the offline strip.** "This PC can't reach the server. If this session is taken over on another device before it reconnects, what you add here now is discarded." Paused: "Sync is paused. If this session is taken over on another device before sync is back, what you add here now is discarded." Removed by the server: "This PC isn't paired any more. If this session is taken over on another device before you pair again, what you add here now is discarded." (The owner changed the Settings line to "is no longer paired" and has been told this strip still reads "isn't paired any more"; they haven't asked for it to match.)
- **Slice 3, the discard box.** Title `“Circuits” was taken over` / "It was taken over on another device while this PC was offline. 3 messages you sent here never reached the server and were discarded. The session now shows the server's version." / OK. One message: "1 message you sent here never reached the server and was discarded." None, but another change: "Changes made here that hadn't reached the server were discarded." Several sessions: one box titled "Sessions were taken over", one line each.

**The smaller rules about held sessions**

- **After a take-over** the strip goes, the message box and the greyed controls come back, and nothing else is announced.
- **If the side tutor's window is open** when a session becomes held, it closes to its greyed bubble.
- **An open question's box** goes away with the message box on a held session, and so do the model and thinking pickers.
- **Take over** asks again every 2 seconds while it waits; Cancel stops asking and the holder keeps the session.

**A ruling of slice 1** (the hint under the name box no longer follows what is typed: `NAME_HELP_TEXT` since seamless sessions)

- **Read while building:** the line under the name box follows what is typed ("Held by Laptop"), where the plan's drawing showed it with the suggested name only.

### Phase 6, slice 3: run between two built copies

- **Run between two built copies** with the loop on:
  - never paired: no chip, no strip, no marker;
  - the server stopped while a lesson was open: nothing for the first 30 seconds, then the chip and the heads-up (30 to 40 s after the stop, depending on where in its 10-second rhythm the PC was); the same strip in a practice session; the chip alone on the home screen; a click opening Settings → Cloud on "Can't reach the server. Trying again.";
  - the app started with the server away: the chip at once;
  - the server back: the chip and the strip gone 7 s later;
  - the PC stopped, three messages added to its copy, the session taken over on the server, the PC started: the box with "3 messages …", still there after Esc and a click outside, gone for good after OK;
  - two sessions at once: one box, one line each;
  - Remove on the server's site: NOT PAIRED within 10 s;
  - the learner's own Unpair: no chip and no strip.
### The wrap-up run

(Run before seamless sessions: the Take over, "Held by" and strip steps below describe screens since removed.)

One run between two built copies with the loop on, through the real screens, nobody pressing "Sync now", with a computer-size page of each copy and a phone-size page of the server:

- before pairing, 12 seconds on a lesson: no request to `/api/cloud` from either side, no chip, no strip, no `sync/` folder;
- Pair pressed in Settings → Cloud: both sessions identical on the server 0.4 s later;
- Take over tapped on the phone: moved after 4.7 s, and the PC's open lesson showed "Held by the web app" by itself; taken back on the PC in 0.2 s, and the phone's strip returned by itself;
- 30 idle seconds with three pages open: the PC wrote no file; the server wrote `sync/authority.json` once (its once-a-minute save of "last heard from");
- the server stopped: chip and heads-up after 37 s; started again: both gone 37 s later;
- the PC stopped with three unsent messages, the session taken over on the server, the PC started: the discard box, with the lesson behind it showing the server's version;
- Unpair this PC: no chip, no strip, the message box back, and the server listing no desktop app.

## Flashcards sync

### The review of the wiring, and its fixes

A reviewer read the sync part. It found six serious issues, each reproduced by a script, all fixed before anything shipped (`97fe7ee`); lower ones were fixed too. A second and a third pass by the same reviewer followed (below).

1. **Putting the first-sync backup back** made sync read the missing cards as deletions and delete them everywhere. Now a library that doesn't follow its memory counts as "records lost", and nothing missing counts as deleted ("The memory" under "The wiring" in `docs/fork/cloud-sync.md`).
2. **A fact deleted and generated again before a device's first sync** had its schedule rebuilt from the old reviews. Now an `e` is set at the first read.
3. **A library that can't be read** (the format lock, damaged) made the PC download everything every round and the server back up every round. Now: no request, nothing written, no cursor moved, `locked` and a probe.
4. **Seconds-long stalls of the server's process** with a 25 MB library. Now tables are copied only on the first change, an idle exchange skips the walk of its table, an apply starts from the last read and leaves its own result as the next read, and fingerprints are kept while a value is the same (a review's for good).
5. **The server timed its own changes when a PC next asked**, so an older phone edit could beat a newer PC edit. Now each side notes its own changes a little after the plugin's notice (about 2 seconds then; 20 to 50 s since the second pass).
6. **Two PCs whose first exchanges overlapped** were both "first". Now one part-way through counts too.

Also changed then: deck membership as one item per fact and deck, which combines; the same-question rule for pairs from two devices only; the 15-minute end of a generation's hold, and no rounds from its notices; zone names in their standard form and checked after they are set; one rebuild per zone on the PC.

**The second pass**, by the same reviewer over those fixes, found six more, all fixed (`5e3f9a8`):

1. **A PC whose clock was ahead of the server's, with a library put back**, sent times before 1970 and was refused every round: it never synced Flashcards again. Now times are clamped to 0 on both sides.
2. **A fact made on both devices** lost the other device's earlier reviews at a later read (the `e` was inferred from `created`). Now it is inferred only for a fact sync has never seen here, from what the file counted.
3. **A lost memory** timed items with the file's modified time, so they could beat newer values on the other side. Now every item is timed 0, as for a library put back; a memory cut between its two files counts as lost.
4. **A card the server took from a PC whose answer was lost** could be paired with the PC's next same-question card. Now the server counts what the PC is sending in this exchange as the PC's.
5. **The server's own noting** ran 2 s after a notice, noted reviews too and didn't run while a generation held the exchange. Now 20 s after the last change, at most 50 s after the first, skipped after an exchange, reviews left to the exchange, and also while a generation holds it.
6. **The fallback for a fact taken out of every deck** now looks at deleted decks: the last deck it was put in that isn't deleted; if all are, the last one, which stays as a deck, so the fact is never dropped.

**The third pass**, over those six: all fixed, nothing found that loses, brings back or double-counts a card or a review, and the reviewer's word was to ship. It found one new, narrow gap, fixed before shipping:

- the server's noting skipped whenever an exchange had looked since the *first* change of its wait, so a phone change made after that exchange, in the same wait, was noted only at the next exchange, with a later time; if the PC went offline in those seconds and then edited the same item, the older phone edit won. The watcher now names the *newest* change it is noting, and the skip applies only when an exchange looked after that one. Confirmed with the reviewer's own script.
### The two-copy run

Before the review's fixes. Two built copies with the loop on, the server in UTC and the desktop in another zone, nobody pressing Sync now:

- unpaired: nothing;
- a first sync of two different libraries: equal on both 0.8 s after pairing, with a backup on each side;
- a review on the PC reached the server in 0.76 s; one on the server reached the PC in 10 s (its next check);
- a generation on the server held the PC's review (one `busy`), which went 0.76 s after the batch ended;
- the PC offline with changes on both sides: all 13 reviews, the hand-made card and the rename kept, and identical schedules 1.9 s after the PC started;
- an edit against a delete: deleted on both. Twin decks: joined;
- 30 idle seconds: no Flashcards file written, 3 requests with 0 changes;
- 2,000 facts and 20,000 reviews (a 20.3 MB file): first-synced in 10.7 s, in 7 pages up and 3 down;
- unpair and pair again: carried on with 1 change and no second backup.

**Measured after the fixes** (a 25 MB library, 20,000 reviews): the server's idle exchange 25 ms; a first sync 6.5 s. **After the second pass's fixes:** the idle exchange 23 ms; a first exchange 2.2 s. The steps that still hold the server's process are under "Known limits" under "Flashcards sync" in `docs/fork/cloud-sync.md`.

**The tests after each pass of fixes**

- **After the first pass's fixes:** all sync tests, 300 of 300; typecheck clean.
- **After the second pass's fixes:** all sync tests, 309 of 309.

## The phases

0. **Checks.**
   - ✅ ChatGPT sign-in and model calls from a VPS (callback replayed by hand).
   - ✅ Graph id and rewrite analysis ("Graph sync" in `docs/fork/cloud-sync.md`).
   - ✅ `claude auth login` works on a headless VPS. It prints the link as plain text (`If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?...`). Claude's own page shows a code after the learner authorizes. A plain prompt (`Paste code here if prompted >`) takes it, then the CLI prints `Login successful.` The Sign in button drives this command; Disconnect runs `claude auth logout`. The native installer puts `claude` in `~/.local/bin`.
   - ✅ `ob sync-config` has `--excluded-folders` (comma-separated, empty to clear). It also has `--configs` (which `.obsidian` setting categories sync; may close the `.obsidian` gap), `--conflict-strategy merge|conflict` (an owner decision for Phase 4), `--file-types` and `--device-name`.
1. ✅ **Server mode.** Dockerfile, the `LH_DATA_DIR` volume, the password login gate in `proxy.ts`, Caddy (HTTPS), the server image workflow, and automatic server updates. Running on the permanent VPS: HTTPS via Caddy, setup and password, locked from outside, and the nightly timer installed.
2. ✅ **Sign-in on the server.** The ChatGPT paste box, plus the Claude sign-in button and Disconnect. Verified on the VPS: Claude Code installed itself onto the volume, and both ChatGPT and Claude connected from Settings.
3. ✅ **Phone layouts.** Every view, the side tutor bubble and sheet, the full-screen notes drawer, Settings, press and hold, and the home-screen app. Two real-phone rounds; the owner declared Phase 3 complete.
4. ✅ **Vault on the server.** Settings → Obsidian, the sync manager around `ob`, folders left out automatically, the safety check and Disconnect. Verified by the owner on the server with their real Obsidian account.
5. ✅ **Sync engine.** Pairing and device keys, the lease API, session sync with take-over (no copies: unsent turns are discarded), graph line and operation sync, per-key settings merges, and the sync protocol version check. Run between two built copies; not yet between the owner's real PC and server, which needs Phase 6's screens. (Since then: after the merge the owner paired the real PC with the real server and reported "everything works!".)
   - Built as wrapper stores at the composition root (`src/server/stores.ts`) over the `core/ports.ts` interfaces, so upstream store code stays untouched and rebasing onto upstream stays cheap.
6. ✅ **Sync screens** (desktop app, server's site and phone). Plan approved by the owner and built; see "The sync screens" in `docs/fork/cloud-sync.md`.
   - ✅ Slice 1: Settings → Cloud on both sides (pairing, sync state, Sync now, Unpair this PC; paired desktop apps and pairing codes on the server), with four engine changes.
   - ✅ Slice 2: a held session (the list line, the strip, Take over, the warning box, greyed controls). (Retired by seamless sessions.)
   - ✅ Slice 3: the desktop's own notices (the sync chip, the offline strip, the discard box).
7. **Tests and docs** (not done; the owner merged without it). Lease, take-over and graph operation tests; an end-to-end test with two servers and one cloud; and an update of this file from "planned" to built.

### What the investigation found (for whoever builds it)

- **The approved table misses four things:**
  - `jobs/*.json`: a finished helper result lives only in its job file until it is delivered into the session (`delivery.status: "pending"`), so job files travel with the session's lease.
  - A fourth ledger rewrite: `mergeFindings` (`src/core/graph.ts`) ends with `simplifyChains` and `rewriteLedgers({ chains })`.
  - Background writers of the chat file: extraction (`appendExtractionUsage`) and the visual maker (`saveImageSnapshot`).
  - Three unlisted files: `graph/source-organization.json`, `graph/render-settings.json`, `prompts/**`.
- **Not everything goes through `stores`:** settings, prompt overrides and render settings are imported straight from `src/store` (`src/server/index.ts` and a few server files).
- **The turn gate is too late for a lease check:** in `handleChatInput`, `ensureCompacted` and the parallel-question branch write the chat record before `beginTurn`. The check belongs at the top of that function.
- **Helpers restart by themselves:** `recoverStaleJobs` (`src/server/jobs.ts`) respawns any job left `running` with no live worker. It must only do that on the lease holder.
- **Graph ids, folder ids and chat ids are all random,** so combining two libraries can't collide.
- **The login file parser drops unknown fields** (`parseServerAuthState`), and `reset-password` writes a fresh state. Paired devices stored there are cleared by a reset for free; stored anywhere else, the script must clear them.
- **Desktop shell:** quitting kills the local server at once (`killServer` in `electron/main.cjs`); there is no secure store in use (credentials are 0600 JSON files, and a test forbids `safeStorage`); a build opts out of updates with `lhAutoUpdate: false` in its packaged `package.json`.

- The open questions that were listed here are answered in `docs/fork/cloud-sync.md`.
- **Which branch builds the server image:** `.github/workflows/server-image.yml` lists the branches that build (`side-tutor` → `:latest`; `claude/pensive-goldberg-7dty2m` → `:dev`). A push to any other branch builds nothing, and the owner's server follows `:dev`. Keep working on that branch, or add the new branch's name to that list in the same change.
- **Build order in the plan page, all six built** (each with its tests, a run between two copies, and a commit and push):
  1. pairing codes, device keys, the sync API behind the login gate, and the protocol version check;
  2. sessions and leases: whole sessions with their side-tutor thread, notes home folder and job files, the read-only rule, new and deleted sessions, and the first sync (backup, then combine);
  3. take-over: the evidence rule, hand-over from an online holder, take-over from an offline one, the discard at reconnect, and the facts for the heads-up and the notice;
  4. the graph log: lines, repeated actions, the exact-result fallback, redoing unsent entries on top of fetched ones, and combining two graphs;
  5. settings and the other maps: the approved split, prompt overrides, render settings, chains-view folders, source records, positions, and the vault folder names;
  6. timing (2 s and 10 s, retries while offline), pictures sent once, a full two-copy run in browsers, and the docs.
- **Phase 5 has no screens.** The owner sees nothing new until Phase 6; the thing to check after each update is that the server and phone work as before. The phase ended with a page of screenshots and timings from two copies syncing.

## Handoff notes from before the merge

### State before the merge (Phases 0–5 done; notes drawer additions built)

Kept as written while the work was on its own branch; where it says "until the merge", that has now happened.

- **Branch:** `claude/pensive-goldberg-7dty2m`. All cloud sync work lives here.
  - Pushes build only the server image (`:dev`), never a desktop release.
  - **Never push to `side-tutor`** until the owner approves merging the whole feature.
- **Phase 4 (the Obsidian vault on the server) is complete.** The plan was approved by the owner beforehand (every decision is recorded under "Obsidian vault on the VPS — built in Phase 4" in `docs/fork/server.md`), and the owner confirmed on the real server that sign-in, connecting and syncing work.
  - Tested here: the full suite, plus the manager driving the real `ob` program against a stand-in for Obsidian's servers, and a Playwright run in server mode at phone and desktop size.
  - The owner's check covered the update, the install of `ob`, sign-in and connect. The stopped states (a refused sign-in, an ended subscription, the safety pause) have only been seen against the stand-in; the texts of Obsidian's real error messages are the likeliest place for a surprise.
- **Phase 3 (phone layouts) is complete** (the owner's call, after two real-phone rounds; see "Real-phone checks (owner, iPhone, iOS 27), two rounds" in `docs/fork/history/phone-and-tablet.md`). The last fixes pushed before that call (the home-screen app's top inset at +26 points, phone menus pinned by their top, Fable as `fable`) weren't reported on individually; if the owner mentions one of them, start from its bullet in `docs/fork/phone-and-tablet.md`.
- **Open by design:** the Safari-tab bleed stays marked as an experiment (it works on the owner's phone); a tablet layout is not built.
- **Also on this branch (not phone work):** Claude Fable in the Claude Code model list and the Claude-models-last menu order (see "Claude Code: Fable in the model list" in `docs/fork/models-and-agents.md`). It reaches the desktop app only with the merge.
- **Phases 0–2 are done and verified on the owner's VPS:**
  - HTTPS and the password login work;
  - the nightly update timer is installed;
  - Claude Code installed itself onto the volume;
  - ChatGPT and Claude are both connected from Settings.
- **The cloud copy and the desktop app are still separate libraries** for the owner: the engine is built, but pairing needs Phase 6's screens and the desktop app only gets any of this with the final merge.

### Phase 5, the sync engine (built), and what comes next

**The owner approved the Phase 5 plan page, and all six slices are built** (`docs/fork/cloud-sync.md`). **Phase 6, the screens, is built too**, all three slices ("The sync screens" in `docs/fork/cloud-sync.md`). Phase 6 changed four of the engine's rules at the owner's request; they are listed there, and the Phase 5 text in `docs/fork/cloud-sync.md` is corrected where it described the old rule.

**What the owner can and can't see now**

- **Can see, since Phase 6 slice 1:** a Cloud row in the server's Settings ("No desktop app is paired.", Add a desktop app). There is no desktop app with this code installed anywhere, so nothing is paired and the engine stays switched off on the owner's server and phone.
- **Built but not visible there:** "Held by …", Take over (slice 2), the sync chip and the notices (slice 3) show only once a desktop app is paired, and the last three only in the desktop app.
- **What an update to the server should look like:** exactly as before. That is the thing to check.
- **Can see:** the page of screenshots and timings from two copies syncing (shown to the owner at the end of Phase 5).
- **The API under the screens:** `GET | POST /api/cloud` on the app, `POST /api/server-auth/desktops` on the server's site.
### Still to do

- Nothing for Phase 6: the owner's real PC is paired with the real server and they reported that everything works.
- Phase 7 (not started; the owner starts it).
### Later phases: decisions still open (ask when you get there)

- **Phase 5 (sync engine):** answered and built. The owner confirmed the wording listed under slices 1 and 2 with the Phase 6 plan page, and settled the two readings of "the desktop's value is kept" (decisions 15 and 16, "Phase 6 decisions (owner)" in `docs/fork/cloud-sync.md`).
- **Phase 6 (sync screens):** answered and built; see "The sync screens" in `docs/fork/cloud-sync.md`. For the owner to review: the wording listed as added while building, under slices 1 to 3, and the lesson's one extra read of its session (slice 3).
- **Phase 7 and the merge:** not started. The merge into `side-tutor` needs the owner's approval and a guide for pairing the real PC with the real server.
