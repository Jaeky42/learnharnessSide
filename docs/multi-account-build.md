# Build steps: accounts on one server

The step-by-step companion to `docs/multi-account-plan.md` (the approved plan: read it first; it holds the owner's decisions and the design). This file says what to build, in what order, in which files, and how to prove each step. **Nothing here is built, and nothing is to be built until the owner says so.**

The names, routes and file shapes under "Contracts" are the planner's proposals for the inside of the system; a builder may change one for a good reason and should then change it here too. What the owner decided, and every word on a screen, is not the builder's to change.

## Before the first step

1. **The owner's word to build.** Approval of the plan is not it.
2. **Read:** `docs/multi-account-plan.md`, then "Login (VPS)", "Hosting" and "Phase 5: what is built" → "Slice 1" in `docs/cloud-sync.md`.
3. **Ask the owner** (one question per call, with a drawing): the questions listed per slice below. Each slice's questions must be answered before that slice's screens are built; the parts with no screen can go ahead.
4. **Branch.** Work on its own branch. A push to a branch in `.github/workflows/server-image.yml`'s list reaches the owner's real server at the nightly update, so nothing goes to `claude/pensive-goldberg-7dty2m` or `side-tutor` before slice 6 is done and the owner approves. Dry runs: both workflows by hand (`workflow_dispatch`).
5. **Rules that hold in every slice:**
   - The desktop app and a single-copy server (no gateway) behave byte for byte as today. Everything new is switched by `LH_GATE_SECRET` / `LH_ACCOUNT_TAG` being set, or lives in the gateway and the maker. `tests/server-auth.test.ts`, `tests/sync-inert.test.ts`, `tests/sync-pairing.test.ts` and `tests/claude-code-status-ui.test.tsx` stay green untouched.
   - The sync protocol stays 3. If a step seems to need a change on the wire, stop and ask.
   - No secret in a log line, a URL or a command-line argument.
   - Run test files one at a time in a cloud session (one shared memory limit).

## Contracts (fix these first; they let slices be built side by side)

### Processes and ports

| Piece | Image and command | Listens | Networks |
|---|---|---|---|
| Caddy | `caddy:2` | 80, 443 (public) | front; every account's network |
| gateway | the LearnHarness image, `lh-gateway` | 9000 | front; maker |
| maker | the LearnHarness image, `lh-maker` | 9100 | maker only; mounts the Docker socket |
| owner's copy | the LearnHarness image, default command; compose service `lh`, volume `lh-data` (both as today) | 3000 | front |
| an account's copy | the same; container `lh-acct-<tag>`, volume `lh-acct-<tag>-data` | 3000 | `lh-acct-<tag>-net` |

### Environment variables

| Variable | Where | Meaning |
|---|---|---|
| `LH_GATE_SECRET` | every copy | Set: the copy is behind a gateway. Its own password gate is off; every request must carry this value in `X-LH-Gate`. |
| `LH_ACCOUNT_TAG` | an account's copy | Its three-character tag. Absent on the owner's copy. |
| `LH_SEED_WORKER_CONCURRENCY` | an account's copy | Read by the entrypoint only when the volume has no `settings.json` yet: writes "helpers at once" (3). |
| `LH_GATEWAY_FILE` | gateway | Its state file (`/gateway/accounts.json`, on its own volume). |
| `LH_MAX_ACCOUNTS` | gateway | The cap (4). From `deploy/.env`. |
| `LH_OWNER_UPSTREAM`, `LH_OWNER_GATE_SECRET` | gateway | The owner's copy (`lh:3000`) and its secret. |
| `LH_MAKER_URL`, `LH_MAKER_TOKEN` | gateway, maker | Where the maker is, and the shared token for it. |
| `LH_IMAGE`, `LH_CADDY_CONTAINER` | maker | The image every copy is made from (the maker's own), and Caddy's container name (to join it to a new account's network). |

`LH_GATE_SECRET` (owner's copy) and `LH_MAKER_TOKEN` are made once by `deploy/make-secrets.sh` into `deploy/.env`. An account copy's secret is made by the maker and kept in the gateway's file.

### Headers between Caddy, the gateway and a copy

- Caddy removes any `X-LH-Upstream` and `X-LH-Gate` a client sent, before anything else.
- Caddy asks `GET gateway:9000/gate` with the original method, path, `Cookie`, `Authorization`, `Origin` and `Host` (Caddy's `forward_auth` passes the method and path as `X-Forwarded-Method` and `X-Forwarded-Uri`; *from its documentation, proven in slice 0*).
- The gateway's 200 carries `X-LH-Upstream: <host>:3000` and `X-LH-Gate: <that copy's secret>`; Caddy copies both onto the request and proxies to the upstream named. Any other answer goes back to the client as it is.

### What `/gate` decides, in this order

1. `/api/internal/*` → 404 (Caddy refuses it too).
2. A sync path (`isSyncPath`): the tag is read from the Bearer key (46 characters: the first 3 are the tag; 43: the owner's). Account active → 200. Paused, or removed and still kept → **503** (the desktop app reads that as offline and keeps its key). No such account, or no key → 401 `{code: "not_paired"}`, the shape the desktop app already understands.
3. A public file (`/favicon.ico`, `/robots.txt`, `/manifest.webmanifest`, `/_next/`, `/fonts/`, `/icons/`: the list in `isPublic`) → 200, the owner's copy.
4. A write that doesn't come from the site itself (`sameOrigin`) → 403.
5. A valid session cookie of an active account → 200, that account's copy. "Last seen" is touched at most every 5 minutes.
6. Otherwise: an API path → 401 "Sign in to LearnHarness first."; a page → a redirect to `/login` (to `/setup` while no owner exists).

### The gateway's own routes

| Route | Who | Does |
|---|---|---|
| `GET /login`, `/invite`, `/reset`, `/setup` | anyone | The pages (plain HTML, built like `server-auth-pages.ts`, themed with a fixed default palette). |
| `POST /api/server-auth/setup` | anyone, once | The first start: setup code, name, password → the owner's account, bound to the owner's copy. |
| `POST /api/server-auth/login` | anyone | Name and password → the cookie. |
| `POST /api/server-auth/invite` | anyone | Invite code, name, password → asks the maker for a copy, signs in, returns the recovery codes once. |
| `POST /api/server-auth/reset` | anyone | A recovery code or the owner's reset code, the name, a new password. |
| `GET /api/server-auth/account` | signed in | Today's shape (`devices` = signed-in browsers), plus `name`, `owner`, `recoveryCodesLeft`. |
| `POST /api/server-auth/password`, `/logout`, `/sign-out-everywhere` | signed in | As today, per account. |
| `POST /api/server-auth/recovery-codes` | signed in, with the password | Replaces the 4 codes; returns them once. |
| `POST /api/server-auth/delete-account` | signed in, with the password; not the owner | Deletes at once (the owner's decision): ends every session, has the maker remove the container and delete the volume, then erases the account's record. No `removed` state, no 30 days. |
| `GET /api/accounts`, `POST /api/accounts {op}` | the owner | The list, and `invite`, `cancel-invite`, `reset`, `pause`, `resume`, `remove`, `restore`, `delete-now`. |
| `POST /api/sync/pair` | a desktop app | Reads the tag from the code in the body, passes the request to that copy with its secret, passes the answer back. |

`POST /api/server-auth/desktops` (pairing codes, removing a PC) stays the copy's own route, reached through `/gate` like any other.

### A copy's new internal routes (reachable only with the gate secret; never from outside)

- `POST /api/internal/unpair-all`: `removeAllDevices`. The gateway calls it after a password change, either reset, Sign out everywhere, Pause and Remove.
- `GET /api/account/export`: the download (a normal signed-in request, not internal).

### The maker's API (Bearer `LH_MAKER_TOKEN`; internal network only)

| Call | Does |
|---|---|
| `POST /copies {tag}` | Makes the network, the volume and the container from the fixed template, joins Caddy to the network, starts it. Answers `{upstream, gateSecret}`. |
| `POST /copies/<tag>/stop`, `/start` | Pause and resume. |
| `DELETE /copies/<tag>` | Removes the container and its network. The volume stays. |
| `DELETE /volumes/<tag>` | The final deletion. |
| `GET /copies` | Each copy's state and image. |

A tag must be exactly three characters of the code alphabet, or the call is refused. The template takes nothing else from a request: image `LH_IMAGE`; `Memory` 1 GB and `MemorySwap` 2 GB; `CpuShares` equal for all; `PidsLimit` 512; `CapDrop: ALL`; `no-new-privileges`; restart `unless-stopped`; the four variables above.

### The gateway's state file

`{version, accounts[], sessions[], invites[], resets[], lockouts{}, setupCodeHash}`; hashes only; mode 0600; written atomically; a damaged file closes the site (503).

- account: `id`, `tag`, `name`, `nameKey` (lower case), `password` (scrypt), `recoveryCodes[]` (hashes), `role` (`owner` | `member`), `state` (`active` | `paused` | `removed`), `createdAt`, `lastSeenAt`, `removedAt`, `upstream`, `gateSecret`.
- session: today's `SessionRecord` plus `accountId`. invite / reset: `codeHash`, `expiresAt` (reset: `accountId`).

### Tags in codes and keys

- Tag: 3 random characters of `CODE_ALPHABET` (`src/core/server-auth.ts`), unique among accounts, never reused while its volume exists.
- Pairing code: `newSetupCode()` + `-` + tag, shown `XXXX-XXXX-TTT`. After `normalizeSetupCode`: 11 characters, the last 3 the tag; 8 characters is the owner's.
- Device key: tag + 32 random bytes as base64url (46 characters); 43 characters is the owner's.

## The slices

```
0 proof ──► 1 gateway + one account ──► 2 desktop sync ──► 3 maker + invites ──► 4 owner's screen ──► 6 whole run, guide, docs
                                                                    └──────────► 5 each person's own ─┘
```

Slices 4 and 5 can be built side by side. Inside a slice, the lettered parts with different files can be given to different workers.

### Slice 0: the proof

- **Goal:** know that Caddy can route by the gateway's answer, before anything is built on it.
- **Build (throwaway, in a scratch folder, not committed):** Caddy with the sketch below, a 40-line stand-in gateway that answers `/gate` from a query parameter, and two copies of the built server.

  ```
  {$LH_DOMAIN} {
  	encode zstd gzip
  	request_header -X-LH-Upstream
  	request_header -X-LH-Gate
  	handle /api/internal/* {
  		respond 404
  	}
  	@gateway path /login /setup /invite /reset /api/accounts /api/sync/pair /api/server-auth/*
  	@copyOwn path /api/server-auth/desktops
  	handle @copyOwn {
  		import to_copy
  	}
  	handle @gateway {
  		reverse_proxy gateway:9000
  	}
  	handle {
  		import to_copy
  	}
  }
  # to_copy: forward_auth gateway:9000 { uri /gate; copy_headers X-LH-Upstream X-LH-Gate }
  #          reverse_proxy {http.request.header.X-LH-Upstream} { flush_interval -1 }
  ```

  *(A sketch from Caddy's documentation; its syntax is what this slice settles.)*
- **Prove:** the answer picks the copy; a lesson's streamed reply and `/api/events` arrive in pieces; a 26 MB upload to the plugin document route arrives whole; a client-sent `X-LH-Upstream` or `X-LH-Gate` never reaches a copy; a 401, a 302 and a 503 from `/gate` reach the client unchanged; the gateway sees the real method and path.
- **If it doesn't hold:** the gateway carries the requests itself (a streaming proxy in Node). The contracts above stay; only "Caddy copies the headers" becomes "the gateway adds them".
- **In the sandbox:** Docker works after starting `dockerd`, but Docker Hub may refuse the `caddy` image (429). Then run this slice as a job started by hand in GitHub Actions.
- **Worker:** routine. **Done when:** the six proofs are written down in this file, with the Caddyfile that passed.

### Slice 1: the gateway and one account

After it, the owner's server does what it does today, through the gateway, with a name on the sign-in page.

- **Already answered** ("The approved words" in the plan): the sign-in page, the first-start page and their refusals. A paused or removed account is told so only after a correct name and password.
- **1a. The rules** (new `src/core/accounts.ts`, pure, exported like the other core rules): the state's shape and its parser (unknown fields dropped, a wrong version refused), name rules and the reserved list, create / find / pause / remove / restore an account, sessions with an `accountId`, invites, reset codes, recovery codes, the cap. Reuse from `src/core/server-auth.ts`: `hashPassword`, `verifyPassword`, `passwordProblem`, `newSessionToken`, `newSetupCode`, `setupCodeHash`, `setupCodeMatches`, `lockedFor`, `recordFailure`, `clearFailures`, `formatWait`, `deviceLabel`, `SESSION_COOKIE`, `SESSION_LIFETIME_MS`.
  - Tests: `tests/accounts-core.test.ts`.
- **1b. The gateway program** (new `gateway/`): `state.ts` (the file, as `src/store/server-auth.ts` does it), `gate.ts` (the `/gate` decision as one pure function of method, path, headers and state), `routes.ts` (each route as `(Request) => Response`), `pages.ts`, `main.ts` (the HTTP listener, the setup code printed at first start, as `announceSetupCode` does). No dependency beyond Node and `src/core`.
  - Tests: `tests/gateway-gate.test.ts` (the six-step order, every branch), `tests/gateway-routes.test.ts` (sign-in, the lockout, same answer and timing for a wrong name and a wrong password, sign-out, the first-start claim working once, a damaged file → 503).
- **1c. A copy behind the gateway** (`src/server/server-auth.ts`): in `serverGate`, when `LH_GATE_SECRET` is set, the whole decision is "does `x-lh-gate` equal it" (constant time), for pages, APIs and public files alike; sync paths then still run `syncGate`. `proxy.ts` and `src/server/api-gate.ts` need no change (they call `serverGate`). `announceSetupCode` prints nothing in this mode. The copy's `server-login.json` is left as it is, password included, so taking the gateway away again gives the old login back.
  - Also: `accountResponse`, `changePasswordResponse`, `logoutResponse`, `signOutEverywhereResponse`, `loginResponse`, `setupResponse` answer 404 in this mode (the gateway owns those paths). `desktopsResponse` (`src/server/sync/http.ts`) keeps working: today it asks `signedIn(request, state, now)`, which reads the copy's own session list; in this mode the gate secret is the proof. Give `signedIn` that rule once, and check its every caller.
  - New route `app/api/internal/unpair-all/route.ts` → 404 unless the mode is on.
  - Tests: `tests/gate-secret.test.ts`. The existing `tests/server-auth.test.ts` passes untouched.
- **1d. Build and deploy files:** `scripts/build-gateway.mjs` bundles `gateway/main.ts` and `gateway/maker.ts` with esbuild into single `.mjs` files (add `esbuild` as a dev dependency with npm 11; it is in `node_modules` today only through `tsx`). `Dockerfile`: run it in the build stage, copy the two files, add `lh-gateway` and `lh-maker` wrappers like `reset-password`. `deploy/compose.yaml`: the `gateway` service and its volume, `LH_GATE_SECRET` on `lh`, a fixed `container_name` for Caddy. `deploy/Caddyfile` from slice 0. `deploy/make-secrets.sh`. `deploy/.env.example`. `scripts/server-reset-password.mjs`: with `LH_GATEWAY_FILE` set it resets the owner's account in the gateway's file (and `reset-password` runs in the gateway's container).
  - The desktop build must not pick the gateway up: `scripts/build-server.mjs` is not changed.
- **Run:** Caddy, the gateway and one copy with the golden data, in a browser at computer and phone size: first-start claim, sign in, a lesson, Settings → Account, sign out, the lockout, the home-screen manifest and icons while signed out.
- **Risk:** high. Complex implementer for 1b and 1c, routine for 1a and 1d; one deep review of 1b + 1c together.

### Slice 2: desktop sync through the gateway

- **No questions for the owner** (no screen changes), unless the desktop app's code box turns out too narrow for 13 characters (`max-w-40` in `components/settings/cloud-section.tsx`): widening it is a desktop release, which is the owner's to approve.
- **2a. Tags in the copy** (`src/core/sync/devices.ts`): `startPairing` appends the tag to the code and `completePairing` puts it before the key, both only when a tag is given; callers in `src/server/sync/http.ts` pass `process.env.LH_ACCOUNT_TAG`. `pairResponse` must not require `state.password` in gateway mode (today it answers "This server isn't set up yet" without one).
- **2b. The gateway's side:** the sync branch of `/gate`, and `POST /api/sync/pair` (read the JSON body once, at most a few kilobytes; pick the copy by the code's tag; forward with the gate secret and the client's address; a wrong code still counts toward the copy's own lockout, as now).
- **Tests:** `tests/sync-tags.test.ts` (codes and keys with and without a tag; the existing pairing tests untouched), more cases in `tests/gateway-gate.test.ts` (a 43- and a 46-character key, a changed tag, a paused account → 503, a deleted one → 401 `not_paired`), and one in-process run: the real desktop client (`pairWithServer`, `syncRequest`) → the gateway's functions → the real copy's gate and routes, for the owner's copy (no tag) and a tagged one.
- **Run:** two built copies and the gateway; a third built copy plays a desktop app and pairs with each account in turn, with the loop on; a desktop paired **before** the gateway was put in front carries on without pairing again.
- **Risk:** high (a wrong route here shows one person's sessions to another's PC). Complex implementer; one deep review.

### Slice 3: the maker, invites and new accounts

- **Already answered:** the invite page and its refusals (no note about the owner's powers) and the recovery-codes page (Copy and Continue, nothing to tick). **Still to ask:** the sentence for a reserved name.
- **3a. The maker** (new `gateway/maker.ts` and `gateway/docker.ts`): the Docker Engine API over the socket with plain `node:http` (`socketPath`), no dependency. The fixed template; the per-account network and joining Caddy to it; start, stop, remove; at its own start, bring every `lh-acct-*` container whose image differs from `LH_IMAGE` onto it, one at a time.
  - Tests: `tests/maker.test.ts` against a stand-in Docker API on a socket: the exact create request (limits, no extra mounts, no privileges), a refused tag, the token check, the re-create on a new image.
- **3b. Invites in the gateway:** `POST /api/server-auth/invite`, the cap, the tag's choice, the maker call, rolling back the account if the maker fails, the recovery codes returned once.
- **3c. The entrypoint** (`deploy/docker-entrypoint.sh`): the `LH_SEED_WORKER_CONCURRENCY` seed, only on a volume with no `settings.json`.
- **3d. Compose:** the `maker` service (the socket mounted, the maker network, `LH_IMAGE` and `LH_CADDY_CONTAINER`), and the gateway's `LH_MAKER_*`.
- **Run (real Docker):** redeem an invite; the new copy answers through the gateway; from inside one copy, `curl` to the other copy's address fails or is refused (network, then secret); Chromium still starts in a hardened copy (`--no-sandbox`, all capabilities dropped); Claude Code and `ob` still install themselves under the limits; a copy that passes its memory ceiling is restarted alone.
- **Risk:** high (rights over Docker). Complex implementer; one deep review of the maker and the template.

### Slice 4: the owner's screen

- **Already answered:** Settings → Accounts (a ⋯ menu per account), its four confirm boxes, and what a paused or removed person reads at sign-in. **Still to ask:** the menu item that undoes Pause, and how a reset code and a new invite code are shown once made.
- **Build:** the gateway's `/api/accounts` (owner only, checked by the gateway; an `lh_owner=1` marker cookie only decides whether the row shows); the 30-day deletion (checked at the gateway's start and once a day; `DELETE /volumes/<tag>`); the unpair-all calls. New `components/settings/accounts-section.tsx`; one row in `components/settings/settings-dialog.tsx` (upstream's file; add it to the list in `docs/upstream-0.6.0.md`); the phone's Settings list (`components/phone/phone-plugins.ts`, `tests/phone-layout.test.ts` pin the rows).
- **Tests:** `tests/gateway-accounts.test.ts` (each `op`, a non-owner refused, the cap, Restore with no free slot, the 30 days with a moved clock), `tests/accounts-ui.test.tsx` (every state with the approved words; the row absent for a member and in the desktop app).
- **Risk:** moderate. Routine implementer for the screen, complex for the gateway part.

### Slice 5: each person's own

- **Already answered:** the new parts of Settings → Account and their boxes, the reset page (one box for either code), and the download's file type (.zip).
- **Delete my account is immediate** (the owner's decision): the gateway checks the password, ends every session, calls the maker's `DELETE /copies/<tag>` and `DELETE /volumes/<tag>`, and only then erases the record. If the maker fails part-way, the account stays signed out and marked for deletion and the gateway tries again; it is never left usable with half its data gone.
- **5a. Settings → Account** (`components/settings/account-section.tsx`): reads the gateway's wider answer; the three new blocks only when the answer has them, so a single-copy server's screen is unchanged.
- **5b. Reset** in the gateway: recovery code or owner's code, both counted by the one lockout, both ending every session and unpairing.
- **5c. Download my data:** `app/api/account/export/route.ts` and `src/server/account-export.ts`: the parts `src/store/sync/backup.ts` lists (`chats`, `graph`, `jobs`, `settings.json`, `prompts`, `themes`, `notes/sessions`, `plugins-state.json`, `core-plugin-data`), streamed, never `sync/`, the secrets folder, the home folder or the vault. The owner chose **.zip**; the repo has no archive library, so add one small zip writer (with npm 11, for the lockfile), or write the store-only zip format by hand if nothing suitable is found. The file is named `learnharness-<name>-<date>.zip`.
- **5d. Browser storage at sign-out:** the app's stored keys are window and view state (`lh:side-tutor:pos`, `lh:side-tutor:size`, `lh:notes-*`, `lh:sidebar-open`, `lh:session-kind-filter`, `lh:zoom`, `lh.graph.camera.v1`). Check the files that touch storage (`components/chat.tsx`, `opening-prompt.ts`, `sidebar.tsx`, `graph-view.tsx`, `graph-canvas.ts`, `notes/notes-drawer.tsx`, `side-tutor.tsx`, `settings/settings-dialog.tsx`, `settings/keyboard-section.tsx`) for anything that holds a person's words, and clear that at sign-out.
- **Tests:** `tests/gateway-reset.test.ts`, `tests/account-export.test.ts` (what is in, what is never in), more cases in `tests/server-auth-ui`-style tests for the Account screen.
- **Risk:** moderate; the reset paths get the deep reviewer's eye with slice 1's.

### Slice 6: the whole thing

- **The crossing tests**, in `.github/workflows/server-image.yml` after the image is built (real Caddy, gateway, maker and three copies): with two accounts, each of these is tried and refused: the other's session cookie; the other's device key; a key with a changed tag; a forged `X-LH-Upstream` and `X-LH-Gate`; a direct call from inside one container to another; a pairing code redeemed with another account's tag; a removed account's cookie and key; `/api/internal/*` from outside; the maker's port from a copy.
- **The unchanged tests:** the existing smoke test of a single copy (setup code, `reset-password`, `ob`, Chromium) stays as it is, beside the new one.
- **The update:** build two images, start the stack on the first, switch to the second; every copy ends on the second, and a signed-in page and a paired desktop carry on.
- **The switch-over guide** for the owner (an Artifact page; each command tagged with where it runs): the copy of the server's data by hand; swap (`free -h`, then the commands); `git pull` in the repo folder (files in `deploy/` changed); `./make-secrets.sh`; `./update.sh`; the setup code from `docker compose logs gateway`; the claim; checking the phone and the paired PC; the way back (the previous `deploy/` files and image tag: the copy's own password gate works again, because its login file was never touched).
- **Docs:** "what was built" into `docs/cloud-sync.md` (a new part under "Hosting"), the plan's status, `CLAUDE.md`'s list of docs, the upstream-file list in `docs/upstream-0.6.0.md`.
- **Then, with the owner's approval:** the same commit to both branches. No protocol change, so no order is forced; the server gets it first so the owner can try it. A desktop release happens only because `side-tutor` moved.

## Who can build what at the same time

| Files | One owner at a time |
|---|---|
| `src/core/accounts.ts` | 1a |
| `gateway/**` except the maker | 1b, then 2b, 3b, 4, 5b in turn |
| `gateway/maker.ts`, `gateway/docker.ts` | 3a (can start as soon as the contracts stand) |
| `src/server/server-auth.ts`, `app/api/internal/**` | 1c |
| `src/core/sync/devices.ts`, `src/server/sync/http.ts` | 2a (after 1c: both touch the copy's gate behaviour) |
| `Dockerfile`, `deploy/**`, `scripts/build-gateway.mjs`, `scripts/server-reset-password.mjs` | 1d, then 3c and 3d |
| `components/settings/accounts-section.tsx`, `settings-dialog.tsx` | 4 |
| `components/settings/account-section.tsx`, `app/api/account/**`, `src/server/account-export.ts` | 5 |
| `.github/workflows/server-image.yml` | 6 |

The maker (3a) and the rules (1a) depend on nothing but the contracts, so they can start with slice 0.

## What to tell the owner at the end of each slice

A short list of what was built, what was run and how, what couldn't be checked outside the real server, and any wording or behaviour added beyond what was approved, for review. After slice 1 and after slice 3, a page of screenshots from the running stack.
