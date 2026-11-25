# History and records: Upstream in the fork: the 0.6.0 and 0.7.0 merges, decisions, what was built, and the fork's edits to upstream files

## The 0.6.0 merge: how it was checked

- **Tests, typecheck, lint.** In the development sandbox every test passes except the four that fail there on untouched upstream too ("Known test failures in the development sandbox" in `docs/fork/development.md`).
- **The update, rehearsed with built copies** (the pre-merge fork built from its last commit, and this branch):
  1. old PC and old server, paired, two sessions and an old Tutor conversation file synced;
  2. **the server updated first:** the old PC reads "Update LearnHarness to continue syncing" and shows SYNC PAUSED; nothing changes on either side; the server's site works and shows the PC's sessions as held; the old Tutor files are gone from the server;
  3. **the PC updated too:** sync is back by itself, no discard notice, both session files still byte for byte what they were, the old Tutor files gone from the PC.
- **Between the two updated copies**, nobody pressing Sync now: a theme chosen on the server reached the PC in 4 s (the PC's model slots untouched); a custom theme imported on the PC reached the server at the next 10-second round, identical; a session with a picture inside a message was identical on both sides 2.5 s after the change; a hand-over from the online PC took 10 s; on the held session the PC showed the strip, the greyed bubble and greyed Cite and Ask, and the server refused a rename and a side question (409).
- **A Tutor answer during a hand-over**, with a slow stand-in model on the PC: the server's request read "handing over", then "finishing a reply", and the session moved when the answer ended, with the whole answer on both sides.
- **A real browser**, computer and iPhone size, dark and light theme: the Tutor (one scroll, highlight then Ask, a refusal coming back into the box, practice), Settings, the notes drawer, a plugin page on a phone.
- **A fresh reviewer** read the finished diff against the pre-merge docs for lost fork behaviour and found none. Its two findings are fixed: the Tutor's answers and the sync loop ("Sync (protocol 2)" in `docs/fork/upstream.md`), and the home screen's topic box, which sent on Enter on a touch phone although the phone's Enter rule names it (it was so before the merge too; it uses `enterSends` now).
- **The Windows workflow as a dry run** on this branch, and the server image workflow the same way (both publish only on a push).

## The 0.7.0 merge: how it went

- **Branch and commits** (all on `claude/upstream-0.6.0`, not pushed or shipped when this was written; the first is the merge, the rest are the fork's fixes on top, in order):
  1. `10443d2c` Merge upstream v0.7.0 (tag commit `0292b85b`).
  2. `2661e18a` GPT-6.2 stays in the ChatGPT model list.
  3. `653f7def` Off-screen rule: the newest turn is always drawn.
  4. `e6c9418b` Startup announcements are off in this app.
  5. `401b5279` Phone: Appearance shows only Compact session list of the three new rows.
  6. `25ef42dc` Touch: press and hold opens a session folder's menu.
  7. `c89defec` Folder delete fits sync: a named deletion, and sessions move here first.
  8. `ec2e2afd` Folder delete: refused while offline, and three review fixes.
- **The investigation:** five read-only workers looked at what upstream changed (159 commits since v0.6.0: 43 up to v0.6.1, 116 more; 252 files) against the fork's edits, before the merge was committed. The owner was then asked one question per decision ("The owner's decisions at the 0.7.0 merge" in `docs/fork/upstream.md`), the plan was approved ("yes i approve") and the build began at the owner's word ("build it on claude/upstream-0.6.0").
- **The trial merge** had 20 conflicted files; each kept both sides (37 files had been changed on both sides). Two conflicts forced owner decisions: the researcher's limit and the Claude Code Fable entry (decisions 2 and 7).
- **Hazards found before merging** (each would have gone unnoticed by the existing tests):
  - **GPT-6.2 would have vanished from the ChatGPT list.** Upstream 0.7.0 builds that list from the library's bundled OpenAI catalog alone (`getBuiltinModels`), bypassing the provider wrapper that added the two models. Fixed in `2661e18a`; a test now runs the real `refreshConnectionCatalog("chatgpt")`.
  - **The folder delete was unlogged.** `deleteFolderWithSessions` deleted the sessions' traces with no record of what was done, so the graph log would have carried the generic `rewrite` entries (the net nothing in the app produces). Fixed in `c89defec`: it is the named `delete-sources` entry every device repeats.
  - **A held session refused the folder delete.** The server refuses the whole delete when a session in the folder is held elsewhere, with the retired "Take it over" sentence. Fixed in `c89defec` and `ec2e2afd`: the sessions move here first.
- **What the merge commit says it did not do** (the later commits did, in order above): GPT-6.2, the folder delete and sync, the off-screen rule's exemption, startup announcements off, the phone's Appearance rows, press and hold on folders, and the docs. It also loaded upstream's saved model catalog in `instrumentation.ts` in its own `try`, listed the two new browser-storage keys as view state, and made the phone rule tolerate a navigator with no `userAgent`.
- **Test record of the merge commit:** typecheck and lint pass. 533 test files were run one at a time, `tests/safe-fetch.test.ts` left out as always in the sandbox: 7,349 tests pass, and the 4 failures are the known sandbox ones ("Known test failures in the development sandbox" in `docs/fork/development.md`).
- **Tests of the fix commits** (named in their messages; not re-run for this record):
  - `2661e18a`: `tests/extra-models.test.ts` (both GPT-6.2 ids once, no overlay-only id; an overlay row with a GPT-6.2 id once);
  - `653f7def`: `tests/offscreen-rule.test.ts` (every selector requires the attribute, the two specificity orders, a pin on upstream's attribute name in `components/chat.tsx` and `app/globals.css`) and `tests/offscreen-target.test.ts` (a jump into the newest turn). No browser run yet;
  - `e6c9418b`: `tests/startup-messages-off.test.ts`;
  - `401b5279`: `tests/appearance-phone.test.tsx`;
  - `25ef42dc`: `tests/touch-folders.test.tsx` (the real rows and `long-press.ts` with scripted touches);
  - `c89defec`, `ec2e2afd`: `tests/sync-folder-delete.test.ts` (both modes; both sides end with the same session files, folders and graph ledgers; a `delete-sources` entry and no `rewrite`; the route refuses a held session and deletes nothing) and `tests/folder-delete-ui.test.tsx` (named in `c89defec`; `ec2e2afd` added eight cases: the offline refusal, an all-local offline delete, no raised flag, the net's failure). Upstream's own folder-delete tests pass unchanged.
- **The independent review of the folder delete** (an Opus reviewer, read-only): the online path sound. Three fixes came from it (`ec2e2afd`): a failed move from the folder's box no longer raises the session's "move failed" flag, which left "This session couldn't be continued here." waiting in those lessons; `fetchHere`'s net answers the approved sentence when its move fails, where it used to return the server's retired "held by another device" text; and the offline refusal asks the server before moving anything, because a take-over that can't reach the server marks the session this PC's (`carryOn`), and the next Try again would then have deleted it. Limits it named that stay: "Rulings, limits and open items at the 0.7.0 merge" in `docs/fork/upstream.md`.
- **Not run, as of this record:** a browser (the check waiting behind Open on a wide screen, the off-screen rule with the newest turn drawn, the folder menus, the Appearance rows, the delete box), the packaged Windows app, a desktop as the deleting side through the real route, the real server, and the owner's devices. A second full independent test run was under way; its result is not recorded here.

