# History and records: The lesson screen: checks, rendering, dictation and the highlight toolbar

## Scrolling into a check

### A check opens by scrolling: built, shipped, then reverted

Reverted at the owner's word; what the owner asked for in its place is "Scrolling into a check: the blank space" in `docs/fork/lesson.md`.

- **A check opens by scrolling: built, shipped, then reverted at the owner's word** (owner's ask, iPhone in a mobile browser: after opening a session, scrolling down didn't go into a teach check waiting behind "Check your understanding … Open ›" until it had been tapped; the owner's words: "i literally just want it to be like a normal question where i can scroll down and it opens").
  - **What was built and shipped** (release 0.6.30 and the server image of that commit, `51d76b8`; code commit `99459c4`): an untapped check opened (1) on coming back within 16 px of the lesson's bottom after having been more than 96 px away, and (2) at the end on one more push down, a 24 px finger drag or 100 px of wheel (`components/push-at-end.ts`, and `leftBottomRef` in `DockOverlay`, `components/chat.tsx`). On every device, by the owner's two decisions then (opens by scrolling like any question; everywhere).
  - **The owner's verdict on the iPhone:** "the scrolling into the question isn't working how i wanted it to at all. i wanted it to be like any normal question, where i scroll all the way through the content, into blank space, then it opens. with your change, if i scroll down a tiny bit and then the question opens, then closes, then opens when it gets to the bottom of the blank space. revert it".
  - **Reverted** (`cf6e46c`, a `git revert` of `99459c4`): `components/chat.tsx`, `components/phone/use-dock-touch-scroll.ts` and `tests/dock-touch-reveal.test.tsx` are byte for byte what they were at `340a5a4` (the phone's keyboard round), and `components/push-at-end.ts` and `tests/push-at-end.test.ts` are gone. Upstream's rule held again: a teach check waited behind Open until it was tapped (or opened with Enter), and reaching the bottom by hand didn't open it. The reading in `docs/cloud-sync.md` ("The teach check's "Open" away from the bottom") stood as first written, until the blank space (the next round) changed it: reaching the bottom by hand now opens a waiting check, as that reading itself notes.
    - It also takes back a side effect: a tap on Open whose glide the learner stops leaves the check unopened again.
  - **Why it opened, closed and opened again** (read from the code after the report; not reproduced, the Chromium check never showed it): before a check's first opening the lesson ends where its text ends, with no blank space under it. The push opened the check there; the dock then grew and the room kept under the lesson for an open question appeared, so the bottom was suddenly a few hundred pixels further down. With the finger still on the screen the slide to the new bottom is stopped ("A touch stops the slide to the bottom" in `docs/cloud-sync.md`), the lesson is then more than 96 px from its bottom, and the fold rule folds the question; it opens again at the real bottom.
  - **State of the revert:** shipped. With the owner's word ("Ship to both"), the same commit went to `claude/pensive-goldberg-7dty2m` and to `side-tutor`, both plain fast-forwards from `069e4b9` (the keyboard-up marker fix, another session's, shipped meanwhile); release 0.6.32. What the owner asked for in its place is the next bullet.

### Scrolling into a check: the blank space, what was checked

- **Checked** by an independent verifier on a production build in Chromium, every case 3 times from a fresh page load, after one repair (the taller window, above):
  - **iPhone size, real touch through CDP:** folded in every frame for 5 s after load, resting 357 px from the bottom with the spacer at 668 px and the last text where it is for a folded question; ordinary swipes, and one slow swipe held at the bottom for a second, wiggled and lifted, opened it on arrival (0 to 13 px from the bottom) with no fold in any frame after and the spacer unchanged; a 20 px swipe left it folded; up and back down opened it on arrival; Open from rest and from 1,500 px up ended open at the bottom; once open it folds and reopens as any question; a normal question as before.
  - **A computer, 1280 × 800, the wheel:** the same (resting 485 px from the bottom, spacer 804 px; one wheel step leaves it folded; Open by click).
  - **Resizes while resting:** the phone 300 px taller, and 250 px shorter then back; 1280 × 800 to 1280 × 1000; 1280 wide to 900 wide: folded throughout, back at the end of the text, and a scroll to the bottom afterwards opened it with no fold.
  - Typecheck clean, lint with its one existing warning, the eight related test files passing one at a time.

## Money is not math

### Money is not math: the renderer's own rule, what was checked

- **Checked:**
  - **old renderer against new, the same inputs through both** (the code before the change in a scratch worktree): 61 inputs of real math (formulas that start with digits, decimals, percentages, units, ranges, fractions, in tables, lists, quotes, headings and bold, beside every kind of punctuation, `$$…$$`, `\(…\)`, formulas holding `\$`, formulas followed by a digit or a letter, formulas with a space before the closing dollar): **61 of 61 identical**, as a message and as a tool's text, no KaTeX error. 28 inputs with money: 24 changed, all for the better; 3 were already right (table cells and list items never paired); 1 is the "US$" limit;
  - **an independent verifier**, twice, with its own inputs (85, then 138) against the same old code: its first run found the losses listed above; its second, after the narrowing, found the pipe case, fixed since. The factorial case came from the lead's own comparison. The verifier didn't see the last two narrowings; the 61-input comparison was run after them;
  - **a reply being written:** every prefix of formula sentences comes out unchanged, and no prefix of a money sentence draws a formula (tests);
  - **in a browser**, a local copy of the app at iPhone size with a sample lesson holding the owner's sentences beside the old chat's formulas, money next to math and a table with both: the amounts as text, all nine formulas drawn, no error; run again on the rule as finally built, with the same result.

### Money amounts no longer turn into a formula, what was checked

- **Checked** through the app's real renderer, as a message and as a tool's text (a problem statement): the owner's sentence bare (a formula), escaped (text, bold intact, also in a table and a list), each amount inside math (one formula each), and escaped money beside real math.

## Demos and figures follow the theme

### Demos and figures follow the theme, what was checked

- **Checked:** on a production build with the sample teaching session, the Default theme (dark) and Catppuccin Latte (light): demo and figure inverted on dark, not on light; a demo flipped on with the light theme stayed inverted on dark and on light while the unflipped figure followed the theme.

## Highlight, then Ask on a touch screen

**Highlight, then Ask on touch: following the selection, measured**

- **Measured** in a browser at iPhone size with iOS's sequence from a script (the end moved one line every 120 ms), before and after: placed again 322–335 ms after each change, hidden in between, a new element each time; after, 24–30 ms after each change as measured (the next frame plus the measuring script's own frame), never hidden, the same element. After an autoscroll: back 410–433 ms after the last scroll before, 161–168 ms after. The first appearance after the press and hold is unchanged (315–331 ms in both).

## Dictation

### Dictation in Firefox: what was checked

- **Checked** by an independent verifier in Chromium with a made-up microphone and a stand-in for Deepgram's socket: the normal path built one engine at 16,000 and sent 4,096-byte frames at about 33,000 bytes a second; with the 16,000 engine made to refuse as Firefox does, the run stayed on, the first engine was closed, a second ran at 44,100, the frames were the same size at the same rate (not three times it), the meter moved, the words landed, and a second run built no 16,000 engine. Ten seconds of a 440 Hz tone from 44,100 and from 48,000 came out at 439.98 Hz with its level kept and 159,744 samples (within one frame of 160,000).
