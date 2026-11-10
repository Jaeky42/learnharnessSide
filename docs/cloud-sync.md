# Cloud sync: approved plan

Status: **planned, not built.** Work happens on a separate branch. It merges into `side-tutor` only once the whole feature works and the owner approves the merge, because every push to `side-tutor` publishes a release. Change these decisions only with the owner's approval.

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

### Login (VPS)

- Browser mode currently has no authentication (`desktopAPIAuthorized` returns `true` when it isn't the desktop server). The VPS needs a login gate in `proxy.ts` before it's reachable from the internet.
- **Password login.** A session cookie lasts a **fixed 30 days from login** and isn't extended by use.
- Login attempts are rate-limited.
- "Sign out everywhere" in Settings ends every login.
- Desktop sync uses per-device tokens that can be revoked.

### Model sign-in on the VPS

- **ChatGPT** (verified on a VPS: sign-in and a model reply both worked).
  - **The problem:** the OAuth callback listens on `127.0.0.1:<random port>` on the server (`electron/chatgpt.cjs`), so the phone's browser can't reach it.
  - **The fix:** a **"Paste the address you landed on"** box in the sign-in panel. The server forwards the pasted callback URL to its own waiting listener.
  - The 3-minute login timeout still applies, so the panel shows a countdown.
- **Claude (Claude Code CLI).**
  - **The web/phone Settings** get a **Sign in to Claude** button. LearnHarness runs the official `claude` sign-in command on the server, shows the link, and passes the code the learner pastes back to the CLI.
  - **The CLI owns the login.** It keeps its own credentials, and LearnHarness never stores a Claude token.
  - **Disconnect** runs the CLI's own sign-out.
  - **The desktop Settings stay unchanged** ("authenticate in your terminal").
  - Which command to drive (`claude auth login`, preferred because it has a matching sign-out, or `claude setup-token`) is decided in Phase 0.
- Subscription credentials are never copied between devices; each machine signs in on its own.

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

### Phone layouts

- Every view gets a phone layout in v1: teaching sessions, practice sessions, the side tutor and the notes drawer.
- **Side tutor:** a chat bubble in the bottom-right corner of the teaching session that opens the tutor.
- **Notes drawer:** slides in from the right and fills the screen. The owner reviews how this looks before it's settled.

### Hosting

- A small VPS with Ubuntu, Docker and Caddy, plus a persistent volume for `/data` and `/vault`.
- **Provider:** chosen at setup time. Hetzner CX23 is being considered, with DigitalOcean as the fallback.
  - Use **x86**, not ARM, because the native add-ons, the Claude CLI and `ob` are only confirmed on x86.
  - The server needs a **public IPv4** address.
- The server image is built by a **separate** workflow, so it never triggers a desktop release.

### Updates

- **The desktop** keeps updating itself from this fork's releases, as now.
- **The server updates automatically.** It checks for a new server image on a schedule, pulls it and restarts. `/data` and `/vault` live on persistent storage and aren't touched. The check interval is decided in Phase 1.
- **Version rule:**
  - The desktop and server exchange a sync protocol version on every sync.
  - If they don't match, sync **pauses**: the desktop keeps working locally and shows "Update the server to continue syncing".
  - Releases that change a data format are marked, so they're never applied to only one side.
- Multi-user hosting isn't planned. If it's ever wanted, the approach is one container per user on one VPS, with no changes to the single-user app.

## Phases

0. **Checks.**
   - ✅ ChatGPT sign-in and model calls from a VPS (callback replayed by hand).
   - ✅ Graph id and rewrite analysis (above).
   - ⏳ Which `claude` sign-in command the page can drive on a headless server.
   - ⏳ `ob sync-config --excluded-folders` on a real install.
1. **Server mode.** Dockerfile, the `LH_DATA_DIR` volume, the password login gate in `proxy.ts`, Caddy (HTTPS), the server image workflow, and automatic server updates.
2. **Sign-in on the server.** The ChatGPT paste box, plus the Claude sign-in button and Disconnect.
3. **Phone layouts.** PWA manifest; the teaching, practice, side tutor (bubble) and notes drawer (full screen) layouts.
4. **Vault on the server.** The `ob sync` process, setup, and the automatic excluded-folders list.
5. **Sync engine.** The lease API, session sync with take-over and desktop copies, graph line and operation sync, per-key settings merges, and the sync protocol version check.
   - Built as wrapper stores at the composition root (`src/server/stores.ts`) over the `core/ports.ts` interfaces, so upstream store code stays untouched and rebasing onto upstream stays cheap.
6. **Desktop sync UI.** Settings → Cloud (server URL, sign-in, device name, Sync now); a sync status chip; lease state on each session.
7. **Tests and docs.** Lease, take-over and graph operation tests; an end-to-end test with two servers and one cloud; and an update of this file from "planned" to built.
