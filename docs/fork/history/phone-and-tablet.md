# History and records: Phone and tablet: layouts, touch and typing, the home-screen app

## Screens

### Screens: browser runs and the first build

- **A swipe left on the drawer closes it** (the session list on a phone):
  - **In the browser** (iPhone size, real touch through CDP; the drawer 320 px wide): 120 px into a drag the drawer sat at −120 px with the dim at 0.625; let go there, it closed with no inline style left; a 48 px swipe with the finger stopped sprang back; a swipe on the dim, an up-and-down drag, a first move to the right and a touch from the search box moved nothing; a swipe that began on a session row never opened it, closing or springing back; press and hold still opened the row's menu; opening again and a second swipe worked; at 1280 px a mouse drag did nothing. **Not run there:** the quick flick (the sandbox delivered touch events 35 to 100 ms apart, too slow to be one); it rests on the unit tests.

- **With the keyboard up the question gets the room: the bottom block goes down to the keyboard**
  - **The first build did nothing on the owner's iPhone** (owner, with two screenshots: "on the web app the elements are still to high and the side tutor button is still there"; in a Safari tab the bubble was still there too). It set the marker from `keyboardUp`, which compares the visible height with `window.innerHeight`; in the browser run here `innerHeight` stays the screen's, on the iPhone that difference stays under its 120 px with the keyboard up, in the home-screen app and in a tab. What `innerHeight` reads there isn't known; it is read from the result only.
  - **In the browser** with a stand-in that shrinks `innerHeight` with the keyboard (to 62 px above the visible height): the old comparison says no, the new rule says yes; the home-screen set-up's block ends at the visible area's bottom (padding 0, the question 155 of 540 points), a tab keeps 12 px, the bubble is hidden in both, and everything is back when the keyboard closes.
- **A Dictate that fails shows its reason**
  - **In the browser** (iPhone size, the microphone refused): the line above the message box on all three screens with the bottom block's box unchanged, gone after 5.0 s, the mic still in the error colour after it; on the lesson the line ends at x 227 and the bubble starts at x 322; the Tutor's sheet showed the reason in its own line and the lesson's line stayed away; at 1280 px no line, the button's text as before.

## Touch and typing

### Touch and typing: test pages, browser runs and earlier attempts

- **A tap with the keyboard up**
  - **The test page** (an Artifact page, seven benches, run on the owner's iPhone in the Claude app's browser; the page was in a frame and never saw the keyboard's size, so each bench moved its own stand-in screen):

    | Bench | On the iPhone |
    |---|---|
    | The height taken inside the focus change (the app then) | 0 of 5 taps reached the button; the release landed on lesson text |
    | The height taken one frame later | 5 of 5 |
    | The button's mousedown prevented | 7 of 7, the box kept the focus, the keyboard stayed up |
    | The tap taken at `touchend` and replayed as `click()` | 5 of 5, the same |
    | A slider's knob dragged, nothing done | 8 of 8 kept the focus (no mousedown is sent) |
    | A tap on a slider's line, nothing done | 1 of 1: the value changed, one mousedown, the box lost the focus |
    | The focused box removed from the page | no blur or focusout (0 of 2); the keyboard closed at once |
    | A tap on plain lesson text | the box lost the focus, the keyboard closed |

  - **In the browser** (a production-like run at the owner's screen size, home-screen set-up, a stand-in keyboard, real touch through CDP), keyboard up:
    - an answer option, Dictate, the Tutor's Dictate and Ask: the press kept, the click on the button, the focus still in the box, the height unchanged;
    - Send: the same, and the form submitted (the stand-in data has no model, so a set-up dialog then took the focus; a real send wasn't run);
    - Submit answer with focusout and blur swallowed (WebKit's behaviour): submitted, and the app at its full height by itself;
    - Notes in the top bar and a tap on the lesson: the click landed, the box lost the focus, the app at its full height;
    - the model menu: it opened above its pill, with the app at its full height;
    - a computer at 1280 px: no press kept, the click moves the focus as before.
    - Chromium handles a touch on a slider itself and sends no mousedown, so the slider's kept press ran only in the unit tests.

- **A tap on the folded question ends at the bottom, open**
  - **What shipped first** (with the touch batch): the tap opened the question at once and slid the lesson down with `use-stick-to-bottom`'s spring. That library ends its slide at any upward scroll, and on an iPhone such scrolls come without a new touch (Safari's own momentum of a lesson still moving, or its late reports), so the question was let go and folded again. The fix held it open and slid again a frame after each such ending (`holdReveal`, up to 4 s), stopped the dock's own throw first, and let go for a new touch, a wheel, a mouse press on the lesson or a scrolling key. In Chromium the fold-back could only be reproduced with stand-ins for Safari's scroll reports (open at 116 ms, folded at 236 ms, 9,700 px from the bottom).
  - **The owner's verdict on the iPhone:** "when i click the question on the bottom while im scrolling, it pulls up the question, i see the content still scrolling up, then it jitters a bunch and finally pulls down. i wanted it to just smoothly pull all the way down the page and into the question." Safari's momentum kept going after the tap on the dock (a sibling of the scroller), and the slide and the slide-again loop fought it until it died.
  - **In the browser** (a production build at iPhone size, real touch through CDP; before is the shipped reveal):
    - a tap at rest 9,400 px up: before, the question opened at the tap (at 8,850 px) and slid open for 64 frames; now one smooth scroll, folded on every frame of the way, open at 15 px after 1.55 s, at the bottom (1 px), never moving up;
    - a tap right after a throw on the bar: before, opened at 9,290 px; now the same as at rest (one glide, open on arrival at 14 px);
    - a touch on the lesson 150 ms into the glide: stopped at 8,950 px, folded, and still there 1.5 s later; a drag on the dock during the glide: stopped, moved only by the drag, still there 1.5 s later; one glide in both;
    - the teach check's Open 3,000 px up: the invitation stayed for all 54 frames of the way, and the check opened on arrival; before, it opened at the tap;
    - 50 px from the bottom: opened at once, as before; with reduced motion: a jump, open at once at the bottom;
    - the scroller's inline `overflow` after the stop: `auto`, as it was;
    - unchanged, measured the same as before: dragging an open question folds it (241 px), scrolling back to the bottom by hand opens it, the teach check waits behind Open on load; and a computer: the click opens at once and ends at the bottom (1 px), the wheel folds it (4,001 px), a wheel during the slide folds it.
    - **after the review's fixes** (the same set-up; before is the glide as first built):
      - a wheel (−300) over the lesson 150 and 300 ms into the glide, on a touch laptop used with a mouse (1280 × 800, a touch screen): before, the glide ran on and the lesson ended at the bottom with the question open (1 px); now it stops there and the wheel's step applies (5,450 and 3,080 px up), folded, and stays;
      - a phone whose scroller ignores the smooth scroll: before, three tries, then the question folded and the lesson where it was (9,405 px): a dead tap; now the net opens it at 623 ms where it is and the lesson slides to the bottom (1 px); a teach check likewise, revealed;
      - a tap at rest far up, once: the lesson grew by about 900 px under the glide (at 603 ms the distance went from 3,285 to 4,190 px), the first glide ended 1,112 px short, and one more glide arrived: open at 11 px after 2.25 s (since the re-aim, below: no rest);
      - everything else as listed above: a tap after a throw, a touch on the lesson and a drag on the dock during the glide, 50 px from the bottom, the teach check's Open, reduced motion, and the computer's click and wheel.
  - **The re-aim, frame by frame** (the same set-up, Chromium at 60 Hz; times from the tap; three builds: no re-aim (the glide with the review's fixes), the re-aim at once, and the re-aim once slowed, which is what is built):
    - the demo sizing itself in flight (it grew at about 760–770 ms, in two runs of four): no re-aim, a rest of 9 frames ending at 1,741 ms and a second glide from 0 px/frame, arrival at 2,236 ms; at once, re-aimed at 767 ms, 204 px/frame then 2, arrival at 1,751 ms; once slowed, re-aimed at 1,493 and 1,504 ms, 15, 13, 11, 9 px/frame then 2, 8, 15, no frame without movement, arrival at 1,960 and 1,971 ms;
    - 1,000 px added to the lesson at 600 ms: no re-aim, 9 still frames, arrival at 2,179 ms; at once, re-aimed at 602 ms, 452 px/frame then 2, arrival at 1,901 ms; once slowed, re-aimed at 1,515 ms, 14, 12, 10, 8 then 2, 8, 16, no rest, arrival at 1,949 ms;
    - a lesson that doesn't grow: one smooth scroll, arrival at 1,521 to 1,534 ms in all three builds;
    - a glide the browser ends 1,500 px short (no growth): the retry rule in all three: 10 still frames, a second glide, arrival at 2,303 to 2,311 ms;
    - the question folded on the way and opened on arrival in every case.

## How it's built

### How it's built: the keyboard glide that was taken out, and the checks

- **Gliding in step with the keyboard: tried and taken out**
  - **What was tried** (the owner's pick, "B · In step", from an animated picture of three): the app's height glided with the keyboard both ways, from the keyboard's height remembered from the last time it was up, with a short glide when the guess was off.
  - **The owner's verdict on the iPhone:** the question box jiggled up and down after the keyboard closed, and the jerkiness the owner had asked about was still there. The owner asked for it to be reverted completely.
  - **Reverted:** `phone-viewport.tsx`, `menu-shell.tsx` and `use-dock-anchor.ts` are back to what they were before it, and its two test files are gone. The keyboard is handled as in "Closing the keyboard" above. A `lh:phone:keyboard` entry it left in a browser's storage is no longer read.
- **Desktop check:** desktop screenshots (1280 and 700 wide) and a dump of every element's position and size, compared before and after. Nothing moved; the only pixel differences are the see-through footer pills, whose blur picks up whatever transcript text sits behind them.
- **Real-phone checks (owner, iPhone, iOS 27), two rounds.** Round 1: most of it worked; fixed after it were the keyboard pushing the app up, the session list's strips, Settings' Account row popping in and the missing dictation waveform, and Settings became the centred panel. Round 2 confirmed on the phone: Settings (centred panel, fades), the dictation waveform, the keyboard opening and closing, the session list's full-height colours (Safari tab and home-screen app), 120 fps scrolling, dragging on and out of an opened question (no jumping, no pull-back), tapping the folded question while the lesson moves, the home-screen app filling the screen to the bottom, and the model picker in a Safari tab. Every fix above was found on the owner's iPhone and is described in its own bullet.

## Plugins on a phone

### Plugins on a phone: Flashcards and Rich code blocks

**What was checked**

- In a browser at iPhone size: a production build, real touch through CDP, the Safari-tab and the home-screen set-ups, a dark and a light theme. Every screen of the look was shot again after the change.
- **Flashcards with the stand-in provider:** a generation through the picker, the preview and Start.
- **Tests, typecheck, lint** (on the branch after the merge of `side-tutor`, before the sync fixes): typecheck clean; lint clean apart from the one existing warning; the full suite without `tests/safe-fetch.test.ts`: 5,997 tests, 5,988 pass, 4 skipped, 5 fail. The 5 are the four that fail in the development sandbox on untouched code ("Development notes from the merge" in `docs/upstream-0.6.0.md`) and one plugin SDK type test that runs out of its 30-second limit in a full run and passes alone. The plugin's own tests: 204 of 204.
- **The computer:** compared element by element at 1280 and 700 px against the build before the change: identical.
- **A fresh reviewer** read the phone diff and found two real bugs (the rename box stuck open after a hold on, or a slide off, its ✕; a hold inside the rename box opening the menu and saving) and smaller items. All are fixed.
