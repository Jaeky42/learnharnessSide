#!/bin/sh
# Adds the secrets the gateway set-up needs to deploy/.env. Run once, from the
# repository's deploy/ folder: ./make-secrets.sh
# It only ADDS what is missing and never replaces a value that is there, never
# prints a value, and keeps .env readable by its owner alone. With no .env yet
# it starts from .env.example.
#   LH_GATE_SECRET   the owner's copy requires it on every request
#   LH_MAKER_TOKEN   the gateway's key to the maker
#   LH_RELAY_TOKEN   the gateway's key to Caddy's internal relay
#   LH_DOCKER_GID    the group of Docker's socket (not a secret), for the maker
# Run it as your own user, not with sudo: a root-owned .env can't be read by
# your own `docker compose`.
set -eu
umask 077
cd "$(dirname "$0")"
env_file=".env"
example=".env.example"

owner_of() {
	stat -c %u "$1" 2>/dev/null || stat -f %u "$1" 2>/dev/null || echo unknown
}

# Only a .env that root already owns may be added to as root.
if [ "$(id -u)" = "0" ] && { [ ! -f "$env_file" ] || [ "$(owner_of "$env_file")" != "0" ]; }; then
	echo "make-secrets: run this as your own user, not as root or with sudo (the new .env would be owned by root)." >&2
	exit 1
fi

# The socket compose mounts (LH_DOCKER_SOCKET, the same variable and default
# as compose.yaml): the shell's value, else .env's, else Docker's usual path.
socket="${LH_DOCKER_SOCKET:-}"
if [ -z "$socket" ] && [ -f "$env_file" ]; then
	socket="$(sed -n 's/^LH_DOCKER_SOCKET=//p' "$env_file" | tail -n 1)"
fi
socket="${socket:-/var/run/docker.sock}"

# A tracked .env would put the secrets in git.
if command -v git >/dev/null 2>&1 && git ls-files --error-unmatch -- "$env_file" >/dev/null 2>&1; then
	echo "make-secrets: $env_file is tracked by git; remove it from git first (git rm --cached deploy/.env)." >&2
	exit 1
fi

if [ ! -f "$env_file" ]; then
	if [ ! -f "$example" ]; then
		echo "make-secrets: no $env_file and no $example here." >&2
		exit 1
	fi
	cp "$example" "$env_file"
	echo "Created $env_file from $example. Set LH_DOMAIN in it."
fi
chmod 600 "$env_file"

# 32 random bytes as 64 hex characters: nothing that needs quoting.
random_hex() {
	head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
}

has_value() {
	grep -Eq "^$1=[^[:space:]]" "$env_file"
}

add() {
	# add NAME VALUE: drop an empty "NAME=" line, then append NAME=VALUE.
	tmp="$(mktemp "$env_file.XXXXXX")"
	grep -Ev "^$1=[[:space:]]*$" "$env_file" >"$tmp" || true
	[ -z "$(tail -c1 "$tmp")" ] || printf '\n' >>"$tmp"
	printf '%s=%s\n' "$1" "$2" >>"$tmp"
	chmod 600 "$tmp"
	mv "$tmp" "$env_file"
}

for name in LH_GATE_SECRET LH_MAKER_TOKEN LH_RELAY_TOKEN; do
	if has_value "$name"; then
		echo "$name: kept"
	else
		add "$name" "$(random_hex)"
		echo "$name: added"
	fi
done

if has_value LH_DOCKER_GID; then
	echo "LH_DOCKER_GID: kept"
else
	gid="$(stat -c %g "$socket" 2>/dev/null || stat -f %g "$socket" 2>/dev/null || true)"
	case "$gid" in
		''|*[!0-9]*)
			echo "LH_DOCKER_GID: not found ($socket missing). Add LH_DOCKER_GID=<the socket's group id> to $env_file." >&2
			exit 1
			;;
	esac
	add LH_DOCKER_GID "$gid"
	echo "LH_DOCKER_GID: added"
fi
