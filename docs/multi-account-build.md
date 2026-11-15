# Build steps: accounts on one server

The step-by-step companion to `docs/multi-account-plan.md` (the approved plan: read it first; it holds the owner's decisions and the design). This file says what to build, in what order, in which files, and how to prove each step. **Status: built on `claude/dazzling-maxwell-j6mfy1`, not shipped.** The owner's word to build was given; shipping needs their approval after the page of screenshots. What was built, the builder's rulings and what is still open are in `docs/cloud-sync.md` ("Accounts on one server (built, not shipped)" under "Hosting"). The sections below are the guide as it was written; where the build differs, the text says "(changed while building: reason)", so the contracts here match the code.

The names, routes and file shapes under "Contracts" are the planner's proposals for the inside of the system; a builder may change one for a good reason and should then change it here too. What the owner decided, and every word on a screen, is not the builder's to change.

## Before the first step

1. **The owner's word to build.** Approval of the plan is not it.
2. **Read:** `docs/multi-account-plan.md`, then "Login (VPS)", "Hosting" and "Phase 5: what is built" → "Slice 1" in `docs/cloud-sync.md`.
3. **Nothing is left to ask before building.** The owner answered the wording and the build questions; they are in the plan under "The approved words" and "How it is built and tried". If a screen needs a word that isn't there, use the app's existing wording for the same thing where one exists; otherwise build it with a clearly marked placeholder and list it on the end page for the owner. Never invent a sentence silently.
4. **Branch.** Work on its own branch, started from `claude/upstream-0.6.0`. A push to a branch in `.github/workflows/server-image.yml`'s list reaches the owner's real server at the nightly update, so nothing goes to `claude/pensive-goldberg-7dty2m` or `side-tutor` before slice 6 is done and the owner approves. Dry runs: both workflows by hand (`workflow_dispatch`).
5. **No stops** (the owner's decision): run slices 0 to 6 straight through and come back once, with the screenshot page. Stop earlier only when the plan can't be followed as written; that goes to the owner before anything is changed.
6. **Rules that hold in every slice:**
   - The desktop app and a single-copy server (no gateway) behave byte for byte as today. Everything new is switched by `LH_GATE_SECRET` / `LH_ACCOUNT_TAG` being set, or lives in the gateway and the maker. `tests/server-auth.test.ts`, `tests/sync-inert.test.ts`, `tests/sync-pairing.test.ts` and `tests/claude-code-status-ui.test.tsx` stay green untouched.
   - The sync protocol stays 3. If a step seems to need a change on the wire, stop and ask.
   - No secret in a log line, a URL or a command-line argument.
   - Run test files one at a time in a cloud session (one shared memory limit).

## Contracts (fix these first; they let slices be built side by side)

### Processes and ports

| Piece | Image and command | Listens | Networks |
|---|---|---|---|
| Caddy (container `lh-caddy`) | `caddy:2` | 80, 443 (public); 9200 (the internal relay, never published) | front; owner; every account's network |
| gateway | the LearnHarness image, `lh-gateway` | 9000 | front; maker |
| maker | the LearnHarness image, `lh-maker` | 9100 | maker only; mounts the Docker socket |
| owner's copy | the LearnHarness image, default command; compose service `lh`, volume `lh-data` (both as today) | 3000 | owner |
| an account's copy | the same; container `lh-acct-<tag>`, volume `lh-acct-<tag>-data` | 3000 | `lh-acct-<tag>-net` |

**(Changed while building: the plan says each copy's network is joined only by Caddy, and nothing else may reach the gateway.)** Networks, as built: `front` (named `lh-0-front`) = Caddy and the gateway only; `owner` (`lh-1-owner`) = Caddy and the owner's copy; `maker` (`lh-2-maker`) = gateway and maker (`internal: true`); each account's `lh-acct-<tag>-net` = that copy and Caddy (not internal: the copy needs outbound access). So nothing but Caddy reaches the gateway, and no copy shares a network with another copy, the gateway or the maker. The owner's copy sat on `front` in the first table; it now has its own network. **(Changed after a CI run:** the three have fixed names, chosen so `lh-0-front` sorts before every `lh-acct-` network: Docker routes a container on several networks, published ports included, through the network whose name sorts first, so a project named `stack` let the first account network take Caddy's ports and cut a request in flight. The maker also joins Caddy with `GwPriority` −1. One stack per host; "Networks, as built" in `docs/cloud-sync.md`.)

**The relay (changed while building: the same reason).** The gateway can't reach a copy directly, yet it must forward a pairing request and call a copy's `/api/internal/unpair-all`. It does both through an internal site in Caddy (`http://:9200`, plain HTTP, never published), which opens only for `LH_RELAY_TOKEN` (`X-LH-Relay`) and only for an upstream that is a copy's address; the gateway sends the copy's address and secret (`X-LH-Upstream`, `X-LH-Gate`), the scope (`X-LH-Scope`: `sync` or `internal`) and the real client's address (`X-LH-Client-Addr`, which Caddy turns into the copy's `X-Forwarded-For`). The relay is reachable from every network Caddy is on, so the token is what keeps a copy's programs out.

**Limits (changed while building: for the owner to confirm).** The owner's own copy in `deploy/compose.yaml` has the same limits as an account's copy (1 GB memory, 2 GB with swap, 512 processes, no capabilities, `no-new-privileges`, init); a test keeps them equal to the maker's template. The gateway has 256 MB and 128 processes, a read-only root and `/tmp` as tmpfs; the maker 128 MB and 64 processes, a read-only root, the socket's group added (`group_add: LH_DOCKER_GID`) so it stays the image's `node` user. The maker needs **Docker 25 or newer** (Engine API 1.44).

### Environment variables

| Variable | Where | Meaning |
|---|---|---|
| `LH_GATE_SECRET` | every copy | Set: the copy is behind a gateway. Its own password gate is off; every request must carry this value in `X-LH-Gate`. |
| `LH_ACCOUNT_TAG` | an account's copy | Its three-character tag. Absent on the owner's copy. |
| `LH_SEED_WORKER_CONCURRENCY` | an account's copy | Read by the entrypoint only when the volume has no `settings.json` yet: writes "helpers at once" (3). |
| `LH_GATEWAY_FILE` | gateway | Its state file (`/gateway/accounts.json`, on its own volume). |
| `LH_MAX_ACCOUNTS` | gateway | The cap (4). From `deploy/.env`. |
| `LH_OWNER_UPSTREAM`, `LH_OWNER_GATE_SECRET` | gateway | The owner's copy (`lh:3000`) and its secret (the copy's `LH_GATE_SECRET`; at least 32 characters). |
| `LH_MAKER_URL`, `LH_MAKER_TOKEN` | gateway, maker | Where the maker is, and the shared token for it. |
| `LH_RELAY_URL`, `LH_RELAY_TOKEN` | gateway; Caddy (the token) | Caddy's internal relay (`http://caddy:9200`) and its token (at least 32 characters). *(Added while building: the relay, above.)* |
| `LH_IMAGE`, `LH_CADDY_CONTAINER` | maker | The image every copy is made from (compose passes the image the whole stack runs; without it, the maker's own container's image), and Caddy's container name (`lh-caddy`, to join it to a new account's network). |
| `LH_DOCKER_GID`, `LH_DOCKER_SOCKET` | compose | The Docker socket's group id (added to the maker's groups) and the socket's path if it isn't `/var/run/docker.sock`. *(Added while building: the maker doesn't run as root.)* |

`LH_GATE_SECRET` (owner's copy), `LH_MAKER_TOKEN` and `LH_RELAY_TOKEN` are made once by `deploy/make-secrets.sh` into `deploy/.env`, which also adds `LH_DOCKER_GID` (changed while building: the relay and the maker's group). An account copy's secret is made by the maker and kept in the gateway's file.

### Headers between Caddy, the gateway and a copy

- Caddy removes any `X-LH-Upstream`, `X-LH-Gate`, `X-LH-Scope`, `X-LH-Relay` and `X-LH-Client-Addr` a client sent, before anything else. *(Changed while building: three more headers than the first two.)*
- Caddy asks `GET gateway:9000/gate` with the original method, path, `Cookie`, `Authorization`, `Origin` and `Host` (Caddy's `forward_auth` passes the method and path as `X-Forwarded-Method` and `X-Forwarded-Uri`; proven in slice 0).
- The gateway's 200 carries `X-LH-Upstream: <host>:3000`, `X-LH-Gate: <that copy's secret>` and **`X-LH-Scope`** (`public`, `sync` or `session`); Caddy copies all three onto the request and proxies to the upstream named. Any other answer goes back to the client as it is. **(Changed while building: `X-LH-Scope` is new. A security review showed that the gateway and a copy could read one request path differently, because Caddy forwards request targets raw to both. The gateway now says what kind of request it let through, and the copy re-checks that against the path as the copy itself parses it; the gateway also refuses any non-canonical path with 400, and its public list is narrower than the copy's.)**
- **Caddy also (changed while building, for the reasons in `docs/cloud-sync.md`):** strips the session cookie (`__Host-lh_session`) before a request reaches any copy, so a program inside a copy can't act as that person against the gateway; refuses a request with a `Service-Worker` header (403) and strips `Service-Worker-Allowed` from answers (one shared origin, no service worker in the app); has `admin off`; and fails closed (502) when the gateway's answer has no upstream, no scope, or an upstream that isn't a copy's address.

### What `/gate` decides, in this order

**(Changed while building: the order below is what `decideGate` in `gateway/gate.ts` does; the guide's first draft had the same six steps without the canonical-path check, the damaged-file answer and the unpair marks.)**

0. A request target that isn't in one canonical form (a fragment, the absolute form, a control character, space or backslash; dot segments, encoded slashes, `%2e`, `%00`, `%23` or doubled slashes in the path; anything a URL parser would change) → 400.
1. `/api/internal/*` → 404 (Caddy refuses it too).
2. A sync path (`isSyncPath`): the tag is read from the Bearer key (46 characters: the first 3 are the tag; 43: the owner's). A damaged state file → 503. A key of no valid shape, or none → 401 `{code: "not_paired"}`, the shape the desktop app already understands. Untagged → the owner's copy (503 while its unpair is owed). Tagged: no owner yet → 503; no such account, the owner's, or an account being deleted → 401 `not_paired`; paused, removed (still kept), without a copy yet or owing an unpair-all → **503** (the desktop app reads that as offline and keeps its key); active → 200, scope `sync`.
3. A public file (`/favicon.ico`, `/robots.txt`, `/_next/static/`, `/fonts/`, `/icons/`: `isPublicFile`, narrower than the copy's own list, without the manifest and without other `/_next/` paths) → 200, the owner's copy, scope `public`. **`/manifest.webmanifest` is the gateway's own**, with the standard dark colours (the owner's decision), so Caddy sends that path to the gateway.
4. A write that doesn't come from the site itself (`sameOrigin`) → 403.
5. A damaged state file → 503.
6. A valid session cookie of an active account with a ready copy → 200, that account's copy, scope `session`. "Last seen" is touched at most every 5 minutes, and with it the session is extended: valid until 30 days after its last use, never past 6 months after its sign-in (the owner's decision).
7. Otherwise: an API path → 401 "Sign in to LearnHarness first."; a page → a redirect to `/login` (to `/setup` while no owner exists).

### The gateway's own routes

| Route | Who | Does |
|---|---|---|
| `GET /gate`, `GET /healthz` | Caddy | The decision above; a plain "ok". |
| `GET /login`, `/invite`, `/reset`, `/setup` | anyone | The pages (plain HTML, built like `server-auth-pages.ts`, in the app's standard dark theme, always: the owner's decision; the palette is the default theme's, read from the app's own theme definitions at build time, never from anyone's saved theme). |
| `POST /api/server-auth/setup` | anyone, once | The first start: setup code, name, password → the owner's account, bound to the owner's copy, signed in. *(Added while building: the answer carries the owner's four recovery codes, once.)* |
| `POST /api/server-auth/login` | anyone | Name and password → the cookie. |
| `POST /api/server-auth/invite` | anyone | Invite code, name, password → asks the maker for a copy, signs in, returns the recovery codes once. |
| `POST /api/server-auth/reset` | anyone | A recovery code or the owner's reset code, the name, a new password. |
| `GET /api/server-auth/account` | signed in | Today's shape (`devices` = signed-in browsers), plus `name`, `owner`, `recoveryCodesLeft`. |
| `POST /api/server-auth/password`, `/logout`, `/sign-out-everywhere` | signed in | As today, per account. |
| `POST /api/server-auth/recovery-codes` | signed in, with the password | Replaces the 4 codes; returns them once. |
| `POST /api/server-auth/delete-account` | signed in, with the password; not the owner | Deletes at once (the owner's decision): ends every session, has the maker remove the container and delete the volume, then erases the account's record. No `removed` state, no 30 days. |
| `GET /api/accounts`, `POST /api/accounts {op}` | the owner | The list, and `invite`, `cancel-invite`, `reset`, `pause`, `resume`, `remove`, `restore`, `delete-now`. |
| `POST /api/sync/pair` | a desktop app | Reads the tag from the code in the body, passes the request to that copy (through the relay) with its secret and the client's address, passes the answer back. |
| `POST /control/reset-owner` | the `lh-gateway reset-owner` command only | *(Added while building.)* Loopback only, never with a forwarding header (Caddy always adds one); not routed by Caddy. The owner's last way back in. |

`POST /api/server-auth/desktops` (pairing codes, removing a PC) stays the copy's own route, reached through `/gate` like any other.

### A copy's new internal routes (reachable only with the gate secret; never from outside)

- `POST /api/internal/unpair-all`: `removeAllDevices`. The gateway calls it (through the relay, scope `internal`) after a password change, either reset and Sign out everywhere. **(Changed while building, settled by the plan: the guide said "Pause and Remove" too. The plan says a paused or removed account's desktop app keeps its key and carries on after Restore, so Pause and Remove end browser sessions only; the app gets 503 meanwhile and 401 `not_paired` only after the data is deleted for good.)** The account is marked `unpairPending` in the same write as the change, the call is retried until the copy confirms, and while the mark is set that account's sync requests get 503 and new pairings are refused.
- `GET /api/account/export`: the download (a normal signed-in request, not internal).

### The maker's API (Bearer `LH_MAKER_TOKEN`; internal network only)

| Call | Does |
|---|---|
| `POST /copies {tag, start?, fresh?}` | Makes the network, the volume and the container from the fixed template, joins Caddy to the network, starts it (not when `start` is literally `false`). `fresh: true` (a new account only): 409 `copy_exists` / `volume_exists` and nothing made when the tag's container, a swap's leftover or its volume exists. On an existing copy: re-created on the same volume with a new secret. Answers `{upstream, gateSecret}`. |
| `POST /copies/<tag>/stop`, `/start` | Pause and resume. 404 `no_copy` when there is none. |
| `DELETE /copies/<tag>` | Removes the container (a swap's leftovers too) and its network. The volume stays. |
| `DELETE /volumes/<tag>` | The final deletion. 409 `volume_in_use` while a container uses it. |
| `GET /copies` | Each copy's state and image: `[{tag, state, image, upToDate}]`. |
| `GET /volumes` | `[{tag}]` for every `lh-acct-<tag>-data` volume. |
| `POST /reconcile` | Finishes interrupted swaps, joins Caddy to every account network, brings every copy onto the current image, one at a time. Also run at the maker's start. |

*(Changed while building: `start: false` and `fresh: true` on create, `GET /volumes` and `POST /reconcile` are new. `fresh` exists so a new account can never be given another person's leftover data (a lost state file, an abandoned attempt); `start: false` lets a paused account's copy be re-created without running; `GET /volumes` lets the gateway avoid tags whose volume exists.)*

A tag must be exactly three characters of the code alphabet, or the call is refused. The template takes nothing else from a request: image `LH_IMAGE`; `User: node`; the volume as the only mount; `Memory` 1 GB and `MemorySwap` 2 GB; `CpuShares` equal for all; `PidsLimit` 512; `CapDrop: ALL`; `no-new-privileges`; `Init: true`; a log-size bound (3 files of 10 MB); restart `unless-stopped`; the variables `LH_GATE_SECRET`, `LH_ACCOUNT_TAG`, `LH_SEED_WORKER_CONCURRENCY`, `LH_TRUST_PROXY=1` and the maker's `TZ`. *(Changed while building: `Init`, the log bound, `User: node` and `LH_TRUST_PROXY` are added.)* **Re-creating a copy** (on a new image, or with a new secret) keeps the old container, renamed `lh-acct-<tag>-old-running` / `-old-stopped`, until the new one runs, and an interrupted swap is finished at the next call or start; on SIGTERM the maker waits for work under way. The maker reaches Docker over the socket with the Engine API 1.44, so the server needs Docker 25 or newer; socket access is through `group_add` of the socket's group id (`LH_DOCKER_GID`, written by `make-secrets.sh`). Its entry file is `gateway/maker-main.ts` (`maker.ts` never starts itself, so tests can import it).

### The gateway's state file

`{version, accounts[], sessions[], invites[], resets[], lockouts{}, setupCodeHash}`; hashes only; mode 0600; written atomically; a damaged file closes the site (503).

- account: `id`, `tag`, `name`, `nameKey` (lower case), `password` (scrypt), `recoveryCodes[]` (hashes), `role` (`owner` | `member`), `state` (`active` | `paused` | `removed` | `deleting`), `createdAt`, `lastSeenAt`, `removedAt`, `upstream`, `gateSecret`. *(Changed while building: `deleting` is a fourth state, an account whose deletion started and must be finished (no slot, no sign-in; its name and tag are kept until the record is erased); and four optional marks: `unpairPending`, `copyPending`, `keepVolume`, `codeFailures`.)*
- session: today's `SessionRecord` plus `accountId`; `expiresAt` moves with use (`lastSeenAt` + 30 days, capped at `createdAt` + 180 days). The cookie itself is set once, at sign-in, with a 180-day lifetime, and the gateway decides whether it still counts: `/gate` answers through Caddy's `forward_auth`, which can't hand a fresh cookie back to the browser. New constants beside `SESSION_LIFETIME_MS` in the account rules (30 days idle, 180 days in all); `src/core/server-auth.ts`'s own fixed 30 days are not changed. invite / reset: `codeHash`, `expiresAt` (reset: `accountId`). Also `lockoutPauseUntil?` (a full lockout table's pause) and, in each lockout record, `against` (whose password every counted failure was against). The file has a daily backup beside it (`accounts.json.bak`), and a missing file with a backup beside it reads as damaged, not as "no accounts". *(Added while building.)*

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
  	@gateway path /login /setup /invite /reset /manifest.webmanifest /api/accounts /api/sync/pair /api/server-auth/*
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

**Result: it held** (real Caddy, 2.11.9 at slice 0 from `caddy:2`; a stand-in gateway and two stand-in copies; run in the sandbox with `--network host`). Caddy chooses the upstream from the gateway's answer, so the fallback (the gateway carrying requests itself) was **not needed**. Slice 0 ran with stand-in copies, not built ones (a build could not run while other files were being edited); built copies ran later in the real stack.

**The proofs** (the six asked for, plus the ones the design added):

1. **The answer picks the copy:** one request signed as A reached copy A with A's secret; as B, copy B with B's.
2. **Streams arrive in pieces:** a server-sent stream arrived in ten chunks over 3 s, also with gzip (`encode zstd gzip`); the events channel is the same case. (`flush_interval -1`.)
3. **A 26 MB upload arrives whole:** a 27,262,976-byte POST arrived with the same bytes and the same SHA-256.
4. **A client can't name its copy:** client-sent `X-LH-Upstream`, `X-LH-Gate`, `X-LH-Relay` and `X-LH-Client-Addr` never reached a copy (only the gateway's values) and never reached `/gate`.
5. **The gateway's 401, 302 and 503 reach the client unchanged** (status, headers, body).
6. **`/gate` sees the real request:** `X-Forwarded-Method`, `X-Forwarded-Uri` (path and query), `Cookie`, `Authorization`, `Origin` and the original `Host`; a client's `X-Forwarded-For` is replaced, not appended (no `trusted_proxies`).
7. **Paths:** `/api/internal/*` → 404 with no `/gate` call; `/api/server-auth/desktops` → `/gate` → the copy; `/api/server-auth/login`, `POST /api/sync/pair` (body intact), `/login` → the gateway directly with no `/gate` call.
8. **The relay:** the right token reaches the copy (its secret kept, `X-LH-Relay` and `X-LH-Client-Addr` removed, the client's address as `X-Forwarded-For`, a client-supplied one gone; a stream passes); a wrong token, none, or an empty `X-LH-Relay` → 404; with `LH_RELAY_TOKEN` empty → 404 for everything.
9. **Failing closed:** a gateway answer naming a dead upstream → 502; the gateway down → 502.
10. **No `X-LH-*` header in any response to a client.**

**Re-run on the Caddyfile as built:** the ten proofs at slice 0 (the first production Caddyfile, validated with `caddy validate`); **fourteen** after the first review's changes; **eighteen plus 27 stand-in checks** after the second review's (real `caddy:2` with the repo's `deploy/Caddyfile` unmodified and a stand-in gateway and copies on one network: the cookie strip in every position of the `Cookie` header, a missing or client-sent `X-LH-Scope`, the upstream allow-list, the relay passing the scope). Re-run them whenever the Caddyfile changes; the file is also pinned by `tests/deploy-files.test.ts`. Not tested: Caddy's certificate path for a real domain, HTTP/2 and HTTP/3 clients, `trusted_proxies` behind another proxy.

**Differences from the sketch above** (slice 0 settled the syntax): the `to_copy` snippet must be defined before its first `import`; `request_header` and `forward_auth` are ordered with an explicit `route { }`, the `handle` blocks inside it; the relay's token uses the parse-time `{$LH_RELAY_TOKEN}` (the runtime `{env.X}` placeholder breaks CEL expressions); `/api/accounts/*` is added to the gateway's paths; and, from the reviews, `admin off`, the extra stripped headers, the scope, the cookie strip, the `Service-Worker` refusal and the fail-closed 502s.

**The Caddyfile that passed** (`deploy/Caddyfile`, as it is now):

```
{
	# Nothing here reloads the config (update.sh re-creates the container), and
	# Caddy sits on every account's network: no admin endpoint at all.
	admin off
	servers {
		# no trusted_proxies: client X-Forwarded-* is never trusted
	}
}

(strip) {
	request_header -X-LH-Upstream
	request_header -X-LH-Gate
	request_header -X-LH-Relay
	request_header -X-LH-Client-Addr
	request_header -X-LH-Scope
}

# The only upstreams there are: the owner's copy, or an account's (tag: the
# setup code's alphabet; a test keeps the class equal to it). The public route
# and the relay both require it.
(copy_upstream) {
	header_regexp X-LH-Upstream ^(lh|lh-acct-[0-9A-HJKMNP-TV-Z]{3}):3000$
}

(to_copy) {
	forward_auth gateway:9000 {
		uri /gate
		copy_headers X-LH-Upstream X-LH-Gate X-LH-Scope
	}
	# Fail closed: a gateway answer that names no upstream, an upstream that
	# isn't a copy, or no scope never proxies anywhere.
	@noUpstream expression `{http.request.header.X-LH-Upstream} == ""`
	respond @noUpstream 502
	@notACopy not {
		import copy_upstream
	}
	respond @notACopy 502
	@noScope expression `{http.request.header.X-LH-Scope} == ""`
	respond @noScope 502
	reverse_proxy {http.request.header.X-LH-Upstream} {
		flush_interval -1
		# All accounts share one origin: a copy must not plant a service worker.
		header_down -Service-Worker-Allowed
		# A copy never gets the gateway's session cookie (its proof is the gate
		# secret): code inside a copy can't act as that person, or the owner,
		# against the gateway. Every other cookie passes unchanged; the
		# forward_auth request above still carries the full header. First the
		# cookie with the separator before it, then a separator left at the start.
		header_up Cookie "(^|;\s*)__Host-lh_session=[^;]*" ""
		header_up Cookie "^;\s*" ""
	}
}

{$LH_DOMAIN} {
	encode zstd gzip

	route {
		import strip

		# Browsers send this header when fetching a worker script. The app has
		# no service worker, so none is ever served or registered.
		@serviceWorker header Service-Worker *
		handle @serviceWorker {
			respond 403
		}

		handle /api/internal/* {
			respond 404
		}

		@copyOwn path /api/server-auth/desktops
		@gateway path /login /setup /invite /reset /manifest.webmanifest /api/accounts /api/accounts/* /api/sync/pair /api/server-auth/*

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
}

# Internal relay: plain HTTP, internal network only (never published).
http://:9200 {
	route {
		# The token, and an upstream that is a copy (X-LH-Scope, set by the
		# gateway, passes through untouched).
		@ok {
			expression `"{$LH_RELAY_TOKEN}" != "" && {header.X-LH-Relay} == "{$LH_RELAY_TOKEN}"`
			import copy_upstream
		}
		handle @ok {
			reverse_proxy {http.request.header.X-LH-Upstream} {
				flush_interval -1
				header_up -X-LH-Relay
				header_down -Service-Worker-Allowed
				header_up X-Forwarded-For {http.request.header.X-LH-Client-Addr}
				header_up -X-LH-Client-Addr
			}
		}
		handle {
			respond 404
		}
	}
}
```

### Slice 1: the gateway and one account

After it, the owner's server does what it does today, through the gateway, with a name on the sign-in page.

- **Already answered** ("The approved words" in the plan): the sign-in page, the first-start page and their refusals. A paused or removed account is told so only after a correct name and password.
- **1a. The rules** (new `src/core/accounts.ts`, pure, exported like the other core rules): the state's shape and its parser (unknown fields dropped, a wrong version refused), name rules and the reserved list, create / find / pause / remove / restore an account, sessions with an `accountId`, invites, reset codes, recovery codes, the cap. Reuse from `src/core/server-auth.ts`: `hashPassword`, `verifyPassword`, `passwordProblem`, `newSessionToken`, `newSetupCode`, `setupCodeHash`, `setupCodeMatches`, `lockedFor`, `recordFailure`, `clearFailures`, `formatWait`, `deviceLabel`, `SESSION_COOKIE`, `SESSION_LIFETIME_MS`.
  - Tests: `tests/accounts-core.test.ts`.
- **1b. The gateway program** (new `gateway/`): `state.ts` (the file, as `src/store/server-auth.ts` does it), `gate.ts` (the `/gate` decision as one pure function of method, path, headers and state), `routes.ts` (each route as `(Request) => Response`), `pages.ts`, `main.ts` (the HTTP listener, the setup code printed at first start, as `announceSetupCode` does). No dependency beyond Node and `src/core`.
  - Tests: `tests/gateway-gate.test.ts` (the six-step order, every branch), `tests/gateway-routes.test.ts` (sign-in, a session extended by use and ended after 30 idle days and after 6 months with a moved clock, the lockout, same answer and timing for a wrong name and a wrong password, sign-out, the first-start claim working once, a damaged file → 503).
- **1c. A copy behind the gateway** (`src/server/server-auth.ts`): in `serverGate`, when `LH_GATE_SECRET` is set, the whole decision is "does `x-lh-gate` equal it" (constant time), for pages, APIs and public files alike; sync paths then still run `syncGate`. `proxy.ts` and `src/server/api-gate.ts` need no change (they call `serverGate`). `announceSetupCode` prints nothing in this mode. The copy's `server-login.json` is left as it is, password included, so taking the gateway away again gives the old login back.
  - Also: `accountResponse`, `changePasswordResponse`, `logoutResponse`, `signOutEverywhereResponse`, `loginResponse`, `setupResponse` answer 404 in this mode (the gateway owns those paths). `desktopsResponse` (`src/server/sync/http.ts`) keeps working: today it asks `signedIn(request, state, now)`, which reads the copy's own session list; in this mode the gate secret is the proof. Give `signedIn` that rule once, and check its every caller.
  - New route `app/api/internal/unpair-all/route.ts` → 404 unless the mode is on.
  - Tests: `tests/gate-secret.test.ts`. The existing `tests/server-auth.test.ts` passes untouched.
- **1d. Build and deploy files:** `scripts/build-gateway.mjs` bundles `gateway/main.ts` and `gateway/maker-main.ts` (changed while building: the maker's entry file; `maker.ts` itself never starts on import) with esbuild into single `.mjs` files (add `esbuild` as a dev dependency with npm 11; it is in `node_modules` today only through `tsx`). `Dockerfile`: run it in the build stage, copy the two files, add `lh-gateway` and `lh-maker` wrappers like `reset-password`. `deploy/compose.yaml`: the `gateway` service and its volume, `LH_GATE_SECRET` on `lh`, a fixed `container_name` for Caddy. `deploy/Caddyfile` from slice 0. `deploy/make-secrets.sh`. `deploy/.env.example`. `scripts/server-reset-password.mjs`: with `LH_GATEWAY_FILE` set it resets the owner's account in the gateway's file (and `reset-password` runs in the gateway's container). **(Changed while building: the script is unchanged. The image's `reset-password` wrapper starts `lh-gateway reset-owner` where `LH_GATEWAY_FILE` is set and the old script everywhere else; `reset-owner` asks the running gateway through a loopback-only control route, because the state file has one writer. It prints the owner's name and a one-time reset code instead of wiping the password: see "Rulings made while building" in `docs/cloud-sync.md`.)**
  - The desktop build must not pick the gateway up: `scripts/build-server.mjs` is not changed.
- **Run:** Caddy, the gateway and one copy with the golden data, in a browser at computer and phone size: first-start claim, sign in, a lesson, Settings → Account, sign out, the lockout, the home-screen manifest and icons while signed out.
- **Risk:** high. Complex implementer for 1b and 1c, routine for 1a and 1d; one deep review of 1b + 1c together.

### Slice 2: desktop sync through the gateway

- **The desktop app's code box** (`max-w-40` in `components/settings/cloud-section.tsx`): check that a 13-character code shows whole. If it doesn't, widen the box; the owner allowed that, and nothing else on the form changes. Its placeholder stays `XXXX-XXXX`.
- **2a. Tags in the copy** (`src/core/sync/devices.ts`): `startPairing` appends the tag to the code and `completePairing` puts it before the key, both only when a tag is given; callers in `src/server/sync/http.ts` pass `process.env.LH_ACCOUNT_TAG`. `pairResponse` must not require `state.password` in gateway mode (today it answers "This server isn't set up yet" without one).
- **2b. The gateway's side:** the sync branch of `/gate`, and `POST /api/sync/pair` (read the JSON body once, at most a few kilobytes; pick the copy by the code's tag; forward with the gate secret and the client's address; a wrong code still counts toward the copy's own lockout, as now).
- **Tests:** `tests/sync-tags.test.ts` (codes and keys with and without a tag; the existing pairing tests untouched), more cases in `tests/gateway-gate.test.ts` (a 43- and a 46-character key, a changed tag, a paused account → 503, a deleted one → 401 `not_paired`), and one in-process run: the real desktop client (`pairWithServer`, `syncRequest`) → the gateway's functions → the real copy's gate and routes, for the owner's copy (no tag) and a tagged one.
- **Run:** two built copies and the gateway; a third built copy plays a desktop app and pairs with each account in turn, with the loop on; a desktop paired **before** the gateway was put in front carries on without pairing again.
- **Risk:** high (a wrong route here shows one person's sessions to another's PC). Complex implementer; one deep review.

### Slice 3: the maker, invites and new accounts

- **Already answered:** the invite page and its refusals (no note about the owner's powers) and the recovery-codes page (Copy and Continue, nothing to tick).
- **3a. The maker** (new `gateway/maker.ts` and `gateway/docker.ts`): the Docker Engine API over the socket with plain `node:http` (`socketPath`), no dependency. The fixed template; the per-account network and joining Caddy to it; start, stop, remove; at its own start, bring every `lh-acct-*` container whose image differs from `LH_IMAGE` onto it, one at a time.
  - Tests: `tests/maker.test.ts` against a stand-in Docker API on a socket: the exact create request (limits, no extra mounts, no privileges), a refused tag, the token check, the re-create on a new image.
- **3b. Invites in the gateway:** `POST /api/server-auth/invite`, the cap, the tag's choice, the maker call, rolling back the account if the maker fails, the recovery codes returned once.
- **3c. The entrypoint** (`deploy/docker-entrypoint.sh`): the `LH_SEED_WORKER_CONCURRENCY` seed, only on a volume with no `settings.json`.
- **3d. Compose:** the `maker` service (the socket mounted, the maker network, `LH_IMAGE` and `LH_CADDY_CONTAINER`), and the gateway's `LH_MAKER_*`.
- **Run (real Docker):** redeem an invite; the new copy answers through the gateway; from inside one copy, `curl` to the other copy's address fails or is refused (network, then secret); Chromium still starts in a hardened copy (`--no-sandbox`, all capabilities dropped); Claude Code and `ob` still install themselves under the limits; a copy that passes its memory ceiling is restarted alone.
- **Risk:** high (rights over Docker). Complex implementer; one deep review of the maker and the template.

### Slice 4: the owner's screen

- **Already answered:** Settings → Accounts (a ⋯ menu per account), its four confirm boxes, and what a paused or removed person reads at sign-in.
- **Build:** the gateway's `/api/accounts` (owner only, checked by the gateway; an `lh_owner=1` marker cookie only decides whether the row shows); the 30-day deletion (checked at the gateway's start and once a day; `DELETE /volumes/<tag>`); the unpair-all calls. New `components/settings/accounts-section.tsx`; one row in `components/settings/settings-dialog.tsx`, under Account, on a computer and a tablet (upstream's file; add it to the list in `docs/upstream-0.6.0.md`). **On a phone there is no row** (the owner's decision): the same component renders as a second group inside Account, under a divider, the way `components/settings/cloud-obsidian-group.tsx` puts Obsidian inside Cloud; the phone's list stays at eight rows (`tests/phone-layout.test.ts` and `tests/phone-plugins-ui.test.tsx` pin them).
- **Tests:** `tests/gateway-accounts.test.ts` (each `op`, a non-owner refused, the cap, Restore with no free slot, the 30 days with a moved clock), `tests/accounts-ui.test.tsx` (every state with the approved words; the row absent for a member and in the desktop app).
- **Risk:** moderate. Routine implementer for the screen, complex for the gateway part.

### Slice 5: each person's own

- **Already answered:** the new parts of Settings → Account and their boxes, the reset page (one box for either code), and the download's file type (.zip).
- **Delete my account is immediate** (the owner's decision): the gateway checks the password, ends every session, calls the maker's `DELETE /copies/<tag>` and `DELETE /volumes/<tag>`, and only then erases the record. If the maker fails part-way, the account stays signed out and marked for deletion and the gateway tries again; it is never left usable with half its data gone. *(As built: the account is marked `deleting` and signed out in one write and the answer returns at once; the maker's steps run in the background and in the lifecycle loop, and the record is erased only after the maker confirmed the volume is gone.)*
- **5a. Settings → Account** (`components/settings/account-section.tsx`): reads the gateway's wider answer; the three new blocks only when the answer has them, so a single-copy server's screen is unchanged.
- **5b. Reset** in the gateway: recovery code or owner's code, both counted by the one lockout, both ending every session and unpairing.
- **5c. Download my data:** `app/api/account/export/route.ts` and `src/server/account-export.ts`: the parts `src/store/sync/backup.ts` lists (`chats`, `graph`, `jobs`, `settings.json`, `prompts`, `themes`, `notes/sessions`, `plugins-state.json`, `core-plugin-data`), streamed, never `sync/`, the secrets folder, the home folder or the vault. The owner chose **.zip**; the repo has no archive library, so add one small zip writer (with npm 11, for the lockfile), or write the store-only zip format by hand if nothing suitable is found. *(As built: `src/server/zip-writer.ts`, written here, streamed and deflated, no dependency, no Zip64: the route refuses above 3.5 GiB or 65,000 files.)* The file is named `learnharness-<name>-<date>.zip`.
- **5d. Browser storage at sign-out:** the app's stored keys are window and view state (`lh:side-tutor:pos`, `lh:side-tutor:size`, `lh:notes-*`, `lh:sidebar-open`, `lh:session-kind-filter`, `lh:zoom`, `lh.graph.camera.v1`). Check the files that touch storage (`components/chat.tsx`, `opening-prompt.ts`, `sidebar.tsx`, `graph-view.tsx`, `graph-canvas.ts`, `notes/notes-drawer.tsx`, `side-tutor.tsx`, `settings/settings-dialog.tsx`, `settings/keyboard-section.tsx`) for anything that holds a person's words, and clear that at sign-out.
- **Tests:** `tests/gateway-reset.test.ts`, `tests/account-export.test.ts` (what is in, what is never in), more cases in `tests/server-auth-ui`-style tests for the Account screen.
- **Risk:** moderate; the reset paths get the deep reviewer's eye with slice 1's.

### Slice 6: the whole thing

- **The crossing tests**, in `.github/workflows/server-image.yml` after the image is built (real Caddy, gateway, maker and three copies): with two accounts, each of these is tried and refused: the other's session cookie; the other's device key; a key with a changed tag; a forged `X-LH-Upstream` and `X-LH-Gate`; a direct call from inside one container to another; a pairing code redeemed with another account's tag; a removed account's cookie and key; `/api/internal/*` from outside; the maker's port from a copy.
- **The unchanged tests:** the existing smoke test of a single copy (setup code, `reset-password`, `ob`, Chromium) stays as it is, beside the new one.
- **The update:** build two images, start the stack on the first, switch to the second; every copy ends on the second, and a signed-in page and a paired desktop carry on.
- **The screenshot page** for the owner (an Artifact page), which is the one stop of the build: every new screen at computer and phone size from the running test stack, the timings, what the crossing tests tried, and anything added beyond the plan. The owner chose pictures over a trial address on the server.
- **The switch-over guide** for the owner (an Artifact page; each command tagged with where it runs), with a second short guide for changing the cap later (`LH_MAX_ACCOUNTS` in `deploy/.env`, then `./update.sh`): the copy of the server's data by hand; swap (`free -h`, then the commands); `git pull` in the repo folder (files in `deploy/` changed); `./make-secrets.sh`; `./update.sh`; the setup code from `docker compose logs gateway`; the claim; checking the phone and the paired PC; the way back (the previous `deploy/` files and image tag: the copy's own password gate works again, because its login file was never touched).
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
