/**
 * Flashcards sync (docs/phone-plugins-plan.md): the second per-item exchange
 * (maps-sync.ts) as this copy runs it, beside the settings one (maps-engine.ts).
 *
 *   flashcardsAuthority()   the server's side     POST /api/sync/flashcards
 *   flashcardsDesktop()     a desktop's side      one part of every round (round.ts)
 *
 * State, each side's own, never synced (under <data>/sync/):
 *
 *   flashcards.json            the server's table (maps-sync.ts AuthorityMapsState)
 *   flashcards-desktop.json    a desktop's agreed fingerprints and unsent changes
 *   flashcards-memory.json     what this device last read or wrote (flashcards-files.ts)
 *   time-zone.json             the server only: the zone the PCs gave (flashcards-zone.ts)
 *
 * The rules (orchestrator's rulings on the approved plan):
 *   - a PC with no Flashcards file brings no settings at its first sync;
 *   - a side with a generation under way holds its Flashcards exchange: the
 *     PC skips it that round, the server answers "busy";
 *   - a memory that is missing while the exchange's state is there: this
 *     side's records are lost, and everything is sent again (the server
 *     starts its table afresh, as a server that lost its records does);
 *   - each side copies its Flashcards folder aside right before its first
 *     Flashcards exchange; with no copy, no Flashcards sync.
 */

import path from "node:path";
import { PATHS } from "../../../config.ts";
import { emit } from "../../core/events.ts";
import { checkFlashcardsChange, flashcardsKindOf } from "../../core/sync/flashcards.ts";
import { makeFlashcardsBackup } from "../../store/sync/backup.ts";
import { readCloudPairing } from "../../store/sync/pairing.ts";
import { stateFile, type StateFile } from "../../store/sync/state-file.ts";
import { measuredClockOffsetMs, syncRequest } from "./client.ts";
import { syncStateDir } from "./engine.ts";
import { createFlashcardsFiles, FLASHCARDS_PLUGIN_ID, type FlashcardsFiles } from "./flashcards-files.ts";
import { localTimeZone, takeTimeZone } from "./flashcards-zone.ts";
import {
	createMapsAuthority, createMapsDesktop, isAuthorityMapsState, isDesktopMapsState,
	type AuthorityMapsState, type DesktopMapsState, type ExchangeRules, type MapsAuthority, type MapsDesktop,
} from "./maps-sync.ts";

export const FLASHCARDS_RULES: ExchangeRules = {
	kindOf: flashcardsKindOf,
	checkChange: checkFlashcardsChange,
	resetUnsentSettings: false,
	malformed: "The Flashcards changes didn't arrive whole.",
};

export const FLASHCARDS_SYNC_PATH = "/api/sync/flashcards";

/** What this copy's sync announces to open Flashcards pages; the loop doesn't take it for a change made here. */
export const SYNC_ECHO = { by: "sync" } as const;

export function isSyncEcho(data: unknown): boolean {
	return !!data && typeof data === "object" && (data as { by?: unknown }).by === SYNC_ECHO.by;
}

export function announceFlashcardsChanged(): void {
	emit("plugin-message", { pluginId: FLASHCARDS_PLUGIN_ID, topic: "changed", data: SYNC_ECHO });
}

/** A server whose memory is gone has lost its records: it starts its table afresh. */
export function authorityState(inner: StateFile<AuthorityMapsState>, files: Pick<FlashcardsFiles, "memoryReadable">): StateFile<AuthorityMapsState> {
	return { read: () => { const state = inner.read(); return state && !files.memoryReadable() ? null : state; }, write: inner.write, exists: inner.exists };
}

/** A desktop whose memory is gone sends everything again. */
export function desktopState(inner: StateFile<DesktopMapsState>, files: Pick<FlashcardsFiles, "memoryReadable">): StateFile<DesktopMapsState> {
	return {
		read: () => {
			const state = inner.read();
			return state && state.synced && !files.memoryReadable() ? { ...state, synced: false, cursor: 0, known: {}, pending: {} } : state;
		},
		write: inner.write,
		exists: inner.exists,
	};
}

function backup(): string | null {
	try {
		return makeFlashcardsBackup(PATHS.data);
	} catch (error) {
		throw new Error(`The backup before the first Flashcards sync couldn't be made: ${error instanceof Error ? error.message : String(error)}`);
	}
}

interface FlashcardsEngine { files?: FlashcardsFiles; authority?: MapsAuthority; desktop?: MapsDesktop }
const globals = globalThis as typeof globalThis & { __lhFlashcardsSync?: FlashcardsEngine };
const engine = (): FlashcardsEngine => (globals.__lhFlashcardsSync ??= {});

export function flashcardsFiles(): FlashcardsFiles {
	return (engine().files ??= createFlashcardsFiles({ dataDir: PATHS.data, syncDir: syncStateDir(), now: Date.now, announce: announceFlashcardsChanged }));
}

export function flashcardsAuthority(): MapsAuthority {
	const files = flashcardsFiles();
	return (engine().authority ??= createMapsAuthority({
		files,
		state: authorityState(stateFile(path.join(/* turbopackIgnore: true */ syncStateDir(), "flashcards.json"), isAuthorityMapsState), files),
		now: Date.now,
		rules: FLASHCARDS_RULES,
		busy: () => files.busy(),
		makeBackup: backup,
		onTimeZone: (deviceId, zone) => takeTimeZone(deviceId, zone),
	}));
}

export function flashcardsDesktop(): MapsDesktop {
	const files = flashcardsFiles();
	return (engine().desktop ??= createMapsDesktop({
		files,
		state: desktopState(stateFile(path.join(/* turbopackIgnore: true */ syncStateDir(), "flashcards-desktop.json"), isDesktopMapsState), files),
		identity: () => {
			const pairing = readCloudPairing();
			return pairing ? { server: pairing.server, deviceId: pairing.deviceId } : null;
		},
		request: (pathname, init) => syncRequest(pathname, init),
		now: Date.now,
		clockOffset: measuredClockOffsetMs,
		timeZone: localTimeZone,
		rules: FLASHCARDS_RULES,
		path: FLASHCARDS_SYNC_PATH,
		busy: () => files.busy(),
		makeBackup: backup,
	}));
}
