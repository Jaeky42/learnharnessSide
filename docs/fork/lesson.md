# The lesson screen: checks, rendering, dictation and the highlight toolbar

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

### Rulings, limits and open items

- **Rulings made while building (for the owner to review):**
  - **"Moved down."** Without it, anything that clamps the lesson to its bottom (the keyboard closing, a taller window, content getting shorter) would have opened the check by itself; those all move the lesson up.
  - **Back to the resting point** (`backToRest`). When the lesson or its scroller changes size (messages taking their real height after load under the off-screen rule, a taller or wider window, the blank space growing), a lesson that was resting at the end of the text is put back there, through the library's own setter. One the learner had scrolled into the blank space is left where it is. Found in the browser: at iPhone size the load left the lesson about 300 px into the blank space; and the independent check found a taller window doing the same, which was a rest point worked out from a half-updated layout (fixed: it is read from the spacer as it is in the page).
  - **A plugin's check keeps upstream's behaviour** (Coding questions: no blank space, Open only). The owner was told with the plan.
  - **A lesson too short to scroll** keeps its check behind Open.
- **Seen, not changed:** a hard flick from 1,500 px up ended 33 to 63 px short of the bottom, folded (3 of 3 in the second run, 1 of 3 in the first); scrolling on opens it. With the learner part-way into the blank space and the window then made taller, the two runs disagree on whether the lesson was moved (the implementer's: not moved; the verifier's: 118 px); it stayed folded in both and opened at the bottom afterwards.
- **Not checked:** Safari on a real iPhone or iPad, the real keyboard, the Windows app, a lesson of hundreds of messages (the test lesson has 59), a check arriving live from a model.
- **Only the owner's iPhone can show:** Safari's momentum through the blank space (a hard flick can stop a few pixels short of the bottom, folded, as for any folded question); whether Safari keeps the view still when messages above take their real height (if not, the back-to-rest rule covers the lesson getting shorter); and how the opening looks at the moment of arrival. The first attempt passed every browser case too.
- **Known limits:** a jump of the browser's own that moves the lesson down to within 16 px of the bottom with no change of the lesson's height could open the check by itself (not seen); a check arriving live from a model was run in the scripted lesson only.

### Code and tests

- **Tests:** `tests/check-blank-space.test.ts` (the rules), `tests/dock-touch-reveal.test.tsx` (the scripted lesson with the real `use-stick-to-bottom`: folded and at rest on load and on arrival, never opening with no input, opening at the bottom with no change of the reserve and no fold after, a lesson too short to scroll, Open from rest and from far up, a stopped glide then a scroll to the bottom by hand, a taller viewport at rest and in the blank space, the reserve growing at rest, a normal question unchanged).

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
  - **When:** decided per gesture from `pointerType` (touch, or a pen: an Apple Pencil counts as touch), never from the screen width, so a mouse on a computer, a touch-screen PC's mouse included, is exactly as before (at once after a click's release, 500 ms after a double or triple click, at the pointer). **In a browser only:** in the desktop app every gesture keeps upstream's behaviour, a finger on a touch-screen PC too ("Still as on a computer" in `docs/cloud-sync.md`; `touchSelectionHere`, the same rule as `isBrowserNow`). On touch the toolbar first shows once the selection has stopped changing for `TOUCH_SETTLE_MS` (300 ms) and no finger is down (a finger that never reports lifting holds it back at most `TOUCH_FINGER_WAIT_MS`, 1.5 s). It goes when the selection is cleared. On Android the long press's `contextmenu` comes first; the toolbar still shows once the selection rests.
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

### Rulings, limits and open items

- **Dictation in Firefox:**
  - **Not checked:** a real Firefox, on Android or a computer; a real microphone; Deepgram's own recognition of the converted audio. If it still turns off on the owner's phone, the line above the message box now says why: ask what it reads.
