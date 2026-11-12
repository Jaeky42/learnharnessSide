# Plan: Flashcards and Rich code blocks on a phone, and Flashcards sync

**Status: approved by the owner ("Approved, build it"). Built on `claude/upstream-0.6.0` (packages A–E; "Where they stand" under "Work packages"); not shipped:** not pushed to `side-tutor` or to the server's branch (the branch contains `side-tutor`'s `a5d3284`, so shipping is a fast-forward of both), both workflow dry runs started and not yet in, the owner's iPhone hasn't seen it, and a second pass of the sync review, over its fixes, is under way. Per `AGENTS.md`, building is mechanical: anything this plan leaves open goes back to the owner. Change a decision here only with the owner's approval. What was built is recorded in `docs/cloud-sync.md`; see "What happened after approval" at the end.

## What the owner asked

"How do I get rich code blocks and flashcards working on my phone web app and browser?" The phone is an iPhone; "web app" is the home-screen app and "browser" is a Safari tab. Both get the phone layout (under 640 px, in a browser only; `docs/cloud-sync.md`, "Phone layouts"). While answering the plan's questions the owner added: **sync Flashcards between the Windows app and the server in this round.**

## The look (done)

Both plugins were un-hidden in a scratch copy and run at iPhone size with no layout work (Chromium as an iPhone 13, a Safari-tab and a home-screen set-up, a dark and a light theme, real touch). The owner got a page of the pictures.

**Already works:** the session-list entry; no screen scrolls the page sideways; no text box is under 16 px; a review and a practice run by touch from the first card to the last; every HostDialog box fits; the charts fit; both themes; the model picker; Rich code blocks draws all three notations.

**The big unknown is settled:** a plugin surface (`openSurface`, the review screen) had never run on a phone. It opens under the top bar and fills the rest of the screen, in both set-ups; a long card scrolls inside it and the window stays still.

**Needs work** (numbers in CSS px):

- The deck tree is 640 wide in a 368 box (`.fc-tree-inner { min-width: 40rem }`); checkboxes 14, disclosure arrows 14 × 20, row "Review" 58 × 24, menu rows 27 tall.
- Press and hold on a row opens nothing, and ends as a tap on the row.
- An inline rename can't be left without saving (Esc only). With the keyboard up the rename box and the edit box's Answer area sit below the visible part.
- Ratings wrap to 3 + 1 at 32 tall, with keyboard hints under them; on a long card they are below the fold; the only way out is a 28 × 28 ✕; a display formula is cut at the card's edge.
- The host's knowledge picker: 43 of 55 tap targets under 32, its header text cut.
- A wide TikZ diagram is cut at the edge with no sign that it scrolls; the source shows while a block compiles.
- Not checkable without the owner's iPhone: safe-area spacing, the real keyboard, Safari's bounce and swallowed taps, how long TikZ takes.

## The owner's decisions

### The phone

| # | About | Decision |
|---|---|---|
| 1 | How much of Flashcards | **Everything**, including making cards from the graph and from a file. |
| 2 | The way in | The session list's Flashcards entry, as on a computer. Nothing else. |
| 3 | Settings | The phone lists **Core plugins**, with all four plugins; the switches of **Coding questions and Drawing Pad are greyed out**, with **no explaining text**. **Flashcards and Rich code blocks** each get their own settings row (while switched on). **No Community plugins row.** No row for Drawing Pad's own settings. |
| 4a | Rating buttons | **Stacked**: four full-width buttons, one under the other. |
| 4b | Where they sit | **Pinned to the bottom** of the screen; the card is as tall as its text, in the middle of the space above; a longer card scrolls in that space. Reveal answer and Next sit in the same place. |
| 4c | Keyboard hints | **Hidden** in the phone layout. The keys still work with a keyboard connected. |
| 4d | The way out | The same ✕ in the same place, **finger-sized**. The count stays under the card. |
| 5a | Deck list | **Fits the screen**, finger-sized rows, **without the three number columns**. |
| 5b | Row menus | **Both**: the ⚙ stays, and press and hold on a row opens the same menu. |
| 5c | Renaming a deck | A **small ✕** in the rename box cancels and keeps the old name. |
| 6 | Statistics charts | **Shown**, as they are. |
| 7 | A drawing wider than the screen | **Shrinks to fit, with a button to enlarge.** The enlarge button is on **all three kinds** of drawing (technical diagrams, molecules, scores). |
| 8 | While a block is drawn | **A box with a spinner**, no words, in place of the source. |
| 9 | Decks made in the Windows app | **Sync Flashcards now** (below). |
| 10 | New sentences | None: every choice above is wordless. |
| 11 | Stays as it is | Drawing Pad hidden, Coding questions parked, community plugins' ways in hidden. |

### Flashcards sync

| # | About | Decision |
|---|---|---|
| S1 | How | **Combine everything.** Every change travels on its own; every review from both devices is kept; each fact's schedule is worked out again from all its reviews. No lease, no Take over. |
| S2 | Time zone | **The server follows the PC**: the Windows app tells the server its time zone with a sync, and the server program uses it from then on. |
| S3 | The first sync | **Combine both libraries.** Nothing is deleted. A fresh backup on each side first. |
| S4 | Two decks from the same session | **Joined into one deck.** |
| S5 | Edited on one device, deleted on the other | **A delete always wins.** |
| S6 | Settings | The four scheduling settings and the **generation chunk budget sync**; the model choice stays per device. |

## Smaller rules (proposed here; approved with this plan)

### The phone

- **Phone only, browser only.** Every rule applies under 640 px in a browser. The computer layout, tablets and the desktop app don't change, also for decisions 7 and 8.
- **Sizes:** everything tapped on these screens gets a touch area of at least 40 px: checkboxes, arrows, Review, +, ⚙, menu rows, switches, the ✕ of boxes and of the review.
- **The review:** the pinned buttons keep clear of the home bar (`env(safe-area-inset-bottom)`). A formula wider than the card scrolls sideways inside the card. The end states ("No cards due in this selection.", "Practice complete.") are unchanged.
- **Press and hold** (about half a second, as sessions and notes) opens the row's own ⚙ menu, and the lift of the finger doesn't also open the card. Rows aren't dragged; order stays "Move up / Move down" in the menu.
- **The rename ✕** is fork code that sends the box its own Esc, so the plugin's file isn't edited for it. Its hidden label, for screen readers, is "Cancel" (for the owner to review).
- **The keyboard:** a focused box (rename, a card's question or answer, search, a settings field) is scrolled into the visible part.
- **The knowledge picker** (the host's shared screen) gets finger-sized rows and checkboxes and an uncut header, on a phone only. It still covers the whole screen and closes with its ✕ or Done.
- **Enlarging a drawing** opens the lesson's existing diagram viewer (drag, pinch, − / +). The button is the lesson's own, with upstream's label "Expand diagram".
- **A drawing that fails** shows what it shows today.
- **Settings rows on a phone**, after Account: Core plugins, then Flashcards and Rich code blocks (each only while its plugin is on). A greyed switch shows whether the plugin is on and can't be changed. On the Core plugins page Drawing Pad's ⚙ is hidden; the ⚙ beside the "Flashcards" title opens its settings.
- **Other plugins' pages** opened on a phone still read "Open this on a computer."

### Flashcards sync

- **What travels:** decks (name, daily new-card limit, order), facts and their cards (question, answer, order), which deck each fact is in, every review, the four scheduling settings and the chunk budget, and the record of each uploaded file (its name and fingerprint, so the same file doesn't become a second deck).
- **What stays per device:** the model and thinking choice, running generations and their retry, the text of uploaded files, the cost log.
- **Schedules never travel.** After every sync each device rebuilds each fact's schedule from the combined reviews, in the order they were made, with the plugin's own scheduler and the settings each review recorded.
- **The same card reviewed on both devices while apart:** both reviews count. That day's new-card limit can be passed.
- **A delete always wins** for a card. A deck that still has cards after combining stays; a card is never left without a deck. A fact deleted and later made again starts fresh: its old reviews don't count.
- **The same question, word for word, twice on one fact:** one is kept (the plugin's own rule when it generates).
- **Order** (decks, facts in a deck, cards of a fact) changed on both devices: the later change wins; anything the later order doesn't know is added at the end.
- **Settings:** latest change wins; at the first sync the first PC's values are kept, as with the app's other synced settings.
- **Time zone:** the PC sends its zone when it changes; the server applies it at once and at every start. With two PCs in different zones the most recently changed one counts.
- **Timing:** a Flashcards change is sent about 2 seconds later, like every other change; an open Flashcards page refreshes when cards arrive.
- **A device where Flashcards is switched off** still receives the data, so it is there when the plugin is switched on.
- **A generation under way** finishes on its device; its cards travel once they are added.
- **A backup** of Flashcards' folder is made on each side right before its first Flashcards sync, beside the existing backups. If it can't be made, Flashcards sync doesn't start.
- **Sync protocol 3.** The server and the Windows app must both be updated, server first; until both are, all sync pauses and nothing is discarded. A second lock: a side neither sends nor takes a Flashcards file in a newer format than it reads (no message on screen).
- **An app that isn't paired** does nothing new.
- **One edit to the plugin's own code:** `plugins/flashcards/src/store.cjs` re-reads its file when it changed on disk (about ten lines). Listed under "At the next upstream release".
- **Known limits:** a concept that is two graph nodes (learned separately on both devices before they synced) is two facts; a server that lost its sync records can bring deleted cards back.

## Work packages

One worker per package, each owning its files, each in its own worktree. Workers never decide wording or behaviour: anything undecided comes back under "Open questions" and goes to the owner.

**Where they stand:**

- **A–E: done**, built on `claude/upstream-0.6.0`.
- **F: done**: a fresh reviewer read the phone diff, and its findings are fixed. The sync part was reviewed too: six serious findings and lower ones, all fixed. A second pass by the same reviewer, over the fixes, is under way.
- **G:** done: the tests, typecheck and lint, the browser run at iPhone size with every screen shot again, Flashcards with the stand-in provider, the computer comparison, the run between two built copies, and the docs (`docs/cloud-sync.md`, `docs/upstream-0.6.0.md`, `CLAUDE.md`). Both workflow dry runs are started and not yet in. Still to come: the "what to try on your iPhone" page.

| # | Package | Owns | After |
|---|---|---|---|
| A | **The gate and Settings.** Phone-ready plugins listed in `phone-plugins.ts`; only Flashcards' session-list entry shown; `PhonePluginPage` lets phone-ready pages through; the Settings rows and the greyed switches of decision 3. `tests/phone-plugins-ui.test.tsx` rewritten to the new rule, every other plugin still hidden. | `components/phone/phone-plugins.ts`, `phone-plugin-page.tsx`, the plugin block of `app/phone.css`, the phone lines of `components/settings/settings-dialog.tsx` and of the plugins section | — |
| B | **Flashcards on a phone.** The review and practice surface (4a–4d), the deck list (5a–5c), boxes, the keyboard rule, the knowledge picker, finger sizes. A test that renders the plugin at phone size and fails when upstream's class names change. | a new `app/phone-flashcards.css` (same phone-only, browser-only rule and test as `phone.css`), `components/phone/` helpers for hold and the rename ✕ | A |
| C | **Rich code blocks on a phone.** Shrink to fit, the enlarge button on all three kinds, the spinner box. | a new `app/phone-rich-code-blocks.css`, a small fork component for the enlarge button and the spinner, the smallest hook in the plugin or the host's code-block mount | A |
| D | **Sync, the rules.** Pure code: the items, combining, delete-wins, joining twin decks, rebuilding schedules by replay with the plugin's own scheduler. Tests against the plugin's scheduler and fixtures. | `src/core/sync/flashcards*.ts`, its tests | — |
| E | **Sync, the wiring.** The store's re-read; reading and writing the library through the exchange; its own route and state; the round and the 2-second trigger; protocol 3 and the format lock; the backup; the time zone; the do-nothing test; a run between two built copies. | `src/server/sync/flashcards*.ts`, `app/api/sync/flashcards`, small additions in `round.ts`, `loop.ts`, `protocol.ts`, `backup.ts`, `instrumentation.ts`, `plugins/flashcards/src/store.cjs`, the workflows' test lists | D |
| F | **A fresh reviewer** (the diff and "Phone layouts" only): computer layout and desktop app unchanged; every phone rule phone-only and browser-only; edits to upstream's files minimal and listed; no earlier phone behaviour lost; an unpaired app inert. | reads and reports | A–E |
| G | **Checks and docs.** Below. | docs | all |

## Checks

- `npm test` (leave `tests/safe-fetch.test.ts` out in the development sandbox), `npm run typecheck`, `npm run lint`.
- **A real browser at phone size**, in server mode, with the look's harness: iPhone 13, real touch, the keyboard stand-in, the home-screen set-up, a dark and a light theme. Before-and-after pictures of every screen of the look.
- **Flashcards without a real model:** the stand-in provider.
- **The computer must not change:** screenshots at 1280 and 700 px and a dump of every element's position and size, before and after.
- **Sync:** the pure rules; the replay equal to the plugin's own schedule on single-device histories; two built copies with the loop on: a first sync with libraries on both sides, reviews on both while apart, a delete against an edit, twin decks, a generation during a round, the time zone, an idle pair writing nothing, an unpaired app doing nothing.
- Both workflows as dry runs before asking to ship.
- **Only the owner's iPhone shows** safe areas, the real keyboard, Safari's bounce and swallowed taps, and TikZ's time. A "what to try on your iPhone" page ends the round; expect a second round from it.

## Shipping

- The same commit to the server's branch and to `side-tutor`, each with the owner's approval, the server's first, after both dry runs. **Protocol 3:** the steps of "Updating the server and the PC together" in `docs/upstream-0.6.0.md` apply again.
- Update `docs/cloud-sync.md` ("Phone layouts", and a Flashcards part under the sync engine), `docs/upstream-0.6.0.md` (decisions 10 and 17, "Not in this merge", "At the next upstream release") and `CLAUDE.md`.

## Risks

- Restyling a plugin from the fork's CSS ties the fork to upstream's class names; the phone-size render test is the guard.
- The rebuilt schedule must equal what the plugin itself would have set; a mismatch would move due dates at the first sync. The replay test and the backup stand in the way.
- The server taking the PC's time zone changes the zone of the whole server program. Its nightly update timer is the system's and isn't affected.
- Generating cards costs money on that device's model. The preview box stays in the way of a mistaken tap.
- TikZ on a real iPhone: time and download size are unknown.

## Not in this plan

- Phone layouts for Coding questions, Drawing Pad, the theme picker and community plugins.
- Syncing any other plugin's data, or which plugins are switched on.
- The iPhone status bar on light themes (still open from the 0.6.0 merge).
- The fork's own coding questions plugin: `docs/own-coding-plugin-plan.md`.

## What happened after approval

The plan above is kept as approved. Where the building went beyond its letter, or a question came back, it is recorded here and in the built docs.

### The owner's later answers

Three answers given after the plan was approved:

- **The full-screen viewer opens a drawing fitted**, as the lesson's other diagrams ("Fitted, as others do"). Nothing in the viewer changed for it.
- **The spinner shows from the first paint** while Rich code blocks is on ("Spinner from the start"). A kind switched off in the plugin's settings spins for the first moments, then turns into plain code once the plugin has started.
- **The knowledge picker hides its Props and Created columns on a phone** ("Hide both on a phone").

### Reviews, and what the runs found

- **Package F, the phone part:** a fresh reviewer read the phone diff and found two real bugs (the rename box stuck open after a hold on, or a slide off, its ✕; a hold inside the rename box opening the menu and saving) and smaller items. All are fixed.
- **The sync part:** the reviewer found six serious issues, each reproduced by a script, and all were fixed before anything shipped: a first-sync backup put back deleted cards everywhere; a fact deleted and generated again before a device's first sync was rebuilt from its old reviews; a library that can't be read made the PC download everything and the server back up every round; seconds-long stalls of the server with a 25 MB library; the server timed its own changes when a PC next asked; two PCs whose first exchanges overlapped were both "first". Lower ones were fixed too. The fixes and three rulings made with them (for the owner's review) are in "Flashcards sync" in `docs/cloud-sync.md`. A second pass by the same reviewer, over the fixes, is under way.
- **Found in the run between two built copies:** a review the server made while it still ran in the zone it was started with kept that zone's due date there, while the PC worked it out in its own zone. Now each side works every schedule out again when the zone changes (a ruling for the owner's review; "Flashcards sync" in `docs/cloud-sync.md`).

### Where the built facts live

- **The phone:** `docs/cloud-sync.md`, "Phone layouts" → "Plugins on a phone": what was built for each decision, the code, the tests, what was checked, what only the iPhone can show, and the list built beyond this plan's letter for the owner to review.
- **Flashcards sync:** `docs/cloud-sync.md`, "Flashcards sync": the decisions S1–S6, the rulings made while building (for the owner to review), the items, the replay, the wiring, the review and its fixes, protocol 3, known limits, tests and the run between two copies.
- **What changed against the 0.6.0 merge** (decisions 10 and 17, "Not in this merge", the upstream files edited, the update steps for protocol 3): `docs/upstream-0.6.0.md`.
