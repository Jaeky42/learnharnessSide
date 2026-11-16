# Crossing tests

`crossing.mjs` checks, against a running multi-account stack (`deploy/compose.yaml`: Caddy, gateway, maker, the owner's copy), that no account can reach another account's copy, the owner's copy, the gateway, the maker or Caddy's internal relay (docs/multi-account-build.md, slice 6). It uses Node's own modules only (Node 22 or later) and runs `docker` / `docker compose` for the checks made from inside containers.

```
node deploy/test/crossing.mjs --list          # what it tries and what counts as refused; touches nothing
node deploy/test/crossing.mjs --base https://<LH_DOMAIN> --ca <Caddy's root.crt> --compose-dir <the deploy/ folder the stack runs from>
```

- **TLS:** `--ca` takes Caddy's root certificate. For a local domain on Caddy's internal CA, copy it out with `docker cp lh-caddy:/data/caddy/pki/authorities/local/root.crt .`. `--insecure` skips certificate checks instead.
- **The owner's account:** on a stack nobody has claimed yet, the script claims it as `owner-x`, using the newest setup code in `docker compose logs gateway`. Otherwise, set `LH_CROSSING_OWNER_NAME` and `LH_CROSSING_OWNER_PASSWORD`.
- **Docker:** the containers must run on the machine where the script runs. The script finds the owner's copy and the gateway by their compose service names, Caddy as `lh-caddy` (`--caddy` to change it), and an account's copy as `lh-acct-<tag>`.
- **Slots:** the run needs two free account slots, because it makes two members. On the default cap of 4 that means at most two accounts before the run, the owner's included.
- **What it creates:** two members (`xa-<random>`, `xb-<random>`) through the real invite flow, a marker session in each member's copy and in the owner's, and a test desktop ("Crossing test") paired with each.
- **How it cleans up:** it deletes both members at the end, also after a failure (Remove, then Delete now: their containers, networks and volumes go), and it removes the owner's test desktop. What it leaves behind:
  - the owner's marker session (`marker-owner-…`);
  - with the stack not yet claimed, the claimed owner account `owner-x`.
  
  Run it on a throwaway stack, or delete that session by hand.
- **Output:** a table, one line per crossing, with what was expected and what came back. It exits 1 on the first crossing that is not refused, or when the run can't go on. It prints no secret, code, password or cookie.

The server image workflow (`.github/workflows/server-image.yml`) runs it on every build against a fresh stack made from the image just built.
