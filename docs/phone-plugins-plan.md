# Plan: Rich code blocks and Flashcards on a phone

**Status: a draft for the owner to approve. Nothing is built.** Written at the end of the upstream 0.6.0 session for the next session, which is led by one orchestrator with worker agents; the owner names the models when starting it. Per `AGENTS.md`: investigate, ask the owner the open decisions one at a time, get this plan approved (changed where the owner says), and only then build.

## What the owner asked

"How do I get rich code blocks and flashcards working on my phone web app and browser?" The phone is an iPhone; "web app" is the home-screen app and "browser" is a Safari tab. Both get the phone layout (under 640 px, in a browser only; `docs/cloud-sync.md`, "Phone layouts").

## Where it stands today

Checked in the running app at phone size (Chromium set up as an iPhone 13), with every core plugin switched on in the data folder.

**Rich code blocks already draws on a phone.** A `smiles` molecule, an `abc` score and a `tikz` diagram all drew inside the lesson's width (342 px of a 390 px screen), with no sideways scroll of the page. The TikZ diagram shows its source for about 4 seconds while it compiles, then the picture.

- **The catch is switching it on.** Under 640 px Settings lists no plugin rows: not Core plugins, and not the plugin's own page with its three switches (chemical structures, musical notation, technical diagrams; all off until switched on).
- **But the server is one device.** Plugin on/off and plugin settings live in the server's data folder, and the phone uses the server. So switching the plugin and its three families on from a computer or an iPad, on the server's site, makes the phone draw them. **No code is needed for that**, and it is what the owner has been told to do now.
- Not checked: a real iPhone, how long TikZ takes there, and how much it downloads (the built plugin is 9.5 MB, mostly the TeX engine and fonts, and plugin files are served `no-store`).

**Flashcards is hidden on a phone, by the owner's earlier decision** (decision 10 in `docs/upstream-0.6.0.md`: "Under 640 px no plugin is offered… Phone layouts for Flashcards, Coding questions, Rich code blocks, the theme picker and plugin settings pages are a later round"). This plan is that round, for two of them.

- Its entry in the session list is hidden (`app/phone.css`).
- Its page, `/plugins/flashcards/library`, shows "Open this on a computer." (`components/phone/phone-plugin-page.tsx`).
- Its Settings page is not listed.

**Decks are per device** (decision 17). The phone shows the server's decks: the ones made on the server's site from any browser. Decks made in the Windows app stay in the Windows app. Syncing Flashcards is a later phase and not in this plan unless the owner asks.

## Facts to build on

Read from the code on the shipped commit.

**The phone rules for plugins** (all fork-owned):

- `components/phone/phone-plugins.ts`: the rules and the owner's wording.
- `app/phone.css`, the "Plugins" block: hides `[data-testid="plugin-top-bar-actions"]`, `[data-testid="plugin-graph-actions"]` and `[data-testid="sidebar-actions"] > [data-plugin-action]`, and keeps Teaching and Practice stacked. Each entry carries `data-plugin-action="<key>"` (`components/plugin-chrome.tsx`), so one plugin's entry can be shown without the others.
- `components/phone/phone-plugin-page.tsx`, used by `app/plugins/[pluginId]/[viewId]/page.tsx`: replaces every plugin page.
- `components/settings/settings-dialog.tsx`: `isPluginSettingsSection` drops `core-plugins`, `plugins` and every `plugin:<id>` row on a phone, and a link to one lands on the list.
- `components/phone/parked-plugin-question.tsx`: plugin questions and problems. Not touched by this plan (neither plugin poses questions).
- Every rule in `app/phone.css` must sit inside `@media (max-width: 639.98px)` and under `html:not(.lh-electron)`; `tests/phone-layout.test.ts` enforces it. The rules are unlayered.
- Tests that pin today's hidden state and must change with the decisions: `tests/phone-plugins-ui.test.tsx`.

**Flashcards** (`plugins/flashcards/src/`, upstream's files, plain JavaScript, about 2,300 lines):

- `main.js` registers one view (`library`, the page), one action (`open`, the session-list entry), a Settings page, and listens for changes.
- The page (`mountLibrary`) is a toolbar (generate from the graph with the host's knowledge picker, "Generate from file…", search, delete selected), the deck tree (`library-tree.js`) and the statistics charts (`dashboard.js`).
- Boxes are the host's HostDialog (`ctx.ui.openDialog`), already sized to the phone's visible height. Row actions open the host's menu (`ctx.ui.openMenu`). Renaming is an inline text box (Enter commits, Esc cancels).
- **Review and practice open as a plugin surface** (`ctx.ui.openSurface`, dimmed background; `review.js`): the card, "Reveal answer", then Again / Hard / Good / Easy. Each button shows a keyboard hint (Space, and so on) and a `keydown` handler on the surface takes the keys. The buttons also work by click.
- Settings (`mountSettings`): the host's settings rows, model picker and thinking picker.
- **Its CSS already thinks about narrow screens a little** (`styles.css`): one `@media (max-width: 600px)` rule (smaller paddings), the review card keeps 16:9 by container width, long text wraps. What will not fit as it is: the tree's `min-width: 40rem` (it scrolls sideways), the charts' `min-width: 20rem`.
- **No plugin surface has ever been shown on a phone**: the Drawing Pad is the only other one and it is hidden. How a surface sits with the phone's top bar, the safe areas, the keyboard and the window lock is unknown.
- Also never shown on a phone: the knowledge picker, a plugin's Settings page, the plugin management page.
- Generating uses the device's model set-up (the server's) and costs money; the box shows a cost preview first.
- Its back end (`backend.cjs`, `store.cjs`, `scheduler.cjs`) needs no change for a phone.

**Rich code blocks** (`plugins/rich-code-blocks/src/`, upstream's):

- Renders code fences through `ctx.registerCodeBlock`, one renderer per switched-on family. Nothing in it asks about the screen.
- `styles.css`: a rendered block is `overflow: auto` with the picture at `max-width: 100%`, except TikZ, which keeps its natural size and scrolls sideways in its own box "rather than shrinking their text".
- TikZ compiles in a worker in the browser (`tex-runner.ts`: one job at a time, a 10-second limit).

**Where changes should live.** `plugins/**` is upstream's code: every edit there has to be carried by hand at each upstream release. Prefer fork-owned files (`app/phone.css`, `components/phone/**`) and small hooks. Plugin CSS is injected into the page, so a `phone.css` rule can restyle `.fc-root …`; check which rule wins before relying on it. Where an edit to a plugin's own file is unavoidable, keep it small and list it under "At the next upstream release" in `docs/upstream-0.6.0.md`.

**Touch rules that already exist** and apply to whatever is un-hidden (`docs/cloud-sync.md`): the Enter rule on a touch phone (`components/phone/enter-key.ts`), 16 px text boxes, press and hold for row menus (`data-phone-press`), hover-only controls always shown (`app/touch.css`), menus clamped to the screen, the window lock, `--lh-vvh` for the keyboard. Plugin widgets have not been checked against any of them.

**Not affected:** cloud sync (no protocol change; plugin data is per device), held sessions (Flashcards is not a session), the desktop app (it never gets the phone layout), tablets (they have the computer layout, where both plugins already work).

## First step: look before asking

Before the owner is asked anything, the orchestrator un-hides both plugins **in a scratch copy only** and takes phone-size screenshots of every Flashcards screen as it is with no layout work: the session-list entry, the page with decks and charts, the generate box with the knowledge picker, the cost preview, a card's edit box, a row's menu, a review from "Reveal answer" through the four ratings, practice, the Settings page, and Settings → Core plugins. Dark and light theme, Safari-tab and home-screen set-ups. Then one page for the owner: what already works, what is broken, with the pictures. The decisions below are asked from that page.

## Decisions to ask the owner (one per question, with pictures)

1. **How much of Flashcards on a phone:** reviewing only; reviewing and browsing decks; or everything (generating, editing, deleting, files).
2. **Where the way in is:** the session list's entry as on a computer, or somewhere else.
3. **Switching plugins on from a phone:** show Settings → Core plugins and the two plugins' own pages on a phone, or keep that for a computer (as today).
4. **The review screen:** how the four rating buttons sit (one row, or two by two), whether the keyboard hints are hidden on touch, the card's size, what the top of the screen shows. Mock-ups of each.
5. **The deck list:** sideways scroll as it is, or a narrower layout; row actions by a visible button or by press and hold, as sessions and notes do.
6. **The statistics charts:** shown (they need a narrower drawing), or left out on a phone.
7. **Wide TikZ diagrams:** scroll sideways in their own box (today), shrink to fit, or tap to enlarge like the lesson's other diagrams.
8. **While TikZ compiles:** the source text (today), or something quieter.
9. **Decks made in the Windows app don't show on the phone.** Accept for now, or add syncing Flashcards to this round (a much larger piece of work: plugin data has never synced).
10. **Every new sentence** on a phone screen (prompt and screen wording is the owner's).
11. Confirm: Drawing Pad stays hidden on a phone, Coding questions stays parked, community plugins stay hidden.

## Work packages (after the look, the answers and the approval)

One agent per package, each owning its own files. Agents never decide wording or behaviour: anything undecided goes into their report under "Open questions", and the orchestrator asks the owner.

| # | Package | Owns | Depends on |
|---|---|---|---|
| A | **The gate.** A list of phone-ready plugins in `phone-plugins.ts`; the session-list entry shown for those only; `PhonePluginPage` lets their pages through; Settings rows per decision 3. Tests in `tests/phone-plugins-ui.test.tsx` rewritten to the new rule, with every other plugin still hidden. | `components/phone/phone-plugins.ts`, `phone-plugin-page.tsx`, the plugin block of `app/phone.css`, the phone lines of `settings-dialog.tsx` | decisions 1, 2, 3, 11 |
| B | **A plugin surface on a phone.** How `openSurface` sits under the phone's top bar, with the safe areas, the home-screen app's top inset (`--lh-safe-top`), the keyboard and the window lock; closing it without a keyboard. | the surface's phone rules in `app/phone.css`, small hooks in `components/plugin-surfaces.tsx` if needed | A |
| C | **Flashcards review and practice.** The card, Reveal, the four ratings, hints, progress, the end of a session, per decision 4. Real touch. | Flashcards' review rules in `app/phone.css` | B, decision 4 |
| D | **Flashcards library.** The toolbar, the deck tree, row actions, boxes, the knowledge picker, file generation, the charts, per decisions 1, 5, 6. The Enter rule and 16 px text in its text boxes. | Flashcards' library rules in `app/phone.css`; the host widgets' phone rules | A, decisions 1, 5, 6 |
| E | **Rich code blocks.** Decisions 7 and 8; its Settings page if decision 3 shows it. | its rules in `app/phone.css` | decisions 3, 7, 8 |
| F | **A fresh reviewer** (given the diff and `docs/cloud-sync.md`'s "Phone layouts" only): the computer layout and the desktop app unchanged; every `phone.css` rule phone-only and browser-only; edits to upstream files minimal and listed; nothing of the fork's earlier phone behaviour lost. | nothing (read and report) | A–E |
| G | **Checks and docs.** Below. | docs, the workflows' test lists | all |

## Checks

- `npm test` (leave `tests/safe-fetch.test.ts` out in the development sandbox; see "Development notes" in `docs/upstream-0.6.0.md`), `npm run typecheck`, `npm run lint`.
- **A real browser at phone size**, in server mode: Playwright `devices["iPhone 13"]`, real touch through CDP `Input.dispatchTouchEvent`, the keyboard by a stand-in `visualViewport`, the home-screen app by overriding `navigator.standalone` ("Testing these without an iPhone" in `docs/cloud-sync.md`). Dark and a light theme.
- **Flashcards without a real model:** the stand-in provider described in `docs/own-coding-plugin-plan.md` ("How to check it without a real model"). For generation the worker must answer with the tool `submit_result` and `{ result: { propositions: [{ propositionId, cards: [{ question, answer }] }] } }`, one entry per target proposition of the request. Model slots need `thinkingLevel: "off"`.
- **A lesson with all three notations** for Rich code blocks: a chat record whose assistant message holds a `smiles`, an `abc` and a `tikz` fence, with the plugin's `settings.json` (`core-plugin-data/rich-code-blocks/`) switching the three families on.
- **The computer must not change:** screenshots at 1280 and 700 px wide and a dump of every element's position and size, before and after, as in Phase 3 of cloud sync.
- **Only the owner's iPhone shows** Safari's rubber band, its top blur, swallowed taps and the keyboard's pan. End with a "what to try on your iPhone" page; expect a second round from what it finds.
- Both workflows as dry runs before asking to ship.

## Shipping

- The same commit to the server's branch and to `side-tutor`, each with the owner's approval, after the dry runs. The phone only uses the server, but the two branches are kept at the same commit.
- No sync protocol change.
- Update `docs/cloud-sync.md` ("Phone layouts"), `docs/upstream-0.6.0.md` (decision 10 and "Not in this merge") and `CLAUDE.md`.

## Risks

- A plugin surface has never run on a phone; the review screen depends on it.
- The host's knowledge picker and model picker may need phone work of their own, which is upstream's code.
- Restyling a plugin from `phone.css` ties the fork to upstream's class names; an upstream release can break it silently. A test that renders the plugin at phone size is the guard.
- TikZ on a real iPhone: time and download size are unknown.
- Generating cards costs money on the server's model; a mistaken tap on a phone should not start it. The cost preview already stands in the way; keep it.

## Not in this plan

- Syncing Flashcards between the Windows app and the server (unless decision 9 adds it).
- Phone layouts for Coding questions, the theme picker, and community plugins.
- The iPhone status bar on light themes (still open from the 0.6.0 merge).
- The fork's own coding questions plugin: `docs/own-coding-plugin-plan.md`.
