# Cloud sync

## Architecture and the rules

Goal: keep learning progress on several devices. The Windows desktop app stays fully usable, works offline, and keeps the Obsidian connection. A phone uses LearnHarness from the browser.

### Architecture

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

### Sessions: leases instead of merging

A teaching transcript can't be merged, because two teachers built on the same turn would diverge. So:

- Only the device holding a session's **lease** may continue it. The VPS is the lease authority.
- **A lease never runs out on its own.** Other devices show "Held by Desktop (offline since …)" with a **Take over** button. (Retired by seamless sessions: nothing shows "Held by" or Take over; the lease itself still never runs out.)
- **Take over warns first** when there is evidence that the holder has turns that haven't synced (see "Phase 5 decisions (owner, asked one at a time)" below). (Retired by seamless sessions: nothing warns.)
- **Since seamless sessions (built and shipped):** the lease stays, but nothing shows it. A session moves to the device you start typing on, with no button and no warning, and a PC cut off from the server carries on. See "Seamless sessions" below; it replaces the two bullets above.
- **No copies** (owner's change during Phase 5 planning; it replaces the earlier "Title (desktop copy)" rule). A device that lost a session to a take-over discards its unsent turns for that session when it reconnects and shows the server's version. The loss isn't silent: the desktop shows a heads-up while it works offline, and a notice after a discard.
- An offline desktop can only continue sessions it held before it went offline. (Since seamless sessions a PC cut off from its server carries on with any session, and it is settled at reconnect.)
- A session's notes home folder (`notes/sessions/<chatId>.json`) follows its lease. Its Tutor conversations are inside the chat record since the upstream 0.6.0 merge (`sideChats`), so they travel with it; the separate `side-tutor/<chatId>.json` file is gone.

### Background work

Graph extraction, research, compaction and visuals run on **whichever device holds the session's lease**. Their results sync like other data. This rule prevents duplicate extraction of the same session.

### Data and how each part syncs

| Data | How it's written | How it syncs |
|---|---|---|
| `chats/*.json` | Whole-file rewrite | Lease. The holder pushes whole files with a version number; their pictures travel once, apart from the file (slice 6). |
| `notes/sessions/<chatId>.json` | Small JSON | Follows the chat's lease |
| `jobs/<jobId>.json` (helper jobs; each names its `chatId`) | Whole-file rewrite | Follow the chat's lease, inside its session |
| `graph/*.jsonl` | Mostly appends, with some rewrites (see below) | Appends as lines; rewrites as replayed operations |
| `sources.json`, positions, `settings.json` | Read-modify-write maps | Last writer wins per key; device-specific keys excluded |
| `prompts/**` (prompt override texts), `graph/render-settings.json` (the graph view's sliders), `graph/source-organization.json` (chains-view folders) | Files and maps | Item by item, latest change wins (slice 5) |
| `themes/<id>.json` (imported themes; never the built-in ones) | Whole file per theme | Item by item, one theme each, latest change wins; removing one removes it on both ("Appearance is per device" below) |
| `core-plugin-data/flashcards/flashcards.json` (Flashcards' library; since Flashcards sync) | Whole-file rewrite by the plugin | Item by item, latest change wins per item; schedules never travel and are worked out again from the combined reviews (see "Flashcards sync" below) |
| The other plugins' data, which plugins are on, Flashcards' model choice and its uploaded files' text | Per device | Never synced |
| `notes/settings.json` (vault path), `notes/pending/` | Per device | Never synced |
| `obsidian-sync.json` (the server's Obsidian sync record) | Per device | Never synced |
| `auth.json`, subscription credentials, model caches | Per device | Never synced |
| `sync/` (sync's own state on each side) | Per device | Never synced |

### Graph sync

- **New ids** are random (`n_` / `arg_` plus 12 hex characters, `src/core/graph.ts`), so ids don't collide across devices.
- **The ledgers are not purely append-only.** Session deletion, chain deletion and notes-source removal call `rewriteLedgers` (`src/core/graph-deletion.ts`, `src/core/graph.ts`). Combining lines from both devices would bring deleted data back. Instead:
  - appended lines sync as lines;
  - destructive changes sync as **operations** (for example "delete session X, mode delete-nodes") that each device replays. The deletion code is deterministic and idempotent, so replaying it is safe.
- **Known limit:** whether a new concept matches an existing node is decided by the AI against the *local* graph. If two devices extract different sessions while out of sync, the same concept can end up as two nodes. This is accepted for v1. A merge pass may come later.

- **The engine must do nothing where no desktop is paired.** Every change that ships reaches the owner's real server at the nightly update, so a server with no paired device, and an app that isn't paired, must leave the data folder byte for byte as it is. A test pins this.

### The owner's decisions and approved words

#### Phase 5 decisions (owner, asked one at a time)

1. **Signing in: a pairing code.** The server's site (Settings → Account, signed in) shows a code that works once, for 10 minutes. The desktop app takes the server address and the code and gets its own device key. The key works only for the sync API, is stored on the server only as a hash, and never involves the server password.
2. **Pairing lasts until removed.** No time limit. A desktop is unpaired by its own Remove button, and also by Sign out everywhere, a password change and `reset-password`, as those sign out every other device. Unpairing deletes nothing on the PC. A new code reconnects it as the same device, with whatever it hadn't synced. (Phase 6 added the PC's own **Unpair this PC**; see there.)
3. **Trying the desktop side: two server copies only.** No desktop test build and no run from source. One copy plays the desktop and one plays the server, in automated tests and browser runs. The owner tries nothing on the PC before the merge, so **sync must stay off in the app until it is paired**, and an unpaired app must behave exactly as today.
4. **First sync: combine both libraries.** Pairing deletes nothing. Desktop sessions go up and cloud sessions come down, each still held by the side it came from. The graphs are joined; a concept learned on both sides before pairing shows twice (the known limit).
5. **A backup once per side**, right before that side's first sync: a dated folder under `backups/` beside the data folder (sessions, graph, side-tutor threads, jobs, settings; no credentials, not the vault). Restored by hand with a guide. (Since the upstream 0.6.0 merge no side-tutor threads, which are inside the sessions; see "Backup contents" below.)
6. **Take over warns only on evidence** (retired by "Seamless sessions": the page always asks with `force`, and nothing warns; the server's rule itself is unchanged). The server keeps, per session, when the holder last checked in and its last word. Warn when that was "busy" or "unsent", or the holder went silent in the middle of a reply. If it was "all sent", no warning, even if the holder has been offline since. An online holder is asked to hand over and no warning is needed.
7. **No copies** (see "Sessions: leases instead of merging" above).
8. **The gap that leaves** (a desktop that said "all sent", went offline and was then used offline): while it can't reach the server, the desktop shows a heads-up in a session being continued; after a discard it shows a notice naming the session and the number of turns. Both screens are Phase 6; Phase 5 supplies the facts.
9. **A busy online holder at take-over:** the reply being written finishes and is sent. Background helpers (research, demo, visual, PDF) stop there and start again from the beginning on the new holder. Extraction stops and the new holder redoes it later.
10. **A held session is read-only until taken over** (retired by "Seamless sessions": every action moves the session here first; the server still refuses a write from a device that doesn't hold it). Reading it, the notes drawer and moving it between folders work. Sending a message, the side tutor, renaming, changing its model and deleting wait for Take over.
11. **Timing:** a session is sent about 2 seconds after a change; the desktop tells the server when a reply starts and ends; it asks the server for news every 10 seconds; a full sync at app start; quiet retries while offline, slowing to once every few minutes. There is no "final sync on quit" (on Windows the local server is killed at once).
12. **Settings split.**
    - Synced, latest change wins per setting: dictation language, graph (extraction on/off, rendering on/off, chunk size, the graph view sliders), compaction threshold, agent (tool switches, search engine, prober graph tools), and prompt overrides (the texts and their switches).
    - Per device, never synced: model slots and per-role model overrides, the custom provider, the Claude Code switch, file-access folders, the reading font, automatic updates, keyboard shortcuts, keys and sign-ins.
    - **Appearance is per device** (owner's change, after the phone plugins round; it synced until then): everything on Settings → Appearance. The theme, the colour overrides, the background, the reading font size, code ligatures, serif session names, heading weight, and the bold and italic colours. Imported theme files still sync. See "Appearance is per device" under "Settings and the other small files" below.
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
- **Backup contents:** sessions, graph, side-tutor threads, helper jobs, settings, prompt overrides and the notes home-folder records. (Since the upstream 0.6.0 merge: custom themes, the plugins' on/off record and the core plugins' data too, and no side-tutor threads, which are inside the sessions now. With Flashcards sync, a second backup of Flashcards' folder alone, right before each side's first Flashcards exchange: "Flashcards sync" below.)
- **While sync is paused** (versions differ, or unpaired) nothing is discarded; it resumes where it stopped.
- **Device names and the wording of every message** ("Held by Desktop", the warning, the heads-up, the notice) are asked in Phase 6 with the screens. Phase 5 stores a name per device and the facts each message needs. (Asked and approved in Phase 6; seamless sessions later retired "Held by Desktop" and the warning.)

### Rulings, limits and open items

#### After the merge

- **Restoring a first-sync backup** (`%APPDATA%\LearnHarness\backups` on the PC, `/data/backups` on the server) has no written guide. Putting old files back while paired would sync the old state everywhere: unpair first, and write the steps for the situation at hand. (With Flashcards sync, Flashcards' library put back deletes nothing anywhere; "Restoring a backup" under "Flashcards sync" below.)
- **Not done:** Phase 7 (one automated test with two desktops and a server syncing everything together; a tidy of this file). The owner chose to merge without it.

## Pairing, device keys and the version check

### Phase 5: what is built

**Slice 1: pairing, device keys, the version check**

- **On the server** (server mode only; everything answers 404 without it):
  - `POST /api/server-auth/desktops` (a signed-in browser): `{op:"code"}` returns a pairing code and when it runs out; `{op:"remove", id}` unpairs one desktop. `GET /api/server-auth/account` now also returns `desktops` (id, name, paired and last-seen times; never a key).
  - `POST /api/sync/pair` (a desktop app): `{code, deviceId, name}` returns the device key, once.
  - `POST /api/sync/hello` (a paired desktop): the protocol check; answers the server's clock too.
  - Paired desktops and the waiting code live in `server-login.json` (`devices`, `pairing`), as hashes. `reset-password` writes a fresh file, which unpairs every desktop.
- **The gate** (`syncGate` in `src/server/server-auth.ts`): `/api/sync/*` opens to a device key in `Authorization: Bearer …` and to nothing else. The login cookie does **not** open it, and a device key opens no other path. A request that names another site (`Origin`, or `Sec-Fetch-Site: cross-site`) is refused. `/api/sync/pair` passes the gate without a key; its route checks the code and the lockout.
- **The version rule** (`src/core/sync/protocol.ts`): the desktop sends `x-lh-sync-protocol` on every request. Unequal → 409 `protocol_mismatch` with the server's number; the desktop then shows the approved sentence for the side that is behind. A server too old to have the sync API at all counts as behind.
  - **The number is 3 today** (`SYNC_PROTOCOL_VERSION`): 1 in release 0.5.6, 2 from the upstream 0.6.0 merge, 3 since Flashcards sync. Both sides must be updated together, the server first, whenever it rises.
- **On the desktop** (`src/server/sync/client.ts`): `pairWithServer`, `contactServer`, and `syncRequest`, the one function every later sync request goes through. It handles the three shared outcomes: the server unpaired this desktop (the key is dropped, the device id and address kept, so a new code reconnects it as the same device), the versions differ (paused), the server can't be reached (offline; never unpairs).
  - `GET /api/cloud` returns this copy's state: `off` (never paired), `starting`, `ok`, `offline`, `paused` (with the sentence), `needs-pairing`. `POST /api/cloud` takes `{op:"pair", server, code, name}` and `{op:"check"}`. On the cloud server `GET` answers `{role:"server"}` and `POST` 404. Phase 6's screens call this (it was built before them).
  - A desktop sends its device id only to the server it was paired with; another address gets a fresh id.
- **Nothing runs where nothing is paired:** an app with no `cloud-sync.json` makes no request and writes no file.

### Engine changes made for Phase 6 (the owner was told before each)

1. **A PC can remove itself.** `POST /api/sync/unpair` (a paired desktop's key): the server removes the device and takes the sessions it held as its own (`releaseDevice` in `authority.ts`). No protocol check, so a PC can leave a server it no longer speaks to.
2. **Only the first PC brings its settings** ("Settings and the other small files" below; `later` in `maps-sync.ts`).
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

### Rulings, limits and open items

- **Wording added while building, for the owner to review in Phase 6** (since Phase 6 the pairing form shows a refusal in these words; the owner confirmed them with the Phase 6 plan page): "That pairing code isn't right, or it has run out. Get a new one from the server's site.", "This server already has 10 desktop apps paired. Remove one first.", "This server isn't set up yet. Open its site and choose a password first.", "That desktop app isn't paired any more.", "This desktop app isn't paired with this server.", "Couldn't reach that server. Check the address and your connection.", "That address didn't answer like a LearnHarness server.", "Enter your server's address.", "The server's address must start with https://", "Give this desktop a name of up to 40 characters.", "Enter the pairing code from the server's site."

### Code and tests

- **Code:** `src/core/sync/{protocol,devices,address}.ts`, `src/store/sync/pairing.ts`, `src/server/sync/{http,client,cloud-http}.ts`, `app/api/sync/{pair,hello}`, `app/api/server-auth/desktops`, `app/api/cloud`; changes in `src/core/server-auth.ts` (the state's `devices` and `pairing`), `src/server/server-auth.ts` (the gate, the account data, unpairing on a password change and Sign out everywhere), `src/agent/tools/fs-shared.ts`, `scripts/server-reset-password.mjs`.
- **Tests:** `tests/sync-pairing.test.ts`. One process plays both sides: the desktop's client is given a `fetch` that delivers to the server's gate and routes.

## Sessions and leases

**Slice 2: sessions and leases**

- **A session travels whole**, as the exact text of its files: `chats/<id>.json`, `notes/sessions/<id>.json`, and every `jobs/<jobId>.json` whose `chatId` names it (`src/store/sync/session-files.ts`; `side-tutor/<id>.json` travelled too until the upstream 0.6.0 merge). Both sides end with the same bytes.
- **The server is the lease authority** (`src/server/sync/authority.ts`, state in `<data>/sync/authority.json`). Per session it records the holder (a device id, or `cloud` for the server's own), a version, and the holder's last word. Only the holder's send is accepted; any other device gets 409 `lease_lost` with the current state.
  - The server's own changes (what the phone does) are found by comparing file stamps (times and sizes), then content digests, whenever a desktop asks for news. Nothing in the server's own write path was changed for that.
- **A desktop's round** (`src/server/sync/desktop-sync.ts`, state in `<data>/sync/desktop.json`): ask what changed since its place in the server's list and fetch those sessions; send the sessions it holds that changed and the new ones it made; report sessions it deleted. `POST /api/cloud {op:"sync"}` runs one round (the timed rounds come with slice 6).
- **Routes for a paired desktop:** `POST /api/sync/sessions` (what changed since `cursor`; also carries the holder's reports), and `GET | PUT | DELETE /api/sync/sessions/<id>`.
- **The first sync is nothing special:** every session here that the server doesn't know is new and goes up, held by this desktop; every session there comes down, held by whoever holds it. The backup is made first, once per side (`src/store/sync/backup.ts`); if it can't be made, the sync doesn't start.
  - The same id on both sides before they ever synced (possible only if one side's data was copied from the other): identical files are one session; different files are left alone on both sides and never sent over each other.
- **Read-only until taken over** is enforced in three layers (since seamless sessions no screen offers Take over: the page moves the session to this device first, and these refusals are the net under it; "Seamless sessions" below):
  1. `proxy.ts`: every write under `/api/chats/<id>` answers 409 `session_held_elsewhere` with the holder (`sessionWritePath` in `src/server/sync/engine.ts`).
  2. Where the session id is in the body: the top of `handleChatInput` (before compaction, any write or any model call), the manual extraction route, and `runningWorkBlocker` (deleting through the sources view).
  3. The stores (`src/server/sync/guarded-stores.ts`, wired in `src/server/stores.ts`): a write that still arrives, for example from background work that was running when a session moved, is dropped, never saved.
  - The notes home folder: its route leaves the record as it is on a held session and answers normally, so the drawer keeps working.
  - `recoverStaleJobs` skips sessions this copy doesn't hold, so fetching a session whose helper is still running elsewhere doesn't start it here.
- **While paused, or unpaired by the server,** the desktop still knows which sessions are held elsewhere (its identity is kept in `cloud-sync.json`), so they stay read-only and nothing is discarded. (Since seamless sessions a PC that can't ask the server carries on with one when the learner acts in it, settled at reconnect: "Carrying on" under "Seamless sessions" below.) After the learner's own **Unpair this PC** every session can be continued there (Phase 6, engine change 4).
- **Deleting:** the holder's delete removes the session's files on the server and on every other device at their next round; a deleted id is never accepted again. The graph side of a deletion comes with slice 4.
- **The store wrappers call the inner store's method as it is at that moment**, never a reference taken at wiring time: upstream's tests replace methods on the inner store object.

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

### Rulings, limits and open items

- **Wording added while building, for Phase 6:** "This session is held by another device. Take it over to continue it here." (the 409's text). (It is still the 409's text, `HELD_ELSEWHERE_MESSAGE` in `src/core/sync/sessions.ts`; since seamless sessions no screen shows it or offers Take over: the page moves the session first.)

### Code and tests

- **Tests:** `tests/sync-sessions.test.ts` (an authority and one or two desktops over separate data folders in one process), `tests/sync-sessions-gate.test.ts` (the read-only rule at the real entry points, with this process as a paired desktop).
- **Tests:** `tests/sync-takeover.test.ts` (every path above with one or two desktops), `tests/sync-local-work.test.ts` (the cloud's side against the real turn registry, job aborts and the recovery sweep).

## Seamless sessions

- **Why:** the owner asked what removing "Held by …" would mean, "so that they can seamlessly be continued on another device", and chose to keep the lease underneath and hide it. The lease is still what keeps a session from splitting in two; nothing on screen shows it any more.
- **It replaces** these recorded decisions: "A lease never runs out … with a Take over button" and "Take over warns first" (under "Sessions: leases instead of merging" above), Phase 5 decisions 6 (the warning) and 10 (read-only until taken over), and Phase 6 decisions 8, 9, 10 and 13 (the held strip, the waiting strip, the warning box, the greyed controls) with their approved words. Where the text above describes those, this section is newer.
- **The sync protocol stays 3 and no synced format changed**, so the server and a PC can be updated in either order. An older PC with a newer server, or the other way round, behaves as each build did.

### What was built: the page

- **`components/cloud/session-move.ts`** (fork-owned) is the one place that moves a session:
  - `ensureSessionHere(chatId)` answers `"here"` at once, with no request, when sync isn't in use or the session isn't in the cloud state's `held`. Otherwise it posts `{op:"take-over", chatId, force:true}` to `/api/cloud`. `yours`, `moved` and `continued-offline` mean it is here; `waiting` is asked again every 2 seconds for as long as the lesson is open, with no limit; anything else is a failure. Callers of one session share one move.
  - On arrival it refreshes the cloud state and has the open lesson read its record again; the answer is `"here-changed"` when that read brought message ids the page hadn't shown, or didn't land.
  - **The triggers** (`useSessionMoveTriggers`): listeners on the document, in the capture phase, for `input` and `paste` in a text box or the confidence bar inside the dock or the Tutor's typing row, and for a click on the lesson's or the Tutor's Dictate, an answer option, Cite, Ask and a plugin button. The dictation shortcut starts it too. Focus alone starts nothing; the notes editor, the session-list search and Settings start nothing. A move started this way that fails is silent.
  - `fetchHere` wraps a simple write (rename in the top bar and the session list, delete, the session's model and thinking, the artifact switch, manual extraction, the Tutor's Ask and Retry): move first, then the request. When the move fails it answers a made-up 409 that carries the failure sentence, which is what the delete box and the Tutor then show.
- **`components/session-core.ts`** (upstream's, about 120 lines, each edit marked `FORK (seamless sessions)`): an optional `moveGate` on `SessionModel` runs before `send`, `steer` and the three dismissals, ahead of any optimistic change, so the text stays in the box until the session is here. `here-changed` or `failed` drops the action and keeps the text. An automatic continuation never moves a session.
- **The net:** a 409 whose code is `session_held_elsewhere` (the page's `held` can be up to 10 seconds old) refreshes the cloud state, moves the session and retries the write once. Before, any 409 from a send was taken for "a reply is being written" and retried for 30 seconds.
- **Removed from the page:** the "Held by" line and the greyed Rename and Delete in `components/sidebar.tsx`; the hidden message box, the title's lock and F2's in `components/chat.tsx`; the Tutor's `held` prop (the greyed bubble, the window closing); `components/cloud/take-over-dialog.tsx`. Upstream's `blocked` props on the plugin buttons and the highlight toolbar are kept and passed nothing.
- **The floating box** (`components/cloud/session-strip.tsx`, the file and export keep their names; `app/cloud.css`):
  - the update box's look (`components/update-banner.tsx`: rounded, a border, a shadow, the popover background) and its ✕;
  - at the top of the lesson, 12 px under the top bar, centred, at most 36rem wide and never wider than the lesson less 16 px each side. A zero-height wrapper holds it, so the lesson doesn't move when it appears. It is under the Tutor's window and bubble (`z-20` against `z-30`);
  - it fades in and out over 200 ms with a 6 px slide, at once with reduced motion;
  - **✕ on the heads-up** hides it in every lesson of that window until that trouble next starts (keyed on the kind, and for offline on `sync.offlineSince`); nothing is stored, so a reload shows it again. **✕ on the failure line** clears it;
  - the failure line shows before the heads-up when both apply.

### What was built: the engine (`src/server/sync/desktop-sync.ts`)

- **Carrying on** (`carryOn`): when the page asks for a session and the server can't be asked (the request ends as `offline`, `paused` or `not-paired`), or the server moved the session here but its files couldn't be fetched, that one session is marked provisionally this PC's (`freed: "held"`, `mine: true`, the mechanism "Unpair this PC" already used for every session) and the answer is `{status: "continued-offline"}`. Nothing is marked when the server answered and refused.
- **Settling** (`settleFreed`, step 0 of every round, for each entry with `freed`):
  - not changed here since: it is whose it was;
  - only this PC changed it (the server's copy is still this PC's base): the PC asks for it with `force: true` and sends its version. A holder that is writing a reply is asked again each round;
  - both sides changed it: the server's version, a discard notice, local work stopped, its unsent graph entries dropped;
  - gone from the server: gone here.
- **Never overwriting what this PC didn't see:**
  - a take that didn't settle remembers the server's version at that moment (`asked`). If the server later names this PC with a higher version and a copy that is neither this PC's own nor equal to the local one, the server's version wins (found by the review: a second desktop could add a turn and hand over while this PC waited);
  - a take is kept only when its version equals the version just read; otherwise the next round decides;
  - the fetch-failed case above is decided the same way.
- **Take-back** (`giveUp`, `askBack`): a PC that finds another device holding a session it held reads the server's copy first. If the PC has unsent changes and that copy is still the PC's own, it asks for the session back and keeps its turns; local work is stopped only on a discard. The lost-lease answers to a send go the same way.
- **"This PC's own copy"** is its last agreed digest or one of the last four bundles it sent (`sent`), so a send whose answer was lost isn't taken for somebody else's change.
- **A take-over and a round run one at a time** (`oneAtATime`); they share one state object.
- `asked` and `sent` are new optional fields in `<data>/sync/desktop.json`, each PC's own file, never synced.
- **`force` at settling also applies to sessions freed by "Unpair this PC"** (it was `false`: "nothing is forced"). With no warning anywhere, a take that waited on one would never settle. A ruling made while building, for the owner to review.

### The owner's decisions and approved words

#### The owner's decisions

1. **The session moves to the device you are on by itself**, at the first typed character in one of the lesson's text boxes, or at a press on Dictate. Chosen over "on your first action" and "on opening the lesson"; the owner's words: "takes over when you either start typing or when you click the dictate button".
2. **Any other action that changes the session moves it when pressed** (an answer option, the confidence bar, Next problem, Rename, Delete, a model change, Cite and Ask), and goes through once the session has arrived. Nothing is greyed.
3. **Completely seamless:** "no visual difference between two sessions when either is active". No strip, no "Held by" line in the session list, no greyed controls, and **no warning box**. The owner was told the consequence: one typed character on the phone can take a session from a PC that is offline, and what that PC never sent is discarded when it reconnects (softened by the take-back rule below).
4. **A PC cut off from its server carries on anyway** with a session another device holds (chosen over "the action fails with a message" and over keeping the strip for that case). It is settled at reconnect.
5. **The heads-up is a floating box**, "kinda like" the update box, in the same place: the top of the lesson. Every text that would have been in the strip goes there; the discard notice stays a box in the middle of the screen.
6. **Wording:** "continued" in place of "taken over" in the heads-up and the discard notice, and "any new messages will be discarded" in place of "what you add here now is discarded".

#### The rules approved with the plan

- **Send before the session has arrived:** the text stays in the box with the usual working look and is sent by itself on arrival.
- **Unless the arriving session has turns this page had not shown:** then nothing is sent, the lesson shows the new turns and the text stays in the box. This holds for everything that adds to the transcript (a message, an answer, Next problem, steering, a dismissal). Rename, Delete, a model change, the artifact switch and the Tutor's Ask go through after arrival.
- **Take-back:** a PC that lost a session while it had unsent turns gets it back, with its turns, when the other device added nothing. Before, those turns were always discarded.
- **When both sides added to a session, the server's version wins**, and the PC shows the discard notice.
- **The sync chip and the offline heads-up stay.** The heads-up now shows in every lesson, since every session can be continued.
- **Helpers still restart from the beginning when a session moves** (Phase 5, decision 9).
- **The server still refuses a write from a device that doesn't hold the session** (409 `session_held_elsewhere`), as the net under the page. No screen shows it.

#### The approved words

In `src/core/sync/screens.ts`. Change them only with the owner's approval.

- **The heads-up** (`SYNC_TROUBLE_BOX_TEXT`): "This PC can't reach the server. If this session is continued on another device before it reconnects, any new messages will be discarded." Paused: "Sync is paused. If this session is continued on another device before sync is back, any new messages will be discarded." Removed by the server: "This PC isn't paired any more. If this session is continued on another device before you pair again, any new messages will be discarded." (The owner gave the new ending for the first sentence; the two others follow it.)
- **A move that failed** (`SESSION_MOVE_FAILED_TEXT`): "This session couldn't be continued here. Try again."
- **The discard notice:** title `“Circuits” was continued on another device` / "It was continued on another device while this PC was offline. …" (the rest as before). Several sessions: "Sessions were continued on another device" / "They were continued on another device while this PC was offline."
- **The pairing form's hint** under "This PC's name" (`NAME_HELP_TEXT`; the owner took the suggested sentence): "The server lists this PC by this name: Settings → Cloud." It replaces `Your other devices show it: “Held by Desktop”.` and no longer follows what is typed.
- **Gone:** "Held by …", "Take over", "Take over anyway", "Take this session over first", the two waiting lines, the warning box's text, "Couldn't take it over. Try again." and the three "can't be taken over right now" lines.

### Rulings, limits and open items

#### Rulings made while building (for the owner to review)

- **`force` for Unpair-freed sessions** (above).
- **The ✕'s hidden label for screen readers is "Dismiss".**
- **A move that fails for a session that isn't open** (Rename from the session list) shows nothing; the rename doesn't happen. Delete shows the failure sentence in its box.
- **A session deleted on a PC while another device held it** still comes back at reconnect, as before. Counting a deletion as an unsent change (so that it deletes everywhere when the other device added nothing) was left out: it wasn't asked for.

#### Known limits

- **A move that the lesson's own session-list entry started is dropped when that lesson is left** (`abandonSessionMove` at unmount): the rename then fails with the failure answer.
- **Taking a session from an online PC still takes up to about 10 seconds** (the PC hears of it at its next check), and waits for a reply or a Tutor answer being written there. Typing first usually hides it. A faster hand-over is a separate engine change, not built.
- **The take-back applies only when the other device really added nothing.** After a forced take, the server changes the session by itself when a helper job was still marked running or a result was waiting to be delivered (the stale-job sweep, while a lesson page is open), when the record ended on the learner's message (the page continues the turn), or when a plugin question was pending. Extraction runs only at the end of a turn.
- **A take-over on a PC waits for a round under way**, which can be slow while pictures upload.
- **A discard notice can say that 0 messages were discarded** (a send whose answer was lost, nothing typed since, then the other device added a turn). Nothing is lost.
- **The ✕'s "until the trouble next starts"** is noticed by a mounted box: a pause that ends and starts again while no lesson is open stays hidden.
- **Two devices that are both typing** pass the session back and forth; each hand-over carries the other's turns, and the "turns this page had not shown" rule holds the send back.

**From "What was checked" in `docs/fork/history/cloud-sync.md`**

- **Not run:** the phone's session-list drawer, and the offline box at phone size (it only shows in the desktop app).
- **Not checked at all:** the real Windows app, the real server over the internet, a real model, a real iPhone or iPad, and two real people's timing (both devices typing at once).

## The graph log

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
- **Routes for a paired desktop:** `GET /api/sync/graph?after=<seq>&log=<name>` and `POST /api/sync/graph {after, log, entries}`.
- **`POST /api/cloud {op:"sync"}`** now answers `{round: {sessions, graph}}` (`src/server/sync/round.ts`); since slice 5 and Flashcards sync also `maps` and `flashcards` ("A round" under "Settings and the other small files" below).

### Rulings, limits and open items

- **Known limits:**
  - The same concept learned separately on two devices before they synced is two nodes (accepted for v1; see "Graph sync" above).
  - A crash in the instant between writing an entry down and making the change leaves that one change in the log but not in the ledger. There is no repair pass.

### Code and tests

- **Tests:** `tests/sync-graph.test.ts` (the rules, with each side's graph in memory and real log files), `tests/sync-graph-wiring.test.ts` (the real ledger files and the app's real deletion entry points, this process as the server).

## Settings and the other small files

**Slice 5: settings and the other small files**

- **What travels, one item at a time** (`src/core/sync/maps.ts`; the key's first letter says what it is):
  - `s|…` the synced settings from `settings.json`, each on its own: the approved list (`SYNCED_SETTINGS`), plus every tool switch and every prompt switch (`SYNCED_SETTING_MAPS`). **Nothing else in `settings.json` is ever read or written by sync**: a request that names any other setting is refused whole (except the retired appearance settings, which are accepted and ignored: "Appearance is per device" below).
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
- **A round** is now sessions, then the graph, then these files: `{round: {sessions, graph, maps}}`. (With Flashcards sync, the Flashcards library comes last: `{sessions, graph, maps, flashcards}`; "Flashcards sync" below.)

**Appearance is per device** (owner's change, after the phone plugins round)
- **At the switch nothing changes on screen:** each side keeps the values in its own `settings.json`.
- **Unchanged:** the login and setup pages and the home-screen app's colours follow the server's own theme, as before.
- **How: retired settings** (`RETIRED_SETTINGS`, `isRetiredSettingKey` in `src/core/sync/maps.ts`; `retired` in `ExchangeRules`, `src/server/sync/maps-sync.ts`):
  - a retired setting is still accepted on the wire, so an older build's request isn't refused whole, but it is never read from or written to `settings.json`;
  - **the server** answers "same" to one an older PC sends (so that PC stops sending it), stores nothing about it, and never lists it among what changed;
  - **a PC** never sends one and skips one in an older server's answer;
  - **both forget what they had noted about them**, once (`maps.json`, `maps-desktop.json`). Without that, "the setting is no longer in my files" would read as "it was reset here" and reset the other side's appearance.
  - `appearance.mode`, the key upstream dropped, is retired with the rest.

### The owner's decisions and approved words

#### Appearance is per device

- **The owner's three decisions:**
  1. **Everything on Settings → Appearance is per device:** the theme, the nine colour overrides, the background, the reading font size, code ligatures, serif session names, heading weight, and the bold and italic colours (the reading font always was). The PC has its own look; the server has its own, which the phone and the tablet share.
  2. **Imported theme files still sync** (`t|<theme id>`), so a theme imported on one side can be picked on the other. Removing one removes it on both, and a side that was using it falls back to the default theme.
  3. **No protocol change:** the sync protocol stays 3. The server and the PC can be updated in either order, and sync doesn't pause.

### Rulings, limits and open items

**Appearance is per device**

- **Known gap, accepted by the owner:** an older server whose first desktop is an updated PC (a fresh pairing, or a server that lost its sync records, in the window where only the PC is updated) resets its own appearance to the defaults: the older server's "a setting the first desktop hasn't set goes back to its default". Updating the server first avoids it.
- **A removed theme that the other side was using** (found by the reviewer, for the owner to review): the side that removes it sets its own theme back to the default (upstream's rule); the other side only loses the file. It shows the default theme, with the default card marked in the picker, but its settings record still names the removed theme, so it switches back by itself if a theme with that id is imported again on either side. Before this change the reset travelled too. Left as it is.
- **Traced by the reviewer, not tested:** an older PC's first exchange in pages and its `send_all` against an updated server; an updated PC as a later desktop on an older server; the PC's forgetting done by its offline noting alone, before any round.

### Code and tests

- **Code:** `src/core/sync/maps.ts`, `src/server/sync/{map-views,maps-sync,maps-engine}.ts`, `src/store/sync/vault-folders.ts`, `app/api/sync/maps`, and three small additions to `src/server/obsidian-sync.ts`.
- **Tests:** `tests/sync-maps.test.ts` (the rules; each side's files in memory, real state files, PCs with wrong clocks), `tests/sync-maps-wiring.test.ts` (the real stores and files), and one more case in `tests/obsidian-sync.test.ts` (the real `ob`: announced folders are left out before any of their files arrive).

**Appearance is per device**

- **Tests:** in `tests/sync-maps.test.ts`: an older side meeting an updated one (an updated server with an older PC: ongoing, and a first exchange as the first and as a later desktop; an older server with an updated PC: ongoing), nothing reset on either, the forgetting, an idle round writing nothing afterwards, and a theme file still travelling; with the real files in `tests/sync-maps-wiring.test.ts`.

## Timing, pictures sent once, and the loop

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
  - sessions: the server takes every session it has as its own again. A desktop that held one is refused at its next send, takes the server's version, and shows the discard notice if its own differed. Nothing is lost silently, and the session moves back to the desktop when it is continued there ("Seamless sessions" above).

### Rulings, limits and open items

- **Not verified here:** the real Windows app talking to the real server over the internet (the owner's choice was two copies only; that first happens after Phase 6 and the merge; since then the owner paired the real PC with the real server and reported "everything works!", without saying which screens were tried), and a reply being written while a round runs with a real model (the turn registry and the hand-over rule are tested with the real modules, without a model).

### Code and tests

- **Tests:** `tests/sync-loop.test.ts` (the rhythm, with a simulated clock), `tests/sync-pictures.test.ts` (each picture travels once, in both directions, through a take-over, and a 17 MB one in pieces), `tests/sync-inert.test.ts` (an unpaired app and a server nobody paired with: no request, no timer, no file), and "a round in which nothing changed" in `tests/sync-sessions.test.ts`.

## The sync screens

### Slice 1: what is built

- **Desktop:** `components/settings/cloud-section.tsx`. An unpaired PC asks its own server once, when the section opens; a paired one looks again every 5 seconds while the section is open. After a pairing or an unpairing it tells the page (`announceSyncInUse`).
- **Server:** `components/settings/cloud-server-section.tsx`. The list is read from `GET /api/cloud`; it is checked every 3 seconds while a code is on screen (so a PC that pairs appears and the code box closes by itself) and every 10 seconds otherwise. The code and Remove go to `POST /api/server-auth/desktops`.
- **Wiring:** `components/settings/settings-dialog.tsx` (one `cloud` row; the server's site renders the server section under it, everything else the desktop's).

### Slice 2: what is built (the parts seamless sessions kept)

- **What the pages know** (`components/cloud/cloud-state.tsx`): one `CloudProvider` in the root layout reads `GET /api/cloud` **only where the marker says sync is in use**: at start, on `chats-changed`, on the new `cloud-changed` event, when the live channel reconnects, and every 10 seconds. `useCloud()` gives `role`, `held`, `sync`, `notices` and `refresh`; `useSessionHolder(chatId)` gives one session's holder, or null, and `useSessionHeld(chatId)` only whether another device holds it. An app that was never paired asks nothing (a test pins it).
- **`cloud-changed`** is a new event on the live channel (`src/core/events.ts`), sent after a pairing and an unpairing (`cloud-http.ts`). Slice 3 sends it when the sync state changes too.

### Slice 3: what is built

- **What is off** (`syncTroubleDueIn` and `syncTrouble` in `src/core/sync/screens.ts`, `useSyncTrouble()` in `cloud-state.tsx`): `offline`, `paused` or `needs-pairing`; nothing for `ok`, `starting`, `unpaired` and `off`, and nothing on the server's site. Paused and removed show at once. Offline shows 30 seconds after the first failed attempt (`OFFLINE_QUIET_MS`), or at once when the app hasn't reached the server since it started. The hook sets one timer for the moment the 30 seconds are up.
- **The sync chip** (`components/cloud/sync-chip.tsx`, mounted in `components/sidebar.tsx` between Background agents and Settings): an outline ring (lucide's `CircleIcon`, the Settings gear's weight) and the word, both `text-amber-500`, in the Settings row's own type. A click opens Settings → Cloud. It goes the moment a round reaches the server again.
- **The offline heads-up** is one of the floating box's texts (`session-strip.tsx`, `data-box="sync-offline"`, `sync-paused` or `sync-needs-pairing`): the approved sentence and its ✕, in every lesson. The message box stays. (Until seamless sessions it was a state of the strip, with no button, and a held session kept its own strip: "Seamless sessions" above.)
- **The side tutor's window may cover the strip** (owner's decision). The tutor's window opens at the lesson's top right by default, 12 px under the top bar, which is the height of the floating box (centred, drawn under the Tutor: `z-20` against `z-30`), so at its default place it can cover the end of the heads-up. (Since the upstream 0.6.0 merge the tutor starts minimized; this is about the window once opened.) A version that moved the window below an open strip was built and removed at the owner's word: "it's fine for the tutor window to be able to cover the strip".
- **The discard box** (`components/cloud/discard-notice.tsx`, mounted once in the root layout): reads `notices`, so it shows on any screen as soon as a round discards something, or at the next app start. **Only OK closes it**: Esc and a click outside do nothing, so it can't be lost by accident. OK sends `dismiss-notice` for every notice shown; they stay away at once and don't come back.
- **A lesson opened in the same moment as the app's first round** (found in the browser run): the page is rendered from the session as it was, the round then replaces it, and the page isn't listening yet when that is announced. The live channel also has no first frame, so its "open" can come late. Where sync is in use, `components/chat.tsx` checks the record a second after a lesson opens (`SYNC_CATCH_UP_MS`) and after every reconnect of the channel, unless a reply is being written: first its stamp (`?only=stamp`), and the whole record only when the stamp differs, is unknown or the check fails (`catchUpRead`; "The sync catch-up read" in `docs/fork/performance.md`). An app that isn't paired asks nothing more than before.

**How long the chip stays after the connection is back:** until the PC's next retry, and the retries slow down while offline (10 s, 20 s, 40 s … up to every 5 minutes; Phase 5, decision 11). After a long spell offline that can be 5 minutes. **Sync now** in Settings → Cloud, where the chip leads, ends the wait at once. The owner has been told; no change was asked for.

### The owner's decisions and approved words

#### Phase 6, the sync screens (built)

**The plan was approved by the owner** after one question per decision and a plan page with a drawing of every screen. All three slices are built as written here. Change a decision or a sentence only with the owner's approval.

#### Phase 6 decisions (owner)

1. **Trying it:** pictures and recordings from two copies (one plays the PC, one the server). Nothing is installed on the owner's PC before the merge. (The merge has happened: release 0.5.6.)
2. **An app that isn't paired** gets one new row in Settings, **Cloud**, under General. Nothing else changes: no chip, no strip, no request while Settings → Cloud is closed.
3. **The pairing form:** one form with a short how-to (address, code, this PC's name, one sentence on what pairing does).
4. **Paired:** the state, Sync now, and **Unpair this PC**.
5. **On the server's site:** its own **Cloud** row, between Obsidian and Account. Account is unchanged.
6. **The sync chip** (slice 3): at the foot of the session list, above Settings, **only when something is off**. An outline ring; ring and words in amber. It reads `OFFLINE`, `SYNC PAUSED` or `NOT PAIRED`. A click opens Settings → Cloud. Never on a PC that was never paired, never after the learner's own Unpair, never on the server's site or a phone.
7. **Names:** the form suggests **Desktop** for a PC. The server is called **the web app** ("Held by the web app"). (Since seamless sessions no screen names a session's holder, so "the web app" isn't shown; "Desktop" is still suggested.)
8. **A held session** (slice 2; decisions 8, 9, 10 and 13 are retired by "Seamless sessions" above): a strip under the top bar with the holder and **Take over**; no message box. The session list's second line reads "Held by Desktop" in place of the time.
9. **While an online holder hands over** (slice 2): the strip changes in place, with **Cancel**.
10. **The take-over warning** (slice 2): a confirm box with one wording; buttons Cancel and **Take over anyway** (red).
11. **The offline heads-up** (slice 3): the same strip under the top bar, for as long as it lasts; the message box stays. (Replaced by seamless sessions, decision 5: the heads-up is a floating box at the top of the lesson, with a ✕; the message box still stays.)
12. **The discard notice** (slice 3): a box over the app, once, with OK.
13. **Controls that can't work on a held session** (slice 2) are shown greyed out, not hidden: the side tutor's bubble, Rename and Delete in the session's menu, the title's click-to-rename. Tooltip on a computer: "Take this session over first".
14. **How a strip appears and goes:** it fades and slides open from under the top bar over 200 ms (`cubic-bezier(0.2, 0.8, 0.2, 1)`, the message box's own easing), and closes the same way, so the lesson glides and nothing jumps. The message box fades over 150 ms. When a strip's words change in place they cross-fade over 150 ms. With reduced motion, at once. The owner chose it from three live demos. (Replaced by seamless sessions: the floating box fades in and out over 200 ms with a 6 px slide, at once with reduced motion, and the message box is never hidden; "The floating box" under "Seamless sessions" above.)
15. **A second PC paired later** takes the server's settings (engine change 2).
16. **A prompt text only the server has** keeps its text with the switch off (as Phase 5 built it).
17. **After the learner's own Unpair** the PC may continue every session (engine change 4), and nothing reminds them to pair again.

#### The approved words

Kept in one place: `src/core/sync/screens.ts`. Change them only with the owner's approval. Quoted names take curly quotes, as in the notes drawer.

- **Desktop, Settings → Cloud, not paired.** Group "Cloud sync". "Keep this PC's sessions, graph and settings in step with your LearnHarness server." / "Server address" / "Pairing code" with "On the server's site: Settings → Cloud → Add a desktop app." / "This PC's name" (filled in: Desktop) with "The server lists this PC by this name: Settings → Cloud." (since seamless sessions: "The approved words" under "Seamless sessions" above) / "Pairing combines this PC's sessions with the server's. Nothing is deleted, and a backup is made first." / button **Pair** ("Pairing…" while it works). A refusal shows as a red line under the button, in the server's words (the Phase 5 list under slice 1).
- **Pairing again with the same server** replaces the "Nothing is deleted" sentence with: "This PC was paired with this server before. Where a session was continued on both sides since, the server's version is kept and what this PC added is discarded. A backup is made first."
- **Desktop, paired.** "Up to date" / "Starting…" / "Syncing…" (during Sync now) / "Can't reach the server. Trying again." / "Update the server to continue syncing" / "Update LearnHarness to continue syncing". "Last synced just now", "… 2 minutes ago", then "… today, 14:02" or "… 9 Nov, 18:20". Rows "Server" and "This PC". Buttons **Sync now** and **Unpair this PC**; the confirm line: "Syncing stops. Nothing on this PC is deleted, and every session can be continued here." with **Unpair this PC** (red) and Cancel.
- **Removed by the server:** "This PC is no longer paired." above the pairing form, which has the address and the name filled in.
- **Unpaired without a connection:** `The server couldn't be told. Remove “Desktop” there too: Settings → Cloud.`
- **Server, Settings → Cloud.** Group "Desktop apps". Each PC: its name, "Paired 12 Nov · online now" or "Paired 3 Nov · last seen 9 Nov, 18:20", **Remove**. Remove's confirm line: `“Desktop” stops syncing. Nothing on that PC is deleted.` with **Remove** (red) and Cancel. "No desktop app is paired." / **Add a desktop app** / "Pairing code" with "Works once, for 9:41" / "Server address" / "In the desktop app, open Settings → Cloud and enter both." / **New code**, **Done** / "This code has run out."
- **Slice 3, the discard box**, with the words of seamless sessions (`discardBox`, `discardedText`). Title `“Circuits” was continued on another device` / "It was continued on another device while this PC was offline. 3 messages you sent here never reached the server and were discarded. The session now shows the server's version." / OK. One message: "1 message you sent here never reached the server and was discarded." None, but another change: "Changes made here that hadn't reached the server were discarded." Several sessions: one box titled "Sessions were continued on another device", one line each.
- **Retired:** the words of slice 2's strip and warning box, and of slice 3's offline strip and discard box as first approved ("taken over", "what you add here now is discarded"): `docs/fork/history/cloud-sync.md`, "Phase 6 words and rules retired by seamless sessions". Seamless sessions replaced them ("The approved words" under "Seamless sessions" above).

#### Smaller rules (proposed in the plan page, approved with it)

- **After the learner's own Unpair, nothing nags:** no chip, no "no longer paired" strip. Both appear only when the PC was removed from the server's side.
- **Quiet for short blips** (slice 3): the chip and the offline strip appear once the PC has failed to reach the server for 30 seconds; at once if the app starts with no connection.
- **The offline strip shows in every session the PC can continue** (slice 3), also one created while offline that nobody could take over. Telling those apart needs one more fact from the engine; the owner was told and hasn't asked for it. (Since seamless sessions the heads-up shows in every lesson, since every session can be continued: "The rules approved with the plan" under "Seamless sessions" above.)
- **Practice sessions** get the same strips as teaching sessions. (Since seamless sessions: the same floating box.)
- **A PC removed on the server's site** that still holds sessions: they stay "Held by Desktop", offline, and can be taken over from the phone. The server remembers the name of every PC it heard from (`names` in `<data>/sync/authority.json`), because the login file forgets a removed PC. (Retired by seamless sessions in part: no screen shows "Held by" or Take over, and such a session moves to whichever device it is continued on; the names are still kept.)
- **How the pages stay current:** the app's live channel (`/api/events`), plus one check every 10 seconds, only where the marker says sync is in use.
- **Retired:** the rules about a held session (the strip after a take-over, the Tutor's greyed bubble, an open question's box going away, Take over asking again with Cancel): `docs/fork/history/cloud-sync.md`, "Phase 6 words and rules retired by seamless sessions". Since seamless sessions the page asks again every 2 seconds, with no Cancel, for as long as the lesson is open (`components/cloud/session-move.ts`).

### Rulings, limits and open items

**Phase 6, slice 1 (Settings → Cloud)**

- **Wording added while building, beyond the plan page, for the owner to review:** "Cloud sync couldn't be checked. Try again." with **Check again** (the app's own server didn't answer), and "Something went wrong. Try again." where a request fails with no reason (the app's usual line).
- **Retired:** a reading about the hint under the name box, which no longer follows what is typed: `docs/fork/history/cloud-sync.md`, "Phase 6 words and rules retired by seamless sessions".

**Phase 6, slice 3 (the chip, the heads-up, the discard box)**

- **Wording added while building, beyond the plan page, for the owner to review:**
  - several sessions in one box: "They were continued on another device while this PC was offline." above the lines (it read "They were taken over …" until seamless sessions), each line `“Circuits”: 3 messages you sent here never reached the server and were discarded.`, and "The sessions now show the server's version." below;
  - "Untitled session" for a discarded session with no title.
- **Read while building:**
  - The discard sentence says "while this PC was offline" also when the discard comes from pairing again after an Unpair (both sides had continued the session). The owner hasn't been asked for a second wording.
  - The chip's words are stored as "Offline", "Sync paused" and "Not paired" and shown in capitals by the row's style.
- **Not seen in a browser:** SYNC PAUSED (two copies of one build always speak the same protocol version); it is covered by the unit tests.

### Code and tests

- **Tests:** `tests/cloud-ui.test.tsx` (both screens in every state, with the approved words, and the Settings rows), `tests/sync-unpair.test.ts` (Unpair, the server's side of it, pairing again, the marker), new cases in `tests/sync-maps.test.ts` (a PC paired later), and the marker's absence in `tests/sync-inert.test.ts`.
- **Tests:** `tests/cloud-notices-ui.test.tsx` (the words, the quiet rule with a moved clock, the chip in every state and where it never shows, the heads-up, the discard box), and `offlineSince` and the signal in `tests/sync-pairing.test.ts`.

## Flashcards sync

- **Why:** the owner added it while answering the phone plan's questions: decks made in the Windows app should be on the phone, so **sync Flashcards between the Windows app and the server in this round**.
- **The plan** is `docs/fork/plans/phone-plugins-plan.md` ("Flashcards sync": decisions S1–S6 and the smaller rules), approved by the owner. Change a decision only with the owner's approval.
- It replaces decision 17 of the 0.6.0 merge ("plugin data is per device") for Flashcards' library only. Every other plugin's data, and which plugins are on, stay per device.
- **The sessions' rules don't apply here:** no lease, no Take over, no held state, nothing discarded.

### What travels, and what stays per device

- **Travels:** decks (name, daily new-card limit, order), facts and their cards (question, answer, order), which decks each fact is in, every review, the four scheduling settings (`retention`, `learningSteps`, `relearningSteps`, `dayStart`) and the chunk budget (`chunkBudget`), and the record of each uploaded file (its name and fingerprint, so the same file doesn't become a second deck).
- **Per device, never synced:** the model and thinking choice, generation batches and their retry, the text of uploaded files, the cost log, creation and deletion receipts, and the file's `revision`. A fact's `version` rises only where the fact really changed, so a review open elsewhere stays valid.
- **Schedules never travel.** After every exchange each device works each fact's schedule out again from the combined reviews (below).
- **A device where Flashcards is switched off** still receives the data (the file is written with the plugin off or never started), so it is there when the plugin is switched on.
- **A generation under way** finishes on its device; its cards travel once they are added.

### The items (`src/core/sync/flashcards-items.ts`)

- Every key is `<kind>|<id>`, and each item travels on its own, latest change wins, through the same per-item exchange as the settings (slice 5):
  - `s|<setting>` the five synced settings;
  - `d|<deck>` a deck `{name, newLimit, sourceId?, s, at}`; `x|<deck>` a deck was deleted;
  - `o|decks` the deck order; `q|<deck>` the order of the facts in a deck;
  - `p|<fact>` a fact `{origin, name, statement, snapshot?, sourceId?, created}`; `e|<fact>` when the fact was deleted; `m|<deck>|<fact>` the fact in that deck, or taken out of it: `{in, s}`;
  - `c|<card>` a card `{p, q, a, s}`; `k|<card>` a card was deleted; `u|<fact>` the order of a fact's cards;
  - `r|<review>` one review, never changed: `{p, c, rating, at, deckIds, settings}`;
  - `f|<file>` an uploaded file's record `{name, fingerprint, deckId}`.
- **Nothing is deleted by a missing item.** Deletions are items of their own (`x`, `k`, `e`), so latest-change-wins only ever chooses between two values. A per-device memory tells "deleted here" from "never had it": the plugin's file keeps no record of what it deleted ("The memory" under "The wiring" below).
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

### The replay (`src/core/sync/flashcards-replay.ts`)

- Each fact's schedule is worked out again from its counted reviews, in the order they were made, with the plugin's own scheduler (`plugins/flashcards/src/scheduler.cjs`) and the settings copy each review recorded. A new fact starts from the plugin's schedule for the moment it was made.
- Pure: the scheduler is passed in and no clock is read. It runs in the process's own time zone (S2 below).
- **It reproduces the plugin's own file byte for byte** on single-device histories: 40 days of reviews with all four ratings, lapses, learning and relearning steps and settings changed along the way; a card deleted; a fact deleted and made again (`tests/sync-flashcards-replay.test.ts`).

### The wiring

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

### Protocol 3

- `SYNC_PROTOCOL_VERSION` is **3** (`src/core/sync/protocol.ts`): the library travels on a route a protocol-2 build doesn't have, and a PC sends its time zone.
- `tests/sync-sessions.test.ts` pins which protocol each Flashcards file format needs (`PROTOCOL_FOR_FLASHCARDS_FORMAT = {1: 3}`), beside the chat format's table: a new format with no row fails it.
- As with protocol 2, both sides must be updated, the server first; until both are, all sync pauses and nothing is discarded. The steps are "Updating the server and the PC together" in `docs/fork/releases.md`.

### The plugin's store (the one edit to Flashcards' code)

- `plugins/flashcards/src/store.cjs`: `get()` and `change()` compare the file's stamp (inode, size, mtime, ctime) with what they last read or wrote, and read the file again when it changed on disk. A file that went missing keeps what is in memory; the next change writes it back whole.
- So the plugin, running in the same process, sees what sync wrote without a restart, and its next write can't put back what sync replaced.
- One line of `plugins/flashcards/tests/store.test.cjs` changed with it. Both are listed under "At the next upstream release: the fork's edits to upstream files" in `docs/fork/upstream.md`.
- The Windows workflow runs the plugin's store and back-end tests on Windows in a step of their own; its `tests/sync-*.test.ts` glob picks up the new sync tests.

### Log lines and API texts

- No wording on screen. The server's log: `[LearnHarness] Flashcards sync: this server now keeps time in <zone>, the paired desktop app's time zone.`; `[LearnHarness] Flashcards sync: <reason>` (once per distinct reason, on either side); `[LearnHarness] Flashcards sync: the saved time zone couldn't be used: …`; and since the fixes:
  - `[LearnHarness] Flashcards sync: the library doesn't follow what sync last saw here (it was put back or replaced); nothing missing from it counts as deleted, and it is combined again.`
  - `[LearnHarness] Flashcards sync: a generation has shown no progress for 15 minutes; Flashcards sync goes on without waiting for it.`
  - `[LearnHarness] Flashcards sync: this server couldn't switch to the time zone <zone>, and keeps the one it had.`
- Texts only the API carries: "The Flashcards changes didn't arrive whole.", "The server is busy with this. Try again in a moment.", "The server couldn't take the Flashcards changes this time."

### The owner's decisions and approved words

#### Flashcards sync decisions (owner)

1. **S1, how: combine everything.** Every change travels on its own; every review from both devices is kept; each fact's schedule is worked out again from all its reviews.
2. **S2, time zone: the server follows the PC.** The Windows app tells the server its time zone with a sync, and the server program uses it from then on.
3. **S3, the first sync: combine both libraries.** Nothing is deleted. A fresh backup on each side first.
4. **S4, two decks from the same session: joined into one deck.**
5. **S5, edited on one device, deleted on the other: a delete always wins.**
6. **S6, settings:** the four scheduling settings and the generation chunk budget sync; the model choice stays per device.

The smaller rules approved with them (what travels, schedules never travel, order, timing, the backup, protocol 3, the one edit to the plugin's code, the known limits) are in the plan; what was built for each is above.

### Rulings, limits and open items

#### Rulings made while building (for the owner to review)

- **A PC with no Flashcards file brings no settings** at its first Flashcards sync: the server's stay. The Flashcards exchange doesn't reset settings a PC didn't send (`resetUnsentSettings: false` in `FLASHCARDS_RULES`), where the app's settings exchange puts a first PC's unset settings back to their defaults.
- **A device with a generation batch under way holds its Flashcards exchange:** a batch `running` or `cancelling`, while the plugin is on. The server answers 409 `busy` and the PC tries again next round; a PC with its own batch under way sends nothing. Sessions, graph and settings go on. A switched-off plugin is never busy.
- **How "a delete always wins" reads for decks and facts:**
  - a fact deleted on one device while the other added a new card to it survives, with the new card;
  - a deck deleted on one device but given a card on the other is a normal deck again;
  - which decks a fact is in combines (one item per fact and deck, since the review's fixes; "The items (`src/core/sync/flashcards-items.ts`)" above). The first ruling here, "one item per fact, the later change wins whole", is replaced;
  - a joined twin deck can undercount that day's new cards (reviews keep the deck id they were recorded under).
- **Schedules are worked out again when the zone changes.** When the server takes a zone it didn't keep or run in, it rebuilds every schedule in that zone; the PC does the same when it sends its zone (its first exchange, or after it moved). Without that, a review made in the old zone kept that zone's due date on one side only (found in the two-copy run). The cost: at the first sync, due dates of facts reviewed in the other zone can move by up to a day. With two PCs in different zones, the one not counted keeps its own zone's schedules. The owner has been told.
- **A side with no Flashcards folder** makes no backup folder and counts as backed up.
- **Made while fixing the review's findings** (for the owner's review; the owner was told in chat):
  - **the same-question rule** reads as "only a pair that meets from two devices": two cards with the same question on one fact, one from each device, lose the later one; two cards one device made are both kept ("The items (`src/core/sync/flashcards-items.ts`)" above);
  - **a fact taken out of every deck stays in the deck it was put in last** that isn't deleted; **if every one of its decks is deleted, the last one stays as a deck** (a fact is never left in no deck, and is never dropped);
  - **a generation that shows no progress for 15 minutes holds the exchange no longer.**
- **Made while fixing the second pass's findings** (for the owner's review):
  - **the watcher's timing:** this side's own changes are noted 20 s after the last one, at most 50 s after the first not yet noted ("Noting this side's own changes" above);
  - **a server that lost its memory takes the first PC's values:** it starts its table afresh, each PC is told `send_all`, and the first desktop to send counts as the first.

#### Known limits

- A concept that is two graph nodes (learned separately on both devices before they synced) is two facts.
- A server that lost its sync records can bring deleted cards back.
- The same card reviewed on both devices while apart: both reviews count, and that day's new-card limit can be passed.
- A joined twin deck can undercount that day's new cards; with two PCs in different zones, the one not counted keeps its own zone's schedules (above).
- 60,000 reviews (over 26 MB) weren't tried.
- With a 25 MB library (20,000 reviews), noting a phone review holds the server's process for about 570 ms and applying one PC review about 540 ms (about 540 to 650 ms, measured after the second pass's fixes). The noting now runs about once every 20 to 50 s during a review session, not on every rating, and rewrites no table for reviews.
- Clock differences between devices affect the times of reviews and deletions.
- A PC with a wrong clock wasn't run between built copies (a built copy's clock can't be skewed in the development sandbox); it rests on the exchange tests.

#### Only the real PC and server can confirm

- Windows file stamps, and the rename over the file while another program holds it.
- The real Windows zone name.
- That the server image's compose `TZ` is overridden by the zone the PC gave.

### Code and tests

#### Tests

- `tests/sync-flashcards.test.ts`: the pure rules, with two devices that each run the plugin's real back end. Both libraries combined at the first sync, every review counted, delete-wins, a deck that still has cards stays, a fact made again starts fresh, twin decks joined, the same question twice, the order rule, settings and the model choice, an idle exchange, and the same library whatever order the changes arrive in.
- `tests/sync-flashcards-replay.test.ts`: the replay, byte for byte against the plugin's own file.
- `tests/sync-flashcards-exchange.test.ts` (with `tests/helpers/sync-flashcards-harness.ts`): the real exchange, the real files and the plugin's real back end on each side, never restarted. Pages both ways, the backups, a review landing without a restart, plugin writes right before and after a sync write, an idle round, a generation holding the exchange, the format lock, a lost memory, a PC with no library, no backup no sync, and the time zone sent once and again when it changes.
- Added with the review's fixes (`tests/sync-flashcards-exchange.test.ts`, and cases in `tests/sync-flashcards.test.ts`, `sync-flashcards-replay.test.ts`, `sync-flashcards-zone.test.ts` and `tests/sync-maps.test.ts`): a library put back from its backup deletes nothing; a crash between writing the library and its memory deletes nothing; the backups keep sync's own files; a library that can't be read for a while passes nothing over; a locked library costs no request, and a server's locked library one cheap request a round; the phone's changes keep their own time while every PC is away; the watcher; two PCs whose first exchanges overlap; the same-question pairs; a generation stuck for 15 minutes; one rebuild per zone; the kept snapshot equal to a fresh read.
- **Added with the second pass's fixes:** in `tests/sync-flashcards-exchange.test.ts`, a restored library on a PC whose clock is ahead and behind, the server taking a negative time, a fact made on both sides, a lost memory and a cut first save, a dropped reply then a same-question card, the watcher's timing, and the server's noting with no table write for a review alone and skipped after an exchange; in `tests/sync-flashcards.test.ts`, the fallback with deleted decks; in `tests/sync-maps.test.ts`, a negative time taken as 0 and NaN refused.
- `tests/sync-flashcards-zone.test.ts`: the zone kept and used by the running process at once and at the next start, the most recent one counting, a name that isn't a zone ignored, the plugin's study day following, and the loop's 2-second trigger.
- `tests/sync-inert.test.ts` (an unpaired app does nothing new) and the protocol rows in `tests/sync-sessions.test.ts`.

## Code map and tests

- **Where the engine attaches** (read these first):
  - `src/core/ports.ts`: the store interfaces (`ChatStore`, `GraphStore`, `SourceOrganizationStore`, `JobStore`, `SettingsStore`, `PromptOverrideStore`, `AuthStore`);
  - `src/server/stores.ts`: the composition root (`stores`), where wrapper stores go so upstream's store code stays untouched;
  - `src/store/*`: how each file is written today (whole-file rewrites, appends, read-modify-write maps), which decides how it can sync;
  - `src/core/graph.ts` and `src/core/graph-deletion.ts` (`rewriteLedgers`): the destructive graph changes that must sync as replayed operations;
  - the notes home-folder records (`src/store/notes.ts`): the fork file that follows a chat's lease (`src/store/side-tutor.ts`, the other one, is gone since the upstream 0.6.0 merge);
  - `src/server/server-auth.ts` and `proxy.ts`: the login gate every new `/api/sync` route sits behind.
