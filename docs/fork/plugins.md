# Plugins: what was tried, security, and the Apple Pencil

## The Drawing Pad

### The Drawing Pad, as tried on a computer (nothing of upstream's changed)

- **Draw** sits in the lesson's top bar right of Notes and the ring. With too little room (the notes drawer open, a narrow window, a long title) it moves into upstream's ⋯ menu.
- The pad covers the lesson under the top bar. **An open question is already on the sheet**, with its options, as a read-only picture to draw on or around; the answer is picked after closing the pad. With the notes drawer open the pad narrows beside it.
- Not tried: sending a drawing to the teacher (it needs a real model).
- **On an iPad (owner's):** a resting palm became one big selection box over the pad. The fork now cancels finger and palm touches on the pad's drawing area, makes the pad unselectable and clears a stuck selection at the next touch, from its own touch files, without changing upstream's plugin ("Palm rejection on the Drawing Pad" in `docs/fork/phone-and-tablet.md`).

## The other core plugins

### The other core plugins, as tried on a computer (nothing changed)

Run in a browser against a stand-in model that poses the questions and writes the cards; no real model, not on Windows, not in the server image.

- **Rich code blocks:** a `smiles` molecule, an `abc` score and a `tikz` diagram all draw; ordinary code fences stay code. The three families are off until switched on in the plugin's own Settings page. TikZ is compiled in the browser.
- **Coding questions:** a coding problem in a practice session and a coding question in a teaching session were posed, answered in the code editor and submitted; the tests ran ("Tests passed", "Tests failed" with the error text), the model solution showed, and the teacher got the result. A teaching "check" waits closed behind **Open**, like upstream's own checks.
  - It runs whatever program the teacher names, from the machine's PATH. The server image has Node and a shell but no Python and no compiler, so a Python or C question there ends in "Could not run tests" (the answer is still accepted). On the PC the language's runtime must be installed and on PATH.
- **Flashcards:** picking topics from the graph, the cost preview, generating, the deck, and a review with its four ratings all work. Generating from a file wasn't tried. Decks and review history were per device then (decision 17); since Flashcards sync, Flashcards' library syncs between the desktop app and the server ("Flashcards sync" in `docs/fork/cloud-sync.md`).

## Plugin security

### Plugin security: the facts, and options not yet chosen

Read from the code by a reviewer; nothing is built. The owner asked whether the concerns raised at decision 16 can be fixed.

- **A community plugin can only be added by copying a folder into `<data>/plugins`** (on the server: over SSH). Nothing in the app downloads or uploads plugin code, and the agents' file tools only read. A signed-in browser can switch on a plugin that is already there.
- **A switched-on plugin is fully trusted code**, core or community alike: its back end is loaded into the server's own process (files, network, environment, child processes, every session, model calls on the owner's credentials, its own tools and prompt text for the agents), and its front end runs in the app's page with the app's own API rights. No permission model, no sandbox; upstream names this a non-goal (`docs/plugin-architecture.md`).
- **Coding questions is the one that runs model-written programs:** one spawn point (`plugins/coding-questions/src/runner.ts`), no shell, the server's whole environment inherited, a 30-second limit, no isolation. The learner never sees the test program. The realistic attack is a web page or document the teacher reads steering it into writing a harmful one. On the server that program could read `/data` (notes, sign-ins, keys).
- **What no option fixes:** a plugin the owner installs and switches on can do whatever LearnHarness can. On the Windows PC there is no practical sandbox for test programs.
- **The owner's direction since:** write the fork's own coding questions plugin, for Python, JavaScript and SQL, whose code and tests run in the learner's browser and never on the machine. A draft plan for the next session is `docs/fork/plans/own-coding-plugin-plan.md` (not approved, nothing built). The six options above are still unchosen; the plan asks about option 1 with its other decisions.

### Rulings, limits and open items

- **Options told to the owner** (none chosen yet):
  1. server mode refuses community plugins (small);
  2. server mode doesn't offer Coding questions (small), or runs its programs in a second container with no `/data` and no network (medium; needs a few lines at upstream's spawn point);
  3. test programs get an emptied environment (small; both PC and server; same spawn point);
  4. a Content-Security-Policy for the app's pages, so plugin front-end code can't send data elsewhere (medium; `proxy.ts`);
  5. only run a community plugin whose content hash the owner approved (small to medium; upstream's activation code).

## Apple Pencil on an iPad

### Asked about, not started: Apple Pencil on an iPad (owner: "dont start working on it yet")

- The owner wants Notability-like Pencil use in the pad on an iPad: squeeze switches to the eraser, which removes whole strokes.
- **Already upstream's:** pen input with pressure, fingers ignored, and an eraser that removes every stroke it touches (undo restores them).
- **Not possible in a browser:** squeeze. iPadOS gives it to native apps only (UIPencilInteraction); Safari sends a page no event for it. Looked up, not tried on a device.
- **Unsure until tried on the owner's iPad:** how many Pencil samples Safari hands a page (smoothness), hover and barrel roll. LearnHarness had never been run on an iPad when this was asked; the owner has used it on an iPad since (the iPad fixes under "When it applies, and tablets" in `docs/fork/phone-and-tablet.md`), and it gets the computer layout there.
- **The two routes told to the owner:** stay a website and pick a stand-in gesture (a change to upstream's plugin), or a small native iPad app around the server's site that passes squeeze on (a separate project that needs a Mac and Xcode).
