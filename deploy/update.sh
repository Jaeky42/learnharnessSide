#!/bin/sh
# Pull newer images and restart only what changed. Run nightly by the
# learnharness-update timer (install-update-timer.sh); safe to run by hand.
set -eu
cd "$(dirname "$0")"
docker compose pull --quiet
docker compose up -d --remove-orphans
docker image prune -f >/dev/null
# Claude Code (on the data volume) updates itself too. Never fail the update over it.
docker compose exec -T lh claude update >/dev/null 2>&1 || true
