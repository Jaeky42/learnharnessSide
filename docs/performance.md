# Long sessions: the performance audit and what was built from it

The owner's report: the app lags when a session gets long, on the Windows app, the iPhone and the iPad. What lags: scrolling a long lesson, opening one, and coming back to the app after a while. Not reported: typing, a choppy stream, or a wait after Send. Later added: lessons where Drawing Pad pictures were sent to the teacher are worse.

**State:** step 1 and the off-screen rule are built on `claude/upstream-0.6.0` and pushed there. Not shipped to either release branch (that needs the owner's word, as always). No sync protocol change and no stored format change: the protocol stays 3, the chat format 2. Change a decision recorded here only with the owner's approval.

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
- **No state change for the same data**: the jobs list, the Tutor's threads, the session list and the usage figures (`sameJsonValue`). The jobs fetch still runs its settle detection every time.
- **The lesson reads only whether its own session is held** (`useSessionHeld` in `components/cloud/cloud-state.tsx`; the state lives in a small store read through `useSyncExternalStore`). `useCloud()` and `useSyncTrouble()` behave as before for the strip, the chip, the session list and the discard box.
- **Less to the browser**: `withoutThinkingSignatures` (`src/core/browser-record.ts`) on the full GET and on the page's `initialMessages`. It builds new objects only for the blocks that carry the field.
- **The session list** (`src/store/chats.ts`): each file's summary is remembered until its stat changes. A failed read is never remembered.
- **The stale-job sweep** (`src/server/jobs.ts`, `src/store/jobs.ts`): no session parse per job (the outer `listChats` loop already proves the session exists); the job store remembers which session a job file belongs to and reads only that session's files.
- **Rendering**: the active-practice-problem scan reads a per-history index (`ProblemIndex` in `src/core/native-messages.ts`), cached only for the browser's frozen histories; `transformMathDelimiters` and `repairMathForDisplay` (`src/core/math-delims.ts`) keep bounded string-keyed results and don't store a string that only extends the previous one (a streaming reply).
- **Notes** (`src/core/notes.ts`): `computeBacklinks` builds its link lookup once per call. Not about session length: it was 1 s per 4-second refresh at 1,000 linked notes.

### The off-screen rule

- `app/offscreen.css` (fork-owned, unlayered): `content-visibility: auto; contain-intrinsic-size: auto 600px` on the learner's rows and the assistant's messages directly in the transcript column (`[data-session-find-root] > [data-testid="user-message"]`, `> .is-assistant`). Every message stays loaded and in the page; only layout and painting of off-screen blocks is put off.
- **Not** on phase dividers, cards and placeholders (a 600 px estimate would inflate the scrollbar), and the dock spacer is a sibling of the column.
- On by default on every device, the desktop app included.
- **Temporary off switch** for the owner's trial: `?offscreen=off` in the address sets `data-lh-offscreen="off"` on `<html>` before the first paint, for that page load (the inline script in `app/layout.tsx`). To be removed once the owner is happy.
- **Only the owner's devices can show** how Safari's own Find and selection treat skipped blocks, how the scrollbar behaves, and how the slide to the bottom feels.

## Rulings made while building (for the owner to review)

- **A picture attached to a practice "thinking" note leaves no trace in a summary**, as before. The marker was decided for two places; this third one was left as it is.
- **The off-screen rule is narrower than the one the audit measured** (which was every direct child of the transcript). Its gain was measured again; see "Measured".
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

## Not built (the audit's other recommendations)

- A memoized per-message component, so a state change re-renders one message (it would also cut the cost of a streaming reply: about 410 ms per update at 950 messages).
- Duplicate work in each sync upload (about half the server's work per upload; no protocol change).
- Pictures decoded lazily and at thumbnail size (each holds about 3.6 MB in the page once seen).
- The notes editor and the Tutor loaded on demand (the lesson route loads 4.5 MB of scripts).
- The graph layout off the request thread (0.35 s of blocked server per extraction batch at 300 concepts).
- The activity feed's scan (every session, then every job file per session).

**Decisions still the owner's:** opening a long lesson with only its recent part; syncing only what changed (protocol 4, server first); letting a helper's progress lines wait before a sync (the 2-second rule); pictures as their own files and old history archived (a stored format that syncs); installing the touch helpers only while needed; serving pictures by address; which pictures the model keeps seeing.

## Tests

- Compaction with pictures: `tests/compaction-drawings.test.ts`.
- The route, the stamp, signatures, the caches and the sweep: `tests/chat-browser-route.test.ts`, `tests/chat-job-caches.test.ts`.
- The page's stamp rule and the catch-up: `tests/session-stamp.test.ts`; no re-render for the same data: `tests/refetch-unchanged.test.tsx`; the sync status selectors: `tests/cloud-state-selectors.test.tsx`.
- Rendering: `tests/active-problem-index.test.ts` (against a copy of the old logic), `tests/math-delims-cache.test.ts`.
- The off-screen rule and its switch: `tests/offscreen-rule.test.ts`.
- Notes: a 300-note vault compared with the per-link loop, in `tests/notes-core.test.ts`.

## Development notes

- **The audit's scripts and synthetic data are not in the repo.** To rebuild the data: repeat the golden teaching chat's messages N times with unique ids, and give every dispatch card a job record, or each one shows a spinner that animates forever and distorts idle and scroll measurements.
- **Measure a lesson only once it has settled.** A long lesson keeps working for tens of seconds after it first reacts. A first sync-poll measurement taken 6 s after opening showed freezes in its control too; the one that held waited a minute and tied each freeze to a poll answer.
- **All processes in a cloud session share one memory limit.** Five workers running tests at once got test processes killed; run test files one at a time.
- **`assert.equal` on two DOM nodes that differ can hang** while it builds its message (it tried to diff linkedom nodes: 1.4 GB, 100% CPU). Compare ids or text.
