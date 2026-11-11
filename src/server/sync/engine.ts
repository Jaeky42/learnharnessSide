/**
 * Cloud sync (Phase 5, docs/cloud-sync.md): the sync engine as this copy
 * runs it. One process is either the cloud server (the lease authority) or
 * a desktop; which one follows from LH_SERVER_MODE.
 *
 * Everything else in the app asks three questions here:
 *   holdsSession(id)          may this copy change the session?
 *   heldElsewhereResponse(id) the refusal to send when it may not
 *   runSyncRound()            (desktop) one round with the server
 *
 * Where no desktop has ever synced, holdsSession() is true for everything
 * and nothing is read beyond one small file check.
 */

import path from "node:path";
import { PATHS } from "../../../config.ts";
import { emit } from "../../core/events.ts";
import { HELD_ELSEWHERE_CODE, HELD_ELSEWHERE_MESSAGE } from "../../core/sync/sessions.ts";
import { readServerAuthState } from "../../store/server-auth.ts";
import { makeFirstSyncBackup } from "../../store/sync/backup.ts";
import { readCloudPairing } from "../../store/sync/pairing.ts";
import { sessionFiles } from "../../store/sync/session-files.ts";
import { stateFile } from "../../store/sync/state-file.ts";
import { pictureStaging } from "../../store/sync/picture-staging.ts";
import { serverModeEnabled } from "../server-auth.ts";
import { createAuthority, isAuthorityState, type Authority, type LocalWork } from "./authority.ts";
import { syncRequest } from "./client.ts";
import { createDesktopSync, isDesktopState, type DesktopSync } from "./desktop-sync.ts";

/** This device's own sync bookkeeping. Never synced. */
export function syncStateDir(): string {
	return path.join(/* turbopackIgnore: true */ PATHS.data, "sync");
}

/** Open pages learn that a session's files changed under them. */
function announce(chatId: string, what: "written" | "removed"): void {
	emit("chats-changed", {});
	if (what === "written") {
		emit("record-changed", { chatId });
		emit("jobs-changed", { chatId });
	}
}

function backup(): string | null {
	try {
		return makeFirstSyncBackup(PATHS.data);
	} catch (error) {
		// No backup, no first sync: the owner asked for a way back.
		throw new Error(`The backup before the first sync couldn't be made: ${error instanceof Error ? error.message : String(error)}`);
	}
}

interface Engine { authority?: Authority; desktop?: DesktopSync; localWork?: LocalWork; discarded?: Array<(chatId: string) => void> }
const globals = globalThis as typeof globalThis & { __lhSyncEngine?: Engine };
const engine = (): Engine => (globals.__lhSyncEngine ??= {});

/**
 * What this copy is doing for a session, and how to stop it. The real
 * functions live with the turn and job machinery (local-work.ts), which
 * registers them here; this module stays small because the proxy loads it.
 */
export function registerLocalWork(work: LocalWork): void {
	engine().localWork = work;
}

const localWork: LocalWork = {
	replying: (chatId) => engine().localWork?.replying(chatId) ?? false,
	stop: (chatId, options) => engine().localWork?.stop(chatId, options),
};

/** Other parts of sync (the graph log) hear when a desktop gives a session up. */
export function onSessionDiscarded(listener: (chatId: string) => void): void {
	(engine().discarded ??= []).push(listener);
}

export function syncAuthority(): Authority {
	return (engine().authority ??= createAuthority({
		files: sessionFiles(),
		state: stateFile(path.join(/* turbopackIgnore: true */ syncStateDir(), "authority.json"), isAuthorityState),
		now: Date.now,
		deviceName: (id) => {
			try { return readServerAuthState().devices.find((d) => d.id === id)?.name ?? null; } catch { return null; }
		},
		makeBackup: backup,
		announce,
		localWork,
		staging: pictureStaging(syncStateDir()),
	}));
}

export function desktopSync(): DesktopSync {
	return (engine().desktop ??= createDesktopSync({
		files: sessionFiles(),
		state: stateFile(path.join(/* turbopackIgnore: true */ syncStateDir(), "desktop.json"), isDesktopState),
		// Who this desktop is stays known while it is unpaired or paused, so
		// sessions held elsewhere stay read-only until sync resumes.
		identity: () => {
			const pairing = readCloudPairing();
			return pairing ? { server: pairing.server, deviceId: pairing.deviceId } : null;
		},
		request: (pathname, init) => syncRequest(pathname, init),
		now: Date.now,
		makeBackup: backup,
		announce,
		localWork,
		onDiscard: (chatId) => { for (const listener of engine().discarded ?? []) listener(chatId); },
	}));
}

/** Who holds a session this copy may not change; null when it may. */
export function sessionHolder(chatId: string): { id: string; name: string | null } | null {
	try {
		return serverModeEnabled() ? syncAuthority().holderOf(chatId) : desktopSync().holderOf(chatId);
	} catch {
		return null;
	}
}

export function holdsSession(chatId: string): boolean {
	return sessionHolder(chatId) === null;
}

/** The answer to any attempt to change a session another device holds. */
export function heldElsewhereResponse(chatId: string): Response | null {
	const holder = sessionHolder(chatId);
	if (!holder) return null;
	return Response.json({ error: HELD_ELSEWHERE_MESSAGE, code: HELD_ELSEWHERE_CODE, holder }, { status: 409, headers: { "Cache-Control": "no-store" } });
}

/**
 * The paths that change one session: everything under /api/chats/<id>
 * that isn't a read. The notes home folder is left to its own route, which
 * skips the write quietly (the notes drawer keeps working on a held session).
 */
export function sessionWritePath(method: string, pathname: string): string | null {
	if (["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) return null;
	const match = /^\/api\/chats\/([A-Za-z0-9_-]+)(?:\/([^/]+))?\/?$/.exec(pathname);
	if (!match || match[2] === "notes") return null;
	return match[1]!;
}

