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
- **Tests:** `tests/side-tutor.test.ts`.
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
- **Moving:** drag and drop works for notes **and folders**, and there's also "Move to…".
- **Editor:** CodeMirror for editing (sections fold while typing), plus a Read view with formatted math, folding, clickable links and images.
- **Where it appears:** both **teaching and practice** sessions.
- **On a phone:** the drawer fills the screen and shows the list, then the note. Rows open their menu on press and hold, and dragging is off. See "Phone layouts" in `docs/cloud-sync.md`.
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
- **Agent file tools:** `privateNotesRoots()` in `src/agent/tools/fs-shared.ts` re-reads `<data>/notes/settings.json` on every resolution or walk (agents never import the notes store). Paths are compared case-insensitively, by both their named and canonical (real) path. `resolveSourcePath` refuses with a specific message, and walks skip the folder.

### Code map

- `src/core/notes.ts`: pure logic (names and paths, properties, sections, links and resolution, backlinks, link suggestions, split and merge planning, attachment folder), exported through the core barrel.
- `src/store/notes.ts`: vault I/O, the tree with an mtime cache, save with a conflict check, create, move, split, merge, extract, undo, pending edits, attachments and asset lookup, and session home folders. Dynamic fs paths carry `/* turbopackIgnore: true */`.
- `src/server/notes.ts`: HTTP responses for the routes below.
- **Routes:**
  - `app/api/notes` (GET tree; POST actions: vault, create, folder, move, split, merge, extract, undo)
  - `app/api/notes/file` (GET / PUT body)
  - `app/api/notes/attachment`
  - `app/api/notes/asset`
  - `app/api/chats/[id]/notes` (home folder)
- **`components/notes/`:**
  - `notes-drawer.tsx`: the panel, state, saving and polling;
  - `notes-tree.tsx`: tree model, drag and drop, row menus;
  - `note-editor.tsx`: CodeMirror;
  - `note-read-view.tsx`;
  - `notes-dialogs.tsx`: Move to, Split, name prompt;
  - `notes-api.ts`.
- **Wiring:** `components/chat.tsx` (Notes chip and drawer mount), `src/core/keyboard.ts` (`toggle-notes`, `focus-notes`), and `src/server/chats.ts` (session deletion hook).
- **Tests:** `tests/notes-core.test.ts`, `notes-store.test.ts`, `notes-privacy.test.ts`, `notes-ui.test.tsx`.

## Claude Code: Fable in the model list

- The Claude Code (CLI billing) list is upstream's three aliases (`opus`, `sonnet`, `haiku`, which the CLI resolves to the newest of each) plus a fork entry, **Claude Fable**, passed to `claude --model` by its full id `claude-fable-5-2` (owner's ask). It shows on the desktop and the server alike.
- Whether a Claude plan can use Fable through Claude Code is up to Anthropic; if not, the CLI's error shows in the lesson.
- Code: `src/agent/claude-code/provider.ts` (`CLAUDE_CODE_MODELS`). Tests that pin the list: `tests/claude-code-provider.test.ts`, `model-catalog.test.ts`, `claude-code-usage.test.tsx`, `claude-code-opt-in.test.ts`.

## Development notes

- CI uses Node 26 with npm 11. Use npm 11 for lockfile changes (`npx npm@11 install …`); npm 10 rewrites the lockfile's `libc` fields.
- A local `npm run build` needs network access to Google Fonts (next/font).
- On Node 22, `tests/subscription-auth.test.ts` has one failure that also happens without any fork changes (a Node-version difference).
