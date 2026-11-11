#!/bin/sh
# Container start (side-tutor fork, docs/cloud-sync.md). HOME is /data/home
# on the persistent volume, so Claude Code (the CLI) and its login survive
# LearnHarness image updates. First start installs Claude Code in the
# background; later starts ask it to update itself. LearnHarness starts
# straight away either way; Settings shows "isn't installed yet" until done.
mkdir -p "$HOME/.local/bin"
if [ ! -x "$HOME/.local/bin/claude" ]; then
	(
		# Download first: in `curl | bash` a failed download still "succeeds".
		if curl -fsSL https://claude.ai/install.sh -o "$HOME/claude-install.sh" >"$HOME/claude-install.log" 2>&1 \
			&& bash "$HOME/claude-install.sh" >>"$HOME/claude-install.log" 2>&1 \
			&& [ -x "$HOME/.local/bin/claude" ]; then
			echo "[LearnHarness] Claude Code installed."
		else
			echo "[LearnHarness] Claude Code could not be installed; see $HOME/claude-install.log on the data volume. It will try again on the next start."
		fi
		rm -f "$HOME/claude-install.sh"
	) &
else
	("$HOME/.local/bin/claude" update >/dev/null 2>&1 &)
fi

# Obsidian's sync program (obsidian-headless, `ob`; cloud sync Phase 4). Its
# licence doesn't allow shipping it inside this public image, so it is
# installed onto the volume here, at the one version LearnHarness was tested
# with (src/core/obsidian-sync.ts OB_VERSION; a test keeps the two equal).
# Settings → Obsidian shows "still installing" until it is there.
OB_VERSION="0.0.14"
if [ "$("$HOME/.local/bin/ob" --version 2>/dev/null)" != "$OB_VERSION" ]; then
	(
		tries=0
		until npm install -g --prefix "$HOME/.local" --cache /tmp/npm-cache --no-audit --no-fund --loglevel=error \
			--allow-scripts=better-sqlite3 "obsidian-headless@$OB_VERSION" >"$HOME/ob-install.log" 2>&1 \
			&& [ "$("$HOME/.local/bin/ob" --version 2>/dev/null)" = "$OB_VERSION" ]; do
			tries=$((tries + 1))
			if [ "$tries" -ge 5 ]; then
				echo "[LearnHarness] Obsidian's sync program could not be installed; see $HOME/ob-install.log on the data volume. It will try again on the next start."
				exit 0
			fi
			sleep 60
		done
		echo "[LearnHarness] Obsidian's sync program installed."
	) &
fi
exec node server.js
