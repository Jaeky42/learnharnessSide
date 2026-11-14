# Plan: accounts on one server (several people, one address)

**Status: a draft for the owner to approve. Nothing is built, and the owner does not want it built yet**: the plan is written so a later session can build it quickly. Per `AGENTS.md`: that session reads this, asks the owner whatever is listed under "To ask the owner at build time", gets the plan approved as it then stands, and only then builds. Change a decision recorded here only with the owner's approval.

## What was asked

- Run LearnHarness for more than one person on the owner's server (2 cores, 4 GB RAM), with a real account system. Today the site has one password and one library.
- Three shapes were shown. The owner chose **B: one front door with accounts, each account its own copy of LearnHarness**. Not chosen: A (a second copy at its own address with its own password, no new code) and C (one process serving several accounts).
- **Why not C** (read from the code): the data folder is a constant fixed when the process starts (`config.ts`, `DATA_ROOT`); about 15 process-wide objects hold one user's state with no user key (turns, jobs, the events channel, the plugin host, the sync engine, the Obsidian manager, `stores`); about 24 store files, 82 server files and 85 API routes take no user id; the process's time zone is set from the paired PC (`src/server/sync/flashcards-zone.ts`); the Claude Code and Obsidian sign-ins are one per home folder; a switched-on plugin is trusted code with every file. It would also conflict with every upstream merge.

## The owner's decisions

Asked one at a time, each with pictures of the options.

| # | About | Decision |
|---|---|---|
| 1 | Who creates accounts | **Invite codes.** The owner makes a one-time code; the invited person redeems it on the site and their copy is created automatically. No open sign-up. |
| 2 | Addresses | **One address for everyone.** A gateway knows who is signed in and passes each request to that person's copy. (Not chosen: an own address per person behind a shared front page.) |
| 3 | How copies are made and kept apart | **A Docker container per account**, with its own data volume. A small separate helper (the "maker") is the only thing allowed to talk to Docker; only the gateway can reach it. |
| 4 | Idle copies | **Always running, with a cap on the number of accounts.** When the server is full an invite code is refused with a clear message. |
| 5 | Sign-in name | **A name the person chooses.** No e-mail address is stored and no mail service is needed. |
| 6 | Forgot password | **Both:** recovery codes the person keeps, and a reset code from the owner as the fallback. The owner's own account keeps the `reset-password` command on the server. |
| 7 | Pairing a desktop app | **The pairing code says whose copy it is.** The desktop app's form (address, code, this PC's name) is unchanged. |
| 8 | The owner's powers | **Manage accounts, never open them.** An owner-only screen: accounts and when each last signed in, invite codes, Reset, Pause, Remove. Nothing on the site shows one account's content to another. |
| 9 | A removed account's data | **Kept 30 days, then deleted for good.** Restore is possible meanwhile; the slot is free at once. |
| 10 | Model access | **Each person brings their own** (their Claude or ChatGPT sign-in, or API keys, in their own Settings). Nothing of the owner's is shared. |
| 11 | Features for invited accounts | **Everything the owner has, in a hardened container:** a memory cap, a CPU share, a process limit, no special system rights. |
| 12 | Extras in the first version | **Delete my own account** and **Download my data.** Not in the first version: usage per account on the owner's screen, renaming an account. |

## Facts this plan rests on

**Measured** (a production build of this repo, two copies side by side in server mode, the sample library of two sessions, Node 22 in the development sandbox; not the Docker image on Node 26, no real model, no Obsidian):

| Per copy | |
|---|---|
| Memory just after start | about 185 MB |
| Memory after opening lessons | 230–270 MB |
| CPU while idle with a lesson page open | 0–2% of one core |
| A headless browser showing one small page (stand-in for a demo check) | about 160 MB, short-lived |

**Estimated, not measured:** Obsidian's sync program about 100 MB per connected copy, always on; one Claude Code CLI process 300–500 MB while a request runs; the operating system, Docker and Caddy about 0.5 GB; the gateway about 50 MB and the maker about 40 MB.

**Read from the code:**

- Two copies need only different `PORT`, `LH_DATA_DIR`, `LH_AUTH_FILE`, `LH_VAULT_DIR` and `HOME` (that is how the measurement ran). One image serves any number of containers.
- The login is one password for the whole site: `ServerAuthState` (`src/core/server-auth.ts`) has one `password`, `sessions`, `lockouts`, `devices` (paired desktops) and `pairing`. No user or name anywhere. `serverGate` (`src/server/server-auth.ts`) lets any signed-in session through everything.
- The desktop app sends a pairing code as typed, of up to 64 characters (`pairWithServer`, `src/server/sync/client.ts`), and the server compares a hash of its letters and digits (`setupCodeMatches`). So **a longer code works with the desktop app as released today**.
- A device key is 32 random bytes as base64url (43 characters); the server accepts 20 to 128 characters of that alphabet (`bearerKey` in `src/core/sync/devices.ts`). The desktop app treats it as opaque.
- The desktop app reads a 5xx answer as "offline" and keeps its key; a 401 `not_paired` makes it drop the key (`src/server/sync/client.ts`).
- Each Claude Code request starts its own CLI process (`src/agent/claude-code/launch.ts`), and helper requests are admitted 8 at a time by default (`src/agent/worker-request-admission.ts`; the setting is "helpers at once", per device).
- No memory or CPU limit is set anywhere today (`Dockerfile`, `deploy/compose.yaml`).
- The entrypoint installs Claude Code and `ob` onto each copy's own volume, once per volume (`deploy/docker-entrypoint.sh`).

## The design

```
                internet
                   │  https://learn.<yourdomain>      (one address, as today)
            ┌──────▼──────┐
            │    Caddy    │  HTTPS; asks the gateway about every request
            └──┬───────┬──┘
   "who is     │       │ the request itself, straight to that copy
    this?"     │       │
        ┌──────▼───┐   │        ┌────────────┐
        │ gateway  │───┼───────►│   maker    │──► Docker (create / start / stop)
        │ accounts │   │        │ (internal) │
        │ sessions │   │        └────────────┘
        │ invites  │   │
        └──────────┘   ├──────────────┬──────────────┐
                 ┌─────▼─────┐  ┌─────▼─────┐  ┌─────▼─────┐
                 │ owner's   │  │  copy     │  │  copy     │   one container and
                 │ copy      │  │  "sam"    │  │  "kim"    │   one data volume each
                 └───────────┘  └───────────┘  └───────────┘
```

### The pieces

- **Caddy** stays the only way in and keeps serving HTTPS for the one address. For every request it asks the gateway (`forward_auth`) and gets back either a refusal (a redirect to sign-in, a 401) or "this request belongs to copy X", and then passes the request straight to that copy. Lesson streams and uploads never flow through the gateway.
  - *(Not verified here.)* That Caddy can choose the upstream from a header the gateway returns is from its documentation, not from a run. Slice 0 proves it; the fallback is the gateway carrying the requests itself.
  - Caddy must strip any `X-LH-*` header a client sends before it asks the gateway, so a client can't name its own copy.
- **The gateway** is a small program of its own (plain Node HTTP, no Next), in a fork-owned folder (`gateway/`), built into the same image and started with a different command. It holds accounts, sign-in sessions, invite codes, reset and recovery codes and the lockout, in one file on its own volume, written like `server-login.json` (mode 0600, hashes only, fail closed when damaged). It reuses the pure rules in `src/core/server-auth.ts` (password hashing, the session and lockout rules, the code alphabet).
- **The maker** is a second small program, the only one with access to Docker. It is on an internal network with the gateway alone. It understands a handful of requests (create a copy, start, stop, delete a copy's volume, list) and builds every container from one fixed template: its own image, a name and volume derived from the account's tag, the limits below. It takes no image name, no mount and no command from a request.
- **A copy** is today's LearnHarness container, unchanged in what it does, with a new mode for standing behind the gateway (below).

### Signing in

- `/login` is the gateway's page: name and password, and a link for an invite code. The cookie keeps its name (`__Host-lh_session`) and its rules (HttpOnly, Secure, SameSite=Lax, a fixed 30 days, only a hash stored); it now names a gateway session, which names an account.
- The existing rules carry over, per account where they were per site: a password of at least 8 characters as a scrypt hash; 5 wrong tries from one address pause sign-ins from it for 15 minutes, doubling to 24 hours; writes must come from the site itself.
- A wrong name and a wrong password give the same answer and take the same time.
- One browser holds one signed-in account at a time.

### A copy behind the gateway

- With `LH_GATE_SECRET` set (by the maker, one random secret per copy), a copy's own password gate is off and a different rule is on: **every request must carry that copy's secret**, which Caddy adds from the gateway's answer. Compared in constant time. A request without it is refused, pages and files included.
- Why it is needed although copies aren't reachable from the internet: programs in one person's copy (the teacher's tools, a coding question's test program) could otherwise call another copy over Docker's internal network. Each copy also gets its own internal network, joined only by Caddy, where Docker allows it; the secret is the second lock.
- The device-key check for `/api/sync/*` stays in the copy as it is. The gateway only decides which copy a sync request goes to.
- The desktop app and a single-copy server (no gateway) are unchanged: the mode exists only where the variable is set.

### Desktop pairing

- Each account has a short random **tag** (three characters of the setup-code alphabet; not derived from the name).
- A copy that knows its tag (`LH_ACCOUNT_TAG`) puts it at the end of the pairing codes it makes (shown as `XXXX-XXXX-XXX`) and at the front of the device keys it issues.
- The gateway reads the tag: from the key on every `/api/sync/*` request, and from the code in the one pairing request (`POST /api/sync/pair`, which Caddy sends through the gateway itself, because the code is in the body).
- **A key or code with no tag belongs to the owner's copy**, so the PC that is paired today keeps working without pairing again. Tagged keys are told from older ones by their length.
- A paused or removed account's desktop app gets a 5xx answer, which it reads as "offline" and which keeps its key, so a restored account's PC carries on. Only after the data is deleted for good does it get 401 `not_paired`.
- The sync protocol stays at 3: nothing on the wire changes shape. No desktop release is needed for pairing.

### Invite codes and a new account

1. The owner presses **New invite code** on the Accounts screen: a code in the setup code's form, working once, for 7 days. Refused when no slot is free.
2. The invited person opens the site, follows "Have an invite code?", enters the code, a name and a password.
3. The gateway checks the code (wrong codes count toward the lockout), reserves the name, and asks the maker for a copy. The maker creates the volume and the container and starts it.
4. The person is shown their recovery codes once, then lands in their copy: an empty library and "set up a model" as on a fresh install (decision 10).

### Forgot password

- **Recovery codes:** 8 codes shown once when the account is made, each working once. "New recovery codes" in Settings → Account (with the password) replaces them all.
- **The owner's reset code:** Reset on the Accounts screen gives a code that works once, for 24 hours.
- Either one, with a new password, at the sign-in page. As a password change does today, it signs out every device of that account and unpairs its desktop apps (the gateway tells the copy).
- The owner's own account: recovery codes too, and `reset-password` on the server as the last way in.

### The owner's screen

- **Settings → Accounts**, shown only to the owner (a marker cookie from the gateway decides what shows; the gateway decides what is allowed).
- Per account: name, "signed in now" or when last seen, and Reset, Pause, Remove. Removed accounts are listed apart with Restore and Delete now. Below: how many accounts of the cap are used, and New invite code with the waiting codes (each can be cancelled).
- **Pause:** sign-in is refused, the copy is stopped, everything is kept, the slot stays taken. Resume starts it again.
- **Remove:** the copy stops at once and the slot is free. The volume is kept 30 days, then the maker deletes it. Restore within that time brings the account back as it was (if a slot is free).
- The owner's account can't be paused or removed.

### In each person's Settings → Account

- As today: change password, the signed-in devices, Sign out, Sign out everywhere. These calls are answered by the gateway now (Caddy sends `/api/server-auth/*` there, except the desktop-app list and pairing codes, which stay the copy's).
- New: recovery codes; **Download my data**; **Delete my account** (password and a confirm box; the same 30-day rule as Remove; not offered to the owner).
- **Download my data** is made by the copy itself: one archive of its data folder in the folder's own layout (sessions, graph, settings, prompt texts, themes, plugin data, the notes records), so it can be put into a desktop app's data folder. Not in it: sign-ins and keys, the sync records, and the Obsidian vault (Obsidian has it).

### Limits on a copy

- Memory ceiling per container, and no more than that again in swap.
- CPU by share, not a hard cap: one person alone may use both cores; two share them.
- A limit on the number of processes; no added capabilities; no privilege escalation.
- New accounts start with "helpers at once" at 3 (the maker seeds the setting into the new volume). The owner's own copy is changed by hand.
- The server gets swap (a step in the guide).

### Updates

- The nightly `update.sh` pulls the one image and restarts Caddy, the gateway, the maker and the owner's copy, as now.
- Account containers aren't in the compose file. When the maker starts on a new image it brings every account container onto that image (stop, re-create on the same volume, start), one at a time. So all copies and the gateway always run the same build.

### The switch-over on the owner's server

- The owner's existing container and volume stay where they are and become the owner's account. No data moves.
- At the first start with no accounts, the gateway prints a one-time setup code to its log, as the app does today. The owner enters it and chooses a name and a password. Every browser signs in once more; the paired PC is untouched.
- Before it: a copy of the server's data by hand, as for the 0.6.0 update.

## Smaller rules (proposed here, approved with the plan)

- **The cap** is 4 accounts, the owner's included, on a 4 GB server; a setting in `deploy/.env`. Paused accounts count; removed ones don't. At the cap, two idle copies leave about 2 GB for work in progress.
- **Memory ceiling** 1 GB per copy; **swap** on the server 2 GB. Both are first values to tune on the real server.
- **Names:** 3 to 20 characters of a–z, 0–9 and dash; told apart without regard to capitals; a short list is reserved (admin, owner, root, api, login, setup and the like). A removed account's name stays taken for its 30 days.
- **Invite codes:** once, 7 days, at most as many waiting as there are free slots.
- **One lockout** covers passwords, invite codes, reset codes and recovery codes.
- **What signs a person out everywhere:** a password change, either reset, Pause and Remove.
- **Browser storage** is shared by accounts that use the same browser (window positions and the like). Before building, list what the app keeps there; anything that holds a person's content (an unsent draft) is cleared at sign-out.
- **The marker cookies** (`lh_server`, `lh_cloud`) stay plain markers; the gateway adds one for the owner.
- **The home-screen app** keeps working: same address, same icon.
- **A single-copy server** (no gateway) stays possible and is what the image does by default.

## To ask the owner at build time

- **Every word on the new screens**, with a drawing of each: the sign-in page with a name, the invite page, the recovery-code page, the reset page, Settings → Accounts, the new parts of Settings → Account, the confirm boxes, and each refusal ("This server is full.", "This account is paused.", a wrong or used code, a taken name). The drawings shown with the questions are drafts, not approved wording.
- **The four numbers above** (cap, memory ceiling, swap, helpers at once), once the real server has been watched with two copies.
- **The download's file type** (zip is proposed).
- **Whether a person is told** on the invite page that the owner can pause, reset and remove their account but can't open it from the site.
- **Which branch feeds it**, and when the owner's server and the desktop app get it.

## Build order

Each slice ends with its tests, a run of real containers, and a commit. Risk is high throughout (sign-in, one person's data reaching another, rights over Docker): the implementer is the complex one, and each of slices 1 to 3 gets one independent deep review.

0. **Proof first:** Caddy, a stand-in gateway and two copies in Docker. Shows: the gateway's answer picks the copy; a lesson stream, the events channel and a 26 MB upload pass untouched; a client-sent `X-LH-*` header is ignored. If it can't be made to hold, the gateway carries the requests itself and the rest of the plan stands.
1. **The gateway and one account.** Accounts file, sign-in and sign-out, sessions, the lockout, the pages; the copy's behind-the-gateway mode; the compose file with the existing copy as the owner's. After this slice the server does what it does today, through the gateway, with a name on the sign-in page.
2. **Desktop sync through the gateway.** Tags in codes and keys, sorting `/api/sync/*`, the pairing request, 5xx for a stopped copy. The already-paired PC must carry on untouched.
3. **The maker, invites and new accounts.** The fixed template and its limits, the cap, per-copy networks and secrets, re-creating copies on a new image.
4. **The owner's screen.** Accounts, invite codes, Reset, Pause, Remove, Restore, the 30-day deletion.
5. **Each person's own.** Recovery codes, the gateway behind Settings → Account, Delete my account, Download my data.
6. **The whole thing:** three copies in the image workflow with every crossing tried (below), the switch-over guide, and `docs/cloud-sync.md` brought up to date.

**Where it attaches** (fork-owned unless noted): new `gateway/` and its bundle step in `Dockerfile`; `deploy/compose.yaml`, `deploy/Caddyfile`, `deploy/update.sh`, `deploy/.env.example`; `src/server/server-auth.ts` (the behind-the-gateway rule beside `serverGate`); `src/core/sync/devices.ts` (tags in codes and keys); `scripts/server-reset-password.mjs`; `components/settings/account-section.tsx`, a new `accounts-section.tsx`, and one row in `settings-dialog.tsx` (upstream's file, already edited by the fork); a download route in `app/api/`; `.github/workflows/server-image.yml`.

**The tests that matter most:** with two accounts, every way of reaching the other's copy is tried and refused: the other's session cookie, the other's device key, a key with a changed tag, a forged `X-LH-*` header, a direct call from inside one container to the other, a pairing code redeemed against the wrong copy, a removed account's cookie and key. And: an app that isn't behind a gateway behaves byte for byte as today (the existing `tests/server-auth.test.ts`, `tests/sync-inert.test.ts` and the desktop request-list tests stay green).

## What only the real server can show

- Docker's limits and per-copy networks on the owner's VPS, and how four copies behave in 4 GB with real lessons.
- Caddy's certificate and the one address staying as they are through the switch-over.
- Claude and ChatGPT sign-ins made from an invited copy (both are blocked in the development sandbox).
- A second person's desktop app pairing over the internet.

## Not in the first version

- Usage per account on the owner's screen; renaming an account (decision 12).
- Sleeping copies (decision 4), an own address per person (decision 2), e-mail of any kind (decision 5), sharing the owner's model keys (decision 10), switches per account for single features (decision 11), opening another account from the owner's screen (decision 8).
- More than one server.
