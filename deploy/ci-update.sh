#!/bin/sh
# Update this server from CI: bring the checkout up to date, run update.sh,
# and check that the site answers. It is the forced command of an SSH key
# (authorized_keys: restrict,command="<this checkout>/deploy/ci-update.sh"),
# so it takes no input from the caller: SSH_ORIGINAL_COMMAND is never read,
# and the arguments below are only ever passed by the script to itself.
# It can be run by hand too.
#
# What it prints on stdout is exactly four lines and nothing else, so the
# public workflow log never learns anything about this server:
#   files: ok | unchanged | failed | not run
#   update: ok | failed | skipped
#   site: answers | no answer | not checked
#   result: ok | failed
# Everything else (output of git, update.sh, curl) goes to ~/lh-update.log,
# which keeps the previous run as ~/lh-update.log.1. Exit status 0 only for
# "result: ok".
#
# How it runs: the front (no argument) starts the real work detached
# (`work`: a new session, no terminal, output to the log), so a dropped SSH
# connection cannot stop an update halfway, and waits for the result (up to
# 25 minutes; it then reports failure without stopping the work). The work
# takes a lock (one run at a time), then runs the `files` stage: fetch the
# branch the server's channel follows (LH_CHANNEL in .env: dev is the server's
# own branch, latest or unset is side-tutor) and fast-forward only. The
# checkout must be on that branch. If that fails nothing else
# runs (a new image with old deploy files could be a mismatch). Otherwise the
# `files` stage replaces itself (exec) with the checked-out script's `update`
# stage, so the newest logic runs and no shell ever reads a script that git
# changed under it: runs update.sh, then asks the local Caddy for the sign-in
# page under the site's own name.
#
# Environment, for tests only (sshd passes none of it; a run by hand may):
#   LH_CI_WAIT_SECONDS       front's wait for the result (default 1500)
#   LH_CI_LOCK_WAIT_SECONDS  wait for another run's lock (default 600)
#   LH_CI_STALE_SECONDS      age at which a lock is taken over (default 1800)
#   LH_CI_SITE_WAIT_SECONDS  how long the site may take to answer (default 120)
#   LH_CI_SITE_INTERVAL      seconds between tries (default 5)
#   LH_CI_POLL               seconds between looks while waiting (default 1)
set -eu

here=$(cd "$(dirname "$0")" && pwd)
script="$here/ci-update.sh"
log_file="${HOME:?}/lh-update.log"
lock_dir="$HOME/.lh-ci-update.lock"
poll="${LH_CI_POLL:-1}"

unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
GIT_TERMINAL_PROMPT=0
export GIT_TERMINAL_PROMPT

# A line in the log, with the time.
log() {
	printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$log_file"
}

# A result line for the front, if it is still waiting for it.
record() {
	if [ -f "$out" ]; then
		printf '%s: %s\n' "$1" "$2" >> "$out"
	fi
}

# ---- the front: what the SSH session sees ----------------------------------

front() {
	exec 2>/dev/null
	out="$HOME/.lh-ci-update.out.$$"
	( umask 077; : > "$out" )
	trap 'rm -f "$out"' EXIT
	trap 'exit 1' HUP INT TERM
	if command -v setsid >/dev/null 2>&1; then
		setsid nohup sh "$script" work "$out" < /dev/null > /dev/null 2>&1 &
	elif command -v nohup >/dev/null 2>&1; then
		nohup sh "$script" work "$out" < /dev/null > /dev/null 2>&1 &
	else
		sh "$script" work "$out" < /dev/null > /dev/null 2>&1 &
	fi
	started=$(date +%s)
	limit="${LH_CI_WAIT_SECONDS:-1500}"
	while ! grep -q '^result: ' "$out"; do
		if [ $(( $(date +%s) - started )) -ge "$limit" ]; then
			break
		fi
		sleep "$poll"
	done
	# The last line of each kind, and only words of the kinds this script
	# writes itself.
	pick() {
		sed -n "s/^$1: \\([a-z ]*\\)\$/\\1/p" "$out" | tail -n 1
	}
	files_status=$(pick files)
	update_status=$(pick update)
	site_status=$(pick site)
	result=$(pick result)
	printf 'files: %s\n' "${files_status:-not run}"
	printf 'update: %s\n' "${update_status:-skipped}"
	printf 'site: %s\n' "${site_status:-not checked}"
	if [ "$result" = ok ]; then
		printf 'result: ok\n'
		return 0
	fi
	printf 'result: failed\n'
	return 1
}

# ---- the detached work: the lock, then the stages --------------------------

have_lock=
finished=

release() {
	if [ -n "$have_lock" ] && [ "$(cat "$lock_dir/owner" 2>/dev/null || true)" = "$$" ]; then
		rm -rf "$lock_dir"
	fi
	have_lock=
}

cleanup() {
	if [ -z "$finished" ]; then
		record result failed
	fi
	release
}

# Take the lock: an atomic mkdir. A lock held less than the stale age is
# waited for (up to the lock wait); an older one is taken over only when the
# process that took it is gone.
acquire() {
	stale="${LH_CI_STALE_SECONDS:-1800}"
	max="${LH_CI_LOCK_WAIT_SECONDS:-600}"
	started=$(date +%s)
	missing_since=
	while :; do
		if mkdir "$lock_dir" 2>/dev/null; then
			printf '%s\n' "$$" > "$lock_dir/owner"
			date +%s > "$lock_dir/since"
			have_lock=1
			return 0
		fi
		now=$(date +%s)
		since=$(cat "$lock_dir/since" 2>/dev/null || true)
		case "$since" in
			*[!0-9]*) since= ;;
		esac
		if [ -z "$since" ]; then
			# A lock with no time in it: another run is between mkdir and its
			# first write, or died there. Give it half a minute.
			if [ -z "$missing_since" ]; then missing_since=$now; fi
			if [ $(( now - missing_since )) -ge 30 ] && [ -d "$lock_dir" ]; then
				since=0
			fi
		fi
		if [ -n "$since" ] && [ $(( now - since )) -ge "$stale" ]; then
			# Old enough, but only a lock whose owner is gone is taken over: a run
			# that is still going, however long, is waited for like any other.
			owner=$(cat "$lock_dir/owner" 2>/dev/null || true)
			case "$owner" in
				''|*[!0-9]*) owner= ;;
			esac
			if [ -z "$owner" ] || ! kill -0 "$owner" 2>/dev/null; then
				log "taking over a stale lock"
				if mv "$lock_dir" "$lock_dir.old.$$" 2>/dev/null; then
					rm -rf "$lock_dir.old.$$"
				fi
				continue
			fi
		fi
		if [ $(( now - started )) -ge "$max" ]; then
			return 1
		fi
		sleep "$poll"
	done
}

stage_work() {
	out=${1:-}
	trap cleanup EXIT
	trap 'exit 1' HUP INT TERM
	if ! acquire; then
		log "another update held the lock for too long; nothing was done"
		record files "not run"
		record update skipped
		record site "not checked"
		return 1
	fi
	if [ -f "$log_file" ]; then
		mv -f "$log_file" "$log_file.1"
		chmod 600 "$log_file.1"
	fi
	( umask 077; : > "$log_file" )
	chmod 600 "$log_file"
	exec >> "$log_file" 2>&1
	log "update started"
	if sh "$script" files "$out"; then
		log "update finished: ok"
		record result ok
	else
		log "update finished: failed"
		record result failed
	fi
	finished=1
}

# ---- the stages ------------------------------------------------------------

# The branch this server follows: LH_CHANNEL in .env, "dev" (the server's own
# branch) or "latest" (also when it is not set). Anything else is no branch.
expected_branch() {
	channel=$(env_value LH_CHANNEL || true)
	case "${channel:-latest}" in
		dev) printf '%s\n' claude/pensive-goldberg-7dty2m ;;
		latest) printf '%s\n' side-tutor ;;
		*) return 1 ;;
	esac
}

# Bring this checkout up to date with the branch its channel follows,
# fast-forward only, then hand over to the checked-out script for the rest.
# A checkout on any other branch is a failure: nothing else runs.
stage_files() {
	out=${1:-}
	log "files stage start"
	status=failed
	if branch=$(git -C "$here" symbolic-ref --short -q HEAD) && [ -n "$branch" ]; then
		if ! expected=$(expected_branch); then
			log "LH_CHANNEL in .env is not dev or latest"
		elif [ "$branch" != "$expected" ]; then
			log "the checkout is on $branch, but this server's channel follows $expected"
		else
			before=$(git -C "$here" rev-parse HEAD)
			if git -C "$here" -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=60 fetch --quiet origin "$branch" \
				&& git -C "$here" merge --ff-only --quiet FETCH_HEAD; then
				after=$(git -C "$here" rev-parse HEAD)
				if [ "$before" = "$after" ]; then status=unchanged; else status=ok; fi
			fi
		fi
	else
		log "the checkout is not on a branch"
	fi
	log "files: $status"
	record files "$status"
	if [ "$status" = failed ]; then
		record update skipped
		record site "not checked"
		return 1
	fi
	# git may have rewritten this very file: carry on from the new copy.
	exec sh "$script" update "$out"
}

# One value from .env, read as one line (the file holds secrets: never sourced).
env_value() {
	sed -n "s/^$1=//p" "$here/.env" 2>/dev/null | tail -n 1 | tr -d '\r' \
		| sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\\(.*\\)'\$/\\1/"
}

# The sign-in page, asked of the local Caddy under the site's own name. Any
# 2xx or 3xx counts. Retried, because Caddy and the gateway may be starting.
site_answers() {
	domain=$1
	deadline=$(( $(date +%s) + ${LH_CI_SITE_WAIT_SECONDS:-120} ))
	while :; do
		code=$(curl --resolve "$domain:443:127.0.0.1" -sS -o /dev/null -w '%{http_code}' --max-time 10 "https://$domain/login" 2>> "$log_file") || code=000
		case "$code" in
			2??|3??) return 0 ;;
		esac
		log "the site gave $code"
		if [ "$(date +%s)" -ge "$deadline" ]; then
			return 1
		fi
		sleep "${LH_CI_SITE_INTERVAL:-5}"
	done
}

stage_update() {
	out=${1:-}
	log "update stage start"
	update_status=failed
	if (cd "$here" && sh ./update.sh); then update_status=ok; fi
	log "update: $update_status"
	record update "$update_status"
	site_status="not checked"
	domain=$(env_value LH_DOMAIN || true)
	case "$domain" in
		''|-*|*[!A-Za-z0-9.-]*) domain= ;;
	esac
	if [ -n "$domain" ] && command -v curl >/dev/null 2>&1; then
		if site_answers "$domain"; then site_status=answers; else site_status="no answer"; fi
	fi
	log "site: $site_status"
	record site "$site_status"
	[ "$update_status" = ok ] && [ "$site_status" != "no answer" ]
}

main() {
	case "${1:-}" in
		work) stage_work "${2:-}" ;;
		files) stage_files "${2:-}" ;;
		update) stage_update "${2:-}" ;;
		*) front ;;
	esac
}

# One line, so the shell has read the whole script before it runs any of it.
main "$@"; exit "$?"
