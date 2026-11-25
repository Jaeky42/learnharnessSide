# Ship log: what went to which branch, and when

Each round's ship record: which branches it went to, from which commit, the release it made, the way back, and what the owner said. The entries are kept as they were written at the time, in the order the rounds shipped (oldest first); a block taken from one of the old docs says which, so its "this file", "above" and "below" refer to that old file. An entry may describe a state that a later entry changed (a round reverted, a status later confirmed): the current state is `docs/fork/status.md`.

## The log

### The cloud sync merge (release 0.5.6)

*From the old `docs/cloud-sync.md`, its opening status line:*

Status: **Phases 1–4 done (server mode, sign-in on the server, phone layouts, the Obsidian vault on the server). Phase 5 (the sync engine) is built, all six slices: a paired desktop and the server keep sessions, the graph, settings and folders in step. Phase 6 (the screens) is built, all three slices: Settings → Cloud on the desktop app (pairing, sync state, Unpair) and on the server's site (paired desktop apps, pairing codes); a held session ("Held by …", the strip, Take over, the warning box, greyed controls); and the desktop's own notices (the sync chip, the offline heads-up, the discard box). It has run between two built copies only; the owner's real PC meets the real server after the merge.** **Merged into `side-tutor` with the owner's approval, and released to the desktop app as 0.5.6.** The owner then updated the server, followed the pairing guide and reported: "everything works!". Change these decisions only with the owner's approval.

*From the old `docs/cloud-sync.md`, "After the merge (read this first)":*

- **Merged:** `side-tutor` was fast-forwarded to the cloud sync branch at `a2d2b7e` with the owner's word ("merge"), and the Windows workflow published **release 0.5.6** from it. The desktop app now has everything in this file and in `docs/fork/side-tutor.md`.
- **Checked on Windows before it went out:** the Windows workflow was started by hand on the cloud sync branch (a dry run: no release) and passed, with the sync and cloud tests added to it. Before that the sync code had only run on Linux.
- **Confirmed by the owner on the real PC and the real server:** after release 0.5.6 they updated the server, followed the pairing guide (an Artifact page) and reported "everything works!". They didn't say which screens they tried, so a take-over, the offline chip and the discard box may still be unseen on real devices. If they report a problem later, ask what the screen shows and what Settings → Cloud reads on the PC; never ask for a pairing code, a password or the server's address.

### The upstream 0.6.0 merge (release 0.6.14)

*From the old `docs/cloud-sync.md`, "After the merge (read this first)":*

- **Upstream 0.6.0 is merged and shipped** to both branches, at the same commit. It raises the sync protocol to 2, so the server and the desktop app must both be updated or sync pauses (nothing is discarded while paused). What changed in sync, the gate, the phone layout and the screens is in `docs/fork/upstream.md`. Where this file and that one differ, that one is newer.

*From the old `docs/upstream-0.6.0.md`, its opening state:*

**State:** shipped. With the owner's word ("ready, do both"), the same commit was pushed to `claude/pensive-goldberg-7dty2m` (the server's image `:dev`) and to `side-tutor` (the Windows release), both plain fast-forwards. Both dry runs had passed on commit `c990b21e`, the last code commit; the shipped commit adds only these lines. Before the push the owner made both backups by hand: a copy of the PC's data folder, and the server's data as one archive in the server user's home folder (`lh-data-before-0.6.tar.gz`). The server's image before the update was `dev-a2d2b7e`, should a way back be needed. **The owner then updated the server and the PC (release 0.6.14) and reported that both "went flawlessly".** They didn't say which screens they tried. `claude/upstream-0.6.0` builds nothing.

### The phone plugins round and Flashcards sync (sync protocol 3)

*From the old `docs/cloud-sync.md`, "After the merge (read this first)":*

- **The phone plugins round is shipped** (built on `claude/upstream-0.6.0`): Flashcards and Rich code blocks on a phone ("Plugins on a phone" in `docs/fork/phone-and-tablet.md`) and Flashcards sync ("Flashcards sync" in `docs/fork/cloud-sync.md`). It raises the sync protocol to 3, so the same rule applies again: the server and the desktop app must both be updated, the server first.
  - **Where it stands:** With the owner's word ("if the run works and the review comes back ok, you can just ship"), the same commit was pushed to `claude/pensive-goldberg-7dty2m` (the server's image `:dev`) and to `side-tutor` (the Windows release), both plain fast-forwards. Both dry runs had passed on `7ad11e3`, the last code commit; the shipped commit adds only these lines. The owner hasn't updated the server or the PC yet, and the owner's iPhone hasn't seen it. The owner has the "what to try" page (an Artifact page): a copy of the PC's data folder and of the server's data by hand, the server's update, then the PC's, then tick-lists for the iPhone. If they report a problem, ask what the screen shows and what Settings → Cloud reads on the PC.
  - **Way back:** the server's image before this update is the per-commit tag of `a5d3284`; the owner's two copies by hand are the data's way back (protocol 3 changes no file format, so an older build reads the files, but it speaks protocol 2).
  - **For the owner's review, not yet answered item by item:** "Built beyond the plan's letter, for the owner to review" under "Plugins on a phone" in `docs/fork/phone-and-tablet.md`, and "Rulings made while building (for the owner to review)" under "Flashcards sync" in `docs/fork/cloud-sync.md`.
  - **Reviews:** the sync part was reviewed in three passes; every finding is fixed, and the reviewer's last word was to ship ("The review of the wiring, and its fixes" in `docs/fork/history/cloud-sync.md`).

*From the old `docs/upstream-0.6.0.md`, its opening state:*

**Since then:** the phone plugins round (Flashcards and Rich code blocks on a phone, and Flashcards sync, sync protocol 3) is **built on `claude/upstream-0.6.0` and shipped**. With the owner's word ("if the run works and the review comes back ok, you can just ship"), the same commit was pushed to `claude/pensive-goldberg-7dty2m` (the server's image `:dev`) and to `side-tutor` (the Windows release), both plain fast-forwards. Both dry runs had passed on `7ad11e3`, the last code commit; the shipped commit adds only these lines. The sync part was reviewed in three passes and every finding fixed. The owner hasn't updated the server or the PC yet, and the owner's iPhone hasn't seen it. The plan is `docs/fork/plans/phone-plugins-plan.md`; what was built is in `docs/fork/phone-and-tablet.md` ("Plugins on a phone") and `docs/fork/cloud-sync.md` ("Flashcards sync"). It changes decisions 10 and 17 below, as noted there.

*From the old `docs/cloud-sync.md`, "Plugins on a phone: Flashcards and Rich code blocks":*

- **State:** built on `claude/upstream-0.6.0`, together with Flashcards sync ("Flashcards sync" in `docs/fork/cloud-sync.md`), and **shipped** to both branches; where it stands is `docs/fork/status.md`.

*From the old `docs/cloud-sync.md`, "Flashcards sync (built and shipped)":*

- **State:** built on `claude/upstream-0.6.0`, together with the phone plugins round ("Plugins on a phone" in `docs/fork/phone-and-tablet.md`), and fixed after a review in three passes ("The review of the wiring, and its fixes" in `docs/fork/history/cloud-sync.md`). **Shipped** to both branches; where it stands is `docs/fork/status.md`.

### The second touch batch: Obsidian inside Cloud on a phone, and Cite and Ask following the selection

*From the old `docs/cloud-sync.md`, "A less cramped list: Obsidian inside Cloud":*

- Shipped to both branches with the second touch batch (the owner's word: "ship"); not yet confirmed on the owner's iPhone. Checked in a browser at iPhone size in server mode (the list, Cloud with both groups, Core plugins, Flashcards' page and both back arrows, the notes drawer's "Open Settings" landing on Cloud with the group in view) and at 1280 px, where the Settings dialog was pixel for pixel the same as before. Tests: `tests/phone-plugins-ui.test.tsx`, `tests/phone-layout.test.ts`.

*From the old `docs/side-tutor.md`, "Highlight, then Ask" (the toolbar following the selection on touch):*

- Shipped to both branches with the second touch batch (the owner's word: "ship"); not yet confirmed on the owner's iPhone or iPad.

### The performance round

*From the old `docs/cloud-sync.md`, "After the merge (read this first)":*

- **The performance round is shipped** (long lessons lagging; `docs/fork/performance.md`): to both branches at the same commit, with the owner's word ("ship"). No protocol change, so nothing pauses and the order of the two updates doesn't matter. On touch it changes two things recorded in "Touch and typing" in `docs/fork/phone-and-tablet.md`: the glide's rule (item 6 under "A tap on the folded question ends at the bottom, open" in `docs/fork/phone-and-tablet.md`) and, through the off-screen rule, how long that glide takes. If the owner reports jumps while scrolling up on the iPhone or iPad, or Safari's own Find missing text, start from "Known faults with the rule on" in `docs/fork/performance.md`. (`?offscreen=off` turned the rule off for a comparison only in 0.6.28 and its server image; the switch's removal shipped with the phone's keyboard round, below.)

*From the old `docs/performance.md`, its opening state:*

**State:** step 1, the off-screen rule, the fix for jumps under it and the glide's rule are built on `claude/upstream-0.6.0` and **shipped**. With the owner's word ("ship"), the same commit was pushed to `claude/pensive-goldberg-7dty2m` (the server's image `:dev`) and to `side-tutor` (the Windows release), both plain fast-forwards from `1915f9c`. Both dry runs had passed on `d74d622`; the shipped commit adds only these lines. No sync protocol change and no stored format change: the protocol stays 3, the chat format 2, so the order of updating the server and the PC doesn't matter and nothing pauses. **The owner then updated and tried it on the iPhone and the iPad: "the performance is now very good"**, and again: "performance is very good". They didn't say which screens they tried, or whether the Windows app has been tried, so the things only their devices can show (under "Known faults with the rule on" in `docs/fork/performance.md`) are still open: scrolling up through never-drawn messages, Safari's own Find, and the glide's feel. The one thing the owner noticed (a mobile browser): **the scrollbar moves up and down instead of travelling smoothly** while scrolling, which is the estimates giving way to real heights; their words: "that isn't a problem at all", "performance is overall much better". They reported no text jumping. Nothing was changed for it: on a phone a closer estimate for the assistant's messages (1,000 px) opened the lesson short of its bottom (under "The off-screen rule" in `docs/fork/performance.md`). **The trial's off switch is removed** (owner's ask, once happy with the rule). The removal went out with the next change that was shipped, the phone's keyboard round ("The phone's keyboard round" below); the Windows app 0.6.28 and the server image of that time still took `?offscreen=off`. The server's image before this update is the per-commit tag of `1915f9c`. Change a decision recorded here only with the owner's approval.

*From the old `docs/upstream-0.6.0.md`, its opening state:*

**Since then, the performance round** (long sessions lagging): an audit, then step 1 of its recommendations, the off-screen rule and the two scroll fixes it needed, built on `claude/upstream-0.6.0` and **shipped** to both branches at the owner's word ("ship"), after both dry runs passed. No protocol or format change. The owner tried it on the iPhone and the iPad and reported that the performance is very good. The findings, the owner's decisions and what was built are in `docs/fork/performance.md`.

### The phone's keyboard round

*From the old `docs/cloud-sync.md`, "After the merge (read this first)":*

- **The phone's keyboard round is pushed to both branches** (built on the session branch `claude/vigilant-mccarthy-m36qe3`, cut from `claude/upstream-0.6.0` at `885497e`): with the keyboard up every tap lands and the keyboard stays for controls beside the box ("A tap with the keyboard up" under "Touch and typing" in `docs/fork/phone-and-tablet.md`), the question gets the room ("With the keyboard up the question gets the room" in `docs/fork/phone-and-tablet.md`), and the Tutor's bubble clears the home-screen app's top bar. With the owner's word ("push to both branches"), the same commit went to `claude/pensive-goldberg-7dty2m` and to `side-tutor`, both plain fast-forwards from `43b4a81`. Phone layout only; no protocol or format change, so nothing pauses and the order of the two updates doesn't matter.
  - **No dry run this time** (the owner asked for the push directly). Before it: the tests that read the changed files, typecheck and lint here, an independent verifier, and a browser run at the owner's screen size. The two workflows run their own tests before they publish anything.
  - **It carries the off-screen rule's switch removal** (`885497e`), which was waiting for the next shipped change (`docs/fork/performance.md`).
  - **The owner's first report from the iPhone:** "the buttons all work when the keyboard is up". The layout part had done nothing there (the keyboard-up marker never came on; the fix and a temporary readout are under "With the keyboard up the question gets the room" in `docs/fork/phone-and-tablet.md`). Still to ask about: a tap on the confidence bar's line. That fix was put on top of the check that opens by scrolling (next bullet), which the owner had shipped meanwhile ("i made other changes and pushed them, so make sure you account for those"), and pushed to both branches as a plain fast-forward from `51d76b8`. Not yet confirmed on the iPhone; the readout is to be removed once it is.
  - **The three commits that `claude/upstream-0.6.0` had beside this push** ("a check opens by scrolling, like any question", another session's work, cut from the same `885497e`) were put on top of it, shipped, and then reverted (next bullet).

### A check that opens by scrolling (release 0.6.30), and its revert (release 0.6.32)

*From the old `docs/cloud-sync.md`, "After the merge (read this first)":*

- **A check that opens by scrolling was shipped, and is reverted** ("A check opens by scrolling: built, shipped, then reverted" in `docs/fork/history/lesson.md`): it went to both branches at `51d76b8` (release 0.6.30), with the owner's word ("ship to both branches, fast forward"). The owner tried it on the iPhone and asked for it back out ("revert it"): scrolling down a little opened the check, it closed, and it opened again at the bottom of the blank space. The revert (`cf6e46c`) puts the three lesson-screen files it touched back to what the keyboard round shipped (`340a5a4`). It sits on top of the keyboard-up marker fix (`069e4b9`), which another session had pushed to both branches meanwhile and which touches other files. With the owner's word ("Ship to both"), the same commit was pushed to `claude/pensive-goldberg-7dty2m` and to `side-tutor`, both plain fast-forwards from `069e4b9`. No dry run; before it, typecheck and the tests that read the changed files here, and the two workflows run their own tests before they publish. No protocol or format change either way. Not yet confirmed on the owner's iPhone. What the owner wants in its place (scroll through the blank space, then it opens) is not built and needs a plan first.

### Scrolling into a check: the blank space (release 0.6.33)

*From the old `docs/cloud-sync.md`, "After the merge (read this first)":*

- **Scrolling into a check is shipped** (the owner's ask after the revert; "Scrolling into a check: the blank space" in `docs/fork/lesson.md`): a waiting check stays folded, the lesson keeps the open check's blank space under it and rests at the end of its text, and scrolling down to the bottom opens it. With the owner's word ("Build, ship both at once"), the same commit went to `claude/pensive-goldberg-7dty2m` and to `side-tutor`, both plain fast-forwards from `77a6b5d`. Every device, the Windows app included; no protocol or format change. Release 0.6.33. **Confirmed by the owner on the phone: "yes, everything works"**; the Windows app wasn't mentioned. Should it need to come out, `git revert 0a3feea` puts the lesson screen back to the reverted state (release 0.6.32).

*From the old `docs/upstream-0.6.0.md`, "Scrolling into a check: the blank space":*

- **State:** built on `claude/upstream-0.6.0` (code commit `0a3feea`) and **shipped**: with the owner's word ("Build, ship both at once"), the same commit was pushed to `claude/pensive-goldberg-7dty2m` and to `side-tutor`, both plain fast-forwards from `77a6b5d`. No dry run; the two workflows run their own tests before they publish (release 0.6.33). No protocol or format change. **Confirmed by the owner after updating: "yes, everything works"** (asked about the phone: folded at the end of the text, opening at the bottom of the blank space). They didn't say whether the Windows app was tried.

### The session list's swipe and the chains view's button

*From the old `docs/cloud-sync.md`, "After the merge (read this first)":*

- **The session list's swipe and the chains view's button are shipped** (built on the session branch `claude/confident-shannon-htmvtb`, cut from `2fbc222`): on a phone the session list drawer swipes left to close ("Session list" in `docs/fork/phone-and-tablet.md`), and the chains view has no session-list button ("Home" there). With the owner's word ("one more fix before you ship to both branches", the fix being the button), the same commit went to `claude/pensive-goldberg-7dty2m` and to `side-tutor`, both plain fast-forwards from `2fbc222`. Phone layout only; no protocol or format change, so nothing pauses and the order of the two updates doesn't matter. The Windows release it publishes changes nothing in that app.
  - **No dry run.** Before it: the new tests and the phone and sidebar tests one file at a time, typecheck and lint, and an independent verifier's browser run of the swipe at iPhone size with real touch. The two workflows run their own tests before they publish.
  - **Not run in a browser:** the swipe's quick flick (the sandbox delivers touch events too slowly); it rests on the unit tests.
  - **Not yet confirmed on the owner's iPhone.** To ask about: the feel of the drag and the flick, and whether a slightly diagonal scroll of the list ever pulls the drawer.
  - **Way back:** `git revert db7f46f` takes the swipe out (the drawer's ✕ and the tap on the dim are untouched by it); the button is one rule in `app/phone.css`.

### Several accounts on one server (release 0.6.40)

*From the old `docs/cloud-sync.md`, "After the merge (read this first)":*

- **Several accounts on one server is shipped** (built on `claude/dazzling-maxwell-j6mfy1`, cut from the released `side-tutor`): a gateway, a maker that makes one Docker container per account, invite codes and the owner's Accounts screen. With the owner's word ("can you ship"), the same commit went to `claude/pensive-goldberg-7dty2m` and to `side-tutor`, both plain fast-forwards from `bab6d0e`, after both dry runs had passed. No sync protocol or format change. **The owner's server is switched over:** the owner followed the guide (a copy of the server's data by hand, `git pull`, `./make-secrets.sh`, `./update.sh`, the setup code from the gateway's log, the claim) and reported "everything works great", without saying which screens they tried. If they report a problem, ask what the screen shows and for the lines of `docker compose logs gateway` that carry no code. Never ask for the setup code, a recovery code or a password. Still open for the owner: a password box on Reset, Remove and Delete now. **The host firewall was built on the session branch, passed its check, and was then declined by the owner**; it is in no branch that ships ("The host firewall: built and checked, then declined" in `docs/fork/history/server.md`). What was built, the builder's rulings for the owner to review, what is open and what only the real server can show are in "Accounts on one server" in `docs/fork/server.md`; the owner's decisions and the approved words are in `docs/fork/plans/multi-account-plan.md`.

*From the old `docs/cloud-sync.md`, "Accounts on one server", "State":*

- **Built on `claude/dazzling-maxwell-j6mfy1`** (the released `side-tutor` merged in first; the guide named `claude/upstream-0.6.0` as the start, which was at the same commit as this branch's start). The owner gave the word to build ("build my multi accounts feature"). The build ran straight through, as the owner decided; its one stop is the page of screenshots.
- **Shipped.** After the page of screenshots the owner gave the word ("can you ship then show me the firewall"), and the same commit went to `claude/pensive-goldberg-7dty2m` (the server's image `:dev`) and then to `side-tutor` (the Windows release), both plain fast-forwards from `bab6d0e`. Both dry runs had passed on `eeecd2b`, the last code commit; the shipped commit adds only docs. The three builds of the shipped commit (`e9b225e`) passed, the crossing step included (the server image for `:dev` and for `:latest`, and the Windows workflow), and the Windows workflow published **release 0.6.40**.
  - **The owner's server is switched over.** The owner followed the guide (an Artifact page) the same day and reported: "everything works great". They didn't say which steps or screens they tried, so the claim, the PC carrying on without pairing again, the home-screen app and an invite are confirmed only as far as that sentence goes; nobody has been invited yet as far as is known. Its `deploy/` files before the switch were at `c31e953` (the code the guide's step 4 prints; the owner sent it), which are the single-copy files the switch-over was tested from: that commit is the way back for `git checkout <commit> -- deploy`.
  - **The Windows release** carries the wider pairing box and, unused there, the account screens.
  - **The two open decisions were not settled by the ship** ("Open for the owner" in `docs/fork/server.md`): the owner said "ship" to the question of a password box on Reset, Remove and Delete now, which was read as shipping the approved confirm boxes as they are; the firewall step was shown to the owner after the ship, built at the owner's word, and then declined by the owner ("The host firewall: built and checked, then declined" in `docs/fork/history/server.md`).
  - **Way back:** the per-commit image tag of `bab6d0e` and the previous `deploy/` files; the owner's copy's own password login was never touched.
  - **What was written after the ship** (the release number, the switch-over on the owner's server, the firewall's record) **is on `claude/upstream-0.6.0`**, as docs-only commits on top of the released `side-tutor` (`3fa1289`, which already had the research wrap-up and the theme change from other sessions). The owner asked for that branch to be brought up to date and for these records to be added to it. The two release branches get them with the next change that ships.
- **Dry runs:** both workflows passed on `eeecd2b`; see the end of "The full run in the real stack" in `docs/fork/history/server.md`.

### Research: one wrap-up request

*From the old `docs/upstream-0.6.0.md`, "Asked for with the results":*

- **State:** built on `claude/upbeat-goodall-391yam` (cut from `side-tutor` at `e9b225e`; code commits `6f61bf5` and `74cdeaa`) and **shipped**: with the owner's word ("Ship to both now"), the same commit was pushed to `claude/pensive-goldberg-7dty2m` and to `side-tutor`, both plain fast-forwards from `e9b225e`. No dry run (it was offered); the two workflows run their own tests before they publish. No protocol or format change, so the order of updating the server and the PC doesn't matter. Not yet confirmed by the owner with a real research job. The owner's report since the investigation: it happens only occasionally, and with every provider, which fits the call limit.

### Demos and figures follow the theme

*From the old `docs/upstream-0.6.0.md`, "Asked for with the results":*

- **State:** built on `claude/peaceful-ride-831pls` (code commit `232ff0e`, merged with `side-tutor` at `1d28187` as `2233b1c`) and **shipped**: with the owner's word ("yes", then "push"), the same commit went to `claude/pensive-goldberg-7dty2m` and to `side-tutor`, both plain fast-forwards from `1d28187`. No dry run; before it, typecheck, lint and the related tests on the merged tree, and an independent verifier (no defects). No protocol or format change, so the order of updating the server and the PC doesn't matter. Not yet confirmed by the owner on a device.

### Appearance is per device (release 0.6.44)

*From the old `docs/cloud-sync.md`, "After the merge (read this first)":*

- **Appearance is per device, shipped** (built on `claude/upstream-0.6.0`): nothing on Settings → Appearance syncs between the server and a desktop app any more; imported theme files still do. With the owner's word ("run the dry runs, then ship to both"), the same commit went to `claude/pensive-goldberg-7dty2m` and to `side-tutor`, both plain fast-forwards from `3fa1289`, after both dry runs had passed. The sync protocol stays 3 and no stored format changed, so nothing pauses. **Update the server first** all the same: an older server paired fresh with an updated PC resets its own appearance (the one known gap). Not yet confirmed by the owner. If they report a look changing by itself, ask which side changed and whether a theme was removed on the other. The decisions, how it works and what wasn't tested are "Appearance is per device" in `docs/fork/cloud-sync.md`.

*From the old `docs/cloud-sync.md`, "Appearance is per device" (under slice 5):*

- **State:** built on `claude/upstream-0.6.0` (code commit `af5d46b`) and **shipped**. With the owner's word ("run the dry runs, then ship to both"), the same commit was pushed to `claude/pensive-goldberg-7dty2m` (the server's image `:dev`) and then to `side-tutor` (the Windows release), both plain fast-forwards from `3fa1289`. Both dry runs had passed on `44dc265`; the shipped commit (`e072349`) adds only docs lines. Its three builds passed (the server image for `:dev` and for `:latest`, and the Windows workflow), and the Windows workflow published **release 0.6.44**. Not yet confirmed by the owner on the server or the PC. Checked before that: the sync tests (336 of 336), typecheck and lint, run again by an independent verifier; the diff read by a reviewer, whose word was to ship. Not run between two built copies, and not against a real older build: an older side is played in the tests by the same code with the retired rule switched off.
  - **Way back:** `git revert af5d46b` makes appearance sync again; the server's image before this update is the per-commit tag of `3fa1289`. After a revert each side sends its own appearance again and the latest change wins per setting, so one side's look would replace the other's.

### Money amounts no longer turn into a formula

*From the old `docs/upstream-0.6.0.md`, "Asked for with the results":*

- **State:** built on `claude/upstream-0.6.0` (code commit `f849272`) and **shipped**: with the owner's word ("ship"), the same commit went to `claude/pensive-goldberg-7dty2m` and to `side-tutor`, both plain fast-forwards from `e072349`, once the builds of the appearance ship before it had finished (a push to a branch cancels that branch's build in progress). No dry run; before it, the new test, every test file that reads the agents' instructions (258 of 258), typecheck and lint. No protocol or format change, so the order of updating the server and the PC doesn't matter. Not tried with a real model, and the owner hasn't seen it yet.

### Money is not math: the renderer's own rule

*From the old `docs/upstream-0.6.0.md`, "Asked for with the results":*

- **State:** built on the session branch `claude/dreamy-fermat-5fyoa5` (cut from `claude/upstream-0.6.0` at `0c49178`; code commits `c3ef8f7`, `62ed9c2` and `3702f22`). **The owner gave the word to ship to both branches ("yes").** The first push was refused by that session's own permission check; it went through afterwards: both release branches were at `d4c05e6` (this section's own commit) when the seamless sessions work started from them. Checked before it: the above, typecheck, lint and the 110 test files that render lesson text (1,791 tests), one at a time; the rest of the suite is left to the two workflows, which run their own tests before they publish. No protocol or format change, so the order of updating the server and the PC doesn't matter.
  - **Way back, once shipped:** `git revert 3702f22 62ed9c2 c3ef8f7` puts the renderer back to upstream's pairing (two bare amounts are a formula again); the money bullet in the instructions is untouched by it.

### Seamless sessions, the pairing form's hint and GPT-6.2 (release 0.6.48)

*From the old `docs/cloud-sync.md`, "After the merge (read this first)":*

- **Seamless sessions are shipped** (built on `claude/upstream-0.6.0`): no "Held by", no Take over, no warning; a session moves to the device you start typing on, a PC cut off from its server carries on, and the heads-up is a floating box. With the owner's word, the same commit went to both branches as plain fast-forwards from `d4c05e6`, after both dry runs passed; it also carries the pairing form's new hint and GPT-6.2 Astra and Sol in the model list. The sync protocol stays 3, so the order of updating the server and the PC doesn't matter. Not yet confirmed by the owner on a device. If they report a session that won't continue on a device, ask what the box at the top of the lesson says and what Settings → Cloud reads on the PC. Still for the owner's review: the rulings made while building. Everything is in "Seamless sessions" in `docs/fork/cloud-sync.md`.

*From the old `docs/cloud-sync.md`, "Seamless sessions: no "Held by", no Take over (built and shipped)":*

- **State:** built on `claude/upstream-0.6.0`, on top of the released `side-tutor` (`d4c05e6`), and **shipped**. With the owner's word ("yes, ship it", to "the dry runs, and then to ship if they pass"), the same commit went to `claude/pensive-goldberg-7dty2m` (the server's image `:dev`) and to `side-tutor` (the Windows release), both plain fast-forwards from `d4c05e6`. Both dry runs had passed on `56e6091`; the shipped commit adds the pairing form's hint, the two GPT-6.2 models ("OpenAI and ChatGPT: GPT-6.2 in the model list" in `docs/fork/models-and-agents.md`) and these lines, which were tested here and not dry-run (the owner: "ship the models and hint too when they're ready"). The shipped commit's three builds passed (`b40cd07`: the server image for `:dev` and for `:latest`, each with the full tests and the crossing step, and the Windows workflow), and the Windows workflow published **release 0.6.48**. Not yet seen by the owner on a device. Reviewed and checked in a browser between two built copies ("What was checked" in `docs/fork/history/cloud-sync.md`). Open for the owner: the rulings made while building.
  - **This line and the release number are on `claude/upstream-0.6.0` only**, as a docs-only commit on top of the shipped one; the two release branches get them with the next change that ships.
  - **Way back:** the server's image before this update is the per-commit tag of `d4c05e6`. The page part and the engine part came in several commits (`ca90585` to `ebdc405`); to take the feature out, revert that range, or go back to `d4c05e6`'s tree for the files listed under "Added by seamless sessions" in `docs/fork/upstream.md`. `asked` and `sent` in a PC's `sync/desktop.json` are ignored by an older build.

*From the old `docs/side-tutor.md`, "OpenAI and ChatGPT: GPT-6.2 in the model list":*

- **State:** shipped to both branches with the seamless sessions ("Seamless sessions" in `docs/fork/cloud-sync.md`), at the owner's word ("ship the models and hint too when they're ready"), release 0.6.48. **Confirmed by the owner on the phone** ("they appear!", with a screenshot of the model menu): GPT-6.2 Astra and GPT-6.2 Sol are listed under ChatGPT (subscription) with their ids as built, at 272k. A lesson with one of them hasn't been reported yet. Tests: `tests/extra-models.test.ts`.

### Dictation in Firefox, and a failed Dictate's reason on a phone

*From the old `docs/cloud-sync.md`, "After the merge (read this first)":*

- **Dictation in Firefox, and a failed Dictate's reason on a phone, are shipped** (built on the session branch `claude/admiring-gauss-8xdvtn`, cut from `026e625`; code commits `6c1e714` and `3033b56`). With the owner's word ("ship"), the same commit went to `claude/pensive-goldberg-7dty2m` and to `side-tutor`, both plain fast-forwards from `b40cd07`. No dry run; before it, the dictation, phone and Tutor tests one file at a time, typecheck and lint, and an independent verifier's Chromium run with Firefox's refusal forced. No protocol or format change, so the order of the two updates doesn't matter; the Windows release it publishes changes nothing visible in that app. **The Firefox cause is an assumption that only the owner's Android phone can confirm.** If Dictate still turns off there, ask what the line above the message box reads. Both are under "Footer row" in `docs/fork/phone-and-tablet.md`.

*From the old `docs/cloud-sync.md`, "Footer row" under "Phone layouts":*

- **State: built on the session branch `claude/admiring-gauss-8xdvtn` and shipped.** With the owner's word ("ship"), the same commit went to `claude/pensive-goldberg-7dty2m` and to `side-tutor`, both plain fast-forwards from `b40cd07`, together with the phone's dictation reason above. No dry run (it was offered); the two workflows run their own tests before they publish. No protocol or format change. Not yet confirmed on the owner's phone.
- **Way back:** `git revert 6c1e714` takes the fallback out (the recorder and the worklet are upstream's again, plus the button's marker); `git revert 3033b56` takes the phone's line out.

### The docs regrouped into docs/fork/, and a comment-only source tidy (no release)

- **What:** the owner asked for an analysis of the codebase and a cleanup of the docs, with no change to the product, reviewed by Sonnet and Opus agents. Four reviews first (two Opus on the docs, one Sonnet checking the docs against the code, one Sonnet mapping the repository), then five decisions of the owner's, one question each: docs plus a source tidy; regroup and correct, every fact kept; every "how it works now" file loaded into each session; the fork's docs in their own folder, `docs/fork/`; shipped with `[skip ci]`, so that nothing builds. The owner approved the plan ("approved").
- **The docs:** `docs/cloud-sync.md`, `docs/side-tutor.md`, `docs/upstream-0.6.0.md` and `docs/performance.md` were split by topic. A script copied every line from the old files (commit `3ccae15f`: 2,476 of 2,495 non-blank lines word for word; the 19 others are headings of sections that were split up). Five Opus editors then corrected what was no longer true, each change logged and checked against the code, and moved records and retired text into `docs/fork/history/`. New: `README.md` (the map), `status.md`, this ship log in the order the rounds shipped. The four plan docs are in `docs/fork/plans/`, the review policy is `docs/fork/review-policy.md`, the sealed-box spike is `docs/fork/spikes/`. `CLAUDE.md` imports the topic files.
- **The source tidy** (commit `095e973e`, then `490738f6` and `079facff`): comments only, plus the fork's three test helpers moved into `tests/helpers/` with their ten importers. Comments that named a doc name its new place; inside upstream's files the marker comments "Side-tutor fork" and "Fork (…)" are `FORK (…)`. The root `README.md` says the repository is a fork.
- **Checked:**
  - every touched code file is identical once its comments are stripped, apart from the helpers' import paths (a script, run again by an independent Sonnet verifier, who also read the diffs);
  - typecheck clean, lint with its one existing warning, 28 test files one at a time with no failure (the ten that import a moved helper and eighteen that read the text of a changed file);
  - both workflows started by hand on `claude/upstream-0.6.0` at `4f813953`, which has all of the tidy except the 34 comment lines of `490738f6` and `079facff`: the Windows run passed (its tests, the build, the packaged app, the update feed) and the server image run passed its tests on Node 26, the image build, its smoke test and the accounts stack with the crossing tests. Neither publishes on a run started by hand;
  - an Opus reviewer accounted for every one of the 109 lines the editors changed and checked about 35 of the corrections' claims in the code; its six findings are fixed;
  - a script checks the pointers between the docs: no old path left outside this log's "From the old …" lines, and every quoted section title is a heading or a bold lead in the file it names.
- **Shipped:** every commit carries `[skip ci]`. `claude/upstream-0.6.0`, then `claude/pensive-goldberg-7dty2m` and `side-tutor`, both plain fast-forwards from `dce63584`. No release and no server image: the released app stays 0.6.49.
- **Way back:** the tree at `dce63584`.
- **Not done, on purpose:** the 42 upstream files whose fork edits carry no marker got no new comments (they are listed in "Every upstream file the fork has edited" in `docs/fork/upstream.md`); upstream's three test helpers at the top of `tests/` stayed where they are; the temporary keyboard readout and the `TODO(owner wording)` placeholder are untouched; `main` and the old session branches were not touched.
- **For the owner to know:** the files loaded into every session come to about 440 KB, against about 530 KB before, not the roughly 300 KB estimated in the plan: almost all of the text turned out to be live rules, as-built contracts and lists for the owner, which stay in the topic files.

### An empty reply is asked again (releases 0.6.51 and 0.6.52)

- **What:** on ChatGPT and OpenAI models, a reply owed to the learner that has only thinking is dropped and requested again in the same turn, up to 2 times; still empty, it is saved as a failed reply, so the failed-reply line and its Retry apply (`docs/fork/models-and-agents.md`, "ChatGPT and OpenAI: an empty reply is asked again").
- **Built on** `claude/modest-euler-dy4rc7`, from `fa5dda0`: `a14973f` (the guard, its tests and docs), `cfe18d7` and `711576f` (docs).
- **Shipped** with the owner's word ("Ship to both"): `711576f` to `claude/pensive-goldberg-7dty2m`, then to `side-tutor`, both plain fast-forwards. The Windows workflow published **release 0.6.51**.
- **The server image did not build from that commit.** Both server image runs hung in "Every other test" until the job's 30-minute limit. The cause was not this round: two cases of `tests/gateway-review.test.ts` redeemed an invite made on the helpers' fixed clock (15 November 2026) through a gateway on the real clock, and an invite lasts 7 days, so from 22 November 12:00 UTC the test waited forever. The last passing run was on 22 November at 09:52 UTC.
- **The repair** (`cce472a`, `65bf2fb`; test files and docs only): those two cases, and one in `tests/gateway-lifecycle.test.ts` that would have failed from 15 December, give the gateway the test's clock. Shipped with the owner's word ("Both branches") to both branches at `65bf2fb`. The server image `:dev` was published from it (typecheck, tests, lint, the image's smoke test and the accounts stack tests all passed), and the Windows workflow published **release 0.6.52**, the same app as 0.6.51.
- **Way back:** `git revert a14973f`; the server image built from `dce63584`, the one before this round.
- **The owner's word:** the plan approved ("Approved, build it"); shipped at the owner's word. Not yet confirmed in use: no real ChatGPT model was run before the ship.

### A hidden nudge replaces the empty-reply retries (release 0.6.53)

- **Why:** the plain retry of releases 0.6.51 and 0.6.52 did not help in use. On the owner's server GPT-6.2 Astra answered the identical request with an empty reply every time: two turns, three requests each, then the red line. The log lines read `thinking: no; phases before: commentary`.
- **What:** on the first empty reply the app drops it and asks once more with a hidden instruction added to that one request only; the page gives the empty attempt's place to the reply that follows; still empty, the failed-reply line with Retry (`docs/fork/models-and-agents.md`, "ChatGPT and OpenAI: an empty reply is asked again").
- **Built on** `claude/modest-euler-dy4rc7`, from `1953209`: `7ea21dc` (the code, tests and docs), `28ed5d0` and `993fa11` (docs).
- **Checked before the ship:** the full suite, typecheck and lint; an independent check with the nudge and the page rule each switched off in a scratch copy; a browser run in server mode with a stand-in model that returns a completed response with no output, on a computer and at iPhone size. No real model.
- **Shipped** with the owner's word given with the plan ("Approved, build and ship": ship without asking again if every check passes): `993fa11` to `claude/pensive-goldberg-7dty2m`, then to `side-tutor`, both plain fast-forwards. The Windows workflow published **release 0.6.53**; the server images `:dev` and `:latest` were published from the same commit.
- **Way back:** `git revert 7ea21dc`.
- **The owner's word:** asked for by the owner ("remove the silent retries and nudge the model and make sure the user is unaware of this behavior"); the instruction's words chosen by the owner ("Both together"). Not yet confirmed in use.

### Dictation after the app was away, and the phone's reason centred (release 0.6.54)

- **Why:** the owner's report from the iPhone's home-screen app: dictation stops working after the app is closed and reopened, and sometimes a red line names Deepgram (the words couldn't be reproduced to read). Then, from a screenshot of the browser run: "that error message should be centered".
- **What:** the recorder no longer trusts the audio engine it kept: one that won't run is replaced in the same run, and when none will the run ends with "Microphone didn't start. Try again."; a microphone taken away during a run stops it as Stop does, with its words and no error (`docs/fork/lesson.md`, "Dictation"). On a phone a failed Dictate's reason is centred above the message box (`docs/fork/phone-and-tablet.md`, "Screens", "Footer row"). The cause is a working assumption: no iPhone could be run.
- **Built on** `claude/upstream-0.6.0`, from `1953209`: `ee053ea` and `7e8e82d` (the recorder, its tests and docs), `f988c85` (the centred line). The hidden nudge (`993fa11`) and its ship record (`28ded6d`), shipped meanwhile by another session, were merged in before the ship (`0227370`, `44987e1`), both without a conflict.
- **Checked before the ship:** the recorder's tests (25 new, the existing ones unchanged); the full suite on the merged tree (7,084 tests, 7,076 passed, 4 skipped, 4 failed: the development sandbox's four known ones), typecheck and lint; an independent check with a browser run in server mode (a kept engine made stuck, every engine stuck, the microphone muted with the page hidden, the page hidden alone; at iPhone and at computer size); the centred line measured at 440 and 390 points wide on the new-session screen and a lesson. The record: `docs/fork/history/lesson.md`, "Dictation after the app was away: what was checked".
- **Shipped** at the owner's word ("i agree to ship"): `f988c85` to `claude/pensive-goldberg-7dty2m`, then to `side-tutor`, both plain fast-forwards from `28ded6d`, with no build under way on either. The Windows workflow published **release 0.6.54**; the server images `:dev` and `:latest` were published from the same commit. The sync protocol stays 3.
- **Way back:** `git revert f988c85` (the line's place); `git revert 7e8e82d ee053ea` (the recorder).
- **The owner's word:** the plan approved ("i approve"); the three decisions the owner's own (stop and keep the words; "Microphone didn't start. Try again."; every device). Not yet confirmed on the iPhone.

