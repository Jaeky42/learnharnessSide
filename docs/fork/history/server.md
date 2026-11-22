# History and records: The server: login, sign-ins, Obsidian, hosting, accounts and updates

## The Obsidian vault on the server

### Obsidian vault on the server: verified on the owner's server

**Verified on the owner's server** against Obsidian's real servers (they are blocked from the development sandbox): `ob` installed itself after the update, the owner signed in and connected the vault in Settings → Obsidian, and reported that it works.

## Accounts on one server

### What was run, and how it was reviewed

- **Slice 0 (the proof)** ran before anything was built on it; see "Slice 0: the proof" in `docs/fork/plans/multi-account-build.md` for the Caddyfile that passed and each proof. **Caddy chooses the upstream from the gateway's answer** (real Caddy 2.11.9); the fallback (the gateway carrying requests itself) was not needed. It ran with stand-in copies and a stand-in gateway, not built ones (a build could not run while other files were being edited); built copies ran later in the real stack.
- **The real stack in the sandbox** (Docker, Caddy with the repo's Caddyfile, the built gateway and maker, the owner's copy and made copies): checks of the services' limits, the first-start claim, signed-in and signed-out requests through Caddy, forged headers, what each network reaches, and the maker creating, stopping, starting and deleting a copy; browser screenshots at computer and phone size. The Caddy proofs were re-run on the final Caddyfile after each review (the build guide lists the counts).
- **Three independent deep reviews** (the maker and the deploy files; sign-in, `/gate`, sync routing and the copy's gate; the account lifecycle), each "changes required"; every finding is fixed or recorded as open ("Rulings, limits and open items" under "Accounts on one server" in `docs/fork/server.md`).
- **Run in the sandbox:** the whole suite, one file at a time, by an independent run (495 files, 6,805 tests; the only failures are the four known sandbox ones; typecheck clean; lint only the existing warning).
- The results of the full-flow run follow in the next sub-part.

### The full run in the real stack

Caddy, the gateway, the maker and copies ran together in Docker in the development sandbox, driven through a real browser (Playwright), with another container from the same image playing a desktop app. The image was built from a generated local copy of the `Dockerfile` ("The accounts stack" in `docs/fork/development.md`), so it had no Chromium, curl or fonts. The flows first ran on the image of commit `2bc5ddf`; after the repair of the gateway's second half the image was rebuilt, the stack moved onto it with a real `update.sh`, and invite, both resets, Delete my account, `reset-password` and the crossing run were done again on it. All passed.

| Flow | What was seen | Time |
|---|---|---|
| **The switch-over:** one copy with its own password login and a paired desktop copy, then the gateway stack put in front of the same data volume (`make-secrets.sh`, `up`) | `/setup` answered; after the claim all sessions were there; the desktop copy kept syncing without pairing again | `/setup` after 1.6 s; claim to the codes page 0.23 s; codes page to home 2.6 s; desktop sync 2.1 s |
| **The way back:** the stack stopped, the copy started without `LH_GATE_SECRET` | The old password login works; the desktop copy syncs | 10 s |
| **An invite redeemed** | Recovery codes, then an empty library asking for a provider key; `docker inspect` matches the template; the owner's list shows the member | codes page 1.0 s; the new copy's first page 5.1 s |
| **Invite refusals:** wrong code, used code, taken name (capitals ignored), reserved name, bad name, passwords, a full server at cap 2 | Each approved sentence; the greyed New invite code button | — |
| **Pause, Resume** | Copy exited, the open page answers 401, the paused sentence only with the right password; then back | 0.5 s; 0.2 s, sign-in 3.8 s |
| **Remove, Restore, Delete now** | Container gone and volume kept; the removed sentence; Restore brought a marker session back; Delete now removed container, network and volume, and the name was free | 1.0 s; 2.2 s |
| **Resets:** the owner's reset code, a recovery code, `reset-password` in the gateway's container | Each code works once; old sessions end; the fifth wrong code shows the lockout sentence | — |
| **Delete my account** | At `/login` at once; container, network and volume gone; the name can be taken again | 0.23 s; all gone after 1.0 s (10.7 s on the rebuilt image) |
| **Download my data** | A valid zip (`chats`, `graph`, `jobs`, `settings.json`); no `sync/`, nothing from the secrets folder | — |
| **Pairing through the gateway** | A member: 13-character code, 46-character tagged key, the session reaches that member's library only. The owner: 9-character code, 43-character key | — |
| **A paused member's desktop copy** | Offline, keeps its key; syncs again after Resume without pairing | 3.4 s |
| **A member's password change** | The desktop copy must pair again | — |
| **An update with accounts present** (`update.sh` onto a rebuilt image) | Every copy on the new image; Caddy joined to every account network again; a signed-in page and both desktop copies carried on | 8–10 s; 13.4 s once the gateway drains |

- **The crossing tests** (`deploy/test/crossing.mjs`, on a fresh stack of the rebuilt image): **111 of 111 crossings refused, in 63 s.** Each cookie sees only its own marker session; two accounts' cookies together 401; forged `X-LH-*` headers change nothing (signed out: 401); another account's device key 404; a key with its tag swapped, removed or added 401; a pairing code with another tag or none 401; a member on `/api/accounts` 404; from inside a copy, the other copies, `lh`, the gateway and the maker don't resolve by name and time out by address; the relay without its token 404, and its port isn't published; `/api/internal/*` in ten spellings from three callers 404 or 400; path tricks 400 or 404; a `Service-Worker` request 403; a paused or removed account's cookie 401 and key 503; a deleted account's key 401 `not_paired` with its volume gone.
  - An absolute-form request for a host Caddy doesn't serve gets Caddy's own empty 200; no gateway or copy is asked.
  - One fix to the script on its first run: the key control read a session before any sync round, so the copy answered 404; it now does a first round first.
- **Screenshots:** 91, of every new screen at 1280 × 800 and at iPhone 13 size, indexed in the scratch folder's `final-shots/INDEX.md`; 83 of them are on the owner's review page (an Artifact page). No page error in any.
- **The two workflows started by hand on this branch** (`workflow_dispatch`; they publish nothing): **both passed on `eeecd2b`**, the last code commit.
  - **Server image** (its fifth run): typecheck, the plugin SDK type tests, every other test and lint, on Node 26; the real image built, Chromium included; the single-copy smoke test; then the new step, the whole stack started from a folder named `stack` with the crossing script: **111 of 111 refused**. The publish step was skipped.
  - **Windows app:** its tests on Windows (the account rules and both account screens among them), the build, the packaged app's smoke test and the update-feed check. No release.
  - **The four server runs that failed found three faults** the sandbox hadn't shown (it tests on Node 22, and ran its stack from a folder named `deploy`):
    1. **A cancelled download left a file open** (`src/server/zip-writer.ts`). Cancelled right after an entry's header, the generator rested at a `yield` outside the `try` that closes the file. On Node 26 a file handle that reaches the garbage collector unclosed is an error, so the whole test file failed. Everything from opening a file to closing it is now in one `try` / `finally`.
    2. **The cancel returned before the file was really closed.** A read stream made from a handle closes that handle itself when destroyed, and `handle.close()` then answers at once. Not a leak; the cancel now waits for the stream's own `close` event. On Node 26 under load: 16 of 18 runs failed before, 18 of 18 pass after.
    3. **Caddy's outward network depended on the stack's folder name** ("Fixed network names, never the compose project's" under "The pieces and how a request travels" in `docs/fork/server.md`): the first invite ended in "socket hang up".
  - **And one wrong fix of the lead's own:** the first run failed on the download's memory check (61.3 MiB against a 48 MiB limit), which measured without a collection. The first repair switched `--expose-gc` on inside the running test process; that run then met fault 1. The check now runs in a child process started with the flag (`tests/helpers/account-export-memory.ts`): about 11 MiB against a 24 MiB limit.
  - New tests from these: a cancel at every point of a download leaves no descriptor open (`tests/account-export.test.ts`), and the network names and their order (`tests/deploy-files.test.ts`, `tests/maker.test.ts`).

## The host firewall: built and checked, then declined

- **State: declined by the owner; nothing of it is in this branch or in either release branch, and the owner's server doesn't run it.** The owner saw a page of a trial with stand-in containers and decided to add it ("ok, i say we add it"), with the result shown before it ships. It was built on the session branch, reviewed, and passed its check on GitHub's runner. Shown that result, the owner decided against it: "i dont really want the firewall". Don't offer it again unless the owner raises it.
  - **Where the code is:** four commits on `claude/dazzling-maxwell-j6mfy1`, `8b62721`, `189b5b3`, `a85b894` and `6f9665a` (`deploy/install-firewall.sh`, the `--firewall` checks in `deploy/test/crossing.mjs` and its README, the workflow step's firewall part, and a suite in `tests/deploy-files.test.ts`). They touch nothing else, so `git cherry-pick` brings it back while that branch exists. If it is gone, what follows is the record to rebuild it from.
  - **What stays as it was:** a copy can reach the host's own services and the provider's metadata address ("Known limits" under "Accounts on one server" in `docs/fork/server.md`), as the owner's copy always could.
  - Everything below describes the firewall as it was built on that branch.
- **The trial the owner saw first** (the sandbox, Docker 29, stand-in containers on a non-internal user bridge, on `docker0` and on a network made after the rules; a stand-in host service; the metadata address both forwarded to an "outside" namespace and bound on the host): every route to the host service and to `169.254.169.254` went from reached to refused; outbound (a real HTTPS request through a relay to the sandbox's proxy, a 1 MiB upload over an MTU-1280 hop), DNS through Docker's resolver, container to container, the published port from the host and from containers all still worked. Applied three times: the same rules. Removed: `iptables-save` identical to before. After a `dockerd` restart the rules were still there.
- **Why:** account networks are not internal (a copy needs outbound access for its model providers), so a program inside a copy (the teacher's tools, a coding question's test program) can reach the server's own services through the bridge's gateway address, and the hosting provider's metadata address. The owner's copy always could. The app can't close this; the host's packet filter can.
- **What it is:** `deploy/install-firewall.sh`, run once on the server with `sudo`, in the style of `install-update-timer.sh`. Optional: the stack works the same with or without it.
  - no option: installs (copies itself to `/usr/local/sbin/learnharness-firewall`, writes and enables the systemd unit `learnharness-firewall.service`, applies the rules now);
  - `--status`: is every rule in place, is the jump first, is the unit enabled and active, is every `br-*` interface one of Docker's (needs root; exits 1 when not all in place);
  - `--remove`: takes the rules, the unit and the installed copy out;
  - `--rules 4 | 6`: prints the rules and changes nothing (no root, no `iptables` needed); `--apply` is what the unit runs.
- **The rules** (IPv4, mirrored for IPv6 where `ip6tables` works, with AWS's `fd00:ec2::254`): the script's own chains (`LH-FW-INPUT`, `LH-FW-INPUT-BR`, `LH-FW-FORWARD`, `LH-FW-FORWARD-BR`), loaded in one step with `iptables-restore --noflush`, reached by one jump kept as the first rule of `INPUT` and of `DOCKER-USER`. Only packets that arrive on `docker0` or `br-+` are looked at.
  - **To the host itself:** replies to connections the host opened pass (conntrack `RELATED,ESTABLISHED`, which carries the ICMP that path-MTU discovery needs); port 53 to the resolvers named in the host's `resolv.conf` files and in `daemon.json`'s `dns` passes; `169.254.0.0/16` is refused; TCP 80 and 443 and UDP 443 pass (the site's own published ports); everything else is refused.
  - **Forwarded:** port 53 to those resolvers passes, then `169.254.0.0/16` is refused. Everything else is left to Docker's own rules: outbound, container to container, Caddy to a copy.
  - **Refused means `REJECT`** (a TCP reset, else ICMP admin-prohibited), so an attempt fails in milliseconds instead of hanging.
  - **Nothing is ever accepted and no chain policy changes**, so it can't open what another firewall closed, and it can't cut SSH, which never arrives from a bridge.
- **When it refuses to install, changing nothing:** no `iptables`; no `DOCKER-USER` chain (Docker's nftables backend); a `br-*` interface that isn't one of Docker's networks (exactly 12 hex characters equal to the start of a network id); no systemd. A failure half-way takes out everything it added and exits 1, also on a signal.
- **After a restart of Docker or the server** the unit puts the rules back (`After=`, `PartOf=` and `WantedBy=docker.service`, a oneshot that stays "active"). An apply that fails then takes its rules out: it fails open, and `--status` and `systemctl status learnharness-firewall` say so.
- **`deploy/update.sh` doesn't touch it**, and the maker needs no change: an account network made later is a `br-*` bridge like the others.

**The check on GitHub** (the "Multi-account stack and crossing tests" step of `server-image.yml`, on the real stack, after the plain crossing run's set-up):

1. A listener is started on the host (`python3 -m http.server`, all addresses). **Before the firewall** the owner's copy must reach it through the bridge's gateway address, and what `169.254.169.254:80` answers from there is printed. Without that, "refused" would prove nothing: a port with no listener is refused too.
2. `sudo ./install-firewall.sh`, then the crossing script with `--firewall --host-port <port>`: from inside an account's copy and inside the owner's copy, the listener and `169.254.169.254:80` must be refused within 3 s; a DNS lookup, a TCP connection to an outside host on 443 and one to the site's own 443 on the gateway address must still work. That is 11 more checks: **122** with the firewall, 111 without.
3. The firewall's own packet counters must have risen (the `169.254.0.0/16` rules, and the last TCP rule to the host), so the refusals came from these rules.
4. The jump is deleted from `INPUT` by hand and Docker is restarted: once the unit has run again, `--status` must say all in place, and the owner's copy must be refused again.
5. `--remove`: no `LH-FW` line left in `iptables-save` or `ip6tables-save`, the unit not enabled, and the owner's copy reaches the listener again.

**What the runs showed** (three runs started by hand on the session branch; they publish nothing):

- **Before the firewall**, from the owner's copy: the listener `connected`, and `169.254.169.254:80` `connected` too (GitHub's runners are Azure machines with a real metadata service).
- **With it:** `ECONNREFUSED` after 3 ms for both, from an account's copy and from the owner's copy; the three controls worked; **122 of 122 refused as expected**; counters: 2 metadata resets on the forward path, 0 to the host, 2 resets on the host's other TCP ports.
- **After a Docker restart** the rules were back and the copy was refused again; **after `--remove`** nothing was left and the copy connected again (the run on `6f9665a`, which passed whole).
- **The first run** was cancelled by starting the second (the workflow's concurrency group). **The second failed in the check, not in the script:** it asked for the status the instant the site answered after Docker's restart, about half a second before systemd had run the unit again (`MISSING: IPv4 INPUT -> LH-FW-INPUT`, and the rule there a second later). The check now waits up to 30 s for the status before requiring it.

**An independent security review** (read-only, "changes required"; all four fixed before the run that passed):

1. The check could have passed with no firewall at all (no listener is also "refused"): the positive controls before the install, the counters, and "connected again after `--remove`" were added.
2. The jump was kept first by deleting by rule number, which could delete another program's rule added in the same instant (fail2ban, for one): it is deleted by its own spec now, and nothing is touched when it is already first and single.
3. `--status` said "All in place." with a failed unit or a foreign bridge: it reports both, and a jump that isn't first.
4. The bridge check matched by prefix: an exact match now.

**Choices made while building, for the owner to review** (the owner saw the first four on the trial's page before deciding):

- **It covers every Docker bridge on the server**, not only LearnHarness's: account networks appear at runtime and the packet filter sees only `br-<id>`. Anything else in Docker on that server that needs the host itself is refused too.
- **Ports 80 and 443 stay reachable from containers** (the site's own address).
- **The provider's private network isn't blocked**, only the host itself and `169.254.0.0/16`.
- **Copies run for a moment at boot before the rules are back** (the unit runs after Docker has started).
- **A rule another program puts above the jump** (fail2ban inserting at the top) makes `--status` say NOT FIRST. That is harmless when the rule above is that program's own; `--status` says so and how to put the jump first again.

**Known limits and not tried:**

- **Never run on the owner's server,** so their provider, their Docker version and whether they use `ufw` are untried. Run so far: GitHub's Ubuntu 24.04 runner (systemd, Docker's iptables backend) and the sandbox's Docker 29 with stand-in containers.
- **IPv6 traffic** wasn't sent through it (the rules are loaded and removed in the runs; no IPv6 probe).
- **A bridge named `br-*` that isn't Docker's, made after the install** (libvirt or a hand-made one): new connections arriving on it to the host would be refused, and the next apply (a Docker restart, a reboot) refuses, takes the rules out and says so in `--status`. An SSH session never arrives on a bridge.
- **A provider whose metadata address is outside `169.254.0.0/16`** isn't covered for that address (Azure's second one, `168.63.129.16`, is such an address).
- **A failed apply at boot is silent** except in `--status` and `systemctl status`: nothing in the app shows it.
- **The unit tests pin mostly the rules' text and order** (and a run against stand-in `iptables`, `docker` and `systemctl`); that the rules really refuse is shown only by the GitHub step.
