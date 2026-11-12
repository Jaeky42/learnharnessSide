# Upstream 0.6.0 in the fork: decisions and what was built

The fork is now based on upstream amosblomqvist/learnharness **v0.6.0** (tag commit `a6366476`), merged with `git merge v0.6.0` into the fork's history. It is **not a 1:1 copy**: where upstream and the fork did the same job differently, the owner chose. This file records those choices and where each lives in the code. Change one only with the owner's approval.

Upstream 0.6.0 brought: plugins (core and community), themes, side conversations ("side chats", stored in the chat record), a highlight toolbar (Cite, Ask), a dialog system (HostDialog), a Host-header check on the API, a link allow-list in the desktop shell, and chat record format 2.

**State:** built on the branch `claude/upstream-0.6.0` (it builds nothing and no device follows it). Not yet on `claude/pensive-goldberg-7dty2m` (the server) or `side-tutor` (the desktop app); both need the owner's approval, and must get the same commit, the server's first ("Updating the server and the PC together" below).

## The owner's decisions

| # | About | Decision |
|---|---|---|
| 1 | Side tutor | **Mix.** It works like upstream's side conversations (the teacher sees them, they count in the cost, no Clear, highlight then Ask) and keeps the fork's window, bubble, phone sheet and design. Details: "The Tutor on upstream's side conversations" in `docs/side-tutor.md`. |
| 1b | Conversations | Upstream keeps one per teaching step. The window shows all of them in one scroll, in order. |
| 1c | Ways in | The bubble, and highlight then Ask. No "?" marker at each step and no Ctrl+J. |
| 1d | Conversations from before the update | Deleted, once. |
| 1e | Practice sessions | The Tutor is there too. |
| 1f | Thinking | The session's thinking level, as upstream. |
| 1g | Dividers | Each step's conversation starts with that step's first words, greyed. |
| 6 | Sync | Protocol 2, plus a second lock: a side never accepts or sends a session newer than it can read. No message on screen. |
| 7 | Settings list | **The fork's.** Obsidian, Cloud and Account sit above the divider, with icons; plugins below. On a phone the closing fade stays. |
| 8 | Themes | Everything of the fork's follows the chosen theme, including the login pages and the home-screen app's colours. |
| 9 | Themes and devices | The theme, colour overrides, code ligatures and custom themes sync. "Reasoning in summaries" syncs; "helpers at once" stays per device. |
| 10 | Phone | The Enter rule applies to upstream's new text boxes. Under 640 px no plugin is offered (Drawing Pad never will be), and a plugin's question is parked with a note. Phone layouts for Flashcards, Coding questions, Rich code blocks, the theme picker and plugin settings pages are a later round. |
| 11 | Held sessions | Upstream's new controls are refused by the server and greyed out, like Rename and Delete. A Tutor answer in progress finishes before the session moves. |
| 12 | The server's front door | **The fork's.** Its login and device-key gates on the server; upstream's new check only on the desktop app and local use. |
| 13 | Large uploads | **Mix.** Upstream's exemption for document uploads, with the fork's login checked inside it. |
| 14 | Shortcuts | **Upstream's.** Drawing Pad keeps Ctrl+Shift+E. Ctrl+Shift+N opens the notes drawer with the cursor in the note's editor, and closes it again. The fork's "jump into the editor" shortcut is gone. |
| 15 | Pop-up boxes | **Upstream's.** All of the fork's move onto HostDialog, keeping their look and words. |
| 16 | Plugins | **Upstream's.** Every plugin is offered on the PC and on the server, off until switched on. |
| 17 | Plugin data | Per device for now. The sync backup also covers plugin and theme data. Syncing Flashcards is a later phase. |
| 18 | Upstream's workflows | Deleted from the fork (`ci.yml`, `release.yml`, `notify-website.yml`). |
| 19 | Pictures in messages | The "sent once" rule is extended to them. |
| — | Server feed | Two branches stay: the server follows its own branch, the PC follows `side-tutor`. |
| — | The official app | It is installed on the owner's PC. The update steps account for it. |

(Numbers 2, 4 and 5 of the first round were settled by decision 1.)

## What was built, by area

### The Tutor

See `docs/side-tutor.md`. In short: the fork's engine (store, route, agent, prompt, sync guard, bundle file) is gone; the window reads upstream's side conversations through upstream's hook `useSideThread`, and nothing in upstream's engine is changed.

### Sync (protocol 2)

- **`SYNC_PROTOCOL_VERSION` is 2** (`src/core/sync/protocol.ts`). Upstream raised the chat record format from 1 to 2 (`CURRENT_CHAT_VERSION`), and a format-1 build refuses a format-2 file, so a protocol-1 side must never receive one. The session bundle also changed shape.
  - A test (`PROTOCOL_FOR_CHAT_FORMAT` in `tests/sync-sessions.test.ts`) lists which protocol each chat format needs and fails when the format rises without a new row. It runs in both workflows, so the rule "a release that changes a data format is marked" is enforced.
- **The second lock** (owner's decision 6): beside the protocol number, a side neither takes nor sends a chat file stamped with a newer `version` than it reads (`chatFormatTooNew`, `checkBundle` in `src/core/sync/sessions.ts`; the server answers 409 `newer_format`). Nothing shows on screen. It covers the case the number can't: two builds with the same protocol, one of which already writes a newer chat format.
  - **Known limit:** a hand-over can stall when the holder's chat file is newer than its own build can read (a downgraded app). The asker keeps seeing the waiting strip.
- **A session is three kinds of file now**: the chat record (its side conversations are inside it, `sideChats`), the notes home-folder record, and the helper job files. `side-tutor/<chatId>.json` is gone from the bundle. The bundle's fingerprint keeps a constant "no side-tutor file" part, so the fingerprints both sides saved before the update still match and nothing is re-sent in bulk.
- **Pictures inside messages travel once** (decision 19; `src/core/sync/pictures.ts`). Since 0.6.0 a picture the learner attached or a tool returned is an image block inside the message (`{ type: "image", mimeType, data }`), outside `imageSnapshots`. Each one of at least 1,024 base64 characters is named by the SHA-256 of its bytes and travels like a snapshot (`PictureList.inline`: the path to the block, and the id). The file is still put back together byte for byte; a chat that can't be (odd formatting, non-canonical base64) travels whole.
- **More settings sync** (decision 9; `SYNCED_SETTINGS` in `src/core/sync/maps.ts`): `appearance.theme`, the nine `appearance.colors.*` overrides, `appearance.codeLigatures` and `compaction.includeReasoning`. `appearance.mode` stays on the list: upstream no longer reads it, but an older record that still carries it must not stall a round.
  - **Per device, never synced:** `agent.workerRequestConcurrency` ("helpers at once"), the side-question model slot (`agent.models.sideQuestion`), and everything that was per device before.
- **Custom theme files sync** as their own map kind, `t|<theme id>` (`themes/<id>.json`, read and written through upstream's `themeStore`; `src/server/sync/map-views.ts`). Built-in themes never travel. A theme file that is there but can't be read is left alone, like the other files.
- **Held sessions and upstream's new writes:**
  - `sessionWritePath` (`src/server/sync/engine.ts`) matches a write at any depth under `/api/chats/<id>` (a side question's `PATCH /side-chats/<thread>` and `POST …/stop` are two levels down). The notes home folder is still left to its own route.
  - `guardChatStore` covers upstream's new store method, `updateSideChats`: on a held session it changes nothing and returns the threads as they are. The fork's `guardSideTutorStore` is gone with the store it guarded.
  - `handleChatInput` checks the lease in its first statement (`heldElsewhereResponse`), ahead of upstream's new tidy-up of plugin questions.
  - `reconcilePluginQuestionCompatibility` (run by `GET /api/chats/<id>`) leaves a held session alone. Without that, a held session whose plugin was off on this device reloaded in a loop.
- **A Tutor answer syncs at once.** The loop runs a round immediately on `side-chats-changed` (`src/server/sync/loop.ts`), which upstream announces when a side answer starts (the question is in the record by then) and when it ends. So the server hears "busy" as it does for a reply, and the question isn't left unsent while the answer is written. Found by the reviewer: without it the server heard of a Tutor answer only at the next 10-second round.
- **A Tutor answer counts as a reply being written** at a hand-over (decision 11; `src/server/sync/local-work.ts`): the holder finishes it, then hands over; the asking device shows the existing strip, "Desktop is finishing a reply. This session moves here when it's done." When a session goes anyway (lost to a take-over, or taken from the cloud), a side answer still running for it is stopped with the other work (`sideChats.stopAll`).
- **Backups** (decision 17; `src/store/sync/backup.ts`): the once-per-side backup also copies `themes/`, `plugins-state.json` and `core-plugin-data/`, and no longer `side-tutor/`. Not the code of community plugins.
- **A bug fixed on the way:** a round whose fetch of one session failed still moved its place in the server's list forward, so that session was never fetched again. The place now moves only past what was fetched (`src/server/sync/desktop-sync.ts`).
- **Plugin data is per device** (decision 17): which plugins are on, their settings and their data (Flashcards' history) don't sync. Consequences the owner has been told:
  - a plugin's pending question is cancelled by upstream's own rule after a take-over to a device where that plugin is off;
  - a plugin's background job that was running when its session moved fails on the new holder, and says so, instead of restarting;
  - a plugin's own operations (its data, its pages) aren't session writes and aren't refused on a held session.
- **An app that isn't paired** still makes no sync request and writes no sync file. Upstream's plugin start-up does create an empty `plugins/` folder in the data folder; `tests/sync-inert.test.ts` allows exactly that.

### The server's front door

- **`proxy.ts`:** in server mode the fork's `serverGate` (login, device keys, the `Origin` rule) decides, as before. Outside server mode (the desktop app, local use) upstream's `apiRequestRefusal` runs for `/api` paths (its Host allow-list). The held-session check and the two marker cookies are unchanged.
- **Document uploads** (decision 13): upstream takes `POST /api/plugins/<id>/documents/markdown` out of the proxy, because a proxy would buffer the whole upload. The fork keeps that exemption and runs its own gate inside the route: `apiGate(request)` in `src/server/api-gate.ts`, called by `createPluginDocumentRoute` (`src/server/plugin-transport.ts`). Server mode: `serverGate`. Elsewhere: upstream's refusal.
- **Start-up** (`instrumentation.ts`): upstream's plugin start-up runs first, inside a try/catch, so a broken plugin can't keep the setup code from being printed or Obsidian sync from starting. Then the one-time removal of the old Tutor files (every start), then the server-only steps.
- **The desktop shell's link allow-list** (upstream: http, https and mailto only) gets one narrow exception, `obsidian://open` links (`isObsidianOpenLink` in `electron/main.cjs`), which the notes drawer uses for notes outside the notes folder and "Open in Obsidian".
- **Build:** `npm run plugins:setup` after `npm ci` in `Dockerfile`, `.github/workflows/side-tutor-windows.yml` and `.github/workflows/server-image.yml`. `npm run build` then builds the core plugins into `core-plugins/`, which `scripts/build-server.mjs` requires.
- **Upstream's workflows are deleted** (decision 18). Two of upstream's test files read them and now skip when they are absent (`tests/desktop-platform.test.ts`, `tests/verify-release.test.ts`); `tests/plugin-setup.test.ts` checks the fork's two workflows instead.

### Held sessions and upstream's new controls

- **Greyed, with the fork's tooltip** "Take this session over first" (`HELD_TEXT.blocked`): the plugin buttons in the lesson's top bar and their overflow menu (`blocked` on `PluginTopBarActions`, `components/plugin-chrome.tsx`), and Cite and Ask in the highlight toolbar (`blocked` on `SelectionToolbar`, `components/selection-toolbar.tsx`). They keep their name and icon and do nothing.
- **Refused by the server** (409 `session_held_elsewhere`): answering or dismissing a plugin question, submitting a plugin problem, steering, and a side question. A plugin worker whose session moved away writes nothing and delivers nothing.
- **Not covered:** a plugin's keyboard shortcut still runs its action on a held lesson (the server refuses whatever would change the session).
- Tests: `tests/sync-plugins-gate.test.ts`, `tests/cloud-held-plugins-ui.test.tsx`.

### Themes on the fork's screens

- **Colours are theme tokens now.** The fork's hard-coded colours (emerald, red-400, amber and so on) became upstream's tokens (`text-success`, `text-error`, `text-warning`, `--lh-error`), in the Tutor, the notes drawer, the sync chip and strips, Settings → Obsidian / Cloud / Account, and the sign-in controls. On the default dark theme a few shades moved slightly (success green, error red).
- **The notes editor** (CodeMirror) follows the theme's light or dark mode live (`editorTheme(mode)` in `components/notes/note-editor.tsx`).
- **The login and setup pages** take the server's saved theme (`authPagePalette()` in `src/server/server-auth-theme.ts`): the theme's colours, and nothing else, are shown to someone who isn't signed in. Only plain hex colours reach the page; the pages keep their one inline `<style>` under their CSP.
- **The home-screen app:** `app/manifest.ts` takes its background and theme colours from the saved theme, read per request (`force-dynamic`). The browser bar's colour (`themeColor` in `generateViewport`, `app/layout.tsx`) is the theme's background.
- **The iPhone status bar style is unchanged** (`black-translucent`): see "Asked after it was built".
- Tests: `tests/themed-pages.test.ts`.

### Pop-up boxes on HostDialog

- The notes drawer's Move to, Split, Delete and name boxes (`components/notes/notes-dialogs.tsx`), its row menu (`PointMenu` in `notes-tree.tsx`), the take-over warning (`components/cloud/take-over-dialog.tsx`) and the discard notice (`components/cloud/discard-notice.tsx`) are built on upstream's HostDialog and interaction layers. Same look, words and buttons.
- **The discard notice still closes only with OK:** its `onClose` answers `"blocked"`. It is mounted inside `<AppShell>` (`app/layout.tsx`), where the dialog system lives.
- Read while building: the discard box's role is `dialog` now (it was `alertdialog`); the notes Delete box can be closed while a delete is under way (the delete still completes).
- **A circular import fixed on the way:** `components/notes/note-read-view.tsx` reads the lesson's Markdown components lazily (`readComponents()`), because upstream's plugin renderers now import the lesson screen, which imports the notes drawer.

### Settings

- **Rows, in order:** Providers, Agent, Appearance, Graph, Keyboard, General, Obsidian (server only), Cloud, Account (server only); a divider; Core plugins, Community plugins; a divider; one row per plugin that has settings. Icons for the fork's rows: a notebook with a pen (Obsidian), a cloud (Cloud), a person (Account). (`components/settings/settings-dialog.tsx`)
- **On a phone:** the list has no icons, no Keyboard row and no plugin rows; a link to a plugin's section lands on the list. The closing fade is kept by fading a copy of the panel's contents (`fadeOutCopy`), because upstream's dialog removes the panel at once.

### Phone

- **The Enter rule** (Enter is a new line on a touch phone; the button sends) also applies to upstream's new text boxes: a plugin question's box and its key handling (`components/plugin-question-dock.tsx`, `plugin-question-keys.ts`), upstream's "Enter from anywhere" (`components/enter-submits.ts`) and the citation comment (`components/citation-comment-editor.tsx`; ⌘/Ctrl+Enter still saves and sends).
- **Plugins are hidden under 640 px** (`components/phone/phone-plugins.ts` lists the rules):
  - the ways in are hidden by `app/phone.css`: the lesson's top-bar plugin buttons, the session list's plugin entries, the graph's plugin buttons;
  - a plugin page opened directly shows "Open this on a computer." under a top bar that has only the session-list button (`components/phone/phone-plugin-page.tsx`);
  - a plugin's question is parked: "This question needs a bigger screen. Open this session on a computer to answer it.", with the button "Dismiss question" under it; a plugin's practice problem is parked with "This problem needs a bigger screen. Open this session on a computer to answer it." (`components/phone/parked-plugin-question.tsx`; "Asked after it was built" below);
  - rich diagrams inside a lesson still draw.
- **HostDialog on a phone** is sized to the visible height (`--lh-vvh`), so the keyboard doesn't cover it; theme cards are one column.
- Tests: `tests/phone-plugins-ui.test.tsx`, and the phone-only rule for every `phone.css` rule in `tests/phone-layout.test.ts`.

### Notes shortcut

- **Ctrl+Shift+N** opens the drawer with the cursor in the open note's editor (the note switches to its edit view), and closes the drawer again. With no note open, the cursor lands in the notes search box. Opening with the Notes chip doesn't move the cursor. (`landInEditor` on `NotesDrawer`, set by the `toggle-notes` shortcut in `components/chat.tsx`.)
- **Ctrl+Shift+E is upstream's** (Drawing Pad). The fork's `focus-notes` shortcut is removed.

## Asked after it was built (owner's answers)

Five things the plan had left open, or that came out differently than the plan said. The owner chose from pictures.

1. **The Tutor's middle on a light theme: the theme's background at 62% with 10% of its text colour mixed in** (the owner's pick of three; the others were the background at 60% and the theme's soft grey at 78%). Black at 60% is unreadable over a light lesson. Dark themes keep black at 60%. (`BODY_BG` in `components/side-tutor.tsx`.)
2. **A parked plugin question gets "Dismiss question".** The plan said the message box stays usable under the note. It can't: upstream's server takes no typed message while a plugin question waits ("Answer or dismiss the pending plugin question first"), on any device. The owner chose upstream's own button and words over the sentence alone and over changing upstream's rule. It is upstream's silent dismissal: the question is marked dismissed, the message box comes back, and the teacher learns of it with the learner's next message.
3. **A plugin's practice problem is parked too**, with new wording the owner approved: "This problem needs a bigger screen. Open this session on a computer to answer it." No button; upstream has no dismissal for a problem. It can only be met by opening, on a phone, a practice session started on a computer.
4. **The iPhone status bar is left as it is for now** (`black-translucent`). The plan said dark clock text on a light theme. An iPhone offers no style with dark text that also lets the app draw under the clock, which the full-height session list and the tuned top spacing rely on. So on a light theme the home-screen app's clock is white and hard to read; a Safari tab isn't affected. To be decided in the phone-layout round, on the owner's real phone. The two other options shown: a dark strip behind the clock on light themes, or the iPhone's standard bar on light themes (the icon must be added again and the top spacing re-checked).
5. **The icons for the fork's Settings rows stay** as picked: a cloud (Cloud), a notebook with a pen (Obsidian), a person (Account).

## How it was checked

- **Tests, typecheck, lint.** In the development sandbox every test passes except the four that fail there on untouched upstream too ("Development notes" below).
- **The update, rehearsed with built copies** (the pre-merge fork built from its last commit, and this branch):
  1. old PC and old server, paired, two sessions and an old Tutor conversation file synced;
  2. **the server updated first:** the old PC reads "Update LearnHarness to continue syncing" and shows SYNC PAUSED; nothing changes on either side; the server's site works and shows the PC's sessions as held; the old Tutor files are gone from the server;
  3. **the PC updated too:** sync is back by itself, no discard notice, both session files still byte for byte what they were, the old Tutor files gone from the PC.
- **Between the two updated copies**, nobody pressing Sync now: a theme chosen on the server reached the PC in 4 s (the PC's model slots untouched); a custom theme imported on the PC reached the server at the next 10-second round, identical; a session with a picture inside a message was identical on both sides 2.5 s after the change; a hand-over from the online PC took 10 s; on the held session the PC showed the strip, the greyed bubble and greyed Cite and Ask, and the server refused a rename and a side question (409).
- **A Tutor answer during a hand-over**, with a slow stand-in model on the PC: the server's request read "handing over", then "finishing a reply", and the session moved when the answer ended, with the whole answer on both sides.
- **A real browser**, computer and iPhone size, dark and light theme: the Tutor (one scroll, highlight then Ask, a refusal coming back into the box, practice), Settings, the notes drawer, a plugin page on a phone.
- **A fresh reviewer** read the finished diff against the pre-merge docs for lost fork behaviour and found none. Its two findings are fixed: the Tutor's answers and the sync loop (above), and the home screen's topic box, which sent on Enter on a touch phone although the phone's Enter rule names it (it was so before the merge too; it uses `enterSends` now).
- **The Windows workflow as a dry run** on this branch, and the server image workflow the same way (both publish only on a push).
- **Not checked here:** a real iPhone; Obsidian's real servers; a real model; the packaged Windows app by hand.

## Updating the server and the PC together

Protocol 2 means both sides must be updated, or sync pauses (nothing is discarded while it is paused). The same commit goes to both branches, the server's first:

1. The official LearnHarness app stays closed until the end: it shares the data folder, and once updated it writes format 2 without knowing about sync or held sessions.
2. In Side Tutor: Settings → Cloud → Sync now, until "Up to date". No reply or helper left running.
3. A copy of the PC's data folder and of the server's data, by hand. Format 2 is one-way, and the automatic backup was made only once, at the first sync.
4. Push to the server's branch (owner's approval). The image builds; the owner updates the server and checks the site from the phone. Meanwhile the PC shows SYNC PAUSED and "Update LearnHarness to continue syncing". No Take over of a PC-held session during this gap.
5. Push the same commit to `side-tutor` (owner's approval). The release builds; the app installs it at its next start. Settings → Cloud reads "Up to date" again.
6. Plugins are off by default and per device: switch the same ones on in both places, from a computer.

## Not in this merge

- Phone layouts for Flashcards, Coding questions, Rich code blocks, the theme picker and plugin settings pages. Until then plugins are computer-only.
- Syncing plugin data (Flashcards' review history first).
- Phase 7 of cloud sync, and a tablet layout.

## Development notes from the merge

- **`npm run plugins:setup`** after `npm ci`, or the build and several tests fail.
- **`next dev` only:** upstream's lesson screen assigns to a ref's property during render, which React's development server renderer refuses ("object is not extensible"). The lesson page's server render answers 500 and the page then renders in the browser. Production builds aren't affected. It is upstream's, not the merge's.
- **Tests in the development sandbox** (Node 22, no IPv6): `tests/safe-fetch.test.ts` hangs and must be left out of a full run; `tests/safe-fetch-connector.test.ts`, `tests/passive-tooltip.test.tsx` and one case of `tests/plugin-document-proxy.test.ts` fail. All four behave the same on an untouched upstream v0.6.0 checkout. CI (Node 26) runs them.
- **Upstream's plugin SDK type tests** (`tests/plugin-*types.test.ts`) each run the TypeScript compiler with a 30-second limit. Beside the fork's larger suite on GitHub's runner one of them ran out of time, twice in a row. `server-image.yml` runs those seven on their own first, one at a time, then every other test. `npm test` locally still runs everything together.
- **`docs/plugin-api/`** is generated: `node scripts/build-plugin-types.mjs <dir>`, then `node scripts/build-plugin-api-reference.mjs <dir> docs/plugin-api`. A test fails when it is stale, which happens whenever the fork adds an event (`cloud-changed`).
- **A Tutor conversation for screenshots:** put threads in the chat record's `sideChats` (upstream's shape in `src/core/contracts/chat.ts`). The old `side-tutor/<chatId>.json` recipe in `docs/cloud-sync.md` no longer applies.
- **At the next upstream release:** the fork's edits to upstream files are the lesson screen (`components/chat.tsx`: the Tutor's mount, upstream's card and markers left out, the `blocked` props, the parked question and problem), `components/settings/settings-dialog.tsx`, `proxy.ts`, `instrumentation.ts`, `app/layout.tsx`, the `blocked` props in `plugin-chrome.tsx` and `selection-toolbar.tsx`, and the phone Enter rule in the three text-box files. Everything else is in the fork's own files.
