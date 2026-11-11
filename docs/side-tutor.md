# Side Tutor fork: features, design decisions, code map

Branch `side-tutor`, based on upstream amosblomqvist/learnharness @ da08cb5 (v0.5.0). The fork adds three things: the side tutor, the notes drawer, and a separately installed Windows app that updates itself from this fork's releases.

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
  2. Runs the side-tutor and notes tests on Windows, builds, and smoke-tests the server and the packaged app.
  3. Checks that the packaged `app-update.yml` points at this fork and that the package name and version are right.
  4. Only then publishes a GitHub Release (`gh release create`, with the installer, blockmap and latest.yml).
- Pushes that only change `CLAUDE.md` or `docs/**` don't run the workflow.
- `LH_BUILD_VERSION` / `LH_BUILD_HOMEPAGE` (next.config.ts) make Settings show the stamped version and link release notes to this fork.
- To pick up upstream: rebase `side-tutor` onto the new upstream release and push.

## Side tutor

- A floating, draggable, resizable window over **teaching** sessions (not practice) for quick questions. Esc shrinks it.
- **Minimized, it is a round bubble with no words** (owner's ask; it was a pill reading "Ask on the side" at the window's place). It sits at the lesson's bottom right, just above the message box or the open question, the same bubble as on a phone. While an opened question leaves no room above it, the bubble sits under the top bar at the right.
  - The open window can still be dragged anywhere and opens again where it was left; only the bubble has a fixed place.
  - Its place comes from `components/phone/use-dock-anchor.ts` (the dock's top, and the lesson's right edge, which isn't the window's while the notes drawer is open).
- **The window's words** (owner's wording): "Tutor" in the top bar, "Stuck on a term or a step? Ask here." while it is empty, and "Ask a follow-up…" as the typing box's hint. Nothing else: no tagline, and no explanation of what the tutor can see.
- **Speaking to the tutor** (owner's ask): a Dictate button (a microphone) sits right of the typing box, before Send. While it listens, a small live waveform and a red Stop take its place. The words land in the tutor's typing box when the run ends.
  - It borrows the page's one dictation run (`components/dictation.tsx`): the same microphone, Deepgram key, language and waveform as the lesson's Dictate. The button claims the run's transcript, then starts the run (`components/side-tutor-dictation-state.ts`); `dictation.tsx` sends the transcript to the claimant and drops the claim whenever a run ends, so a claim never outlives its run.
  - While the tutor's run is live, the lesson's own Dictate shows no run, and the lesson's message box doesn't take the words or the focus.
  - Send while still listening ends the run first, then asks with the spoken words. Esc cancels the run (the words are dropped), as in the lesson; a second Esc minimizes. Minimizing ends the run and keeps the words.
  - The button is off while the lesson itself is dictating. Without a Deepgram key it says so, and a click opens Settings → Keys, as the lesson's Dictate does.
- A second agent answers, using the session's model and credentials at **medium** thinking (`SIDE_TUTOR_THINKING` in `src/server/side-tutor.ts`).
- It sees a fresh lesson snapshot on every question: transcript, plan, phase, answers already revealed, and the open question **without** its answer key. It's told not to reveal open-question answers.
- **Isolation:** the thread is stored in `<data>/side-tutor/<chatId>.json`, never in the chat record. The main teacher's context, compaction and graph extraction never see it. Its cost isn't added to the session meter. Deleting a session deletes its thread.
- **Code:**
  - `src/core/side-tutor.ts`
  - `src/store/side-tutor.ts`
  - `src/agent/subagents/side-tutor.ts`
  - `src/server/side-tutor.ts`
  - `app/api/chats/[id]/side-tutor/route.ts`
  - `components/side-tutor.tsx`
  - `components/side-tutor-dictation.tsx` and `side-tutor-dictation-state.ts` (the Dictate button; three small hooks in `components/dictation.tsx` and the lesson-side checks in `components/chat.tsx`)
- **Tests:** `tests/side-tutor.test.ts`; the window's words, its Dictate button and the bubble's place: `tests/side-tutor-ui.test.tsx`.
- **Known limit:** a teacher reply that's still streaming isn't visible until it finishes.
- **On a phone** (browser narrower than 640 px): a bubble above the message box opens the tutor as a bottom sheet. See "Phone layouts" in `docs/cloud-sync.md`.

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
  - Afterwards the drawer's message line reads `Deleted “Electricity”.` (wording added while building, for the owner to review).
- **Editor:** CodeMirror for editing (sections fold while typing), plus a Read view with formatted math, folding, clickable links and images.
- **Where it appears:** both **teaching and practice** sessions.
- **On a phone:** the drawer fills the screen and shows the list, then the note. Rows open their menu on press and hold; holding and then moving the finger drags the row into a folder. See "Phone layouts" in `docs/cloud-sync.md`.
- **On the cloud server:** the vault is connected in Settings → Obsidian instead of by a folder path, and the drawer says when the notes aren't syncing with Obsidian. See "Obsidian vault on the VPS" in `docs/cloud-sync.md`. The desktop app's drawer is unchanged.
- **Extras:**
  - Math in Read view.
  - Pasted images go to Obsidian's `attachmentFolderPath`, or `LearnHarness/attachments` when that isn't set.
  - Shortcuts: Ctrl+Shift+N opens and closes the drawer; Ctrl+Shift+E jumps into the editor.
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
  - `notes-dialogs.tsx`: Move to, Split, Delete, name prompt;
  - `notes-api.ts`.
- **Wiring:** `components/chat.tsx` (Notes chip and drawer mount), `src/core/keyboard.ts` (`toggle-notes`, `focus-notes`), and `src/server/chats.ts` (session deletion hook).
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
