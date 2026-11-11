/**
 * Cloud sync (Phase 5): the backup each side makes once, right before its
 * first sync (owner's decision). A dated folder under `backups/` beside
 * the data folder:
 *
 *   desktop  %APPDATA%\LearnHarness\backups\before-first-sync 2026-11-20\
 *   server   /data/backups/before-first-sync 2026-11-20/
 *
 * It holds the sessions, the graph, the side-tutor threads, the helper
 * jobs, the settings, the prompt overrides and the notes home-folder
 * records. No keys or sign-ins (they live beside the data folder, not in
 * it), and not the Obsidian vault. Restoring is done by hand.
 */

import fs from "node:fs";
import path from "node:path";

const PARTS = ["chats", "graph", "side-tutor", "jobs", "settings.json", "prompts", path.join("notes", "sessions")];

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
