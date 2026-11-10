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
exec node server.js
