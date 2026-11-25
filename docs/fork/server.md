# The server: login, sign-ins, Obsidian, hosting, accounts and updates

## Login on the server

### Login (VPS) — built in Phase 1

This is the login of a single-copy server (no `LH_GATE_SECRET`). Behind the gateway, which is what the owner's server runs since the switch-over, the copy's own login routes and pages answer 404 and the gateway's sign-in applies ("Sign-in, sessions and the lockout" under "Accounts on one server" below); there `reset-password` runs in the gateway's container.

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
- **Desktop sync** uses per-device keys that can be revoked (built in Phase 5: a pairing code gives each desktop app its own device key; `src/core/sync/devices.ts`, `syncGate` in `src/server/server-auth.ts`).

### Code and tests

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

## Model sign-in on the server

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

### Code and tests

- **Tests:** `tests/server-sign-in.test.ts`. It includes an offline ChatGPT sign-in completed through the paste step, and `claude auth login` driven against a stand-in CLI that prints what the real one printed on a VPS.

## The Obsidian vault on the server

### Obsidian vault on the VPS — built in Phase 4

**What it does**

- The official headless client `obsidian-headless` (`ob`) runs **inside the LearnHarness container** as one more Obsidian Sync device, named **"LearnHarness server"** (owner's choices). The notes drawer on the phone then shows the same notes as Obsidian.
  - Notes are stored decrypted on the server's disk, the same as on any other synced device.
- **Set up in Settings → Obsidian** (owner's choice over SSH). The section shows only on the server, just above Cloud and Account. On a phone it has no row of its own: it is a group inside Cloud, under "Desktop apps" (owner's ask; "A less cramped list: Obsidian inside Cloud" under "Plugins on a phone" in `docs/fork/phone-and-tablet.md`).
  1. Sign in: Obsidian email, password, and a two-step code if the account uses one.
  2. Choose the vault and give its encryption password (empty for a standard vault).
  3. A status line: Starting… / Downloading your notes… / Up to date (with "Last synced …") / Syncing… / Can't reach Obsidian. Trying again. / the stopped states under "Keeping sync safe" below.
  - SSH still works as a backup: `docker compose exec lh ob …` uses the same files, and the page reads its state from `ob` itself.
- **One vault, at `/data/vault`** (`LH_VAULT_DIR`), in the existing data volume (owner's choice).
  - Connecting points the notes drawer at it. Nobody types a folder path on the server: the drawer shows "Connect your Obsidian vault" with **Open Settings**, its gear opens Settings → Obsidian (on a phone: Cloud, with the Obsidian group in view), and `POST /api/notes {action:"vault"}` answers 403.
  - While sync is stopped, the drawer shows "Not syncing with Obsidian right now. What you write here is kept and syncs when it's back." The notes still open and save. An offline spell shorter than a minute isn't shown.
- **Conflicts: `merge`** (owner's choice; `ob`'s default).
- **None of `.obsidian` syncs** (owner's choice; `ob` syncs no settings unless `--configs` names some). So the server can't read Obsidian's attachment setting, and pictures pasted on the phone go to `LearnHarness/attachments`, the drawer's existing fallback. **The server never writes outside `LearnHarness/`.**
- File kinds synced are `ob`'s defaults: notes, canvases, bases, images, audio, video and PDFs.

**Leaving folders out (owner's choice: fully automatic, no list to paste)**

- Obsidian Sync can only exclude folders, so every top-level folder except `LearnHarness/` goes on `ob`'s excluded-folders list.
- Why not a list up front: the server can't list the vault before syncing (`ob` starts downloading while the file list is still arriving), and only a paired desktop app sends its folder names (below).
- So the manager leaves a folder out **the moment it first shows up**:
  - on `ob`'s `Downloaded <name>` line for a new top-level folder (a folder's record arrives before its files, so usually none of them is downloaded);
  - on a `Downloading <folder>/…` line;
  - on a scan of the vault's top level every 10 seconds.
  - It stops `ob`, adds the folder with `ob sync-config --excluded-folders`, and starts `ob` again.
- A folder name with a comma, or with spaces at either end, can't go through that option (`ob` splits the value on commas and trims each entry). For such a list LearnHarness writes `ignoreFolders` into `ob`'s settings file for the vault, the field the command sets.
- Kept: `LearnHarness/` (the exact name) and dot-folders (`ob` never syncs those).
- **Strays:** a file or two can arrive before its folder is left out. They stay on the server, unused. `ob` never uploads, changes or deletes anything in an excluded folder, so they can't affect Obsidian.
- **Loose files at the top of the vault always sync**; Obsidian Sync can't exclude single files. The owner's pasted pictures live there, which is why pictures in notes show on the phone.
- **A paired desktop app sends its vault's top-level folder names** with a sync round, and the manager leaves them out before `ob` starts and at once while it runs, so the strays stop for those folders (`desktopVaultFolders` in `src/store/sync/vault-folders.ts`, `foldersAnnounced` in `src/server/obsidian-sync.ts`).

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

### When the owner reports a problem

- If the owner reports a problem, ask what Settings → Obsidian shows and for the lines `docker compose logs lh` prints that start with `[LearnHarness] Obsidian sync:`. They hold state changes and Obsidian's own reason for a refused sync, never note names, folder names or passwords. `ob`'s own log is `/data/home/.config/obsidian-headless/sync/<vault id>/sync.log` in the container; it lists note names, so ask the owner to read it rather than paste it.

### Rulings, limits and open items

#### From the Phase 4 handoff

- Wording added while building, beyond the approved screens, for the owner to review: "Nothing yet" (no folders left out so far), "Obsidian said: …" (Obsidian's own words under a refused sign-in), "Loading your vaults…", "Couldn't check Obsidian sync on this server.", "The vault couldn't be connected. Try again.", "Obsidian's sync program couldn't be disconnected, so nothing was removed. Try again.", "Obsidian's sync program didn't answer. Try again.", the drawer gear's tooltip "Obsidian settings", and **Try again** on the ended-subscription state.

### Code and tests

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

## Hosting and the image

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
- Multi-user hosting is **built and shipped to both branches**: several accounts at one address, a container per account behind a gateway ("Accounts on one server" below). **The owner's server is switched over** ("State" below): it runs the gateway, the maker and the owner's copy behind Caddy, and what is said above about the single copy's own login now describes the way back, not what runs. The plan, with the owner's decisions and the approved words, is `docs/fork/plans/multi-account-plan.md`; the step-by-step guide it was built from is `docs/fork/plans/multi-account-build.md`.

## Accounts on one server

### State

- **The owner's server runs the gateway** (switched over). The owner reported "everything works great" without saying which steps or screens they tried, so an invite, the home-screen app through the gateway and the PC carrying on are confirmed only as far as that sentence goes. Records: `docs/fork/history/ship-log.md`.
- Two things the guide asked for that haven't been confirmed one by one: "Concurrent worker requests" lowered to 3 on the owner's copy, and the recovery codes kept.
- **After `git pull` on the server, `./make-secrets.sh` must run before the next `./update.sh`:** the new compose file refuses to start without the secrets, so the nightly update would fail (and change nothing) until they exist.
- **The sync protocol stays 3 and no stored format changed.** Nothing on the wire changed shape, so the order of updating the server and a PC doesn't matter. A desktop app and a single-copy server (no gateway) behave as before: everything new is switched by `LH_GATE_SECRET` / `LH_ACCOUNT_TAG` being set, or lives in the gateway and the maker. No existing test file was edited.
- **Where to read:** the owner's decisions and every approved sentence are in `docs/fork/plans/multi-account-plan.md` (the sentences live in code in `src/core/account-screens.ts`). This part records what was built, where, and what the builder decided beyond the plan.

### What it does

- **One address, several people.** Each person has an account (a name they chose, a password, four recovery codes) and their own copy of LearnHarness in a Docker container with its own data volume. The owner's existing container and volume become the owner's account; no data moves.
- **Two programs added to the image and a mode in the app:** the **gateway** (accounts, sign-in sessions, invite codes, reset and recovery codes, the lockout, `/gate`), the **maker** (the only program with Docker's socket; builds every account's container from one fixed template) and, in each copy, a new mode for standing behind the gateway. Caddy asks the gateway about every request and then sends the request straight to that person's copy.
- **The owner's screen** (Settings → Accounts) manages accounts and never opens one: invite codes, Reset, Pause, Remove, Restore, Delete now. **Each person's Settings → Account** gains recovery codes, Download my data and Delete my account.
- **A single-copy server stays possible** and is still what the image does by default (no `LH_GATE_SECRET`).

### The pieces and how a request travels

```
                 internet  https://learn.<yourdomain>
                     │
              ┌──────▼──────┐   GET /gate (method, path, cookie, key)   ┌─────────────┐
              │    Caddy    │──────────────────────────────────────────►│   gateway   │
              │  lh-caddy   │◄── 200 + X-LH-Upstream / -Gate / -Scope ──│  :9000      │
              └─┬───┬───┬─┬─┘                                           └──┬───────▲──┘
   own network  │   │   │ └── :9200 relay (token) ◄── pairing forward,      │       │ front
   per account  │   │   │              unpair-all ──────────────────────────┘       │ (Caddy + gateway only)
        ┌───────┘   │   └────────┐                                         maker network (internal)
  ┌─────▼────┐ ┌────▼─────┐ ┌────▼─────┐                                      ┌────▼─────┐
  │ owner's  │ │ lh-acct- │ │ lh-acct- │   one container and one volume each  │  maker   │──► Docker socket
  │ copy lh  │ │   ABC    │ │   XYZ    │                                      │  :9100   │
  └──────────┘ └──────────┘ └──────────┘                                      └──────────┘
```

- **Caddy** (`deploy/Caddyfile`) stays the only way in. For a request it removes every `X-LH-*` header the client sent, refuses a `Service-Worker` header (403), answers `/api/internal/*` 404, sends the gateway's own paths to the gateway, and asks the gateway about everything else (`forward_auth` to `/gate`). A 200 names the copy; any other answer goes back to the client as it is. Lesson streams, the events channel and large uploads never pass the gateway.
  - **The gateway's own paths:** `/login /setup /invite /reset /manifest.webmanifest /api/accounts /api/accounts/* /api/sync/pair /api/server-auth/*`, except `/api/server-auth/desktops` (pairing codes and the paired-desktop list stay the copy's own and go through `/gate`).
  - **Fails closed (502)** when the gateway's answer has no upstream, an upstream that isn't a copy's address (`^(lh|lh-acct-<tag>):3000$`, the tag in the setup code's alphabet) or no scope.
  - **Strips the session cookie** (`__Host-lh_session`) before a request reaches any copy; every other cookie passes. A program inside a copy therefore can't act as that person, or as the owner, against the gateway.
  - Strips `Service-Worker-Allowed` from answers: all accounts share one origin and the app has no service worker. `admin off`: no admin endpoint (nothing reloads the config; `update.sh` re-creates the container).
- **The relay** (`http://:9200`, plain HTTP, never published) is how the gateway reaches a copy: only to forward a pairing request and to call `/api/internal/unpair-all`. It opens only with `LH_RELAY_TOKEN` (`X-LH-Relay`) and only for an upstream that is a copy's address; it turns `X-LH-Client-Addr` (the real client's address) into the copy's `X-Forwarded-For` and passes `X-LH-Scope` through. It exists because the plan lets only Caddy join each copy's network: the gateway shares no network with any copy. It is reachable from every network Caddy is on, so a program inside a copy can reach `caddy:9200`; the token is why that gets a 404.
- **The gateway** (`gateway/`, plain `node:http`, no Next, no dependency beyond Node and `src/core`) holds its state in one file on its own volume. **The maker** (`gateway/maker.ts`) is on the `maker` network with the gateway alone. Both are bundled into single `.mjs` files (`scripts/build-gateway.mjs`) and started as `lh-gateway` and `lh-maker`.

**Networks, as built:**

| Network | Members | Notes |
|---|---|---|
| `front`, named `lh-0-front` | Caddy (alias `caddy`), gateway | Nothing but Caddy reaches the gateway. Caddy's default route and its published ports. |
| `owner`, named `lh-1-owner` | Caddy, the owner's copy `lh` | |
| `maker`, named `lh-2-maker` | gateway, maker | `internal: true`: no way in or out. |
| `lh-acct-<tag>-net` | that account's copy, Caddy | Made by the maker, one per account, **not** internal (the copy needs outbound access for its model providers). No copy shares a network with another copy, the gateway or the maker. Caddy joins it with the lowest gateway priority (`GwPriority` −1). |

- **Fixed network names, never the compose project's.** Docker gives a container on several networks its default route, and with it the published ports, through the network whose name sorts first in byte order (Docker 28 and later: the highest gateway priority first, then the name). With the project's name in front (CI copies `deploy/` to a folder named `stack`: `stack_front`), the first account network, `lh-acct-<tag>-net`, sorted first: joining Caddy to it moved ports 80 and 443 onto it and cut the request in flight (the first invite: "socket hang up"). A project named `deploy` only happened to sort first. Now `lh-0-front` sorts before every `lh-acct-` name, on every engine.
- **Two locks beside the names:** the maker joins Caddy with `GwPriority` −1 (Docker 28 and later honour it, checked on 29; Docker 25 takes the field and ignores it, checked on 25.0); and it logs a warning when none of Caddy's own networks sorts before the account network it joins (it still joins). `tests/deploy-files.test.ts` pins the names and their order. Compose's own `gw_priority` key isn't used: older Compose refuses an unknown key.
- **One stack per host.** The names are host-wide, as `lh-caddy` and every `lh-acct-*` name already were. A second stack on the same Docker would be given the first one's networks by compose; it stops only at `lh-caddy`'s name, already taken (tried), and its `down` would remove the networks once they are unused.

**Processes:**

| Piece | Image and command | Listens | Limits and hardening |
|---|---|---|---|
| Caddy `lh-caddy` | `caddy:2` | 80, 443 (public); 9200 (relay, internal) | none set |
| gateway | the LearnHarness image, `lh-gateway` | 9000 | 256 MB, 128 processes, read-only root with `/tmp` as tmpfs, no capabilities, `no-new-privileges`; volume `gateway-data` at `/gateway`; stop grace 90 s |
| maker | the same image, `lh-maker` | 9100 | 128 MB, 64 processes, read-only root, no capabilities, `no-new-privileges`; mounts Docker's socket; stays the image's `node` user with the socket's group added (`group_add`); stop grace 120 s |
| owner's copy `lh` (compose service, volume `lh-data`) | the same image, default command | 3000 | the same limits as an account's copy (below) |
| an account's copy | the same image; container `lh-acct-<tag>`, volume `lh-acct-<tag>-data` | 3000 | the maker's template (below) |

### The contract as built

The build guide's contract tables (`docs/fork/plans/multi-account-build.md`) are corrected where this differs; each change is marked there.

**Headers between Caddy, the gateway and a copy:**

| Header | Set by | Meaning |
|---|---|---|
| `X-LH-Upstream` | the gateway's `/gate` answer | `lh:3000` or `lh-acct-<tag>:3000` |
| `X-LH-Gate` | the gateway's `/gate` answer | that copy's secret; the copy compares it in constant time (both sides hashed first) |
| `X-LH-Scope` | the gateway's `/gate` answer | what kind of request it let through: `public`, `sync` or `session`; `internal` only on the gateway's own relay calls |
| `X-LH-Relay`, `X-LH-Client-Addr` | the gateway, to the relay only | the relay token; the real client's address |

Caddy removes all five from every client request before anything else. `/gate` reads only the forwarded method (`X-Forwarded-Method`), URI (`X-Forwarded-Uri`), `Host`, `Cookie`, `Authorization`, `Origin`, `Sec-Fetch-Site` and `X-Forwarded-Proto`; it never reads an `X-LH-*` header.

**What `/gate` decides, in this order** (`decideGate`, `gateway/gate.ts`, a pure function of the request's facts and the state):

1. A request target that isn't already in one canonical form → 400 (`canonicalPath`: no fragment, absolute form, control character, space or backslash; no dot segments, encoded slashes, `%2e`, `%00` or `%23` in the path, no doubled slashes; nothing a URL parser would change). The gate must classify exactly the path the copy will route.
2. `/api/internal/*` → 404.
3. A **sync path** (`/api/sync/*`): sorted by the tag in the Bearer key, never by a cookie. A damaged state file → 503. A key of no valid shape, or none → 401 `{code: "not_paired"}` (the shape the desktop app reads as "removed"). An untagged key (43 characters) is the owner's copy's, claimed or not (503 while the owner's `unpairPending`). A tagged key (46): with no owner yet → 503 (a lost file must not make PCs drop their keys); no such account, the owner's, or `deleting` → 401 `not_paired`; the account not active, or no copy yet, or `unpairPending` → 503 (the app reads that as offline and keeps its key). Otherwise that copy, scope `sync`.
4. A public file (`/favicon.ico`, `/robots.txt`, `/_next/static/`, `/fonts/`, `/icons/`) → the owner's copy, scope `public`. Narrower than the copy's own list: no pages, APIs or manifest, and no other `/_next/` path.
5. A write that doesn't come from the site itself (`sameOrigin`) → 403.
6. A damaged state file → 503 (JSON for an API, plain text for a page).
7. A valid session cookie of an active account whose copy is ready → that copy, scope `session`. "Last seen" is stamped at most every 5 minutes and the session is extended with it.
8. Otherwise: an API path → 401 "Sign in to LearnHarness first."; a page → 303 to `/login` (`/setup` while no owner exists).

**What a copy accepts** (`gatewayGate`, `src/server/server-auth.ts`; with `LH_GATE_SECRET` set in server mode, `behindGateway()`): the secret must match, then the scope must fit the path **as the copy itself parses it**.

| Scope | Allowed on the copy |
|---|---|
| `public` | GET or HEAD of the gateway's public files only (`isGatewayPublic`: a subset of the copy's own `isPublic`; a test keeps the two lists equal to the gateway's) |
| `sync` | sync paths only, then the device-key gate (`syncGate`) as before |
| `session` | everything but `/api/internal/*`; sync paths still need a device key; the same-site write rule stays as a second lock |
| `internal` | `/api/internal/*` only |

Refusals: a secret shorter than 32 characters → 503 for everything (fail closed); a wrong secret, a missing or unknown scope or a path outside the scope → 503 on sync paths (the app reads 5xx as offline and keeps its key), 401 on any other API, 403 on a page or file. **Why a scope exists** (a builder's change to the contract; a security review): Caddy forwards request targets raw to both the gateway and a copy, and the two could read one path differently. The gateway now refuses any non-canonical path and its public list is narrower, and the copy re-checks the scope against its own reading.

**The gateway's routes** (`ALL_ROUTES` in `gateway/main.ts`):

| Route | Who | Does |
|---|---|---|
| `GET /gate`, `GET /healthz` | Caddy | the decision above; a plain "ok" |
| `GET /login`, `/setup`, `/invite`, `/reset` | anyone | the pages (`gateway/pages.ts`), always in the app's standard dark theme (the Default theme's colours, never anyone's saved theme); a signed-in browser is sent to `/`, no owner yet to `/setup` |
| `GET /manifest.webmanifest` | anyone | the home-screen manifest, in the same dark colours |
| `POST /api/server-auth/setup` | anyone, once | setup code, name, password → the owner's account bound to the owner's copy, signed in; the answer carries the four recovery codes |
| `POST /api/server-auth/login`, `/logout` | anyone, signed in | the cookie; ends this session |
| `POST /api/server-auth/invite` | anyone | invite code, name, password → reserves the account, has the maker make the copy, signs in; the answer carries the four recovery codes |
| `POST /api/server-auth/reset` | anyone | a recovery code or the owner's reset code, name, new password |
| `GET /api/server-auth/account` | signed in | today's `devices` shape plus `name`, `owner`, `recoveryCodesLeft` |
| `POST /api/server-auth/password`, `/sign-out-everywhere` | signed in | as today, per account; both unpair the account's desktop apps |
| `POST /api/server-auth/recovery-codes`, `/delete-account` | signed in, with the password | four new codes, once; Delete my account (not for the owner) |
| `GET`, `POST /api/accounts` | the owner (404 to anyone else) | the list, and `invite`, `cancel-invite`, `reset`, `pause`, `resume`, `remove`, `restore`, `delete-now` |
| `POST /api/sync/pair` | a desktop app | reads the tag from the code in the body and forwards to that copy through the relay |
| `POST /control/reset-owner` | the gateway's own command only | loopback only, and never with a forwarding header (Caddy always adds one); see "Rulings made while building (for the owner to review)" below |

Bodies are at most 16 KB; a request has 10 s for its headers and 30 s in all.

**Tags** (`src/core/sync/devices.ts`, `src/core/accounts.ts`):

- **A tag** is 3 random characters of the setup code's alphabet, unique among accounts in every state, not derived from the name; the owner has none. A member's copy is exactly `lh-acct-<tag>:3000`, and a state file with any other upstream for a member is read as damaged.
- **A copy that knows its tag** (`LH_ACCOUNT_TAG`) ends its pairing codes with it (`XXXX-XXXX-TTT`: 11 characters normalized, 13 as shown) and starts its device keys with it (46 characters; 43 is the owner's and any older key). The stored hashes cover the whole code and key. An invalid tag refuses pairing (500, `code: "account_tag_invalid"`), never an untagged code.
- **The gateway reads the tag** from the key on every sync request and from the code in `POST /api/sync/pair`. An untagged key or code goes to the configured owner's copy, also before the owner has claimed the gateway.

**The gateway's state file** (`src/core/accounts.ts` `GatewayState`, `gateway/state.ts`): `{version: 1, accounts[], sessions[], invites[], resets[], lockouts{}, setupCodeHash, lockoutPauseUntil?}`; hashes only.

- **account:** `id`, `tag`, `name`, `nameKey` (lower case), `password` (scrypt), `recoveryCodes[]` (hashes), `role` (`owner` | `member`), `state` (`active` | `paused` | `removed` | `deleting`), `createdAt`, `lastSeenAt`, `removedAt`, `upstream`, `gateSecret`, and four optional marks: `unpairPending` (the copy still owes an unpair-all), `copyPending` (the maker was asked to (re)create the copy and the answer isn't saved), `keepVolume` (an abandoned reservation: never delete its volume), `codeFailures` (wrong reset or recovery codes naming it).
- **session:** the server login's `SessionRecord` plus `accountId`. **invite** and **reset:** `codeHash`, `expiresAt` (reset: `accountId`). **lockout:** the server login's record plus `against` (whose password every counted failure was against, or `*`).
- **The file** is written like `server-login.json` (mode 0600, a temp file in the same folder renamed over it, `fsync`). A damaged or wrong-version file closes the site (503) and is never overwritten as empty. `update()` is synchronous end to end, so two requests in one process can't lose each other's write; every read stats the file and parses again only when it changed (the owner's command may write it from a second process). A daily backup is kept beside it (`accounts.json.bak`, made before a write, only from a file that parses); **a missing file with a backup beside it reads as damaged, not as "no accounts"** (that would reopen first-start setup).

**The maker's API** (`gateway/maker.ts`; Bearer `LH_MAKER_TOKEN`, checked first and in constant time; internal network only; a body is at most 512 bytes and only `tag`, `start` and `fresh` are read from it; Docker Engine API 1.44, so the server needs **Docker 25 or newer**):

| Call | Does |
|---|---|
| `POST /copies {tag, start?, fresh?}` | Makes the network, the volume and the container from the template, joins Caddy to the network, starts it (not when `start` is literally `false`). `fresh: true` (a new account only): 409 `copy_exists` / `volume_exists` and nothing made when the tag's container, a swap's leftover or its volume exists, so a new account can never be given another person's leftover data. On an existing copy: the container is re-created on the same volume with a **new secret**. Answers `{upstream, gateSecret}`. |
| `POST /copies/<tag>/stop`, `/start` | Pause and resume. 404 `no_copy` when there is none. |
| `DELETE /copies/<tag>` | The container (a swap's leftovers too) and the network go; **the volume stays**. Fine from any partial state. |
| `DELETE /volumes/<tag>` | The final deletion. 409 `volume_in_use` while any container still uses the volume. |
| `GET /copies`, `GET /volumes` | `[{tag, state, image, upToDate}]`; `[{tag}]` for every `lh-acct-<tag>-data` volume (tags taken, whatever the gateway's file says). |
| `POST /reconcile` | Finishes interrupted swaps, joins Caddy to every account network, brings every copy onto the current image (same volume, same secret, same running or stopped state), one at a time. Also run at the maker's start. |

- **A tag** must be exactly 3 characters of the code alphabet, or the call is refused (400). The template takes nothing else from a request: no image, mount, command or name.
- **The template** (`copyTemplate`): the maker's own image (`LH_IMAGE`, else its own container's image); `User: node`; the volume `lh-acct-<tag>-data` at `/data` as the only mount; `Memory` 1 GB, `MemorySwap` 2 GB; `CpuShares` 1024 (a share, not a cap); `PidsLimit` 512; `CapDrop: ALL`; `no-new-privileges`; `Privileged: false`; no published ports; `Init: true`; `unless-stopped`; log files bounded (3 × 10 MB); its own network; environment `LH_GATE_SECRET`, `LH_ACCOUNT_TAG`, `LH_SEED_WORKER_CONCURRENCY=3`, `LH_TRUST_PROXY=1` and the maker's own `TZ`.
- **A swap that can be cut off at any instant:** the old container is renamed `lh-acct-<tag>-old-running` / `-old-stopped` (its state in its name), stopped, the successor is created on the same volume and started when it should run, and only then is the old one removed. Every call for a tag, and every reconcile pass, first finishes a leftover (`settle`). On SIGTERM the maker refuses new work and waits (up to 100 s) for what is under way.
- **The gateway's side** (`gateway/maker-client.ts`): a timeout on every call (60 s for a create, 20 s otherwise), answers capped at 64 KB. A 5xx, a timeout or no answer is "the maker is busy, try later" and never "the copy doesn't exist": after a `POST /copies` without an answer a container may run with a secret the gateway never saw.

**Environment variables:**

| Variable | Where | Meaning |
|---|---|---|
| `LH_GATE_SECRET` | the owner's copy (compose); an account's copy (the maker) | Set: the copy stands behind a gateway (server mode only). Its own password gate is off; every request must carry this value in `X-LH-Gate`. At least 32 characters. |
| `LH_ACCOUNT_TAG` | an account's copy | Its tag. Absent on the owner's copy. |
| `LH_SEED_WORKER_CONCURRENCY` | an account's copy | Read by the entrypoint only when the volume has no `settings.json`: writes "helpers at once" (3), in the file's own shape. |
| `LH_GATEWAY_FILE` | gateway | The state file (`/gateway/accounts.json`). |
| `LH_MAX_ACCOUNTS` | gateway; `deploy/.env` | The cap, the owner's included (default 4). |
| `LH_OWNER_UPSTREAM`, `LH_OWNER_GATE_SECRET` | gateway | The owner's copy (`lh:3000`) and its secret (the copy's `LH_GATE_SECRET`; at least 32 characters). |
| `LH_RELAY_URL`, `LH_RELAY_TOKEN` | gateway (both); Caddy (the token) | Caddy's relay (`http://caddy:9200`) and its token (at least 32 characters). |
| `LH_MAKER_URL`, `LH_MAKER_TOKEN` | gateway (both); maker (the token) | Where the maker is, and the shared token. Without them no copy can be made (invites answer 503). |
| `LH_IMAGE`, `LH_CADDY_CONTAINER` | maker | The image every copy is made from, and Caddy's container name (`lh-caddy`). |
| `LH_DOCKER_GID`, `LH_DOCKER_SOCKET` | compose | The socket's group id (added to the maker's groups) and the socket's path (default `/var/run/docker.sock`). |
| `LH_TRUST_PROXY` | gateway, every copy | `1`: the client's address is the last `X-Forwarded-For` entry, which Caddy writes. |

**Three secrets in `deploy/.env`,** made once by `deploy/make-secrets.sh`: `LH_GATE_SECRET` (the owner's copy), `LH_MAKER_TOKEN`, `LH_RELAY_TOKEN`; plus `LH_DOCKER_GID` (not a secret). An account copy's secret is made by the maker and kept in the gateway's file.

### The copy behind the gateway

- **The whole gate** is "does `X-LH-Gate` equal the secret, and does the scope fit the path" (above), for pages, APIs and files alike. `proxy.ts` and `src/server/api-gate.ts` needed no change (they call `serverGate`).
- **The copy's own account routes and pages answer 404** (`/login`, `/setup`, `/api/server-auth/login|setup|logout|account|password|sign-out-everywhere`); no setup code is printed; **`server-login.json` is left as it is**, password included, so taking the gateway away gives the old login back.
- **`/api/internal/*` exists only here** (404 on a desktop app or a single-copy server, signed in or not). `POST /api/internal/unpair-all` (`unpairAllResponse`, `app/api/internal/unpair-all/route.ts`) removes every paired desktop app of this copy; it needs the secret and scope `internal`.
- **`signedIn`** returns a boolean now and, behind a gateway, means "the secret and scope `session`" (the gateway checked the login). That is what keeps the copy's own `desktopsResponse` (pairing codes, removing a PC) working. `pairResponse` doesn't ask for a password behind a gateway.
- **Why a secret although copies are on separate networks:** programs in one person's copy (the teacher's tools, a coding question's test program) could otherwise call another copy over Docker's network. The network is the first lock, the secret the second.

### Sign-in, sessions and the lockout

- **Sign-in** (`signIn` in `src/core/accounts.ts`): name and password. A wrong name and a wrong password are one answer and cost the same (an unknown name still verifies a real scrypt hash of a password nobody has). **Paused** and **removed** are told only after a correct password. An account being made (no copy yet) or `deleting` reads as no account.
- **The cookie** keeps its name and rules (`__Host-lh_session`, HttpOnly, Secure, SameSite=Lax; only a hash stored) and is set once with a 180-day lifetime; **the gateway decides how long it counts**: 30 days from the last use, never past 180 days from the sign-in (`sessionExpiry`; Caddy's `forward_auth` can't hand a fresh cookie back, which is why the cookie isn't re-issued). An account keeps at most 50 sessions. **One browser holds one account:** signing in or redeeming an invite ends the session that browser already had.
- **`lh_owner=1`** is a plain marker cookie set at the owner's sign-in and cleared at a member's and at sign-out. It decides only whether the Accounts row shows; the gateway checks the role.
- **`Clear-Site-Data: "cache"`** on every answer that starts or ends a sign-in, so a shared browser doesn't show the next person pages cached from the previous person's copy. (A ruling; see below.)
- **The lockout** is the existing one (5 wrong tries from one address pause sign-ins from it for 15 minutes, doubling up to 24 hours), one per address for passwords, invite codes, reset codes and recovery codes, with these additions (rulings below): a success clears an address's failures only when all of them were password tries against that same account; IPv6 addresses count by /64; the table holds 5,000 entries and never drops one that is locked or recent; when it is full, attempts from addresses with no entry pause for 60 seconds; wrong reset or recovery codes are also counted per account (10 in 24 hours block code resets of that account, from any address).
- **The client's address** is the last `X-Forwarded-For` entry (`LH_TRUST_PROXY=1`); Caddy has no trusted proxies and writes the peer's address itself.

### Invites, lifecycle and deletion

- **An invite** (`createInvite`): once, 7 days, at most as many waiting as there are free slots; the code is shown once. **The cap** counts active and paused accounts, the owner's included.
- **Redeeming** (`inviteRoute`, `reserveMember`, then `makeReservedCopy` in `gateway/lifecycle.ts`): (1) one write checks the code (a wrong one counts toward the lockout), the cap, the name and the password, consumes the invite, and creates an active member with a fresh tag and **no copy yet**; (2) the maker is asked for the copy with `fresh: true`; (3) one write saves the copy's address and secret and signs the person in; the answer carries the four recovery codes, once. If the maker says the tag's volume or container exists (a lost state file), another tag is tried (up to 5). If making the copy fails or its outcome is unknown, the invite is given back and the reservation abandoned (below).
- **One account's steps run one at a time** (`serial`): an owner's action, a redeem and the loop never interleave on one account. **A state change that must survive a crash is written before the maker is asked** (`deleting` before the copy and volume go; `copyPending` before a copy is (re)created).
- **Pause** ends the account's sessions and stops the copy; the slot stays taken. **Resume** starts it (re-creating it when it is missing). **Remove** ends sessions and reset codes, removes the container and network, keeps the volume; the slot is free at once; the name stays taken. **Restore** (a slot must be free; taken in the same write as the check) re-creates the copy on the same volume with a fresh secret. **Pause and Remove never unpair desktop apps**: the PC gets 503 and keeps its key, so it carries on after Resume or Restore. A password change, Sign out everywhere, and either kind of reset do unpair (the account is marked `unpairPending` in the same write; the copy is told through the relay, retried at the gateway's start and every 60 seconds; while the mark is set the account's sync requests get 503 and new pairings are refused; the unpair-all waits for pairing forwards in flight).
- **The loop** (`pass` in `gateway/lifecycle.ts`, at the start and every 5 minutes; follow-ups after 30 seconds on a failure): (1) a reservation with no copy after 2 minutes is abandoned; (2) `deleting` accounts are finished; (3) removed accounts past 30 days are marked `deleting` and finished; (4) copies against accounts, from `GET /copies`: a copy of a removed or `deleting` account is removed, a missing one is re-created (only after being missing in two passes in a row, because the maker briefly hides a copy it is swapping), an active account's stopped copy is started, a paused one's running copy is stopped, a copy of no account is left alone (logged once); (5) unpair retries. A maker that doesn't answer means "try again later", never "the copy is gone".
- **Every path to a volume deletion, and its guard.** The only code that deletes a volume is `finishDeletion` (`gateway/lifecycle.ts`, through the maker's `DELETE /volumes/<tag>`):

| Path | How it gets there |
|---|---|
| Owner's **Delete now** | on a removed account only (`deleteNow` → `deleting`) |
| **30 days** after Remove | the loop's step 3 (`dueForDeletion`, `deleteDue` → `deleting`) |
| **Delete my account** | the person's password (`selfDelete`, not for the owner) → `deleting`, signed out in the same write → `deleteSoon` |
| An unfinished deletion | the loop's step 2, for any account already `deleting` |

  - **Guards:** the account must be `deleting`, a member, with a tag; its copy and network are removed first; the volume is removed only when the account isn't marked `keepVolume` and was made (`isReady`); the maker refuses (409) while any container uses the volume; the account's record is **erased only after the maker confirmed**, so a volume is never forgotten and never deleted on a guess. A call names only a 3-character tag and the maker derives `lh-acct-<tag>-data` itself, so no other volume can be named. The owner's account can't be paused, removed or deleted by any of these.
  - **An abandoned reservation** (`abandonReservation`: the copy couldn't be made, or its outcome is unknown) removes the container and network and **keeps the volume** (`keepVolume`), because a volume under that tag may not be this attempt's own. The record stays `deleting` (no slot, no sign-in, name and tag kept) until the leftovers are gone, then is erased. Orphan volumes can pile up this way and need pruning by hand.
- **The owner's reset code** (`issueResetCode`): once, 24 hours, replaces an older one for that account; the owner never learns the person's password and opens nothing of theirs. Using a code (either kind) ends every session of the account and unpairs its desktop apps; a paused account stays paused; a removed one is refused.

### The screens

- **The owner's Settings → Accounts** (`components/settings/accounts-section.tsx`, `AccountsSection`; wording in `src/core/account-screens.ts`): three groups (Accounts with a ⋯ menu per account, Invite codes, Removed); the four confirm boxes and the invite and reset code boxes are on the host's dialog layer, and the two code boxes close only with their button. The list is read when the section opens and every 10 seconds, and every answer carries the fresh view. A **row under Account** on a computer and a tablet (`SECTIONS` in `settings-dialog.tsx`, `UsersIcon`; shown when `!phone && isServerMode() && isOwnerMode()`); **on a phone** the same component is a **second group inside Account**, under a divider (`components/settings/account-accounts-group.tsx`, `AccountAccountsGroup`, `phoneSection`), as Obsidian sits inside Cloud, so the phone's list stays at eight rows. A link to Accounts on a phone opens Account with the group scrolled to the top for 2 seconds or until the learner touches. `components/settings/owner-mode.ts` reads the `lh_owner` marker (nothing asks the server; the desktop app and a single-copy server read false).
- **Each person's Settings → Account** (`components/settings/account-section.tsx`): when the gateway's answer has a `name`, the screen adds "Signed in as …", Recovery codes ("2 of 4 left." and **New recovery codes**, with a password box; the new codes appear in a box that closes only with **Done**), Your data (**Download my data**, a plain link to `/api/account/export`) and, for a member, **Delete my account** (a red text button under a divider, with a password box). `useServerAccount` now also returns `info`, kept in a small module-level store because the dialog hands the section only the device list. A single-copy server's answer has no `name`: nothing is added.
- **Browser storage at sign-out** (`components/settings/sign-out-storage.ts`): at Sign out, Sign out everywhere and Delete my account, behind a gateway, whatever holds a person's words is removed: `lh:notes-expanded`, `lh:notes-split-dismissed`, `lh:notes-open-note:*` (localStorage) and `lh.openingPrompt.*` (sessionStorage). Window positions and view state stay (since the 0.7.0 merge that includes `lh:sidebar-open-folders`, which session-list folders are open, and `lh.graph.folder-filter.v1`, the graph's folder filter: folder ids only). The file lists everything the app keeps in the browser, and a test fails if another file starts using storage.
- **The pages before sign-in** (`gateway/pages.ts`): sign-in, first start, invite, recovery codes (shown right after an account is made), reset. One shell, always the standard dark theme.

### Download my data

- `GET /api/account/export?name=<name>` (`app/api/account/export/route.ts`, `src/server/account-export.ts`), made by the copy itself: **one .zip of its data folder in the folder's own layout**, so it can be put into a desktop app's data folder. **In:** `chats`, `graph`, `jobs`, `settings.json`, `prompts`, `themes`, `notes/sessions`, `plugins-state.json`, `core-plugin-data` (`EXPORT_PARTS`, an allow-list). **Never in:** the sync records, backups, sign-ins and keys, the home folder, the Obsidian vault, the notes settings and pending edits, and `model-catalog.json` (upstream's saved remote model catalog, per device; the allow-list names none of it). Symbolic links and the atomic writers' `.tmp-` files are skipped.
- **The writer** (`src/server/zip-writer.ts`) is ours (no archive library in the repo): streamed (nothing held whole, back-pressure end to end), deflate through `node:zlib`, data descriptors, a central directory; sizes and CRC come from the bytes actually read, so a file that changes while it is read still gives a valid archive. **No Zip64:** above 3.5 GiB or 65,000 files the route answers 413. **One export at a time per copy** (429; a lock older than an hour is ignored). **Files with names that are unsafe on Windows** (control characters, `\ : * ? " < > |`, a trailing dot or space, a device name like `CON`) are **skipped, never renamed**, and counted in `skipped-files.txt` inside the archive.
- **404 unless the copy is behind a gateway** (the desktop app and a single-copy server get no new endpoint). The file is named `learnharness-<name>-<date>.zip`.

### Desktop pairing

- **The pairing code says whose copy it is** (decision 7 in the plan). The desktop app's form (address, code, this PC's name) is unchanged and sends the code as typed (up to 64 characters); `POST /api/sync/pair` goes to the gateway, which reads the tag and forwards the body unchanged through the relay (with the copy's secret, scope `sync` and the client's address). The copy checks the code and counts a wrong one in its own lockout; a code of no copy's shape is refused here (401 or 429) and counted in the gateway's lockout.
- **After pairing**, `/api/sync/*` is sorted by the tag in the key. A PC paired **before** the gateway has a 43-character key, goes to the owner's copy and **keeps syncing through the switch-over** without pairing again.
- **A paused or removed account's PC** gets 503 (offline, key kept); **after the account is deleted for good** 401 `not_paired` (the app drops its key).
- **The desktop app's pairing box was widened one step** (`max-w-44` in `components/settings/cloud-section.tsx`; it was `max-w-40`), which the owner allowed: in Chromium's font a 13-character code filled the old box with no room to spare (158 of 158 px, where the font's metrics had given 118 of 138 px).
- Tests drive the real desktop client (`pairWithServer`, `syncRequest`) through the gateway's real functions to the real copy, for the owner's copy and a tagged one.

### Updates and the switch-over

- **`deploy/make-secrets.sh`** (run once from `deploy/`, as your own user, never with `sudo`; it refuses root unless root already owns `.env`): starts `.env` from `.env.example` if there is none, **adds** whatever is missing of `LH_GATE_SECRET`, `LH_MAKER_TOKEN`, `LH_RELAY_TOKEN` (32 random bytes as hex each) and `LH_DOCKER_GID` (the group of the Docker socket; `LH_DOCKER_SOCKET` if it isn't the usual path), never replaces a value, never prints one, keeps `.env` mode 600, and refuses when `.env` is tracked by git. The compose file refuses to start without them.
- **`deploy/update.sh`** (the nightly timer's script) still pulls and runs `docker compose up -d --remove-orphans`. Account copies aren't in the compose file: **the maker brings each one onto the new image when it starts** (stop, re-create on the same volume with the same secret, start; one at a time) and joins Caddy to every account network. So all copies and the gateway always run the same build. `update.sh` restarts the maker itself only when `up -d` did not just re-create it, or when Caddy was re-created (a new Caddy has lost its network joins); a maker that `up -d` re-created has reconciled at its start and must not be restarted while it is swapping copies.
- **The switch-over on the owner's server:** the existing container and volume stay and become the owner's account. After `git pull` (files in `deploy/` changed), `./make-secrets.sh` and `./update.sh`, the gateway has no owner yet and prints a one-time setup code to its log (`docker compose logs gateway`); the owner enters it and chooses a name and a password and is shown four recovery codes. Every browser signs in once more; the paired PC is untouched. A copy of the server's data by hand comes first, as for the 0.6.0 update. The step-by-step guide for the owner is an Artifact page made at the end of the build (outside the repo).
- **The way back:** the previous `deploy/` files and image tag. The owner's copy keeps its own password login untouched (its `server-login.json` was never written), so without `LH_GATE_SECRET` its own gate works again.
- **The owner's copy now has the same limits as an account's copy** (1 GB memory, 2 GB with swap, 512 processes, no capabilities, init) in `deploy/compose.yaml`; a test keeps those numbers equal to the maker's template. See "Rulings made while building (for the owner to review)" below: it ran unlimited before, with "helpers at once" at 8.
- **`reset-password`:** where the image runs a gateway (`LH_GATEWAY_FILE` set: the gateway's container) the command is `lh-gateway reset-owner`; everywhere else it is the single-copy reset as ever (`scripts/server-reset-password.mjs` is unchanged; the choice is in the image's wrapper script).
- **The cap** is `LH_MAX_ACCOUNTS` in `deploy/.env` (4), changed by editing that line and running `./update.sh`.

### Rulings, limits and open items

#### Rulings made while building (for the owner to review)

None of these is approved item by item. Each went the way the plan or the code pointed. The owner has the review page (an Artifact page), which lists the main ones under "Added or decided while building", and gave the word to ship without commenting on them.

- **The server's `reset-password` behind the gateway** is `lh-gateway reset-owner`, through a loopback-only control route on the running gateway (the state file has one writer; with nothing listening the command changes the file itself). It signs the owner out everywhere, clears the lockouts and prints the owner's name and a one-time reset code (24 hours) to use at "Forgot your password?"; with no owner yet it prints a fresh setup code. Today's command wipes the password and prints a setup code, and the first-start page exists only while there is no owner.
- **The owner gets 4 recovery codes at the first-start claim**, shown on the recovery-codes page. The plan gives the owner recovery codes; the first-start page's approved words don't mention the page that follows.
- **New recovery codes made in Settings** are shown in a box that reuses the recovery-codes page's words, closed with **Done**. The invite-code and reset-code boxes and this one close only with their button (Esc and a click outside do nothing), because the code can't be shown again.
- **Words that had no approved sentence:** "Never signed in" (an account with no last-seen time); "Signed in now" for a member (the plan's example is the owner's "Owner · signed in now"); a **Try again** button when the Accounts list fails to load; the reserved-name sentence reused on the first-start page; the lockout sentence follows today's `formatWait` output ("15 min"), where the plan quotes "15 minutes"; `ACCOUNTS_FILE_DAMAGED_PLACEHOLDER` ("The accounts file on this server is damaged. See the server guide."), marked `TODO(owner wording)` in `src/core/account-screens.ts`; the terminal lines of `reset-owner` and of a damaged accounts file. Bare `code` answers with no sentence show the app's generic line.
- **"Signed in now"** means a session used in the last 10 minutes (`SIGNED_IN_NOW_MS`, twice the 5-minute stamp resolution).
- **Sign-in hygiene for a shared browser:** `Clear-Site-Data: "cache"` on every answer that starts or ends a sign-in.
- **The lockout's additions** (listed under "Sign-in, sessions and the lockout" above): the plan approved one lockout per address; the builder added the rules for when a success clears failures, /64 grouping, the table's size and its 60-second full-table pause, and the per-account count for wrong codes.
- **An unfinished new account** (its copy not made yet) can't sign in, isn't listed and no operation applies to it. If making the copy fails or its outcome is unknown, the reservation is abandoned **with its volume kept** (never deleted on a guess), so orphan volumes can pile up and need pruning by hand.
- **The accounts file is backed up daily** beside itself, a missing file with a backup reads as damaged, and **while no owner exists, tagged device keys and pairing codes answer 503, never 401**, so a lost file doesn't make members' PCs drop their keys. An untagged key or code always goes to the configured owner's copy, also before the owner has claimed the gateway, so the PC paired today keeps syncing through the switch-over.
- **Download my data limits:** refuses (413) above 3.5 GiB or 65,000 files (no Zip64); one at a time per copy (429); unsafe-for-Windows names skipped, not renamed, with a count in `skipped-files.txt`.
- **Browser storage at sign-out** clears the four keys listed above; view state stays, the two folder keys of the 0.7.0 merge among it (`tests/sign-out-storage.test.ts` carries them).
- **The desktop app's pairing box was widened one step** (above), which the owner allowed.
- **Delete my account** sits at the bottom of Settings → Account as a red text button under a divider.
- **The owner's own copy gets the account copies' limits** (1 GB, 2 GB with swap, 512 processes, no capabilities, init) in `deploy/compose.yaml`. The plan sets the ceiling per copy; the owner's copy ran unlimited before, with "helpers at once" at 8, so the switch-over guide tells the owner to lower that to 3 by hand. **For the owner to confirm.**
- **Changes to the build guide's contract** (each is marked in `docs/fork/plans/multi-account-build.md`): the network layout (nothing but Caddy reaches the gateway; no copy shares a network with another); the relay; `X-LH-Scope`; Caddy stripping the session cookie, refusing `Service-Worker`, `admin off` and failing closed; the maker's `start: false` and `fresh: true`, `GET /volumes`, the swap that keeps the old container until the new one runs, waiting for work on SIGTERM, `Init`, a log bound and `User: node` in the template, Docker Engine API 1.44, and socket access through `group_add` (`LH_DOCKER_GID`); the three secrets; `update.sh`'s rule for restarting the maker.
- **The unpair-all rule.** The guide's contract said the gateway calls unpair-all after Pause and Remove; the plan says a paused or removed account's desktop app keeps its key and carries on after Restore. Built as the plan says (Pause and Remove end browser sessions only), and the guide's sentence is corrected.
- **The Windows workflow's cloud-sync test step** also runs `accounts-core`, `accounts-ui`, `account-own-ui` and `sign-out-storage` (pure rules and screens the desktop app's bundle carries too; the gateway, the maker and the copy's gate are Linux-only).
- **Seen in the run, for the owner to review:**
  - "Last seen today, 04:40 AM" and "Removed Nov 15 · deleted for good on Dec 15": dates and times follow the device's own format (`dayText`, `dayTimeText` in `src/core/account-screens.ts`), as the sync screens do; the approved examples read "9 Nov, 18:20".
  - On a computer the Accounts page's heading is followed by a group also headed "Accounts" (the approved group name).
  - The desktop app's pairing box fitted a 13-character code with no room to spare in Chromium's font (158 of 158 px). It was then widened one step (`max-w-44` in `components/settings/cloud-section.tsx`), which the owner allowed; the screenshot predates that.
  - `reset-password` unpairs the owner's desktop apps when its code is used (a reset does).

#### Open for the owner

Not built; each is a decision for the owner.

- **Asking for the owner's password again on Reset, Remove and Delete now.** All copies share one origin, so a tab left open from a member's copy in a browser the owner then signs in on could call the owner's Accounts routes (the routes check the session's role, not where the page came from). A password box on those confirm boxes would close that; the approved confirm boxes have none, so it changes approved screens.
- **A firewall rule on the server: built, then declined** (the owner: "i dont really want the firewall"). Not open any more; the record, with the trial the owner saw first, is "The host firewall: built and checked, then declined" in `docs/fork/history/server.md`.
- **Each password check holds the gateway's one thread briefly** (scrypt, as on a single-copy server today): a flood of sign-in tries slows the site for everyone. The lockout bounds one address, not many.
- **The owner's Reset is, by design (plan decisions 6 and 8), the power to set a member's password.** It signs the member out and unpairs their desktop apps, which is how the member can tell. Recorded here so the owner can confirm they accept it.
- **The four first values** (4 accounts, 1 GB per copy, 2 GB of swap, 3 helpers at once) are approved as first values to tune on the real server ("Still for the owner, after the build" in `docs/fork/plans/multi-account-plan.md`).

#### Known limits

- **All accounts share one origin.** Browser storage and cookies are shared by accounts that use one browser (hence the clearing at sign-out); no service worker is allowed; a tab left open from one account is a page on the same origin as the next ("Open for the owner" above).
- **Next's standalone output carries the whole source tree** (tests, docs, `deploy/`), so the gateway's source files ride along unused in the Windows app and in the server image. `next.config.ts` warns that tracing exclusions break the app in non-obvious ways, so nothing was changed.
- **Orphan volumes** can pile up (an abandoned reservation keeps its volume) and are pruned by hand.
- **Copies can reach the internet and the host's other services,** the provider's metadata address included; the owner's copy always could.
- **A copy that passes its memory ceiling** should be restarted alone by its restart policy (`unless-stopped`); not seen. How four copies behave in 4 GB with real lessons is unknown.
- **A restore of the accounts file from its backup** loses what happened since the backup (up to a day). The file is the only record of who owns which copy.
- **The gateway is one process with one thread** (scrypt checks hold it briefly).
- **No usage per account, no renaming, no sleeping copies, no own address per person** ("Not in the first version" in `docs/fork/plans/multi-account-plan.md`).
- **A stack started from the files before the fixed network names** (`<project>_front`, only ever in the development sandbox and in CI) gets new networks at its next `up`, and its containers are re-created on them (not tried; the sandbox and CI start fresh). The owner's server goes from the single copy's default network to these names at the switch-over; its old `deploy_default` network can be left behind, unused (`docker network prune` removes it).

#### What only the real server can show

- Docker's limits and per-copy networks on the owner's VPS (Docker 25 or newer), and how four copies behave in 4 GB with real lessons.
- Caddy's certificate for the real domain and the one address staying as they are through the switch-over; HTTP/2 and HTTP/3 clients (slice 0's proofs ran over plain HTTP, the real-stack runs on Caddy's internal CA).
- Claude Code and `ob` installing themselves under the limits, and Chromium starting in a hardened copy (`--no-sandbox`, all capabilities dropped): the sandbox image had no curl, Chromium or fonts, and its copies' background installs failed.
- Claude and ChatGPT sign-ins made from an invited copy (both blocked in the development sandbox).
- A second person's desktop app pairing over the internet, and the owner's own PC carrying on through the switch-over.
- The home-screen app through the gateway (cookie, manifest, icon) on the owner's iPhone.
- The nightly update on a server with several copies (the maker's swap, `update.sh`'s rule).

### Code and tests

#### Code map

| Where | What |
|---|---|
| `src/core/accounts.ts` | The pure rules: the state and its parser, names, tags, the lockout, invites, sign-in, sessions, reset, the owner's actions, `resetOwnerAccess`, the views. Bundled into the gateway; imports only `./server-auth.ts`. |
| `src/core/account-screens.ts` | The approved words (import-free and browser-safe; a test reads the source to keep it so). Exported through the core barrel. |
| `gateway/config.ts`, `state.ts`, `gate.ts` | The settings, the state file, the `/gate` decision. |
| `gateway/routes.ts`, `account-routes.ts`, `owner-routes.ts`, `pages.ts` | The routes (sign-in, setup, pairing forward; invite, reset, recovery codes, delete; the owner's) and the pages. |
| `gateway/lifecycle.ts`, `copies.ts`, `maker-client.ts`, `control.ts`, `main.ts` | The lifecycle loop and every step on an account's copy; the relay and the unpairer; the gateway's side of the maker's API; `reset-owner`; the listener and `lh-gateway`. |
| `gateway/maker.ts`, `docker.ts`, `maker-main.ts` | The maker, its Docker Engine client over the socket, and its entry file. Imports nothing from `src/`. |
| `src/server/server-auth.ts` | `behindGateway`, `gatePasses`, `gateScopeOf`, `gatewayGate`, `unpairAllResponse`, `signedIn`. |
| `src/core/sync/devices.ts`, `src/server/sync/http.ts` | Tags in pairing codes and keys; `accountTag`. |
| `src/server/account-export.ts`, `zip-writer.ts`, `app/api/account/export/route.ts`, `app/api/internal/unpair-all/route.ts` | Download my data; the copy's internal route. |
| `components/settings/accounts-section.tsx`, `account-accounts-group.tsx`, `owner-mode.ts`, `account-section.tsx`, `sign-out-storage.ts`, `settings-dialog.tsx` | The screens ("The screens" above); the dialog edit is marked in the file. |
| `Dockerfile`, `scripts/build-gateway.mjs`, `deploy/compose.yaml`, `Caddyfile`, `make-secrets.sh`, `update.sh`, `docker-entrypoint.sh`, `.env.example` | The image's two extra programs and wrapper scripts; the stack; the seed of "helpers at once". |
| `deploy/test/crossing.mjs`, `deploy/test/README.md` | The crossing tests against a running stack (`--list` prints what it tries and touches nothing). |
| `.github/workflows/server-image.yml`, `side-tutor-windows.yml` | The new "Multi-account stack and crossing tests" step after the single-copy smoke test; the Windows step's wider test list. |

#### Tests

Run one file at a time (`NODE_ENV=test npx tsx --test tests/<file>`).

| File | Covers |
|---|---|
| `tests/accounts-core.test.ts` | The pure rules and the approved words; every state passed in is deep-frozen. |
| `tests/gateway-gate.test.ts` | `/gate` in its order and every branch; the small rules repeated from the copy compared with the copy's own. |
| `tests/gateway-routes.test.ts` | Sign-in, the first start, sessions extended by use and ended (a moved clock), the lockout, same answer for a wrong name and a wrong password, sign-out, password change and the unpairing it owes, the pages and manifest, a damaged file, the file's mode, the listener. |
| `tests/gate-secret.test.ts` | A copy behind the gateway: the secret, the scopes, the copy's 404s, no setup code, `/api/internal/*`. |
| `tests/sync-tags.test.ts`, `gateway-sync.test.ts`, `gateway-sync-tagged.test.ts` (+ `helpers/gateway-sync-harness.ts`) | Tags in codes and keys; the real desktop client through the gateway to the real copy, the owner's copy (a PC paired before the gateway carries on) and a tagged one (Pause → offline with the key kept, deleted → drops it, another account's cookie or tag never reaches it). |
| `tests/maker.test.ts` | The fixed template, the tag check, the token, call sequences, the re-create on a new image, against a stand-in Docker API on a socket. |
| `tests/gateway-invite.test.ts`, `gateway-accounts.test.ts`, `gateway-lifecycle.test.ts`, `gateway-reset.test.ts` (+ `helpers/gateway-fakes.ts`) | Redeeming (the maker failing, losing its answer or hanging; two redeems of one code; the last slot); every owner op; every branch of the loop; reset, new codes, Delete my account and `reset-owner`. |
| `tests/gateway-review.test.ts` | The security review's findings, end to end. |
| `tests/accounts-ui.test.tsx`, `account-own-ui.test.tsx` | The owner's screen and each person's new parts in the approved words; the row absent for a member and in the desktop app; the phone group; a single-copy server's Account screen unchanged. |
| `tests/account-export.test.ts`, `sign-out-storage.test.ts` | The download (what is in, what never is; read back by a reader written in the test and by `unzip` / Python when present); the storage audit. |
| `tests/deploy-files.test.ts` | The Caddyfile, compose file, entrypoint seed, `make-secrets.sh`, `build-gateway.mjs` and the image's wrappers (shell and YAML nothing else runs). |

The existing tests that guard "unchanged" (`tests/server-auth.test.ts`, `sync-inert.test.ts`, `sync-pairing.test.ts`, `claude-code-status-ui.test.tsx`) stay as they were.

## Updating the server

- **The desktop** keeps updating itself from this fork's releases, as now.
- **The server updates automatically, nightly at 4 am** (the server's system time zone). A systemd timer (`deploy/install-update-timer.sh`) runs `deploy/update.sh`: `docker compose pull`, then `up -d`, which restarts only what changed. It catches up after downtime. `/data` (the vault included) lives on a volume and isn't touched.
- **Updating the server from a phone: an iPhone Shortcut, no button in the app** (owner's choice of three, asked after the scroll-opens-check ship). The app runs in a container and can't restart itself, so an "Update now" button needs a way to the host.
  - **Chosen:** a Shortcut on the owner's iPhone (Apple's "Run Script Over SSH" action) that logs in to the server and starts `deploy/update.sh` in the background. Nothing in the app or in `deploy/` changes. The owner has a set-up guide (an Artifact page). **Set up and confirmed by the owner on the iPhone** ("it worked!"), with the key route.
    - The command it runs: `cd ~/learnharnessSide/deploy && { setsid nohup ./update.sh > ~/lh-update.log 2>&1 < /dev/null & echo "Update started. The site is back in a minute or two."; }`. It answers at once and the update goes on by itself, so a dropped connection can't stop it halfway; its output is in `lh-update.log` in that user's home folder.
    - With a password login the password is kept in the Shortcut. With a key, the guide's line for `~/.ssh/authorized_keys` carries `restrict,command="…"`, so that key can only start the update.
    - **What the set-up met:** the first run shows iOS's "Unknown Host" box with the server's fingerprint (tap Connect; once). Shortcuts reports a refused login as "could not connect to the SSH server". The owner's PC logs in with a key and a passphrase (PowerShell asks "Enter passphrase for key", which is not a server password), so the server takes no password and the Shortcut needed its own key: generated in the action, its public half added on the server from the PC. The key's label is replaced with a plain one in the line, because a phone's name can carry a curly apostrophe.
  - **Not chosen:** a button in Settings that leaves a request file in a folder shared with the host, where a systemd watcher runs the same script (the recommendation: the app could only ever ask for that one script; it needs one set-up command on the host); and a helper container with Docker access (third-party software with full control of the host, one step away from the app's agents).
  - An update that changes files under `deploy/` still needs `git pull` on the server first, by hand.
- **The owner's server follows `LH_CHANNEL=dev`.** To update it right away instead of waiting for the nightly run: `cd ~/learnharnessSide && git pull && cd deploy && ./update.sh`. The `git pull` is needed only when files in `deploy/` changed. After an update, a home-screen app has to be swiped away and reopened to load it.
