/**
 * Cloud sync (Phase 5): the names of the top-level folders in a desktop's
 * Obsidian vault (owner's decision: names only, sent at sync, so the server
 * leaves those folders out of its own Obsidian sync before any of their
 * files arrive).
 *
 *   on a desktop   read from the vault the notes drawer is connected to
 *   on the server  kept in <data>/sync/vault-folders.json
 *
 * Nothing but the names is read: no file inside those folders is opened.
 */

import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../../config.ts";
import { isVaultFolderName, MAX_VAULT_FOLDERS } from "../../core/sync/maps.ts";
import { writeFileAtomicSync } from "../atomic-write.ts";

/** This desktop's vault's top-level folder names, sorted, or null when no vault is connected. */
export function desktopVaultFolders(): string[] | null {
	let vault: unknown;
	try {
		vault = (JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ PATHS.notes, "settings.json"), "utf-8")) as { vaultPath?: unknown }).vaultPath;
	} catch {
		return null;
	}
	if (typeof vault !== "string" || !path.isAbsolute(vault)) return null;
	try {
		return fs.readdirSync(/* turbopackIgnore: true */ vault, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && isVaultFolderName(entry.name))
			.map((entry) => entry.name)
			.sort()
			.slice(0, MAX_VAULT_FOLDERS);
	} catch {
		return null; // the vault is offline: say nothing rather than "no folders"
	}
}

const file = (syncDir: string): string => path.join(/* turbopackIgnore: true */ syncDir, "vault-folders.json");

/** The folder names desktops have told this server about. */
export function announcedVaultFolders(syncDir: string): string[] {
	try {
		const names = (JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ file(syncDir), "utf-8")) as { names?: unknown }).names;
		return Array.isArray(names) ? names.filter(isVaultFolderName) : [];
	} catch {
		return [];
	}
}

/** Adds names to the list. True when the list grew. */
export function rememberVaultFolders(syncDir: string, names: readonly string[]): boolean {
	const before = announcedVaultFolders(syncDir);
	const next = [...new Set([...before, ...names.filter(isVaultFolderName)])].slice(0, MAX_VAULT_FOLDERS * 4);
	if (next.length === before.length) return false;
	fs.mkdirSync(/* turbopackIgnore: true */ syncDir, { recursive: true });
	writeFileAtomicSync(file(syncDir), `${JSON.stringify({ names: next })}\n`, { allowInPlaceFallback: true });
	return true;
}
