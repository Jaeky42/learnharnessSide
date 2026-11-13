# LearnHarness — Side Tutor fork

This is a fork of amosblomqvist/learnharness. All fork work lives on the `side-tutor` branch and ships as a separate Windows app, "LearnHarness Side Tutor".

@AGENTS.md
@docs/side-tutor.md
@docs/cloud-sync.md
@docs/upstream-0.6.0.md

## Working here

- Follow AGENTS.md: investigate, ask about design decisions, and get the plan approved before implementing.
- After `npm ci`, run `npm run plugins:setup` (upstream 0.6.0's core plugins); the build and several tests need it.
- Tests: `npm test` (all), or `NODE_ENV=test npx tsx --test tests/<file>.test.ts`. Also `npm run typecheck` and `npm run lint`.
- **Every push to `side-tutor` publishes a release** that installed apps download automatically. Pushes that only change `CLAUDE.md` or `docs/` don't build.
- Cloud sync (a phone and a server alongside the desktop app) is built and merged into `side-tutor` (release 0.5.6): see `docs/cloud-sync.md`, especially "Handoff". The server's image is still built from its own branch; "After the merge" there says which branch changes what.
- Upstream 0.6.0 (plugins, themes, side conversations, chat format 2) is merged and shipped to `side-tutor` and to the server's branch (sync protocol 2; 3 with Flashcards sync, below): see `docs/upstream-0.6.0.md` for the owner's choices, what was added after the merge (the Tutor's morph, tablet touch rules, Chromium in the server image), and what is still open (plugin security, the fork's own coding questions plugin). Upstream's own workflows are deleted from the fork.
- **Next piece of work, not started:** the fork's own coding questions plugin (Python, JavaScript, SQL; code and tests run in the learner's browser, sealed). The draft plan is `docs/own-coding-plugin-plan.md`. It is not approved yet. Its first three spikes are done and passed, on the owner's iPad too (`docs/spikes/sealed-box/`): read both, run the two spikes left, ask the owner the open decisions one at a time, and build only after the owner approves.
- **Shipped, not yet confirmed by the owner:** Flashcards and Rich code blocks on a phone, and Flashcards sync between the PC and the server (sync protocol 3: both sides must be updated, the server first). The plan is `docs/phone-plugins-plan.md` (approved); what was built is in `docs/cloud-sync.md` ("Plugins on a phone" under "Phone layouts", and "Flashcards sync"), with the changes against the 0.6.0 merge in `docs/upstream-0.6.0.md`. The same commit is on `side-tutor` and on the server's branch (both fast-forwards, after both workflow dry runs passed and three passes of the sync review). The owner hasn't updated the server or the PC yet, and the owner's iPhone hasn't seen it. The owner has a "what to try" page (an Artifact page: the two backups, the server first, then the PC, then tick-lists for the iPhone). Things built beyond the plan's letter wait for the owner's review: "Built beyond the plan's letter" and "Rulings made while building" in `docs/cloud-sync.md`.
- **Shipped, tried by the owner on the iPhone:** a touch batch, all in the fork's phone and touch files (the same commit on `side-tutor` and on the server's branch, release 0.6.22; no file format and no sync protocol changed). The owner's verdict, part by part:
  - the Tutor's phone sheet swiping down to minimize: "works fine" ("On a phone: swipe down to minimize" in `docs/side-tutor.md`);
  - Cite and Ask after a press-and-hold selection: "work as intended", but too slow to come back after the selection is resized ("Highlight, then Ask" in `docs/side-tutor.md`);
  - a tap on the folded question while the lesson scrolls: it jittered before it pulled down;
  - the app's height gliding in step with the iPhone keyboard: the question box jiggled after the keyboard closed and the jerkiness it was meant to fix stayed; the owner asked for it to be reverted completely.
- **Built on `claude/upstream-0.6.0`, not shipped** (nothing of it is on `side-tutor` or the server's branch; it waits for the owner's word). The owner chose the behaviour of the first two on a test page run on the iPhone (an Artifact page with live benches) before they were built:
  - the keyboard glide is taken out; the keyboard is handled as before the touch batch ("Gliding in step with the keyboard: tried and taken out" in `docs/cloud-sync.md`). The jerkiness at the focus is still open; a new attempt needs a test page on the owner's iPhone first;
  - a tap on the folded question stops the lesson's own motion, glides to the bottom with the browser's smooth scroll, and the question opens on arrival ("A tap on the folded question ends at the bottom, open" in `docs/cloud-sync.md`). Touch screens only; it serves every way of opening a waiting question there;
  - Cite and Ask stay on screen and follow the selection while its handles are dragged ("Once shown, it follows the selection" in `docs/side-tutor.md`);
  - the phone's Settings list is shorter (owner's ask and plan): Obsidian sits inside Cloud, Flashcards' and Rich code blocks' pages open from their gear on Core plugins, and a plugin that can't be used on a phone reads "Disabled" ("A less cramped list: Obsidian inside Cloud" in `docs/cloud-sync.md`). Phone layout only.
  - Before shipping: both workflow dry runs on the final commit, then the same commit to both branches with the owner's word, and a new "what to try" page (the old one still describes the keyboard glide). Only the owner's iPhone can confirm the feel of the glide and of the following toolbar.
- Keep this file, `docs/side-tutor.md`, `docs/cloud-sync.md` and `docs/upstream-0.6.0.md` technical. The fork is public: no personal information.
