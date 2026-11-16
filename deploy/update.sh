#!/bin/sh
# Pull newer images and restart only what changed. Run nightly by the
# learnharness-update timer (install-update-timer.sh); safe to run by hand.
set -eu
cd "$(dirname "$0")"
# The running container of a service (empty when it isn't running).
container() {
	docker compose ps -q "$1" 2>/dev/null || true
}
maker_before="$(container maker)"
caddy_before="$(container caddy)"
docker compose pull --quiet
docker compose up -d --remove-orphans
# Account copies are not in the compose file. The maker brings each one onto
# the new image when it starts (one at a time) and joins Caddy to every
# account's network. A maker that `up -d` just re-created has done that at its
# start, and must not be restarted while it is still swapping copies. Restart
# it only when it kept running (nothing to bring over) or when Caddy was
# re-created (a new Caddy has lost its network joins). Its SIGTERM waits for a
# pass under way (stop_grace_period in compose.yaml). The first run on a server
# that had no maker does nothing here: the new maker reconciles at its start.
maker_after="$(container maker)"
caddy_after="$(container caddy)"
if [ -n "$maker_before" ] && [ -n "$maker_after" ] && { [ "$maker_before" = "$maker_after" ] || [ "$caddy_before" != "$caddy_after" ]; }; then
	docker compose restart maker >/dev/null || echo "Could not restart the maker; account copies may still be on the old image." >&2
fi
docker image prune -f >/dev/null
# Claude Code (on the data volume) updates itself too. Never fail the update over it.
docker compose exec -T lh claude update >/dev/null 2>&1 || true
