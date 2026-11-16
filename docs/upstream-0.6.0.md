# Upstream 0.6.0 in the fork: decisions and what was built

The fork is now based on upstream amosblomqvist/learnharness **v0.6.0** (tag commit `a6366476`), merged with `git merge v0.6.0` into the fork's history. It is **not a 1:1 copy**: where upstream and the fork did the same job differently, the owner chose. This file records those choices and where each lives in the code. Change one only with the owner's approval.

Upstream 0.6.0 brought: plugins (core and community), themes, side conversations ("side chats", stored in the chat record), a highlight toolbar (Cite, Ask), a dialog system (HostDialog), a Host-header check on the API, a link allow-list in the desktop shell, and chat record format 2.

**State:** shipped. With the owner's word ("ready, do both"), the same commit was pushed to `claude/pensive-goldberg-7dty2m` (the server's image `:dev`) and to `side-tutor` (the Windows release), both plain fast-forwards. Both dry runs had passed on commit `c990b21e`, the last code commit; the shipped commit adds only these lines. Before the push the owner made both backups by hand: a copy of the PC's data folder, and the server's data as one archive in the server user's home folder (`lh-data-before-0.6.tar.gz`). The server's image before the update was `dev-a2d2b7e`, should a way back be needed. **The owner then updated the server and the PC (release 0.6.14) and reported that both "went flawlessly".** They didn't say which screens they tried. `claude/upstream-0.6.0` builds nothing.

**Since then:** the phone plugins round (Flashcards and Rich code blocks on a phone, and Flashcards sync, sync protocol 3) is **built on `claude/upstream-0.6.0` and shipped**. With the owner's word ("if the run works and the review comes back ok, you can just ship"), the same commit was pushed to `claude/pensive-goldberg-7dty2m` (the server's image `:dev`) and to `side-tutor` (the Windows release), both plain fast-forwards. Both dry runs had passed on `7ad11e3`, the last code commit; the shipped commit adds only these lines. The sync part was reviewed in three passes and every finding fixed. The owner hasn't updated the server or the PC yet, and the owner's iPhone hasn't seen it. The plan is `docs/phone-plugins-plan.md`; what was built is in `docs/cloud-sync.md` ("Plugins on a phone" under "Phone layouts", and "Flashcards sync"). It changes decisions 10 and 17 below, as noted there.

**Since then, the performance round** (long sessions lagging): an audit, then step 1 of its recommendations, the off-screen rule and the two scroll fixes it needed, built on `claude/upstream-0.6.0` and **shipped** to both branches at the owner's word ("ship"), after both dry runs passed. No protocol or format change. The owner tried it on the iPhone and the iPad and reported that the performance is very good. The findings, the owner's decisions and what was built are in `docs/performance.md`.

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
| 7 | Settings list | **The fork's.** Obsidian, Cloud and Account sit above the divider, with icons; plugins below. On a phone the closing fade stays. **Since then, on a phone** (owner's ask, "very cramped"): no Obsidian row (it is a group inside Cloud) and no plugin page rows; see "Settings" below. |
| 8 | Themes | Everything of the fork's follows the chosen theme, including the login pages and the home-screen app's colours. |
| 9 | Themes and devices | The theme, colour overrides, code ligatures and custom themes sync. "Reasoning in summaries" syncs; "helpers at once" stays per device. **Since then** (owner's change): everything on Settings → Appearance is per device; custom theme files still sync. See "Appearance is per device" in `docs/cloud-sync.md`. |
| 10 | Phone | The Enter rule applies to upstream's new text boxes. Under 640 px no plugin is offered (Drawing Pad never will be), and a plugin's question is parked with a note. Phone layouts for Flashcards, Coding questions, Rich code blocks, the theme picker and plugin settings pages are a later round. **Since the phone plugins round**: Flashcards and Rich code blocks are offered on a phone, with Settings → Core plugins and their own pages; everything else stays as here. See "Phone" below. |
| 11 | Held sessions | Upstream's new controls are refused by the server and greyed out, like Rename and Delete. A Tutor answer in progress finishes before the session moves. |
| 12 | The server's front door | **The fork's.** Its login and device-key gates on the server; upstream's new check only on the desktop app and local use. |
| 13 | Large uploads | **Mix.** Upstream's exemption for document uploads, with the fork's login checked inside it. |
| 14 | Shortcuts | **Upstream's.** Drawing Pad keeps Ctrl+Shift+E. Ctrl+Shift+N opens the notes drawer with the cursor in the note's editor, and closes it again. The fork's "jump into the editor" shortcut is gone. |
| 15 | Pop-up boxes | **Upstream's.** All of the fork's move onto HostDialog, keeping their look and words. |
| 16 | Plugins | **Upstream's.** Every plugin is offered on the PC and on the server, off until switched on. |
| 17 | Plugin data | Per device for now. The sync backup also covers plugin and theme data. Syncing Flashcards is a later phase. **Since the phone plugins round**: Flashcards' library syncs (its model choice, batches and uploaded files' text stay per device); every other plugin's data and which plugins are on stay per device. See "Plugin data is per device" below. |
| 18 | Upstream's workflows | Deleted from the fork (`ci.yml`, `release.yml`, `notify-website.yml`). |
| 19 | Pictures in messages | The "sent once" rule is extended to them. |
| — | Server feed | Two branches stay: the server follows its own branch, the PC follows `side-tutor`. |
| — | The official app | It is installed on the owner's PC. The update steps account for it. |

(Numbers 2, 4 and 5 of the first round were settled by decision 1.)

## What was built, by area

### The Tutor

See `docs/side-tutor.md`. In short: the fork's engine (store, route, agent, prompt, sync guard, bundle file) is gone; the window reads upstream's side conversations through upstream's hook `useSideThread`, and nothing in upstream's engine is changed.

### Sync (protocol 2)

(Protocol 3 since Flashcards sync: "Flashcards sync" in `docs/cloud-sync.md`. Everything below still holds.)

- **`SYNC_PROTOCOL_VERSION` is 2** (`src/core/sync/protocol.ts`). Upstream raised the chat record format from 1 to 2 (`CURRENT_CHAT_VERSION`), and a format-1 build refuses a format-2 file, so a protocol-1 side must never receive one. The session bundle also changed shape.
  - A test (`PROTOCOL_FOR_CHAT_FORMAT` in `tests/sync-sessions.test.ts`) lists which protocol each chat format needs and fails when the format rises without a new row. It runs in both workflows, so the rule "a release that changes a data format is marked" is enforced.
- **The second lock** (owner's decision 6): beside the protocol number, a side neither takes nor sends a chat file stamped with a newer `version` than it reads (`chatFormatTooNew`, `checkBundle` in `src/core/sync/sessions.ts`; the server answers 409 `newer_format`). Nothing shows on screen. It covers the case the number can't: two builds with the same protocol, one of which already writes a newer chat format.
  - **Known limit:** a hand-over can stall when the holder's chat file is newer than its own build can read (a downgraded app). The asker keeps seeing the waiting strip.
- **A session is three kinds of file now**: the chat record (its side conversations are inside it, `sideChats`), the notes home-folder record, and the helper job files. `side-tutor/<chatId>.json` is gone from the bundle. The bundle's fingerprint keeps a constant "no side-tutor file" part, so the fingerprints both sides saved before the update still match and nothing is re-sent in bulk.
- **Pictures inside messages travel once** (decision 19; `src/core/sync/pictures.ts`). Since 0.6.0 a picture the learner attached or a tool returned is an image block inside the message (`{ type: "image", mimeType, data }`), outside `imageSnapshots`. Each one of at least 1,024 base64 characters is named by the SHA-256 of its bytes and travels like a snapshot (`PictureList.inline`: the path to the block, and the id). The file is still put back together byte for byte; a chat that can't be (odd formatting, non-canonical base64) travels whole.
- **More settings sync** (decision 9; `SYNCED_SETTINGS` in `src/core/sync/maps.ts`): `appearance.theme`, the nine `appearance.colors.*` overrides, `appearance.codeLigatures` and `compaction.includeReasoning`. `appearance.mode` stays on the list: upstream no longer reads it, but an older record that still carries it must not stall a round.
  - **Since then** (owner's change): no appearance setting syncs. They are "retired": still accepted on the wire, never read or written, and both sides forgot what they had noted about them ("Appearance is per device" in `docs/cloud-sync.md`). `compaction.includeReasoning` still syncs.
  - **Per device, never synced:** `agent.workerRequestConcurrency` ("helpers at once"), the side-question model slot (`agent.models.sideQuestion`), and everything that was per device before.
- **Custom theme files sync** as their own map kind, `t|<theme id>` (`themes/<id>.json`, read and written through upstream's `themeStore`; `src/server/sync/map-views.ts`). Built-in themes never travel. A theme file that is there but can't be read is left alone, like the other files.
- **Held sessions and upstream's new writes:**
  - `sessionWritePath` (`src/server/sync/engine.ts`) matches a write at any depth under `/api/chats/<id>` (a side question's `PATCH /side-chats/<thread>` and `POST …/stop` are two levels down). The notes home folder is still left to its own route.
  - `guardChatStore` covers upstream's new store method, `updateSideChats`: on a held session it changes nothing and returns the threads as they are. The fork's `guardSideTutorStore` is gone with the store it guarded.
  - `handleChatInput` checks the lease in its first statement (`heldElsewhereResponse`), ahead of upstream's new tidy-up of plugin questions.
  - `reconcilePluginQuestionCompatibility` (run by `GET /api/chats/<id>`) leaves a held session alone. Without that, a held session whose plugin was off on this device reloaded in a loop.
- **A Tutor answer syncs at once.** The loop runs a round immediately on `side-chats-changed` (`src/server/sync/loop.ts`), which upstream announces when a side answer starts (the question is in the record by then) and when it ends. So the server hears "busy" as it does for a reply, and the question isn't left unsent while the answer is written. Found by the reviewer: without it the server heard of a Tutor answer only at the next 10-second round.
- **A Tutor answer counts as a reply being written** at a hand-over (decision 11; `src/server/sync/local-work.ts`): the holder finishes it, then hands over; the asking device shows the existing strip, "Desktop is finishing a reply. This session moves here when it's done." When a session goes anyway (lost to a take-over, or taken from the cloud), a side answer still running for it is stopped with the other work (`sideChats.stopAll`).
- **Backups** (decision 17; `src/store/sync/backup.ts`): the once-per-side backup also copies `themes/`, `plugins-state.json` and `core-plugin-data/`, and no longer `side-tutor/`. Not the code of community plugins. With Flashcards sync each side also copies Flashcards' folder aside once more, right before its first Flashcards exchange (`backups/before-first-flashcards-sync <date>/`, `makeFlashcardsBackup`); both backups also keep Flashcards sync's own files under `sync/` when they exist. Putting either back deletes nothing on the other side ("Restoring a backup" under "Flashcards sync" in `docs/cloud-sync.md`).
- **A bug fixed on the way:** a round whose fetch of one session failed still moved its place in the server's list forward, so that session was never fetched again. The place now moves only past what was fetched (`src/server/sync/desktop-sync.ts`).
- **Plugin data is per device** (decision 17): which plugins are on, their settings and their data (Flashcards' history) don't sync. Consequences the owner has been told:
  - a plugin's pending question is cancelled by upstream's own rule after a take-over to a device where that plugin is off;
  - a plugin's background job that was running when its session moved fails on the new holder, and says so, instead of restarting;
  - a plugin's own operations (its data, its pages) aren't session writes and aren't refused on a held session.
  - **Since Flashcards sync**: Flashcards' library is the exception. Its decks, facts, cards, deck memberships, reviews, synced settings and uploaded-file records travel item by item, with no lease, and each schedule is worked out again from the combined reviews; its model choice, batches and uploaded files' text stay per device. Which plugins are on, and every other plugin's data, are still per device, and the three consequences above still hold. See "Flashcards sync" in `docs/cloud-sync.md`.
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
- **On a phone:** the list has no icons, no Keyboard row and no plugin rows; a link to a plugin's section lands on the list. (Since the phone plugins round: Core plugins is listed after Account, with no dividers, and the pages of Flashcards and Rich code blocks open from their ⚙ there, their back arrow returning to Core plugins; Coding questions and Drawing Pad read "Disabled" there, their switch off and greyed; on the server's site Obsidian is a group inside Cloud, under "Desktop apps", with no row of its own, so the list has eight rows. The pages' own rows and the Obsidian row were taken out at the owner's ask, "very cramped": "Settings on a phone" and "A less cramped list" under "Plugins on a phone" in `docs/cloud-sync.md`. Shipped with the second touch batch.) The closing fade is kept by fading a copy of the panel's contents (`fadeOutCopy`), because upstream's dialog removes the panel at once.

### Phone

- **The Enter rule** (Enter is a new line on a touch phone; the button sends) also applies to upstream's new text boxes: a plugin question's box and its key handling (`components/plugin-question-dock.tsx`, `plugin-question-keys.ts`), upstream's "Enter from anywhere" (`components/enter-submits.ts`) and the citation comment (`components/citation-comment-editor.tsx`; ⌘/Ctrl+Enter still saves and sends).
- **Plugins are hidden under 640 px** (`components/phone/phone-plugins.ts` lists the rules). **Since the phone plugins round** this holds for every plugin but Flashcards and Rich code blocks: Flashcards' session-list entry shows, a phone-ready plugin's page renders, and rich drawings get a phone layout ("Plugins on a phone" in `docs/cloud-sync.md`). As built at the merge:
  - the ways in are hidden by `app/phone.css`: the lesson's top-bar plugin buttons, the session list's plugin entries, the graph's plugin buttons;
  - a plugin page opened directly shows "Open this on a computer." under a top bar that has only the session-list button (`components/phone/phone-plugin-page.tsx`);
  - a plugin's question is parked: "This question needs a bigger screen. Open this session on a computer to answer it.", with the button "Dismiss question" under it; a plugin's practice problem is parked with "This problem needs a bigger screen. Open this session on a computer to answer it." (`components/phone/parked-plugin-question.tsx`; "Asked after it was built" below);
  - rich diagrams inside a lesson still draw.
- **HostDialog on a phone** is sized to the visible height (`--lh-vvh`), so the keyboard doesn't cover it; theme cards are one column.
- Tests: `tests/phone-plugins-ui.test.tsx`, and the phone-only rule for every `phone.css` rule in `tests/phone-layout.test.ts`.

### Notes shortcut

- **Ctrl+Shift+N** opens the drawer with the cursor in the open note's editor (the note switches to its edit view), and closes the drawer again. With no note open, the cursor lands in the notes search box. (The search box exists only once the list has loaded, so the drawer waits for that; a browser run found the cursor going nowhere before.) Opening with the Notes chip doesn't move the cursor. (`landInEditor` on `NotesDrawer`, set by the `toggle-notes` shortcut in `components/chat.tsx`.)
- **Ctrl+Shift+E is upstream's** (Drawing Pad). The fork's `focus-notes` shortcut is removed.

## Asked after it was built (owner's answers)

Five things the plan had left open, or that came out differently than the plan said. The owner chose from pictures.

1. **The Tutor's middle on a light theme: the theme's background at 62% with 10% of its text colour mixed in** (the owner's pick of three; the others were the background at 60% and the theme's soft grey at 78%). Black at 60% is unreadable over a light lesson. Dark themes keep black at 60%. (`BODY_BG` in `components/side-tutor.tsx`.)
2. **A parked plugin question gets "Dismiss question".** The plan said the message box stays usable under the note. It can't: upstream's server takes no typed message while a plugin question waits ("Answer or dismiss the pending plugin question first"), on any device. The owner chose upstream's own button and words over the sentence alone and over changing upstream's rule. It is upstream's silent dismissal: the question is marked dismissed, the message box comes back, and the teacher learns of it with the learner's next message.
3. **A plugin's practice problem is parked too**, with new wording the owner approved: "This problem needs a bigger screen. Open this session on a computer to answer it." No button; upstream has no dismissal for a problem. It can only be met by opening, on a phone, a practice session started on a computer.
4. **The iPhone status bar is left as it is for now** (`black-translucent`). The plan said dark clock text on a light theme. An iPhone offers no style with dark text that also lets the app draw under the clock, which the full-height session list and the tuned top spacing rely on. So on a light theme the home-screen app's clock is white and hard to read; a Safari tab isn't affected. To be decided in the phone-layout round, on the owner's real phone. The two other options shown: a dark strip behind the clock on light themes, or the iPhone's standard bar on light themes (the icon must be added again and the top spacing re-checked).
5. **The icons for the fork's Settings rows stay** as picked: a cloud (Cloud), a notebook with a pen (Obsidian), a person (Account).

## Asked for with the results (owner)

- **The Tutor starts minimized** on a computer whenever a session opens, and **comes out of its bubble with a morph** when opened and closed. Computer only; the phone's animation is not to be changed yet. Details in `docs/side-tutor.md`.

- **The Tutor stays above the Drawing Pad**, window and bubble. Details in `docs/side-tutor.md`.

- **A tablet in the browser no longer has its page pulled down by a finger**, with the computer layout kept ("Phone layouts", under "When it applies", in `docs/cloud-sync.md`).
- **Three iPad fixes** (owner's iPad): in the home-screen app the top edges sit below iOS's blur (a Safari tab is unchanged); Apple Pencil taps click the first time; and palm rejection on the Drawing Pad. All three are in the fork's own touch files, change nothing in the Windows app, and were shipped to both branches at the owner's word. Not yet confirmed on the owner's iPad. Details under "When it applies" in `docs/cloud-sync.md`.
- **Demos work on the server:** the image now carries Chromium, which the demo agent needs to test-run a demo ("Hosting" in `docs/cloud-sync.md`). Not an 0.6.0 matter: it was so since server mode was built.
- **A check opens by scrolling: built, shipped, then reverted at the owner's word** (owner's ask, iPhone in a mobile browser: after opening a session, scrolling down didn't go into a teach check waiting behind "Check your understanding … Open ›" until it had been tapped; the owner's words: "i literally just want it to be like a normal question where i can scroll down and it opens").
  - **What was built and shipped** (release 0.6.30 and the server image of that commit, `51d76b8`; code commit `99459c4`): an untapped check opened (1) on coming back within 16 px of the lesson's bottom after having been more than 96 px away, and (2) at the end on one more push down, a 24 px finger drag or 100 px of wheel (`components/push-at-end.ts`, and `leftBottomRef` in `DockOverlay`, `components/chat.tsx`). On every device, by the owner's two decisions then (opens by scrolling like any question; everywhere).
  - **The owner's verdict on the iPhone:** "the scrolling into the question isn't working how i wanted it to at all. i wanted it to be like any normal question, where i scroll all the way through the content, into blank space, then it opens. with your change, if i scroll down a tiny bit and then the question opens, then closes, then opens when it gets to the bottom of the blank space. revert it".
  - **Reverted** (`cf6e46c`, a `git revert` of `99459c4`): `components/chat.tsx`, `components/phone/use-dock-touch-scroll.ts` and `tests/dock-touch-reveal.test.tsx` are byte for byte what they were at `340a5a4` (the phone's keyboard round), and `components/push-at-end.ts` and `tests/push-at-end.test.ts` are gone. Upstream's rule holds again: a teach check waits behind Open until it is tapped (or opened with Enter), and reaching the bottom by hand doesn't open it. The reading in `docs/cloud-sync.md` ("The teach check's "Open" away from the bottom") stands as first written.
    - It also takes back a side effect: a tap on Open whose glide the learner stops leaves the check unopened again.
  - **Why it opened, closed and opened again** (read from the code after the report; not reproduced, the Chromium check never showed it): before a check's first opening the lesson ends where its text ends, with no blank space under it. The push opened the check there; the dock then grew and the room kept under the lesson for an open question appeared, so the bottom was suddenly a few hundred pixels further down. With the finger still on the screen the slide to the new bottom is stopped ("A touch stops the slide to the bottom" in `docs/cloud-sync.md`), the lesson is then more than 96 px from its bottom, and the fold rule folds the question; it opens again at the real bottom.
  - **State of the revert:** shipped. With the owner's word ("Ship to both"), the same commit went to `claude/pensive-goldberg-7dty2m` and to `side-tutor`, both plain fast-forwards from `069e4b9` (the keyboard-up marker fix, another session's, shipped meanwhile); release 0.6.32. What the owner asked for in its place is the next bullet.
- **Scrolling into a check: the blank space** (owner, after the revert: "i wanted it to be like any normal question, where i scroll all the way through the content, into blank space, then it opens"; and, to a test page first: "why should it need a test page? the functionality is already there").
  - **The owner's decisions:** a waiting check stays **folded, and scrolling opens it** (over "open on arrival, like other questions", which would have dropped the Open step); every device, as decided for the first attempt; and **built and shipped to both branches at once**, with no test page and no phone trial first (over the server branch first).
  - **What the learner gets:**
    1. A check that waits behind "Check your understanding … Open ›" still arrives and loads folded, and **never opens by itself**.
    2. While it waits, the lesson already has **the blank space under it that the open check will need** (the spacer is as tall as it will be once the check is open). Opening it later changes no scroll geometry, which is what the first attempt got wrong.
    3. **The lesson rests at the end of its text**, on load and while it follows the teacher's writing: the bar sits under the last line and the blank space is below the screen.
    4. **Scrolling on down through the blank space to the bottom opens the check** and counts as opening it, exactly as a folded question reopens at the bottom (the fold machine's own `EXPAND_DIST`, 16 px). From then on it is an ordinary question.
    5. Open, Enter and the reading-thinking field's Open work as before; on a touch screen Open glides from the resting point to the real bottom and the check opens on arrival.
  - **How** (`components/check-blank-space.ts`, fork-owned, the pure rules; the wiring is `DockOverlay` in `components/chat.tsx`, each edit marked `FORK (scroll into a check)`):
    - **The height:** `QuestionDock` keeps its open form mounted and laid out while folded (hidden, zero height), now marked `data-dock-open-form`. The open block's height is the folded block with the bar swapped for that form, the question area counted uncapped, the whole capped as an open dock is (`openCheckBlockHeight`, `measureOpenCheck`). `offer()` reserves the larger of that and the folded block; a ResizeObserver on the form measures again when it rewraps. The reserve still only grows.
    - **The resting point:** `use-stick-to-bottom` takes a custom target (its context's `targetScrollTop`). While a check waits it is the real bottom less the blank space beyond the folded dock (`extra`, kept in a ref and set where the reserve is offered, so it is there before the library's own resize handling). The library only ever slides down, so a learner already in the blank space is never pulled back up.
    - **Opening:** reaching the bottom opens a waiting check only when the blank space is in place for this question, the lesson has since been seen more than 16 px from the bottom, and the last scroll that moved it moved it down (`checkOpensOnScroll`). An arrival that falls inside one of the fold machine's 400 ms mutes is looked at again when the mute ends.
  - **Rulings made while building (for the owner to review):**
    - **"Moved down."** Without it, anything that clamps the lesson to its bottom (the keyboard closing, a taller window, content getting shorter) would have opened the check by itself; those all move the lesson up.
    - **Back to the resting point** (`backToRest`). When the lesson or its scroller changes size (messages taking their real height after load under the off-screen rule, a taller or wider window, the blank space growing), a lesson that was resting at the end of the text is put back there, through the library's own setter. One the learner had scrolled into the blank space is left where it is. Found in the browser: at iPhone size the load left the lesson about 300 px into the blank space; and the independent check found a taller window doing the same, which was a rest point worked out from a half-updated layout (fixed: it is read from the spacer as it is in the page).
    - **A plugin's check keeps upstream's behaviour** (Coding questions: no blank space, Open only). The owner was told with the plan.
    - **A lesson too short to scroll** keeps its check behind Open.
  - **State:** built on `claude/upstream-0.6.0` (code commit `0a3feea`) and **shipped**: with the owner's word ("Build, ship both at once"), the same commit was pushed to `claude/pensive-goldberg-7dty2m` and to `side-tutor`, both plain fast-forwards from `77a6b5d`. No dry run; the two workflows run their own tests before they publish (release 0.6.33). No protocol or format change. **Confirmed by the owner after updating: "yes, everything works"** (asked about the phone: folded at the end of the text, opening at the bottom of the blank space). They didn't say whether the Windows app was tried.
  - **Checked** by an independent verifier on a production build in Chromium, every case 3 times from a fresh page load, after one repair (the taller window, above):
    - **iPhone size, real touch through CDP:** folded in every frame for 5 s after load, resting 357 px from the bottom with the spacer at 668 px and the last text where it is for a folded question; ordinary swipes, and one slow swipe held at the bottom for a second, wiggled and lifted, opened it on arrival (0 to 13 px from the bottom) with no fold in any frame after and the spacer unchanged; a 20 px swipe left it folded; up and back down opened it on arrival; Open from rest and from 1,500 px up ended open at the bottom; once open it folds and reopens as any question; a normal question as before.
    - **A computer, 1280 × 800, the wheel:** the same (resting 485 px from the bottom, spacer 804 px; one wheel step leaves it folded; Open by click).
    - **Resizes while resting:** the phone 300 px taller, and 250 px shorter then back; 1280 × 800 to 1280 × 1000; 1280 wide to 900 wide: folded throughout, back at the end of the text, and a scroll to the bottom afterwards opened it with no fold.
    - Typecheck clean, lint with its one existing warning, the eight related test files passing one at a time.
    - **Seen, not changed:** a hard flick from 1,500 px up ended 33 to 63 px short of the bottom, folded (3 of 3 in the second run, 1 of 3 in the first); scrolling on opens it. With the learner part-way into the blank space and the window then made taller, the two runs disagree on whether the lesson was moved (the implementer's: not moved; the verifier's: 118 px); it stayed folded in both and opened at the bottom afterwards.
    - **Not checked:** Safari on a real iPhone or iPad, the real keyboard, the Windows app, a lesson of hundreds of messages (the test lesson has 59), a check arriving live from a model.
  - **Tests:** `tests/check-blank-space.test.ts` (the rules), `tests/dock-touch-reveal.test.tsx` (the scripted lesson with the real `use-stick-to-bottom`: folded and at rest on load and on arrival, never opening with no input, opening at the bottom with no change of the reserve and no fold after, a lesson too short to scroll, Open from rest and from far up, a stopped glide then a scroll to the bottom by hand, a taller viewport at rest and in the blank space, the reserve growing at rest, a normal question unchanged).
  - **Only the owner's iPhone can show:** Safari's momentum through the blank space (a hard flick can stop a few pixels short of the bottom, folded, as for any folded question); whether Safari keeps the view still when messages above take their real height (if not, the back-to-rest rule covers the lesson getting shorter); and how the opening looks at the moment of arrival. The first attempt passed every browser case too.
  - **Known limits:** a jump of the browser's own that moves the lesson down to within 16 px of the bottom with no change of the lesson's height could open the check by itself (not seen); a check arriving live from a model was run in the scripted lesson only.
- **A research job that ends without a brief gets one wrap-up request** (owner's report: research agents fail to produce text).
  - **The fault is upstream's**, unchanged in 0.6.1: the brief is the text of the run's **last** assistant message (`runSubagent` in `src/agent/subagents/pi-run.ts`), and a run with no text there fails with "Research failed: the researcher produced no text" (`src/agent/subagents/runner.ts`).
  - **Four ways to get there, each reproduced** with the real researcher loop and scripted model replies (no real model):
    1. **the call limit:** the run ends right after the model call that reaches the limit, also when that call was one more search, so the brief is never asked for;
    2. **hidden text:** the last message has only thinking. Newer Claude models return text written next to a tool call as a thinking block, and the researcher has no tool to hand its brief in (the teacher and the Tutor have `send_to_user`);
    3. **the brief too early:** the brief and one more tool call in one message, then a closing message without text;
    4. **cut off:** the last message runs out of output room while thinking.
    - A quiet variant of the first: a line such as "Let me check one more source." beside the last tool call was delivered as the brief, with no failure shown.
  - **Which of these the owner met isn't known**: that needs a failed job's record (`usage.steps` at the limit means the first).
  - **The owner's decisions** (one question each):
    - **a wrap-up request**, over that plus a hand-in tool for the brief (sturdier on Claude models, but it changes the researcher's prompt for every run) and over no fix;
    - **the limit is 16 model calls** (it was 12; the others offered were 12 and 20). With the wrap-up a job makes at most 17;
    - **the wrap-up's words:** "Your research time is up. Do not call any more tools. Write your final brief now, in the required format, using only what you have already gathered. If something could not be established, say so under Gaps." (`RESEARCH_WRAP_UP_MESSAGE` in `src/agent/subagents/researcher.ts`; over a shorter text without the last sentence).
  - **The rule** (`wrapUp` on `runSubagent`, used by the researcher only):
    - when the run's last message made a tool call, or has no text, the researcher is sent the wrap-up message once, and that reply's text is the brief;
    - a tool call in that reply is refused, not run. The tools stay declared: taking them away in the middle of a run invalidates the earlier thinking blocks on newer Claude models;
    - still no text: the same failure as before;
    - not after Stop or a provider's error. The wrap-up call is counted in the job's usage like any other;
    - a run that ends with a brief makes no extra call, and nothing on screen changed.
  - **Not changed:** the PDF reader (its own loop and limit) and every other helper.
  - **State:** built on `claude/upbeat-goodall-391yam` (cut from `side-tutor` at `e9b225e`; code commits `6f61bf5` and `74cdeaa`) and **shipped**: with the owner's word ("Ship to both now"), the same commit was pushed to `claude/pensive-goldberg-7dty2m` and to `side-tutor`, both plain fast-forwards from `e9b225e`. No dry run (it was offered); the two workflows run their own tests before they publish. No protocol or format change, so the order of updating the server and the PC doesn't matter. Not yet confirmed by the owner with a real research job. The owner's report since the investigation: it happens only occasionally, and with every provider, which fits the call limit.
  - **Checked** with scripted model replies only, by the implementer and then by an independent verifier with a script of its own: each of the four ways and the quiet variant now ends in the wrap-up's brief; 16 tool calls make exactly 17 model calls; a tool call in the wrap-up reply never ran; a wrap-up reply without text gives the old failure and no second wrap-up; a run that ends with a brief makes no extra call; a caller without `wrapUp` is as before. Typecheck clean, lint with its one existing warning.
  - **Not checked:** a real model (whether it follows the wrap-up message, and how a real provider takes a refused tool call), and a job through the real screen.
  - **Tests:** `tests/researcher-wrap-up.test.ts`.
  - **Known limit:** a brief written beside one more tool call, followed by a closing message that has some text ("Done."), still delivers the closing text. A real brief can't be told from a closing remark without guessing.

- **Demos and figures follow the theme** (owner's ask: "make it so that demos default to dark mode/light mode depending on theme").
  - **The owner's decisions:** the existing "Invert colors" switch starts on for a dark theme and off for a light one (over demos built with their own dark colours, and over both together); a switch the learner has flipped is kept as set on every theme and device, and demos flipped before this keep what they saved (over "the opposite of the theme"); figures follow too, not demos only.
  - **What the learner gets:** a demo or figure never flipped shows dark on a dark theme and light on a light one, and changes at once when the theme changes. The full-screen figure view opens the way the card shows. Annotated photos never invert, as before. Unchanged: how demos are written (still built light, on white), downloads, sync, and a held session (a flip is refused there, as before).
  - **How:** the steer card hands the saved switch through as it is (`data.ui?.inverted`, undefined when never flipped; it used to become `false`), and `DemoOutputCard` and `VisualOutputCard` take `savedInverted` and fall back to `useAppearance().resolvedMode === "dark"`. A flip saves through the artifact-ui route as before. Each edit is marked `FORK (theme default)`.
  - **Checked:** on a production build with the sample teaching session, the Default theme (dark) and Catppuccin Latte (light): demo and figure inverted on dark, not on light; a demo flipped on with the light theme stayed inverted on dark and on light while the unflipped figure followed the theme.
  - **Tests:** `tests/artifact-theme-default.test.tsx` (both kinds on a dark and a light theme, a saved choice both ways, the steer card's hand-through, a live theme switch and a flip sticking through it); the two asserts in `tests/demos.test.tsx` that pinned "off by default" now read "on, on a dark theme".
  - **State:** built on `claude/peaceful-ride-831pls` (code commit `232ff0e`, merged with `side-tutor` at `1d28187` as `2233b1c`) and **shipped**: with the owner's word ("yes", then "push"), the same commit went to `claude/pensive-goldberg-7dty2m` and to `side-tutor`, both plain fast-forwards from `1d28187`. No dry run; before it, typecheck, lint and the related tests on the merged tree, and an independent verifier (no defects). No protocol or format change, so the order of updating the server and the PC doesn't matter. Not yet confirmed by the owner on a device.
  - **Not checked:** a real iPhone, iPad or the Windows app.

- **Money amounts no longer turn into a formula** (owner's report, a practice problem: "On January 1, a company purchases a debt security at its face value of $100,000 … it receives $6,000 of interest" was drawn as one long italic formula, with the bold's asterisks showing).
  - **The cause:** in upstream's renderer two bare `$` in one paragraph are a formula's start and end, and the agents' formatting instructions say `$...$` is math and nothing about money. A model that wrote each amount as its own formula (`$\$600{,}000$`) rendered fine; one that wrote bare amounts didn't. Upstream's Flashcards generator already carries a line about literal dollars; the lesson's agents didn't.
  - **The owner's choice** (of three: the instructions, the renderer, both): "a fix that won't break anything", so **the instructions only**. The renderer is unchanged, so nothing that draws correctly today can change.
  - **What was built:** one bullet in `src/agent/prompts/shared/40-formatting.md`, under the Math bullet, wording approved by the owner: "Money: a bare `$` opens math, so two amounts in one paragraph turn everything between them into a formula. Escape currency in prose as `\$20` (in JSON strings: `\\$20`), or keep it inside math as `$\$20$`. Literal tokens such as `$HOME` go in inline code." That fragment is composed for the prober, the teacher, practice and side questions (the Tutor).
  - **Limits the owner has been told:** it makes the glitch rare, not impossible (a model can still slip, and a backslash doubled once too often in a tool argument, `\\$`, still opens math); text already garbled stays garbled; a learner who has switched on their own Formatting text in Settings keeps that text; the background helpers (research, demos, visuals, PDF) have their own instructions and aren't changed.
  - **Checked** through the app's real renderer, as a message and as a tool's text (a problem statement): the owner's sentence bare (a formula), escaped (text, bold intact, also in a table and a list), each amount inside math (one formula each), and escaped money beside real math.
  - **Tests:** `tests/prompt-money.test.tsx` (the bullet word for word, reaching all four agents; each form rendering as the bullet says; and that two bare amounts are still read as a formula, so the bullet is revisited if upstream ever teaches the renderer to tell money from math).
  - **State:** built on `claude/upstream-0.6.0` (code commit `f849272`) and **shipped**: with the owner's word ("ship"), the same commit went to `claude/pensive-goldberg-7dty2m` and to `side-tutor`, both plain fast-forwards from `e072349`, once the builds of the appearance ship before it had finished (a push to a branch cancels that branch's build in progress). No dry run; before it, the new test, every test file that reads the agents' instructions (258 of 258), typecheck and lint. No protocol or format change, so the order of updating the server and the PC doesn't matter. Not tried with a real model, and the owner hasn't seen it yet.

### The Drawing Pad, as tried on a computer (nothing of upstream's changed)

- **Draw** sits in the lesson's top bar right of Notes and the ring. With too little room (the notes drawer open, a narrow window, a long title) it moves into upstream's ⋯ menu.
- The pad covers the lesson under the top bar. **An open question is already on the sheet**, with its options, as a read-only picture to draw on or around; the answer is picked after closing the pad. With the notes drawer open the pad narrows beside it.
- Not tried: sending a drawing to the teacher (it needs a real model).
- **On an iPad (owner's):** a resting palm became one big selection box over the pad. The fork now cancels finger and palm touches on the pad's drawing area, makes the pad unselectable and clears a stuck selection at the next touch, from its own touch files, without changing upstream's plugin ("Palm rejection on the Drawing Pad" in `docs/cloud-sync.md`).

### The other core plugins, as tried on a computer (nothing changed)

Run in a browser against a stand-in model that poses the questions and writes the cards; no real model, not on Windows, not in the server image.

- **Rich code blocks:** a `smiles` molecule, an `abc` score and a `tikz` diagram all draw; ordinary code fences stay code. The three families are off until switched on in the plugin's own Settings page. TikZ is compiled in the browser.
- **Coding questions:** a coding problem in a practice session and a coding question in a teaching session were posed, answered in the code editor and submitted; the tests ran ("Tests passed", "Tests failed" with the error text), the model solution showed, and the teacher got the result. A teaching "check" waits closed behind **Open**, like upstream's own checks.
  - It runs whatever program the teacher names, from the machine's PATH. The server image has Node and a shell but no Python and no compiler, so a Python or C question there ends in "Could not run tests" (the answer is still accepted). On the PC the language's runtime must be installed and on PATH.
- **Flashcards:** picking topics from the graph, the cost preview, generating, the deck, and a review with its four ratings all work. Generating from a file wasn't tried. Decks and review history are per device (decision 17).

### Plugin security: the facts, and options not yet chosen

Read from the code by a reviewer; nothing is built. The owner asked whether the concerns raised at decision 16 can be fixed.

- **A community plugin can only be added by copying a folder into `<data>/plugins`** (on the server: over SSH). Nothing in the app downloads or uploads plugin code, and the agents' file tools only read. A signed-in browser can switch on a plugin that is already there.
- **A switched-on plugin is fully trusted code**, core or community alike: its back end is loaded into the server's own process (files, network, environment, child processes, every session, model calls on the owner's credentials, its own tools and prompt text for the agents), and its front end runs in the app's page with the app's own API rights. No permission model, no sandbox; upstream names this a non-goal (`docs/plugin-architecture.md`).
- **Coding questions is the one that runs model-written programs:** one spawn point (`plugins/coding-questions/src/runner.ts`), no shell, the server's whole environment inherited, a 30-second limit, no isolation. The learner never sees the test program. The realistic attack is a web page or document the teacher reads steering it into writing a harmful one. On the server that program could read `/data` (notes, sign-ins, keys).
- **Options told to the owner** (none chosen yet):
  1. server mode refuses community plugins (small);
  2. server mode doesn't offer Coding questions (small), or runs its programs in a second container with no `/data` and no network (medium; needs a few lines at upstream's spawn point);
  3. test programs get an emptied environment (small; both PC and server; same spawn point);
  4. a Content-Security-Policy for the app's pages, so plugin front-end code can't send data elsewhere (medium; `proxy.ts`);
  5. only run a community plugin whose content hash the owner approved (small to medium; upstream's activation code).
- **What no option fixes:** a plugin the owner installs and switches on can do whatever LearnHarness can. On the Windows PC there is no practical sandbox for test programs.
- **The owner's direction since:** write the fork's own coding questions plugin, for Python, JavaScript and SQL, whose code and tests run in the learner's browser and never on the machine. A draft plan for the next session is `docs/own-coding-plugin-plan.md` (not approved, nothing built). The six options above are still unchosen; the plan asks about option 1 with its other decisions.

### Asked about, not started: Apple Pencil on an iPad (owner: "dont start working on it yet")

- The owner wants Notability-like Pencil use in the pad on an iPad: squeeze switches to the eraser, which removes whole strokes.
- **Already upstream's:** pen input with pressure, fingers ignored, and an eraser that removes every stroke it touches (undo restores them).
- **Not possible in a browser:** squeeze. iPadOS gives it to native apps only (UIPencilInteraction); Safari sends a page no event for it. Looked up, not tried on a device.
- **Unsure until tried on the owner's iPad:** how many Pencil samples Safari hands a page (smoothness), hover and barrel roll. LearnHarness has never been run on an iPad; it gets the computer layout there.
- **The two routes told to the owner:** stay a website and pick a stand-in gesture (a change to upstream's plugin), or a small native iPad app around the server's site that passes squeeze on (a separate project that needs a Mac and Xcode).

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

**Protocol 3 (Flashcards sync)** means the same: both sides must be updated, the server first, or all sync pauses, with nothing discarded. The steps above apply again as they stand. The round changes no file format (the chat record stays at 2, Flashcards' file at 1); only the protocol rises. Step 3's copy by hand covers Flashcards too; its own automatic backup is made once, right before each side's first Flashcards exchange. Steps 4 and 5 are done (both were fast-forwards); what is left is the owner's: the copies by hand, the server's update, then the PC's.

## Not in this merge

- Phone layouts for Flashcards, Coding questions, Rich code blocks, the theme picker and plugin settings pages. Until then plugins are computer-only.
- Syncing plugin data (Flashcards' review history first).
- Phase 7 of cloud sync, and a tablet layout.

**Since then** (the phone plugins round): Flashcards and Rich code blocks have phone layouts, Settings on a phone lists Core plugins and their pages, and Flashcards' library syncs. Still not done: phone layouts for Coding questions, the Drawing Pad, the theme picker and community plugins; syncing any other plugin's data or which plugins are on; Phase 7 and a tablet layout.

## Development notes from the merge

- **`npm run plugins:setup`** after `npm ci`, or the build and several tests fail.
- **`next dev` only:** upstream's lesson screen assigns to a ref's property during render, which React's development server renderer refuses ("object is not extensible"). The lesson page's server render answers 500 and the page then renders in the browser. Production builds aren't affected. It is upstream's, not the merge's.
- **Tests in the development sandbox** (Node 22, no IPv6): `tests/safe-fetch.test.ts` hangs and must be left out of a full run; `tests/safe-fetch-connector.test.ts`, `tests/passive-tooltip.test.tsx` and one case of `tests/plugin-document-proxy.test.ts` fail. All four behave the same on an untouched upstream v0.6.0 checkout. CI (Node 26) runs them.
- **Upstream's plugin SDK type tests** (`tests/plugin-*types.test.ts`) each run the TypeScript compiler with a 30-second limit. Beside the fork's larger suite on GitHub's runner one of them ran out of time, twice in a row. `server-image.yml` runs those seven on their own first, one at a time, then every other test. `npm test` locally still runs everything together.
- **`docs/plugin-api/`** is generated: `node scripts/build-plugin-types.mjs <dir>`, then `node scripts/build-plugin-api-reference.mjs <dir> docs/plugin-api`. A test fails when it is stale, which happens whenever the fork adds an event (`cloud-changed`).
- **A Tutor conversation for screenshots:** put threads in the chat record's `sideChats` (upstream's shape in `src/core/contracts/chat.ts`). The old `side-tutor/<chatId>.json` recipe in `docs/cloud-sync.md` no longer applies.
- **At the next upstream release:** the fork's edits to upstream files are the lesson screen (`components/chat.tsx`: the Tutor's mount, upstream's card and markers left out, the `blocked` props, the parked question and problem), `components/settings/settings-dialog.tsx`, `proxy.ts`, `instrumentation.ts`, `app/layout.tsx`, the `blocked` props in `plugin-chrome.tsx` and `selection-toolbar.tsx`, and the phone Enter rule in the three text-box files. Everything else is in the fork's own files.
  - **Added by the phone plugins round**:
    - `app/layout.tsx`: imports `phone-flashcards.css` and `phone-rich-code-blocks.css`; awaits `richCodeBlocksBoot()` and sets `data-lh-rich-code-blocks` on `<body>`;
    - `app/plugins/[pluginId]/[viewId]/page.tsx`: passes `pluginId` to `PhonePluginPage` (the wrapper itself dates from the merge);
    - `components/settings/settings-dialog.tsx`: the phone's rows (Core plugins, the phone-ready plugins' pages) and `isPhoneHiddenSettingsSection`;
    - `components/settings/plugins-section.tsx` (`PluginRow`): the switch pulled into a variable, disabled and wrapped in `data-phone="plugin-locked"` when locked on a phone; the ⚙ hidden when locked, and marked `data-phone="plugin-settings-link"`;
  - **Added by the less cramped phone Settings** (owner's ask; "A less cramped list" under "Plugins on a phone" in `docs/cloud-sync.md`):
    - `components/settings/settings-dialog.tsx`: no plugin page rows and no Obsidian row on a phone; Obsidian shown as Cloud there (`phoneSettingsSection`, an effect that moves to Cloud, and `selected` instead of `active` for the Obsidian and Cloud pages), with `CloudObsidianGroup` under the server's Cloud; the header's name taken from the plugin when no row has it; the back arrow from a plugin's page to Core plugins (`phoneSettingsBack`);
    - `components/settings/plugins-section.tsx` (`PluginRow`): a locked plugin's switch shows off and its hint reads "Disabled" on a phone.
    - `components/md-blocks.tsx`: the phone frame around a smiles, abc or tikz block, and `data-lh-rich-fence` on its code fallback;
    - `components/session-overlay.tsx`: an optional `openDrawing` in the viewer's context and a `drawing` prop;
    - `components/chat.tsx`: `figureFocus` takes `{ drawing }`, and `openDrawing`;
    - `instrumentation.ts`: on the server, the saved time zone set before the plugins start;
    - `src/server/index.ts`: the barrel exports `richCodeBlocksBoot` and `flashcardsExchangeResponse`;
    - `plugins/flashcards/src/store.cjs`: reads its file again when it changed on disk (Flashcards sync), and one line of `plugins/flashcards/tests/store.test.cjs` with it.
  - **Added by the folded-question tap on touch** ("A tap on the folded question ends at the bottom, open" in `docs/cloud-sync.md`):
    - `components/chat.tsx`: `openDock` (every way of opening a folded or waiting question: on a touch screen it glides to the bottom first, through `components/phone/use-dock-touch-scroll.ts`), `arriveAtBottom` (the fold machine's "reached the bottom again", factored out so the glide's end can call it too), `openOnArrivalRef` (a teach check opened by a tap reveals on arrival) and `openAtOnce` (upstream's opening, also the net when a glide gives up). `suppressFoldDuringReveal` is upstream's again.
  - **Added by scrolling into a check** ("Scrolling into a check: the blank space" under "Asked for with the results"):
    - `components/chat.tsx` (`DockOverlay`): `blankSpace`, `checkSpaceRef`, `lookAtCheckRef`, `noteCheckOfferRef`, `endCheckSpace` and the two ResizeObservers; `offer()` reserves the open check's height; the context's `targetScrollTop`; `openDock` glides from the resting point; `arriveAtBottom` takes `intoCheck`; the scroll listener's look and its recheck after a mute;
    - `components/question-dock.tsx`: `data-dock-open-form` on the hidden open form's wrapper.
  - **Added by the session list's swipe** ("Session list" under "Phone layouts" in `docs/cloud-sync.md`):
    - `components/sidebar.tsx` (`SessionsSidebar`): the import, a ref on the drawer and on its dim, and one `useSidebarSwipe` call (`components/phone/sidebar-swipe.ts`).
  - **Added by the touch selection fix** (Highlight, then Ask on a phone and a tablet; `docs/side-tutor.md`):
    - `components/selection-actions.ts`: a touch or pen gesture no longer sets the "press under way" flag (iOS sends no `mouseup` after a press-and-hold selection, and the flag stuck); it reports once the selection has rested with no finger down, re-checks after a touch is cancelled, a tap and Android's `contextmenu`, and holds the toolbar through a press on it until its click; once shown it follows the selection (placed again at the next frame for each change, never hidden; hidden while the lesson scrolls and placed again once scrolling settles, with no settle wait); `onSelection` gets a second argument, `touch`. Mouse timing unchanged. All of it in a browser only (`touchSelectionHere`): in the desktop app every gesture is upstream's;
    - `components/selection-toolbar.tsx`: a touch selection is placed by `resolveTouchSelectionPosition` (`components/phone/touch-selection.ts`), opposite the system's Copy / Look Up box, inside the part of the lesson the top bar and the dock leave visible, with the bigger touch buttons (a `touch` prop on `SelectionToolbarButtons`), and measured from the shifted body while the iPhone keyboard is up (the layout effect's clamp too; unchanged for a mouse); on touch, finding no selection to show also stops the observer's following (`observer.cancel()`).
  - **Added by demos and figures following the theme** ("Asked for with the results"): `components/artifacts/steer-card.tsx` (passes `savedInverted`), `demo-card.tsx` and `visual-card.tsx` (`savedInverted`, the theme fallback).
  - **Added by the performance round** (long sessions; `docs/performance.md`):
    - `src/core/compaction.ts`: `serializeForSummary` reads a learner message's text whatever its shape and writes `[drawing attached]` per picture, there and for a picture in a tool result (`DRAWING_MARKER`, `imageMarkers`); it imports `userFacingTextOf`;
    - `src/server/compaction.ts`: preparing the summary moved inside `compact()`'s try; a catch on `kickCompaction`;
    - `app/api/chats/[id]/route.ts`: `?only=coverage|settings|turns|stamp`, the record read once and handed to the helpers, `stamp` in the full answer, signatures left out of `messages`;
    - `app/chat/[id]/page.tsx`: `initialStamp`, and `initialMessages` without signatures;
    - `src/server/chats.ts`: re-exports `chatStamp`; `sessionCoverage` takes an already-read record; `src/server/index.ts` and `src/core/index.ts`: one export line each;
    - `src/store/chats.ts`: `chatStamp`, and the stat-keyed summary cache in `listChats`;
    - `src/store/jobs.ts`: the job-file-to-session map in `listJobs`; `src/server/jobs.ts`: the sweep's per-job `getChat` removed;
    - `src/core/native-messages.ts`: the problem fold reads a per-history index (`ProblemIndex`, `problemIndexOf`); `src/core/math-delims.ts`: bounded caches around `transformMathDelimiters` and `repairMathForDisplay`;
    - `components/chat.tsx`: `useSessionHeld`; the `initialStamp` prop; no state set for the same jobs, turns or pricing; `syncTurns` reads `?only=turns`; the catch-up asks for the stamp first; the growth-mute observer reads the entry's own size;
    - `components/session-core.ts`, `session.ts`: `stamp` on the record, `rememberStamp`, `knownStamp`, `recordUnchanged`, `readUsage`, `canonicalNow`, `sameJsonValue`;
    - `components/use-side-thread.ts`, `sidebar.tsx`: an equal list sets no state; `components/extraction-coverage.tsx`, `model-picker.tsx`: read their one field;
    - `app/layout.tsx`: imports `offscreen.css` (the trial's `?offscreen=off` in the head script is removed again; the script is upstream's line);
    - `components/session-navigation.tsx`: `scrollSessionTarget` hands its measuring and scrolling (now `placeSessionTarget`) to `revealOffscreenTarget` (`components/offscreen-target.ts`), so a jump into a message the off-screen rule skipped lands;
    - upstream's tests whose scripted server now answers `?only=settings`: `tests/stats-cache-interaction.test.tsx`, `stats-meter-interaction.test.tsx`, `model-catalog-setup.test.tsx`, `claude-code-context-ui.test.tsx`.
    - The off-screen rule hangs on upstream's markup (`data-session-find-root`, `data-testid="user-message"`, the `is-assistant` class); `tests/offscreen-rule.test.ts` pins the rule.
  - **Added by accounts on one server** (built on `claude/dazzling-maxwell-j6mfy1` and shipped to both branches; "Accounts on one server" under "Hosting" in `docs/cloud-sync.md`). Most of it is new, fork-owned files (`gateway/`, `src/core/accounts.ts`, `src/core/account-screens.ts`, `src/server/account-export.ts`, `src/server/zip-writer.ts`, `app/api/internal/unpair-all/route.ts`, `app/api/account/export/route.ts`, `components/settings/accounts-section.tsx`, `account-accounts-group.tsx`, `owner-mode.ts`, `sign-out-storage.ts`, `scripts/build-gateway.mjs`, `deploy/make-secrets.sh`, `deploy/test/`). The edits to files upstream has, or that the fork had already edited:
    - `components/settings/settings-dialog.tsx` (each edit marked "Side-tutor fork"): imports `UsersIcon`, `AccountsSection`, `AccountAccountsGroup` and `isOwnerMode`; one more `SECTIONS` row, `accounts`, listed only when `!phone && isServerMode() && isOwnerMode()`; its section; on a phone the Account section ends with `AccountAccountsGroup` and there is no Accounts row; `phoneSection` (account-accounts-group.tsx; it wraps `phoneSettingsSection`) replaces `phoneSettingsSection` in the places that fold a section into another on a phone, and `scrollToAccounts` beside `scrollToObsidian` keeps the group in view. `phoneSettingsSection` is no longer imported there.
    - `src/core/index.ts`: two lines, `export * from "./account-screens.ts"` and `export type { AccountsView } from "./accounts.ts"`.
    - `src/server/index.ts`: `unpairAllResponse` added to the `server-auth.ts` export list, and `export { accountExportResponse } from "./account-export.ts"`.
    - `package.json` and `package-lock.json`: `esbuild` 0.28.2 as a dev dependency and the `gateway:build` script (the build already had esbuild through `tsx`).
    - `.gitignore` and `.dockerignore`: `gateway-dist`.
    - The fork's own files, edited: `src/server/server-auth.ts` (`behindGateway`, `gatePasses`, `gateScopeOf`, `gatewayGate`, `unpairAllResponse`; `signedIn` returns a boolean and, behind a gateway, means the secret with scope `session`; the account routes and pages answer 404 behind a gateway), `src/core/sync/devices.ts` and `src/server/sync/http.ts` (a tag in pairing codes and device keys; `accountTag`), `components/settings/account-section.tsx` (the new parts, shown only when the gateway's answer has a `name`), `Dockerfile` (the two bundles, the `lh-gateway` and `lh-maker` wrappers, the `reset-password` wrapper's choice, `/gateway`), `deploy/compose.yaml`, `Caddyfile`, `update.sh`, `docker-entrypoint.sh` (the seed of "helpers at once"), `.env.example`, and both workflows (`server-image.yml`: the stack and crossing tests step; `side-tutor-windows.yml`: four more test files in the cloud-sync test step).
    - Not edited: `proxy.ts`, `components/chat.tsx`, `src/server/api-gate.ts`, `scripts/server-reset-password.mjs`, `scripts/build-server.mjs`. The desktop app's bundle carries the gateway's source files unused (Next's standalone output includes the source tree); nothing in it reads them.
  - **Added by the research wrap-up** ("A research job that ends without a brief gets one wrap-up request" under "Asked for with the results"; each edit marked `FORK (research wrap-up)`):
    - `src/agent/subagents/pi-run.ts`: the optional `wrapUp` on `runSubagent` (one more request when the run ended on a tool call or with no text; tool calls refused during it);
    - `src/agent/subagents/researcher.ts`: `maxTurns` 16 (upstream: 12), `RESEARCH_WRAP_UP_MESSAGE`, and `wrapUp` passed to `runSubagent`.
  - **Added by the money bullet** ("Money amounts no longer turn into a formula" under "Asked for with the results"):
    - `src/agent/prompts/shared/40-formatting.md`: one bullet, "Money: …", after the Math bullet. A prompt fragment can carry no marker comment (its whole text reaches the model); `tests/prompt-money.test.tsx` fails if a merge drops it.
  - The phone styling of Flashcards and Rich code blocks hangs on upstream's class names and markup from the fork's own stylesheets; `tests/phone-flashcards.test.ts`, `tests/phone-flashcards-structure.test.tsx` and `tests/phone-rich-code-blocks.test.tsx` fail when one of those names or structures changes upstream.
