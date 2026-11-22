# The notes drawer

## Design decisions

The learner's own notes beside the lesson, stored as Markdown in their Obsidian vault.

### The owner's decisions and approved words

#### Design decisions (approved; change only with the owner's approval)

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

### Rulings, limits and open items

#### Added without being asked (after Phase 4)

- **Wording and behaviour added without being asked:** the message `Deleted “Electricity”.` after a delete, and the message line showing on the phone's list screen. The owner has used both and asked only for the messages to go sooner, so they stand unless the owner says otherwise.

## Behaviour details

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

## On a phone

- **Notes drawer:** slides in from the right and fills the screen.
  - **List, then note** (owner's choice from screenshots of two layouts): the topic list first; tapping a note shows it full screen, and "‹ Notes" goes back. It opens on the note last open in that session, if any. The list can't fold there; a divider line under the "Topics" heading replaces the fold arrow (owner's ask).
  - The two resize handles are hidden.
  - **Dragging: hold, then move** (owner's choice over a grip on each row; built after Phase 4, it replaced "dragging is off").
    - Press and hold opens the menu, as before. Keep the finger down and move: the menu closes and the row itself lifts and follows the finger.
    - What moves and where it lands is the same as on a computer: "Dragging" under "Notes drawer" in `docs/side-tutor.md`.
    - **The divider under "Topics" is the upper limit** (owner's ask). Pushing on against it puts the item above Inbox, outside every folder.
  - **The message line** ("Moved …", "Deleted …", and refusals such as a name that's already taken in that folder) also shows at the bottom of the list screen. Its usual place is in the note half, which the list screen hides, so on a phone those messages were never seen. Found in the browser run of the drag and added without being asked, for the owner to review.
  - A phone always opens the drawer closed and doesn't remember it, so the desktop's saved state is untouched.

## Code map and tests

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

### The dragging's numbers

- The numbers to tune, should that change, are at the top of `row-drag.ts` (`EDGE_BAND`, `INTO_DWELL_MS`, `LEVEL_STICK`) and `row-drag-dom.ts` (`PART_MS`, `SETTLE_MS`, `SLIDE_MS`, `INTO_TUCK`).
