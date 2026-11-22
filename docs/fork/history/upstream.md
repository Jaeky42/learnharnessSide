# History and records: Upstream 0.6.0 in the fork: decisions, what was built, and the fork's edits to upstream files

## How it was checked

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
