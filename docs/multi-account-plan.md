# Plan: accounts on one server (several people, one address)

**Status: approved by the owner** ("I agree with everything"), with one change: 4 recovery codes, where the draft said 8. **Since then the owner answered every open question** ("The approved words" and "How it is built and tried" below), so that the build can run in one go, and changed one rule: a person who deletes their own account has their data deleted at once. **Built and shipped.** The owner then gave the word to build ("build my multi accounts feature"), and it was built straight through, as decided, on the branch `claude/dazzling-maxwell-j6mfy1`, as written here: the build followed the plan, and where it had to differ from the build guide (`docs/multi-account-build.md`) or added something the plan doesn't say, that is recorded in "Accounts on one server" in `docs/cloud-sync.md` ("Rulings made while building" and "Open for the owner"), for the owner to review. **What was built, where it lives in the code, what was run and what is still open is there, not here.** After the page of screenshots the owner gave the word to ship, and the same commit went to the server's branch and to `side-tutor`; the owner's server is switched over by hand, with the guide (see "How it is built and tried" and "Still for the owner, after the build" below). Change a decision recorded here only with the owner's approval; anything that has to differ from it goes back to the owner first.

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
| 12a | Deleting one's own account (the owner's later change) | **The data is deleted at once, for good.** No 30 days and no Restore. The owner's own Remove keeps its 30 days (decision 9). |
| 12b | The download | **A .zip file**, its folders laid out like the data folder. |

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

- `/login` is the gateway's page: name and password, and a link for an invite code. The cookie keeps its name (`__Host-lh_session`) and its rules (HttpOnly, Secure, SameSite=Lax, only a hash stored); it now names a gateway session, which names an account.
- **A sign-in is extended by use** (the owner's decision, a change from today's fixed 30 days): it lasts **30 days from the last use, and at most 6 months from the sign-in**. A device left unused for 30 days is signed out; a device in constant use signs in again after 6 months. The upper limit is there so that a sign-in copied off a device can't be kept alive for ever by being used. Behind a gateway only: a single-copy server keeps its fixed 30 days.
- The other existing rules carry over, per account where they were per site: a password of at least 8 characters as a scrypt hash; 5 wrong tries from one address pause sign-ins from it for 15 minutes, doubling to 24 hours; writes must come from the site itself.
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

- **Recovery codes:** 4 codes (the owner's number; the draft proposed 8) shown once when the account is made, each working once. "New recovery codes" in Settings → Account (with the password) replaces them all.
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
- New: recovery codes; **Download my data**; **Delete my account** (password and a confirm box; not offered to the owner).
- **Delete my account deletes at once** (decision 12a): every device is signed out, the copy is stopped and removed, its volume is deleted, and the account's record, name and tag are gone. Nothing is kept and nothing can be restored. A desktop app that was paired with it is answered 401 `not_paired` from then on; what is on that person's own PC stays there.
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

## Smaller rules (proposed in the plan, approved with it)

- **The cap** is 4 accounts, the owner's included, on a 4 GB server; a setting in `deploy/.env`. Paused accounts count; removed ones don't. At the cap, two idle copies leave about 2 GB for work in progress.
- **Memory ceiling** 1 GB per copy; **swap** on the server 2 GB. Both are first values to tune on the real server.
- **Names:** 3 to 20 characters of a–z, 0–9 and dash; told apart without regard to capitals; a short list is reserved (admin, owner, root, api, login, setup and the like). A removed account's name stays taken for its 30 days.
- **Invite codes:** once, 7 days, at most as many waiting as there are free slots.
- **The owner's reset code:** once, 24 hours. **Recovery codes:** 4 per account.
- **One lockout** covers passwords, invite codes, reset codes and recovery codes.
- **What signs a person out everywhere:** a password change, either reset, Pause and Remove.
- **Browser storage** is shared by accounts that use the same browser (window positions and the like). Before building, list what the app keeps there; anything that holds a person's content (an unsent draft) is cleared at sign-out.
- **The marker cookies** (`lh_server`, `lh_cloud`) stay plain markers; the gateway adds one for the owner.
- **The home-screen app** keeps working: same address, same icon.
- **A single-copy server** (no gateway) stays possible and is what the image does by default.

## How it is built and tried (the owner's answers)

Asked so that the build can run in one go once the owner says "build it".

| About | Decision |
|---|---|
| Trying it | **Pictures first, then switch with a way back.** The build runs the whole system in a test set-up and gives the owner one page of screenshots and timings. On the owner's go the real server is switched in one update; the way back is the previous `deploy/` files and image, because the owner's copy keeps its own password login untouched. No trial address on the server. |
| Stops | **Run straight through, one page at the end.** All seven slices without waiting, each risky part independently reviewed. The builder stops earlier only when the plan can't be followed as written. Nothing reaches the server or the Windows app before the owner approves after that page. |
| Accounts in Settings | A row of its own under Account on a computer and a tablet. **On a phone it is a second group inside Account**, under a divider, as Obsidian sits inside Cloud; the phone's list stays at eight rows. Shown to the owner only. |
| Colours before sign-in | **The app's standard dark theme, always**, for the sign-in, first-start, invite, recovery-code and reset pages. **The home-screen app's start-up colours too** (the manifest, which is fetched with no sign-in). Behind a gateway only: a single-copy server keeps its themed sign-in pages. Signed in, everyone has their own theme as now. |
| The Windows app's pairing box | **May be widened** if a 13-character code doesn't fit; nothing else on that form changes. It rides with the Windows release that the shipping causes anyway. |
| How long a sign-in lasts | **30 days since the last use, at most 6 months** (asked after the owner wanted sign-ins extended by use; the other choices were no upper limit, and today's fixed 30 days). |
| Changing the cap | **In the server's settings file** (`LH_MAX_ACCOUNTS` in `deploy/.env`, then `./update.sh`), with a short guide. Not on the Accounts screen. |

## Still for the owner, after the build

- **Approval to ship**, after the screenshot page: every push to `side-tutor` needs it, and the server's branch gets the same commit.
- **Whether the four numbers still fit** (4 accounts, 1 GB per copy, 2 GB of swap, 3 helpers at once), once the real server has run two copies. They are approved as first values.
- **Review of anything added beyond this plan**, listed on that page.

## The approved words

Asked one screen at a time, each with a drawing; the owner's answers. They belong in one place in the code when built (as `src/core/sync/screens.ts` holds the sync screens' words). Change them only with the owner's approval. Quoted names take curly quotes, as elsewhere in the app.

- **The sign-in page** (everyone, every sign-in). "LearnHarness" / "Name" / "Password" / **Sign in** / links "Have an invite code?" and "Forgot your password?".
  - A wrong name or a wrong password: "That name or password isn't right."
  - Too many tries: today's sentence, "Too many attempts. Try again in 15 minutes."
  - **With the correct name and password, on a paused account:** "This account is paused. Ask this server's owner." **On an account the owner removed** (while its data is still kept): "This account was removed. Ask this server's owner." Only after a correct password, so a stranger guessing names learns nothing. (The owner first chose the ordinary sentence here, then changed it to this.)
- **The first-start page** (the owner, once, at the switch-over). "Set up LearnHarness" / "Enter the setup code from the server log, then choose a name and a password of at least 8 characters." / "Setup code" / "Name" with "3 to 20 letters, digits or dashes." / "New password" / "Type it again" / **Create account**. No sentence about the owner's account or the existing data (the owner's choice).
  - A wrong code: today's sentence, "That setup code isn't right. Check the server log for the current code." A name that isn't allowed: "Use 3 to 20 letters, digits or dashes."
- **The invite page** (an invited person, once). "Create your account" / "Invite code" / "Name" with "3 to 20 letters, digits or dashes." and "You sign in with it." / "Password" with "At least 8 characters." / "Type it again" / **Create account**. **No note about what the owner can and can't do** (the owner's choice).
  - Refusals: "That invite code isn't right, or it has run out." / "That name is taken. Choose another." / "This server is full. Ask its owner."
- **The recovery codes page** (once, right after an account is made). "Your recovery codes" / "If you forget your password, any one of these lets you choose a new one. Each works once. They won't be shown again." / the four codes / **Copy**, **Continue**. Nothing has to be ticked first (the owner's choice).
- **The reset page** (from "Forgot your password?"). One box takes either kind of code (the owner's choice). "Choose a new password" / "Enter one of your recovery codes, or a reset code from this server's owner." / "Name" / "Code" / "New password" / "Type it again" / **Set new password**.
  - Refusal: "That name or code isn't right, or the code has been used or has run out."
- **Settings → Accounts** (the owner only). Each account is one line with a **⋯** menu (the owner's choice over buttons on every row; it fits a phone).
  - Group "Accounts": the name, then "Owner · signed in now", "Last seen 9 Nov, 18:20" or "Paused". The menu: **Reset password**, **Pause**, **Remove** (red, last). Under the list: "3 of 4 accounts used."
  - Group "Invite codes": **New invite code**; each waiting code with "Works once, until 22 Nov" and **Cancel**.
  - Group "Removed": the name, "Removed 9 Nov · deleted for good on 9 Dec", **Restore**, **Delete now**.
- **The owner's confirm boxes** (approved as drawn):
  - `Reset “sam”’s password?` / "You get a code to pass on. It works once, for 24 hours. When it is used, sam is signed out everywhere and pairs their desktop apps again." / Cancel, **Get reset code**.
  - `Pause “sam”?` / "sam can't sign in and their copy stops. Nothing is deleted." / Cancel, **Pause**.
  - `Remove “sam”?` / "The account stops now. Its data is kept for 30 days, then deleted for good." / Cancel, **Remove** (red).
  - `Delete “lee” now?` / "This deletes the account's data for good." / Cancel, **Delete** (red).
- **Each person's Settings → Account, the new parts** (approved as drawn):
  - Group "Recovery codes": "2 of 4 left." / **New recovery codes**. Its box: "New recovery codes?" / "Your old codes stop working." / "Password" / Cancel, **Make new codes**.
  - Group "Your data": **Download my data** / "Your sessions, graph and settings as one file."
  - **Delete my account** (not shown to the owner). Its box: "Delete your account?" / "Your account and everything in it are deleted now, for good. This can't be undone. Download your data first if you want to keep it." / "Password" / Cancel, **Delete my account** (red).

- **The last small pieces** (approved as drawn):
  - A paused account's ⋯ menu: **Reset password**, **Resume**, **Remove**.
  - After **New invite code**, a box: "Invite code" / the code / "Works once, until 22 Nov. Send it to the person with this site's address." / **Copy**, **Done**.
  - After **Get reset code**, a box: `Reset code for “sam”` / the code / "Works once, for 24 hours." / **Copy**, **Done**.
  - The server is full (the invite button is greyed): "All 4 accounts are used. Remove one to invite someone." Restore with no room: "All 4 accounts are used. Remove one first."
  - The invite page, a name that can't be used (a reserved one): "That name can't be used. Choose another."
  - At the top of each person's Settings → Account: "Signed in as sam".
- **Reused as they are today:** "The two passwords don't match." and "Use at least 8 characters." on the pages that set a password.

## Build order

**The detailed steps are in `docs/multi-account-build.md`:** the contracts between the pieces (variables, headers, routes, file shapes), and for each slice what to ask the owner first, which files and functions, the tests, the run, and who can build what side by side. This section is the summary.

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
