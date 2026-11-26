# The lesson screen: checks, resting point, rendering, dictation and the highlight toolbar

## Scrolling into a check

- **Scrolling into a check: the blank space** (owner, after the revert: "i wanted it to be like any normal question, where i scroll all the way through the content, into blank space, then it opens"; and, to a test page first: "why should it need a test page? the functionality is already there").
  - **What the learner gets:**
    1. A check that waits behind "Check your understanding … Open ›" still arrives and loads folded, and **never opens by itself**.
    2. While it waits, the lesson already has **the blank space under it that the open check will need** (the spacer is as tall as it will be once the check is open). Opening it later changes no scroll geometry, which is what the first attempt got wrong.
    3. **The lesson rests at the end of its text**, on load and while it follows the teacher's writing: the bar sits under the last line and the blank space is below the screen.
    4. **Scrolling on down through the blank space to the bottom opens the check** and counts as opening it, exactly as a folded question reopens at the bottom (the fold machine's own `EXPAND_DIST`, 16 px). From then on it is an ordinary question.
    5. Open, Enter and the reading-thinking field's Open work as before; on a touch screen Open glides from the resting point to the real bottom and the check opens on arrival.
  - **How** (`components/check-blank-space.ts`, fork-owned, the pure rules; the wiring is `DockOverlay` in `components/chat.tsx`, each edit marked `FORK (scroll into a check)`):
    - **The height:** `QuestionDock` keeps its open form mounted and laid out while folded (hidden, zero height), now marked `data-dock-open-form`. The open block's height is the folded block with the bar swapped for that form, the question area counted uncapped, the whole capped as an open dock is (`openCheckBlockHeight`, `measureOpenCheck`). `offer()` reserves the larger of that and the folded block; a ResizeObserver on the form measures again when it rewraps. The reserve still only grows.
    - **The resting point:** `use-stick-to-bottom` takes a custom target (its context's `targetScrollTop`). While a check waits it is the real bottom less the blank space beyond the folded dock (`extra`, kept in a ref and set where the reserve is offered, so it is there before the library's own resize handling). The library only ever slides down, so a learner already in the blank space is never pulled back up.
    - **Opening:** reaching the bottom opens a waiting check only when the blank space is in place for this question, the lesson has since been seen more than 16 px from the bottom, and the last scroll that moved it moved it down (`checkOpensOnScroll`). An arrival that falls inside one of the fold machine's 400 ms mutes is looked at again when the mute ends.

### The owner's decisions and approved words

- **The owner's decisions:** a waiting check stays **folded, and scrolling opens it** (over "open on arrival, like other questions", which would have dropped the Open step); every device, as decided for the first attempt; and **built and shipped to both branches at once**, with no test page and no phone trial first (over the server branch first).
- **A check against upstream's adaptive question layout** (0.7.0 merge, decision 5). After the browser run below, the owner was shown the result and chose **"Leave it as it is"**, over "checks keep the normal width" and over "checks adapt, with the blank space measured to fit". So a check adapts like any other question, and the strip described under "Rulings, limits and open items" is an accepted limit. Nothing was changed in the code for it.

### Rulings, limits and open items

- **Known limit, accepted by the owner (0.7.0 merge, decision 5): a check waiting behind Open against upstream's adaptive question layout.** Upstream 0.7.0 can widen an expanded question and split it into two columns ("Adapt question layout" in Settings → Appearance, on by default; its row is hidden on a phone, `docs/fork/phone-and-tablet.md`).
  - **What the browser run showed** (a production build in headless Chromium, 14 runs across wide screens): a waiting check never shifted the lesson at the moment it opened, so the blank space held. On a wide screen a long check opens in two columns, and a blank strip of 96 to 120 px is then left above it, because the blank space was measured for the stacked, narrower form, which is taller.
  - **Why, from the code:**
    - the layout request (`components/use-question-layout.ts`, `QuestionLayoutRequest`: the available width, the base width, the column floor and a font key) has no "expanded" term for a folded check, so the hidden folded form (`data-dock-open-form`, kept laid out at zero height) is laid out at the narrow dock width, while the open check, once opened, may widen and split into two columns (`components/question-layout.ts`; `data-question-layout="columns"` in `components/question-dock.tsx`);
    - `measureOpenCheck` (`components/check-blank-space.ts`) reads the first `[data-dock-scroll-area]` inside the form; in two columns that attribute is on the question column only (`question-dock.tsx` puts it on the stacked area or on the columns' areas), so the open check's height, and with it the blank space kept under a waiting check, is measured for the stacked shape, not the one that opens.
  - Phone and narrow windows get no adaptive layout, so the rule there is as written above.
- **Rulings made while building (for the owner to review):**
  - **"Moved down."** Without it, anything that clamps the lesson to its bottom (the keyboard closing, a taller window, content getting shorter) would have opened the check by itself; those all move the lesson up.
  - **Back to the resting point** (`backToRest`). When the lesson or its scroller changes size (messages taking their real height after load under the off-screen rule, a taller or wider window, the blank space growing), a lesson that was resting at the end of the text is put back there, through the library's own setter. One the learner had scrolled into the blank space is left where it is. Found in the browser: at iPhone size the load left the lesson about 300 px into the blank space; and the independent check found a taller window doing the same, which was a rest point worked out from a half-updated layout (fixed: it is read from the spacer as it is in the page). A lesson that stopped short of its resting point at load, with no check involved, is a different fault with its own rule: "Rest on open" below.
  - **A plugin's check keeps upstream's behaviour** (Coding questions: no blank space, Open only). The owner was told with the plan.
  - **A lesson too short to scroll** keeps its check behind Open.
- **Seen, not changed:** a hard flick from 1,500 px up ended 33 to 63 px short of the bottom, folded (3 of 3 in the second run, 1 of 3 in the first); scrolling on opens it. With the learner part-way into the blank space and the window then made taller, the two runs disagree on whether the lesson was moved (the implementer's: not moved; the verifier's: 118 px); it stayed folded in both and opened at the bottom afterwards.
- **Not checked:** Safari on a real iPhone or iPad, the real keyboard, the Windows app, a lesson of hundreds of messages (the test lesson has 59), a check arriving live from a model.
- **Only the owner's iPhone can show:** Safari's momentum through the blank space (a hard flick can stop a few pixels short of the bottom, folded, as for any folded question); whether Safari keeps the view still when messages above take their real height (if not, the back-to-rest rule covers the lesson getting shorter); and how the opening looks at the moment of arrival. The first attempt passed every browser case too.
- **Known limits:** a jump of the browser's own that moves the lesson down to within 16 px of the bottom with no change of the lesson's height could open the check by itself (not seen); a check arriving live from a model was run in the scripted lesson only.

### Code and tests

- **Tests:** `tests/check-blank-space.test.ts` (the rules), `tests/dock-touch-reveal.test.tsx` (the scripted lesson with the real `use-stick-to-bottom`: folded and at rest on load and on arrival, never opening with no input, opening at the bottom with no change of the reserve and no fold after, a lesson too short to scroll, Open from rest and from far up, a stopped glide then a scroll to the bottom by hand, a taller viewport at rest and in the blank space, the reserve growing at rest, a normal question unchanged).

## Rest on open

- **What the learner gets:** a lesson opens at its resting point and stays there until the learner first scrolls, taps or presses a key. The resting point is the bottom of the lesson, or, for a lesson whose check waits folded, the end of the text ("Scrolling into a check"). Before this, a lesson could open 12 to 135 px above its resting point and stay there, with the slide to the bottom no longer following the lesson as it grew. Seen in Chromium; whether Safari does it is not known.
- **The cause** (measured, production builds, with the library's state, every `scrollTop` write with its stack, every scroll event and the library's 1 ms timeouts logged):
  - the off-screen rule (`docs/fork/performance.md`, "The off-screen rule") gives older messages an estimated height until they are drawn. When one above the screen takes its real height and is shorter than its estimate, the browser's scroll anchoring lowers `scrollTop` with it;
  - `use-stick-to-bottom`'s scroll handler takes a decrease of `scrollTop` for the learner scrolling up, unless its one shared `resizeDifference` is non-zero when its 1 ms timeout runs. On the loading main thread that timeout ran 25 to 85 ms late, after a later ResizeObserver callback had set `resizeDifference` back to 0. The library then stops following (`escapedFromLock` true, `isAtBottom` false), and later growth is not followed;
  - two logged loads: an ordinary lesson, timeout queued at 1931 ms and run at 1958 ms, after the reset at 1955.8 ms: 111 px short; a check lesson, queued at 1644 ms and run at 1729 ms: 30 px short. In the failing check-lesson loads the shifts came from older rows just above the newest turn (estimated 700 px, real 470 to 495 px);
  - the fork's `backToRest`, `targetScrollTop` and growth mute were not involved. Inferred, not tested: why the check lesson failed only with the newest-turn exemption.
  - The library is unchanged; the fork's rule works around it.
- **The rule** (`components/rest-on-open.ts`, fork-owned; the pure rules are `restOnOpenStep` and `viewMovedByOther`, wired by `installRestOnOpen`):
  - from the moment a lesson opens until the learner's first wheel, touch, pointer press or key press anywhere on the page (`REST_END_EVENTS`), a lesson more than 2 px above its resting point (`REST_TOLERANCE_PX`), with no library slide under way, is put back through the library's own setter, and the library is set following again (`scrollToBottom("instant")`). The resting point is the library's own target: the bottom, or the end of the text while a check waits folded. A lesson at rest whose library had let go is set following again without moving. A lesson below its resting point is never moved, and one too short to scroll neither;
  - it looks 5 ms after each scroll event of the lesson (`REST_CHECK_DELAY_MS`, after the library's 1 ms decision) and after each resize of the lesson or its content, and waits frame by frame while a slide runs;
  - **it ends for good:**
    - at the first input above;
    - at a scroll event that moved what is on screen other than by the library's setter (`viewMovedByOther`: scroll anchoring moves `scrollTop` and leaves the rows on screen still, where a real scroll moves every row's edges the same way by more than 2 px). This is needed because Chromium scrolls a wheel on the compositor, and the page can see the scroll with a late wheel event or none. A scroll up found this way also calls the library's `stopScroll`;
    - at any jump (Find, a citation, the Tutor's "Show in the lesson", a link to a message: all go through `revealOffscreenTarget` in `components/offscreen-target.ts`, which calls `noteLessonJump()`);
    - it never starts when the lesson opens on a `#message-…` link (`opensOnMessageLink`);
  - a put-back is noted in the check space as not a move down (`onPutBack`), so a waiting check still never opens by itself;
  - while it is active it wraps the `scrollTop` setter of the library's state object, so the library's own moves are not taken for the learner's, and gives the setter back as it was when it ends;
  - the off-screen rule, its size estimates and the newest-turn exemption are unchanged. No size estimate cured the fault in the runs (the measurements are in `docs/fork/history/performance.md`, "Rest on open").
- **Why it was needed now:** the fault is older than the 0.7.0 merge for ordinary lessons (the fork's own off-screen rule, in the releases since the performance round). The newest-turn exemption (decision 6 of the 0.7.0 merge) made it show on check lessons at 1366 wide too.

### The owner's decisions and approved words

- **The owner's word on the fault:** "fix it first then ship".

### Rulings, limits and open items

- **The recommendation for decision 6 was wrong in this one respect.** It said the newest-turn exemption had no cost; for check lessons at 1366 wide it made the fault show. The owner has been told. The exemption stays: with the fix every measured case is 30 of 30.
- **Rulings made while building (for the owner to review):** it runs on every device, the desktop app included (it acts only when a lesson stopped short with no input); any key press ends it, not only a scrolling key; the wrapped setter (above).
- **Known limits:** a scroll that moves nothing visible on screen (some assistive-technology scrolls) is not seen as the learner's; a misread the other way only ends the rule early, and the lesson then behaves as before.
- **Not checked:** Safari, a real iPhone or iPad, the Windows app. Only the owner's devices can show whether Safari's anchoring behaves like Chromium's.

### Code and tests

- **Code:** `components/rest-on-open.ts`; one effect and one import in `DockOverlay` in `components/chat.tsx` (`FORK (rest on open)`); one call in `revealOffscreenTarget`, `components/offscreen-target.ts` (fork-owned).
- **Tests:** `tests/rest-on-open.test.tsx` (the rules; a control that reproduces the library's fault; the sequence from the frame logs: a jump, heights settling, a 24 px anchoring shift, then 413 px of growth; the learner's input, a jump and a message link ending it; a waiting check not opened).

## Money is not math

- **Money is not math: the renderer's own rule** (owner's report after the money bullet shipped, with two screenshots from the iPhone: "comparing $73,000 with $70,000 measures the lifetime gain" drawn as "73,000*with*70,000", and "the $3,000 fair-value loss and removing the remaining $3,000" as one italic run; an older chat, where the model had written its amounts inside formulas, was fine).
  - **Why the bullet didn't hold:** it is a request to the model. The model in the screenshot wrote bare amounts anyway, and no instruction repairs a reply that is already saved.
  - **The rule** (`isMoneyPair` in `src/core/content-reader.ts`): a pair of single dollars is money, not a formula, when it **opens on a digit** and its **closing dollar looks like the start of an amount or a formula, never the end of one**:
    - after whitespace, an opening bracket or an opening quote ("$73,000 with $70,000", "$5 fee and $x$", "$100 ($x$ each)"), the closing dollar must be followed by something an amount or a formula can start with. Whitespace, closing punctuation or a table's pipe after it means a formula typed with a space before its closing dollar ("$1 + 2 $ and"), which stays math;
    - straight after one of the separators amounts are joined with (`-`, `–`, `—`, `/`, `,`, `;`, `&`, `~`, a bold's `*` or `_`), it must be followed by a digit ("$5-$10", "$5/$6").
    - **Never money:** a pair that doesn't open on a digit; a formula that closes on a letter, a digit, a closing bracket, `!`, `=` or `%`, whatever follows it (`$2x + 3 = 7$`, `$3$4`, `$5!$6`); every `$$…$$` and every `\(…\)`.
    - **The end of the text counts as a start**, so money still being written never flashes as a formula while a reply streams.
  - **Only the opening dollar is given up.** The dollar that would have closed the pair is read afresh, so it can still open a real formula: "costs $5, so $3$ units" is an amount and a formula, and a table with a money column beside a formula column keeps its formulas. (A first version escaped both dollars when the second was followed by a digit, and broke exactly those; found while probing, before anything was committed.)
  - **How:**
    - the span reader (`readContentSpans`) no longer reports a money pair as math and hands back the offsets of the money dollars. Everything that reads spans sees money as prose, so the display repairs for tool text never work on the words between two amounts;
    - `transformMathDelimiters` (`src/core/math-delims.ts`) puts a backslash before each of those dollars, so the Markdown reader shows it as text and pairs the later dollars as the span reader did. One parse, as before; the result is cached as before.
    - **Display only:** the stored text is never rewritten, which is why replies saved before the change come out repaired.
  - **Where it applies:** everything drawn through the lesson's Markdown (`MessageResponse`): lessons, practice problems and questions, the Tutor, reasoning, helper cards, and the notes drawer's Read view (the learner's own notes get the rule too).
  - **Not changed:** the Tutor's divider text (`plainFirstWords` in `src/core/tutor-view.ts`) has its own formula pattern and still ends a step's first words at the first of two amounts, with "…".

- **Money amounts no longer turn into a formula** (owner's report, a practice problem: "On January 1, a company purchases a debt security at its face value of $100,000 … it receives $6,000 of interest" was drawn as one long italic formula, with the bold's asterisks showing).
  - **The cause:** in upstream's renderer two bare `$` in one paragraph are a formula's start and end, and the agents' formatting instructions say `$...$` is math and nothing about money. A model that wrote each amount as its own formula (`$\$600{,}000$`) rendered fine; one that wrote bare amounts didn't. Upstream's Flashcards generator already carries a line about literal dollars; the lesson's agents didn't.
  - **What was built:** one bullet in `src/agent/prompts/shared/40-formatting.md`, under the Math bullet, wording approved by the owner: "Money: a bare `$` opens math, so two amounts in one paragraph turn everything between them into a formula. Escape currency in prose as `\$20` (in JSON strings: `\\$20`), or keep it inside math as `$\$20$`. Literal tokens such as `$HOME` go in inline code." That fragment is composed for the prober, the teacher, practice and side questions (the Tutor).

### The owner's decisions and approved words

#### Money is not math: the renderer's own rule

- **The owner's decision** (it replaces "the instructions only"): the renderer tells money from math, **on the condition that math is still displayed properly**. The owner approved the rule and the plan in chat; the bullet stays as a second net.

#### Money amounts no longer turn into a formula

- **The owner's choice** (of three: the instructions, the renderer, both): "a fix that won't break anything", so **the instructions only**. The renderer was left unchanged then, so nothing that drew correctly could change. **Replaced since** (owner's decision): the renderer now tells money from math too, and that rule is the main fix; the bullet stays as a second net; see "Money is not math" above.

### Rulings, limits and open items

#### Money is not math: the renderer's own rule

- **The rule as the owner approved it was simpler** ("a digit after the opening dollar, and a space before the closing one or a digit after it"). It was narrowed while building, always towards the owner's condition, after an independent check found real math it lost: a formula directly followed by a digit (`$3$4`, `$2x$5`), a formula typed with a space before its closing dollar and the formula after it (`Sum of $1 + 2 $ and $3$`), the same against a table's pipe, and a factorial before a digit (`$5!$6`). The owner has been told.
- **Limits the owner has been told:**
  - a formula that starts with a number and has whitespace before its closing dollar, **at the very end of a text** ("… is $1 + 2 $"), shows as plain text. With anything after it, it is math. It is the price of the end of the text counting as a start (above); both are pinned by a test;
  - a currency written with letters before the dollar is still garbled, as before the change: "US$5 and US$6" (the pair closes on a letter, which is what a formula does).
- Not checked: a real model, the owner's own saved chats, a real iPhone.

#### Money amounts no longer turn into a formula

- **Limits the owner has been told:** it makes the glitch rare, not impossible (a model can still slip, and a backslash doubled once too often in a tool argument, `\\$`, still opens math); text already garbled stays garbled; a learner who has switched on their own Formatting text in Settings keeps that text; the background helpers (research, demos, visuals, PDF) have their own instructions and aren't changed.

### Code and tests

#### Money is not math: the renderer's own rule

- **Tests:** `tests/money-not-math.test.tsx` (the rule; the owner's sentences as a message and as a tool's text; lists, tables, code, already-escaped amounts, price ranges; every shape of real math untouched byte for byte and still drawn, the checks' findings among them; the owner's old chat; money beside math, a formula that starts with a number after an amount, a table with both, 60 alternations in one paragraph; and every prefix of a formula and of a money sentence, for a reply still being written). Two of upstream's cases in `tests/render-markdown.test.tsx` pinned "bare currency is left untouched" and now expect the escape; the "still read as a formula" case in `tests/prompt-money.test.tsx` is turned round.

#### Money amounts no longer turn into a formula

- **Tests:** `tests/prompt-money.test.tsx` (the bullet word for word, reaching all four agents; each form rendering as the bullet says; and that two bare amounts in one paragraph now stay text: this case pinned them as a formula until the renderer's own rule turned it round).

## Demos and figures follow the theme

- **Demos and figures follow the theme** (owner's ask: "make it so that demos default to dark mode/light mode depending on theme").
  - **What the learner gets:** a demo or figure never flipped shows dark on a dark theme and light on a light one, and changes at once when the theme changes. The full-screen figure view opens the way the card shows. Annotated photos never invert, as before. Unchanged: how demos are written (still built light, on white), downloads and sync. On a session another device holds a flip was refused when this was built; since seamless sessions it moves the session here first, then saves (`fetchHere` in `components/artifacts/demo-card.tsx` and `visual-card.tsx`).
  - **How:** the steer card hands the saved switch through as it is (`data.ui?.inverted`, undefined when never flipped; it used to become `false`), and `DemoOutputCard` and `VisualOutputCard` take `savedInverted` and fall back to `useAppearance().resolvedMode === "dark"`. A flip saves through the artifact-ui route as before. Each edit in the two cards is marked `FORK (theme default)`; the steer card's two changed lines carry no marker.

### The owner's decisions and approved words

- **The owner's decisions:** the existing "Invert colors" switch starts on for a dark theme and off for a light one (over demos built with their own dark colours, and over both together); a switch the learner has flipped is kept as set on every theme and device, and demos flipped before this keep what they saved (over "the opposite of the theme"); figures follow too, not demos only.

### Rulings, limits and open items

- **Not checked:** a real iPhone, iPad or the Windows app.

### Code and tests

- **Tests:** `tests/artifact-theme-default.test.tsx` (both kinds on a dark and a light theme, a saved choice both ways, the steer card's hand-through, a live theme switch and a flip sticking through it); the two asserts in `tests/demos.test.tsx` that pinned "off by default" now read "on, on a dark theme".

## Highlight, then Ask on a touch screen

- **On a touch screen (phone and tablet) the toolbar shows after a press-and-hold selection**, beside the system's own Copy / Look Up box (owner's report: on the iPhone and the iPad only the system's box showed, with no way to Ask). Shipped to both branches with the touch batch (the owner's word: "ship"); not yet confirmed on the owner's iPhone or iPad.
  - **The cause:** upstream reports a selection when the mouse is released. A press-and-hold selection on iOS sends `pointerdown`, then the system takes the touch (`pointercancel`), and never a `mouseup`; upstream's "a press is under way" flag then stayed set for good and every later selection was ignored. Dragging the handles sends the page only `selectionchange`.
  - **When:** decided per gesture from `pointerType` (touch, or a pen: an Apple Pencil counts as touch), never from the screen width, so a mouse on a computer, a touch-screen PC's mouse included, is exactly as before (at once after a click's release, 500 ms after a double or triple click, at the pointer). **In a browser only:** in the desktop app every gesture keeps upstream's behaviour, a finger on a touch-screen PC too ("Still as on a computer" in `docs/fork/phone-and-tablet.md`; `touchSelectionHere`, the same rule as `isBrowserNow`). On touch the toolbar first shows once the selection has stopped changing for `TOUCH_SETTLE_MS` (300 ms) and no finger is down (a finger that never reports lifting holds it back at most `TOUCH_FINGER_WAIT_MS`, 1.5 s). It goes when the selection is cleared. On Android the long press's `contextmenu` comes first; the toolbar still shows once the selection rests.
  - **Once shown, it follows the selection** (owner, iPhone: "the cite/ask buttons do work as intended, but they take way to long to reappear after i resize the selection box. please make these feel almost instant"). It used to hide at every change and come back 300 ms after the handles rested. On a test page run on the owner's iPhone (Test 2 of a bench page with three choices: as before, back after 60 ms, and "Stays, follows") the owner chose **"Stays, follows"**: "b is best. i didn't even know that was possible". So a change that leaves a selection in the lesson doesn't hide it: it is placed again for the selection as it is now, by the same rule, at the next animation frame (several changes in one frame are placed once), with no settle wait and no finger wait; the handles send the page no touch or pointer events, so there is no lift to wait for. It may switch sides when the selection's centre crosses the middle; it just moves. The same element is kept (no unmount, no entry animation), the passage Cite and Ask act on is the selection as it is now, and the place is measured afresh each time with the toolbar's real size.
  - **While the lesson scrolls** (a handle dragged to its edge autoscrolls it) the toolbar is hidden, because a fixed element moved from script would trail the scroll; it is placed again 150 ms after the last scroll event (`SCROLL_SETTLE_MS`, upstream's), plus a frame, with no settle wait on top. A finger scroll, a new press and hold, a tap elsewhere, Esc, the window losing focus and focus moving into a text box end the following, also while a scroll has the toolbar hidden (it then doesn't come back when the scroll settles; found by a reviewer): the next selection settles first again, as at the first appearance.
  - **Tapping a button works although iOS may clear the selection first:** a press that starts on the toolbar keeps it, with the passage it captured, until that press has ended and its click has been handled (or `TOUCH_ACTION_RELEASE_MS`, 400 ms, after the finger lifts with no click). It doesn't rely on `preventDefault` on the press.
  - **Where (owner's choice: "opposite side", over a fixed bar above the message box and over always below the selection):** the system's box can't be moved or seen by a page, so the buttons go on the side opposite where it is predicted:
    - iOS puts its box on the side with more room: **below** the selection when the selection's vertical centre (the middle of its first line's top and its last line's bottom) is above the middle of the visible screen, **above** otherwise. The switch is `SYSTEM_BOX_SWITCH` (0.5 of the visible height). The visible height is what the phone layout already uses for `--lh-vvh` (in the home-screen app it includes the clock strip that the iPhone leaves out of `innerHeight`), elsewhere the visual viewport's height; measured from the visual viewport's top. The app's own top bar is not allowed for: iOS doesn't know about it.
    - box predicted below → the buttons **above the start of the selection**, from its first line's left end; box predicted above → **below the end**, from its last line's right end. Both `TOUCH_HANDLE_GAP` (18 px) from the text, clear of the handles' knobs (about 12 points beyond the first and last line, from the owner's screenshots).
    - **Bigger buttons on touch:** 32 px tall (24 on a computer), 15 px text, a 16 px icon and a little more side padding, the same look otherwise (`TOUCH_BUTTON_CLASS`; `TOUCH_TOOLBAR_HEIGHT` = 32 before the toolbar is measured). Owner: "a little bigger and a tiny bit closer", after seeing screenshots; the gap was 24 px at first. A mouse keeps upstream's size and place.
    - no room on that side (the selection starts right under the top bar, or ends right above the dock) → on the system box's side, beyond it, `SYSTEM_BOX_CLEARANCE` (70 px) from the text (the box reaches about 62 points from it); no room there either (a selection that fills the lesson) → under the end, clamped inside the lesson and the visible screen, as on a computer. Never beside the box: it is centred on the selection and nearly as wide as the screen.
    - **The owner's measurements** (iPhone, home-screen app, 440 × 956 points; the lesson from 147 to about 830), where the system's box went:

      | Selection (line centre, pt) | System box |
      |---|---|
      | one word at 327 | below |
      | one word at 414 | below |
      | five lines, 404 to 523 (centre 464) | below the end |
      | one word at 550 | above |
      | one word at 646 | above |

      The box is about 43 points tall, 15 to 19 points from the selection, and up to 344 of 440 points wide. Only the iPhone's home-screen app was measured; a Safari tab and the iPad use the same rule. The switch-over (between 464 and 550 points) and the two gaps can be tuned only on the owner's devices.
  - **"No room" is judged against what is really visible** (found by a reviewer: a selection ending just above the message box put the buttons on top of it, because the lesson's box runs under the dock). On touch the lesson's box is cut at the top of the dock (`[data-phone="dock"]`: the message box, or an open question, which is taller) and at the bottom of the top bar (`[data-phone="topbar"]`) where they overlap it (`visibleLessonBounds`). So a selection ending right above the dock sends the buttons to the system box's side, beyond the box (iPhone 13 size: a selection at 530–552 with the dock at 562 put them at 570–602 over the message box; now at 428–460, above the start).
  - **While the iPhone keyboard is up** the body is shifted and is the frame for fixed elements, so the touch toolbar's position is measured from the body's top (`fixedFrameTop`, `touchToolbarTop`), as the fork's other fixed elements are. With no shift the numbers are upstream's. Not tried with a real keyboard.
  - Scope as on a computer: the lesson's text. A held session's buttons are not greyed (since seamless sessions `components/chat.tsx` passes nothing as `blocked`); a press on Cite or Ask starts moving the session here (`prewarmSessionMove` in `components/cloud/session-move.ts`).

### Rulings, limits and open items

- **Only the owner's devices can show** where iOS really puts its box and handles beside the buttons, whether a tap on Ask or Cite lands the first time (on iOS, and with an Apple Pencil), and how the timing feels. Chromium's touch emulation makes no press-and-hold selection; the browser run used iOS's event sequence from a script.

### Code and tests

- **Code:** `components/phone/touch-selection.ts` (the constants, the placement rule, the visible screen and the visible lesson, the browser gate, the shifted frame); small, commented edits in upstream's `components/selection-actions.ts` (the touch timing and the held press) and `components/selection-toolbar.tsx` (the touch placement). **Tests:** `tests/selection-touch.test.ts` (the five measured rows, the two no-room fallbacks and the clamp, the dock (a message box, an open question, none), the shifted body, the desktop app keeping upstream's behaviour for a finger and a pen, scripted touch sequences, following a resize (placed again at each change and never hidden, once per frame, the side switching as the centre crosses the middle, the selection cleared, a new press and hold settling first, hidden during an autoscroll and back 150 ms after it plus a frame, a press on the toolbar during it), and the mouse's timing and placement unchanged).

## Dictation

- **Dictation in Firefox** (owner's report, Firefox on an Android phone: "it clicks for 1 second, then turns off").
  - **The cause below is a working assumption:** no Firefox could be run in the development sandbox, and the owner couldn't try Chrome on the same phone. The owner's phone is the proof.
  - **The assumed cause:** the recorder runs one audio engine at 16,000 samples a second (`new AudioContext({ sampleRate: 16000 })`, what Deepgram is told), and a phone's microphone runs at 48,000 or 44,100. Chrome, Safari and the desktop app convert. Firefox refuses to connect a microphone stream to an engine at another rate (`createMediaStreamSource` throws `NotSupportedError`; Mozilla bugs 1725336 and 2001200, open when this was written). The button is on from the tap (upstream's optimistic meter), so the run ended about a second later, when the connection was refused.
  - **The fix** (approved by the owner with the plan): on that refusal the same run retries once with an engine at the device's own rate, and the audio worklet converts to 16,000 before it posts audio. Deepgram's settings and the upload's size are unchanged. Later runs on that page go straight to the device-rate engine.
    - **Told by the refusal, never by the browser's name**, so Firefox goes back to the normal path by itself once Mozilla fixes it.
    - **Every browser where the 16,000 engine works makes the same calls as before**, and the worklet's unchanged path gives the same samples (a test compares it with the file as it was, kept as a fixture).
    - **The conversion** (`public/worklets/pcm-capture.js`, `processorOptions.targetRate`): from a higher rate, each output sample is the mean of the input over its exact time window, with the boundary sample split; from a lower rate (8,000), linear interpolation. State is carried across the worklet's 128-sample blocks. No filter beyond the averaging, so tones above 8 kHz fold back; fine for speech.
    - **Not chosen:** sending at the device's rate and telling Deepgram (three times the upload on mobile data).
    - Any other failure, or a failing retry, ends the run with its reason as before.
  - **Code:** `components/dictation.tsx` (`needsNativeRate`, `dropAudioGraph`, `isGraphRateError`, `buildGraph` in `start`; each edit marked `FORK (Firefox sample rate)`), `public/worklets/pcm-capture.js`. Tests: `tests/dictation-native-rate.test.ts` (the worklet), `tests/dictation-native-rate-flow.test.tsx` (the recorder with stand-in engines).

- **Dictation after the app was away** (owner's report, the iPhone's home-screen app: "my dictation isnt working after i close my ios learnharness web app and reopen it. and sometimes it shows a red error message that mentions deepgram").
  - **The cause below is a working assumption:** Chromium has no such interruption, and the owner couldn't reproduce the red line to read it. The owner's iPhone is the proof.
  - **The assumed cause:** the recorder keeps one audio engine for the life of the page (upstream's `sharedCtx`) and woke it only when it read "suspended". When iOS puts the app in the background it interrupts the engine, and it can stay that way after the app is shown again: its state reads "interrupted", or `resume()` never settles (WebKit bugs 263627, 273511, 276016, 281566, 281955 and 291892, open when this was written). Used as it was, the engine clocked nothing: the bars stood still, no audio reached Deepgram, Deepgram hung up after about 10 seconds, the one reconnect got no audio either, and the run ended with "Deepgram connection lost (…)" about 20 seconds after the tap. A run stopped before that ended with no words and no message.
    - The same red line came from leaving the app during a run: iOS takes the microphone from a home-screen app in the background (WebKit bug 239602), the connection dies, and the reconnect gets no audio.
  - **Starting a run:**
    - an engine that reads "running" is used as before: no new call and no wait;
    - any other state: a kept engine's `resume()` is given at most 500 ms (`ENGINE_RESUME_CAP_MS`). Still not running, the engine is closed and a fresh one built in the same run (the Firefox fix's `dropAudioGraph`), once per run. A fresh one that won't run either ends the run with "Microphone didn't start. Try again.";
    - **a net that holds nothing up:** 700 ms after the recorder is wired (`ENGINE_SILENT_CHECK_MS`), an engine that has sent nothing from its worklet and whose clock (`currentTime`) hasn't moved is replaced the same way, with the same microphone stream, the connection and the queued audio left alone. It shares the one replacement per run; silent again, the run ends with the same sentence. The clock is read because it doesn't depend on the page's own thread being free;
    - **an engine made in this run is waited for 4 seconds** (`ENGINE_LAST_CHANCE_MS`), at its `resume()` and at the silent check that would end the run: the page's first engine, and a replacement. A healthy engine can be slow to start (the sound moving to a headset), there is nothing to fall back to after it, and before this change the recorder waited for it with no limit. Found by the independent check: with 500 ms for both, a slow start would have ended in the new sentence;
    - **told by the symptom, never by the device's name**, so every device where the engine runs makes the calls it made before.
  - **The microphone taken away during a run:** the run stops as if Stop was tapped. The words so far land in the box, and no error shows.
    - **What counts:** a microphone track that ended; a track the system muted; the engine no longer running (`captureEvidence` in `components/dictation-capture.ts`). Only positive evidence counts.
    - **When it is looked at:** at the track's `ended` and `mute` events, the engine's `statechange`, the page's `visibilitychange` (both ways), and when Deepgram's connection drops.
    - **Stopped at once** for an ended track, while the page is hidden, and for 2 seconds after it is shown again (`SHOWN_RECENTLY_MS`: what iOS queued while the page was frozen arrives then). **With the page in front the whole time** a mute or an engine that stopped is looked at again after 1.5 seconds (`LOSS_GRACE_MS`) and stops the run only if it still holds, so a moment's mute while the sound moves to a headset doesn't end a dictation.
    - **A connection that drops with the capture lost** ends the run with its words and no reconnect. With the capture alive it reconnects once, as upstream built it, and "Deepgram connection lost (…)" stays for a real network loss.
    - **Not a reason:** the page being hidden. Dictating on a computer with another window or tab in front carries on as before.
  - **The Tutor's Dictate** uses the same recorder and gets both parts.
  - **A tap on Stop while an engine is being replaced** ends the run as any Stop does: nothing more is wired, and no error shows.

### The owner's decisions and approved words

#### Dictation after the app was away

- **Leaving the app during a dictation: it stops and the words are kept** (the owner's choice of three, from drawings; the others were carrying on by itself at the return, which would switch the microphone on without a tap, and stopping with the words thrown away).
- **The sentence** when no engine will run (`DICTATION_MIC_DEAD` in `components/dictation-capture.ts`; the owner's choice of three): "Microphone didn't start. Try again." A tap on Dictate tries again, as after any failed run.
- **Every device** gets the taken-away rule (over browsers only, and over touch browsers only). On a computer it matters only when the microphone really goes during a run (unplugged, say): the run used to carry on in silence until stopped.
- **The plan** (the two parts above, told by the symptom) was approved by the owner in chat.

### Rulings, limits and open items

- **Dictation after the app was away:**
  - **Rulings made while building (for the owner to review):** the numbers (500 ms for a kept engine's wake-up, 700 ms for the net, 4 seconds for an engine made in the run, 2 seconds after the page is shown, 1.5 seconds of grace in front); a kept engine whose `resume()` is slower than 500 ms gets a fresh engine, which costs the building of one and nothing else; an engine that takes longer than 4 seconds to start ends the run with the sentence, where the recorder used to wait without limit; an engine that merely reads "suspended" during a run, with the page in front, stops the run after the 1.5 seconds; a connection that drops while the capture reads lost ends the run at once, without the 1.5 seconds, also with the page in front.
  - **Known limits:** if iOS leaves the microphone alone while the app is away and nothing is seen lost at the return, the dictation carries on; an audio failure that only reloading the page cures (WebKit bug 319706, iOS 26) ends in the new sentence, and closing the app fully is the way out; a run whose engine stops clocking later than the 700 ms check, with nothing else seen, still ends in upstream's "Deepgram connection lost (…)".
  - **Not checked:** a real iPhone or iPad, the home-screen app, a real microphone, Deepgram itself. WebKit's bug pages couldn't be opened from the development sandbox (the host is outside its network); the bug numbers and what they say are from search results.
  - **Only the owner's iPhone can show** whether a fresh engine runs where the kept one is stuck, whether the words land when the app is left during a run, and what the red line reads if a dictation still fails: ask what it reads.

- **Dictation in Firefox:**
  - **Not checked:** a real Firefox, on Android or a computer; a real microphone; Deepgram's own recognition of the converted audio. If it still turns off on the owner's phone, the line above the message box now says why: ask what it reads.

### Code and tests

- **Dictation after the app was away:** `components/dictation-capture.ts` (fork-owned: the sentence, the five numbers and the rules `engineRunning`, `captureEvidence`, `captureLost`, `lossAction`, `engineSilent`, `resumeWithin`); `components/dictation.tsx` (`runningEngine`, `watchCapture` and `armSilentNet` in `start`, the check in the socket's `close` handler, `disarmCapture` in `cleanup` and `stop`; each edit marked `FORK (dictation after the app was away)`). Tests: `tests/dictation-app-away.test.tsx` (the recorder with stand-in engines, tracks and a page that can be hidden: a stuck engine replaced, a suspended one woken with the calls of before, a healthy one untouched, no engine running, an engine that is only slow, the silent net, Stop during a replacement, a track ending, a mute hidden, just shown and in front, the engine interrupted, the page hidden with a live capture, the connection dropping both ways, the Firefox fallback beside it, and the rules).
