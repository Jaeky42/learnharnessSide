#!/bin/sh
# Keeps every Docker container on this server (LearnHarness's copies, the
# gateway, the maker, Caddy) away from two things:
#   - the hosting provider's metadata address (169.254.0.0/16), and
#   - the services of this server itself (sshd, anything listening on the
#     host), through the bridge's gateway address or any of the host's own.
# Containers keep the internet (model providers), DNS, each other, and the
# site's own public ports 80 and 443.
#
# Optional. Run it once on the server, from the repository's deploy folder:
#   cd ~/learnharnessSide/deploy && sudo ./install-firewall.sh
#
#   sudo ./install-firewall.sh            install, apply now, and at every start
#   sudo ./install-firewall.sh --status   is every rule in place?
#   sudo ./install-firewall.sh --remove   take all of it out again
#   ./install-firewall.sh --rules [4|6]   print the rules only (changes nothing)
#
# Only traffic that arrives from a Docker bridge (docker0, br-*) is looked at,
# so nothing that reaches the server from outside (your SSH session included)
# is matched by any rule here. The rules only ever refuse or step aside; they
# never accept anything, so they can't open what another firewall closed.
set -eu

NAME=learnharness-firewall
BIN=/usr/local/sbin/$NAME
UNIT=/etc/systemd/system/$NAME.service
# The site's own public ports (Caddy). Reachable from the internet anyway; kept
# open from containers so one can reach the site's own address.
PUBLIC_TCP=80,443
PUBLIC_UDP=443
# AWS's IPv6 metadata address (its IPv4 one is in 169.254.0.0/16).
META6=fd00:ec2::254

say() { printf '%s\n' "$*"; }
die() { printf '%s\n' "$*" >&2; exit 1; }

need_root() {
	[ "$(id -u)" = 0 ] || die "Run it with sudo: sudo $0${1:+ $1}"
}

have() { command -v "$1" >/dev/null 2>&1; }

# iptables for one family: "4" or "6".
ipt() { if [ "$1" = 4 ]; then shift; iptables -w "$@"; else shift; ip6tables -w "$@"; fi; }
iptr() { if [ "$1" = 4 ]; then shift; iptables-restore -w --noflush "$@"; else shift; ip6tables-restore -w --noflush "$@"; fi; }

# The IPv6 side is used only when ip6tables works on this kernel.
v6_usable() { have ip6tables && have ip6tables-restore && ip6tables -w -n -L INPUT >/dev/null 2>&1; }
v6_docker() { ip6tables -w -n -L DOCKER-USER >/dev/null 2>&1; }

# The name servers Docker's embedded DNS forwards to (and the default bridge
# copies): the host's resolv.conf, systemd-resolved's real upstream list
# (Docker reads it when the host's file only names 127.0.0.53), and
# daemon.json's "dns". Loopback ones are dialled from the host itself and need
# nothing here; a provider resolver inside 169.254.0.0/16 (Google Cloud's is
# 169.254.169.254, AWS's 169.254.169.253) or on the host's own address must
# stay reachable on port 53 only.
nameservers() {
	fam=$1
	{
		for f in /etc/resolv.conf /run/systemd/resolve/resolv.conf; do
			[ -r "$f" ] && sed -n 's/^[[:space:]]*nameserver[[:space:]]\{1,\}\([^[:space:]%]*\).*/\1/p' "$f"
		done
		if [ -r /etc/docker/daemon.json ]; then
			tr -d '\n' < /etc/docker/daemon.json | sed -n 's/.*"dns"[[:space:]]*:[[:space:]]*\[\([^]]*\)\].*/\1/p' | tr ',' '\n' | tr -d ' "\t'
			echo # the list's last entry has no line end of its own
		fi
	} | while read -r ns; do
		case $ns in
		'' | 127.* | ::1) ;;
		*:*) [ "$fam" = 6 ] && say "$ns" ;;
		*.*.*.*) [ "$fam" = 4 ] && say "$ns" ;;
		esac
	done | sort -u
}

# The rules of one family, as iptables-restore input. Declaring a chain with
# --noflush empties it first, so a re-run replaces the contents in one step.
rules() {
	fam=$1
	if [ "$fam" = 4 ]; then rej=icmp-admin-prohibited; meta=169.254.0.0/16; else rej=icmp6-adm-prohibited; meta=$META6; fi
	say '*filter'
	say ':LH-FW-INPUT - [0:0]'
	say ':LH-FW-INPUT-BR - [0:0]'
	if [ "$fam" = 4 ] || v6_docker; then
		say ':LH-FW-FORWARD - [0:0]'
		say ':LH-FW-FORWARD-BR - [0:0]'
	fi
	# Only packets from a Docker bridge go further.
	say '-A LH-FW-INPUT -i docker0 -j LH-FW-INPUT-BR'
	say '-A LH-FW-INPUT -i br-+ -j LH-FW-INPUT-BR'
	# To the host itself. First, replies to connections the host opened
	# (Docker's port proxy to Caddy, a curl from the host, ICMP such as
	# "fragmentation needed" for path MTU, which is RELATED).
	say '-A LH-FW-INPUT-BR -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN'
	if [ "$fam" = 6 ]; then
		# Neighbour discovery between a container and its gateway.
		for t in 133 135 136; do say "-A LH-FW-INPUT-BR -p ipv6-icmp --icmpv6-type $t -j RETURN"; done
	fi
	for ns in $(nameservers "$fam"); do
		say "-A LH-FW-INPUT-BR -d $ns -p udp --dport 53 -j RETURN"
		say "-A LH-FW-INPUT-BR -d $ns -p tcp --dport 53 -j RETURN"
	done
	# A metadata address bound on the host itself is refused even on 80/443.
	say "-A LH-FW-INPUT-BR -d $meta -p tcp -j REJECT --reject-with tcp-reset"
	say "-A LH-FW-INPUT-BR -d $meta -j REJECT --reject-with $rej"
	say "-A LH-FW-INPUT-BR -p tcp -m multiport --dports $PUBLIC_TCP -j RETURN"
	say "-A LH-FW-INPUT-BR -p udp -m multiport --dports $PUBLIC_UDP -j RETURN"
	say '-A LH-FW-INPUT-BR -p tcp -j REJECT --reject-with tcp-reset'
	say "-A LH-FW-INPUT-BR -j REJECT --reject-with $rej"
	if [ "$fam" = 4 ] || v6_docker; then
		# Through the host to elsewhere: only the metadata range is refused.
		say '-A LH-FW-FORWARD -i docker0 -j LH-FW-FORWARD-BR'
		say '-A LH-FW-FORWARD -i br-+ -j LH-FW-FORWARD-BR'
		for ns in $(nameservers "$fam"); do
			say "-A LH-FW-FORWARD-BR -d $ns -p udp --dport 53 -j RETURN"
			say "-A LH-FW-FORWARD-BR -d $ns -p tcp --dport 53 -j RETURN"
		done
		say "-A LH-FW-FORWARD-BR -d $meta -p tcp -j REJECT --reject-with tcp-reset"
		say "-A LH-FW-FORWARD-BR -d $meta -j REJECT --reject-with $rej"
	fi
	say 'COMMIT'
}

# Rule numbers (1-based) of "-A <chain> -j <target>" in <chain>.
jump_numbers() {
	ipt "$1" -S "$2" 2>/dev/null | grep -v '^-[PN] ' | grep -nx -- "-A $2 -j $3" | cut -d: -f1
}

# The jump to <target> is the first rule of <chain>, exactly once.
ensure_first() {
	fam=$1 chain=$2 target=$3
	# Already first and the only one: nothing changes.
	nums="$(jump_numbers "$fam" "$chain" "$target")"
	[ "$nums" = 1 ] && return 0
	# Deleted by what it is, never by its number: another program (fail2ban,
	# say) may insert a rule between our read and our delete. Between the
	# delete and the insert the jump is missing for a moment; that is accepted.
	while ipt "$fam" -C "$chain" -j "$target" 2>/dev/null; do
		ipt "$fam" -D "$chain" -j "$target"
	done
	ipt "$fam" -I "$chain" 1 -j "$target"
}

remove_family() {
	fam=$1
	for pair in INPUT:LH-FW-INPUT DOCKER-USER:LH-FW-FORWARD; do
		chain=${pair%%:*} target=${pair#*:}
		ipt "$fam" -n -L "$chain" >/dev/null 2>&1 || continue
		while ipt "$fam" -C "$chain" -j "$target" 2>/dev/null; do
			ipt "$fam" -D "$chain" -j "$target"
		done
	done
	for c in LH-FW-INPUT LH-FW-FORWARD LH-FW-INPUT-BR LH-FW-FORWARD-BR; do
		if ipt "$fam" -n -L "$c" >/dev/null 2>&1; then
			ipt "$fam" -F "$c"
			ipt "$fam" -X "$c"
		fi
	done
}

remove_rules() {
	have iptables && remove_family 4
	v6_usable && remove_family 6
	return 0
}

# A bridge named br-* that isn't one of Docker's would be treated as a
# container network. This prints any such bridge: Docker names its bridges
# br- and the first 12 hex characters of the network's id.
foreign_bridges() {
	ids="$(docker network ls -q --no-trunc 2>/dev/null | cut -c1-12)" || return 1
	for d in /sys/class/net/br-*; do
		[ -e "$d" ] || continue
		n=${d##*/}
		id=${n#br-}
		if printf '%s\n' "$id" | grep -qx '[0-9a-f]\{12\}' && say "$ids" | grep -qx -- "$id"; then continue; fi
		say "$n"
	done
}
# With "drop" (the --apply of the start-up unit), rules from an earlier run
# are taken out too: none is better than rules that match a foreign bridge.
check_bridges() {
	bad="$(foreign_bridges)" || die "Couldn't ask Docker for its networks. Is Docker running? Nothing was changed."
	if [ -n "$bad" ]; then
		# Once more: a network Docker is making or removing right now.
		sleep 2
		bad="$(foreign_bridges)" || die "Couldn't ask Docker for its networks. Is Docker running? Nothing was changed."
	fi
	[ -z "$bad" ] && return 0
	msg="The network interface $(say "$bad" | head -n 1) isn't one of Docker's networks, and this firewall treats every br-* interface as one."
	if [ "${1:-}" = drop ] && have_rules; then
		remove_rules
		die "$msg The firewall rules from before are removed, so none are in place now. Rename or remove that interface, then: sudo systemctl restart $NAME"
	fi
	die "$msg Nothing was changed."
}

# Any of this script's chains present?
have_rules() {
	for c in LH-FW-INPUT LH-FW-FORWARD LH-FW-INPUT-BR LH-FW-FORWARD-BR; do
		ipt 4 -n -L "$c" >/dev/null 2>&1 && return 0
		v6_usable && ipt 6 -n -L "$c" >/dev/null 2>&1 && return 0
	done
	return 1
}

preflight() {
	have iptables && have iptables-restore || die "iptables isn't installed (Docker normally brings it: sudo apt-get install -y iptables). Nothing was changed."
	iptables -w -n -L INPUT >/dev/null 2>&1 || die "iptables can't read this server's rules. Nothing was changed."
	iptables -w -n -L DOCKER-USER >/dev/null 2>&1 || die "Docker's DOCKER-USER chain isn't there. Either Docker isn't running (start it: sudo systemctl start docker), or it uses its nftables firewall backend (\"firewall-backend\": \"nftables\" in /etc/docker/daemon.json), which this script doesn't support. Nothing was changed."
	have docker || die "The docker command isn't installed. Nothing was changed."
	check_bridges "${1:-}"
}

apply() {
	need_root --apply
	preflight drop
	# The rules are worked out before anything changes; a pipe would lose a
	# failure on its left side.
	r4="$(rules 4)"
	r6=
	if v6_usable; then r6="$(rules 6)"; fi
	# From here on, a failure (or being stopped) takes out everything this
	# script added, so no half of it is left in place.
	trap 'trap - EXIT; set +e; remove_rules; echo "The firewall rules could not be applied, and none are in place." >&2; exit 1' EXIT
	trap 'exit 1' HUP INT TERM
	say "$r4" | iptr 4
	ensure_first 4 INPUT LH-FW-INPUT
	ensure_first 4 DOCKER-USER LH-FW-FORWARD
	if [ -n "$r6" ]; then
		say "$r6" | iptr 6
		ensure_first 6 INPUT LH-FW-INPUT
		if v6_docker; then ensure_first 6 DOCKER-USER LH-FW-FORWARD; fi
	fi
	trap - EXIT HUP INT TERM
}

status() {
	need_root --status
	ok=0
	check() { # <family> <chain> <target>
		if [ "$(jump_numbers "$1" "$2" "$3" 2>/dev/null | head -n 1)" = 1 ]; then
			say "  in place: IPv$1 $2 -> $3 (first rule)"
		elif [ -n "$(jump_numbers "$1" "$2" "$3" 2>/dev/null)" ]; then
			say "  NOT FIRST: IPv$1 $2 -> $3. Another rule comes before it. If that rule is another firewall's, this is harmless; to put ours first again: sudo systemctl restart $NAME"; ok=1
		else
			say "  MISSING:  IPv$1 $2 -> $3"; ok=1
		fi
	}
	say "Firewall rules:"
	if have iptables && iptables -w -n -L INPUT >/dev/null 2>&1; then
		check 4 INPUT LH-FW-INPUT
		if iptables -w -n -L DOCKER-USER >/dev/null 2>&1; then check 4 DOCKER-USER LH-FW-FORWARD
		else say "  MISSING:  Docker's DOCKER-USER chain (is Docker running?)"; ok=1; fi
	else
		say "  iptables isn't usable here."; ok=1
	fi
	if v6_usable; then
		check 6 INPUT LH-FW-INPUT
		if v6_docker; then check 6 DOCKER-USER LH-FW-FORWARD; else say "  IPv6: Docker has no IPv6 rules here; only the host's own services are covered."; fi
	else
		say "  IPv6: ip6tables isn't usable here; nothing to do."
	fi
	if have docker; then
		if bad="$(foreign_bridges)"; then
			for n in $bad; do
				say "  FOREIGN BRIDGE: $n isn't one of Docker's networks. The rules treat it as a container network, so new connections arriving on it to this server are refused. Remove the firewall (sudo $0 --remove), or rename that bridge."
				ok=1
			done
		else
			say "  Couldn't ask Docker for its networks (is Docker running?)."; ok=1
		fi
		for net in $(docker network ls -q --filter driver=bridge 2>/dev/null); do
			bn="$(docker network inspect -f '{{index .Options "com.docker.network.bridge.name"}}' "$net" 2>/dev/null || true)"
			case $bn in '' | docker0 | br-*) ;; *) say "  NOT COVERED: Docker network $net uses the bridge name $bn"; ok=1 ;; esac
		done
	fi
	if have systemctl && [ -d /run/systemd/system ]; then
		enabled="$(systemctl is-enabled "$NAME" 2>/dev/null)" || true
		active="$(systemctl is-active "$NAME" 2>/dev/null)" || true
		say "Start-up unit: ${enabled:-not installed}, ${active:-unknown}"
		# Without it the rules are gone after the next restart.
		[ "$enabled" = enabled ] || ok=1
		if [ "$enabled" = enabled ] && [ "$active" != active ]; then
			say "  The start-up unit's last run didn't succeed ($active). Its reason: journalctl -u $NAME --no-pager | tail; to try again: sudo systemctl restart $NAME"
			ok=1
		fi
	fi
	[ "$ok" = 0 ] && say "All in place." || say "Not all in place."
	return "$ok"
}

install() {
	need_root
	[ -d /run/systemd/system ] && have systemctl || die "This server doesn't run systemd, so the rules couldn't be put back after a restart. Nothing was changed."
	preflight
	# A copy outside the repository, so moving or updating the checkout can't
	# leave the start-up unit pointing at nothing.
	cp "$0" "$BIN.new" && chmod 755 "$BIN.new" && mv "$BIN.new" "$BIN"
	cat > "$UNIT" <<UNIT
[Unit]
Description=Keep Docker containers away from this server's own services and the metadata address
# Docker's DOCKER-USER chain must exist first. PartOf: restarting Docker
# restarts this too, so the rules are checked again right after.
After=docker.service
PartOf=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$BIN --apply

[Install]
WantedBy=docker.service
UNIT
	# Once here first, so a refusal shows its own reason on this screen.
	if ! "$BIN" --apply; then
		systemctl disable "$NAME" >/dev/null 2>&1 || true
		rm -f "$UNIT" "$BIN"
		systemctl daemon-reload
		die "The firewall is not installed."
	fi
	systemctl daemon-reload
	systemctl enable "$NAME" >/dev/null
	# restart, so a second install applies a changed script at once.
	if ! systemctl restart "$NAME"; then
		journalctl -u "$NAME" -n 20 --no-pager >&2 || true
		die "The start-up unit failed (its log is above). Take it out with: sudo $0 --remove"
	fi
	status
}

uninstall() {
	need_root --remove
	if have systemctl && [ -d /run/systemd/system ]; then
		systemctl disable --now "$NAME" >/dev/null 2>&1 || true
		rm -f "$UNIT"
		systemctl daemon-reload
	fi
	rm -f "$BIN"
	remove_rules
	say "The firewall rules and their start-up unit are removed."
}

case ${1:-} in
'') install ;;
--apply) apply ;;
--status) status ;;
--remove) uninstall ;;
--rules)
	case ${2:-4} in 4 | 6) rules "${2:-4}" ;; *) die "Usage: $0 --rules [4|6]" ;; esac
	;;
*) die "Usage: sudo $0 [--status | --remove]" ;;
esac
