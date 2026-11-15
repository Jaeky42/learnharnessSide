#!/bin/sh
# Pull newer images and restart only what changed. Run nightly by the
# learnharness-update timer (install-update-timer.sh); safe to run by hand.
set -eu
cd "$(dirname "$0")"
docker compose pull --quiet
docker compose up -d --remove-orphans
# Account copies are not in the compose file: the maker brings each one onto
# the new image when it starts, one at a time, and joins Caddy to every
# account's network again (a re-created Caddy has lost them). The reconcile is
# idempotent, so always restart it; with no account copies it does nothing.
docker compose restart maker >/dev/null || echo "Could not restart the maker; account copies may still be on the old image." >&2
docker image prune -f >/dev/null
# Claude Code (on the data volume) updates itself too. Never fail the update over it.
docker compose exec -T lh claude update >/dev/null 2>&1 || true
