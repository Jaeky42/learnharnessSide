# Long sessions: the performance audit and what was built from it

The owner's report: the app lags when a session gets long, on the Windows app, the iPhone and the iPad. What lags: scrolling a long lesson, opening one, and coming back to the app after a while. Not reported: typing, a choppy stream, or a wait after Send. Later added: lessons where Drawing Pad pictures were sent to the teacher are worse.

**State:** step 1, the off-screen rule, the fix for jumps under it and the glide's rule are built on `claude/upstream-0.6.0` and **shipped**. With the owner's word ("ship"), the same commit was pushed to `claude/pensive-goldberg-7dty2m` (the server's image `:dev`) and to `side-tutor` (the Windows release), both plain fast-forwards from `1915f9c`. Both dry runs had passed on `d74d622`; the shipped commit adds only these lines. No sync protocol change and no stored format change: the protocol stays 3, the chat format 2, so the order of updating the server and the PC doesn't matter and nothing pauses. **The owner then updated and tried it on the iPhone and the iPad: "the performance is now very good"**, and again: "performance is very good". They didn't say which screens they tried, or whether the Windows app has been tried, so the things only their devices can show (under "Known faults with the rule on") are still open: scrolling up through never-drawn messages, Safari's own Find, and the glide's feel. The one thing the owner noticed (a mobile browser): **the scrollbar moves up and down instead of travelling smoothly** while scrolling, which is the estimates giving way to real heights; their words: "that isn't a problem at all", "performance is overall much better". They reported no text jumping. Nothing was changed for it: on a phone a closer estimate for the assistant's messages (1,000 px) opened the lesson short of its bottom (below). The `?offscreen=off` switch stays until the owner says to remove it. The server's image before this update is the per-commit tag of `1915f9c`. Change a decision recorded here only with the owner's approval.

## What the audit found

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
4. **The browser may skip drawing off-screen messages**, tried in the app with a temporary off switch (the owner's pick of three ways to try it).

## What was built

### Step 1 (no change in what the app does or shows)

- **Compaction** (`src/core/compaction.ts`, `src/server/compaction.ts`): `serializeForSummary` reads a learner message's text whatever its shape and adds the marker per picture; a picture in a tool result becomes the marker in place of its base64. Preparing the summary sits inside `compact()`'s try, so a failure there is logged and the lesson carries on uncompacted, as for a summarizer failure; `kickCompaction` can't leave an unhandled rejection. Before, the throw reached `handleChatInput`, so Send would have failed once such a session passed its threshold (read from the code; not run with a model).
- **One field at a time** (`app/api/chats/[id]/route.ts`): `GET /api/chats/<id>?only=coverage | settings | turns | stamp`. The coverage ring, the model picker and the usage read (`syncTurns`) use them. An unknown value answers 400; the `only` answers never reconcile a plugin question and never write.
- **The stamp** (`src/server/browser-stamp.ts`, one function for the full GET, `?only=stamp` and the page's `initialStamp`): the chat file's stat (`chatStamp` in `src/store/chats.ts`: inode, size, modified and changed times; no read) plus a digest of the four values a full read gives the page that are not in the file: `turnError`, the two plugin availabilities and `pricing`.
  - **No stamp (null) while a plugin question is pending or a plugin problem is active**: those sessions always do the full read, as before.
  - The stat is taken before the file is read, so a write landing in between gives an older stamp with newer content, and the page reads once more.
- **The sync catch-up read** (`components/chat.tsx`, `components/session-core.ts`): when it runs is unchanged (sync in use; one second after a lesson opens; at every reconnect; not during a stream or a turn). It now asks for the stamp and does the full read only when the stamp differs, is unknown, or the check fails.
  - The page knows a stamp only while its messages, error and plugin availabilities are the very objects that stamp was taken for (`knownStamp`); any stream, append, replace or error forgets it. A needless full read is the old behaviour; a wrong skip would be a fault.
  - On a skip it still runs the owed-continuation check.
  - **Usage not read yet is no reason for the full read** (`catchUpRead` in `components/session-core.ts`). On a slow device the catch-up fired before the mount's usage read had landed, and downloaded the whole record (4 of 4 runs at 4×, 950 messages). Now an unchanged stamp waits for the usage read under way, or starts one (`?only=turns`), then runs the continuation check. A usage read that leaves no figures still ends in the full read. The read after a turn settles always starts afresh; only the catch-up waits for one under way. Unit-tested; not measured again in a browser.
- **No state change for the same data**: the jobs list, the Tutor's threads, the session list and the usage figures (`sameJsonValue`). The jobs fetch still runs its settle detection every time.
- **The lesson reads only whether its own session is held** (`useSessionHeld` in `components/cloud/cloud-state.tsx`; the state lives in a small store read through `useSyncExternalStore`). `useCloud()` and `useSyncTrouble()` behave as before for the strip, the chip, the session list and the discard box.
- **Less to the browser**: `withoutThinkingSignatures` (`src/core/browser-record.ts`) on the full GET and on the page's `initialMessages`. It builds new objects only for the blocks that carry the field.
- **The session list** (`src/store/chats.ts`): each file's summary is remembered until its stat changes. A failed read is never remembered.
- **The stale-job sweep** (`src/server/jobs.ts`, `src/store/jobs.ts`): no session parse per job (the outer `listChats` loop already proves the session exists); the job store remembers which session a job file belongs to and reads only that session's files.
- **Rendering**: the active-practice-problem scan reads a per-history index (`ProblemIndex` in `src/core/native-messages.ts`), cached only for the browser's frozen histories; `transformMathDelimiters` and `repairMathForDisplay` (`src/core/math-delims.ts`) keep bounded string-keyed results and don't store a string that only extends the previous one (a streaming reply).
- **Notes** (`src/core/notes.ts`): `computeBacklinks` builds its link lookup once per call. Not about session length: it was 1 s per 4-second refresh at 1,000 linked notes.

### The off-screen rule

- `app/offscreen.css` (fork-owned, unlayered): `content-visibility: auto` on the learner's rows and the assistant's messages directly in the transcript column (`[data-session-find-root] > [data-testid="user-message"]`, `> .is-assistant`). Every message stays loaded and in the page; only layout and painting of off-screen blocks is put off.
- **Size estimates per kind** (`contain-intrinsic-size: auto …`): 60 px for the learner's rows (100 px in the phone layout), 700 px for the assistant's messages on every width. They are the mean heights measured in the 950-message test lesson. A message drawn once keeps its real height ("auto").
  - The first build had a flat 600 px for both: the scrollbar started 37% too long on a computer. With these: 4% too long on a computer, 32% too short at iPhone size.
  - **Not 1,000 px for the assistant on a phone** (the plan's number, its mean there): with it a lesson opened 38 px short of its bottom at iPhone size, 3 of 3 loads; with 700 px, 0–1 px in 20 of 20.
  - **Lower estimates don't help**: 44 / 140 px (below most real heights) was tried against the scroll faults below and did worse (the glide failed 14 of 30 at iPhone size; the scrollbar started 63–70% short).
- **Not** on phase dividers, cards and placeholders (a message-sized estimate would inflate the scrollbar), and the dock spacer is a sibling of the column.
- On by default on every device, the desktop app included.
- **Temporary off switch** for the owner's trial: `?offscreen=off` in the address sets `data-lh-offscreen="off"` on `<html>` before the first paint, for that page load (the inline script in `app/layout.tsx`). It works only where there is an address bar (a browser tab), and isn't remembered. To be removed once the owner is happy.

#### Jumps into a message that isn't drawn

- **The fault** (found by the browser checks of the first build): inside a skipped message a passage measures as zeros (`Range.getBoundingClientRect()`), so upstream's `scrollSessionTarget` scrolled nowhere near it. The app's Find showed the match in 1 of 14 steps, the Tutor's "Show in the lesson" landed in 1 of 3 tries. A link to a message (the hash) was fine: the message's own box has its estimate.
- **The fix** (owner's choice, over leaving the rule off by default and over removing it): `components/offscreen-target.ts`, called from one edited place in upstream's `components/session-navigation.tsx` (`scrollSessionTarget`; its loop moved into `placeSessionTarget`). Every jump goes through it: Find, citations and the Tutor's quotes, links to a message.
  - Before the jump measures, the target's message gets `data-lh-draw`, which the stylesheet answers with `content-visibility: visible`. So do the skipped messages the jump brings on screen, and those up to two window heights above (the browser draws those by itself a few frames later, and without scroll anchoring their real heights would move the passage: about 440 px in the stand-in run).
  - Once the passage and the lesson's height have been still for 3 frames (at least 4 frames, at most 20), the passage is measured again and put back **once** if it moved. Then the attribute comes off; with no frame for 1 s (a hidden tab) it comes off anyway.
  - **Not after the learner's own input**: a wheel, a touch, a press or a scrolling key anywhere on the page, or another jump, cancels the check. It listens on the whole page because a wheel or a drag on the dock scrolls the lesson from script (the first version listened on the lesson only, and a wheel over the dock was undone 9 of 9 times).
  - An attribute, not an inline style: Find re-reads every match when a style in the lesson changes, which cost two tasks of about 270 ms per step.
  - It does nothing with the rule off, when no message near the passage is skipped, and in the tests' DOMs.
- **Checked by a second analyst** (950 messages, a computer and iPhone size, rule on against off): Find 14 of 14 forward and backward, also stepping fast and typing a new search during a settle; the Tutor's quotes 3 of 3 from the bottom and from the top; links to a message at 16–17 px; no attribute left behind; opening at the bottom in 80 of 80 loads; a streamed reply followed the same on and off; with the rule off everything as before the fix. A citation jump wasn't run (the data has none).

#### Known faults with the rule on

- **Scroll anchoring is what makes the rule comfortable.** When a message above the screen takes its real height, Chromium moves the scroll position so the view stays still. With anchoring switched off (a stand-in for a browser without it), scrolling up through never-drawn messages gave 226 layout shifts on a computer (largest 797 px) and 274 at iPhone size, against 1 and 8 with the rule off. Whether the owner's Safari anchors could not be confirmed from here.
- **The fork's glide to the bottom** (touch: a tap on the folded question from far up) took the browser's shift for the learner stopping it: 4 of 40 runs at iPhone size stopped 12.7k–23.5k px short, the question still folded. **Fixed** (owner's choice): the glide's rule now tells the two apart, and 60 of 60 glides arrived with the rule on. The rule, its numbers and its limits are item 6 under "A tap on the folded question ends at the bottom, open" in `docs/cloud-sync.md`.
  - **The glide is slower with the rule on:** a median of 3.5 s against 2.1 s off, from 9,400 px up, because the bottom keeps moving as messages take their real height and the glide is aimed again twice.
- **The computer's slide to the bottom** (upstream's `use-stick-to-bottom`): 2 of 50 runs stopped far short in the first two rounds, 0 of 100 in the third; 0 with the rule off throughout. Read from the library: its guard against taking a resize for the learner's scroll is reset by comparing values, so two equal resize differences in a row let the next correction count as a scroll up. Not changed: it is upstream's dependency.
- **Only the owner's devices can show** whether Safari anchors, how Safari's own Find and selection treat skipped messages (a WebKit report says its Find doesn't search them), how the scrollbar behaves, and how the slide to the bottom feels.

## Rulings made while building (for the owner to review)

- **A picture attached to a practice "thinking" note leaves no trace in a summary**, as before. The marker was decided for two places; this third one was left as it is.
- **The off-screen rule is narrower than the one the audit measured** (which was every direct child of the transcript). Its gain was measured again; see "Measured".
- **The jump fix does more than the plan's sentence** ("draw the target message, measure, check once a frame later"): it also draws the skipped messages around the target, and waits for the layout to settle (up to 20 frames) before its one check. Both came from the browser runs.
- **700 px, not 1,000 px, for the assistant's messages on a phone** (above). The plan named 1,000.
- **The glide's rule is shaped differently from the description the owner approved** ("a shift that comes together with the lesson's height changing by the same amount"). Recorded frame by frame, the shift is a rise, and what ended the glide was the smooth scroll's return from it a frame or two later, with the height unchanged. So the rule has a 100 ms allowance after a rise and a "stopped dead" check; the intent is the same. The owner has been told.
- **No diagram cache.** One was built and removed after review: mermaid queues renders but applies its configuration at once, so a quick theme switch could leave a chart drawn in the wrong theme in the cache. `components/mermaid-render.ts` is upstream's, unchanged.
- **Whole parsed sessions are not kept in the server's memory between requests.** It would save the most parsing, but any code that modifies a session it was handed would corrupt the shared copy.
- **`?only=stamp` reads the session once on the server.** It saves the download and the page's work, not the server's parse.
- **One existing test's clean-up waits 10 ms** (`tests/cloud-notices-ui.test.tsx`): a closed dialog hands the focus back from a zero-delay timer, and the sync status now updates a few microtasks earlier, so that timer could land in the next test.

## Measured

Workers' own measurements on the test library (Node, not a browser):

| | before | after |
|---|---|---|
| One stale-job sweep | 1.2–1.8 s | 2–5 ms |
| Session files parsed per sweep | 68 | 0 |
| `listChats`, second call | 148 ms | 0.1 ms |
| Full session download, 950 messages | 3,568,720 B | 2,716,523 B |
| Active-problem scan, one render's worth, 950 messages | 113–145 ms | 2 ms, then 0.1 ms |
| The same at 2,850 messages | 1,141–1,218 ms | 11 ms, then 0.1 ms |
| `computeBacklinks`, 1,000 notes × 4 links | about 1 s | 11 ms |

In a browser, after the build (headless Chromium, software rendering, a production build, 950 messages; medians of 3 where repeated; machine noise about ±30%, and the "before" column is the audit's, taken on a busier machine). "Off" is step 1 alone (`?offscreen=off`), "on" adds the off-screen rule as first built (a flat 600 px estimate).

| | before | off | on |
|---|---|---|---|
| Open: until the page reacts | 13.6–18 s | 12.4 s | 8.3 s |
| Open at 4× | 28.6 s | 37.5 s | 29.3 s |
| Full-record downloads at open; page size | 2–3; 7.1 MB | 0; 6.27 MB | 0; 6.27 MB |
| 60 wheel steps: main thread / hit-testing | 1.71 / 0.86 s | 2.0 / 1.04 s | 1.2–1.3 / 0.06 s |
| The same at 4× | 14.7–21.5 / 4.2–4.7 s | 8.5 / 4.3 s | 5.3–5.7 / 0.3 s |
| At 4×: frames over 50 ms / worst frame | 72–79 / 4.3–4.5 s | 59–61 / 183–217 ms | 27–29 / 150–217 ms |
| Six touch swipes, frames over 33 ms | 11–13 | 9–20 | 1–4 |
| One re-render with nothing changed (4×) | about 300 ms (1.2 s) | 91 ms (528 ms) | 80 ms (477 ms) |
| One streamed update, main thread | 410 ms | 125 ms | 102 ms |
| Idle on a paired device, 45 s: freezes | 4 of 0.28–0.43 s (4×: 1.2–2.4 s) | 0 | 0 |
| Reconnect on a paired device | 3.57 MB, 0.9–1.0 s of long tasks | 90 B, 0.46–0.52 s | the same |
| Full session download: server time | about 115 ms | 78 ms | |

- **Step 1 alone** removes the multi-second scroll frames, the idle freezes and the download on return, and cuts a re-render about threefold. It does not make opening faster: at 4× the difference from the audit is within noise.
- **The off-screen rule** is what speeds up opening (style recalculation 2.16 s → 0.83 s) and ordinary scrolling (hit-testing down 94%). It adds layout, pre-paint and IntersectionObserver work while scrolling (layout at 4×: 58 → 481 ms per 60 steps) and two style recalculations a second at idle (20–250 ms per 45 s).
- **Not changed by either:** the one hydration task at opening (14–16 s at 4×), and a lesson of 95 messages (no gain).
- `?only=stamp` costs the server about half a full read (38 ms against 78 ms at 950 messages): it parses the file once.
- **With the per-kind estimates and the jump fix** (a second analyst's runs, another day's machine load, so compare on with off, not with the table): opening 6.9 s on against 8.3 s off; 60 wheel steps at 4×: main thread 3.2 s against 4.7–5.8 s, hit-testing 0.13 s against 2.4–3.1 s. A Find step takes about 520 ms on against 490 ms off.
- No run of the new build at 2,850 messages, and none with a real model.

## Not built (the audit's other recommendations)

- A memoized per-message component, so a state change re-renders one message (it would also cut the cost of a streaming reply: about 410 ms per update at 950 messages).
- Duplicate work in each sync upload (about half the server's work per upload; no protocol change).
- Pictures decoded lazily and at thumbnail size (each holds about 3.6 MB in the page once seen).
- The notes editor and the Tutor loaded on demand (the lesson route loads 4.5 MB of scripts).
- The graph layout off the request thread (0.35 s of blocked server per extraction batch at 300 concepts).
- The activity feed's scan (every session, then every job file per session).

**The owner's word after trying it: "the performance is fine, id only want changes that have zero behavior impact".** So nothing below is asked for, and anything from this list that changes what the app does or shows is off the table unless the owner raises it: opening with only the recent part, pictures decoded lazily (a picture could show a moment late), and the editor and the Tutor loaded on demand (a first opening could wait). With no visible change at all: the per-message component (a large edit of upstream's lesson screen), the sync upload's duplicate work, the graph layout off the request thread and the activity feed's scan (all three on the server).

**Decisions still the owner's:** opening a long lesson with only its recent part; syncing only what changed (protocol 4, server first); letting a helper's progress lines wait before a sync (the 2-second rule); pictures as their own files and old history archived (a stored format that syncs); installing the touch helpers only while needed; serving pictures by address; which pictures the model keeps seeing.

## Tests

- Compaction with pictures: `tests/compaction-drawings.test.ts`.
- The route, the stamp, signatures, the caches and the sweep: `tests/chat-browser-route.test.ts`, `tests/chat-job-caches.test.ts`.
- The page's stamp rule and the catch-up: `tests/session-stamp.test.ts`; no re-render for the same data: `tests/refetch-unchanged.test.tsx`; the sync status selectors: `tests/cloud-state-selectors.test.tsx`.
- Rendering: `tests/active-problem-index.test.ts` (against a copy of the old logic), `tests/math-delims-cache.test.ts`.
- The glide and the browser's shift (the rules, and scripted lessons that play the shift and the smooth scroll's return): `tests/phone-layout.test.ts`, `tests/dock-touch-reveal.test.tsx`.
- The off-screen rule, its estimates and its switch: `tests/offscreen-rule.test.ts`; jumps into a skipped message (a scripted lesson whose passages measure as zeros until drawn; the one check; the learner's input, on the dock too; the selectors kept equal to the stylesheet's): `tests/offscreen-target.test.ts`.
- Notes: a 300-note vault compared with the per-link loop, in `tests/notes-core.test.ts`.

## Development notes

- **The audit's scripts and synthetic data are not in the repo.** To rebuild the data: repeat the golden teaching chat's messages N times with unique ids, and give every dispatch card a job record, or each one shows a spinner that animates forever and distorts idle and scroll measurements.
- **Measure a lesson only once it has settled.** A long lesson keeps working for tens of seconds after it first reacts. A first sync-poll measurement taken 6 s after opening showed freezes in its control too; the one that held waited a minute and tied each freeze to a poll answer.
- **All processes in a cloud session share one memory limit.** Five workers running tests at once got test processes killed; run test files one at a time.
- **`assert.equal` on two DOM nodes that differ can hang** while it builds its message (it tried to diff linkedom nodes: 1.4 GB, 100% CPU). Compare ids or text.
