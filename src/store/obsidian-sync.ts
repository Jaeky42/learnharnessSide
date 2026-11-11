/**
 * Files behind the Obsidian vault on the cloud server (side-tutor fork,
 * cloud sync Phase 4; docs/cloud-sync.md). Server mode only.
 *
 *   <data>/obsidian-sync.json   LearnHarness's own small record: how many
 *                               notes the last healthy sync saw, and when.
 *                               Per device; never synced.
 *   <vault>                     the server's copy of the vault (LH_VAULT_DIR)
 *   <ob config>                 obsidian-headless's own folder: its sign-in
 *                               token and the vault key. LearnHarness only
 *                               checks that the token file exists and, for
 *                               folder names its command can't take, writes
 *                               the excluded-folders list into its settings.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { NOTES_FOLDER } from "../core/notes.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

const RECORD_VERSION = 1;
const MAX_DEPTH = 24;
const MAX_FILES = 20_000;

export interface ObsidianSyncRecord {
	/** Notes under LearnHarness/ at the last healthy sync. */
	notesSeen: number;
	/** The first full download has finished. */
	firstSyncDone: boolean;
	lastSyncedAt: number | null;
	connectedAt: number | null;
}

export const EMPTY_OBSIDIAN_RECORD: ObsidianSyncRecord = { notesSeen: 0, firstSyncDone: false, lastSyncedAt: null, connectedAt: null };

export function obsidianRecordFile(): string {
	return path.join(/* turbopackIgnore: true */ PATHS.data, "obsidian-sync.json");
}

/** Where the server keeps its copy of the vault. Outside LH_DATA_DIR on
 *  purpose (the notes store refuses a vault inside it). */
export function obsidianVaultDir(env: Record<string, string | undefined> = process.env): string {
	return env.LH_VAULT_DIR ? path.resolve(/* turbopackIgnore: true */ env.LH_VAULT_DIR) : path.join(/* turbopackIgnore: true */ path.dirname(PATHS.data), "vault");
}

/** obsidian-headless's own folder, by its rule (cli.js): XDG on Linux,
 *  ~/.obsidian-headless elsewhere. */
export function obConfigDir(env: Record<string, string | undefined> = process.env, home: string = os.homedir(), platform: NodeJS.Platform = process.platform): string {
	if (platform === "linux") return path.join(/* turbopackIgnore: true */ env.XDG_CONFIG_HOME || path.join(/* turbopackIgnore: true */ home, ".config"), "obsidian-headless");
	return path.join(/* turbopackIgnore: true */ home, ".obsidian-headless");
}

function readRecord(file: string = obsidianRecordFile()): ObsidianSyncRecord {
	try {
		const raw = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ file, "utf-8")) as Partial<ObsidianSyncRecord> | null;
		if (!raw || typeof raw !== "object") return { ...EMPTY_OBSIDIAN_RECORD };
		const time = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
		return {
			notesSeen: typeof raw.notesSeen === "number" && Number.isInteger(raw.notesSeen) && raw.notesSeen > 0 ? raw.notesSeen : 0,
			firstSyncDone: raw.firstSyncDone === true,
			lastSyncedAt: time(raw.lastSyncedAt),
			connectedAt: time(raw.connectedAt),
		};
	} catch {
		return { ...EMPTY_OBSIDIAN_RECORD };
	}
}

function writeRecord(record: ObsidianSyncRecord, file: string = obsidianRecordFile()): void {
	fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(file), { recursive: true });
	writeFileAtomicSync(file, JSON.stringify({ version: RECORD_VERSION, ...record }, null, "\t"), { allowInPlaceFallback: true });
}

function walkNotes(vaultDir: string, visit: (file: string, stat: fs.Stats) => void): void {
	let seen = 0;
	const walk = (dir: string, depth: number) => {
		if (depth > MAX_DEPTH || seen > MAX_FILES) return;
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(/* turbopackIgnore: true */ dir, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			const full = path.join(/* turbopackIgnore: true */ dir, entry.name);
			if (entry.isDirectory()) walk(full, depth + 1);
			else if (entry.isFile()) {
				seen += 1;
				try { visit(full, fs.statSync(/* turbopackIgnore: true */ full)); } catch { /* gone meanwhile */ }
			}
		}
	};
	walk(path.join(/* turbopackIgnore: true */ vaultDir, NOTES_FOLDER), 0);
}

/** Notes (.md) under <vault>/LearnHarness. */
function countNotes(vaultDir: string): number {
	let count = 0;
	walkNotes(vaultDir, (file) => { if (file.toLowerCase().endsWith(".md")) count += 1; });
	return count;
}

/** The newest change time of any file under <vault>/LearnHarness, or 0. */
function newestChange(vaultDir: string): number {
	let newest = 0;
	walkNotes(vaultDir, (_file, stat) => { if (stat.mtimeMs > newest) newest = stat.mtimeMs; });
	return newest;
}

/** Names of the folders at the top of the vault. */
function topLevelFolders(vaultDir: string): string[] {
	try {
		return fs.readdirSync(/* turbopackIgnore: true */ vaultDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
	} catch {
		return [];
	}
}

function isFolder(vaultDir: string, name: string): boolean {
	try { return fs.statSync(/* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ vaultDir, name)).isDirectory(); } catch { return false; }
}

function isEmptyDir(dir: string): boolean {
	try { return fs.readdirSync(/* turbopackIgnore: true */ dir).length === 0; } catch { return true; }
}

/** Removes everything inside the vault folder (not the folder itself).
 *  Only ever called with sync off and the vault unlinked from ob, so the
 *  removal can't reach Obsidian. */
function emptyVault(vaultDir: string): void {
	let entries: string[];
	try { entries = fs.readdirSync(/* turbopackIgnore: true */ vaultDir); } catch { return; }
	for (const name of entries) fs.rmSync(/* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ vaultDir, name), { recursive: true, force: true });
}

function hasToken(configDir: string): boolean {
	try { return fs.statSync(/* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ configDir, "auth_token")).size > 0; } catch { return false; }
}

/** For folder names `ob sync-config --excluded-folders` can't take (a comma,
 *  or spaces at either end): writes the list into ob's own settings file
 *  for this vault, the same field its command sets. Sync must be stopped. */
function writeExcludedFolders(configDir: string, vaultId: string, folders: readonly string[]): boolean {
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(vaultId)) return false;
	const file = path.join(/* turbopackIgnore: true */ configDir, "sync", vaultId, "config.json");
	try {
		const config = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ file, "utf-8")) as Record<string, unknown>;
		if (!config || typeof config !== "object" || config.vaultId !== vaultId) return false;
		if (folders.length) config.ignoreFolders = [...folders];
		else delete config.ignoreFolders;
		writeFileAtomicSync(file, JSON.stringify(config, null, 2), { mode: 0o600, allowInPlaceFallback: true });
		return true;
	} catch {
		return false;
	}
}

export const obsidianSyncFiles = {
	readRecord,
	writeRecord,
	countNotes,
	newestChange,
	topLevelFolders,
	isFolder,
	isEmptyDir,
	emptyVault,
	hasToken,
	writeExcludedFolders,
};

export type ObsidianSyncFiles = typeof obsidianSyncFiles;
