/**
 * Cloud sync (Phase 5): the backup each side makes once, right before its
 * first sync (owner's decision). A dated folder under `backups/` beside
 * the data folder:
 *
 *   desktop  %APPDATA%\LearnHarness\backups\before-first-sync 2026-11-20\
 *   server   /data/backups/before-first-sync 2026-11-20/
 *
 * It holds the sessions (their side questions are inside them), the
 * graph, the helper jobs, the settings, the prompt overrides, the custom
 * themes, the notes home-folder records, and the built-in plugins' state
 * and data (plugins-state.json, core-plugin-data/; per device, never
 * synced, but kept with the rest). Not community plugin code, no keys or
 * sign-ins (they live beside the data folder, not in it), and not the
 * Obsidian vault. Restoring is done by hand.
 */

import fs from "node:fs";
import path from "node:path";

const PARTS = ["chats", "graph", "jobs", "settings.json", "prompts", "themes", path.join("notes", "sessions"), "plugins-state.json", "core-plugin-data"];

function localDate(now: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Copy the data folder's synced parts aside. Returns the backup folder. */
export function makeFirstSyncBackup(dataDir: string, now: Date = new Date()): string {
	const root = path.join(/* turbopackIgnore: true */ path.dirname(dataDir), "backups");
	let target = path.join(/* turbopackIgnore: true */ root, `before-first-sync ${localDate(now)}`);
	for (let n = 2; fs.existsSync(/* turbopackIgnore: true */ target); n++) {
		target = path.join(/* turbopackIgnore: true */ root, `before-first-sync ${localDate(now)} (${n})`);
	}
	fs.mkdirSync(/* turbopackIgnore: true */ target, { recursive: true });
	for (const part of PARTS) {
		const from = path.join(/* turbopackIgnore: true */ dataDir, part);
		if (!fs.existsSync(/* turbopackIgnore: true */ from)) continue;
		const to = path.join(/* turbopackIgnore: true */ target, part);
		fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(to), { recursive: true });
		fs.cpSync(/* turbopackIgnore: true */ from, to, { recursive: true });
	}
	return target;
}
