# Cloud sync: approved plan

Status: **Phases 1–4 done (server mode, sign-in on the server, phone layouts, the Obsidian vault on the server). Phase 5 (the sync engine) is built, all six slices: a paired desktop and the server keep sessions, the graph, settings and folders in step. Phase 6 (the screens) is built, all three slices: Settings → Cloud on the desktop app (pairing, sync state, Unpair) and on the server's site (paired desktop apps, pairing codes); a held session ("Held by …", the strip, Take over, the warning box, greyed controls); and the desktop's own notices (the sync chip, the offline heads-up, the discard box). It has run between two built copies only; the owner's real PC meets the real server after the merge.** **Merged into `side-tutor` with the owner's approval, and released to the desktop app as 0.5.6.** The owner then updated the server, followed the pairing guide and reported: "everything works!". Change these decisions only with the owner's approval.

Goal: keep learning progress on several devices. The Windows desktop app stays fully usable, works offline, and keeps the Obsidian connection. A phone uses LearnHarness from the browser.

## Architecture

```
                         ┌──────────── VPS (Docker) ───────────────────┐
  Phone (browser/PWA) ──►│ Caddy (HTTPS) ─► password login gate        │
                         │   ▼                                         │
                         │ LearnHarness server (browser mode)          │
                         │   agents · Claude Code CLI · ChatGPT OAuth  │
                         │   /data  (persistent volume = LH_DATA_DIR)  │
                         │   /api/sync + lease authority               │
                         │ obsidian-headless (`ob sync`) ─► /data/vault│
                         └──────▲───────────────────────────▲──────────┘
                                │ sync over HTTPS             │ Obsidian Sync (E2EE)
                                │ (device token)              │
  ┌─────────────────────────────┴──────┐            ┌─────────┴──────────┐
  │ Windows desktop app                │            │ Obsidian desktop + │
  │  local server + local data         │            │ Obsidian mobile    │
  │  sync engine; works offline on     │            └────────────────────┘
  │  sessions it holds a lease for     │
  └────────────────────────────────────┘
```

- **Source of truth:** an always-on VPS running the browser-mode server.
- **The phone** has no local server; it uses the VPS in the browser.
- **The desktop** keeps its own local server and data under `LH_DATA_DIR` and syncs both ways with the VPS.

## Decisions

### Sessions: leases instead of merging

A teaching transcript can't be merged, because two teachers built on the same turn would diverge. So:

- Only the device holding a session's **lease** may continue it. The VPS is the lease authority.
- **A lease never runs out on its own.** Other devices show "Held by Desktop (offline since …)" with a **Take over** button.
- **Take over warns first** when there is evidence that the holder has turns that haven't synced (see "Phase 5 decisions").
- **No copies** (owner's change during Phase 5 planning; it replaces the earlier "Title (desktop copy)" rule). A device that lost a session to a take-over discards its unsent turns for that session when it reconnects and shows the server's version. The loss isn't silent: the desktop shows a heads-up while it works offline, and a notice after a discard.
- An offline desktop can only continue sessions it held before it went offline.
- A session's notes home folder (`notes/sessions/<chatId>.json`) follows its lease. Its Tutor conversations are inside the chat record since the upstream 0.6.0 merge (`sideChats`), so they travel with it; the separate `side-tutor/<chatId>.json` file is gone.

### Background work

Graph extraction, research, compaction and visuals run on **whichever device holds the session's lease**. Their results sync like other data. This rule prevents duplicate extraction of the same session.

### Data and how each part syncs

| Data | How it's written | How it syncs |
|---|---|---|
| `chats/*.json` | Whole-file rewrite | Lease. The holder pushes whole files with a version number. |
| `notes/sessions/<chatId>.json` | Small JSON | Follows the chat's lease |
| `graph/*.jsonl` | Mostly appends, with some rewrites (see below) | Appends as lines; rewrites as replayed operations |
| `sources.json`, positions, `settings.json` | Read-modify-write maps | Last writer wins per key; device-specific keys excluded |
| `core-plugin-data/flashcards/flashcards.json` (Flashcards' library; since Flashcards sync) | Whole-file rewrite by the plugin | Item by item, latest change wins per item; schedules never travel and are worked out again from the combined reviews (see "Flashcards sync") |
| The other plugins' data, which plugins are on, Flashcards' model choice and its uploaded files' text | Per device | Never synced |
| `notes/settings.json` (vault path), `notes/pending/` | Per device | Never synced |
| `obsidian-sync.json` (the server's Obsidian sync record) | Per device | Never synced |
| `auth.json`, subscription credentials, model caches | Per device | Never synced |

### Graph sync

- **New ids** are random (`n_` / `arg_` plus 12 hex characters, `src/core/graph.ts`), so ids don't collide across devices.
- **The ledgers are not purely append-only.** Session deletion, chain deletion and notes-source removal call `rewriteLedgers` (`src/core/graph-deletion.ts`, `src/core/graph.ts`). Combining lines from both devices would bring deleted data back. Instead:
  - appended lines sync as lines;
  - destructive changes sync as **operations** (for example "delete session X, mode delete-nodes") that each device replays. The deletion code is deterministic and idempotent, so replaying it is safe.
- **Known limit:** whether a new concept matches an existing node is decided by the AI against the *local* graph. If two devices extract different sessions while out of sync, the same concept can end up as two nodes. This is accepted for v1. A merge pass may come later.

### Login (VPS) — built in Phase 1

- Browser mode had no authentication (`desktopAPIAuthorized` returns `true` when it isn't the desktop server). Server mode (`LH_SERVER_MODE=1`, set by the Docker image) puts a login gate in front of **every page and API**; only `/login`, `/setup` and static build files are open.
- **First start:** the server prints a one-time **setup code** to its log (`docker compose logs lh`). `/setup` takes the code and a new password. It works once.
- **Password:** at least **8 characters**, stored only as a scrypt hash.
- **Logins** last a **fixed 30 days from sign-in** and aren't extended by use. The cookie is `__Host-lh_session` (HttpOnly, Secure, SameSite=Lax); only a SHA-256 of its token is stored.
- **Wrong attempts:** after 5 from one address, logins from it pause for **15 min**. Each repeated pause doubles, up to **24 h**. A success, or a day without failures, resets it. Signed-in devices keep working.
- **Writes** (any non-GET request) must carry an `Origin` that matches the `Host`, so other sites can't submit forms or requests on your behalf (CSRF).
- **Settings → Account** (shown only in server mode):
  - Change password: needs the current one, and **signs out every other device**.
  - The signed-in devices list.
  - **Sign out**: this device only.
  - **Sign out everywhere**, this device included.
- **Forgot password:** `docker compose exec lh reset-password` removes the password and every login and prints a new setup code. Data isn't touched.
- **Storage:** `server-login.json` beside `auth.json`, mode 0600. It's never synced, and the agents' file tools refuse it. A damaged file closes the site (503) instead of opening it.
- **Later (Phase 6):** desktop sync will use per-device tokens that can be revoked.

**Code:**
- `src/core/server-auth.ts` (rules)
- `src/store/server-auth.ts` (file)
- `src/server/server-auth.ts` and `server-auth-pages.ts` (gate, routes, pages)
- `proxy.ts` (calls the gate; the matcher now covers pages, which pass straight through outside server mode)
- `instrumentation.ts` (prints the setup code)
- `app/{login,setup}/route.ts`, `app/api/server-auth/*`
- `components/settings/account-section.tsx`
- `scripts/server-reset-password.mjs`

**Tests:** `tests/server-auth.test.ts`.

### Model sign-in on the VPS — built in Phase 2

Both controls appear **only on the cloud server**. The page knows it's on the server from a plain `lh_server=1` marker cookie that the server's proxy sets (`components/settings/server-mode.ts`); it carries no secret, and the desktop never sends an extra request to check. The desktop app's Settings are unchanged.

- **ChatGPT.** The callback listens on `127.0.0.1:<random port>` on the server (`electron/chatgpt.cjs`), so a phone's browser can't reach it.
  - While a sign-in is pending, the connect dialog shows **"Paste the address you landed on"** with a 3-minute countdown (`components/settings/chatgpt-paste.tsx`).
  - The server forwards the pasted address to its own listener (`src/server/chatgpt-paste.ts`, the `callback` op in `web-subscription-http.ts`). It accepts only `http://127.0.0.1:<port>/auth/callback` with a state and a code, and only for **the pending attempt's own port** (`pendingCallbackOrigin()` in `chatgpt.cjs`). The listener still checks the state and code itself.
- **Claude (Claude Code CLI).** The Claude Code block in Settings → Providers gets **Sign in to Claude** (`components/settings/claude-server-sign-in.tsx`, `src/server/claude-login.ts`, `claude-login-http.ts`).
  - LearnHarness runs `claude auth login --claudeai` over plain pipes, with no terminal emulation, and reads the link the CLI prints.
  - The link opens through a **one-use** redirect (`/api/claude-code/login/open`); the page never receives it. The learner pastes the code from Claude's page, LearnHarness writes it to the CLI, and the attempt ends on `Login successful.`
  - Limits: a **10-minute** time limit and one attempt at a time. A rejected code ends the attempt with a message.
  - Status comes from `claude auth status --json`. **Disconnect** runs `claude auth logout`.
  - **The CLI owns the login**; LearnHarness never stores a Claude code or token.
  - Routes answer 404 outside server mode.
- **Claude Code in the image.** `HOME=/data/home` is on the persistent volume. On first start the entrypoint (`deploy/docker-entrypoint.sh`) installs Claude Code there in the background with the official installer. It then updates itself, and the entrypoint and the nightly `update.sh` also run `claude update`. Its login (`/data/home/.claude`) is refused by the agents' file tools (the `.claude` entry under the home folder in `fs-shared.ts`).
- Subscription credentials are never copied between devices; each machine signs in on its own.
- **Tests:** `tests/server-sign-in.test.ts`. It includes an offline ChatGPT sign-in completed through the paste step, and `claude auth login` driven against a stand-in CLI that prints what the real one printed on a VPS.

### Obsidian vault on the VPS — built in Phase 4

**What it does**

- The official headless client `obsidian-headless` (`ob`) runs **inside the LearnHarness container** as one more Obsidian Sync device, named **"LearnHarness server"** (owner's choices). The notes drawer on the phone then shows the same notes as Obsidian.
  - Notes are stored decrypted on the server's disk, the same as on any other synced device.
- **Set up in Settings → Obsidian** (owner's choice over SSH). The section shows only on the server, just above Account.
  1. Sign in: Obsidian email, password, and a two-step code if the account uses one.
  2. Choose the vault and give its encryption password (empty for a standard vault).
  3. A status line: Starting… / Downloading your notes… / Up to date (with "Last synced …") / Syncing… / Can't reach Obsidian. Trying again. / the stopped states under "Keeping sync safe".
  - SSH still works as a backup: `docker compose exec lh ob …` uses the same files, and the page reads its state from `ob` itself.
- **One vault, at `/data/vault`** (`LH_VAULT_DIR`), in the existing data volume (owner's choice).
  - Connecting points the notes drawer at it. Nobody types a folder path on the server: the drawer shows "Connect your Obsidian vault" with **Open Settings**, its gear opens Settings → Obsidian, and `POST /api/notes {action:"vault"}` answers 403.
  - While sync is stopped, the drawer shows "Not syncing with Obsidian right now. What you write here is kept and syncs when it's back." The notes still open and save. An offline spell shorter than a minute isn't shown.
- **Conflicts: `merge`** (owner's choice; `ob`'s default).
- **None of `.obsidian` syncs** (owner's choice; `ob` syncs no settings unless `--configs` names some). So the server can't read Obsidian's attachment setting, and pictures pasted on the phone go to `LearnHarness/attachments`, the drawer's existing fallback. **The server never writes outside `LearnHarness/`.**
- File kinds synced are `ob`'s defaults: notes, canvases, bases, images, audio, video and PDFs.

**Leaving folders out (owner's choice: fully automatic, no list to paste)**

- Obsidian Sync can only exclude folders, so every top-level folder except `LearnHarness/` goes on `ob`'s excluded-folders list.
- Why not a list up front: the server can't list the vault before syncing (`ob` starts downloading while the file list is still arriving), and the desktop app gets no new code until the final merge.
- So the manager leaves a folder out **the moment it first shows up**:
  - on `ob`'s `Downloaded <name>` line for a new top-level folder (a folder's record arrives before its files, so usually none of them is downloaded);
  - on a `Downloading <folder>/…` line;
  - on a scan of the vault's top level every 10 seconds.
  - It stops `ob`, adds the folder with `ob sync-config --excluded-folders`, and starts `ob` again.
- A folder name with a comma, or with spaces at either end, can't go through that option (`ob` splits the value on commas and trims each entry). For such a list LearnHarness writes `ignoreFolders` into `ob`'s settings file for the vault, the field the command sets.
- Kept: `LearnHarness/` (the exact name) and dot-folders (`ob` never syncs those).
- **Strays:** a file or two can arrive before its folder is left out. They stay on the server, unused. `ob` never uploads, changes or deletes anything in an excluded folder, so they can't affect Obsidian.
- **Loose files at the top of the vault always sync**; Obsidian Sync can't exclude single files. The owner's pasted pictures live there, which is why pictures in notes show on the phone.
- **Later (Phases 5–6):** the desktop can send the folder names ahead of time, so even the strays stop.

**Passwords**

- The Obsidian password, the two-step code and the vault's encryption password are sent once over HTTPS and written to `ob`'s input. They are never a command-line argument, never stored and never logged by LearnHarness. The page clears the fields when the server answers.
- `ob` keeps a sign-in token and the vault's derived key in its own folder (`/data/home/.config/obsidian-headless`, readable only by its owner). The agents' file tools refuse that folder (`fs-shared.ts`).
- Routes: `GET /api/obsidian` (the view) and `POST /api/obsidian` with `op` = `sign-in`, `sign-out`, `vaults`, `connect`, `disconnect` or `retry`. They answer 404 outside server mode, sit behind the login gate, need the app's own header, and run one operation at a time.
- **Known limit:** `ob` reads a prompt's answer from its input and drops trailing whitespace, so a password that ends in a space can't be given this way (use SSH for that).

**Keeping sync safe**

- **Deleting in the notes drawer is fine**: it is a deliberate deletion, and it syncs to Obsidian like one made on any other device (Obsidian keeps it under Settings → Sync → Deleted files). The delete route tells the manager (`notesChangedHere`), which updates the safety check's note count at once, also while `ob` isn't running. Without that, clearing out more than half the notes during a sync stop would pause sync at the next start.
- **Rule: never delete files in the server's `LearnHarness/` folder by hand** (over SSH, outside the app), with sync running or not. `ob` treats a missing file as a deletion and removes it from Obsidian on every device, also when it next starts. To remove something that leaked into another folder, leave it out instead; that is automatic.
- **Safety check before every start of `ob`** (owner's choice). LearnHarness keeps the number of notes under `LearnHarness/` in `<data>/obsidian-sync.json` and updates it while `ob` runs. If the folder is missing, empty, or has lost more than half its notes, sync stays **paused** and Settings says why. The fix is Disconnect, then connect again. It can't undo a delete made while sync is running.
  - The same check works when LearnHarness's own record is lost: with no count to compare, an empty notes folder pauses sync whenever `ob` still remembers a sync of the vault (its `state.db` exists). If the notes are there, the record is rebuilt from them.
- **A fresh connect starts clean on both sides.** Before `ob sync-setup`, LearnHarness removes what `ob` still holds for that vault id or that folder (settings it can't read count too) and empties the folder. A new setup on top of an old sync memory would make `ob` find every remembered note missing and delete them all from Obsidian.
- **No answer means no action.** If `ob` gives no usable answer about its setup (`sync-list-local` or `sync-status` fails), the manager keeps what it knew, and Connect and Disconnect refuse with "Obsidian's sync program didn't answer. Try again." Nothing is removed on a guess.
- **Disconnect removes the server's copy** (owner's choice), in this order: stop `ob`, `ob sync-unlink`, check that `ob` no longer lists the folder, and only then empty the vault folder; then `ob logout`. If something changed after the last full sync, it warns first and needs "Disconnect anyway". Obsidian's copy is never touched.
- **Stopping `ob`** is a SIGTERM: it finishes the file it is writing (it doesn't write atomically). It's killed only if it hasn't stopped after 10 seconds. When the server process is told to stop, the signal is passed on to `ob`.
- **Restarts:** after an unexpected stop, 5 seconds, doubling, at most 5 minutes; after 5 in a row the page says "Sync keeps stopping. The reason is in the server log." with **Try again**. `ob` holds a lock in the vault for 5 seconds after a hard kill; a start refused for that is waited out, not counted.
- **Stops that don't restart:** the sign-in is refused ("Sync stopped" with **Sign in again**, which keeps the vault and the notes), the subscription ended (**Try again**), or the vault no longer exists (Disconnect).
- After a server restart, sync starts again by itself (`instrumentation.ts`).

**Installing `ob`**

- Its licence doesn't allow shipping it inside the public image. Like Claude Code, it is installed onto the volume at container start (`deploy/docker-entrypoint.sh`): `npm install -g --prefix ~/.local obsidian-headless@<version>`, up to 5 tries.
- **The version is pinned** (0.0.14), because the manager reads what `ob` prints. `OB_VERSION` appears in the entrypoint and in `src/core/obsidian-sync.ts`; a test keeps them equal. Until that exact version is installed, Settings shows "still installing".
- Its one native add-on (`better-sqlite3`) has a prebuilt binary for the image's Node 26, so the image needs no compiler. npm 11 runs its install script only when allowed, hence `--allow-scripts=better-sqlite3`.
- The image workflow checks, in the built image, that `ob` installs itself and that the add-on loads.

**Facts about `ob` 0.0.14 that the code relies on** (read from its source and confirmed by running it)

- With piped input, a prompt isn't printed and its answer is everything up to the end of the input. So each command gets at most one answer that way: `--email` is an argument and the password is the input.
- When the account needs a two-step code that wasn't given, `ob login` exits 0 and prints nothing. Success prints `Logged in as <name> (<email>)`.
- `ob sync-setup` needs no password for a standard vault and prints `Password not provided.` for an end-to-end one. A wrong one prints `Failed to validate password.`
- While syncing it prints `Downloading <path>`, `Downloaded <path>`, `Accepted <path>`, `Uploading file <path>`, `Fully synced` (at least every 30 seconds while idle and connected), and errors as `Error: <message>`: `Failed to authenticate: …`, `Your subscription to Obsidian Sync has expired`, `The connected remote vault no longer exists.`
- Its settings and state are in `~/.config/obsidian-headless` (`auth_token`, `sync/<vault id>/config.json`, `state.db`, `sync.log`).

**Code**

- `src/core/obsidian-sync.ts`: the rules and the approved wording (reading `ob`'s output, which folder to leave out, the safety check, restart delays, input checks).
- `src/store/obsidian-sync.ts`: the record file, counting notes, emptying the vault folder, `ob`'s folder.
- `src/server/obsidian-sync.ts`: the manager that runs `ob`; `obsidian-sync-http.ts`: the routes; `app/api/obsidian/route.ts`.
- `components/settings/obsidian-section.tsx`; wiring in `settings-dialog.tsx`.
- `components/notes/notes-drawer.tsx` (connect prompt, banner, gear), `src/server/notes.ts` (`status.sync`, the 403), `src/store/notes.ts` (`clearVault`).
- `src/agent/tools/fs-shared.ts` (`.config/obsidian-headless`), `Dockerfile` (`LH_VAULT_DIR`), `deploy/docker-entrypoint.sh`, `instrumentation.ts`.

**Tests**

- `tests/obsidian-sync.test.ts`: the rules, the files, the routes, and the manager driving **the real `ob` program** end to end: sign-in (wrong password, two-step code), vault setup, the first download, folders left out (a comma in the name too), a change from another device, an upload, a crash and a crash loop, the lock after a hard kill, an expired sign-in, an ended subscription, a missing vault, the safety check, Disconnect, and the three ways a wrong deletion could start (stale sync memory, a lost record, `ob` not answering).
  - Obsidian's servers are played by `tests/fixtures/obsidian-fake/preload.cjs`, loaded into `ob` with `node --require`. It replaces `fetch` (the account and vault API) and `WebSocket` (the sync service, with `ob`'s encryption version 0); everything else is `ob`'s own code.
  - These tests need the program: `LH_TEST_OB_CLI=<path>/obsidian-headless/cli.js`. Without it they are skipped. The image workflow fetches the pinned version for them.
- `tests/obsidian-sync-ui.test.tsx`: every state of Settings → Obsidian and the drawer's server-only changes, with the approved wording; the desktop's drawer is unchanged.

**Verified on the owner's server** against Obsidian's real servers (they are blocked from the development sandbox): `ob` installed itself after the update, the owner signed in and connected the vault in Settings → Obsidian, and reported that it works.

### Phone layouts — built in Phase 3

**When it applies**

- Screens narrower than **640 px, in a browser only**. The desktop app never shows the phone layout (its window can't go below 640 px, and the rules also exclude the Electron shell, so UI zoom can't trigger it).
- **Tablet layout: not built; decide later.** Tablets get the desktop layout.
  - **A tablet is still a touch screen** (owner's ask, iPad in landscape: a drag pulled the whole page down to refresh, as it once did on the phone). On every touch screen in a browser, at any width, the page itself never moves under a finger:
    - `app/touch.css` turns the page's bounce off (`overscroll-behavior-y: none` on the root, inside `@media (any-pointer: coarse)`, never in the desktop app);
    - the window lock (`components/phone/window-lock.ts`) no longer asks for the phone layout, only for a browser: a one-finger vertical drag that starts where nothing can scroll that way (the top bar, the message box, a panel at its end) is stopped. Panels scroll by themselves as before; sideways drags and pinches are left alone.
    - **Three more of the phone's touch helpers apply there too** (owner's choice of the three offered):
      - **a drag on the dock scrolls the lesson** (an open question, the message box): `use-dock-touch-scroll.ts` now asks for a touch screen (`useIsTouchScreen`: the phone layout, or a browser where `any-pointer: coarse` holds), not for the phone layout. The dock is the transcript's sibling at every width;
      - **press and hold opens a row's menu** (sessions, notes, folders), and holding then moving drags a notes row: `long-press.ts` asks for a browser, and the notes list listens for the hold-drag at every width, beside its mouse drag. `app/touch.css` makes those rows unselectable;
      - **hover-only buttons always show** (copy, expand diagram, "move this section"): `app/touch.css`.
    - **Still as on a computer:** the layout, Enter sends, hover tooltips, the keyboard handling, and everything in the desktop app (also on a PC with a touch screen).
    - **The Drawing Pad and a pen:** the pad draws from pen pointer events and ignores fingers; the lock only cancels a finger's page scroll. Tried in the iPad set-up with pen-type events: a stroke draws, the pen's eraser pass removes it, a finger drag draws nothing and no longer moves the page, and the Tutor's bubble stays reachable. A real Apple Pencil also sends touch events of its own; the owner's iPad is the proof.
    - Checked in a Chromium set up as a landscape iPad with real touch events, beside a normal computer (unchanged: no bounce rule, copy button hidden until hover, rows selectable). Chromium has no pull-to-refresh; the owner's iPad is the proof. Tests: `tests/touch-tablet.test.ts`, `tests/phone-hold-drag.test.ts`.
  - **Palm rejection on the Drawing Pad** (owner's ask, iPad in a browser: a palm resting on the pad while drawing turned into one big selection box over the pad, with no Copy bar, and the Pencil could neither draw through it nor tap it away). The pad draws from the Pencil's pointer events and ignores fingers, but it didn't stop them, so Safari took a resting palm for a finger held down. Only the canvas was marked unselectable, with the unprefixed `user-select`.
    - **Three parts, in the fork's own files** (owner's choice; upstream's Drawing Pad is unchanged):
      1. `app/touch.css`: the pad (`.drawing-pad-root`) and the frame around it can't be selected (`-webkit-user-select` too), and iOS's press-and-hold menu is off there;
      2. `components/phone/pad-palm.ts`: a finger or palm touch that lands on the pad's drawing area (`.drawing-pad-viewport`, not its toolbar) is cancelled from the moment it lands until it lifts. The Pencil is never cancelled (iPadOS's `touchType` "stylus"), and a touch that carries a palm and the Pencil together is left alone. The pad's buttons and its ✕ still take a finger tap;
      3. the same listener clears a selection of page text at any touch on the drawing area, finger or Pencil (also a pen that sends no touch events), so a stuck one goes at the next touch. Not while the cursor is in a text box (the Tutor's typing box).
    - Nothing is lost: fingers already did nothing on the drawing area, the Hand tool included. In a browser on a touch screen only; the phone never shows the pad; the desktop app is untouched.
    - **Upstream's class names** (`drawing-pad-root`, `drawing-pad-viewport`, `drawing-pad-tools`) are what this finds the pad by; `tests/pad-palm.test.ts` fails if upstream renames them.
    - Checked in a Chromium set up as an iPad with real touch events: the pad's computed `user-select` is `none`; a held touch on the drawing area was cancelled and cleared a selection made beforehand; finger taps on Eraser and Pen weren't cancelled and switched the tool; a pen-type stroke (CDP `Input.dispatchMouseEvent` with `pointerType: "pen"`) drew. Chromium has no iOS press-and-hold selection and doesn't label touches as finger or Pencil, so the owner's iPad is the proof.
  - **Apple Pencil taps click the first time** (owner's ask, iPad: Pencil taps often needed several tries; finger taps were fine). The page lock and the dock helper decide a drag on its first movement and then cancel the touch's movement, and on an iPad that also cancels the tap's click.
    - **Found with a test page on the owner's iPad** (an Artifact page with five benches that counted taps without a click): a Pencil tap always moved a little while touching (1.4 to 9.6 px, about 4 px typically), a finger tap was reported with no movement at all. A plain button clicked on every Pencil tap; with the page lock's rule, every Pencil tap the lock cancelled missed (5 of 10, then 2 of 12), and none it left alone did. The app's tooltips made no difference. Run in the Claude app's built-in browser (Safari's engine), not Safari itself.
    - **Owner's choice (option B of two): a Pencil dead zone.** A Pencil touch counts as a drag only once it has moved 12 px (`PENCIL_SLOP` in `components/phone/use-dock-touch-scroll.ts`), then it is decided as before. On the test page that bench clicked on all 27 Pencil taps. The other option was replaying a lost Pencil tap as a click.
    - **The accepted cost:** under those 12 px Safari may start its own scrolling, so a Pencil drag that starts where nothing can scroll (the top bar) may move the page a little before the lock can stop it.
    - Fingers are unchanged (they decide on the first pixel, as the iPhone needs), and so is every browser that doesn't label its touches: iPadOS gives each touch a `touchType` of "stylus" or "direct" (`isPencilTouch`). The Drawing Pad reads the Pencil from pointer events and is unaffected.
    - Tests: `tests/touch-tablet.test.ts` (a Pencil tap's wobble on the top bar isn't stopped, a Pencil drag past 12 px is), `tests/phone-layout.test.ts` (the rule).
  - **The home-screen app on a tablet: the top edges sit below iOS's blur** (owner's ask, iPad home-screen app: the top bar was blurred, the iPhone's problem in "Full height" below). The iPhone fix (`--lh-safe-top` in `app/phone.css`) is for the phone layout only, so on a tablet the top bar still started under the clock.
    - **Owner's choice, the iPhone's rule:** the top bar's buttons and title start where the blur ends. The other option shown was the bar's own top edge there, 12 points lower.
    - **Measured on the owner's screenshot** (13-inch iPad, 24-point clock strip): the sidebar's divider line is invisible to 33 points, smeared to 63 and fully sharp from 68 to 69. The top bar's buttons sit 11.5 points into the bar, so the top edges move down by the clock strip plus 32 points: the buttons start at 67.5.
    - **The 32 points only where there is a clock strip:** `min(32px, env(safe-area-inset-top) * 100)`, so an iPhone held sideways (the computer layout, no clock strip) and an iPad window away from the top of the screen get nothing extra.
    - **What moves** (`app/tablet.css`, `--lh-tablet-top`): the top bar (lessons, practice, plugin pages), the session list's header (its column and divider still run to the top), the notes drawer, the home and new-session corner buttons and the graph's toolbar (12 points below the inset, so they start where the top bar's buttons do), and the Tutor ("Minimized" and "Moving and resizing" in `docs/side-tutor.md`). Each bar's own background still runs up under the clock.
    - **Where:** every rule sits inside `@media (any-pointer: coarse) and (min-width: 640px)` and under `html:not(.lh-electron) body[data-lh-standalone]`. The marker is now set in a browser's home-screen app at any width, not only in the phone layout (`standaloneMarker` in `components/phone/phone-viewport.tsx`), in a layout effect so it is there before the Tutor places its window. A Safari tab, the phone layout, computers and the desktop app are unchanged.
    - Checked in a Chromium set up as the owner's iPad (1366 × 1024, touch, `navigator.standalone`, a 24-point clock strip through CDP `Emulation.setSafeAreaInsetsOverride`): every top edge's first control starts at 67.5 to 68 points, the Tutor's window opens at 128 (12 under the 116-point top bar); as a Safari tab and as a computer, nothing moved. iOS's blur itself can't be shown in Chromium; the owner's iPad is the proof. Tests: `tests/tablet-top.test.ts`, the Tutor's in `tests/side-tutor-ui.test.tsx`.

**Screens**

- **Session list:** a drawer that slides in from the left over the lesson, with the rest dimmed. It covers 85% of the width, at most 20rem.
  - A phone always starts with it closed. It closes on picking a session, a tap on the dimmed area, or ✕.
  - It doesn't read or write the desktop's remembered open/closed setting.
  - Its divider line sits on the drawer itself, so it runs the full height through the safe-area and bleed padding (owner's ask).
  - **Full height (owner's ask after the real-phone check):** the drawer's colour and the dim should run from the very top of the screen to the very bottom, with the controls still below the clock.
    - **Home-screen app:** the status bar is `black-translucent`, so the app draws under the clock and both colours run edge to edge. Every top edge pads by `env(safe-area-inset-top)`, so no control sits under the clock.
      - **The height quirk** (owner's iPhone): the page starts behind the clock, but the iPhone reports a height that leaves the clock strip out (894 of 956 points), so the app, the drawer and the dim stopped 62 points above the bottom. When the shortfall matches `env(safe-area-inset-top)` exactly, `--lh-vvh` adds it back (`standaloneGap` in `phone-viewport.tsx`), only while the keyboard is down (with it up the iPhone reports the visible height correctly, and adding the strip put the app's bottom and the model menu 62 points under the keyboard), and the drawer, its dim and the Settings and tutor-sheet backdrops take their height from `--lh-vvh` instead of `inset: 0`. The message box already pads by the home bar (`env(safe-area-inset-bottom)`).
      - **The top blur** (owner's iPhone): since iOS 26 the iPhone draws a "Liquid Glass" blur (scroll edge effect) over the top of a home-screen web app that runs under the clock, reaching about 40 points below it, which softened the top bar. It's undocumented and no setting turns it off. A solid, pinned, full-width strip behind the clock (which some developers report stops it) didn't help on the owner's iPhone and was removed. **Owner's choice: move the controls below it.** Every top edge pads by `--lh-safe-top` (`app/phone.css`): `env(safe-area-inset-top)` in a Safari tab, plus 26 px in the home-screen app (`body[data-lh-standalone]`, set by `phone-viewport.tsx`). Tuned from the owner's screenshot: the blur fades out between about 65 and 100 points from the top, and +26 puts the top bar's round buttons at about 100 (+40 left them at 114, visibly lower than needed). The other option offered was a black status bar (`black` instead of `black-translucent`; the icon must be re-added).
    - **Safari tab:** measured on the owner's iPhone (iOS 27), the page box is only the area between the clock strip and Safari's toolbar; at rest Safari fills both strips with one plain colour (the page background, or the colour of a full-width fixed layer at that edge). Content shows under the bars only once the page is scrolled, which is why another site's text appeared under the clock.
    - **Safari tab bleed (experiment, owner's choice):** in an iPhone Safari tab only, the body gets 200 px of padding above and below (`body[data-lh-bleed]`, `--lh-bleed`, `BLEED_PX`) and the window rests scrolled down by 200 px (`components/phone/phone-viewport.tsx`). The app sits exactly where it did; the session drawer and its dim are `position: absolute` page layers that span the whole padded page, so they are what shows under the clock and the toolbar. A window scroll snaps back to the resting point.
      - Off in the home-screen app (already edge to edge), in other iOS browsers, on Android and while the keyboard is up (a focused text box, a pan, or a visible area more than 120 px shorter than the layout), so the keyboard handling is unchanged.
      - A focused text box counts on its own: Safari starts scrolling the page to reveal the box before the keyboard's size arrives. With the bleed still on, that scroll was snapped back and the bleed then went off a moment later, a quick jump down and up (owner's iPhone). The viewport events are now followed synchronously, not on the next frame.
      - Fixed overlays (notes drawer, tutor sheet, Settings) are still clipped to the area between the bars.
      - Risk: Safari may shrink or grow its toolbar when the page scrolls. Checked in a phone-sized Chromium only.
- **Top bar:** one row at today's height. The title takes the free space (22 px text instead of 30) and truncates. Plan and Notes are icon-only, the extraction ring stays, and the phase word is hidden. The phase dividers in the lesson still show the phase.
- **Side tutor** (teaching and practice sessions since the upstream 0.6.0 merge, as on the desktop):
  - A round bubble in the bottom-right corner, just above the message box, in the app's floating-control look (card background, thin border, grey icon; the owner found the bright version out of place). It shows a spinner while an answer is being written. On a phone the tutor starts closed and isn't focused on open (that would pop up the keyboard).
  - The bubble opens a **bottom sheet** covering about three quarters of the screen, with the lesson dimmed above it. It closes on a tap on the dimmed lesson or the – button. No resizing.
    - **A swipe down on its handle or top bar minimizes it** (owner's ask, after the phone plugins round; shipped to both branches with the touch batch): the sheet follows the finger and the dim fades with it; let go past a quarter of its height, or with a quick flick, and it slides away, otherwise it springs back. The – button and the tap on the dim slide it away too. Opening is unchanged. Details and the readings for the owner to review: "On a phone: swipe down to minimize" in `docs/side-tutor.md`. Only the owner's iPhone can confirm the feel.
    - Only the lesson above the sheet is dimmed. Behind the sheet it is left as it is, so it shows through the sheet's see-through middle ("The window's look" in `docs/side-tutor.md`).
  - While an opened question leaves no room above the dock, the bubble moves to the top-right corner under the top bar.
- **Notes drawer:** slides in from the right and fills the screen.
  - **List, then note** (owner's choice from screenshots of two layouts): the topic list first; tapping a note shows it full screen, and "‹ Notes" goes back. It opens on the note last open in that session, if any. The list can't fold there; a divider line under the "Topics" heading replaces the fold arrow (owner's ask).
  - The two resize handles are hidden.
  - **Dragging: hold, then move** (owner's choice over a grip on each row; built after Phase 4, it replaced "dragging is off").
    - Press and hold opens the menu, as before. Keep the finger down and move: the menu closes and the row itself lifts and follows the finger.
    - What moves and where it lands is the same as on a computer: "Dragging" under "Notes drawer" in `docs/side-tutor.md`.
    - **The divider under "Topics" is the upper limit** (owner's ask). Pushing on against it puts the item above Inbox, outside every folder.
    - **History:** the first version had a floating label with the name, an empty box over the heading for "outside every folder", and a lit area under the list. The owner tried it on the iPhone: the drag started and followed the finger, but the boxes looked bad, and they asked for the row itself to move with the others parting.
  - **The message line** ("Moved …", "Deleted …", and refusals such as a name that's already taken in that folder) also shows at the bottom of the list screen. Its usual place is in the note half, which the list screen hides, so on a phone those messages were never seen. Found in the browser run of the drag and added without being asked, for the owner to review.
  - A phone always opens the drawer closed and doesn't remember it, so the desktop's saved state is untouched.
- **Questions:** an opened question may grow to the full screen below the top bar, as on the desktop. Scrolling up folds it into the slim bar.
- **Footer row** (context and cost, model, thinking level): all stay, on one row; the model name is kept to one line. The idle Dictate button is icon-only.
  - **While dictating** (owner's ask): a small live waveform (3.5rem, the desktop's meter) replaces the red dot, and the red Stop button is icon-only, so the row still fits.
- **Home:** the knowledge graph. The toolbar is fitted: search becomes an icon that opens a full-width field, and the other buttons are icon-only. The graph already supports touch drag and pinch (d3-zoom).
- **Settings:** the desktop's floating panel, centred (90% wide, at most 85% of the visible height); the owner preferred it to a full-screen page. Inside: the section list first, then the section with a back arrow. It opens with the desktop's fade-and-grow and fades back out on close (150ms; closing waits for the fade). The Keyboard section is hidden on phones; nothing else is removed. (Since the upstream 0.6.0 merge the plugin rows were left out too; with the phone plugins round Core plugins and the phone-ready plugins' pages are back: "Plugins on a phone" below.)
  - On the server the Account row shows from the first frame (the `lh_server` cookie), so it doesn't pop into the list when the device list arrives; the section shows "Loading…" until then.
- **Plan and diagram viewers:** one-finger drag, two-finger pinch to zoom (new), and the − / + buttons.

**Touch and typing**

- **Enter:** on a touch phone, Enter makes a new line and the button sends (`components/phone/enter-key.ts`; a touch phone is the phone layout plus `pointer: coarse`). This covers the lesson, home and new-session message boxes, the side tutor, practice answers, written answers and "thinking while reading" (a check waiting closed opens with its Open button). Keyboard hints are hidden on touch screens. Desktop is unchanged.
  - In practice, the empty box's hint reads **"Ask anything, or tap Next problem."** on a touch phone (owner's wording); the desktop keeps "…or press Enter for the next one."
- **Row menus:** press and hold (about half a second) a session, note or folder to open the menu that right-click opens on the desktop. Row text isn't selectable on phones.
  - Rows opt in with `data-phone-press`; one document listener (`components/phone/long-press.ts`) turns a held touch into a `contextmenu` event, so each row's existing handler runs. Lifting the finger after a hold cancels the follow-up tap (`touchend` preventDefault), so the row doesn't also open and menus that close on an outside press stay open. Android's own long-press menu event is de-duplicated.
  - **Hold, then move** (the notes drawer's rows): rows that also carry `data-phone-drag` can be dragged with the same touch. Once the hold has opened the menu, moving the finger past the hold slop sends `HOLD_DRAG_EVENT` on the document (start, move, end or cancel, with the finger's position and the row). From the moment the hold fires, `touchmove` is prevented, so the page can't start a scroll of its own under the drag (an iPhone's scroll can't be stopped once it has started). A second finger or a new touch cancels the drag.
    - `components/notes/notes-tree.tsx` passes these on to the list's own drag (`row-drag.ts` for the rules, `row-drag-dom.ts` for the movement), the same one the mouse drives on a computer.
- **Dragging on the dock scrolls the lesson** (owner's ask after the real-phone check: only a thin strip above an opened question could be dragged). The dock is a sibling of the transcript, so a finger drag on it never reached the transcript; `components/phone/use-dock-touch-scroll.ts` forwards it, the touch twin of the desktop's wheel forwarding (`forwardDockWheel`): a real scroll box under the finger keeps native scrolling while it can still move that way, otherwise the drag (with a short fling) moves the transcript, which folds an opened question as scrolling does. Sideways drags and drags in text boxes are left alone.
  - **Decided on the first movement** (`dragDecision`). iPhone Safari starts its own scrolling on the first touchmove that isn't prevented. Waiting for 8 px of travel let Safari scroll the page (which has room in a Safari tab) while the lesson was also moved and the page snapped back, so scrolling from a question jumped and rubber-banded, more on quick flicks (owner's iPhone). Once Safari's own scrolling has started, the events aren't cancelable and are left to it.
  - **The throw after release** (`releaseVelocity`, `flingStep`): its speed comes from the finger's last 80 ms, capped, and nothing if the finger stopped before lifting. It used to come from the last move alone; as a finger lifts, an iPhone can report a tiny twitch backwards a millisecond later, which read as a fast throw the other way, sent the lesson back to the bottom and re-opened the question once (owner's iPhone). The throw is time-based, so it travels as far at 120 fps as at 60.
  - **A touch stops the slide to the bottom** (owner's find): a quick swipe sometimes pulled the lesson back into the question, and only while the text above was still moving. When a question opens or the learner reaches the bottom, the transcript slides down (`use-stick-to-bottom`'s `scrollToBottom`); while that slide runs it pulls the scroll down every frame, and `chat.tsx` won't fold the question until it settles or is interrupted. A wheel interrupts it at once; a finger never did. Now every touch on the dock or the transcript stops the slide whenever one is under way: running (`stickState.animation`), or a reveal still waiting for its first frame (`expandIntentRef`, which is also cleared so the question can fold). Then `stopScroll`, the way a touch stops a moving list on an iPhone. Checking only `stickState.animation` still lost very quick swipes right after a question opened (owner's iPhone). Two earlier attempts called `stopScroll` on every upward move (then once per drag) and made scrolling jump up and down on the owner's iPhone; they were reverted.
  - **A tap while the lesson is moving still taps:** on an iPhone the first tap on something still scrolling only stops the scroll, and Safari swallows it. Tapping the folded question then stopped the text with a jolt and left it folded (owner's iPhone). A short tap on the dock that began while the lesson was moving (a throw, a slide, or a scroll in the last 100 ms) is replayed as a click on what was touched (`replayTap`); its own click is cancelled so it can't land twice. Taps on the lesson itself keep the iPhone's stop-the-scroll behaviour.
  - **A tap on the folded question ends at the bottom, open** (owner's iPhone: scrolling through a lesson and tapping the folded question, it opened very quickly and folded back down, with the lesson left far up). The wanted behaviour was already the rule: the tap takes the lesson to its bottom and the question ends open.
    - **What shipped first** (with the touch batch): the tap opened the question at once and slid the lesson down with `use-stick-to-bottom`'s spring. That library ends its slide at any upward scroll, and on an iPhone such scrolls come without a new touch (Safari's own momentum of a lesson still moving, or its late reports), so the question was let go and folded again. The fix held it open and slid again a frame after each such ending (`holdReveal`, up to 4 s), stopped the dock's own throw first, and let go for a new touch, a wheel, a mouse press on the lesson or a scrolling key. In Chromium the fold-back could only be reproduced with stand-ins for Safari's scroll reports (open at 116 ms, folded at 236 ms, 9,700 px from the bottom).
    - **The owner's verdict on the iPhone:** "when i click the question on the bottom while im scrolling, it pulls up the question, i see the content still scrolling up, then it jitters a bunch and finally pulls down. i wanted it to just smoothly pull all the way down the page and into the question." Safari's momentum kept going after the tap on the dock (a sibling of the scroller), and the slide and the slide-again loop fought it until it died.
    - **The test page** (an Artifact page with live benches, run on the owner's iPhone): three ways of meeting a tap while the lesson moves. The owner's choice, **B, "Stop, Safari's glide"**: stop the lesson's own momentum at the touch, then one smooth scroll by Safari itself. Their words: "b is how i wanted it. it should stop the glide and immediately pull me down. however i feel like id like it more if it pulled down into the question, like how you can already scroll down into the question smoothly. rather than how it opens the question and pulls down simultaneously."
    - **The design now built, touch screens only** (a computer, and the desktop app, keep exactly what they had: the click opens at once and `use-stick-to-bottom` slides):
      1. **The lesson's own motion stops at the touch on the dock** (`stopMomentum` in `use-dock-touch-scroll.ts`, at the dock's `touchstart` when the lesson scrolled in the last 100 ms by itself, not by the dock's throw or a library slide): its scrolling is hidden for one frame (`overflow-y: hidden`), its place kept, then put back as it was (the scroller's own inline `overflow: auto` included) at the place it is then, so a drag begun in that frame isn't undone. The dock's throw stops as before.
      2. **One glide to the bottom, the browser's own smooth scroll** (`glideToBottom`: `scrollTo({ top: bottom, behavior: "smooth" })` on the lesson's scroller; `"auto"`, a jump, with reduced motion). Not the library's spring, and no slide-again loop. A glide asked for while the stop's hidden frame is still to come starts right after it (the ordering a tap whose touchstart and touchend land in one frame needs): started on a box whose scrolling is hidden it would be cut off, and restoring at once could undo the stop before a frame showed it.
      3. **The question stays folded on the way and opens as the lesson arrives**, by the fold machine's own "reached the bottom again" (`arriveAtBottom` in `chat.tsx`, which the scroll listener and the glide's end both call; the end only matters when one of the fold machine's short mutes hid the arrival). It opens within 16 px of the bottom (`GLIDE_ARRIVED_PX`, the fold machine's `EXPAND_DIST`) and `use-stick-to-bottom` then slides the last pixels, so the lesson counts as at the bottom and a new reply is followed, as after scrolling down by hand.
      4. **Already at the bottom** (within `use-stick-to-bottom`'s 70 px "near the bottom"), the tap opens the question at once, as before.
      5. **The learner stops it:** a touch on the lesson or the dock, a wheel, a mouse press on the lesson or its scrollbar, or a scrolling key while the page or the lesson has the focus (`keyScrollsLesson`) ends the glide where it is, and nothing pulls the lesson back. A touch on the lesson, a mouse press and a wheel also halt the browser's smooth scroll there (`scrollTo` the current place, `behavior: "instant"`): a wheel over the lesson doesn't stop it by itself (found by a review, in headless Chrome: a wheel 150 or 300 ms into the glide and the lesson still ended at the bottom), and the wheel's own step still applies after the halt. A scrolling key cancels it in Chrome by itself; a wheel over the dock is forwarded to the lesson as a scroll (`forwardDockWheel`), which cancels it too.
      6. **Something else moves the lesson back up** (a scroll this hook can't see: iOS's tap on the status bar, VoiceOver's scrolling, the Tutor's "Show in the lesson" during a glide): once the glide has gone down at all, a lesson more than `GLIDE_PULLED_BACK_PX` (8 px) above the lowest point the glide took it to ends the glide as a learner's stop does, folded, with nothing pulling it back. A glide only goes down, and the lesson growing doesn't move it up. Motion up before the glide has gone down at all is Safari's momentum that the stop didn't catch: the glide waits it out (found by a review).
      7. **Ending short with nobody touching** (the lesson grew under it, the browser gave up): it glides once more, at most `GLIDE_RETRIES` (2) times, decided by `glideStep` once the lesson has been still for `GLIDE_QUIET_MS` (150 ms); never once per frame.
      8. **The net: the lesson still won't go down, with nobody touching** (the glide gave up: Safari refused the smooth scroll, or its momentum outlasted the stop and the tries): the question opens where the lesson is and `use-stick-to-bottom` slides it down, the way a computer opens it (`openAtOnce` in `chat.tsx`, from `onGlideEnd("gave-up")`), with a teach check revealed as its Open asked. So a tap is never lost. When the net is used it looks like the behaviour before the touch batch (open, then a slide), after about half a second with the question folded. A glide the learner stopped never uses it.
      9. `use-stick-to-bottom`'s own animation, if one runs, is stopped before the glide starts (`openDock` in `chat.tsx`). That one added `stopScroll` line also runs on a computer, where it has no effect: away from the bottom no slide of the library is under way.
      - The same glide serves the plugin question's bar and the Enter key or the reading-thinking field's own Open that open a waiting check (`openDock(true)`, as the question bar), and a folded practice problem and a plugin problem (`openDock(false)`).
    - **The teach check's "Open" away from the bottom (a reading for the owner's review):** the same glide, and the check opens on arrival. It counts as revealed only on arrival (`openOnArrivalRef` in `chat.tsx`), so the invitation stays on screen during the glide, and a glide the learner stops leaves it as it was: reaching the bottom later by hand doesn't open it, as for any check that hasn't been opened.
    - **Kept: a tap on an open question during a slide takes the reveal up again** (found by a review; the owner: "this change is fine"). An open question can still be under `use-stick-to-bottom`'s slide: one that opens at the bottom (a tap there, a new question arriving while the lesson is at its bottom), the last pixels after a glide's arrival, and the lesson following a reply. A touch on the dock then still stops the slide at once but keeps the question held until the touch is known: ends as a tap (it never moved, by `dragDecision`, and lasted at most `TAP_MS`), the reveal is taken up again (`onTouchSettled`); it moves, lasts longer or gets a second finger, it lets go and the question folds where the fold rule says. A touch on the lesson itself stops the slide, and that is that. A replayed tap (`replayTap`) clicks once, before the reveal is taken up again. The case the review found (a tap on the thinking box while the question was open and the lesson far up, sliding) no longer comes up from a tap on the bar, since the question now opens only at the bottom.
    - **Removed:** the hold-and-slide-again loop (`revealToBottom`, `holdReveal`, `revealOver`, `REVEAL_HOLD_MS`, `REVEAL_BOTTOM_PX`) and its tests; `suppressFoldDuringReveal` in `chat.tsx` is upstream's again (one slide, a 2-second hold). The mouse and key rule stays, now to stop a glide.
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
        - a tap at rest far up, once: the lesson grew by about 900 px under the glide (at 603 ms the distance went from 3,285 to 4,190 px), the first glide ended 1,112 px short, and one more glide arrived: open at 11 px after 2.25 s;
        - everything else as listed above: a tap after a throw, a touch on the lesson and a drag on the dock during the glide, 50 px from the bottom, the teach check's Open, reduced motion, and the computer's click and wheel.
    - **Only the owner's iPhone can show** whether one hidden frame stops Safari's momentum every time (the test page's numbers are the owner's), how long Safari's own smooth scroll takes from far up (Chromium's took 1.5 s for 9,400 px, the last 400 px about half a second of it) and whether that feels like "pulling down into the question", and the opening's look at the moment of arrival. Chromium stops its own fling at a new touch and has no iOS momentum, so the momentum cases ran against a scripted lesson in the tests only.
    - Built on `claude/upstream-0.6.0`, not shipped. Tests: `tests/dock-touch-reveal.test.tsx` (the real `use-stick-to-bottom` and the real hook with `chat.tsx`'s wiring, over a scripted lesson that plays the browser's smooth scroll, a wheel that doesn't cancel it, and Safari's momentum, also one that outlives the stop and ignores the smooth scroll), `tests/phone-layout.test.ts` (`glideStep`).
  - **No bounce at the lesson's ends** (found with a temporary on-screen scroll readout on the owner's iPhone, since removed): the occasional pull-back into the question was Safari's rubber-band spring. When the lesson overshot its bottom (the readout showed `d` below zero), a swipe that began during the bounce folded the question, but the spring kept running underneath, overrode the forwarded scroll and snapped the lesson back to the bottom about 150 ms later, which re-opened the question. On phones the transcript gets `overscroll-behavior-y: none` (set by `use-dock-touch-scroll.ts`), so it stops dead at its ends like the desktop's. Confirmed fixed on the owner's iPhone.
  - **120 fps:** iPhone Safari holds a page's own updates (this forwarding, the throw) near 60 fps by default; native scrolling isn't held. The owner turned off Settings → Apps → Safari → Advanced → Feature Flags → "Prefer Page Rendering Updates near 60fps", which fixed it on their phone. A site can't change that setting.
- **The page never moves under a finger** (the owner's phone pulled the whole page down, like pull-to-refresh). The root has `overscroll-behavior-y: none`, and `components/phone/window-lock.ts` stops (on its first movement, as above) a one-finger vertical drag that starts where nothing can scroll that way (the top bar, the drawer's header, a panel already at its end). Not `overscroll-behavior: contain` on panels: on a box that only scrolls sideways (a formula, a table) it also stopped drags there from reaching the lesson.
- **Menus** slide back inside the screen on a phone (`clampMenuToScreen` in `menu-shell.tsx`, phone only); the stats popover opens from the left edge.
  - **The model picker** (owner's iPhone: it opened behind the keyboard): on a touch phone a menu opens with focus on its body, not its search box, so the keyboard doesn't pop up; tapping the search opens it. A phone menu is placed within the visible height (`--lh-vvh`, re-placed when the iPhone keyboard resizes the visual viewport) and measured from the shifted body while the keyboard is up; an upward menu is pinned by its `top` (anchor top minus gap minus its own height, `phoneTopPlacement`) instead of `bottom`, because the fixed frame's bottom isn't reported reliably (the home-screen app's frame is taller than `innerHeight`, and the keyboard covers it without shrinking it), and it re-places when its content changes size (a search filtering the list). Desktop placement is unchanged.
- Text boxes use 16 px text on phones (smaller text makes iPhone Safari zoom in on focus).
- When the on-screen keyboard opens, the layout shrinks so the focused box stays visible.
- Controls that only appear on hover (copy, expand diagram, move section) are always visible on a phone; Tailwind's `hover:` never fires on touch screens. The notes list's row ⋯ buttons stay hidden, because rows use press and hold (owner decision). Hover tooltips don't show.
- Wide tables, formulas and code scroll sideways inside their own box. The page never scrolls sideways.
- The notch and the home bar (safe areas) are respected.

**Home-screen app (PWA)**

- Name and short name **LearnHarness**, the existing app icon, a dark background, `display: standalone`.
- The manifest and the icon files are served **without the login**, because phones fetch them without the session cookie. They contain only the name and the icon.
- No service worker and no offline mode.
- The login and setup pages link the manifest and the icon too; their security policy allows the same-site manifest and icon (`manifest-src 'self'; img-src 'self'`).
- Icons are rendered from `build/icon-flat.svg` by `scripts/make-pwa-icons.mjs` into `public/icons/`: the icon as drawn (192, 512), a maskable 512 for Android, and a 180 apple-touch-icon. The full-bleed versions use the icon's own background, #141414.
- **The site's name in a browser** (owner's ask): the page title is "LearnHarness", one word, as in the manifest and on the login pages. It read "Learning Harness" (upstream's title), which is what a tab, the history and the address bar's suggestions showed. The title is shared with the desktop app, whose window is already named LearnHarness.
- **Browser-tab icon** (owner's ask: Chrome showed its globe, because the site had only the home-screen icons): the same script writes `app/favicon.ico` (the logo at 16, 32 and 48 px). Next serves it at `/favicon.ico` and links it from every page; the login and setup pages link it themselves. It is open without the login, like the other icons.
- On an iPhone the status bar is `black-translucent`: the app draws under the clock and pads every top edge (see the session list above).

**How it's built**

- Phone styling lives in fork-owned files: `app/phone.css`, and since the phone plugins round `app/phone-flashcards.css` and `app/phone-rich-code-blocks.css` ("Plugins on a phone" below). Every rule sits inside `@media (max-width: 639.98px)` and under `html:not(.lh-electron)`. The rules are unlayered, so they beat Tailwind's layered utilities without `!important` (except against inline styles).
- The desktop app is marked `lh-electron` by an inline script in the root layout's `<head>`, before the first paint, so a zoomed-in desktop window at its minimum width can't flash phone styles (`<html suppressHydrationWarning>` for that one attribute).
- Upstream components get only small hooks: `data-phone="…"` attributes and short `useIsPhone()` conditionals. That keeps rebasing onto upstream cheap.
- **Code (`components/phone/`):**
  - `use-phone.ts`: the phone rule (`useIsPhone`, `useIsTouchPhone`, `isPhoneNow`), the same query as the CSS.
  - `phone-runtime.tsx`: mounted once in the root layout; installs press-and-hold and `phone-viewport.tsx`.
  - `phone-viewport.tsx`: keeps the app inside the part of the screen the iPhone keyboard leaves visible. iPhone Safari overlays the keyboard and pans the view up to the box being typed in; on the owner's phone that pushed the top bar off screen and left an empty band above the keyboard.
    - `--lh-vvh` is the visible height; every `h-dvh` shell, the body and the overlays size from it.
    - `--lh-vv-top` is Safari's pan (`visualViewport.offsetTop`). While it's non-zero the body carries `data-lh-keyboard` and moves down by that much, which also makes the body the frame for fixed overlays, so they move with it. A window scroll is undone (the app's pages never scroll the window).
    - **Closing the keyboard** (`layoutHeight`): iPhone Safari reports the new visible height only after the keyboard has slid away, so the app sat squeezed above an empty band for a moment and then dropped down (owner's iPhone). When a text box loses focus (and focus isn't moving to another one) the app takes the full height at once; the message box sits at the bottom behind the keyboard and is revealed as it slides away. The override ends when Safari's height arrives, or after 1.2 s.
    - **Gliding in step with the keyboard: tried and taken out** (owner's report, iPhone: "the keyboard has a very jerky animation when clicking on the text box for the tutor (and sometimes the thinking section of the question)").
      - **What was tried** (the owner's pick, "B · In step", from an animated picture of three): the app's height glided with the keyboard both ways, from the keyboard's height remembered from the last time it was up, with a short glide when the guess was off.
      - **The owner's verdict on the iPhone:** the question box jiggled up and down after the keyboard closed, and the jerkiness the owner had asked about was still there. The owner asked for it to be reverted completely.
      - **Reverted:** `phone-viewport.tsx`, `menu-shell.tsx` and `use-dock-anchor.ts` are back to what they were before it, and its two test files are gone. The keyboard is handled as in "Closing the keyboard" above. A `lh:phone:keyboard` entry it left in a browser's storage is no longer read.
      - **Still open:** the jerkiness at the focus. An iPhone tells a page the keyboard's size only once it is up, so the app's height changes in one step then; the Tutor's sheet moves at both edges, which is why it shows most there. Any new attempt should be tried on the owner's iPhone before it ships (a test page first): a stand-in keyboard in Chromium couldn't show what the real one did.
      - **Kept from that round:** the Tutor's sheet blurs its typing box as its slide away starts ("On a phone: swipe down to minimize" in `docs/side-tutor.md`), so the keyboard goes with the sheet.
    - Nothing changes while the page is pinch-zoomed (`visualViewport.scale` above 1).
    - Android shrinks the layout itself (`interactive-widget=resizes-content` in the root layout's viewport).
    - Anything that positions a fixed element from `getBoundingClientRect()` measures relative to the body (`use-dock-anchor.ts` does).
  - `use-dock-anchor.ts`: the tutor bubble's position, measured from the top (an iPhone keyboard covers the bottom edge). The computer's minimized tutor uses it too (owner's ask, after Phase 4), so it also reports how far the lesson's right edge is from the window's; the phone ignores that.
  - `enter-key.ts`, `enter-hint.tsx`, `long-press.ts`, `use-pinch-zoom.ts`, `use-dock-touch-scroll.ts`, `window-lock.ts`.
- **Wiring:** `sidebar.tsx` (drawer state, backdrop, press-and-hold on rows), `top-bar.tsx`, `chat.tsx` (dock hook, practice hint, dock drag), `side-tutor.tsx`, `notes/notes-drawer.tsx`, `notes/notes-tree.tsx`, `settings/settings-dialog.tsx` (a link to a section opens on it; plain Settings opens on the list), `graph-view.tsx` (search icon), `stats-bar.tsx`, `menu-shell.tsx`, `session-overlay.tsx` and `plan-block.tsx` (pinch), and the Enter handlers in `composer.tsx`, `question-dock.tsx`, `practice-dock.tsx`, `reading-thinking.tsx`.
- **Tests:** `tests/phone-layout.test.ts` checks that every rule in `phone.css` (and in the two plugin stylesheets) is phone-only and browser-only, and covers the Enter rule, the bubble position, the hold slop, edge scrolling and menu clamping. `tests/phone-hold-drag.test.ts` drives press and hold and hold-then-move with scripted pointer and touch events. `tests/notes-row-drag.test.ts` covers where a drag lands. `tests/server-auth.test.ts` pins the open manifest and icon paths.
- **Desktop check:** desktop screenshots (1280 and 700 wide) and a dump of every element's position and size, compared before and after. Nothing moved; the only pixel differences are the see-through footer pills, whose blur picks up whatever transcript text sits behind them.
- **Real-phone checks (owner, iPhone, iOS 27), two rounds.** Round 1: most of it worked; fixed after it were the keyboard pushing the app up, the session list's strips, Settings' Account row popping in and the missing dictation waveform, and Settings became the centred panel. Round 2 confirmed on the phone: Settings (centred panel, fades), the dictation waveform, the keyboard opening and closing, the session list's full-height colours (Safari tab and home-screen app), 120 fps scrolling, dragging on and out of an opened question (no jumping, no pull-back), tapping the folded question while the lesson moves, the home-screen app filling the screen to the bottom, and the model picker in a Safari tab. Every fix above was found on the owner's iPhone and is described in its own bullet.
- **Testing these without an iPhone:** Playwright `devices["iPhone 13"]` (iOS Safari user agent, so the Safari-tab bleed turns on); real touch through CDP `Input.dispatchTouchEvent`; the keyboard by replacing `window.visualViewport` with a fake whose `height` you set and fire `resize` on (an init script); the home-screen app by overriding `navigator.standalone` (Chromium has no clock strip, so `env(safe-area-inset-top)` is 0 there and `standaloneGap` stays 0). Chromium never shows iOS's rubber band, its top blur, its swallowed taps or its keyboard pan, so anything touching those needs the owner's phone; a temporary on-screen readout (`?scrolldebug=1`, since removed) was the way to see what the phone did.

**Not in this phase:** a tablet layout, the side tutor in practice sessions (added at the upstream 0.6.0 merge), offline use, and renaming notes in the drawer.

#### Plugins on a phone: Flashcards and Rich code blocks (built after the upstream 0.6.0 merge)

- **State:** built on `claude/upstream-0.6.0`, together with Flashcards sync ("Flashcards sync" under "Handoff"), and **shipped** to both branches; where it stands is "After the merge (read this first)" under "Handoff".
- **The plan** is `docs/phone-plugins-plan.md`: the owner's decisions (numbered 1–11 there) and the smaller rules, approved by the owner ("Approved, build it"). This part records what was built for each. Change a decision only with the owner's approval.
- It replaces the 0.6.0 merge's "under 640 px no plugin is offered" (decision 10 in `docs/upstream-0.6.0.md`) for these two plugins only.

**Which plugins, and the gate**

- **Phone-ready: Flashcards and Rich code blocks** (`PHONE_READY_PLUGINS` in `components/phone/phone-plugins.ts`). Everything else stays as at the merge (plan decision 11): the Drawing Pad hidden, a Coding questions question or problem parked, community plugins' ways in hidden.
- **The way in** (decision 2): only Flashcards' session-list entry shows (`PHONE_SIDEBAR_ENTRIES = ["flashcards/open-sidebar"]`; `app/phone.css` names the same entry, and a test keeps the two equal). Teaching, Practice and Flashcards stack in one column. The lesson's top-bar plugin buttons, the graph's plugin buttons and every other session-list entry stay hidden.
- **A plugin page opened on a phone:** a phone-ready plugin's page renders as on a computer; any other still reads "Open this on a computer." (`PhonePluginPage` now takes the `pluginId`).

**Settings on a phone** (decision 3)

- **The list**, after Account: **Core plugins**, then **Flashcards** and **Rich code blocks**, each only while its plugin is on. No Community plugins row, no other plugin's page, and no dividers above the plugin rows. A link to an unlisted plugin section lands on the list (`isPhoneHiddenSettingsSection`).
- **The Core plugins page** lists all four core plugins. The switches of Coding questions and Drawing Pad are greyed and can't be changed (`isPhoneLockedPlugin`; disabled, `data-phone="plugin-locked"`), with no explaining text.
- Their ⚙ is hidden; Flashcards' and Rich code blocks' ⚙ open their own pages.
- Finger-sized on these pages: the ⚙ is 40 px, and a switch keeps its look with a 40 × 40 touch area around it (`app/phone.css`).

**Flashcards' screens** (decisions 1, 4a–4d, 5a–5c, 6; the look is `app/phone-flashcards.css`, the touch behaviour `components/phone/flashcards-touch.ts`)

- **Everything** (decision 1), making cards from the graph and from a file included.
- **The review and practice:**
  - **Stacked ratings (4a):** four full-width buttons, Again to Easy, one under the other (48 px). Reveal answer and Next are full width too (44 px).
  - **Pinned to the bottom (4b):** while a card shows, the stage is the scroller: the card is as tall as its text, in the middle of the space above the buttons, and a longer card scrolls in that space while the buttons stay in view. The buttons keep clear of the home bar (`env(safe-area-inset-bottom)`).
  - Between two cards the pinned band stays where it is, with upstream's "Loading next card…" in it (`flashcards-touch.ts` marks that moment `data-phone-review="loading"`). The end states ("No cards due in this selection.", "Practice complete.", an error with Retry) keep upstream's layout.
  - In practice, "Practice mode does not change your review schedule." sits under the pinned buttons.
  - **Keyboard hints (4c)** are hidden; the keys still work with a keyboard connected.
  - **The way out (4d):** the same ✕ in the same place (its centre where it was), 44 × 44. The count stays under the card.
  - A formula wider than the card scrolls sideways inside the card.
- **The deck list (5a):** fits the screen (it was 640 px wide in a 368 px box), finger-sized rows, without the three number columns; names truncate. + and ⚙ are 40 × 40; Review keeps its size with a 40 px touch area around it.
- **Row menus (5b):** the ⚙ stays, and press and hold (about half a second, the fork's one hold in `long-press.ts`) on a row opens the same menu. Rows that have a ⚙ are marked `data-phone-press="flashcards"`, and the held finger is answered by pressing that row's own ⚙; the lift opens nothing else. No dragging; order stays "Move up / Move down" in the menu.
  - `long-press.ts` lets a click the page sends itself (`isTrusted === false`) through during a hold, so that press reaches the ⚙.
- **Renaming a deck (5c):** a small ✕ at the end of the rename box cancels and keeps the old name.
  - It is fork code that sends the box the plugin's own Esc, so the plugin's file isn't edited for it. Its press doesn't take the focus, because a blur saves. Enter still saves.
  - A press on it that ends any other way (the finger slid off, a scroll, a touch elsewhere, no click within 400 ms of the lift) gives the plugin its blur back, so the box saves as it would have.
- **Boxes and menus:** every button of the library page and of the plugin's boxes, the boxes' checkbox rows and their ✕, the rows' ⚙ menu items, and the ⚙ beside the page title get 40 px touch areas. In Settings → Flashcards the model and thinking pickers keep their pill with a 40 px touch area.
- **Statistics charts (6):** shown as they are.
- **The keyboard:** a focused box (the rename box, search, a card's Question and Answer, the fields of Settings → Flashcards) is scrolled into the visible part when it is focused, and again whenever the visible height changes while it has focus. The app is already as tall as the visible part (`--lh-vvh`); this moves the box inside it.
- **The knowledge picker** ("Pick nodes", the host's shared screen): 48 px rows, finger-sized checkboxes and controls, and its header uncut. It still covers the whole screen and closes with its ✕ or Done.
  - **Its Props and Created columns are hidden on a phone** (owner's answer after the plan was approved: "Hide both on a phone"), so the names get the full width. Sorting by name stays.
- **Checkboxes** in the deck list and the picker are drawn by the fork: a 20 px box inside a 40 × 40 control, in theme tokens, because a native checkbox can't have a larger touch area.

**Rich code blocks** (decisions 7 and 8; `app/phone-rich-code-blocks.css`, `components/phone/rich-drawing-frame.tsx`)

- **Shrink to fit (7):** a drawing wider than the lesson shrinks to the lesson's width; one that fits keeps its size. (Off a phone a wide TikZ drawing keeps its natural size and scrolls sideways in its box, as upstream draws it.)
- **The enlarge button**, on all three kinds (technical diagrams, molecules, scores): the lesson's own enlarge control, with upstream's label "Expand diagram", at the block's top right, once the picture is drawn. None while a block is drawn or after it failed.
  - It opens the lesson's existing diagram viewer (drag, pinch, − / +) with a copy of the picture (`drawingCopy`): its ids renamed, so the copy never shares one with the lesson's drawing, and wrapped in the plugin's `rich-code-blocks` class, so the theme's ink and the plugin's fonts still apply.
  - **The viewer opens the drawing fitted**, as it does the lesson's other diagrams (owner's answer after approval: "Fitted, as others do"). Nothing in the viewer changed for it.
  - The button keeps the lesson's 24 px look with a 40 × 40 touch area. The area extends to the left: the button sits at the lesson column's right edge, which clips what lies beyond it.
  - **Where:** the lesson, the Tutor's sheet and the notes Read view, with the button and the viewer in all three. Not inside a Flashcards card: plugin Markdown there is display-only (upstream's rule).
- **While a block is drawn (8):** a dashed box with a spinner and no words, in place of the source. A block that fails shows what it shows today (the plugin removes its block, and the host shows its error and the source), so no spinner is left behind. With reduced motion the spinner stands still.
- **From the first paint** (owner's answer after approval: "Spinner from the start"): while Rich code blocks is switched on but its front end hasn't started, a smiles, abc or tikz fence shows the same box instead of the host's code.
  - Before the page runs, the server's mark decides: `richCodeBlocksBoot()` (`src/server/rich-code-blocks-boot.ts`) reads the plugin host's list while the page is rendered, and `app/layout.tsx` sets `data-lh-rich-code-blocks="on"` on `<body>`. The code fallback of such a fence carries `data-lh-rich-fence` (`md-blocks.tsx`).
  - Once the page runs, the frame's marker says which state its fence is in (`richFenceState`: `plugin`, `waiting` or `code`).
  - A kind switched off in the plugin's own settings spins for the first moments, then turns into plain code once the plugin has started (only the plugin knows which kinds are on).
- **The frame never mounts a block twice.** On a phone it puts a marker of no height just before the block, which keeps its place; so the layout answer arriving after hydration, or a window resized across 640 px, doesn't draw the block again (a failed TikZ block would compile again, up to its 10-second limit). On a computer the frame renders the block alone.

**How it's built (additions to "How it's built" above)**

- **Two more fork-owned stylesheets** under the same law as `phone.css` (inside `@media (max-width: 639.98px)`, under `html:not(.lh-electron)`, unlayered), imported by `app/layout.tsx`: `app/phone-flashcards.css` and `app/phone-rich-code-blocks.css`.
  - They restyle upstream's markup: the plugins' own class names and the host components that render for them (the tree, the surface, the dialog, the menu, the knowledge picker). Every rule is more specific than the plugin's own; inline styles are beaten with `!important` only.
  - The guard against upstream renames is the tests below.
- **Helpers (`components/phone/`):**
  - `phone-plugins.ts`: the gate (`PHONE_READY_PLUGINS`, `PHONE_SIDEBAR_ENTRIES`, `isPhoneReadyPlugin`, `isPhoneHiddenSettingsSection`, `isPhoneLockedPlugin`); `phone-plugin-page.tsx`;
  - `flashcards-touch.ts`: press and hold, the rename ✕, the loading mark, the keyboard rule. Installed once by `phone-runtime.tsx`; off the phone layout it marks nothing and answers nothing;
  - `rich-drawing-frame.tsx`: `PhoneRichDrawingFrame`, `drawingCopy`, `richFenceState`;
  - `long-press.ts`: a click the page sends itself passes through during a hold.
- **On the server:** `src/server/rich-code-blocks-boot.ts` (exported from the server barrel).
- **Upstream files:** none for Flashcards' screens. For Rich code blocks: `md-blocks.tsx`, `session-overlay.tsx` (`openDrawing`, a `drawing` prop), `chat.tsx` (`openDrawing`), `app/layout.tsx`. For the gate and Settings: `settings-dialog.tsx`, `plugins-section.tsx`, `app/plugins/[pluginId]/[viewId]/page.tsx`. The whole list is "At the next upstream release" in `docs/upstream-0.6.0.md`.

**Tests**

- `tests/phone-layout.test.ts`: every rule of the three phone stylesheets is phone-only and browser-only, and each is imported by `app/layout.tsx`; the kept session-list entry; the Settings sections a phone lists; the greyed switch and the 40 px touch areas.
- `tests/phone-plugins-ui.test.tsx`: the gate, the Settings rows and the greyed switches, every other plugin still hidden.
- `tests/phone-flashcards.test.ts`: the guard (every class, attribute, label and test id the stylesheet and the touch helper hang on, with the upstream file that makes it; it fails when upstream renames or drops one, or when the stylesheet grows a hook that isn't listed), press and hold, the rename ✕, the keyboard maths.
- `tests/phone-flashcards-structure.test.tsx`: mounts the plugin's real screens and the host's tree and picker, and fails when the structure a phone rule assumes (children, siblings, order) stops matching.
- `tests/phone-rich-code-blocks.test.tsx`: the frame's states with the real plugin manager and render service, the boot's failure paths, and the guard on the plugin's names.

**What was checked**

- In a browser at iPhone size: a production build, real touch through CDP, the Safari-tab and the home-screen set-ups, a dark and a light theme. Every screen of the look was shot again after the change.
- **Flashcards with the stand-in provider:** a generation through the picker, the preview and Start.
- **Tests, typecheck, lint** (on the branch after the merge of `side-tutor`, before the sync fixes): typecheck clean; lint clean apart from the one existing warning; the full suite without `tests/safe-fetch.test.ts`: 5,997 tests, 5,988 pass, 4 skipped, 5 fail. The 5 are the four that fail in the development sandbox on untouched code ("Development notes from the merge" in `docs/upstream-0.6.0.md`) and one plugin SDK type test that runs out of its 30-second limit in a full run and passes alone. The plugin's own tests: 204 of 204.
- **The computer:** compared element by element at 1280 and 700 px against the build before the change: identical.
- **A fresh reviewer** read the phone diff and found two real bugs (the rename box stuck open after a hold on, or a slide off, its ✕; a hold inside the rename box opening the menu and saving) and smaller items. All are fixed.

**Only the owner's iPhone can show**

- The safe-area spacing (the home bar under the pinned buttons); the real keyboard with the scroll-into-view; Safari's bounce on the pinned footer; the rename ✕ keeping the keyboard up; the hold's timing and iOS's text callout; a formula scrolling sideways in a card; TikZ's time and memory; the viewer's pinch and drag.
- The plan ends the round with a "what to try on your iPhone" page; expect a second round from it.

**Built beyond the plan's letter, for the owner to review** (the owner was told of each in chat as it came up and hasn't answered item by item)

- **Renaming a deck:** while its box is open, that row's Review and + are hidden so the box has room (96 → 200 px); the ⚙ and the ✕ stay. A hold on that row does nothing while the box is open. Sliding off the ✕ and tapping elsewhere saves the draft (the plugin's own blur rule).
- The rename ✕'s hidden label for screen readers is "Cancel".
- The fork-drawn checkboxes (above).
- The phone's Settings list has no dividers above the plugin rows. On the Core plugins page the ⚙ of every core plugin that isn't phone-ready is hidden, Coding questions' too (the plan named Drawing Pad's).
- Between review cards the pinned band stays, with "Loading next card…" in it. In practice the "Practice mode does not change your review schedule." note sits under the pinned buttons.
- **Rich code blocks:**
  - an unfinished fence in a message still being written already shows the spinner;
  - the wait for the plugin to start is capped at 15 seconds (`RICH_WAIT_CEILING_MS`), after which the block shows its code;
  - if the server's plugin list isn't ready within 300 ms while a page is rendered (right after a server start), that first page shows code until the page's own plugin list arrives.
- The enlarge button's touch area extends to the left only (above).
- **Left as they are:** the picker's 28 px book and folder icon beside its 40 px arrow; the 28 px number fields of Settings → Flashcards; the app's 36 px session-list button; the session-list entries' 28 px height.
- **Found, not changed:** Enter in the Create deck box and in the Deck settings fields does nothing (upstream's behaviour).

### Hosting — built in Phase 1

- **Reached at your own domain** (for example `learn.<yourdomain>`). Caddy serves HTTPS with an automatic certificate.
- **`Dockerfile`** builds the same standalone server the desktop app runs and starts it in server mode as the `node` user:
  - `/data` is a volume: `/data/data` = `LH_DATA_DIR`, `/data/secrets` = the `auth.json` folder (mode 700), `/data/vault` = `LH_VAULT_DIR` (the Obsidian vault, Phase 4), `/data/home` = `HOME` (Claude Code and `ob`);
  - `reset-password` is on the PATH.
  - **Chromium** (Debian's package, `/usr/bin/chromium`) and one font are installed in the image. The demo agent runs every demo in a browser before it is shown (`src/agent/subagents/headless.ts`); the desktop app uses its own Electron for that, and the server has none. Without a browser every demo on the server failed with "No render engine available" (found by the owner, on an iPad). Upstream's checker finds Chromium at that path by itself and starts it with `--no-sandbox`, one launch per demo. The image workflow starts it in the built image; `tests/server-image-browser.test.ts` pins the install line.
    - The demo's page is model-written. It is loaded on a blank page with no access to files, and the app's own API answers it 401 (no login). Chrome's own sandbox is off, as in upstream's fallback on any computer, so a browser bug would be the one way out of the page.
- **`deploy/`:**
  - `compose.yaml`: LearnHarness and Caddy. `LH_TRUST_PROXY=1`, because Caddy's `X-Forwarded-For` / `X-Forwarded-Proto` are trusted for the lockout and redirects.
  - `Caddyfile`
  - `.env.example`: `LH_DOMAIN`, `LH_CHANNEL`, `TZ`
  - `update.sh`
  - `install-update-timer.sh`
- **Provider:** chosen at setup time. Hetzner CX23 is being considered, with DigitalOcean as the fallback.
  - Use **x86**, not ARM, because the native add-ons, the Claude CLI and `ob` are only confirmed on x86.
  - The server needs a **public IPv4** address.
- **Images:** `.github/workflows/server-image.yml` runs typecheck, tests and lint, builds and smoke-tests the image, then pushes it to `ghcr.io/jaeky42/learnharnessside`:
  - `:latest` from `side-tutor`;
  - `:dev` from the cloud sync feature branch;
  - plus a tag per commit.
  - It never creates a GitHub Release, so it can't affect desktop updates.
  - The package is **public**. GitHub creates it private, so set it to public once in the package settings.
- Multi-user hosting isn't planned. If it's ever wanted, the approach is one container per user on one VPS, with no changes to the single-user app.

### Updates

- **The desktop** keeps updating itself from this fork's releases, as now.
- **The server updates automatically, nightly at 4 am** (the server's system time zone). A systemd timer (`deploy/install-update-timer.sh`) runs `deploy/update.sh`: `docker compose pull`, then `up -d`, which restarts only what changed. It catches up after downtime. `/data` (the vault included) lives on a volume and isn't touched.
- **Version rule:**
  - The desktop and server exchange a sync protocol version on every sync.
  - If they don't match, sync **pauses**: the desktop keeps working locally and shows "Update the server to continue syncing".
  - Releases that change a data format are marked, so they're never applied to only one side.
- Multi-user hosting isn't planned. If it's ever wanted, the approach is one container per user on one VPS, with no changes to the single-user app.

## Phases

0. **Checks.**
   - ✅ ChatGPT sign-in and model calls from a VPS (callback replayed by hand).
   - ✅ Graph id and rewrite analysis (above).
   - ✅ `claude auth login` works on a headless VPS. It prints the link as plain text (`If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?...`). Claude's own page shows a code after the learner authorizes. A plain prompt (`Paste code here if prompted >`) takes it, then the CLI prints `Login successful.` The Sign in button drives this command; Disconnect runs `claude auth logout`. The native installer puts `claude` in `~/.local/bin`.
   - ✅ `ob sync-config` has `--excluded-folders` (comma-separated, empty to clear). It also has `--configs` (which `.obsidian` setting categories sync; may close the `.obsidian` gap), `--conflict-strategy merge|conflict` (an owner decision for Phase 4), `--file-types` and `--device-name`.
1. ✅ **Server mode.** Dockerfile, the `LH_DATA_DIR` volume, the password login gate in `proxy.ts`, Caddy (HTTPS), the server image workflow, and automatic server updates. Running on the permanent VPS: HTTPS via Caddy, setup and password, locked from outside, and the nightly timer installed.
2. ✅ **Sign-in on the server.** The ChatGPT paste box, plus the Claude sign-in button and Disconnect. Verified on the VPS: Claude Code installed itself onto the volume, and both ChatGPT and Claude connected from Settings.
3. ✅ **Phone layouts.** Every view, the side tutor bubble and sheet, the full-screen notes drawer, Settings, press and hold, and the home-screen app. Two real-phone rounds; the owner declared Phase 3 complete.
4. ✅ **Vault on the server.** Settings → Obsidian, the sync manager around `ob`, folders left out automatically, the safety check and Disconnect. Verified by the owner on the server with their real Obsidian account.
5. ✅ **Sync engine.** Pairing and device keys, the lease API, session sync with take-over (no copies: unsent turns are discarded), graph line and operation sync, per-key settings merges, and the sync protocol version check. Run between two built copies; not yet between the owner's real PC and server, which needs Phase 6's screens.
   - Built as wrapper stores at the composition root (`src/server/stores.ts`) over the `core/ports.ts` interfaces, so upstream store code stays untouched and rebasing onto upstream stays cheap.
6. ✅ **Sync screens** (desktop app, server's site and phone). Plan approved by the owner and built; see "Phase 6, the sync screens".
   - ✅ Slice 1: Settings → Cloud on both sides (pairing, sync state, Sync now, Unpair this PC; paired desktop apps and pairing codes on the server), with four engine changes.
   - ✅ Slice 2: a held session (the list line, the strip, Take over, the warning box, greyed controls).
   - ✅ Slice 3: the desktop's own notices (the sync chip, the offline strip, the discard box).
7. **Tests and docs** (not done; the owner merged without it). Lease, take-over and graph operation tests; an end-to-end test with two servers and one cloud; and an update of this file from "planned" to built.

## Handoff: where things stand and how to continue

### After the merge (read this first)

- **Upstream 0.6.0 is merged and shipped** to both branches, at the same commit. It raises the sync protocol to 2, so the server and the desktop app must both be updated or sync pauses (nothing is discarded while paused). What changed in sync, the gate, the phone layout and the screens is in `docs/upstream-0.6.0.md`. Where this file and that one differ, that one is newer.
- **The phone plugins round is shipped** (built on `claude/upstream-0.6.0`): Flashcards and Rich code blocks on a phone ("Plugins on a phone" under "Phone layouts") and Flashcards sync ("Flashcards sync" below). It raises the sync protocol to 3, so the same rule applies again: the server and the desktop app must both be updated, the server first.
  - **Where it stands:** With the owner's word ("if the run works and the review comes back ok, you can just ship"), the same commit was pushed to `claude/pensive-goldberg-7dty2m` (the server's image `:dev`) and to `side-tutor` (the Windows release), both plain fast-forwards. Both dry runs had passed on `7ad11e3`, the last code commit; the shipped commit adds only these lines. The owner hasn't updated the server or the PC yet, and the owner's iPhone hasn't seen it. The owner has the "what to try" page (an Artifact page): a copy of the PC's data folder and of the server's data by hand, the server's update, then the PC's, then tick-lists for the iPhone. If they report a problem, ask what the screen shows and what Settings → Cloud reads on the PC.
  - **Way back:** the server's image before this update is the per-commit tag of `a5d3284`; the owner's two copies by hand are the data's way back (protocol 3 changes no file format, so an older build reads the files, but it speaks protocol 2).
  - **For the owner's review, not yet answered item by item:** "Built beyond the plan's letter" under "Plugins on a phone", and "Rulings made while building" under "Flashcards sync".
  - **Reviews:** the sync part was reviewed in three passes; every finding is fixed, and the reviewer's last word was to ship ("The review of the wiring, and its fixes" under "Flashcards sync").

- **Merged:** `side-tutor` was fast-forwarded to the cloud sync branch at `a2d2b7e` with the owner's word ("merge"), and the Windows workflow published **release 0.5.6** from it. The desktop app now has everything in this file and in `docs/side-tutor.md`.
- **Checked on Windows before it went out:** the Windows workflow was started by hand on the cloud sync branch (a dry run: no release) and passed, with the sync and cloud tests added to it. Before that the sync code had only run on Linux.
- **Confirmed by the owner on the real PC and the real server:** after release 0.5.6 they updated the server, followed the pairing guide (an Artifact page) and reported "everything works!". They didn't say which screens they tried, so a take-over, the offline chip and the discard box may still be unseen on real devices. If they report a problem later, ask what the screen shows and what Settings → Cloud reads on the PC; never ask for a pairing code, a password or the server's address.
- **Which branch changes what, from now on:**
  - a push to `side-tutor` publishes a desktop release (and builds the server image `:latest`). It still needs the owner's approval every time;
  - the owner's server follows `LH_CHANNEL=dev`, which is built from `claude/pensive-goldberg-7dty2m`. A change the server should get must be pushed there; a change both should get goes to both branches, kept at the same commit.
  - Moving the server to `latest`, so one branch feeds both, is the owner's call and hasn't been asked.
- **The two sides must speak the same sync protocol version** (1 in release 0.5.6; **2 from the upstream 0.6.0 merge on**, see `docs/upstream-0.6.0.md`; **3 with Flashcards sync**, see "Flashcards sync"). A change that raises it has to reach the server and the desktop together, or sync pauses until both are updated.
- **Restoring a first-sync backup** (`%APPDATA%\LearnHarness\backups` on the PC, `/data/backups` on the server) has no written guide. Putting old files back while paired would sync the old state everywhere: unpair first, and write the steps for the situation at hand. (With Flashcards sync, Flashcards' library put back deletes nothing anywhere; "Restoring a backup" under "Flashcards sync".)
- **Not done:** Phase 7 (one automated test with two desktops and a server syncing everything together; a tidy of this file). The owner chose to merge without it.

### State before the merge (Phases 0–5 done; notes drawer additions built)

Kept as written while the work was on its own branch; where it says "until the merge", that has now happened.

- **Branch:** `claude/pensive-goldberg-7dty2m`. All cloud sync work lives here.
  - Pushes build only the server image (`:dev`), never a desktop release.
  - **Never push to `side-tutor`** until the owner approves merging the whole feature.
- **Phase 4 (the Obsidian vault on the server) is complete.** The plan was approved by the owner beforehand (every decision is recorded under "Obsidian vault on the VPS"), and the owner confirmed on the real server that sign-in, connecting and syncing work.
  - Tested here: the full suite, plus the manager driving the real `ob` program against a stand-in for Obsidian's servers, and a Playwright run in server mode at phone and desktop size.
  - The owner's check covered the update, the install of `ob`, sign-in and connect. The stopped states (a refused sign-in, an ended subscription, the safety pause) have only been seen against the stand-in; the texts of Obsidian's real error messages are the likeliest place for a surprise.
  - The guide's server commands must each start with `cd ~/learnharnessSide/deploy &&`: `docker compose` only works from that folder (the owner hit this).
  - If the owner reports a problem, ask what Settings → Obsidian shows and for the lines `docker compose logs lh` prints that start with `[LearnHarness] Obsidian sync:`. They hold state changes and Obsidian's own reason for a refused sync, never note names, folder names or passwords. `ob`'s own log is `/data/home/.config/obsidian-headless/sync/<vault id>/sync.log` in the container; it lists note names, so ask the owner to read it rather than paste it.
  - Wording added while building, beyond the approved screens, for the owner to review: "Nothing yet" (no folders left out so far), "Obsidian said: …" (Obsidian's own words under a refused sign-in), "Loading your vaults…", "Couldn't check Obsidian sync on this server.", "The vault couldn't be connected. Try again.", "Obsidian's sync program couldn't be disconnected, so nothing was removed. Try again.", "Obsidian's sync program didn't answer. Try again.", the drawer gear's tooltip "Obsidian settings", and **Try again** on the ended-subscription state.
- **Phase 3 (phone layouts) is complete** (the owner's call, after two real-phone rounds; see "Real-phone checks" above). The last fixes pushed before that call (the home-screen app's top inset at +26 points, phone menus pinned by their top, Fable as `fable`) weren't reported on individually; if the owner mentions one of them, start from its bullet in "Phone layouts".
- **Open by design:** the Safari-tab bleed stays marked as an experiment (it works on the owner's phone); a tablet layout is not built.
- **Also on this branch (not phone work):** Claude Fable in the Claude Code model list and the Claude-models-last menu order (see `docs/side-tutor.md`, "Claude Code: Fable in the model list"). It reaches the desktop app only with the merge.
- **Known CI flake:** `tests/notes-import-route.test.ts` (first test, "out-of-order completion remains supported") depends on timer order and fails now and then on GitHub's runners. It isn't related to this work: re-run the failed job. A separate task to make it deterministic was offered to the owner.
- **Phases 0–2 are done and verified on the owner's VPS:**
  - HTTPS and the password login work;
  - the nightly update timer is installed;
  - Claude Code installed itself onto the volume;
  - ChatGPT and Claude are both connected from Settings.
- **The cloud copy and the desktop app are still separate libraries** for the owner: the engine is built, but pairing needs Phase 6's screens and the desktop app only gets any of this with the final merge.
- **The owner's server follows `LH_CHANNEL=dev`.** To update it right away instead of waiting for the nightly run: `cd ~/learnharnessSide && git pull && cd deploy && ./update.sh`. The `git pull` is needed only when files in `deploy/` changed. After an update, a home-screen app has to be swiped away and reopened to load it.

### How the owner works

- **Per AGENTS.md:**
  - Investigate first, then ask design questions **one per AskUserQuestion call**.
  - Get the phase plan approved, then build.
  - Never guess a design or wording decision.
- **The owner prefers visuals.** Use diagrams and mockups in questions, and phone-friendly step-by-step guides as Artifact pages for anything done on the server. Each command is tagged with where it runs, and the guide has fill-in boxes for values like the domain.
- **The owner is new to servers.** The PC is Windows (PowerShell, not Command Prompt). Spell out every command and what success looks like. Never ask the owner to paste secrets, setup codes or sign-in codes into chat.
- **Each phase ends with:**
  - tests and `npm test` / typecheck / lint;
  - a real browser check (Playwright) in server mode;
  - a commit and push to the branch;
  - a "what to try on your server" list.

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
  - The numbers to tune, should that change, are at the top of `row-drag.ts` (`EDGE_BAND`, `INTO_DWELL_MS`, `LEVEL_STICK`) and `row-drag-dom.ts` (`PART_MS`, `SETTLE_MS`, `SLIDE_MS`, `INTO_TUCK`).
- **A third round, asked for with that confirmation** (decisions in `docs/side-tutor.md`):
  - the bottom row can be pulled down out of the bottom folder;
  - on a computer the minimized side tutor is the phone's round bubble, at the lesson's bottom right (16 px in from the lesson's right edge, 20 px above the question bar; the owner's placing after "too far" and "too close");
  - the tutor window's words are "Tutor", "Stuck on a term or a step? Ask here." and "Ask a follow-up…" (the owner first asked for less text, then gave these three);
  - the tutor has its own Dictate button with a small live waveform;
  - the site has a browser-tab icon (the logo).
- **State of that round:** pushed (the owner first asked to hold it for a bigger batch, then said to push), and on the owner's server since; see the fourth round for what they reported.
  - Checked in a browser at phone size (touch) and at computer width (mouse).
  - **The tutor's dictation has never met a real microphone or Deepgram**: it was run with Chromium's made-up microphone and a stand-in for Deepgram's socket in the page. It reuses the lesson's dictation run unchanged, so the likeliest surprises are in the hand-over (who gets the words, the lesson's bar staying idle), not in the audio.
  - The 20 px above the bar is a reading of "a little higher up"; the owner may want it tuned (`BUBBLE_BAR_GAP` and `BUBBLE_EDGE_GAP` in `components/side-tutor.tsx`).
  - The "what to try" page was last updated for the redone drag; it doesn't cover this round.
- **A fourth round, the tutor window's look and resizing** (decisions in `docs/side-tutor.md`, "The window's look" and "Moving and resizing on a computer"): the middle of the window is closer to black and more see-through, Dictate and Send are as tall as the typing box, the hint "Ask a follow-up…" is a little smaller, and on a computer the window resizes from its left, right and bottom sides and its bottom corners, with the size remembered.
  - **State:** pushed, and **tried by the owner on the server: "all the changes worked"**. One thing was hard: finding the resize zones, which were mostly outside the window. They now sit on its edges and are larger ("Moving and resizing on a computer" in `docs/side-tutor.md`). The owner tried that fix and the site's new name too: "everything is how I like it".
  - The owner didn't say which pieces they tried, so the tutor's dictation with a real microphone is still not confirmed one way or the other.
  - Before that, the owner had seen before-and-after screenshots (computer and phone). The shade is the owner's pick (black at 60%; 70% was too black). The hint's size (14 px) is a reading of "slightly smaller".
  - The owner asked why the phone's sheet wasn't see-through: the dim behind it covered the whole screen. It now covers only the lesson above the sheet. Shown as a screenshot; not confirmed on the iPhone, where the blur behind a sheet that slides in is the thing to look at.
  - Checked in a browser at both sizes: the box and the buttons measure the same at reading sizes from 14 to 22 px, the box keeps its height when typing starts, and dictation still lands its words in the tutor's box.
  - Resizing was driven with a real mouse in the browser: the pointer over each zone and over the top bar, each side and corner, the limits, the remembered size after minimizing and after a reload, and a smaller app window. The owner approved the plan (a picture of the zones) and chose "remember the size"; they have seen a picture of the zones, tinted for the picture only.
  - Playwright hides scrollbars by default; launch with `ignoreDefaultArgs: ["--hide-scrollbars"]` to get real ones. The run of the larger zones did, and dragged the conversation's scrollbar thumb beside the right strip.
- **Nothing is queued after this round.** The owner asked whether anything was left in Phase 4 (nothing is), and then handed the work over for Phase 5 to begin.
- **The drawer's message line** now goes after 5 seconds, or 20 with an Undo button (the owner's ask and choice; "The message line" under "Notes drawer" in `docs/side-tutor.md`). Timed in a browser. Pushed as the last change before Phase 5; the owner hasn't said yet whether they tried it.
- **Wording and behaviour added without being asked:** the message `Deleted “Electricity”.` after a delete, and the message line showing on the phone's list screen. The owner has used both and asked only for the messages to go sooner, so they stand unless the owner says otherwise.

### Phase 5, the sync engine (built), and what comes next

**The owner approved the Phase 5 plan page, and all six slices are built** ("Phase 5: what is built"). **Phase 6, the screens, is built too**, all three slices ("Phase 6, the sync screens", below). Phase 6 changed four of the engine's rules at the owner's request; they are listed there, and the Phase 5 text below is corrected where it described the old rule.

**What the owner can and can't see now**

- **Can see, since Phase 6 slice 1:** a Cloud row in the server's Settings ("No desktop app is paired.", Add a desktop app). There is no desktop app with this code installed anywhere, so nothing is paired and the engine stays switched off on the owner's server and phone.
- **Built but not visible there:** "Held by …", Take over (slice 2), the sync chip and the notices (slice 3) show only once a desktop app is paired, and the last three only in the desktop app.
- **What an update to the server should look like:** exactly as before. That is the thing to check.
- **Can see:** the page of screenshots and timings from two copies syncing (shown to the owner at the end of Phase 5).
- **The API under the screens:** `GET | POST /api/cloud` on the app, `POST /api/server-auth/desktops` on the server's site.

#### Phase 5 decisions (owner, asked one at a time)

1. **Signing in: a pairing code.** The server's site (Settings → Account, signed in) shows a code that works once, for 10 minutes. The desktop app takes the server address and the code and gets its own device key. The key works only for the sync API, is stored on the server only as a hash, and never involves the server password.
2. **Pairing lasts until removed.** No time limit. A desktop is unpaired by its own Remove button, and also by Sign out everywhere, a password change and `reset-password`, as those sign out every other device. Unpairing deletes nothing on the PC. A new code reconnects it as the same device, with whatever it hadn't synced. (Phase 6 added the PC's own **Unpair this PC**; see there.)
3. **Trying the desktop side: two server copies only.** No desktop test build and no run from source. One copy plays the desktop and one plays the server, in automated tests and browser runs. The owner tries nothing on the PC before the merge, so **sync must stay off in the app until it is paired**, and an unpaired app must behave exactly as today.
4. **First sync: combine both libraries.** Pairing deletes nothing. Desktop sessions go up and cloud sessions come down, each still held by the side it came from. The graphs are joined; a concept learned on both sides before pairing shows twice (the known limit).
5. **A backup once per side**, right before that side's first sync: a dated folder under `backups/` beside the data folder (sessions, graph, side-tutor threads, jobs, settings; no credentials, not the vault). Restored by hand with a guide.
6. **Take over warns only on evidence.** The server keeps, per session, when the holder last checked in and its last word. Warn when that was "busy" or "unsent", or the holder went silent in the middle of a reply. If it was "all sent", no warning, even if the holder has been offline since. An online holder is asked to hand over and no warning is needed.
7. **No copies** (see "Sessions" at the top).
8. **The gap that leaves** (a desktop that said "all sent", went offline and was then used offline): while it can't reach the server, the desktop shows a heads-up in a session being continued; after a discard it shows a notice naming the session and the number of turns. Both screens are Phase 6; Phase 5 supplies the facts.
9. **A busy online holder at take-over:** the reply being written finishes and is sent. Background helpers (research, demo, visual, PDF) stop there and start again from the beginning on the new holder. Extraction stops and the new holder redoes it later.
10. **A held session is read-only until taken over.** Reading it, the notes drawer and moving it between folders work. Sending a message, the side tutor, renaming, changing its model and deleting wait for Take over.
11. **Timing:** a session is sent about 2 seconds after a change; the desktop tells the server when a reply starts and ends; it asks the server for news every 10 seconds; a full sync at app start; quiet retries while offline, slowing to once every few minutes. There is no "final sync on quit" (on Windows the local server is killed at once).
12. **Settings split.**
    - Synced, latest change wins per setting: appearance (mode, background, text size, serif session names, heading weight, bold and italic colours), dictation language, graph (extraction on/off, rendering on/off, chunk size, the graph view sliders), compaction threshold, agent (tool switches, search engine, prober graph tools), and prompt overrides (the texts and their switches).
    - Per device, never synced: model slots and per-role model overrides, the custom provider, the Claude Code switch, file-access folders, the reading font, automatic updates, keyboard shortcuts, keys and sign-ins.
    - The chains-view folders (`source-organization.json`) always sync.
    - At the first pairing, where the two sides differ, the desktop's value is kept.
    - A session's own model travels with the session; if it isn't set up on the other device, the learner picks one there.
13. **Graph deletions: repeat the action.** The server keeps one ordered log of graph changes. A deletion is logged as what was done ("delete session X with its concepts", "delete node N", the chain clean-up) and each device runs it on its own graph. A rewrite the engine doesn't recognise is logged as its exact result (which lines went or changed), so nothing is skipped.
14. **Protocol version:** starts at 1 and rises only when a release changes the wire format, a stored format that syncs, or the replayed deletion rules. The two sides must be equal or sync pauses. Messages: "Update the server to continue syncing" (server behind) and "Update LearnHarness to continue syncing" (app behind).
15. **Vault folders:** at each sync the desktop sends the names of its vault's top-level folders (names only), and the server adds them to the folders it leaves out.

#### Smaller rules (proposed in the plan page, approved with it)

- **Pairing code:** 8 characters shown as `XXXX-XXXX`, the setup code's alphabet. Wrong codes count toward the same pause as wrong passwords (5 tries, then 15 minutes).
- **Address:** the desktop only connects to an `https://` address (plain `http` only for this machine itself, which is how two copies run side by side in tests).
- **The device key on the PC:** `cloud-sync.json` beside `auth.json`, mode 0600, never synced, refused by the agents' file tools.
- **Online** means the server heard from the device in the last 30 seconds (three missed checks).
- **At most 10** paired desktops.
- **New sessions** belong to the device that created them; one created offline goes up at reconnect. Practice sessions follow the same lease rule.
- **What a discard removes:** the session's turns that never reached the server, counted as the messages the learner sent, plus graph knowledge extracted from that session and not yet sent. The new holder extracts again where needed.
- **Helpers restart** only on the device that holds the session. A helper needs its model set up there; otherwise the lesson shows the existing "needs setup" state.
- **Pictures in a session** are sent once, not with every send of the session.
- **Clock differences:** the server corrects for a PC clock that is off before deciding which settings change is the latest.
- **Imported-file records and graph positions** sync one item at a time, latest wins. An imported file's path stays the path on the device that imported it.
- **Backup contents:** sessions, graph, side-tutor threads, helper jobs, settings, prompt overrides and the notes home-folder records. (Since the upstream 0.6.0 merge: custom themes, the plugins' on/off record and the core plugins' data too, and no side-tutor threads, which are inside the sessions now. With Flashcards sync, a second backup of Flashcards' folder alone, right before each side's first Flashcards exchange: "Flashcards sync".)
- **While sync is paused** (versions differ, or unpaired) nothing is discarded; it resumes where it stopped.
- **Device names and the wording of every message** ("Held by Desktop", the warning, the heads-up, the notice) are asked in Phase 6 with the screens. Phase 5 stores a name per device and the facts each message needs.

#### Phase 5: what is built

**Slice 1: pairing, device keys, the version check**

- **On the server** (server mode only; everything answers 404 without it):
  - `POST /api/server-auth/desktops` (a signed-in browser): `{op:"code"}` returns a pairing code and when it runs out; `{op:"remove", id}` unpairs one desktop. `GET /api/server-auth/account` now also returns `desktops` (id, name, paired and last-seen times; never a key).
  - `POST /api/sync/pair` (a desktop app): `{code, deviceId, name}` returns the device key, once.
  - `POST /api/sync/hello` (a paired desktop): the protocol check; answers the server's clock too.
  - Paired desktops and the waiting code live in `server-login.json` (`devices`, `pairing`), as hashes. `reset-password` writes a fresh file, which unpairs every desktop.
- **The gate** (`syncGate` in `src/server/server-auth.ts`): `/api/sync/*` opens to a device key in `Authorization: Bearer …` and to nothing else. The login cookie does **not** open it, and a device key opens no other path. A request that names another site (`Origin`, or `Sec-Fetch-Site: cross-site`) is refused. `/api/sync/pair` passes the gate without a key; its route checks the code and the lockout.
- **The version rule** (`src/core/sync/protocol.ts`): the desktop sends `x-lh-sync-protocol` on every request. Unequal → 409 `protocol_mismatch` with the server's number; the desktop then shows the approved sentence for the side that is behind. A server too old to have the sync API at all counts as behind.
- **On the desktop** (`src/server/sync/client.ts`): `pairWithServer`, `contactServer`, and `syncRequest`, the one function every later sync request goes through. It handles the three shared outcomes: the server unpaired this desktop (the key is dropped, the device id and address kept, so a new code reconnects it as the same device), the versions differ (paused), the server can't be reached (offline; never unpairs).
  - `GET /api/cloud` returns this copy's state: `off` (never paired), `starting`, `ok`, `offline`, `paused` (with the sentence), `needs-pairing`. `POST /api/cloud` takes `{op:"pair", server, code, name}` and `{op:"check"}`. On the cloud server `GET` answers `{role:"server"}` and `POST` 404. Phase 6's screens will call this; nothing calls it yet.
  - A desktop sends its device id only to the server it was paired with; another address gets a fresh id.
- **Nothing runs where nothing is paired:** an app with no `cloud-sync.json` makes no request and writes no file.
- **Wording added while building, for the owner to review in Phase 6** (it is only reachable through the API today): "That pairing code isn't right, or it has run out. Get a new one from the server's site.", "This server already has 10 desktop apps paired. Remove one first.", "This server isn't set up yet. Open its site and choose a password first.", "That desktop app isn't paired any more.", "This desktop app isn't paired with this server.", "Couldn't reach that server. Check the address and your connection.", "That address didn't answer like a LearnHarness server.", "Enter your server's address.", "The server's address must start with https://", "Give this desktop a name of up to 40 characters.", "Enter the pairing code from the server's site."
- **Code:** `src/core/sync/{protocol,devices,address}.ts`, `src/store/sync/pairing.ts`, `src/server/sync/{http,client,cloud-http}.ts`, `app/api/sync/{pair,hello}`, `app/api/server-auth/desktops`, `app/api/cloud`; changes in `src/core/server-auth.ts` (the state's `devices` and `pairing`), `src/server/server-auth.ts` (the gate, the account data, unpairing on a password change and Sign out everywhere), `src/agent/tools/fs-shared.ts`, `scripts/server-reset-password.mjs`.
- **Tests:** `tests/sync-pairing.test.ts`. One process plays both sides: the desktop's client is given a `fetch` that delivers to the server's gate and routes.

**Slice 2: sessions and leases**

- **A session travels whole**, as the exact text of its files: `chats/<id>.json`, `side-tutor/<id>.json`, `notes/sessions/<id>.json`, and every `jobs/<jobId>.json` whose `chatId` names it (`src/store/sync/session-files.ts`). Both sides end with the same bytes.
- **The server is the lease authority** (`src/server/sync/authority.ts`, state in `<data>/sync/authority.json`). Per session it records the holder (a device id, or `cloud` for the server's own), a version, and the holder's last word. Only the holder's send is accepted; any other device gets 409 `lease_lost` with the current state.
  - The server's own changes (what the phone does) are found by comparing file stamps (times and sizes), then content digests, whenever a desktop asks for news. Nothing in the server's own write path was changed for that.
- **A desktop's round** (`src/server/sync/desktop-sync.ts`, state in `<data>/sync/desktop.json`): ask what changed since its place in the server's list and fetch those sessions; send the sessions it holds that changed and the new ones it made; report sessions it deleted. `POST /api/cloud {op:"sync"}` runs one round (the timed rounds come with slice 6).
- **Routes for a paired desktop:** `POST /api/sync/sessions` (what changed since `cursor`; also carries the holder's reports), and `GET | PUT | DELETE /api/sync/sessions/<id>`.
- **The first sync is nothing special:** every session here that the server doesn't know is new and goes up, held by this desktop; every session there comes down, held by whoever holds it. The backup is made first, once per side (`src/store/sync/backup.ts`); if it can't be made, the sync doesn't start.
  - The same id on both sides before they ever synced (possible only if one side's data was copied from the other): identical files are one session; different files are left alone on both sides and never sent over each other.
- **Read-only until taken over** is enforced in three layers:
  1. `proxy.ts`: every write under `/api/chats/<id>` answers 409 `session_held_elsewhere` with the holder (`sessionWritePath` in `src/server/sync/engine.ts`).
  2. Where the session id is in the body: the top of `handleChatInput` (before compaction, any write or any model call), the manual extraction route, and `runningWorkBlocker` (deleting through the sources view).
  3. The stores (`src/server/sync/guarded-stores.ts`, wired in `src/server/stores.ts`): a write that still arrives, for example from background work that was running when a session moved, is dropped, never saved.
  - The notes home folder: its route leaves the record as it is on a held session and answers normally, so the drawer keeps working.
  - `recoverStaleJobs` skips sessions this copy doesn't hold, so fetching a session whose helper is still running elsewhere doesn't start it here.
- **While paused, or unpaired by the server,** the desktop still knows which sessions are held elsewhere (its identity is kept in `cloud-sync.json`), so they stay read-only and nothing is discarded. After the learner's own **Unpair this PC** every session can be continued there (Phase 6, engine change 4).
- **Deleting:** the holder's delete removes the session's files on the server and on every other device at their next round; a deleted id is never accepted again. The graph side of a deletion comes with slice 4.
- **Wording added while building, for Phase 6:** "This session is held by another device. Take it over to continue it here." (the 409's text).
- **The store wrappers call the inner store's method as it is at that moment**, never a reference taken at wiring time: upstream's tests replace methods on the inner store object.
- **Tests:** `tests/sync-sessions.test.ts` (an authority and one or two desktops over separate data folders in one process), `tests/sync-sessions-gate.test.ts` (the read-only rule at the real entry points, with this process as a paired desktop).
- **Real run:** two copies of the built app (`next build`, `scripts/build-server.mjs`, then `.next/standalone/server.js` twice with different `PORT`, `LH_DATA_DIR` and `LH_AUTH_FILE`, one with `LH_SERVER_MODE=1`), paired and synced through browsers.

**Slice 3: take-over**

- **Asking for a session:** `POST /api/cloud {op:"take-over", chatId, force}` on either side. On the server it is the phone asking for itself; on a desktop it goes to `POST /api/sync/sessions/<id>/take`. The answer's `status`:
  - `yours` / `moved`: the asker holds it now;
  - `waiting` (`reason: "reply"` or `"handing-over"`): the holder is online and will hand over; ask again;
  - `warning` with `heldBy` (name, last seen, last word): the offline holder may have unsent turns; ask again with `force: true` to take it anyway.
- **The evidence rule** (`takeOver` in `src/server/sync/authority.ts`): a desktop is online while the server heard from it in the last 30 seconds. Offline, its last word decides: after `all-sent` the session moves at once with no warning; after `busy` or `unsent` it warns.
  - The desktop's word travels with every round (`busy` while a reply is being written, `unsent` when it has changes the server lacks) and with every send (`busy` or `all-sent`).
- **Hand-over from an online holder:** the server notes the request; the holder sees it at its next round. If it is writing a reply it carries on (and keeps saying `busy`); otherwise it stops its helpers and extraction, sends the session with `release`, and the server gives it to the asker. A request nobody repeats for a minute is forgotten.
- **From the cloud to a desktop** there is never a warning: the server knows its own state. It waits while it is writing a reply for that session, then stops its helpers and extraction and moves it.
- **Helpers move by restarting:** a stopped helper writes nothing more, so its record travels as `running`, and the new holder's `recoverStaleJobs` starts it again. Stopping is `fireJobAbort` without the "aborted" record that the learner's own Stop writes.
- **No copies:** a desktop that finds another device holding a session it held stops whatever it was still doing for it (a reply too), takes the server's version in place of its own, and, if its own differed from what it last sent, keeps a notice: the session's id and title, the number of messages the learner sent there that the server never got, and the time. `GET /api/cloud` returns `notices` until `POST {op:"dismiss-notice"}`.
  - A send that reaches the server after the take-over is refused (`lease_lost`) and handled the same way.
- **Facts for the Phase 6 screens:** `GET /api/cloud` returns `held`: on the server every session it doesn't hold with the holder's name, `online`, `lastSeenAt` and `word`; on a desktop every session it doesn't hold with the holder's id and name. The offline heads-up needs only `sync.state` (`offline`, `needs-pairing` or `paused`) and whether the session is in `held`.
- **Where this copy's own work is wired:** `src/server/sync/local-work.ts` gives the engine "is a reply being written" and "stop helpers and extraction" from the real turn and job modules. It is loaded by the server barrel. `engine.ts` itself stays small because `proxy.ts` loads it.
- **Tests:** `tests/sync-takeover.test.ts` (every path above with one or two desktops), `tests/sync-local-work.test.ts` (the cloud's side against the real turn registry, job aborts and the recovery sweep).
- **Real run:** between two built copies: an online hand-over, taking it back, and a take-over during the desktop's silence followed by the discard and its notice.

**Slice 4: the graph log**

- **What travels:** the four ledgers (`nodes`, `chains`, `coverage`, and the checkpoints in `sessions.jsonl`). `sources.json` and `positions.json` are maps and belong to slice 5.
- **One ordered log on the server**, `<data>/sync/graph-log.jsonl`, one entry per line: `{seq, by, eid, change}`. A change is one of (`src/core/sync/graph-log.ts`):
  - `line`: one line appended to one ledger;
  - `delete-sources` (ids, mode), `delete-node` (id), `simplify-chains`: a deletion logged as what was done. Each device runs the app's own deletion code for it (`deleteSourcesTraces`, `deleteNodeTraces`, `simplifyChains`);
  - `rewrite`: the exact result of a rewrite the engine can't name: which lines went (by hash) and which changed. Nothing in the app produces one today; it is the net under a future rewrite.
- **Every device applies the same entries in the same order with the same code**, so the ledgers end identical, byte for byte.
- **Where it attaches:** `stores.graphStore` is a wrapper (`loggedGraphStore` in `src/server/sync/graph-sync.ts`) that writes each change down before making it. The three named deletions are wrapped where they happen (`recordGraphAction` in `src/server/chats.ts`, `source-deletion.ts` and `graph.ts`), so the ledger writes inside them aren't logged a second time. The clean-up of redundant arguments at the end of an extraction is recognised inside `rewriteLedgers`.
- **A desktop's round** (after the sessions round): fetch the entries it hasn't seen, redo its own unsent entries on top of them, send them. The server takes them only on top of everything it has (`409 behind` otherwise, and the desktop fetches again). An entry carries its own id (`eid`), so one that arrives twice, after a lost answer, is applied once. A big send goes in pieces of at most 1,000 entries or 4 MB.
  - The desktop keeps `graph.json` (its place in the log, and the log's name), `graph-outbox.jsonl` (its unsent entries) and `graph-base/` (the ledgers as the server has them, kept only while something is unsent) under `<data>/sync/`.
- **The first sync needs no special case:** the server's graph as it stands becomes the start of the log the first time a desktop asks, and everything on the desktop counts as unsent on top of nothing. Both graphs are joined: the server's lines, then the desktop's.
- **The owner's example holds** (a test pins it): the desktop, offline, deletes "Circuits" with its concepts; meanwhile "Motors" on the phone teaches Ohm's law too. After the sync Ohm's law is on both, with its name and statement, minus what only Circuits said about it; a concept only Circuits taught is gone.
- **A session lost to a take-over** takes its unsent graph entries with it (`discardSession`): the lines that only that session taught. The new holder extracts again.
- **A server that was reset or restored** has a log with a new name (`graph-log-id`). A desktop that sees another name treats everything it has as unsent again and combines afresh.
- **Nothing is recorded before the first graph sync:** no log on the server until a paired desktop first asks, no files on a desktop until its first round.
- **Known limits:**
  - The same concept learned separately on two devices before they synced is two nodes (accepted for v1; see "Graph sync").
  - A crash in the instant between writing an entry down and making the change leaves that one change in the log but not in the ledger. There is no repair pass.
- **Routes for a paired desktop:** `GET /api/sync/graph?after=<seq>&log=<name>` and `POST /api/sync/graph {after, log, entries}`.
- **`POST /api/cloud {op:"sync"}`** now answers `{round: {sessions, graph}}` (`src/server/sync/round.ts`).
- **Tests:** `tests/sync-graph.test.ts` (the rules, with each side's graph in memory and real log files), `tests/sync-graph-wiring.test.ts` (the real ledger files and the app's real deletion entry points, this process as the server).
- **Real run:** two built copies with the test library on the desktop and two concepts on the server: first sync (ledgers identical on both), a concept deleted on each side, and a session deleted with its concepts.

**Slice 5: settings and the other small files**

- **What travels, one item at a time** (`src/core/sync/maps.ts`; the key's first letter says what it is):
  - `s|…` the synced settings from `settings.json`, each on its own: the approved list (`SYNCED_SETTINGS`), plus every tool switch and every prompt switch (`SYNCED_SETTING_MAPS`). **Nothing else in `settings.json` is ever read or written by sync**: a request that names any other setting is refused whole.
  - `p|…` prompt override texts (`prompts/**`);
  - `r|…` the graph view's sliders, one field each (`graph/render-settings.json`);
  - `f|…` and `o|…` chains-view folders and where each source is filed (`graph/source-organization.json`);
  - `n|…` imported-file records (`graph/sources.json`); the file path in a record stays the importing device's;
  - `x|…` node places (`graph/positions.json`).
- **No hook in any write path.** Each side compares its files with what it last agreed on, whenever a round runs. That also catches a file edited by hand. The files are read and written through the app's own stores (`src/server/sync/map-views.ts`), so a value passes the same sanitizers as one set in the app.
- **Latest change wins, on the server's clock.**
  - A change found in a file gets that file's own modified time (never later than now). A desktop adds the difference between its clock and the server's, measured on every answer and remembered for when it is offline.
  - A desktop notes its changes with their times while it is offline or paused (`detect()`), so a change made on Monday is still Monday's when it reconnects on Wednesday.
  - A time from the future is cut back to the server's "now".
- **One exchange** (`POST /api/sync/maps`): the desktop sends its changes and its place in the server's counter; the server takes each one newer than what it has and answers with everything changed since that place (and, for each item the desktop sent, either "same" or what the server has instead).
- **The first desktop's first sync** (owner: "where the two sides differ, the desktop's value is kept"; since Phase 6 only for the first desktop a server ever syncs with):
  - an item both sides have, with different values: the desktop's;
  - a synced **setting** the server has set and the desktop hasn't: it goes back to its default on the server too (not set is the desktop's value);
  - everything else is joined: a folder, a prompt text, an imported-file record or a node place that only one side has is kept on both.
  - A prompt text that only the server has is kept, with its switch off (the desktop's value). The owner confirmed this in Phase 6.
- **A desktop paired later** (owner, Phase 6: "only the first PC brings its settings", so a fresh install can't put every device back to its defaults). At its first sync:
  - its synced settings become the server's, "not set" included;
  - where both have the same folder, prompt text, imported-file record or node place, the server's is kept;
  - anything of those kinds that only the new PC has is added on both sides.
  - "First" is the server's record of which desktops have done a first sync (`devices` in `maps.json`). A server that lost that record treats the next desktop as the first again.
  - Since the Flashcards review: a desktop also counts as later while another is part-way through its first exchange (in pages), so two PCs whose first exchanges overlap aren't both first. It holds for the settings exchange and for Flashcards'.
- **A file that is there but can't be read is left alone**, on both sides: its items are neither sent, taken nor deleted that round. Reading a damaged `settings.json` as "no settings" would have reset the other side's. Since the Flashcards review, the desktop's place in the server's list doesn't move in such a round either, so nothing the server has for that file is passed over.
- **Chains-view folders changed on two devices at once** are made whole after every change that arrives (`withOrganizationItems`): a folder whose parent is gone, or that would sit inside itself, moves to the top; a source filed in a missing folder is unfiled. The same on every device.
- **A value a file adjusts on the way in** (the settings sanitizer clamps a number, say) is recorded as adjusted and sent back once; it doesn't bounce.
- **A server that lost its records** answers `409 send_all`; the desktop then sends everything once, as at a first sync.
- **An open page** shows a setting that arrived by sync the next time it loads its settings; the chains view updates at once (`sources-changed`).
- **The vault's folder names** (decision 15): with a round, when the list changed, the desktop sends the names of its vault's top-level folders (`desktopVaultFolders`; names only, nothing inside them is opened; nothing is said while the vault is offline). The server keeps them in `<data>/sync/vault-folders.json`, and the Obsidian sync manager leaves them out like folders found on disk: at every start of `ob` (so before a first download), and at once if `ob` is running when a new name arrives (`foldersAnnounced`, one restart). The notes folder and dot-folders are never left out, whatever is sent.
- **State:** `<data>/sync/maps.json` on the server (per item: a fingerprint, the time, the counter; never a value), `<data>/sync/maps-desktop.json` on a desktop. Neither exists before a desktop's first round.
- **A round** is now sessions, then the graph, then these files: `{round: {sessions, graph, maps}}`. (With Flashcards sync, the Flashcards library comes last: `{sessions, graph, maps, flashcards}`; "Flashcards sync".)
- **Code:** `src/core/sync/maps.ts`, `src/server/sync/{map-views,maps-sync,maps-engine}.ts`, `src/store/sync/vault-folders.ts`, `app/api/sync/maps`, and three small additions to `src/server/obsidian-sync.ts`.
- **Tests:** `tests/sync-maps.test.ts` (the rules; each side's files in memory, real state files, PCs with wrong clocks), `tests/sync-maps-wiring.test.ts` (the real stores and files), and one more case in `tests/obsidian-sync.test.ts` (the real `ob`: announced folders are left out before any of their files arrive).
- **Real run:** two built copies: a first sync (the desktop's settings on both, the server's model and font untouched, 371 node places and the sliders equal), a setting changed on each side, and a chains-view folder made on the server showing on the desktop.

**Slice 6: timing, pictures sent once, and the whole thing running by itself**

- **When a paired desktop syncs** (decision 11; `src/server/sync/loop.ts`):
  - a full round when the app starts (at its first API request, a moment after the window opens);
  - about 2 seconds after a change here (`turn-settled`, `record-changed`, `chats-changed`, `jobs-changed`, `sources-changed`, `activity-changed`; with Flashcards sync also Flashcards' own `changed` and `batch-changed` notices, but not the ones sync itself sends);
  - at once when a reply starts (`turn-started`), so the server knows this desktop is busy;
  - every 10 seconds otherwise;
  - while the server can't be reached: 10 s, 20 s, 40 s, 80 s, 160 s, then every 5 minutes. A change here doesn't hurry a retry;
  - paused (the versions differ) or unpaired by the server: a look every 5 minutes;
  - a change that happens while a round is under way gets one more round 2 seconds after it;
  - one round at a time: "Sync now" (`POST /api/cloud {op:"sync"}`) waits for a round under way, then runs (`round.ts`).
- **A round** is: sessions (leases first), then the graph log, then the small files (and, with Flashcards sync, the Flashcards library last).
- **The loop exists only in a paired desktop app.** `src/server/sync/autostart.ts` (loaded with the server barrel) starts it when a pairing file is there; pairing starts it too. No pairing file: no loop, no timer. It never runs on the cloud server, during a build, or in tests. `LH_SYNC_LOOP=off` turns it off (for runs that drive rounds by hand).
- **An idle pair writes nothing.** A round in which nothing changed rewrites no state file on either side (`stateFile.write` skips equal content). The server keeps "last heard from" in memory to the second and saves it about once a minute.
- **Pictures are sent once** (`src/core/sync/pictures.ts`). A session's pictures live in its chat file (`imageSnapshots`, each named by the SHA-256 of its bytes).
  - On the wire the chat travels without them, with a list of which picture sits where. The receiver puts the file back together from the pictures it already has, **byte for byte**.
  - Sending: the server answers `409 pictures_needed` with the ids it lacks; the desktop sends those (`PUT /api/sync/sessions/<id>/pictures/<picture>`, a big one in pieces of 8 MB of text, because one request holds at most 26 MB), then sends the session again. They wait in `<data>/sync/pictures/<chatId>/` until the session arrives.
  - Fetching: the desktop fetches the pictures it doesn't have, one request each.
  - A picture's bytes must match its name, on both sides. Only the session's holder (or the sender of a new session) may send one.
  - A chat file that isn't in the app's own formatting travels whole, as before.
  - On the desktop this is one wrapper around the request function (`pictures-transport.ts`); the rest of the sync code still sees whole files.
- **A server that lost its sync records** (its `sync/` folder deleted, or the data restored from a backup):
  - the graph and the small files notice (the log's name; `send_all`) and are combined afresh;
  - sessions: the server takes every session it has as its own again. A desktop that held one is refused at its next send, takes the server's version, and shows the discard notice if its own differed. Nothing is lost silently, and Take over gets the session back.
- **Tests:** `tests/sync-loop.test.ts` (the rhythm, with a simulated clock), `tests/sync-pictures.test.ts` (each picture travels once, in both directions, through a take-over, and a 17 MB one in pieces), `tests/sync-inert.test.ts` (an unpaired app and a server nobody paired with: no request, no timer, no file), and "a round in which nothing changed" in `tests/sync-sessions.test.ts`.
- **The full run** (two built copies, nobody pressing "sync"; a desktop copy with the test library, a session with two pictures and a vault folder; a server copy with one session, two concepts and its own settings):
  - before pairing: two libraries, no `sync/` folder on either side, the desktop's state `off`;
  - 0.6 s after pairing: all four sessions on both, every chat file identical (the 1.7 MB one with pictures too), 300 concepts on both, a backup made on each side, the vault's folder names on the server;
  - a rename on the desktop reached the server in 2.2 s; a setting changed on the server reached the desktop in 10 s, as did a concept deleted there;
  - the server asked for a session the online desktop held: handed over in 2 s; the server's rename reached the desktop in 2 s; the desktop's own rename was refused (409);
  - the server was stopped: the desktop showed `offline` within 2 s and kept working; 16 s after the server was back it had the rename made meanwhile;
  - at the end: chat files, ledgers, node places and sliders identical on both, and 30 idle seconds without a single file written.
- **Not verified here:** the real Windows app talking to the real server over the internet (the owner's choice was two copies only; that first happens after Phase 6 and the merge), and a reply being written while a round runs with a real model (the turn registry and the hand-over rule are tested with the real modules, without a model).

#### What the investigation found (for whoever builds it)

- **The approved table misses four things:**
  - `jobs/*.json`: a finished helper result lives only in its job file until it is delivered into the session (`delivery.status: "pending"`), so job files travel with the session's lease.
  - A fourth ledger rewrite: `mergeFindings` (`src/core/graph.ts`) ends with `simplifyChains` and `rewriteLedgers({ chains })`.
  - Background writers of the chat file: extraction (`appendExtractionUsage`) and the visual maker (`saveImageSnapshot`).
  - Three unlisted files: `graph/source-organization.json`, `graph/render-settings.json`, `prompts/**`.
- **Not everything goes through `stores`:** settings, prompt overrides and render settings are imported straight from `src/store` (`src/server/index.ts` and a few server files).
- **The turn gate is too late for a lease check:** in `handleChatInput`, `ensureCompacted` and the parallel-question branch write the chat record before `beginTurn`. The check belongs at the top of that function.
- **Helpers restart by themselves:** `recoverStaleJobs` (`src/server/jobs.ts`) respawns any job left `running` with no live worker. It must only do that on the lease holder.
- **Graph ids, folder ids and chat ids are all random,** so combining two libraries can't collide.
- **The login file parser drops unknown fields** (`parseServerAuthState`), and `reset-password` writes a fresh state. Paired devices stored there are cleared by a reset for free; stored anywhere else, the script must clear them.
- **Desktop shell:** quitting kills the local server at once (`killServer` in `electron/main.cjs`); there is no secure store in use (credentials are 0600 JSON files, and a test forbids `safeStorage`); a build opts out of updates with `lhAutoUpdate: false` in its packaged `package.json`.

- The open questions that were listed here are answered above.
- **Which branch builds the server image:** `.github/workflows/server-image.yml` lists the branches that build (`side-tutor` → `:latest`; `claude/pensive-goldberg-7dty2m` → `:dev`). A push to any other branch builds nothing, and the owner's server follows `:dev`. Keep working on that branch, or add the new branch's name to that list in the same change.
- **Where the engine attaches** (read these first):
  - `src/core/ports.ts`: the store interfaces (`ChatStore`, `GraphStore`, `SourceOrganizationStore`, `JobStore`, `SettingsStore`, `PromptOverrideStore`, `AuthStore`);
  - `src/server/stores.ts`: the composition root (`stores`), where wrapper stores go so upstream's store code stays untouched;
  - `src/store/*`: how each file is written today (whole-file rewrites, appends, read-modify-write maps), which decides how it can sync;
  - `src/core/graph.ts` and `src/core/graph-deletion.ts` (`rewriteLedgers`): the destructive graph changes that must sync as replayed operations;
  - `src/store/side-tutor.ts` and the notes home-folder records (`src/store/notes.ts`): the two fork files that follow a chat's lease;
  - `src/server/server-auth.ts` and `proxy.ts`: the login gate every new `/api/sync` route sits behind.
- **Build order in the plan page, all six built** (each with its tests, a run between two copies, and a commit and push):
  1. pairing codes, device keys, the sync API behind the login gate, and the protocol version check;
  2. sessions and leases: whole sessions with their side-tutor thread, notes home folder and job files, the read-only rule, new and deleted sessions, and the first sync (backup, then combine);
  3. take-over: the evidence rule, hand-over from an online holder, take-over from an offline one, the discard at reconnect, and the facts for the heads-up and the notice;
  4. the graph log: lines, repeated actions, the exact-result fallback, redoing unsent entries on top of fetched ones, and combining two graphs;
  5. settings and the other maps: the approved split, prompt overrides, render settings, chains-view folders, source records, positions, and the vault folder names;
  6. timing (2 s and 10 s, retries while offline), pictures sent once, a full two-copy run in browsers, and the docs.
- **The engine must do nothing where no desktop is paired.** Every push to this branch reaches the owner's real server at the nightly update, so a server with no paired device, and an app that isn't paired, must leave the data folder byte for byte as it is. A test pins this.
- **Phase 5 has no screens.** The owner sees nothing new until Phase 6; the thing to check after each update is that the server and phone work as before. The phase ended with a page of screenshots and timings from two copies syncing.
- **Sample data for UI screenshots:** copy `tests/fixtures/golden-data` to a scratch `LH_DATA_DIR`. Truncating a copy of the teaching chat right after a `quiz` tool call gives a session with an open question. Phone screenshots: Playwright `devices["iPhone 13"]`; real touch (press and hold, pinch) through CDP `Input.dispatchTouchEvent`.

### Phase 6, the sync screens (built)

**The plan was approved by the owner** after one question per decision and a plan page with a drawing of every screen. All three slices are built as written here. Change a decision or a sentence only with the owner's approval.

#### Phase 6 decisions (owner)

1. **Trying it:** pictures and recordings from two copies (one plays the PC, one the server). Nothing is installed on the owner's PC before the merge.
2. **An app that isn't paired** gets one new row in Settings, **Cloud**, under General. Nothing else changes: no chip, no strip, no request while Settings → Cloud is closed.
3. **The pairing form:** one form with a short how-to (address, code, this PC's name, one sentence on what pairing does).
4. **Paired:** the state, Sync now, and **Unpair this PC**.
5. **On the server's site:** its own **Cloud** row, between Obsidian and Account. Account is unchanged.
6. **The sync chip** (slice 3): at the foot of the session list, above Settings, **only when something is off**. An outline ring; ring and words in amber. It reads `OFFLINE`, `SYNC PAUSED` or `NOT PAIRED`. A click opens Settings → Cloud. Never on a PC that was never paired, never after the learner's own Unpair, never on the server's site or a phone.
7. **Names:** the form suggests **Desktop** for a PC. The server is called **the web app** ("Held by the web app").
8. **A held session** (slice 2): a strip under the top bar with the holder and **Take over**; no message box. The session list's second line reads "Held by Desktop" in place of the time.
9. **While an online holder hands over** (slice 2): the strip changes in place, with **Cancel**.
10. **The take-over warning** (slice 2): a confirm box with one wording; buttons Cancel and **Take over anyway** (red).
11. **The offline heads-up** (slice 3): the same strip under the top bar, for as long as it lasts; the message box stays.
12. **The discard notice** (slice 3): a box over the app, once, with OK.
13. **Controls that can't work on a held session** (slice 2) are shown greyed out, not hidden: the side tutor's bubble, Rename and Delete in the session's menu, the title's click-to-rename. Tooltip on a computer: "Take this session over first".
14. **How a strip appears and goes:** it fades and slides open from under the top bar over 200 ms (`cubic-bezier(0.2, 0.8, 0.2, 1)`, the message box's own easing), and closes the same way, so the lesson glides and nothing jumps. The message box fades over 150 ms. When a strip's words change in place they cross-fade over 150 ms. With reduced motion, at once. The owner chose it from three live demos.
15. **A second PC paired later** takes the server's settings (engine change 2).
16. **A prompt text only the server has** keeps its text with the switch off (as Phase 5 built it).
17. **After the learner's own Unpair** the PC may continue every session (engine change 4), and nothing reminds them to pair again.

#### The approved words

Kept in one place: `src/core/sync/screens.ts`. Change them only with the owner's approval. Quoted names take curly quotes, as in the notes drawer.

- **Desktop, Settings → Cloud, not paired.** Group "Cloud sync". "Keep this PC's sessions, graph and settings in step with your LearnHarness server." / "Server address" / "Pairing code" with "On the server's site: Settings → Cloud → Add a desktop app." / "This PC's name" (filled in: Desktop) with `Your other devices show it: “Held by Desktop”.` (the name follows what is typed) / "Pairing combines this PC's sessions with the server's. Nothing is deleted, and a backup is made first." / button **Pair** ("Pairing…" while it works). A refusal shows as a red line under the button, in the server's words (the Phase 5 list under slice 1).
- **Pairing again with the same server** replaces the "Nothing is deleted" sentence with: "This PC was paired with this server before. Where a session was continued on both sides since, the server's version is kept and what this PC added is discarded. A backup is made first."
- **Desktop, paired.** "Up to date" / "Starting…" / "Syncing…" (during Sync now) / "Can't reach the server. Trying again." / "Update the server to continue syncing" / "Update LearnHarness to continue syncing". "Last synced just now", "… 2 minutes ago", then "… today, 14:02" or "… 9 Nov, 18:20". Rows "Server" and "This PC". Buttons **Sync now** and **Unpair this PC**; the confirm line: "Syncing stops. Nothing on this PC is deleted, and every session can be continued here." with **Unpair this PC** (red) and Cancel.
- **Removed by the server:** "This PC is no longer paired." above the pairing form, which has the address and the name filled in.
- **Unpaired without a connection:** `The server couldn't be told. Remove “Desktop” there too: Settings → Cloud.`
- **Server, Settings → Cloud.** Group "Desktop apps". Each PC: its name, "Paired 12 Nov · online now" or "Paired 3 Nov · last seen 9 Nov, 18:20", **Remove**. Remove's confirm line: `“Desktop” stops syncing. Nothing on that PC is deleted.` with **Remove** (red) and Cancel. "No desktop app is paired." / **Add a desktop app** / "Pairing code" with "Works once, for 9:41" / "Server address" / "In the desktop app, open Settings → Cloud and enter both." / **New code**, **Done** / "This code has run out."
- **Slice 2, the strip.** "Held by Desktop" (the server's site and phone add " · online" or " · offline since today, 14:02"; a desktop app knows only the name). Waiting: "Asking Desktop to hand it over…" and "Desktop is finishing a reply. This session moves here when it's done." (with "the web app" as the holder: "Asking the web app to hand it over…", "The web app is finishing a reply. …"). A failure: "Couldn't take it over. Try again." On a PC that can't reach the server, Take over is off and the strip adds "This PC can't reach the server, so it can't be taken over right now."
- **Slice 2, the warning box.** Title `Take over “Circuits”?` / "Desktop has been offline since today, 14:02, and may have turns that never reached the server. If you take over, those turns are discarded when Desktop is back online." / Cancel, **Take over anyway**.
- **Slice 3, the offline strip.** "This PC can't reach the server. If this session is taken over on another device before it reconnects, what you add here now is discarded." Paused: "Sync is paused. If this session is taken over on another device before sync is back, what you add here now is discarded." Removed by the server: "This PC isn't paired any more. If this session is taken over on another device before you pair again, what you add here now is discarded." (The owner changed the Settings line to "is no longer paired" and has been told this strip still reads "isn't paired any more"; they haven't asked for it to match.)
- **Slice 3, the discard box.** Title `“Circuits” was taken over` / "It was taken over on another device while this PC was offline. 3 messages you sent here never reached the server and were discarded. The session now shows the server's version." / OK. One message: "1 message you sent here never reached the server and was discarded." None, but another change: "Changes made here that hadn't reached the server were discarded." Several sessions: one box titled "Sessions were taken over", one line each.

#### Smaller rules (proposed in the plan page, approved with it)

- **After the learner's own Unpair, nothing nags:** no chip, no "no longer paired" strip. Both appear only when the PC was removed from the server's side.
- **Quiet for short blips** (slice 3): the chip and the offline strip appear once the PC has failed to reach the server for 30 seconds; at once if the app starts with no connection.
- **The offline strip shows in every session the PC can continue** (slice 3), also one created while offline that nobody could take over. Telling those apart needs one more fact from the engine; the owner was told and hasn't asked for it.
- **After a take-over** the strip goes, the message box and the greyed controls come back, and nothing else is announced.
- **If the side tutor's window is open** when a session becomes held, it closes to its greyed bubble.
- **Practice sessions** get the same strips as teaching sessions.
- **An open question's box** goes away with the message box on a held session, and so do the model and thinking pickers.
- **Take over** asks again every 2 seconds while it waits; Cancel stops asking and the holder keeps the session.
- **A PC removed on the server's site** that still holds sessions: they stay "Held by Desktop", offline, and can be taken over from the phone. The server remembers the name of every PC it heard from (`names` in `<data>/sync/authority.json`), because the login file forgets a removed PC.
- **How the pages stay current:** the app's live channel (`/api/events`), plus one check every 10 seconds, only where the marker says sync is in use.

#### Engine changes made for Phase 6 (the owner was told before each)

1. **A PC can remove itself.** `POST /api/sync/unpair` (a paired desktop's key): the server removes the device and takes the sessions it held as its own (`releaseDevice` in `authority.ts`). No protocol check, so a PC can leave a server it no longer speaks to.
2. **Only the first PC brings its settings** ("Slice 5" above; `later` in `maps-sync.ts`).
3. **A marker that sync is in use.** The proxy sets a plain `lh_cloud=1` cookie (`SYNC_MARKER_COOKIE`) when `syncInUse()` says so, and takes it away when not:
   - a PC: it has a pairing file and the learner didn't unpair it here;
   - the server: a desktop is paired, or one has ever synced (a removed PC can still hold sessions).
   - Pages read it with `components/cloud/sync-marker.ts` (`useSyncInUse`). Settings → Cloud announces a pairing or an unpairing in the page (`SYNC_MARKER_EVENT`), because the cookie itself only follows at the app's next request. Slices 2 and 3 hang every request about sync on this marker, so an app that was never paired asks nothing.
4. **After the learner's own Unpair, the PC may continue every session** (it changes the Phase 5 rule that kept other devices' sessions read-only on an unpaired PC). `src/server/sync/unpair.ts`, `release()` and `settleFreed()` in `desktop-sync.ts`:
   - **Unpair:** one last round (when the server can be reached), then the server is told, then every session's record on the PC is marked its own, remembering whose it was (`freed: "mine" | "held"`). The pairing file keeps the address, name and device id, with `key: null` and `unpairedHere: true`. The loop stops, and doesn't start again at the next app start. The state reads `unpaired`.
   - **It works offline:** the PC forgets its key; `told` is false and the screen says the server couldn't be told.
   - **Paired again as the same device** (same server address): a fresh backup is made before the first round (`rejoin()`), then each freed session is settled once:
     - not continued on the PC since: it is whose it was, and the usual round hears of anything that happened to it;
     - continued on the PC only (the server's copy is still what the PC last synced): the PC asks for it back, without force, and sends its version. If another desktop is busy with it, the PC keeps its turns and asks again each round;
     - continued on both sides: the server's version stays (no copies), with a discard notice;
     - deleted on the server meanwhile: it goes on the PC too.
   - **A PC the server removed** (`needs-pairing`) keeps the Phase 5 behaviour: nothing is freed.
5. **Read-only additions to the status.** `GET /api/cloud` on the server now also returns `desktops` (id, name, pairedAt, online, lastSeenAt), from `presence()` in `authority.ts`, which knows "last heard from" to the second. A new sync state, `unpaired`, beside `needs-pairing`.

6. **Since when the server can't be reached** (slice 3). `sync.offlineSince` in `GET /api/cloud` on a desktop: the time of the first failed attempt of the current offline spell, null otherwise (`wentOffline` in `client.ts`). The 30-second quiet rule counts from it. `sync.lastContactAt` is null until the app has reached the server once since it started, which is how "started with no connection" is told.
7. **A signal when the sync state changes** (slice 3). `announceCloudState()` in `round.ts` sends `cloud-changed` on the live channel after a round, a check or a dismissed notice, when the state, the start of the offline spell or the number of notices differs from what was last said. Nothing is sent by an app that isn't paired.

The sync protocol version stayed at 1 for these changes: nothing had been paired anywhere yet. (It is 2 from the upstream 0.6.0 merge on, and 3 with Flashcards sync.)

#### Slice 1: what is built

- **Desktop:** `components/settings/cloud-section.tsx`. An unpaired PC asks its own server once, when the section opens; a paired one looks again every 5 seconds while the section is open. After a pairing or an unpairing it tells the page (`announceSyncInUse`).
- **Server:** `components/settings/cloud-server-section.tsx`. The list is read from `GET /api/cloud`; it is checked every 3 seconds while a code is on screen (so a PC that pairs appears and the code box closes by itself) and every 10 seconds otherwise. The code and Remove go to `POST /api/server-auth/desktops`.
- **Wiring:** `components/settings/settings-dialog.tsx` (one `cloud` row; the server's site renders the server section under it, everything else the desktop's).
- **Wording added while building, beyond the plan page, for the owner to review:** "Cloud sync couldn't be checked. Try again." with **Check again** (the app's own server didn't answer), and "Something went wrong. Try again." where a request fails with no reason (the app's usual line).
- **Read while building:** the line under the name box follows what is typed ("Held by Laptop"), where the plan's drawing showed it with the suggested name only.
- **Tests:** `tests/cloud-ui.test.tsx` (both screens in every state, with the approved words, and the Settings rows), `tests/sync-unpair.test.ts` (Unpair, the server's side of it, pairing again, the marker), new cases in `tests/sync-maps.test.ts` (a PC paired later), and the marker's absence in `tests/sync-inert.test.ts`.
- **Run between two built copies** in a browser, at computer and phone size: pairing, the first sync, Sync now, Unpair, pairing again, Remove on the server, a code running out.

#### Slice 2: what is built

- **What the pages know** (`components/cloud/cloud-state.tsx`): one `CloudProvider` in the root layout reads `GET /api/cloud` **only where the marker says sync is in use**: at start, on `chats-changed`, on the new `cloud-changed` event, when the live channel reconnects, and every 10 seconds. `useCloud()` gives `role`, `held`, `sync`, `notices` and `refresh`; `useSessionHolder(chatId)` gives one session's holder, or null. An app that was never paired asks nothing (a test pins it).
- **`cloud-changed`** is a new event on the live channel (`src/core/events.ts`), sent after a pairing and an unpairing (`cloud-http.ts`). Slice 3 sends it when the sync state changes too.
- **The session list** (`components/sidebar.tsx`): a held session's second line reads "Held by Desktop" in place of the time. In its menu, Rename and Delete are greyed out with the tooltip; the other items work.
- **The strip** (`components/cloud/session-strip.tsx`, mounted under the top bar in `components/chat.tsx`): always in the page, closed and `inert` while there is nothing to say, so opening and closing can be animated. Its states: held (with **Take over**), asking, waiting for a reply or a hand-over (with **Cancel**), failed.
  - Take over sends `POST /api/cloud {op:"take-over", chatId, force:false}`; while the answer is `waiting` it asks again every 2 seconds; `warning` opens the box; `moved` or `yours` re-reads the state, and the strip goes when the session is no longer in `held`.
  - **The warning box** is `components/cloud/take-over-dialog.tsx`. **Take over anyway** sends the same request with `force: true`.
  - On a PC that can't ask the server, Take over is off and a second line says why.
- **The motion** is in `app/cloud.css` (fork-owned, like `phone.css`): the strip's row opens from 0 to its height with a fade over 200 ms, its words fade in over 150 ms when they change, and the message box's block (`.lh-held-dock`) fades over 150 ms and is `inert` while hidden. All at once with reduced motion.
- **In the lesson** (`components/chat.tsx`): the whole dock (message box, an open question, model and thinking pickers) goes on a held session. The title can't be clicked to rename, and F2 does nothing; its tooltip reads "Take this session over first".
- **The side tutor** (`components/side-tutor.tsx`, prop `held`): an open window closes to the bubble; the bubble is greyed out, has the tooltip and ignores a click. With the dock gone it can't sit against the question bar, so it sits at the lesson's bottom right (16 px in, 20 px up), where it is with a one-line message box.
- **Wording added while building, beyond the plan page, for the owner to review:**
  - "another device" as the holder's name when a PC's name isn't known ("Held by another device");
  - the second line when a PC can't take over for a reason other than being offline: "Sync is paused, so it can't be taken over right now." and "This PC is no longer paired, so it can't be taken over right now.";
  - "Desktop is offline and may have turns …" in the warning when the server has no time for the holder.
- **Read while building:**
  - Times follow the device's own format, as in Settings → Obsidian: "offline since today, 14:02" or "… today, 2:02 PM".
  - The title on a held session looks as usual (it isn't greyed); it just can't be clicked.
  - The folder a held session is in can still be changed, and the notes drawer works, as decided in Phase 5.
- **Tests:** `tests/cloud-held-ui.test.tsx` (the words, the provider asking nothing where sync isn't in use, the list line, every state of the strip, the warning box, Cancel), a held session in `tests/side-tutor-ui.test.tsx`, and a removed PC keeping its name in `tests/sync-unpair.test.ts`.
- **Run between two built copies** with the loop on, at computer and phone size: the list lines and the strip on the server's site; the greyed bubble and menu items; a rename refused; a hand-over from the online PC (6.6 s: the PC hears of it at its next 10-second check); the PC showing "Held by the web app" and taking it back (0.3 s); the PC stopped, "offline since …" after 30 seconds, the warning box, Take over anyway, and the PC showing the server's version when it came back.

#### Slice 3: what is built

- **What is off** (`syncTroubleDueIn` and `syncTrouble` in `src/core/sync/screens.ts`, `useSyncTrouble()` in `cloud-state.tsx`): `offline`, `paused` or `needs-pairing`; nothing for `ok`, `starting`, `unpaired` and `off`, and nothing on the server's site. Paused and removed show at once. Offline shows 30 seconds after the first failed attempt (`OFFLINE_QUIET_MS`), or at once when the app hasn't reached the server since it started. The hook sets one timer for the moment the 30 seconds are up.
- **The sync chip** (`components/cloud/sync-chip.tsx`, mounted in `components/sidebar.tsx` between Background agents and Settings): an outline ring (lucide's `CircleIcon`, the Settings gear's weight) and the word, both `text-amber-500`, in the Settings row's own type. A click opens Settings → Cloud. It goes the moment a round reaches the server again.
- **The offline heads-up** is one more state of the strip (`session-strip.tsx`, `data-strip="sync-offline"`, `sync-paused` or `sync-needs-pairing`): the approved sentence and no button, in a session this PC can continue. The message box stays. A held session keeps its own strip.
- **The side tutor's window may cover the strip** (owner's decision). The tutor's window opens at the lesson's top right by default, 12 px under the top bar, which is where a strip opens, so at its default place it covers the end of the heads-up. (Since the upstream 0.6.0 merge the tutor starts minimized; this is about the window once opened.) A version that moved the window below an open strip was built and removed at the owner's word: "it's fine for the tutor window to be able to cover the strip".
- **The discard box** (`components/cloud/discard-notice.tsx`, mounted once in the root layout): reads `notices`, so it shows on any screen as soon as a round discards something, or at the next app start. **Only OK closes it**: Esc and a click outside do nothing, so it can't be lost by accident. OK sends `dismiss-notice` for every notice shown; they stay away at once and don't come back.
- **A lesson opened in the same moment as the app's first round** (found in the browser run): the page is rendered from the session as it was, the round then replaces it, and the page isn't listening yet when that is announced. The live channel also has no first frame, so its "open" can come late. Where sync is in use, `components/chat.tsx` reads the record once more a second after a lesson opens (`SYNC_CATCH_UP_MS`) and after every reconnect of the channel, unless a reply is being written. An app that isn't paired asks nothing more than before.
- **Wording added while building, beyond the plan page, for the owner to review:**
  - several sessions in one box: "They were taken over on another device while this PC was offline." above the lines, each line `“Circuits”: 3 messages you sent here never reached the server and were discarded.`, and "The sessions now show the server's version." below;
  - "Untitled session" for a discarded session with no title.
- **Read while building:**
  - The discard sentence says "while this PC was offline" also when the discard comes from pairing again after an Unpair (both sides had continued the session). The owner hasn't been asked for a second wording.
  - The chip's words are stored as "Offline", "Sync paused" and "Not paired" and shown in capitals by the row's style.
- **Tests:** `tests/cloud-notices-ui.test.tsx` (the words, the quiet rule with a moved clock, the chip in every state and where it never shows, the heads-up, the discard box), and `offlineSince` and the signal in `tests/sync-pairing.test.ts`.
- **Run between two built copies** with the loop on:
  - never paired: no chip, no strip, no marker;
  - the server stopped while a lesson was open: nothing for the first 30 seconds, then the chip and the heads-up (30 to 40 s after the stop, depending on where in its 10-second rhythm the PC was); the same strip in a practice session; the chip alone on the home screen; a click opening Settings → Cloud on "Can't reach the server. Trying again.";
  - the app started with the server away: the chip at once;
  - the server back: the chip and the strip gone 7 s later;
  - the PC stopped, three messages added to its copy, the session taken over on the server, the PC started: the box with "3 messages …", still there after Esc and a click outside, gone for good after OK;
  - two sessions at once: one box, one line each;
  - Remove on the server's site: NOT PAIRED within 10 s;
  - the learner's own Unpair: no chip and no strip.
- **Not seen in a browser:** SYNC PAUSED (two copies of one build always speak the same protocol version); it is covered by the unit tests.

#### The wrap-up run

One run between two built copies with the loop on, through the real screens, nobody pressing "Sync now", with a computer-size page of each copy and a phone-size page of the server:

- before pairing, 12 seconds on a lesson: no request to `/api/cloud` from either side, no chip, no strip, no `sync/` folder;
- Pair pressed in Settings → Cloud: both sessions identical on the server 0.4 s later;
- Take over tapped on the phone: moved after 4.7 s, and the PC's open lesson showed "Held by the web app" by itself; taken back on the PC in 0.2 s, and the phone's strip returned by itself;
- 30 idle seconds with three pages open: the PC wrote no file; the server wrote `sync/authority.json` once (its once-a-minute save of "last heard from");
- the server stopped: chip and heads-up after 37 s; started again: both gone 37 s later;
- the PC stopped with three unsent messages, the session taken over on the server, the PC started: the discard box, with the lesson behind it showing the server's version;
- Unpair this PC: no chip, no strip, the message box back, and the server listing no desktop app.

**How long the chip stays after the connection is back:** until the PC's next retry, and the retries slow down while offline (10 s, 20 s, 40 s … up to every 5 minutes; Phase 5, decision 11). After a long spell offline that can be 5 minutes. **Sync now** in Settings → Cloud, where the chip leads, ends the wait at once. The owner has been told; no change was asked for.

#### Still to do

- Nothing for Phase 6: the owner's real PC is paired with the real server and they reported that everything works.
- Phase 7 (not started; the owner starts it).

### Flashcards sync (built and shipped)

- **State:** built on `claude/upstream-0.6.0`, together with the phone plugins round ("Plugins on a phone" under "Phone layouts"), and fixed after a review in three passes ("The review of the wiring, and its fixes" below). **Shipped** to both branches; where it stands is "After the merge (read this first)" under "Handoff".
- **Why:** the owner added it while answering the phone plan's questions: decks made in the Windows app should be on the phone, so **sync Flashcards between the Windows app and the server in this round**.
- **The plan** is `docs/phone-plugins-plan.md` ("Flashcards sync": decisions S1–S6 and the smaller rules), approved by the owner. Change a decision only with the owner's approval.
- It replaces decision 17 of the 0.6.0 merge ("plugin data is per device") for Flashcards' library only. Every other plugin's data, and which plugins are on, stay per device.
- **The sessions' rules don't apply here:** no lease, no Take over, no held state, nothing discarded.

#### Flashcards sync decisions (owner)

1. **S1, how: combine everything.** Every change travels on its own; every review from both devices is kept; each fact's schedule is worked out again from all its reviews.
2. **S2, time zone: the server follows the PC.** The Windows app tells the server its time zone with a sync, and the server program uses it from then on.
3. **S3, the first sync: combine both libraries.** Nothing is deleted. A fresh backup on each side first.
4. **S4, two decks from the same session: joined into one deck.**
5. **S5, edited on one device, deleted on the other: a delete always wins.**
6. **S6, settings:** the four scheduling settings and the generation chunk budget sync; the model choice stays per device.

The smaller rules approved with them (what travels, schedules never travel, order, timing, the backup, protocol 3, the one edit to the plugin's code, the known limits) are in the plan; what was built for each is below.

#### Rulings made while building (for the owner to review)

- **A PC with no Flashcards file brings no settings** at its first Flashcards sync: the server's stay. The Flashcards exchange doesn't reset settings a PC didn't send (`resetUnsentSettings: false` in `FLASHCARDS_RULES`), where the app's settings exchange puts a first PC's unset settings back to their defaults.
- **A device with a generation batch under way holds its Flashcards exchange:** a batch `running` or `cancelling`, while the plugin is on. The server answers 409 `busy` and the PC tries again next round; a PC with its own batch under way sends nothing. Sessions, graph and settings go on. A switched-off plugin is never busy.
- **How "a delete always wins" reads for decks and facts:**
  - a fact deleted on one device while the other added a new card to it survives, with the new card;
  - a deck deleted on one device but given a card on the other is a normal deck again;
  - which decks a fact is in combines (one item per fact and deck, since the review's fixes; "The items" below). The first ruling here, "one item per fact, the later change wins whole", is replaced;
  - a joined twin deck can undercount that day's new cards (reviews keep the deck id they were recorded under).
- **Schedules are worked out again when the zone changes.** When the server takes a zone it didn't keep or run in, it rebuilds every schedule in that zone; the PC does the same when it sends its zone (its first exchange, or after it moved). Without that, a review made in the old zone kept that zone's due date on one side only (found in the two-copy run). The cost: at the first sync, due dates of facts reviewed in the other zone can move by up to a day. With two PCs in different zones, the one not counted keeps its own zone's schedules. The owner has been told.
- **A side with no Flashcards folder** makes no backup folder and counts as backed up.
- **Made while fixing the review's findings** (for the owner's review; the owner was told in chat):
  - **the same-question rule** reads as "only a pair that meets from two devices": two cards with the same question on one fact, one from each device, lose the later one; two cards one device made are both kept ("The items" below);
  - **a fact taken out of every deck stays in the deck it was put in last** that isn't deleted; **if every one of its decks is deleted, the last one stays as a deck** (a fact is never left in no deck, and is never dropped);
  - **a generation that shows no progress for 15 minutes holds the exchange no longer.**
- **Made while fixing the second pass's findings** (for the owner's review):
  - **the watcher's timing:** this side's own changes are noted 20 s after the last one, at most 50 s after the first not yet noted ("Noting this side's own changes" below);
  - **a server that lost its memory takes the first PC's values:** it starts its table afresh, each PC is told `send_all`, and the first desktop to send counts as the first.

#### What travels, and what stays per device

- **Travels:** decks (name, daily new-card limit, order), facts and their cards (question, answer, order), which decks each fact is in, every review, the four scheduling settings (`retention`, `learningSteps`, `relearningSteps`, `dayStart`) and the chunk budget (`chunkBudget`), and the record of each uploaded file (its name and fingerprint, so the same file doesn't become a second deck).
- **Per device, never synced:** the model and thinking choice, generation batches and their retry, the text of uploaded files, the cost log, creation and deletion receipts, and the file's `revision`. A fact's `version` rises only where the fact really changed, so a review open elsewhere stays valid.
- **Schedules never travel.** After every exchange each device works each fact's schedule out again from the combined reviews (below).
- **A device where Flashcards is switched off** still receives the data (the file is written with the plugin off or never started), so it is there when the plugin is switched on.
- **A generation under way** finishes on its device; its cards travel once they are added.

#### The items (`src/core/sync/flashcards-items.ts`)

- Every key is `<kind>|<id>`, and each item travels on its own, latest change wins, through the same per-item exchange as the settings (slice 5):
  - `s|<setting>` the five synced settings;
  - `d|<deck>` a deck `{name, newLimit, sourceId?, s, at}`; `x|<deck>` a deck was deleted;
  - `o|decks` the deck order; `q|<deck>` the order of the facts in a deck;
  - `p|<fact>` a fact `{origin, name, statement, snapshot?, sourceId?, created}`; `e|<fact>` when the fact was deleted; `m|<deck>|<fact>` the fact in that deck, or taken out of it: `{in, s}`;
  - `c|<card>` a card `{p, q, a, s}`; `k|<card>` a card was deleted; `u|<fact>` the order of a fact's cards;
  - `r|<review>` one review, never changed: `{p, c, rating, at, deckIds, settings}`;
  - `f|<file>` an uploaded file's record `{name, fingerprint, deckId}`.
- **Nothing is deleted by a missing item.** Deletions are items of their own (`x`, `k`, `e`), so latest-change-wins only ever chooses between two values. A per-device memory tells "deleted here" from "never had it": the plugin's file keeps no record of what it deleted ("The memory" under "The wiring").
- **A card's deletion is final:** `k` is never taken back, whatever was edited later.
- **A fact deleted and made again starts fresh:** `e` says from when its reviews count. A fact is alive while it has a card. Its moment of making (`created`) travels, so a fact nobody has reviewed yet has the same schedule everywhere.
  - **An inferred `e`:** only for a fact this device's sync has never seen (no memory, or no `p|<fact>` in it), and only from what the file itself counted: just before its first counted review (`firstReviewedAt − 1`), or the latest review's time when it counted none. Never from `created`: a fact made on both devices keeps one `created`, and the other device's earlier reviews must still count.
- **Order items exist only after a real reorder.** Members an order doesn't know follow it by stamp, then id, so the later reorder wins and anything it doesn't know comes after.
- **Twin decks** (S4): two decks from the same session or source (`sourceId`), or made from the same uploaded file (fingerprint), are joined. The earliest made stays; name and limit come from the most recently changed.
- **Membership combines** (one item per fact and deck): a fact put into a deck on each side is in both decks afterwards; taking it out of a deck (`{in: false}`) travels like any change. A fact taken out of every deck it was in stays in the one it was put in last that isn't deleted; if every one of its decks is deleted, the one it was put in last, which then stays as a deck.
- **The same question, word for word after trimming, twice on one fact:** only a pair whose cards came from different devices loses one, the later (`duplicateDeletions`). It is decided by the side that takes in the second card, from what it knows the sender had. Two cards one device made are both kept, there and everywhere.
  - On the server, "the sender had it" also covers keys the PC sends in this exchange, its earlier pages included, so a card the server took from a PC whose answer was lost still counts as that PC's.
  - The PC runs the same check, but every card it holds was agreed with the server or sent in that exchange, so in practice only the server decides a pair.
- **A review item leaves out** `before`, `after` and `introduced` (worked out again), `requestId` and `ticketId` (local), and the model fields of its settings copy.

#### The replay (`src/core/sync/flashcards-replay.ts`)

- Each fact's schedule is worked out again from its counted reviews, in the order they were made, with the plugin's own scheduler (`plugins/flashcards/src/scheduler.cjs`) and the settings copy each review recorded. A new fact starts from the plugin's schedule for the moment it was made.
- Pure: the scheduler is passed in and no clock is read. It runs in the process's own time zone (S2 below).
- **It reproduces the plugin's own file byte for byte** on single-device histories: 40 days of reviews with all four ratings, lapses, learning and relearning steps and settings changed along the way; a card deleted; a fact deleted and made again (`tests/sync-flashcards-replay.test.ts`).

#### The wiring

- **The route:** `POST /api/sync/flashcards`, behind the device key like every `/api/sync/*` path.
  - Request `{cursor, all, changes: [{key, value, t}], more?: true, timeZone?}`; answer `{cursor, items: [{key, value | same: true, t}], time, more?: true}`.
  - Refusals: 409 `send_all` (send everything once), `busy`, `flashcards_failed` (the server couldn't take it this time; tried again next round); 400 when the changes didn't arrive whole.
- **A second instance of the per-item exchange:** `createMapsAuthority` / `createMapsDesktop` (`src/server/sync/maps-sync.ts`) take optional `rules` and options (`busy`, `makeBackup`, the time zone). Both sides now work on a copy of their state (`structuredClone`), agreed only once it is in the files. The settings exchange keeps its rules (`MAP_RULES`).
- **Paged both ways:** at most 5,000 items or about 4 MB a page (`PAGE_ITEMS`, `PAGE_BYTES`). The desktop takes what arrived once, after the last page.
- **No time before 1970:** a desktop clamps a change's time to 0, and the server takes a negative time as 0 instead of refusing the page, in both exchanges (Flashcards' and the settings'); a time that isn't a number (NaN) is still refused. Before, a PC whose clock was ahead of the server's, with a library put back (items timed 0, minus its clock offset), was refused every round (400) and never synced Flashcards again.
- **Cached:** the parsed library by its file's stamp (inode, size and times), and the items with their fingerprints by the file's stamp plus the memory's. **An idle round reads no Flashcards file and writes nothing.**
- **Apply is one synchronous step**, with nothing awaited between reading and writing (`src/server/sync/flashcards-files.ts`): read the file again, combine (`applyFlashcardsChanges`, with the plugin's own scheduler), write the file whole (a temporary file renamed over it, as the plugin writes), save the memory (after the file: a memory ahead of its file would read as deletions), then tell open pages: `plugin-message {pluginId: "flashcards", topic: "changed", data: {by: "sync"}}`. The loop doesn't take a notice "by sync" for a change made here.
- **The format lock:** a file whose `version` isn't the one this build reads (`FLASHCARDS_FORMAT`, 1), or that isn't the plugin's shape, is neither sent nor taken, and never written over. No message on screen.
- **A library that can't be read** (the format lock, or a damaged file):
  - on the PC: no request and nothing written that round;
  - on the server: the exchange answers 409 `locked`, and the PC then sends only a cheap `{probe: true}` each round until the server can read again. The server's backup isn't made again;
  - no cursor moves past a kind that can't be read, so nothing the other side has is passed over (the settings exchange follows the same rule).
- **The memory,** each side's own: `sync/flashcards-memory.json` (`{version: 1, items}`) and `sync/flashcards-memory-reviews.json` (`{version: 1, reviews, revision}`: the review ids, and the library's `revision` it was made from). The library is always written before the memory.
  - **Records lost** means no memory while the library can be read (also a memory cut between its two files: the reviews file missing), or a library that doesn't follow its memory (`followsMemory`: a lower `revision`, or a review the memory saw is gone; the plugin only ever raises the revision and never removes a review). Then nothing missing counts as deleted, everything is combined again, and for a library that doesn't follow its memory the log says so once.
  - **Every item is then timed 0**, lost memory and library put back alike, so the other side's values stand where both have an item and only what is here alone is added. A lost memory used to time items with the file's modified time.
  - On the server a lost memory still starts its table afresh (each PC is told `send_all`, and the first desktop's values win); a PC sends everything again.
- **Restoring a backup** (the first-sync one or the Flashcards one): nothing is deleted on the other side. Decks deleted after the backup can come back as decks; their cards stay deleted.
- **The round** (`src/server/sync/round.ts`): Flashcards is its last part, after the settings, in its own try/catch, so a failure there leaves the rest syncing. While the server can't be reached, its changes are still noted with their times (`detect()`), as for the settings. The loop's 2-second trigger fires on Flashcards' own `changed` and `batch-changed` notices (`flashcardsChanged` in `loop.ts`).
- **State files** under `<data>/sync/`, each side's own and never synced: on the server `flashcards.json` and `time-zone.json`; on a PC `flashcards-desktop.json`; on both `flashcards-memory.json` and `flashcards-memory-reviews.json` ("The memory" above).
- **The backup:** `backups/before-first-flashcards-sync <date>/core-plugin-data/flashcards/`, once per side, before anything the exchange writes (`makeFlashcardsBackup` in `src/store/sync/backup.ts`). If it can't be made, the Flashcards part of the round fails and the rest syncs. It, and the first-sync backup, also keep Flashcards sync's own files under `sync/` when they exist (the memory and the exchange's state), so a library restored with them is whole.
- **Noting this side's own changes** (`watchFlashcardsChanges` in `flashcards-engine.ts`): each side notes its own Flashcards changes with their time, also with nobody connected, **20 s after the last change and at most 50 s after the first one not yet noted** (`WATCH_QUIET_MS`, `WATCH_CEILING_MS`). Only once `sync/flashcards.json` (the server) or the PC's state exists, and on a PC only while it is paired; nothing on an unpaired side, and an idle side writes nothing. It runs while a generation holds the exchange too. Without it the server timed its own changes when a PC next asked, so an older phone edit could beat a newer PC edit.
  - **On the server** (started in `autostart.ts`) it skips when an exchange has looked at the files since the newest change it is noting (a change made after that exchange, in the same wait, is still noted), and it leaves reviews (`r|`, `ExchangeRules.untimed`: they never change, so their time decides nothing) to the next exchange, so a review-only session rewrites no table.
  - **On a PC** (started with its loop) the same timing; its noting has neither skip.
  - The loop's 2-second sync trigger on the plugin's notices is unchanged; only the noting moved.
- **A generation holding the exchange:** while it does, its notices start no round; the one after it ends does. The hold ends after 15 minutes with no change to the active batches (`BUSY_HOLD_MAX_MS`), with a log line.
- **Two PCs:** a desktop counts as later (it takes the server's values) when another has done its first exchange or is part-way through it, in pages. Both exchanges follow this.
- **The time zone** (S2; `src/server/sync/flashcards-zone.ts`):
  - the PC sends its IANA zone name on the first page whenever it differs from the last one it sent;
  - the server checks the name, puts it in its standard form, stores `{version: 1, zone, from, at}` in `time-zone.json`, and sets `process.env.TZ` at once. It checks the zone took effect; if not, it keeps the one it had (a log line). It takes a zone only after its backup, and not while it is busy;
  - the PC works its schedules out again once per zone, also while the server keeps answering busy;
  - at every start it sets it again before the plugins start (`instrumentation.ts`, server mode only). Nothing is set on a server no desktop ever gave a zone to;
  - with two PCs in different zones, the most recently changed one counts;
  - checked on Node 22 and Node 26: `Date`'s local getters, `Intl`'s default zone and the plugin's study day follow.
- **Unpair and pairing again:** the Flashcards state is kept on both sides, like the settings state. The same server carries on; a different server starts afresh, with a new backup.
- **An app that isn't paired** makes no Flashcards request and writes no Flashcards sync file (`tests/sync-inert.test.ts`).

#### The review of the wiring, and its fixes

A reviewer read the sync part. It found six serious issues, each reproduced by a script, all fixed before anything shipped (`97fe7ee`); lower ones were fixed too. A second and a third pass by the same reviewer followed (below).

1. **Putting the first-sync backup back** made sync read the missing cards as deletions and delete them everywhere. Now a library that doesn't follow its memory counts as "records lost", and nothing missing counts as deleted ("The memory" above).
2. **A fact deleted and generated again before a device's first sync** had its schedule rebuilt from the old reviews. Now an `e` is set at the first read.
3. **A library that can't be read** (the format lock, damaged) made the PC download everything every round and the server back up every round. Now: no request, nothing written, no cursor moved, `locked` and a probe.
4. **Seconds-long stalls of the server's process** with a 25 MB library. Now tables are copied only on the first change, an idle exchange skips the walk of its table, an apply starts from the last read and leaves its own result as the next read, and fingerprints are kept while a value is the same (a review's for good).
5. **The server timed its own changes when a PC next asked**, so an older phone edit could beat a newer PC edit. Now each side notes its own changes a little after the plugin's notice (about 2 seconds then; 20 to 50 s since the second pass).
6. **Two PCs whose first exchanges overlapped** were both "first". Now one part-way through counts too.

Also changed then: deck membership as one item per fact and deck, which combines; the same-question rule for pairs from two devices only; the 15-minute end of a generation's hold, and no rounds from its notices; zone names in their standard form and checked after they are set; one rebuild per zone on the PC.

**The second pass**, by the same reviewer over those fixes, found six more, all fixed (`5e3f9a8`):

1. **A PC whose clock was ahead of the server's, with a library put back**, sent times before 1970 and was refused every round: it never synced Flashcards again. Now times are clamped to 0 on both sides.
2. **A fact made on both devices** lost the other device's earlier reviews at a later read (the `e` was inferred from `created`). Now it is inferred only for a fact sync has never seen here, from what the file counted.
3. **A lost memory** timed items with the file's modified time, so they could beat newer values on the other side. Now every item is timed 0, as for a library put back; a memory cut between its two files counts as lost.
4. **A card the server took from a PC whose answer was lost** could be paired with the PC's next same-question card. Now the server counts what the PC is sending in this exchange as the PC's.
5. **The server's own noting** ran 2 s after a notice, noted reviews too and didn't run while a generation held the exchange. Now 20 s after the last change, at most 50 s after the first, skipped after an exchange, reviews left to the exchange, and also while a generation holds it.
6. **The fallback for a fact taken out of every deck** now looks at deleted decks: the last deck it was put in that isn't deleted; if all are, the last one, which stays as a deck, so the fact is never dropped.

**The third pass**, over those six: all fixed, nothing found that loses, brings back or double-counts a card or a review, and the reviewer's word was to ship. It found one new, narrow gap, fixed before shipping:

- the server's noting skipped whenever an exchange had looked since the *first* change of its wait, so a phone change made after that exchange, in the same wait, was noted only at the next exchange, with a later time; if the PC went offline in those seconds and then edited the same item, the older phone edit won. The watcher now names the *newest* change it is noting, and the skip applies only when an exchange looked after that one. Confirmed with the reviewer's own script.

#### Protocol 3

- `SYNC_PROTOCOL_VERSION` is **3** (`src/core/sync/protocol.ts`): the library travels on a route a protocol-2 build doesn't have, and a PC sends its time zone.
- `tests/sync-sessions.test.ts` pins which protocol each Flashcards file format needs (`PROTOCOL_FOR_FLASHCARDS_FORMAT = {1: 3}`), beside the chat format's table: a new format with no row fails it.
- As with protocol 2, both sides must be updated, the server first; until both are, all sync pauses and nothing is discarded. The steps are "Updating the server and the PC together" in `docs/upstream-0.6.0.md`.

#### The plugin's store (the one edit to Flashcards' code)

- `plugins/flashcards/src/store.cjs`: `get()` and `change()` compare the file's stamp (inode, size, mtime, ctime) with what they last read or wrote, and read the file again when it changed on disk. A file that went missing keeps what is in memory; the next change writes it back whole.
- So the plugin, running in the same process, sees what sync wrote without a restart, and its next write can't put back what sync replaced.
- One line of `plugins/flashcards/tests/store.test.cjs` changed with it. Both are listed under "At the next upstream release" in `docs/upstream-0.6.0.md`.
- The Windows workflow runs the plugin's store and back-end tests on Windows in a step of their own; its `tests/sync-*.test.ts` glob picks up the new sync tests.

#### Known limits

- A concept that is two graph nodes (learned separately on both devices before they synced) is two facts.
- A server that lost its sync records can bring deleted cards back.
- The same card reviewed on both devices while apart: both reviews count, and that day's new-card limit can be passed.
- A joined twin deck can undercount that day's new cards; with two PCs in different zones, the one not counted keeps its own zone's schedules (above).
- 60,000 reviews (over 26 MB) weren't tried.
- With a 25 MB library (20,000 reviews), noting a phone review holds the server's process for about 570 ms and applying one PC review about 540 ms (about 540 to 650 ms, measured after the second pass's fixes). The noting now runs about once every 20 to 50 s during a review session, not on every rating, and rewrites no table for reviews.
- Clock differences between devices affect the times of reviews and deletions.
- A PC with a wrong clock wasn't run between built copies (a built copy's clock can't be skewed in the development sandbox); it rests on the exchange tests.

#### Tests

- `tests/sync-flashcards.test.ts`: the pure rules, with two devices that each run the plugin's real back end. Both libraries combined at the first sync, every review counted, delete-wins, a deck that still has cards stays, a fact made again starts fresh, twin decks joined, the same question twice, the order rule, settings and the model choice, an idle exchange, and the same library whatever order the changes arrive in.
- `tests/sync-flashcards-replay.test.ts`: the replay, byte for byte against the plugin's own file.
- `tests/sync-flashcards-exchange.test.ts` (with `tests/sync-flashcards-harness.ts`): the real exchange, the real files and the plugin's real back end on each side, never restarted. Pages both ways, the backups, a review landing without a restart, plugin writes right before and after a sync write, an idle round, a generation holding the exchange, the format lock, a lost memory, a PC with no library, no backup no sync, and the time zone sent once and again when it changes.
- Added with the review's fixes (`tests/sync-flashcards-exchange.test.ts`, and cases in `tests/sync-flashcards.test.ts`, `sync-flashcards-replay.test.ts`, `sync-flashcards-zone.test.ts` and `tests/sync-maps.test.ts`): a library put back from its backup deletes nothing; a crash between writing the library and its memory deletes nothing; the backups keep sync's own files; a library that can't be read for a while passes nothing over; a locked library costs no request, and a server's locked library one cheap request a round; the phone's changes keep their own time while every PC is away; the watcher; two PCs whose first exchanges overlap; the same-question pairs; a generation stuck for 15 minutes; one rebuild per zone; the kept snapshot equal to a fresh read.
- **After the first pass's fixes:** all sync tests, 300 of 300; typecheck clean.
- **Added with the second pass's fixes:** in `tests/sync-flashcards-exchange.test.ts`, a restored library on a PC whose clock is ahead and behind, the server taking a negative time, a fact made on both sides, a lost memory and a cut first save, a dropped reply then a same-question card, the watcher's timing, and the server's noting with no table write for a review alone and skipped after an exchange; in `tests/sync-flashcards.test.ts`, the fallback with deleted decks; in `tests/sync-maps.test.ts`, a negative time taken as 0 and NaN refused.
- **After the second pass's fixes:** all sync tests, 309 of 309.
- `tests/sync-flashcards-zone.test.ts`: the zone kept and used by the running process at once and at the next start, the most recent one counting, a name that isn't a zone ignored, the plugin's study day following, and the loop's 2-second trigger.
- `tests/sync-inert.test.ts` (an unpaired app does nothing new) and the protocol rows in `tests/sync-sessions.test.ts`.

#### The two-copy run

Before the review's fixes. Two built copies with the loop on, the server in UTC and the desktop in another zone, nobody pressing Sync now:

- unpaired: nothing;
- a first sync of two different libraries: equal on both 0.8 s after pairing, with a backup on each side;
- a review on the PC reached the server in 0.76 s; one on the server reached the PC in 10 s (its next check);
- a generation on the server held the PC's review (one `busy`), which went 0.76 s after the batch ended;
- the PC offline with changes on both sides: all 13 reviews, the hand-made card and the rename kept, and identical schedules 1.9 s after the PC started;
- an edit against a delete: deleted on both. Twin decks: joined;
- 30 idle seconds: no Flashcards file written, 3 requests with 0 changes;
- 2,000 facts and 20,000 reviews (a 20.3 MB file): first-synced in 10.7 s, in 7 pages up and 3 down;
- unpair and pair again: carried on with 1 change and no second backup.

**Measured after the fixes** (a 25 MB library, 20,000 reviews): the server's idle exchange 25 ms; a first sync 6.5 s. **After the second pass's fixes:** the idle exchange 23 ms; a first exchange 2.2 s. The steps that still hold the server's process are under "Known limits".

#### Only the real PC and server can confirm

- Windows file stamps, and the rename over the file while another program holds it.
- The real Windows zone name.
- That the server image's compose `TZ` is overridden by the zone the PC gave.

#### Log lines and API texts

- No wording on screen. The server's log: `[LearnHarness] Flashcards sync: this server now keeps time in <zone>, the paired desktop app's time zone.`; `[LearnHarness] Flashcards sync: <reason>` (once per distinct reason, on either side); `[LearnHarness] Flashcards sync: the saved time zone couldn't be used: …`; and since the fixes:
  - `[LearnHarness] Flashcards sync: the library doesn't follow what sync last saw here (it was put back or replaced); nothing missing from it counts as deleted, and it is combined again.`
  - `[LearnHarness] Flashcards sync: a generation has shown no progress for 15 minutes; Flashcards sync goes on without waiting for it.`
  - `[LearnHarness] Flashcards sync: this server couldn't switch to the time zone <zone>, and keeps the one it had.`
- Texts only the API carries: "The Flashcards changes didn't arrive whole.", "The server is busy with this. Try again in a moment.", "The server couldn't take the Flashcards changes this time."

### Later phases: decisions still open (ask when you get there)

- **Phase 5 (sync engine):** answered and built. The owner confirmed the wording listed under slices 1 and 2 with the Phase 6 plan page, and settled the two readings of "the desktop's value is kept" (decisions 15 and 16 above).
- **Phase 6 (sync screens):** answered and built; see "Phase 6, the sync screens". For the owner to review: the wording listed as added while building, under slices 1 to 3, and the lesson's one extra read of its session (slice 3).
- **Phase 7 and the merge:** not started. The merge into `side-tutor` needs the owner's approval and a guide for pairing the real PC with the real server.

### Development notes for this work

- **Run server mode locally:** `LH_SERVER_MODE=1 LH_DATA_DIR=<tmp>/data LH_AUTH_FILE=<tmp>/secrets/auth.json npx next dev -p 3100`.
  - The setup code is printed in the log.
  - The login cookie is `Secure`, which browsers accept on `http://localhost`.
  - `next dev` rewrites one line of `AGENTS.md`; run `git checkout -- AGENTS.md` before committing.
- **Never run real `claude auth login/logout` in a cloud dev session.** It can sign out the session's own Claude Code. Put a stand-in `claude` script first on `PATH` (see `tests/server-sign-in.test.ts` for one that mimics the real output).
- **Sandbox network:**
  - `auth.openai.com` and `claude.ai` are usually blocked, so real sign-ins can only be tested on the VPS.
  - Docker works after starting `dockerd`. Builds need the sandbox CA and proxy passed in from outside: a local Dockerfile copy adding `COPY --from=ca ca-bundle.crt` and `NODE_EXTRA_CA_CERTS`, `--build-context ca=/root/.ccr`, `--network host`, plus the proxy build args. Never change the real Dockerfile for this.
  - Docker Hub may answer 429 (rate limit), and `apt` can't run (the proxy is HTTPS-only), so test entrypoint changes on top of an image that's already built.
- **On Node 22**, `tests/subscription-auth.test.ts` has one known failure. CI uses Node 26.
- **The Obsidian sync tests need the real `ob` program.** It isn't a dependency of the app (licence; and its native add-on would ride into the desktop build). Install it once into a scratch folder and point the tests at it:
  - `npm install -g --prefix <scratch>/ob --allow-scripts=better-sqlite3 obsidian-headless@0.0.14` (the entrypoint's command; newer npm versions refuse `--allow-scripts` without `-g`)
  - `LH_TEST_OB_CLI=<scratch>/ob/lib/node_modules/obsidian-headless/cli.js npm test`
  - Its add-on is built for the Node that ran the install, so use the same Node for both.
  - Without `LH_TEST_OB_CLI` the end-to-end tests are skipped; CI always runs them.
- **Obsidian's servers (`api.obsidian.md`) are blocked in the sandbox.** To see Settings → Obsidian work in a browser, run server mode with the stand-in: a wrapper script `exec node --require tests/fixtures/obsidian-fake/preload.cjs <cli.js> "$@"` as `LH_OB_BINARY`, `LH_FAKE_OBSIDIAN=<remote.json>` (its shape is described at the top of the preload file), plus `LH_VAULT_DIR` and `XDG_CONFIG_HOME` in scratch folders.
- **The dev server keeps server objects across code reloads.** After editing `src/server/obsidian-sync.ts`, restart `next dev`; otherwise routes call methods the old manager object doesn't have.
- **`pkill -f` in a cloud session matches the shell that runs it** when the pattern is on its own command line. Put such commands in a script file.
- **Colouring a border:** `app/globals.css` sets `* { border-color }` outside any layer, which beats Tailwind's `border-<colour>` utilities. Use a separate element with a background colour (see `Notice` in `obsidian-section.tsx`).
- **A side tutor thread for screenshots** (before the upstream 0.6.0 merge only; now put threads in the chat record's `sideChats`): write `<data>/side-tutor/<chatId>.json` (`{ "version": 1, "chatId": …, "entries": [{ "id", "question", "answer", "status": "done", "askedAt" }] }`) before loading the page. On a computer, `localStorage["lh:side-tutor:pos"]` (`{ left, top }`) puts the window over the lesson's text, which is what shows through its middle.
- **Dictation in a browser run:** launch Chromium with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`, grant the `microphone` permission, answer `/api/stt/token` with `{ "token": "…" }` through `context.route`, and replace `window.WebSocket` for Deepgram's address in an init script (it opens; on the `CloseStream` message it sends one `Results` message with `is_final` and closes).
- **Browser runs of the notes drawer:**
  - A drag starts only after the pointer has moved a little (10 px after the hold on a phone, 5 px with the mouse), so the dragged row's centre isn't under the pointer. To rest the line on something, measure the row's centre and move the pointer by the difference.
  - `locator.dispatchEvent("contextmenu")` sends an event without a position, so the row menu lands off screen. Use a real press and hold (or a right-click) instead.
  - At desktop width the side tutor's floating window opens over the notes list and swallows clicks there. Minimise it first (the button labelled "Minimize the side tutor").
  - Playwright's `devices["iPhone 13"]` screen is 390 × 664 CSS px (Safari's bars are taken off), not 844 high.
  - The topic list is a short box above the note. A row below its visible part can't be pressed: scroll it into view first, and clear the notes earlier runs left in the scratch vault so the list stays short.
  - To have notes for a run, write files into the server's vault folder and wait until they show in the stand-in's `remote.json`; a later deletion then shows there as a record with `deleted: true`.
- **The local dev server** (`next dev` on port 3100) doesn't survive between turns in a cloud session; start it with `setsid nohup … &` and check it answers before each browser run.
- **The owner's phone screenshots are the ground truth for iPhone behaviour.** Measure them (PIL: pixel rows and columns; a full iPhone screenshot is 3 px per point, a cropped or resized one scales from the status-bar icons) before deciding what iOS does; several early guesses about Safari's bars were wrong until measured.
- **Two real copies for a sync run:** `npx next build`, then `node scripts/build-server.mjs`, then start `.next/standalone/server.js` twice.
  - `build-server.mjs` refuses when `.next/standalone/data` exists. That happens when the repo has a local `data/` folder (tests that don't set `LH_DATA_DIR` leave one): the tracer sweeps it in. Delete `.next/standalone/data` and run the script again. A clean checkout (CI, the image) has no `data/`.
  - The server process is titled `next-server`; `pkill -f "node server.js"` doesn't find it.
  - Plain `http` works between the two because the desktop accepts it for `127.0.0.1`.
- **A full two-copy run with the loop on:** start both copies as above (`NODE_ENV=production`), pair through `POST /api/cloud {op:"pair", …}` from a page of the desktop copy (the code comes from `POST /api/server-auth/desktops {op:"code"}` in a signed-in page of the server copy), and then only watch: compare the two data folders' files. `LH_SYNC_LOOP=off` on the desktop copy turns the timed rounds off for a run that calls `{op:"sync"}` itself.
  - To play "the server is away", stop only the copy on the server's port (find it by `PORT=` in `/proc/<pid>/environ`) and start it again with the same folders.
  - With a page of the desktop copy open on the home screen, the graph view settles new concepts and saves their places a few seconds after a sync; the places are equal on both sides one round later, not at once.
  - A local `next build` rewrites `next-env.d.ts` and `AGENTS.md`; put both back before committing (`git checkout -- AGENTS.md next-env.d.ts`).
- **Browser runs of the sync screens (Phase 6):**
  - Stop a copy with `kill -9`, as Windows does to the app's server. A plain `kill` lets it run on for a while, still syncing, so the other side never sees it go offline.
  - The server counts a PC as offline 30 seconds after it last heard from it; wait at least that long before expecting "offline since …" or the warning box.
  - The warning box needs the holder's last word to be "unsent" or "busy". A PC that was idle when it stopped said "all sent", and the session then moves with no box; set `report.word` in the server's `sync/authority.json` to see the box.
  - A discard: stop the PC copy, add messages to its chat file by hand (a user message and an assistant message each; a record that ends on a user message makes the page try to continue the turn), take the session over on the server, start the PC copy.
  - The setup code works once, so a second script run against the same data folders isn't signed in on the server copy. Start each run from fresh folders, or pass the first context's `storageState()` on.
  - The live channel (`/api/events`) sends nothing until its first event or its 25-second ping, so the page's "open" can be that late. Don't wait on it in a script, and don't hang anything urgent on `useServerResync` alone.
  - A lesson's first messages come from the server-side render (`initialMessages`), not from a fetch.
- **Desktop must not change:** server-only UI keys off `isServerMode()` (the `lh_server` cookie) with no extra requests. `tests/claude-code-status-ui.test.tsx` pins the desktop's exact request list.
