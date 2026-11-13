# Side Tutor fork: features, design decisions, code map

Branch `side-tutor`, based on upstream amosblomqvist/learnharness v0.6.0 (merged with `git merge`; the owner's choices at that merge are in `docs/upstream-0.6.0.md`). The fork adds three things: the side tutor, the notes drawer, and a separately installed Windows app that updates itself from this fork's releases.

## Separate Windows app

- `electron-builder.side-tutor.yml` extends `electron-builder.yml` with:
  - its own appId (`com.learnharness.SideTutor`), productName and executable (`LearnHarnessSideTutor.exe`);
  - its own **package name**, `learnharness-side-tutor`.
- **Why the package name matters:** a one-click per-user NSIS install names its folder after package.json `name`, not productName (app-builder-lib `getWindowsInstallationDirName`). With the upstream name, the side tutor overwrote the official app in `%LOCALAPPDATA%\Programs\learnharness`, and either uninstaller deleted both. It now installs to `%LOCALAPPDATA%\Programs\learnharness-side-tutor`. Pinned by `tests/side-tutor-install.test.ts` and a CI check.
- It shares the official app's data folder (`%APPDATA%\LearnHarness`) on purpose, because `electron/main.cjs` pins `app.setName("LearnHarness")`. Because of that, the two apps can't run at the same time (shared single-instance lock).
- NSIS never deletes app data on uninstall.
- The installer is unsigned (SmartScreen: More info → Run anyway).

## Auto-updates from this fork

- The update feed is this fork's GitHub Releases (`publish` in the side config: provider github, owner Jaeky42, repo learnharnessSide, releaseType release).
- `publish` **must stay a single object**. The `extends` merge concatenates arrays (builder-util-runtime `deepAssign`), so a list would keep the official feed first.
- `.github/workflows/side-tutor-windows.yml` runs on every push to `side-tutor`, in this order:
  1. Stamps version `<major>.<minor>.<run number>` into the runner's package.json (never committed). electron-builder 26 has no `--em` flag.
  2. Runs the side-tutor, notes and cloud sync tests on Windows, builds, and smoke-tests the server and the packaged app.
  3. Checks that the packaged `app-update.yml` points at this fork and that the package name and version are right.
  4. Only then publishes a GitHub Release (`gh release create`, with the installer, blockmap and latest.yml).
- Pushes that only change `CLAUDE.md` or `docs/**` don't run the workflow.
- **A dry run:** started by hand (`workflow_dispatch`) on any branch, the workflow does everything except the last step. It tests, builds and attaches the installer to the run, and publishes no release. Used to check the cloud sync branch on Windows before its merge.
- `LH_BUILD_VERSION` / `LH_BUILD_HOMEPAGE` (next.config.ts) make Settings show the stamped version and link release notes to this fork.
- To pick up upstream: rebase `side-tutor` onto the new upstream release and push.

## Side tutor

- A floating window over a session, **teaching and practice** (practice since the 0.6.0 merge, owner's ask), for quick questions. Esc shrinks it.
- **Since the 0.6.0 merge it has no engine of its own.** The window, the bubble and the phone sheet are the fork's; what is asked in them are upstream's side conversations. See "The Tutor on upstream's side conversations" below.
- **Moving and resizing on a computer** (owner's ask; it was the browser's own grip in the bottom right corner):
  - **The top bar moves the window.** Nothing at the top resizes it: not the top edge, not the top corners, not the sides beside the top bar.
  - **The left side, the right side, the bottom side and the two bottom corners resize it.** A side changes the width, the bottom the height, a corner both. The top never moves in a resize; dragging the left side keeps the right edge where it was.
  - **Nothing is drawn.** The pointer turns into resize arrows over those edges.
  - **The zones sit on the window's edges** (owner's ask after trying it: at first they were 6 px outside the window and only 2 px inside, and hard to find):
    - each strip is 12 px thick, 8 px inside the window's edge and 4 px outside it;
    - a corner is an L that runs 28 px along both of its edges, so it is found from either side. Its inner square is cut away (`clip-path`), which leaves the typing box's and Send's own corners alone;
    - the side strips start under the top bar.
  - **Those 8 px are the window's own empty rim**, so no strip covers anything to press: the typing row's padding, and the conversation's left padding.
    - On the right the conversation's scrollbar used to sit against the edge. On a computer the scrolling part now ends 8 px short of it, and gives the words those 8 px back from its right padding, so the words are where they were and only the scrollbar moved in. A short conversation, with no scrollbar, looks as before.
  - **Limits:** no smaller than 288 × 224 px (as before), and no further than 8 px from the app window's edges, the margin a dragged window keeps.
  - **The size is remembered** (owner's choice), like the position: after minimizing and after a reload (`lh:side-tutor:size` in the browser's storage, beside `lh:side-tutor:pos`). In a smaller app window a big remembered size is held inside it and comes back when there is room.
  - Resizing doesn't take the focus from the typing box or select text.
  - **A cloud sync strip under the top bar** (a paired app only) doesn't move the window: the window may cover the strip (owner's decision).
  - **How:** a frame holds the window's place and size, with the window filling it and the five zones beside it (the window clips its own rounded box, so the zones can't be inside it). On a phone the frame is no box at all (`display: contents`) and there are no zones.
- **It starts minimized whenever a session opens** (owner's ask, with the 0.6.0 merge; it used to start open on a computer and remember whether it was left open). Opening a session, a reload and a restart of the app all show the bubble. It stays open only for that visit of the session; nothing about open or closed is stored (`lh:side-tutor:open` is no longer read or written). Highlight then Ask still opens it. The phone always started closed and is unchanged.
- **On a computer the window comes out of the bubble and folds back into it** ("Morph", the owner's pick of three live demos; the others were a plain grow and a grow with an overshoot):
  - the window starts squeezed exactly onto the bubble's circle and is let go to its own place and shape in 260 ms; closing folds it back in 210 ms; the easing is the sync strip's (`cubic-bezier(0.2, 0.8, 0.2, 1)`);
  - a cover in the bubble's own grey, with its icon, lies over the window and fades as the shape opens, so the bubble turns into the window. The owner saw two earlier demos and named their faults: one moved in two steps ("choppy"), one hid the contents first, which left only the dark middle on screen ("turns black");
  - it runs from wherever the bubble is to wherever the window was left. Only `transform` and `opacity` move, so nothing is laid out again on the way;
  - while it folds back the window is still on screen; the bubble appears when it has folded. An unseen stand-in keeps the bubble's place while the window is open, so the end point can be measured (`side-tutor-bubble-place`);
  - **not animated:** with reduced motion (at once, as before); when a session becomes held (the window closes to the greyed bubble at once); and **on a phone, where the sheet's own slide-up is unchanged** (owner: "do not change the phone animation yet"). The owner has since asked for the phone's closing slide: the sheet now slides down when minimized and swipes down from its handle and top bar ("On a phone: swipe down to minimize" below); its opening is still unchanged;
  - `morphStart` and the timings are in `components/side-tutor-window.ts`; the run is in `components/side-tutor.tsx`.
- **It stays above the Drawing Pad** (owner's ask; any plugin surface that covers the lesson). Upstream's pad is opaque and covers the lesson and the dock, and it covered the Tutor's window and bubble with them.
  - The open window keeps its place and is drawn one layer above the surface. Drawing beside it works, and what is typed in it stays.
  - The bubble can't stay in the dock (the pad covers the dock and makes it inert), so while a surface is open it sits at the lesson's bottom right, 16 px in and 20 px up, as on a held session. That place was chosen while building, from the held-session rule, for the owner to review: under the top bar it would sit on the pad's own ✕.
  - Esc with the cursor in the Tutor minimizes the Tutor only; the next Esc closes the pad.
  - A menu opened from the surface still covers the Tutor.
  - **How:** upstream's `useSurfaceChromeStyle` (its hook for page chrome that floats over a plugin surface) gives the surface's rank; `components/chat.tsx` passes it to the Tutor as `above`.
  - **Not changed:** the pad's shortcut (Ctrl+Shift+D) does nothing while the cursor is in the Tutor's typing box; it works from the lesson and its message box.
- **Minimized, it is a round bubble with no words** (owner's ask; it was a pill reading "Ask on the side" at the window's place), the same bubble as on a phone.
  - **On a computer it sits at the lesson's bottom right**: 16 px in from the lesson's right edge and 20 px above the question bar (the message box, an open question, or a question's folded bar). On a wide lesson that is off to the side of the bar's end; on a narrow one, above it. The owner's placing, after two tries: 12 px above the whole dock read as too far, and 8 px above the bar's own right end as too close. It keeps that place against the bar while the lesson scrolls and a question opens or folds.
  - It is drawn **inside the dock** for that (a portal into the `data-phone="dock"` block, placed with CSS only), so it moves with the bar by itself, frame for frame, with nothing to measure. Things the dock shows above the bar (the setup button, queued messages, the jump-to-bottom arrow) are below the bubble, not under it.
  - While an opened question fills the window and leaves no room above it, the bubble waits under the top bar at the lesson's right, as on a phone (`use-dock-anchor.ts` decides; on a wide lesson that is beside the question, on a narrow one over its top corner).
  - The open window can still be dragged anywhere and opens again where it was left, at the size it was left; only the bubble has a fixed place.
  - **In a tablet's home-screen app the top bar sits lower**, below iOS's blur ("Phone layouts" → "When it applies" in `docs/cloud-sync.md`, `--lh-tablet-top`). The Tutor moves with it: the window opens 12 px under the lowered bar (72 px plus the inset), the bubble's place under the top bar is lower by the inset, and the window can't be dragged higher than 8 px below the inset, so a remembered spot up in the blur comes back just below it (`defaultPos`, `clampPos` in `components/side-tutor.tsx`, reading `components/phone/tablet-top.ts`). Elsewhere the inset is 0 and nothing changed.
- **The window's words** (owner's wording): "Tutor" in the top bar, "Stuck on a term or a step? Ask here." while it is empty, and "Ask a follow-up…" as the typing box's hint. Nothing else: no tagline, and no explanation of what the tutor can see.
- **The window's look** (owner's asks, tuned from screenshots):
  - **The middle**, where the conversation is, is closer to black and more see-through than the rest: black at 60%, over the window's blur of the lesson behind it (`BODY_BG` in `components/side-tutor.tsx`). The bars (the top bar, the message line, the typing row) keep the app's background at 95% (`BAR_BG`). The window has no background of its own; one behind the middle would close it up.
    - The owner's pick from a strip of five shades: 70% was "a little too black".
    - **On a light theme** (upstream 0.6.0's themes) black is unreadable over a light lesson, so a light theme gets the theme's background at 62% with 10% of its text colour mixed in: a shade darker than the lesson, as on dark themes. The owner's pick of three; the others were the background at 60% and the theme's soft grey at 78%. Dark themes keep black at 60%.
    - On a phone the sheet paints only what no part covers, in the bars' colour: the strip around its handle and the home-bar strip (`app/phone.css`).
    - **On a phone the dim covers only the lesson above the sheet** (it used to cover the whole screen). Behind the sheet the lesson is left as it is, so it shows through the middle as on a computer; dimmed first, it showed through as plain black, and the owner asked why the phone wasn't see-through. The dim ends one corner radius below the sheet's top, so the lesson at the rounded corners is dimmed too. A tap on the dimmed lesson still closes the sheet.
  - **Dictate and Send are squares as tall as the one-line typing box** (they were 36 px beside a 42 px box). So are Stop and the waveform while it listens, and the button that stops an answer.
    - The height is worked out, not written as a number: one line of the box's text plus its padding and border (`--lh-tutor-row`, set on the typing row). The box's text is the lesson's reading size, a setting, so the buttons follow it: 42 px at the default 16 px.
    - On a phone every text box is 16 px whatever the reading size (`app/phone.css`), so the sheet sets `--lh-tutor-text: 16px` and the row is worked out from that.
  - **The hint "Ask a follow-up…" is a little smaller than typed text**: seven eighths of it (14 px at the default). It keeps the typed text's line height, so it sits where the typed words will and the box doesn't change height at the first letter. Typed text is unchanged (and must stay 16 px on a phone, or iPhone Safari zooms in).
- **Speaking to the tutor** (owner's ask): a Dictate button (a microphone) sits right of the typing box, before Send. While it listens, a small live waveform and a red Stop take its place. The words land in the tutor's typing box when the run ends.
  - It borrows the page's one recorder (`components/dictation.tsx`): the same microphone, Deepgram key, language and waveform as the lesson's Dictate. Since the 0.6.0 merge it uses upstream's own hand-over: the button starts a run for its own destination (`toggleFor` with `SIDE_TUTOR_DICTATION_ID`), and the recorder delivers the words there. The fork's earlier claim hooks and `side-tutor-dictation-state.ts` are gone.
  - While the tutor's run is live, the lesson's own Dictate shows no run and is greyed (upstream's rule for a recorder that is busy elsewhere), and the lesson's message box doesn't take the words or the focus.
  - The button shows only an error of its own run, as upstream's views do.
  - Send while still listening ends the run first, then asks with the spoken words. Esc cancels the run (the words are dropped), as in the lesson; a second Esc minimizes. Minimizing ends the run and keeps the words.
  - The button is off while the lesson itself is dictating. Without a Deepgram key it says so, and a click opens Settings → Keys, as the lesson's Dictate does.
- **The Tutor on upstream's side conversations** (owner's decisions at the 0.6.0 merge; before it, a second agent of the fork's own answered and kept its thread outside the chat record):
  - **What changed with upstream's behaviour:**
    - The main teacher receives every exchange with its next turn, and summaries include them. The teacher's prompt has upstream's paragraph about them (`shared/35-side-conversations.md`).
    - The cost of side answers is added to the session's meter.
    - The helper reads the lesson since the last summary, the open question without its answer key (plugin questions too), and what the learner has typed but not sent in the answer box. It no longer gets the plan, the phase, or the lesson from before a summary.
    - It follows the prompt texts edited in Settings and answers in upstream's short style.
    - It runs at **the session's thinking level** (it was fixed at medium). Its model is upstream's setting (Settings → Agent, the side-question role), per device.
    - The conversations are stored inside the chat record (`sideChats`), so they travel with the session between devices and into backups.
    - **No Clear:** nothing can be deleted from a side conversation. The trash button is gone.
    - An answer still being written carries on after minimizing or a reload, and is there afterwards.
  - **One scroll.** Upstream keeps one conversation per lesson step (from one learner turn to the next). The window shows all of them in lesson order, each under a divider: **the step's first words**, as plain text (no formatting marks; a formula ends the text with "…"), cut to one line. No mark on the current step. A step with no prose gets a plain line.
  - **What is typed is about the step the lesson is on.** With a highlighted passage attached, about that passage's step; after that answer, the current step again.
  - **Highlight, then Ask** (upstream's toolbar over selected lesson text): the window opens (the bottom sheet on a phone) with the passage waiting above the typing box; its ✕ drops it. Once sent, the passage sits above the question, and a click on it shows that place in the lesson (on a phone the sheet closes first). A passage over 4,000 characters: upstream's button reads "Shorten selection" and does nothing.
    - **On a touch screen (phone and tablet) the toolbar shows after a press-and-hold selection**, beside the system's own Copy / Look Up box (owner's report: on the iPhone and the iPad only the system's box showed, with no way to Ask). Shipped to both branches with the touch batch (the owner's word: "ship"); not yet confirmed on the owner's iPhone or iPad.
      - **The cause:** upstream reports a selection when the mouse is released. A press-and-hold selection on iOS sends `pointerdown`, then the system takes the touch (`pointercancel`), and never a `mouseup`; upstream's "a press is under way" flag then stayed set for good and every later selection was ignored. Dragging the handles sends the page only `selectionchange`.
      - **When:** decided per gesture from `pointerType` (touch, or a pen: an Apple Pencil counts as touch), never from the screen width, so a mouse on a computer, a touch-screen PC's mouse included, is exactly as before (at once after a click's release, 500 ms after a double or triple click, at the pointer). **In a browser only:** in the desktop app every gesture keeps upstream's behaviour, a finger on a touch-screen PC too ("Still as on a computer" in `docs/cloud-sync.md`; `touchSelectionHere`, the same rule as `isBrowserNow`). On touch the toolbar first shows once the selection has stopped changing for `TOUCH_SETTLE_MS` (300 ms) and no finger is down (a finger that never reports lifting holds it back at most `TOUCH_FINGER_WAIT_MS`, 1.5 s). It goes when the selection is cleared. On Android the long press's `contextmenu` comes first; the toolbar still shows once the selection rests.
      - **Once shown, it follows the selection** (owner, iPhone: "the cite/ask buttons do work as intended, but they take way to long to reappear after i resize the selection box. please make these feel almost instant"). It used to hide at every change and come back 300 ms after the handles rested. On a test page run on the owner's iPhone (Test 2 of a bench page with three choices: as before, back after 60 ms, and "Stays, follows") the owner chose **"Stays, follows"**: "b is best. i didn't even know that was possible". So a change that leaves a selection in the lesson doesn't hide it: it is placed again for the selection as it is now, by the same rule, at the next animation frame (several changes in one frame are placed once), with no settle wait and no finger wait; the handles send the page no touch or pointer events, so there is no lift to wait for. It may switch sides when the selection's centre crosses the middle; it just moves. The same element is kept (no unmount, no entry animation), the passage Cite and Ask act on is the selection as it is now, and the place is measured afresh each time with the toolbar's real size.
      - **While the lesson scrolls** (a handle dragged to its edge autoscrolls it) the toolbar is hidden, because a fixed element moved from script would trail the scroll; it is placed again 150 ms after the last scroll event (`SCROLL_SETTLE_MS`, upstream's), plus a frame, with no settle wait on top. A finger scroll, a new press and hold, a tap elsewhere, Esc, the window losing focus and focus moving into a text box end the following, also while a scroll has the toolbar hidden (it then doesn't come back when the scroll settles; found by a reviewer): the next selection settles first again, as at the first appearance.
      - **Measured** in a browser at iPhone size with iOS's sequence from a script (the end moved one line every 120 ms), before and after: placed again 322–335 ms after each change, hidden in between, a new element each time; after, 24–30 ms after each change as measured (the next frame plus the measuring script's own frame), never hidden, the same element. After an autoscroll: back 410–433 ms after the last scroll before, 161–168 ms after. The first appearance after the press and hold is unchanged (315–331 ms in both).
      - Shipped to both branches with the second touch batch (the owner's word: "ship"); not yet confirmed on the owner's iPhone or iPad.
      - **Tapping a button works although iOS may clear the selection first:** a press that starts on the toolbar keeps it, with the passage it captured, until that press has ended and its click has been handled (or `TOUCH_ACTION_RELEASE_MS`, 400 ms, after the finger lifts with no click). It doesn't rely on `preventDefault` on the press.
      - **Where (owner's choice: "opposite side", over a fixed bar above the message box and over always below the selection):** the system's box can't be moved or seen by a page, so the buttons go on the side opposite where it is predicted:
        - iOS puts its box on the side with more room: **below** the selection when the selection's vertical centre (the middle of its first line's top and its last line's bottom) is above the middle of the visible screen, **above** otherwise. The switch is `SYSTEM_BOX_SWITCH` (0.5 of the visible height). The visible height is what the phone layout already uses for `--lh-vvh` (in the home-screen app it includes the clock strip that the iPhone leaves out of `innerHeight`), elsewhere the visual viewport's height; measured from the visual viewport's top. The app's own top bar is not allowed for: iOS doesn't know about it.
        - box predicted below → the buttons **above the start of the selection**, from its first line's left end; box predicted above → **below the end**, from its last line's right end. Both `TOUCH_HANDLE_GAP` (18 px) from the text, clear of the handles' knobs (about 12 points beyond the first and last line, from the owner's screenshots).
        - **Bigger buttons on touch:** 32 px tall (24 on a computer), 15 px text, a 16 px icon and a little more side padding, the same look otherwise (`TOUCH_BUTTON_CLASS`; `TOUCH_TOOLBAR_HEIGHT` = 32 before the toolbar is measured). Owner: "a little bigger and a tiny bit closer", after seeing screenshots; the gap was 24 px at first. A mouse keeps upstream's size and place.
        - no room on that side (the selection starts right under the top bar, or ends right above the dock) → on the system box's side, beyond it, `SYSTEM_BOX_CLEARANCE` (70 px) from the text (the box reaches about 62 points from it); no room there either (a selection that fills the lesson) → under the end, clamped inside the lesson and the visible screen, as on a computer. Never beside the box: it is centred on the selection and nearly as wide as the screen.
        - **The owner's measurements** (iPhone, home-screen app, 440 × 956 points; the lesson from 147 to about 830), where the system's box went:

          | Selection (line centre, pt) | System box |
          |---|---|
          | one word at 327 | below |
          | one word at 414 | below |
          | five lines, 404 to 523 (centre 464) | below the end |
          | one word at 550 | above |
          | one word at 646 | above |

          The box is about 43 points tall, 15 to 19 points from the selection, and up to 344 of 440 points wide. Only the iPhone's home-screen app was measured; a Safari tab and the iPad use the same rule. The switch-over (between 464 and 550 points) and the two gaps can be tuned only on the owner's devices.
      - **"No room" is judged against what is really visible** (found by a reviewer: a selection ending just above the message box put the buttons on top of it, because the lesson's box runs under the dock). On touch the lesson's box is cut at the top of the dock (`[data-phone="dock"]`: the message box, or an open question, which is taller) and at the bottom of the top bar (`[data-phone="topbar"]`) where they overlap it (`visibleLessonBounds`). So a selection ending right above the dock sends the buttons to the system box's side, beyond the box (iPhone 13 size: a selection at 530–552 with the dock at 562 put them at 570–602 over the message box; now at 428–460, above the start).
      - **While the iPhone keyboard is up** the body is shifted and is the frame for fixed elements, so the touch toolbar's position is measured from the body's top (`fixedFrameTop`, `touchToolbarTop`), as the fork's other fixed elements are. With no shift the numbers are upstream's. Not tried with a real keyboard.
      - Scope as on a computer: the lesson's text. A held session's buttons stay greyed.
      - **Code:** `components/phone/touch-selection.ts` (the constants, the placement rule, the visible screen and the visible lesson, the browser gate, the shifted frame); small, commented edits in upstream's `components/selection-actions.ts` (the touch timing and the held press) and `components/selection-toolbar.tsx` (the touch placement). **Tests:** `tests/selection-touch.test.ts` (the five measured rows, the two no-room fallbacks and the clamp, the dock (a message box, an open question, none), the shifted body, the desktop app keeping upstream's behaviour for a finger and a pen, scripted touch sequences, following a resize (placed again at each change and never hidden, once per frame, the side switching as the centre crosses the middle, the selection cleared, a new press and hold settling first, hidden during an autoscroll and back 150 ms after it plus a frame, a press on the toolbar during it), and the mouse's timing and placement unchanged).
      - **Only the owner's devices can show** where iOS really puts its box and handles beside the buttons, whether a tap on Ask or Cite lands the first time (on iOS, and with an Apple Pencil), and how the timing feels. Chromium's touch emulation makes no press-and-hold selection; the browser run used iOS's event sequence from a script.
  - **Stopped and failed:** a stopped answer keeps its words and says "Stopped." A failed one shows upstream's reason in the theme's error colour, then a link, "Retry". A refusal before anything was saved (no model set up, for example) shows in the line above the typing box, and the question comes back into the box.
  - **One answer at a time:** while one is being written, Send is Stop.
  - **Before the teacher has said anything** the window shows its empty sentence and the typing box is off.
  - **The hint is always "Ask a follow-up…".** Upstream's other hints aren't used.
  - **Not shown:** upstream's own card, its pinned column, the "?" markers under each step and Ctrl+J. Their components stay in upstream's files, unused, so later releases merge cleanly. Cite, upstream's other toolbar button, is kept.
  - **The old conversation files** (`<data>/side-tutor/`) are deleted once, at the first start of the updated app, on the PC and on the server (`src/server/side-tutor-cleanup.ts`, called from `instrumentation.ts`). The owner chose deleting over converting. Copies inside a first-sync backup aren't touched.
  - **How:** the lesson screen's one `useSideThread` (upstream's hook, unchanged) is handed to the window. The hook holds one open conversation; the window keeps it on the step being asked about, reads the others from the hook's list, and reads once at load which answers are still being written. Nothing in upstream's engine is changed.
  - **Wording added while building, for the owner to review:** "Remove the passage" (the ✕'s tooltip). "Show in the lesson" on a quoted passage is upstream's.
- **Code:**
  - `components/side-tutor.tsx` (the window, the bubble, the sheet, and the conversations in them)
  - `src/core/tutor-view.ts` (the order of the conversations, the divider's words)
  - `components/side-tutor-window.ts` (which edges resize the window, and how far)
  - `components/side-tutor-dictation.tsx` (the Dictate button)
  - `components/phone/tutor-sheet-swipe.ts` (the phone sheet's swipe down and its slide away)
  - `components/chat.tsx`: the mount, "Ask" opening the window, and where upstream's card and markers are left out
  - upstream's, unchanged: `components/use-side-thread.ts`, `src/core/side-chat.ts`, `src/server/side-chat.ts`, `src/agent/side-chat.ts`, `app/api/chats/[id]/side-chats/**`
- **Tests:** the window's words and look, the conversations (through upstream's real hook, with a scripted server), its Dictate button, moving and resizing, the bubble's place, starting minimized and the morph: `tests/side-tutor-ui.test.tsx`; the order, the divider's words and the one-time cleanup: `tests/tutor-view.test.ts`; the resize rules and the morph's geometry: `tests/side-tutor-window.test.ts`; the phone sheet's background and text size: `tests/phone-layout.test.ts`; the phone sheet's swipe and slide (the rules, and the touch driver with scripted touches): `tests/tutor-sheet-swipe.test.ts`, and through the window in `tests/side-tutor-ui.test.tsx`. Upstream's own: `tests/side-chat*.test.ts`, `tests/use-side-thread.test.ts`.
- **Known limit:** when "Ask" is pressed on a passage of another step while an answer is still being written, that answer finishes on the server and shows a spinner until it lands; its words don't stream in meanwhile.
- **On a session another device holds** (cloud sync, a paired app only): the window closes to a greyed bubble that can't be pressed, at the lesson's bottom right. See "Slice 2" in `docs/cloud-sync.md`.
- **On a phone** (browser narrower than 640 px): a bubble above the message box opens the tutor as a bottom sheet. See "Phone layouts" in `docs/cloud-sync.md`.
- **On a phone: swipe down to minimize** (owner's choice from a live demo, option A of two: "handle and top bar"; the other was "anywhere on the sheet, the conversation too while it is at its top"). Shipped to both branches with the touch batch (the owner's word: "ship"); not yet confirmed on the owner's iPhone.
  - **Where it starts:** the handle strip at the sheet's top and the top bar ("Tutor"). Not on the conversation (it only scrolls), not on the typing row, and not on a button in the bar (the − button).
  - **The sheet follows the finger** downward, never above its resting place. The dim over the lesson fades with it (its opacity is 1 minus the share of the sheet's height it has moved).
  - **Letting go:** past a quarter of the sheet's height, or after a quick flick down (faster than 0.5 px/ms over the finger's last 80 ms, with more than 12 px moved), it slides away and the Tutor is minimized; otherwise it springs back in 200 ms.
  - **The − button and a tap on the dimmed lesson slide it away the same way** (they closed it at once).
  - **The slide:** only `transform` and the dim's `opacity` move; `max(130, 260 × the share of the height still to travel)` ms, the morph's easing (`cubic-bezier(0.2, 0.8, 0.2, 1)`). The sheet stays mounted while it goes; the bubble comes back when it is down, as on a computer when the window has folded.
  - **Unchanged:** opening (the 200 ms slide-up), and an answer being written carries on after minimizing as before.
  - **At once:** with reduced motion (a swipe still follows the finger and minimizes, with no slide), and when a session becomes held, also in the middle of a slide (it then ends minimized).
  - **Touch rules** (the iPhone's, "Touch and typing" in `docs/cloud-sync.md`): decided on the first movement, whose default is prevented from then on; the release speed comes from `releaseVelocity`, nothing if the finger had stopped; a second finger, or a cancelled touch, springs it back. A tap on the bar that doesn't move does nothing. A swipe that starts during the opening slide picks the sheet up where that slide had reached (the CSS slide is cancelled), so nothing jumps. A touch while it slides away does nothing.
  - **Read while building, for the owner to review:**
    - the sheet's two other ways of closing on a session that isn't held slide away too: a tap on a quoted passage ("Show in the lesson", which closes the sheet first) and Esc from a connected keyboard;
    - asked to open while it is still sliding away (the lesson's Ask is the only way left to do that), it springs back up and stays open;
    - a cancelled touch (`touchcancel`) springs back rather than deciding as a release would.
  - With the keyboard up, the typing box is blurred when the slide away starts (every way of minimizing on a phone, with reduced motion too), so the keyboard closes as the sheet slides down, and the app takes its full height back as for any text box that loses focus ("Closing the keyboard" in `docs/cloud-sync.md`). It used to go only when the box unmounted at the end; WebKit sends no blur for a removed box (whatwg/html#1569), so the app kept believing a box had focus. Found by a reviewer; `slideAway` in `components/phone/tutor-sheet-swipe.ts`.
  - **Only the owner's iPhone can confirm the feel:** Chromium has no rubber band, no iOS keyboard and no 120 fps touch timing.
  - `components/phone/tutor-sheet-swipe.ts` (the rules and the touch driver); `components/side-tutor.tsx` hooks it to the sheet, the dim and every way of minimizing.

## Notes drawer

The learner's own notes beside the lesson, stored as Markdown in their Obsidian vault.

### Design decisions (approved; change only with the owner's approval)

- **Private, always:** notes never reach a chat record, the teacher, the side tutor, compaction or graph extraction. The agents' file tools refuse the **notes folder only** (`<vault>/LearnHarness`) and `<data>/notes`. The rest of the vault stays readable like any other file.
- **One copy:** the vault file is the only copy. Obsidian and the drawer edit the same file; there's no sync.
- **Location and properties:** notes live in `<vault>/LearnHarness/`. Every frontmatter line is preserved; LearnHarness adds only:
  - `lh_sessions`: the sessions the note was edited in;
  - `lh_parent`: set on notes created by a split.
- **Organized by topic, not by session:** "This session" is a filter over the topic tree, using `lh_sessions`.
- **Long notes:** splitting is a **suggestion only**, never automatic. The banner appears at 800+ words or 4+ `##` sections (`LONG_NOTE_WORDS` / `LONG_NOTE_SECTIONS`).
- **Links only where the learner writes them:**
  - Split, extract and move never add links. A split's structure is shown by the folder, and `lh_parent` is plain text, not a link.
  - Existing learner links are rewritten so they still point at the right place.
  - Link suggestions are opt-in: an unlinked mention of another note's name gets a "link?" button, and nothing changes unless it's clicked.
  - Links to notes outside `LearnHarness/` open in Obsidian (`obsidian://open`).
- **Where new notes go:** the folder selected in the tree, otherwise the session's home folder, otherwise "Skip" files the note in `LearnHarness/Inbox/`. The first folder used becomes the session's home folder, stored in `<data>/notes/sessions/<chatId>.json` and never in the chat record.
- **Moving:** notes **and folders** can be dragged, and there's also "Move to…".
- **Dragging** (owner-approved design; it replaced the browser's drag and drop on the computer and an earlier phone drag):
  - **The row itself moves.** It follows the pointer up and down, and the other rows slide out of its way. A dragged folder moves with everything shown in it, as one piece.
  - **The list still sorts itself** (owner's choice over keeping a hand-made order): Inbox first, then folders A–Z, then notes A–Z. So a drag decides only **which folder** the item ends up in. After the drop the row slides to its sorted place.
  - **Where it lands:**
    - a gap among a folder's rows: that folder (the line is indented like them);
    - a gap at the top level, above Inbox too: outside every folder (the line isn't indented);
    - the middle half of a folder's row: inside that folder. The folder lights up after the line has rested on it for a moment, no gap stays open next to it, and the line tucks in from the left, a little smaller and see-through, so the folder's name stays readable;
    - the top or bottom quarter of a folder's row: next to the folder (rows part).
  - Under a folder's last row the gap could mean that folder or the level outside it: it means the one ahead of the line, and turning back clearly switches to the other.
  - **Nothing changes** when the line is put back among its own neighbours. Then, after a refused move (the reason shows in the message line) and on Esc, everything slides back.
  - **Limits:** the line stays inside the list (on a phone the divider under "Topics" is the upper limit). Pushing on against a limit reaches the first or last place. Near the list's top or bottom edge the list scrolls.
  - **Out of the bottom folder** (owner's ask): the line has one row of room below the list's end. Pulling the last row down by half a row takes it out of the folder it is in, and the line un-indents; from a folder inside a folder it steps out one folder at a time. Where the list fills its box and there is no room, pulling on against the limit does the same.
  - **Starting it:** on a computer, press a row and move (a press that doesn't move is still a click). On a phone, hold, then move (see "On a phone").
  - **Gone, by the owner's ask:** a box over the heading for "outside every folder", the lit area under the list, and a floating label with the item's name.
  - Search results can't be dragged.
- **Row menus** (right-click or ⋯ on a computer, press and hold on a phone):
  - a note: Open, Move to…, Split note… (when it has sections), Merge into parent (after a split), Open in Obsidian, **Delete**;
  - a folder: **New note**, **New folder**, Move to…, the session's home folder item, **Delete**. The owner's wording: no "here" after "New note" and "New folder"; the folder you opened the menu on says where.
- **Deleting** (owner's choices): Delete is the last item of both menus, in red.
  - **For good:** no Undo and no trash folder. With Obsidian Sync the way back is Obsidian → Settings → Sync → Deleted files.
  - **A confirm box first.** A folder is deleted **with everything in it**, and the box says how much. The wording (`deleteConfirmText` in `src/core/notes.ts`, with the drawer's curly quotes):
    - a note: `Delete “Electricity”?` / "This removes it from your Obsidian vault for good."
    - a folder with something in it: `Delete “Physics” and everything in it?` / "This removes 3 notes and 1 folder from your Obsidian vault for good." Files that aren't notes are counted too: "…, 1 folder and 2 other files", or just "2 files" when there is nothing else.
    - an empty folder: `Delete “Physics”?` / "This removes the folder from your Obsidian vault for good."
    - Buttons: Cancel, Delete (red).
  - **No line about links** to the deleted note (the owner declined it). Links to a deleted note are left as written.
  - The open note closes when it is deleted or sits in the deleted folder. Its unsaved typing is dropped, never saved back.
  - A session whose home folder is deleted has no home folder again.
  - The notes folder itself can't be deleted.
  - Afterwards the drawer's message line reads `Deleted “Electricity”.` for 5 seconds (the wording was added while building; the owner has seen it and asked only for it to go sooner).
- **The message line** at the bottom of the drawer ("Moved …", "Deleted …", a split's "… Undo", the reason a move was refused) goes by itself (owner's choices; every message used to stay 20 seconds, which was "way too long"):
  - **after 5 seconds**: every message without an Undo button, so "Moved …", "Deleted …" and the ones that say why something didn't happen;
  - **after 20 seconds**: a message with **Undo** (a split, a merge, a selection moved to a new note), because that button is the only way to undo;
  - its ✕ closes any of them at once.
  - `notesMessageMs` in `components/notes/notes-drawer.tsx`.
- **Editor:** CodeMirror for editing (sections fold while typing), plus a Read view with formatted math, folding, clickable links and images. The editor follows the chosen theme's light or dark mode live (`editorTheme(mode)`), and the drawer's colours are theme tokens.
- **Where it appears:** both **teaching and practice** sessions.
- **On a phone:** the drawer fills the screen and shows the list, then the note. Rows open their menu on press and hold; holding and then moving the finger drags the row into a folder. See "Phone layouts" in `docs/cloud-sync.md`.
- **On the cloud server:** the vault is connected in Settings → Obsidian instead of by a folder path, and the drawer says when the notes aren't syncing with Obsidian. See "Obsidian vault on the VPS" in `docs/cloud-sync.md`. The desktop app's drawer is unchanged.
- **Extras:**
  - Math in Read view.
  - Pasted images go to Obsidian's `attachmentFolderPath`, or `LearnHarness/attachments` when that isn't set.
  - Shortcut: Ctrl+Shift+N opens the drawer with the cursor in the open note's editor (the note switches to its edit view), and closes it again. With no note open the cursor lands in the search box. The Notes chip opens the drawer without moving the cursor. Ctrl+Shift+E used to jump into the editor; since the 0.6.0 merge it is upstream's Drawing Pad shortcut (owner's decision).
  - **Vault offline:** edits are held in `<data>/notes/pending/` and written when the vault is back. A note changed meanwhile isn't overwritten; the offline version becomes "(offline copy)".
- **Linked from:** the drawer lists the notes that link to the open note.
- **Deleting a session** keeps its notes and drops only its home-folder record.
- **Not built (yet):**
  - Renaming notes inside the drawer (rename in Obsidian, which updates links).
  - Embedding one note in another (`![[note]]`).
  - Blocking vault files from the existing notes import into the graph.

### Behavior details

- **Edits in Obsidian:** the drawer polls the tree (4 s) and the open note (2.5 s). An Obsidian edit loads automatically unless there's unsaved drawer typing; then it shows "Load Obsidian's version / Keep mine". Saves send the hash the editor loaded; a different file on disk returns 409 and is never overwritten.
- **Split:** `Name.md` becomes `Name/Name.md` (the summary: intro plus the sections left unchecked) and one note per chosen section. Already a summary? The children join its folder. `[[Name#Section]]` links are rewritten to `[[New note]]`.
- **Related actions:** "Move section to new note" (from Read view headings), "Extract selection to new note", and "Merge into parent" (the reverse of a split; the folder folds back when only the summary is left).
- **Undo:** split, merge and extract record undo snapshots, kept in memory for 30 minutes.
- **Moves:** link rewriting covers path-style wiki links and relative Markdown links. Name-style `[[Name]]` links are left alone because Obsidian resolves them by name. Session home folders follow a moved folder.
- **Delete:** `notesStore.remove` deletes the note, or the folder with everything in it. No link is changed.
  - Edits that were waiting for an offline vault are dropped for every note that went, so a deleted note can't come back.
  - Home-folder records that point at or into a deleted folder are removed.
  - Refused: the notes folder itself, an item that no longer exists, and anything that resolves outside the notes folder (a folder link, for example).
  - `notesStore.contents` counts what a folder holds for the confirm box; hidden (dot) entries aren't counted, but they go with the folder.
  - On the cloud server the route then tells the sync manager (`notesChangedHere`), so its safety check doesn't take a clear-out made in the drawer for the notes going missing. See "Keeping sync safe" in `docs/cloud-sync.md`.
- **Agent file tools:** `privateNotesRoots()` in `src/agent/tools/fs-shared.ts` re-reads `<data>/notes/settings.json` on every resolution or walk (agents never import the notes store). Paths are compared case-insensitively, by both their named and canonical (real) path. `resolveSourcePath` refuses with a specific message, and walks skip the folder.

### Code map

- `src/core/notes.ts`: pure logic (names and paths, properties, sections, links and resolution, backlinks, link suggestions, split and merge planning, attachment folder), exported through the core barrel.
- `src/store/notes.ts`: vault I/O, the tree with an mtime cache, save with a conflict check, create, move, delete, split, merge, extract, undo, pending edits, attachments and asset lookup, and session home folders. Dynamic fs paths carry `/* turbopackIgnore: true */`.
- `src/server/notes.ts`: HTTP responses for the routes below.
- **Routes:**
  - `app/api/notes` (GET tree; POST actions: vault, create, folder, contents, delete, move, split, merge, extract, undo)
  - `app/api/notes/file` (GET / PUT body)
  - `app/api/notes/attachment`
  - `app/api/notes/asset`
  - `app/api/chats/[id]/notes` (home folder)
- **`components/notes/`:**
  - `notes-drawer.tsx`: the panel, state, saving and polling;
  - `notes-tree.tsx`: tree model, the rows and their pointer events, row menus;
  - `row-drag.ts`: the dragging rules (the dragged block, where the gap opens, which folder a gap means, the folder's middle band, the limits);
  - `row-drag-dom.ts`: the movement (measures the rows, moves them frame by frame, settles, and slides every row to its sorted place after the move);
  - `note-editor.tsx`: CodeMirror;
  - `note-read-view.tsx`;
  - `notes-dialogs.tsx`: Move to, Split, Delete, name prompt, built on upstream's HostDialog since the 0.6.0 merge (same look, words and buttons); the row menus are a `PointMenu` on upstream's interaction layers (`notes-tree.tsx`);
  - `notes-api.ts`.
- **Wiring:** `components/chat.tsx` (Notes chip and drawer mount; `landInEditor` when the shortcut opened it), `src/core/keyboard.ts` (`toggle-notes`), and `src/server/chats.ts` (session deletion hook).
- **Tests:** `tests/notes-core.test.ts`, `notes-store.test.ts`, `notes-privacy.test.ts`, `notes-ui.test.tsx`; the dragging rules: `tests/notes-row-drag.test.ts`; the phone's hold-then-move touch rules: `tests/phone-hold-drag.test.ts`.

## Claude Code: Fable in the model list

- The Claude Code (CLI billing) list is upstream's three aliases (`opus`, `sonnet`, `haiku`, which the CLI resolves to the newest of each) plus a fork entry, **Claude Fable**, listed as `fable` to match them (owner's ask). The CLI has no such alias, so `claudeCliModel` (`src/agent/claude-code/constants.ts`) passes the full id `claude-fable-5-2` to `claude --model`.
- The model menus keep the Claude Code models together at the bottom, alphabetically (`compareModels` in `components/settings/model-menu.tsx`); everything else stays alphabetical by id. Upstream sorted only by id, which put haiku, opus and sonnet at the bottom by chance and fable near the top.
- Whether a Claude plan can use Fable through Claude Code is up to Anthropic; if not, the CLI's error shows in the lesson.
- Code: `src/agent/claude-code/provider.ts` (`CLAUDE_CODE_MODELS`). Tests that pin the list: `tests/claude-code-provider.test.ts`, `model-catalog.test.ts`, `claude-code-usage.test.tsx`, `claude-code-opt-in.test.ts`; the order: `tests/phone-layout.test.ts`.

## Development notes

- CI uses Node 26 with npm 11. Use npm 11 for lockfile changes (`npx npm@11 install …`); npm 10 rewrites the lockfile's `libc` fields.
- A local `npm run build` needs network access to Google Fonts (next/font).
- On Node 22, `tests/subscription-auth.test.ts` has one failure that also happens without any fork changes (a Node-version difference).
