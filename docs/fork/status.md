# Status: what shipped, and what waits for the owner

Kept current: a ship adds one row here and one entry in `history/ship-log.md`. The ship log has each round's record as written at the time; this file is the state now.

## Where the branches stand

- `side-tutor` feeds the Windows app (every push that changes more than `CLAUDE.md` or `docs/` publishes a release) and the server image `:latest`. `claude/pensive-goldberg-7dty2m` feeds the server image `:dev`, which the owner's server follows. `claude/upstream-0.6.0` is the working branch and builds nothing. The docs cleanup brought all three to the same commit; its commits carry `[skip ci]`, so no release and no server image were built for it, and the released app and the server image are still those of the dictation round (built from `dce63584`). Details: `releases.md`, "Which branch feeds what".
- Sync protocol **3** (`SYNC_PROTOCOL_VERSION` in `src/core/sync/protocol.ts`); chat record format 2; Flashcards' file format 1. The server and the PC must speak the same protocol, the server updated first.
- The latest release is **0.6.49**, the dictation round, built from `dce63584` (read from the repository's releases).

## What shipped

Newest first. "Not recorded": the docs give none.

| Round | What it is | Code commit(s) | Release | Way back | The owner's word |
|---|---|---|---|---|---|
| The docs regrouped, and a comment-only source tidy | The fork's docs split by topic into `docs/fork/` and corrected; inside upstream's files every fork marker comment reads `FORK (topic)`; three test helpers moved to `tests/helpers/`. No behaviour change | `095e973e` (the tidy), `3ccae15f` (the move, word for word), then the corrections; from `dce63584` | none: every commit carries `[skip ci]` | the tree at `dce63584` (`git revert` the range from it) | the plan was approved by the owner ("approved"); the result not yet seen. `README.md`; `history/ship-log.md`, "The docs regrouped into docs/fork/, and a comment-only source tidy (no release)" |
| Dictation in Firefox, and a failed Dictate's reason on a phone | The recorder retries at the device's own rate when Firefox refuses 16 kHz; on a phone a failed Dictate shows why | `6c1e714`, `3033b56` (fast-forward from `b40cd07`) | 0.6.49 | `git revert 6c1e714` (the fallback); `git revert 3033b56` (the phone's line) | not yet confirmed (the Firefox cause is an assumption only the owner's Android phone can confirm). `lesson.md`, "Dictation"; `phone-and-tablet.md`, "Screens" |
| Seamless sessions, the pairing form's hint, GPT-6.2 | A session moves to the device you type on: no "Held by", no Take over; GPT-6.2 Astra and Sol in the model list | `ca90585` to `ebdc405`; dry runs on `56e6091`; shipped as `b40cd07` (from `d4c05e6`) | 0.6.48 | the server image tagged `d4c05e6`; revert `ca90585` to `ebdc405` | seamless sessions: not yet confirmed on a device. GPT-6.2: "they appear!" (on the phone). `cloud-sync.md`, "Seamless sessions"; `models-and-agents.md`, "OpenAI and ChatGPT: GPT-6.2 in the model list" |
| Money is not math | The renderer tells money from a formula | `c3ef8f7`, `62ed9c2`, `3702f22`; the release branches at `d4c05e6` | not recorded | `git revert 3702f22 62ed9c2 c3ef8f7` | not yet confirmed. `lesson.md`, "Money is not math" |
| The money bullet | The agents' formatting instructions tell them to escape money | `f849272` (from `e072349`) | not recorded | not recorded | not confirmed; the owner then reported amounts still drawn as formulas, which led to the row above. `lesson.md`, "Money is not math" |
| Appearance is per device | Nothing on Settings → Appearance syncs; imported theme files still do | `af5d46b`; dry runs on `44dc265`; shipped as `e072349` (from `3fa1289`) | 0.6.44 | `git revert af5d46b`; the server image tagged `3fa1289` | not yet confirmed. `cloud-sync.md`, "Settings and the other small files" |
| Demos and figures follow the theme | "Invert colors" starts on for a dark theme, off for a light one | `232ff0e`, merged as `2233b1c` (from `1d28187`) | not recorded | not recorded | not yet confirmed. `lesson.md`, "Demos and figures follow the theme" |
| Research: one wrap-up request | A research job that ends without a brief is asked once for it; the limit is 16 model calls | `6f61bf5`, `74cdeaa` (from `e9b225e`) | not recorded | not recorded | not yet confirmed with a real research job. `models-and-agents.md`, "Research: one wrap-up request" |
| The host firewall (**declined, never shipped**) | Host packet-filter rules for the accounts server | `8b62721`, `189b5b3`, `a85b894`, `6f9665a` on `claude/dazzling-maxwell-j6mfy1` (not in this clone) | none | not in any release branch | declined: "i dont really want the firewall". `history/server.md`, "The host firewall: built and checked, then declined" |
| Several accounts on one server | A gateway, a maker of one container per account, invite codes, the owner's Accounts screen | dry runs on `eeecd2b`; shipped as `e9b225e` (from `bab6d0e`) | 0.6.40 | the server image tagged `bab6d0e` and the previous `deploy/` files (`c31e953`) | "everything works great" (after the switch-over; which screens were tried wasn't said). `server.md`, "Accounts on one server" |
| The session list's swipe; the chains view's button | On a phone the session list swipes left to close, and the chains view has no session-list button | `db7f46f` (from `2fbc222`) | not recorded | `git revert db7f46f`; the button is one rule in `app/phone.css` | not yet confirmed. `phone-and-tablet.md`, "Screens" |
| Scrolling into a check | A waiting check keeps its blank space; scrolling to the bottom opens it | `0a3feea` (from `77a6b5d`) | 0.6.33 | `git revert 0a3feea` (back to release 0.6.32) | "yes, everything works" (on the phone; the Windows app not mentioned). `lesson.md`, "Scrolling into a check" |
| The revert of the check that opened by scrolling | Upstream's rule again: a check waits behind Open | `cf6e46c` (from `069e4b9`) | 0.6.32 | not recorded | asked for by the owner ("revert it"). `history/lesson.md`, "A check opens by scrolling: built, shipped, then reverted" |
| A check that opens by scrolling (**reverted**) | An untapped check opened when the lesson came back to its bottom | `99459c4`, shipped at `51d76b8` | 0.6.30 | reverted by `cf6e46c` | the owner had it reverted: "revert it". `history/lesson.md`, "A check opens by scrolling: built, shipped, then reverted" |
| The phone's keyboard round | With the keyboard up every tap lands and the question gets the room; carries the off-screen switch's removal | fast-forward from `43b4a81`; carries `885497e`; the keyboard-up marker fix `069e4b9` followed, from `51d76b8` | not recorded | not recorded | "the buttons all work when the keyboard is up"; the marker fix not yet confirmed. `phone-and-tablet.md`, "Touch and typing" and "Screens" |
| The performance round | Step 1 of the long-session audit, the off-screen rule, jumps into undrawn messages, the glide's rule | dry runs on `d74d622` (from `1915f9c`) | 0.6.28 (the release that still took `?offscreen=off`) | the server image tagged `1915f9c` | "the performance is now very good" (iPhone and iPad; the Windows app not mentioned). `performance.md` |
| The second touch batch | Obsidian inside Cloud on a phone; Cite and Ask follow the selection; a tap on the folded question glides down into it | not recorded | not recorded | not recorded | not yet confirmed on the owner's iPhone or iPad. `phone-and-tablet.md`, "Plugins on a phone" and "Touch and typing"; `lesson.md`, "Highlight, then Ask on a touch screen" |
| The touch batch | Cite and Ask after a press-and-hold selection; the Tutor's sheet swipes down; the first tap on the folded question | not recorded | not recorded | not recorded | Cite and Ask: "the cite/ask buttons do work as intended, but they take way to long to reappear after i resize the selection box" (the second batch changed that); the folded-question tap "jitters a bunch" (replaced by the glide); the swipe not yet confirmed. `lesson.md`, "Highlight, then Ask on a touch screen"; `side-tutor.md`, "On a phone"; `history/phone-and-tablet.md`, "Touch and typing" |
| The phone plugins round and Flashcards sync | Flashcards and Rich code blocks on a phone; Flashcards' library syncs; sync protocol 3 | dry runs on `7ad11e3` | not recorded | the server image tagged `a5d3284`; the owner's copies of the data by hand | not confirmed item by item; the owner has used it on the iPhone since ("this settings page is getting very cramped on my phone"). `phone-and-tablet.md`, "Plugins on a phone"; `cloud-sync.md`, "Flashcards sync" |
| The three iPad fixes | Home-screen app's top edges below iOS's blur; Apple Pencil taps click the first time; palm rejection on the Drawing Pad | not recorded | not recorded | not recorded | not yet confirmed on the owner's iPad. `phone-and-tablet.md`, "When it applies, and tablets"; `upstream.md`, "Asked for with the results (owner)" |
| The upstream 0.6.0 merge | Upstream v0.6.0; sync protocol 2. Per git, the Tutor's morph and start minimized, the Tutor above the Drawing Pad, the touch-tablet fixes and Chromium in the server image are before `c990b21e`, so they went with it | dry runs on `c990b21e` | 0.6.14 | the server image `dev-a2d2b7e`; the owner's backups by hand | the updates of the server and the PC "went flawlessly". `upstream.md` |
| The cloud sync merge | Phases 1–6 (server mode, phone layouts, the vault on the server, the sync engine and screens) and the Tutor and notes rounds, first pushed to the server's branch | `side-tutor` fast-forwarded to `a2d2b7e` | 0.5.6 | not recorded | "everything works!" (after pairing the real PC with the real server). `cloud-sync.md`; `history/cloud-sync.md`, "The phases" |

## Waiting for the owner

**Decisions not made**

- A password box on Reset, Remove and Delete now on the Accounts screen. `server.md`, "Open for the owner".
- Whether the owner accepts that Reset can set a member's password; the four first values to tune on the real server (4 accounts, 1 GB per copy, 2 GB of swap, 3 helpers at once). `server.md`, "Open for the owner".
- The owner's own copy under the account copies' limits: "For the owner to confirm". `server.md`, "Rulings made while building (for the owner to review)".
- The plugin security options (five, none chosen). `plugins.md`, "Plugin security: the facts, and options not yet chosen".
- The fork's own coding-questions plugin: a draft plan, not approved. `plans/own-coding-plugin-plan.md`.
- The iPhone status bar style on light themes (left `black-translucent` for now). `upstream.md`, "Asked after it was built (owner's answers)", item 4.
- Moving the server to the `latest` channel, so one branch feeds both: not asked yet. `releases.md`, "Which branch feeds what".
- The performance audit's remaining decisions. `performance.md`, "Not built (the audit's other recommendations)", "Decisions still the owner's".
- Apple Pencil in the pad (owner: "dont start working on it yet"). `plugins.md`, "Apple Pencil on an iPad".
- A second wording for the discard sentence after pairing again: not asked. `cloud-sync.md`, "The sync screens", "Rulings, limits and open items".

**Rulings made while building, for the owner to review** (each section holds the list)

- `cloud-sync.md`: "Seamless sessions" and "Flashcards sync", both under "Rulings made while building (for the owner to review)"; "Settings and the other small files" (a removed theme the other side used); "The sync screens" (wording added while building, slices 1 and 3).
- `server.md`: "Accounts on one server", "Rulings made while building (for the owner to review)"; "The Obsidian vault on the server", "From the Phase 4 handoff" (wording added while building).
- `phone-and-tablet.md`: "Plugins on a phone", "Built beyond the plan's letter, for the owner to review".
- `side-tutor.md`: "The Tutor on upstream's side conversations" ("Remove the passage"); "On a phone" (the swipe's readings); "The window and the bubble" (the bubble's 20 px).
- `lesson.md`: "Scrolling into a check", "Rulings, limits and open items".
- `performance.md`: "Rulings made while building (for the owner to review)".

**Left in the code until the owner answers**

- The temporary keyboard readout, `components/phone/keyboard-debug.ts` (typing `kbdebug`), still in the code: to be removed once the iPhone confirms the keyboard-up marker. `phone-and-tablet.md`, "Screens", the bullet "With the keyboard up the question gets the room".
- `ACCOUNTS_FILE_DAMAGED_PLACEHOLDER` in `src/core/account-screens.ts`, marked `TODO(owner wording)`: the page shown while the accounts file is damaged has no approved sentence. `server.md`, "Rulings made while building (for the owner to review)".

**Not confirmed, or only the owner's devices or the real server can show**

- `server.md`: "Accounts on one server", "State" ("Concurrent worker requests" lowered to 3, the recovery codes kept); "What only the real server can show".
- `cloud-sync.md`: "Flashcards sync", "Only the real PC and server can confirm"; "Seamless sessions", "Known limits" (not checked on real devices).
- `phone-and-tablet.md`: the "Only the owner's iPhone can show" lists in "Screens" (the session list's swipe, the keyboard marker), "Touch and typing" (a tap on the confidence bar's line with the keyboard up, the glide) and "Plugins on a phone"; the keyboard's jerkiness at the focus, still open, under "How it's built".
- `lesson.md`: "Highlight, then Ask on a touch screen" and "Scrolling into a check" (what only the owner's devices can show); "Dictation" (Firefox on the owner's Android phone).
- `side-tutor.md`: "Speaking to the tutor" (the Tutor's Dictate has never met a real microphone); "On a phone" (the swipe's feel).
- `performance.md`: "Known faults with the rule on" (Safari's anchoring and Find, the scrollbar, the slide to the bottom).
- `models-and-agents.md`: a lesson with GPT-6.2 not reported yet; the research wrap-up with a real model.

## Not built

- Phase 7 of cloud sync (one automated test with two desktops and a server). `cloud-sync.md`, "After the merge"; `upstream.md`, "Not in the merge".
- A tablet layout; offline use. `phone-and-tablet.md`, "When it applies, and tablets" and "How it's built".
- The fork's own coding-questions plugin (a draft plan; spikes 1 to 3 done). `plans/own-coding-plugin-plan.md`.
- Phone layouts for Coding questions, the Drawing Pad, the theme picker and community plugins; syncing any other plugin's data, or which plugins are on. `upstream.md`, "Not in the merge".
- The performance audit's other recommendations (the owner wants only changes with zero behaviour impact). `performance.md`, "Not built (the audit's other recommendations)".
- In the notes drawer: renaming notes, embedding one note in another, keeping vault files out of the notes import into the graph. `notes.md`, "Design decisions".
- A faster hand-over of a session from an online PC. `cloud-sync.md`, "Seamless sessions", "Known limits".
- A swipe from the left edge to open the session list on a phone; the "Your thinking" box's extra 32 points (offered). `phone-and-tablet.md`, "Screens".
- A merge pass for a concept learned on two devices before they synced. `cloud-sync.md`, "Graph sync".
