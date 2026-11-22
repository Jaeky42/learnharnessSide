# The side tutor

## The window and the bubble

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
  - **A cloud sync strip under the top bar** (a paired app only) doesn't move the window: the window may cover the strip (owner's decision). Since seamless sessions the strip is a floating box, centred at the top of the lesson and drawn under the Tutor (`z-20` against `z-30`); the window may cover it as before.
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
- **Since seamless sessions (shipped):** the Tutor is the same on every session. The `held` prop is gone; the first character typed in the Tutor's box, a press on its Dictate, and Ask or Retry move the session to this device first ("Seamless sessions" in `docs/cloud-sync.md`).

### Rulings, limits and open items

#### From the third round after Phase 4

- The 20 px above the bar is a reading of "a little higher up"; the owner may want it tuned (`BUBBLE_BAR_GAP` and `BUBBLE_EDGE_GAP` in `components/side-tutor.tsx`).

## Words and look

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

### The owner's decisions and approved words

- **The window's words** (owner's wording): "Tutor" in the top bar, "Stuck on a term or a step? Ask here." while it is empty, and "Ask a follow-up…" as the typing box's hint. Nothing else: no tagline, and no explanation of what the tutor can see.

### Rulings, limits and open items

#### From the fourth round after Phase 4 (the window's look and resizing)

- Before that, the owner had seen before-and-after screenshots (computer and phone). The shade is the owner's pick (black at 60%; 70% was too black). The hint's size (14 px) is a reading of "slightly smaller".

## Speaking to the tutor

- **Speaking to the tutor** (owner's ask): a Dictate button (a microphone) sits right of the typing box, before Send. While it listens, a small live waveform and a red Stop take its place. The words land in the tutor's typing box when the run ends.
  - It borrows the page's one recorder (`components/dictation.tsx`): the same microphone, Deepgram key, language and waveform as the lesson's Dictate. Since the 0.6.0 merge it uses upstream's own hand-over: the button starts a run for its own destination (`toggleFor` with `SIDE_TUTOR_DICTATION_ID`), and the recorder delivers the words there. The fork's earlier claim hooks and `side-tutor-dictation-state.ts` are gone.
  - While the tutor's run is live, the lesson's own Dictate shows no run and is greyed (upstream's rule for a recorder that is busy elsewhere), and the lesson's message box doesn't take the words or the focus.
  - The button shows only an error of its own run, as upstream's views do.
  - Send while still listening ends the run first, then asks with the spoken words. Esc cancels the run (the words are dropped), as in the lesson; a second Esc minimizes. Minimizing ends the run and keeps the words.
  - The button is off while the lesson itself is dictating. Without a Deepgram key it says so, and a click opens Settings → Keys, as the lesson's Dictate does.
  - **On a phone a failed run says why** (owner's choice; "Footer row" under "Phone layouts" in `docs/cloud-sync.md`): the reason of the Tutor's own run shows for 5 seconds in the sheet's line above the typing box (the line a refusal uses), and the mic is in the theme's error colour until the next tap. On a computer the window is unchanged (the reason is the button's tooltip).

### Rulings, limits and open items

#### From the third and fourth rounds after Phase 4

- **The tutor's dictation has never met a real microphone or Deepgram**: it was run with Chromium's made-up microphone and a stand-in for Deepgram's socket in the page. It reuses the lesson's dictation run unchanged, so the likeliest surprises are in the hand-over (who gets the words, the lesson's bar staying idle), not in the audio.
- The owner didn't say which pieces they tried, so the tutor's dictation with a real microphone is still not confirmed one way or the other.

## The Tutor on upstream's side conversations

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
  - **Stopped and failed:** a stopped answer keeps its words and says "Stopped." A failed one shows upstream's reason in the theme's error colour, then a link, "Retry". A refusal before anything was saved (no model set up, for example) shows in the line above the typing box, and the question comes back into the box.
  - **One answer at a time:** while one is being written, Send is Stop.
  - **Before the teacher has said anything** the window shows its empty sentence and the typing box is off.
  - **The hint is always "Ask a follow-up…".** Upstream's other hints aren't used.
  - **Not shown:** upstream's own card, its pinned column, the "?" markers under each step and Ctrl+J. Their components stay in upstream's files, unused, so later releases merge cleanly. Cite, upstream's other toolbar button, is kept.
  - **The old conversation files** (`<data>/side-tutor/`) are deleted once, at the first start of the updated app, on the PC and on the server (`src/server/side-tutor-cleanup.ts`, called from `instrumentation.ts`). The owner chose deleting over converting. Copies inside a first-sync backup aren't touched.
  - **How:** the lesson screen's one `useSideThread` (upstream's hook, unchanged) is handed to the window. The hook holds one open conversation; the window keeps it on the step being asked about, reads the others from the hook's list, and reads once at load which answers are still being written. Nothing in upstream's engine is changed.

### Rulings, limits and open items

- **Wording added while building, for the owner to review:** "Remove the passage" (the ✕'s tooltip). "Show in the lesson" on a quoted passage is upstream's.
- **Known limit:** when "Ask" is pressed on a passage of another step while an answer is still being written, that answer finishes on the server and shows a spinner until it lands; its words don't stream in meanwhile.

## On a phone

- **On a phone** (browser narrower than 640 px): a bubble above the message box opens the tutor as a bottom sheet. See "Phone layouts" in `docs/cloud-sync.md`.
  - **While the iPhone keyboard is up** (owner's asks): the bubble is hidden and comes back when the keyboard closes, and the sheet's typing row sits 8 px above the bottom of the visible area, without the 34 points kept for the home bar. See "With the keyboard up the question gets the room" under "Phone layouts" in `docs/cloud-sync.md`.
  - **A tap on Dictate, Ask, Stop or a waiting passage's ✕ while typing keeps the keyboard up** (owner's decision for every control beside the box being typed in; "A tap with the keyboard up" under "Touch and typing" in `docs/cloud-sync.md`). The typing row and the passage row carry `data-phone="tutor-typing"` for it.
  - **In the home-screen app the bubble's place allows for the taller top bar** (148 points, not 60), so with an opened question it sits under the top bar, not on its buttons.
- **On a phone: swipe down to minimize** (owner's choice from a live demo, option A of two: "handle and top bar"; the other was "anywhere on the sheet, the conversation too while it is at its top"). Shipped to both branches with the touch batch (the owner's word: "ship"); not yet confirmed on the owner's iPhone.
  - **Where it starts:** the handle strip at the sheet's top and the top bar ("Tutor"). Not on the conversation (it only scrolls), not on the typing row, and not on a button in the bar (the − button).
  - **The sheet follows the finger** downward, never above its resting place. The dim over the lesson fades with it (its opacity is 1 minus the share of the sheet's height it has moved).
  - **Letting go:** past a quarter of the sheet's height, or after a quick flick down (faster than 0.5 px/ms over the finger's last 80 ms, with more than 12 px moved), it slides away and the Tutor is minimized; otherwise it springs back in 200 ms.
  - **The − button and a tap on the dimmed lesson slide it away the same way** (they closed it at once).
  - **The slide:** only `transform` and the dim's `opacity` move; `max(130, 260 × the share of the height still to travel)` ms, the morph's easing (`cubic-bezier(0.2, 0.8, 0.2, 1)`). The sheet stays mounted while it goes; the bubble comes back when it is down, as on a computer when the window has folded.
  - **Unchanged:** opening (the 200 ms slide-up), and an answer being written carries on after minimizing as before.
  - **At once:** with reduced motion (a swipe still follows the finger and minimizes, with no slide), and when a session becomes held, also in the middle of a slide (it then ends minimized).
  - **Touch rules** (the iPhone's, "Touch and typing" in `docs/cloud-sync.md`): decided on the first movement, whose default is prevented from then on; the release speed comes from `releaseVelocity`, nothing if the finger had stopped; a second finger, or a cancelled touch, springs it back. A tap on the bar that doesn't move does nothing. A swipe that starts during the opening slide picks the sheet up where that slide had reached (the CSS slide is cancelled), so nothing jumps. A touch while it slides away does nothing.
  - With the keyboard up, the typing box is blurred when the slide away starts (every way of minimizing on a phone, with reduced motion too), so the keyboard closes as the sheet slides down, and the app takes its full height back as for any text box that loses focus ("Closing the keyboard" in `docs/cloud-sync.md`). It used to go only when the box unmounted at the end; WebKit sends no blur for a removed box (whatwg/html#1569), so the app kept believing a box had focus. Found by a reviewer; `slideAway` in `components/phone/tutor-sheet-swipe.ts`.
  - `components/phone/tutor-sheet-swipe.ts` (the rules and the touch driver); `components/side-tutor.tsx` hooks it to the sheet, the dim and every way of minimizing.

### Rulings, limits and open items

#### From the fourth round after Phase 4 (the window's look and resizing)

- The owner asked why the phone's sheet wasn't see-through: the dim behind it covered the whole screen. It now covers only the lesson above the sheet. Shown as a screenshot; not confirmed on the iPhone, where the blur behind a sheet that slides in is the thing to look at.

**On a phone: swipe down to minimize**

- **Read while building, for the owner to review:**
  - the sheet's two other ways of closing on a session that isn't held slide away too: a tap on a quoted passage ("Show in the lesson", which closes the sheet first) and Esc from a connected keyboard;
  - asked to open while it is still sliding away (the lesson's Ask is the only way left to do that), it springs back up and stays open;
  - a cancelled touch (`touchcancel`) springs back rather than deciding as a release would.
- **Only the owner's iPhone can confirm the feel:** Chromium has no rubber band, no iOS keyboard and no 120 fps touch timing.

## Code map and tests

- **Code:**
  - `components/side-tutor.tsx` (the window, the bubble, the sheet, and the conversations in them)
  - `src/core/tutor-view.ts` (the order of the conversations, the divider's words)
  - `components/side-tutor-window.ts` (which edges resize the window, and how far)
  - `components/side-tutor-dictation.tsx` (the Dictate button)
  - `components/phone/tutor-sheet-swipe.ts` (the phone sheet's swipe down and its slide away)
  - `components/chat.tsx`: the mount, "Ask" opening the window, and where upstream's card and markers are left out
  - upstream's, unchanged: `components/use-side-thread.ts`, `src/core/side-chat.ts`, `src/server/side-chat.ts`, `src/agent/side-chat.ts`, `app/api/chats/[id]/side-chats/**`
- **Tests:** the window's words and look, the conversations (through upstream's real hook, with a scripted server), its Dictate button, moving and resizing, the bubble's place, starting minimized and the morph: `tests/side-tutor-ui.test.tsx`; the order, the divider's words and the one-time cleanup: `tests/tutor-view.test.ts`; the resize rules and the morph's geometry: `tests/side-tutor-window.test.ts`; the phone sheet's background and text size: `tests/phone-layout.test.ts`; the phone sheet's swipe and slide (the rules, and the touch driver with scripted touches): `tests/tutor-sheet-swipe.test.ts`, and through the window in `tests/side-tutor-ui.test.tsx`. Upstream's own: `tests/side-chat*.test.ts`, `tests/use-side-thread.test.ts`.
