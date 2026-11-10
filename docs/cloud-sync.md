# Cloud sync: approved plan

Status: **Phases 1–2 built (server mode, sign-in on the server); Phase 3 (phone layouts) is in progress; the rest is planned.** Work happens on a separate branch. It merges into `side-tutor` only once the whole feature works and the owner approves the merge, because every push to `side-tutor` publishes a release. Change these decisions only with the owner's approval.

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
                         │ obsidian-headless (`ob sync`) ─► /vault     │
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
- **Take over warns first** when the holder may have turns that haven't synced. If the learner goes ahead anyway, the holder's unsynced turns become a separate session, "Title (desktop copy)", when that device reconnects. Nothing is lost silently.
- An offline desktop can only continue sessions it held before it went offline.
- A session's side-tutor thread (`side-tutor/<chatId>.json`) and notes home folder (`notes/sessions/<chatId>.json`) follow its lease.

### Background work

Graph extraction, research, compaction and visuals run on **whichever device holds the session's lease**. Their results sync like other data. This rule prevents duplicate extraction of the same session.

### Data and how each part syncs

| Data | How it's written | How it syncs |
|---|---|---|
| `chats/*.json` | Whole-file rewrite | Lease. The holder pushes whole files with a version number. |
| `side-tutor/<chatId>.json` | Whole file | Follows the chat's lease |
| `notes/sessions/<chatId>.json` | Small JSON | Follows the chat's lease |
| `graph/*.jsonl` | Mostly appends, with some rewrites (see below) | Appends as lines; rewrites as replayed operations |
| `sources.json`, positions, `settings.json` | Read-modify-write maps | Last writer wins per key; device-specific keys excluded |
| `notes/settings.json` (vault path), `notes/pending/` | Per device | Never synced |
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

### Obsidian vault on the VPS

- The official headless client `obsidian-headless` (`ob`) runs as another Obsidian Sync device. It supports end-to-end encrypted vaults; the vault password is given at setup.
  - Notes are stored decrypted on that server's disk, the same as on any other synced device.
- **One vault.** Obsidian Sync can only exclude folders, so LearnHarness keeps the VPS's excluded-folders list up to date: every top-level folder except `LearnHarness/`.
  - The desktop, which has the full vault, sends the current list.
  - Set the exclusions before the first sync.
- **Known gaps:**
  - a new top-level folder syncs to the VPS until the list catches up;
  - loose files at the top level and `.obsidian/` always sync.
- **Rule: never delete files by hand on the VPS while sync is running.** Deletions sync to every device. To remove something that leaked, exclude it instead.
- The notes drawer's existing conflict check (hash + 409) and polling already handle concurrent edits from Obsidian.

### Phone layouts — approved plan (Phase 3)

**When it applies**

- Screens narrower than **640 px, in a browser only**. The desktop app never shows the phone layout (its window can't go below 640 px, and the rules also exclude the Electron shell, so UI zoom can't trigger it).
- **Tablet layout: not built; decide later.** Tablets get the desktop layout.

**Screens**

- **Session list:** a drawer that slides in from the left over the lesson, with the rest dimmed. It covers 85% of the width.
  - A phone always starts with it closed. It closes on picking a session, a tap on the dimmed area, or ✕.
  - It doesn't read or write the desktop's remembered open/closed setting.
- **Top bar:** one row at today's height. The title takes the free space (22 px text instead of 30) and truncates. Plan and Notes are icon-only, the extraction ring stays, and the phase word is hidden. The phase dividers in the lesson still show the phase.
- **Side tutor** (teaching sessions only, as on the desktop):
  - A round bubble in the bottom-right corner, just above the message box. It shows a spinner while an answer is being written. On a phone the tutor starts closed.
  - The bubble opens a **bottom sheet** covering about three quarters of the screen, with the lesson dimmed above it. It closes on a tap on the dimmed lesson or the – button. No dragging or resizing.
  - While an opened question leaves no room above the dock, the bubble moves to the top-right corner under the top bar.
- **Notes drawer:** slides in from the right and fills the screen.
  - **Inner layout: not settled.** Two are built behind a temporary switch for the owner to compare from screenshots: (A) list, then note with a back arrow; (B) stacked, where the list folds away when a note opens. The loser is removed.
  - The two resize handles are hidden. Dragging notes between folders is off (press-and-hold opens the menu; "Move to…" does the job).
- **Questions:** an opened question may grow to the full screen below the top bar, as on the desktop. Scrolling up folds it into the slim bar.
- **Footer row** (context and cost, model, thinking level): all stay, on one row; the model name is kept to one line.
- **Home:** the knowledge graph. The toolbar is fitted: search becomes an icon that opens a full-width field, and the other buttons are icon-only. The graph already supports touch drag and pinch (d3-zoom).
- **Settings:** full screen. The section list first, then the section with a back arrow. The Keyboard section is hidden on phones; nothing else is removed.
- **Plan and diagram viewers:** one-finger drag, two-finger pinch to zoom (new), and the − / + buttons.

**Touch and typing**

- **Enter:** on a touch phone, Enter makes a new line and the button sends. This covers the lesson, home and new-session message boxes, the side tutor, practice answers, written answers and "thinking while reading" (a check waiting closed opens with its Open button). Keyboard hints are hidden on touch screens. Desktop is unchanged.
- **Row menus:** press and hold (about half a second) a session, note or folder to open the menu that right-click opens on the desktop. Row text isn't selectable on phones.
- Text boxes use 16 px text on phones (smaller text makes iPhone Safari zoom in on focus).
- When the on-screen keyboard opens, the layout shrinks so the focused box stays visible.
- Controls that only appear on hover are always visible on touch screens. Hover tooltips don't show.
- Wide tables, formulas and code scroll sideways inside their own box. The page never scrolls sideways.
- The notch and the home bar (safe areas) are respected.

**Home-screen app (PWA)**

- Name and short name **LearnHarness**, the existing app icon, a dark background, `display: standalone`.
- The manifest and the icon files are served **without the login**, because phones fetch them without the session cookie. They contain only the name and the icon.
- No service worker and no offline mode.
- The login and setup pages link the manifest and the icon too.

**How it's built**

- Phone styling lives in one fork-owned file, `app/phone.css`, with every rule inside the phone media query. Behavior (phone detection, press-and-hold, the sheet, pinch) lives in `components/phone/`.
- Upstream components get only small hooks (data attributes and short conditionals), so rebasing onto upstream stays cheap.
- A test checks that no rule in `phone.css` can apply on a desktop. Desktop screenshots are compared before and after.

**Not in this phase:** a tablet layout, the side tutor in practice sessions, offline use, and renaming notes in the drawer.

### Hosting — built in Phase 1

- **Reached at your own domain** (for example `learn.<yourdomain>`). Caddy serves HTTPS with an automatic certificate.
- **`Dockerfile`** builds the same standalone server the desktop app runs and starts it in server mode as the `node` user:
  - `/data` is a volume: `/data/data` = `LH_DATA_DIR`, `/data/secrets` = the `auth.json` folder (mode 700);
  - `reset-password` is on the PATH.
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
- **The server updates automatically, nightly at 4 am** (the server's system time zone). A systemd timer (`deploy/install-update-timer.sh`) runs `deploy/update.sh`: `docker compose pull`, then `up -d`, which restarts only what changed. It catches up after downtime. `/data` and `/vault` live on volumes and aren't touched.
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
3. **Phone layouts.** In progress; see "Phone layouts — approved plan (Phase 3)". PWA manifest; phone layouts for every view.
4. **Vault on the server.** The `ob sync` process, setup, and the automatic excluded-folders list.
5. **Sync engine.** The lease API, session sync with take-over and desktop copies, graph line and operation sync, per-key settings merges, and the sync protocol version check.
   - Built as wrapper stores at the composition root (`src/server/stores.ts`) over the `core/ports.ts` interfaces, so upstream store code stays untouched and rebasing onto upstream stays cheap.
6. **Desktop sync UI.** Settings → Cloud (server URL, sign-in, device name, Sync now); a sync status chip; lease state on each session.
7. **Tests and docs.** Lease, take-over and graph operation tests; an end-to-end test with two servers and one cloud; and an update of this file from "planned" to built.

## Handoff: where things stand and how to continue

### State (Phases 0–2 done, Phase 3 in progress)

- **Branch:** `claude/pensive-goldberg-7dty2m`. All cloud sync work lives here.
  - Pushes build only the server image (`:dev`), never a desktop release.
  - **Never push to `side-tutor`** until the owner approves merging the whole feature.
- **Phases 0–2 are done and verified on the owner's VPS:**
  - HTTPS and the password login work;
  - the nightly update timer is installed;
  - Claude Code installed itself onto the volume;
  - ChatGPT and Claude are both connected from Settings.
- **The cloud copy and the desktop app are separate libraries** until Phase 5.
- **The owner's server follows `LH_CHANNEL=dev`.** To update it right away instead of waiting for the nightly run: `cd ~/learnharnessSide && git pull && cd deploy && ./update.sh`. The `git pull` is needed only when files in `deploy/` changed.

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

### Now: Phase 3, phone layouts (plan approved, in progress)

- The decisions are in "Phone layouts — approved plan (Phase 3)" above. The owner approved them; don't reopen them without a reason.
- **Build order** (each step ends with a push to this branch):
  1. Record the decisions (this file).
  2. Basics: phone detection, `app/phone.css`, and the session drawer.
  3. The notes drawer with **both** inner layouts, then side-by-side screenshots for the owner to choose from.
  4. The rest of the lesson screen: top bar, side tutor bubble and sheet, Enter key, footer row, question tidying, press-and-hold, keyboard and safe-area handling.
  5. Home, Settings, pinch zoom, and a sweep of every dialog and menu at 360, 390 and 430 px wide.
  6. The home-screen app: manifest, icons, iPhone tags.
  7. Tests, the desktop before-and-after comparison, docs, and a phone guide for the owner.
- **Needs the owner's real phone** (a phone-sized desktop browser can't show these): typing with the on-screen keyboard open, the notch and home bar, and "Add to Home Screen".
- **Sample data for screenshots:** copy `tests/fixtures/golden-data` to a scratch `LH_DATA_DIR`. Truncating a copy of the teaching chat right after a `quiz` tool call gives a session with an open question.

### Later phases: decisions still open (ask when you get there)

- **Phase 4 (vault on the server):**
  - how the owner gives the server the Obsidian account and the end-to-end encryption password (a Settings page vs. SSH);
  - `--conflict-strategy` (`merge` or `conflict`);
  - whether `--configs` should be cleared so `.obsidian` settings don't sync to the server;
  - the device name (for example "LearnHarness server");
  - where the vault lives on the volume (for example `/data/vault`) and how the notes drawer's vault path points at it;
  - how the desktop sends the top-level folder list for the exclusions;
  - whether `obsidian-headless` runs inside the LearnHarness container or as a second compose service.
- **Phase 5 (sync engine):**
  - which device holds the take-over warning's data;
  - lease API details;
  - how "(desktop copy)" sessions are named and filed;
  - the operation-log format for graph deletions;
  - the sync protocol version number;
  - how background jobs already running behave when a lease is taken over.
- **Phase 6 (desktop sync UI):**
  - where Settings → Cloud lives;
  - the sync status chip;
  - the lock indicator on sessions;
  - device token pairing (how the desktop signs in to the server).

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
- **Desktop must not change:** server-only UI keys off `isServerMode()` (the `lh_server` cookie) with no extra requests. `tests/claude-code-status-ui.test.tsx` pins the desktop's exact request list.
