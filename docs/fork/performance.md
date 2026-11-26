# Long sessions: the performance audit and what was built from it

## What the audit found

The owner's report: the app lags when a session gets long, on the Windows app, the iPhone and the iPad. What lags: scrolling a long lesson, opening one, and coming back to the app after a while. Not reported: typing, a choppy stream, or a wait after Send. Later added: lessons where Drawing Pad pictures were sent to the teacher are worse.
Measured on a production build in headless Chromium, against synthetic sessions made by repeating the golden test lesson (95 messages): 475, 950 and 2,850 messages. "4×" is a CPU slowdown standing in for a phone. Nothing was measured on the owner's devices or data.

- **A lesson keeps every message in the page.** 4,600 elements at 95 messages, 45,200 at 950, 135,000 at 2,850. Every wheel or touch event makes the browser search them (hit-testing: 0.4 ms per event at 95 messages, 3–4.6 ms at 950).
- **Opening**: the page is rendered whole on the server and also carries every message as data (7.1 MB of page for a 3.8 MB session), and is hydrated in one task. Time until the page reacts: 1.7 s at 95 messages, 13.6 s at 950 (28.6 s at 4×).
- **Any state change in the lesson screen re-rendered the whole transcript**: 16 ms at 95 messages, 300 ms at 950.
- **On paired devices that happened every 10 seconds**: the lesson screen read who holds its session from the whole sync status, which changes at every round (`lastContactAt` on a PC, a holder's `lastSeenAt` on the server's site). Measured with a control, a minute after opening: one freeze per poll, 277–434 ms (1.2–2.4 s at 4×); none when the status didn't change.
- **Coming back**: when the events channel reconnects, 9–16 requests land together, several replaced state with identical data, and where sync is in use the whole record was downloaded again: one 0.9 s task at 950 messages (5.3 s at 4×).
- **The server re-read whole session files for almost everything**: about 11 parses to open one session; the session list parsed every file; three components downloaded the whole record for one field; the stale-job sweep (every 30 s while a lesson is open) parsed a session once per job file ever written: 0.14–1.9 s per sweep in one test library, about 15 s in another.
- **A session file never shrinks.** Compaction bounds what the model gets, not what is stored, read, sent or rendered.
- **Sync** uploads the whole session file on every change (12.6 MB where two consecutive saves differed by 932 bytes), about 3 times per plain turn.
- **Pictures** are stored inside the record as base64 (a half-page drawing from an iPad: about 114 KB), so they ride along on every read, save, download and model request. And compaction threw on a learner message that carries a picture.
- **Found fine:** typing, the tab-indented file format (60 ms against 57 ms at 11.5 MB), sync's per-request checks, the fork's scroll and touch helpers (flat per event), the Tutor, the home graph.

## The owner's decisions

1. **Compaction with pictures is fixed in the fork** (the fault is upstream's), not left for an upstream release.
2. **`[drawing attached]`** is what the summarizer is given in place of a picture, once per picture: after a learner message's text, and in place of a picture inside a tool result (a drawing sent as an answer). The owner chose this wording knowing it also appears for a picture that isn't a drawing.
3. **Reasoning signatures are left out of what the browser receives** (`thinkingSignature` on thinking blocks: about 24% of a record's bytes). The stored file, sync and the model replay are unchanged. A plugin's front end, which is handed the lesson's messages, no longer sees them.
4. **The browser may skip drawing off-screen messages**, tried in the app with a temporary off switch (the owner's pick of three ways to try it). After trying it on the iPhone and the iPad the owner kept the rule and had the switch removed.

**The owner's word after trying it: "the performance is fine, id only want changes that have zero behavior impact".** So nothing in "Not built (the audit's other recommendations)" below is asked for, and anything from that list that changes what the app does or shows is off the table unless the owner raises it: opening with only the recent part, pictures decoded lazily (a picture could show a moment late), and the editor and the Tutor loaded on demand (a first opening could wait). With no visible change at all: the per-message component (a large edit of upstream's lesson screen), the sync upload's duplicate work, the graph layout off the request thread and the activity feed's scan (all three on the server).

## What was built

### Step 1 (no change in what the app does or shows)

- **Compaction** (`src/core/compaction.ts`, `src/server/compaction.ts`): `serializeForSummary` reads a learner message's text whatever its shape and adds the marker per picture; a picture in a tool result becomes the marker in place of its base64. Preparing the summary sits inside `compact()`'s try, so a failure there is logged and the lesson carries on uncompacted, as for a summarizer failure; `kickCompaction` can't leave an unhandled rejection. Before, the throw reached `handleChatInput`, so Send would have failed once such a session passed its threshold (read from the code; not run with a model).
- **One field at a time** (`app/api/chats/[id]/route.ts`): `GET /api/chats/<id>?only=coverage | settings | turns | stamp`. Upstream 0.7.0's `?view=stats` is answered as `?only=turns` (the same `{ turns, pricing }` body and 404; `FORK (perf round)` in the route), so both spellings work; the lesson reads usage through `readUsage`, and upstream's `readStats` stays in `components/session-core.ts` for upstream's test. The coverage ring, the model picker and the usage read (`syncTurns`) use them. An unknown value answers 400; the `only` answers never reconcile a plugin question and never write.
- **The stamp** (`src/server/browser-stamp.ts`, one function for the full GET, `?only=stamp` and the page's `initialStamp`): the chat file's stat (`chatStamp` in `src/store/chats.ts`: inode, size, modified and changed times; no read) plus a digest of the four values a full read gives the page that are not in the file: `turnError`, the two plugin availabilities and `pricing`.
  - **No stamp (null) while a plugin question is pending or a plugin problem is active**: those sessions always do the full read, as before.
  - The stat is taken before the file is read, so a write landing in between gives an older stamp with newer content, and the page reads once more.
- **The sync catch-up read** (`components/chat.tsx`, `components/session-core.ts`): when it runs is unchanged (sync in use; one second after a lesson opens; at every reconnect; not during a stream or a turn). It now asks for the stamp and does the full read only when the stamp differs, is unknown, or the check fails.
  - The page knows a stamp only while its messages, error and plugin availabilities are the very objects that stamp was taken for (`knownStamp`); any stream, append, replace or error forgets it. A needless full read is the old behaviour; a wrong skip would be a fault.
  - On a skip it still runs the owed-continuation check.
  - **Usage not read yet is no reason for the full read** (`catchUpRead` in `components/session-core.ts`). On a slow device the catch-up fired before the mount's usage read had landed, and downloaded the whole record (4 of 4 runs at 4×, 950 messages). Now an unchanged stamp waits for the usage read under way, or starts one (`?only=turns`), then runs the continuation check. A usage read that leaves no figures still ends in the full read. The read after a turn settles always starts afresh; only the catch-up waits for one under way. Unit-tested; not measured again in a browser.
- **No state change for the same data**: the jobs list, the Tutor's threads, the session list and the usage figures (`sameJsonValue`). The jobs fetch still runs its settle detection every time.
- **The lesson no longer reads the whole sync status** (the state lives in a small store read through `useSyncExternalStore`, `components/cloud/cloud-state.tsx`). This step had the lesson read only whether its own session is held (`useSessionHeld`); since seamless sessions the lesson screen reads nothing about it while it renders (a move reads the cloud state's `held` only when it starts, `components/cloud/session-move.ts`), and `useSessionHeld` stays in `cloud-state.tsx`, tested. `useCloud()` and `useSyncTrouble()` behave as before for the floating box, the chip and the discard box.
- **Less to the browser**: `withoutThinkingSignatures` (`src/core/browser-record.ts`) on the full GET and on the page's `initialMessages`. It builds new objects only for the blocks that carry the field.
- **The session list** (`src/store/chats.ts`): each file's summary is remembered until its stat changes. A failed read is never remembered.
- **The stale-job sweep** (`src/server/jobs.ts`, `src/store/jobs.ts`): no session parse per job (the outer `listChats` loop already proves the session exists); the job store remembers which session a job file belongs to and reads only that session's files.
- **Rendering**: the active-practice-problem scan reads a per-history index (`ProblemIndex` in `src/core/native-messages.ts`), cached only for the browser's frozen histories; `transformMathDelimiters` and `repairMathForDisplay` (`src/core/math-delims.ts`) keep bounded string-keyed results and don't store a string that only extends the previous one (a streaming reply).
- **Notes** (`src/core/notes.ts`): `computeBacklinks` builds its link lookup once per call. Not about session length: it was 1 s per 4-second refresh at 1,000 linked notes.

### Rulings, limits and open items

#### Rulings made while building (for the owner to review)

- **A picture attached to a practice "thinking" note leaves no trace in a summary**, as before. The marker was decided for two places; this third one was left as it is.
- **The off-screen rule is narrower than the one the audit measured** (which was every direct child of the transcript). Its gain was measured again; see "Measured" in `docs/fork/history/performance.md`.
- **The jump fix does more than the plan's sentence** ("draw the target message, measure, check once a frame later"): it also draws the skipped messages around the target, and waits for the layout to settle (up to 20 frames) before its one check. Both came from the browser runs.
- **700 px, not 1,000 px, for the assistant's messages on a phone** (under "The off-screen rule" below). The plan named 1,000.
- **The glide's rule is shaped differently from the description the owner approved** ("a shift that comes together with the lesson's height changing by the same amount"). Recorded frame by frame, the shift is a rise, and what ended the glide was the smooth scroll's return from it a frame or two later, with the height unchanged. So the rule has a 100 ms allowance after a rise and a "stopped dead" check; the intent is the same. The owner has been told.
- **No diagram cache.** One was built and removed after review: mermaid queues renders but applies its configuration at once, so a quick theme switch could leave a chart drawn in the wrong theme in the cache. `components/mermaid-render.ts` is upstream's, unchanged.
- **Whole parsed sessions are not kept in the server's memory between requests.** It would save the most parsing, but any code that modifies a session it was handed would corrupt the shared copy.
- **`?only=stamp` reads the session once on the server.** It saves the download and the page's work, not the server's parse.
- **One existing test's clean-up waits 10 ms** (`tests/cloud-notices-ui.test.tsx`): a closed dialog hands the focus back from a zero-delay timer, and the sync status now updates a few microtasks earlier, so that timer could land in the next test.

## The off-screen rule

- `app/offscreen.css` (fork-owned, unlayered): `content-visibility: auto` on the **older** learner's rows and assistant's messages directly in the transcript column (`[data-session-find-root] > [data-testid="user-message"][data-older-transcript-row]`, `> .is-assistant[data-older-transcript-row]`). Every message stays loaded and in the page; only layout and painting of off-screen blocks is put off.
- **The newest turn is always drawn** (owner's decision at the 0.7.0 merge, decision 6; the audit's own rule skipped every message). Upstream 0.7.0 has its own off-screen rule: `components/chat.tsx` sets `data-older-transcript-row` on every row before the newest learner turn (`newestLearnerTurnFrom` in `components/transcript-rows.ts`, which skips a background delivery or an abort and counts a message with text or a picture), and `app/globals.css` gives those rows `content-visibility: auto` with a flat `800px` estimate. The newest learner turn, and the part of the lesson still being written, never carry the attribute, so they are never skipped. The fork's rule now requires that attribute too, which gives the same exemption. Older rows keep the fork's per-kind estimates below, and the jump fix.
  - **The specificity order:** upstream's `[data-older-transcript-row]` has the weight of one class; the fork's per-kind rules three (`[data-session-find-root] > .is-assistant[data-older-transcript-row]`: the root's attribute, the class and the attribute), so on older rows the fork's estimates win over the flat 800 px; the draw override for jumps (with `[data-lh-draw]` added) has four and wins over both.
  - **Pinned by `tests/offscreen-rule.test.ts`:** every selector of the sheet requires the attribute; the two orders above; a pin on upstream's attribute name in `components/chat.tsx` and `app/globals.css`, so a rename fails a test instead of switching the rule off silently. `tests/offscreen-target.test.ts` keeps the jump helper's selectors equal to the sheet's and has a jump into the newest turn.
  - **Run since the merge:** the lesson's load position, which turned out to stop short of its resting point in Chromium; the cause and the fix are under "Known faults with the rule on" below and in `docs/fork/lesson.md`, "Rest on open". Find (20 of 20 steps on screen) and a link to a message (10 of 10) were run on the test lessons.
  - **Still not run:** that the newest turn and a streaming reply are drawn with no jump when a turn ends and the attribute moves to the next rows; the scrollbar; the glide and a jump into a skipped message on a lesson of hundreds of messages. The size measurements below were taken before the exemption.
- **Size estimates per kind** (`contain-intrinsic-size: auto …`): 60 px for the learner's rows (100 px in the phone layout), 700 px for the assistant's messages on every width. They are the mean heights measured in the 950-message test lesson. A message drawn once keeps its real height ("auto").
  - The first build had a flat 600 px for both: the scrollbar started 37% too long on a computer. With these: 4% too long on a computer, 32% too short at iPhone size.
  - **Not 1,000 px for the assistant on a phone** (the plan's number, its mean there): with it a lesson opened 38 px short of its bottom at iPhone size, 3 of 3 loads; with 700 px, 0–1 px in 20 of 20.
  - **Lower estimates don't help**: 44 / 140 px (below most real heights) was tried against the scroll faults below and did worse (the glide failed 14 of 30 at iPhone size; the scrollbar started 63–70% short).
- **Not** on phase dividers, cards and placeholders (a message-sized estimate would inflate the scrollbar), and the dock spacer is a sibling of the column.
- On by default on every device, the desktop app included.
- **No switch.** The trial had one (`?offscreen=off` in the address set `data-lh-offscreen="off"` on `<html>` from the head script in `app/layout.tsx`, and every rule sat under `html:not([data-lh-offscreen="off"])`). It is removed: the head script is upstream's line again, the rules name the messages directly, and the jump helper no longer looks for the attribute. To compare with the rule off in a browser run, inject a stylesheet that sets `content-visibility: visible` on the two selectors.

### Jumps into a message that isn't drawn

- **The fault** (found by the browser checks of the first build): inside a skipped message a passage measures as zeros (`Range.getBoundingClientRect()`), so upstream's `scrollSessionTarget` scrolled nowhere near it. The app's Find showed the match in 1 of 14 steps, the Tutor's "Show in the lesson" landed in 1 of 3 tries. A link to a message (the hash) was fine: the message's own box has its estimate.
- **The fix** (owner's choice, over leaving the rule off by default and over removing it): `components/offscreen-target.ts`, called from one edited place in upstream's `components/session-navigation.tsx` (`scrollSessionTarget`; its loop moved into `placeSessionTarget`). Every jump goes through it: Find, citations and the Tutor's quotes, links to a message.
  - Before the jump measures, the target's message gets `data-lh-draw`, which the stylesheet answers with `content-visibility: visible`. So do the skipped messages the jump brings on screen, and those up to two window heights above (the browser draws those by itself a few frames later, and without scroll anchoring their real heights would move the passage: about 440 px in the stand-in run).
  - Once the passage and the lesson's height have been still for 3 frames (at least 4 frames, at most 20), the passage is measured again and put back **once** if it moved. Then the attribute comes off; with no frame for 1 s (a hidden tab) it comes off anyway.
  - **Not after the learner's own input**: a wheel, a touch, a press or a scrolling key anywhere on the page, or another jump, cancels the check. It listens on the whole page because a wheel or a drag on the dock scrolls the lesson from script (the first version listened on the lesson only, and a wheel over the dock was undone 9 of 9 times).
  - An attribute, not an inline style: Find re-reads every match when a style in the lesson changes, which cost two tasks of about 270 ms per step.
  - It does nothing when no message near the passage is skipped (so also in a browser that doesn't know the rule), and in the tests' DOMs.

### Rulings, limits and open items

#### Known faults with the rule on

- **Scroll anchoring is what makes the rule comfortable.** When a message above the screen takes its real height, Chromium moves the scroll position so the view stays still. With anchoring switched off (a stand-in for a browser without it), scrolling up through never-drawn messages gave 226 layout shifts on a computer (largest 797 px) and 274 at iPhone size, against 1 and 8 with the rule off. Whether the owner's Safari anchors could not be confirmed from here.
- **The fork's glide to the bottom** (touch: a tap on the folded question from far up) took the browser's shift for the learner stopping it: 4 of 40 runs at iPhone size stopped 12.7k–23.5k px short, the question still folded. **Fixed** (owner's choice): the glide's rule now tells the two apart, and 60 of 60 glides arrived with the rule on. The rule, its numbers and its limits are item 6 under "A tap on the folded question ends at the bottom, open" in `docs/fork/phone-and-tablet.md`.
  - **The glide is slower with the rule on:** a median of 3.5 s against 2.1 s off, from 9,400 px up, because the bottom keeps moving as messages take their real height and the glide is aimed again twice.
- **The computer's slide to the bottom, and a lesson that opens short of its resting point** (upstream's `use-stick-to-bottom`): 2 of 50 runs stopped far short in the first two rounds, 0 of 100 in the third; 0 with the rule off throughout. Later runs of the merged build found the same fault at load: a lesson opened 12 to 135 px above its resting point and stayed there, on ordinary lessons since the performance round and on check lessons too since the newest-turn exemption.
  - **The cause, measured:** when an older row above the screen takes its real height and is shorter than its estimate, scroll anchoring lowers `scrollTop`. The library's scroll handler takes a decrease for the learner scrolling up unless its one shared `resizeDifference` is non-zero when its 1 ms timeout runs; on the loading main thread the timeout ran 25 to 85 ms late, after a later ResizeObserver callback had set `resizeDifference` back to 0. The library then stops following the bottom.
  - **Fixed** by the fork's own rule, which puts the lesson back until the learner first acts; the library is unchanged. The rule, its limits and the owner's word are "Rest on open" in `docs/fork/lesson.md`; the runs are in `docs/fork/history/performance.md`, "Rest on open".
- **Only the owner's devices can show** whether Safari anchors, how Safari's own Find and selection treat skipped messages (a WebKit report says its Find doesn't search them), how the scrollbar behaves, and how the slide to the bottom feels.

## Not built (the audit's other recommendations)

- A memoized per-message component, so a state change re-renders one message (it would also cut the cost of a streaming reply: about 410 ms per update at 950 messages).
- Duplicate work in each sync upload (about half the server's work per upload; no protocol change).
- Pictures decoded lazily and at thumbnail size (each holds about 3.6 MB in the page once seen).
- The notes editor and the Tutor loaded on demand (the lesson route loads 4.5 MB of scripts).
- The graph layout off the request thread (0.35 s of blocked server per extraction batch at 300 concepts).
- The activity feed's scan (every session, then every job file per session).

The owner's word on this list ("zero behavior impact") is under "The owner's decisions" above.

**Decisions still the owner's:** opening a long lesson with only its recent part; syncing only what changed (protocol 4, server first); letting a helper's progress lines wait before a sync (the 2-second rule); pictures as their own files and old history archived (a stored format that syncs); installing the touch helpers only while needed; serving pictures by address; which pictures the model keeps seeing.

## Tests

- Compaction with pictures: `tests/compaction-drawings.test.ts`.
- The route, the stamp, signatures, the caches and the sweep: `tests/chat-browser-route.test.ts`, `tests/chat-job-caches.test.ts`.
- The page's stamp rule and the catch-up: `tests/session-stamp.test.ts`; no re-render for the same data: `tests/refetch-unchanged.test.tsx`; the sync status selectors: `tests/cloud-state-selectors.test.tsx`.
- Rendering: `tests/active-problem-index.test.ts` (against a copy of the old logic), `tests/math-delims-cache.test.ts`.
- The glide and the browser's shift (the rules, and scripted lessons that play the shift and the smooth scroll's return): `tests/phone-layout.test.ts`, `tests/dock-touch-reveal.test.tsx`.
- Rest on open (the rules, a control that reproduces the library's fault, and the real `use-stick-to-bottom` over scripted lessons): `tests/rest-on-open.test.tsx`.
- The off-screen rule and its estimates, and that no switch is left: `tests/offscreen-rule.test.ts`; jumps into a skipped message (a scripted lesson whose passages measure as zeros until drawn; the one check; the learner's input, on the dock too; the selectors kept equal to the stylesheet's): `tests/offscreen-target.test.ts`.
- Notes: a 300-note vault compared with the per-link loop, in `tests/notes-core.test.ts`.
