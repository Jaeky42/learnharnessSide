#!/bin/sh
# Installs a systemd timer that runs update.sh every night at 4 am
# (server time zone). Run once: sudo ./install-update-timer.sh
set -eu
dir="$(cd "$(dirname "$0")" && pwd)"
cat > /etc/systemd/system/learnharness-update.service <<UNIT
[Unit]
Description=Update LearnHarness to the newest image
Wants=network-online.target
After=network-online.target docker.service

[Service]
Type=oneshot
ExecStart=$dir/update.sh
UNIT
cat > /etc/systemd/system/learnharness-update.timer <<UNIT
[Unit]
Description=Nightly LearnHarness update

[Timer]
OnCalendar=*-*-* 04:00:00
# Catch up after the server was off at 4 am.
Persistent=true

[Install]
WantedBy=timers.target
UNIT
chmod 755 "$dir/update.sh"
systemctl daemon-reload
systemctl enable --now learnharness-update.timer
systemctl list-timers learnharness-update.timer --no-pager
