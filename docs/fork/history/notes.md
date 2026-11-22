# History and records: The notes drawer

## Design decisions

### Notes drawer and side tutor additions (asked by the owner after Phase 4)

- **What:** the folder menu's "New note" / "New folder" wording, Delete for notes and folders, and dragging on a phone, then dragging redone for phone and computer. Each plan and its wording were approved by the owner. The decisions are recorded where they belong:
  - the menus, Delete and the dragging design: "Notes drawer" in `docs/side-tutor.md`;
  - hold-then-move and the message line on the phone's list screen: "Phone layouts" above;
  - deletes and the sync safety check: "Keeping sync safe" above.
- **"New folder" already existed** (the folder-with-a-plus icon in the drawer's top bar, and the folder row menu). The owner hadn't seen it; only its menu wording changed.
- **Two rounds on the drag:**
  1. A floating label, an empty box over the heading and a lit area under the list. The owner ran it on the iPhone and sent a screenshot of a drag under way: the label was following the finger with both boxes up, so holding and then moving starts a drag on iOS (`long-press.ts`). They didn't say how the drop went. The boxes looked bad to them.
  2. The redone drag (the current one): the row itself moves and the others part. The owner chose "the list sorts itself" over keeping a hand-made order, then approved the plan page.
- **Code:** `src/store/notes.ts` (`remove`, `contents`), `src/server/notes.ts` (actions `contents` and `delete`), `src/server/obsidian-sync.ts` (`notesChangedHere`), `components/notes/` (`notes-api.ts`, `notes-dialogs.tsx` `DeleteDialog`, `notes-drawer.tsx`, `notes-tree.tsx`, `row-drag.ts`, `row-drag-dom.ts`), `components/phone/long-press.ts`.
- **Tested here:**
  - Unit tests: the store and the routes, the confirm wording, the menus and the confirm box, the dragging rules, the touch rules, and a clear-out during a sync stop against the real `ob`.
  - A Playwright run in server mode with the stand-in Obsidian, at phone size with real touch events (CDP `Input.dispatchTouchEvent`: touchStart, wait 750 ms, touchMove in steps, touchEnd): the line lifting and following the finger, rows parting, the indent following the folder, a folder lighting on its middle with the rows back in place, the upper limit and pushing past it to above Inbox, the drop and the slide to the sorted place, a gap among a folder's notes, putting a row straight back, a folder dragged as one piece into another, a refused move sliding back, and edge scrolling.
  - The same at desktop width with the mouse: a click still opens a note, press-and-move drags, Esc puts it back, and the menus are untouched. Earlier runs covered Delete: the confirm boxes, the open note with unsaved typing (it closes and isn't written back), a deleted home folder, and the deletions reaching the stand-in Obsidian with sync never paused.
- **The redone drag is confirmed on the owner's iPhone** ("the dragging looks great").
- **The drawer's message line** now goes after 5 seconds, or 20 with an Undo button (the owner's ask and choice; "The message line" under "Notes drawer" in `docs/side-tutor.md`). Timed in a browser. Pushed as the last change before Phase 5; the owner hasn't said yet whether they tried it.

## On a phone

### On a phone: the first drag

- **Dragging: hold, then move** (the notes drawer on a phone):
  - **History:** the first version had a floating label with the name, an empty box over the heading for "outside every folder", and a lit area under the list. The owner tried it on the iPhone: the drag started and followed the finger, but the boxes looked bad, and they asked for the row itself to move with the others parting.
