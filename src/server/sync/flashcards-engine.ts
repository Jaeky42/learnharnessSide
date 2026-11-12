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
 *   - a memory that is missing while the exchange's state is there, or a
 *     library that doesn't follow its memory (put back, replaced): this
 *     side's records are lost, and everything is sent again (the server
 *     starts its table afresh, as a server that lost its records does);
 *     nothing in such a library counts as deleted. A library that can't be
 *     read changes none of this: nothing is sent, taken or written then;
 *   - a generation that shows no change for 15 minutes holds nothing;
 *   - each side copies its Flashcards folder aside right before its first
 *     Flashcards exchange; with no copy, no Flashcards sync.
 */

import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../../config.ts";
import { emit, subscribe, type ServerEvent } from "../../core/events.ts";
import { checkFlashcardsChange, flashcardsKindOf } from "../../core/sync/flashcards.ts";
import { makeFlashcardsBackup } from "../../store/sync/backup.ts";
import { readCloudPairing } from "../../store/sync/pairing.ts";
import { stateFile, type StateFile } from "../../store/sync/state-file.ts";
import { activePairing, measuredClockOffsetMs, syncRequest } from "./client.ts";
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

/**
 * A server whose records are lost (no memory for a library it can read, or
 * a library that doesn't follow its memory: put back or replaced) starts its
 * table afresh: every PC sends everything once. Its backup was made already
 * and isn't made again. A library it can't read changes nothing here.
 */
export function authorityState(inner: StateFile<AuthorityMapsState>, files: Pick<FlashcardsFiles, "records">): StateFile<AuthorityMapsState> {
	return {
		read: () => {
			const state = inner.read();
			if (!state) return state;
			const records = files.records();
			return records === "lost" || records === "stale" ? { version: 1, seq: 0, items: {}, devices: [], ...(state.backup !== undefined ? { backup: state.backup } : {}) } : state;
		},
		write: inner.write,
		exists: inner.exists,
	};
}

/** A desktop whose records are lost (as above) sends everything again; the server's values stand where both have an item. */
export function desktopState(inner: StateFile<DesktopMapsState>, files: Pick<FlashcardsFiles, "records">): StateFile<DesktopMapsState> {
	return {
		read: () => {
			const state = inner.read();
			if (!state) return state;
			const records = files.records();
			const lost = (records === "lost" && state.synced) || records === "stale";
			return lost ? { ...state, synced: false, cursor: 0, known: {}, pending: {} } : state;
		},
		write: inner.write,
		exists: inner.exists,
	};
}

/**
 * This side's own Flashcards changes are noted with the time they were made
 * (a little after the plugin says so), not only when the next exchange
 * comes: the server's, while every PC is away, would otherwise all get the
 * time of the last one found. Only where Flashcards sync has run (`active`);
 * nothing happens, and no timer is set, anywhere else.
 */
export function watchFlashcardsChanges(deps: {
	subscribe: (listener: (event: ServerEvent) => void) => () => void;
	setTimer: (run: () => void, ms: number) => unknown;
	active: () => boolean;
	detect: () => void;
	delayMs?: number;
}): () => void {
	let waiting = false;
	return deps.subscribe((event) => {
		if (waiting || !isFlashcardsChange(event) || !deps.active()) return;
		waiting = true;
		deps.setTimer(() => {
			waiting = false;
			try { deps.detect(); } catch (error) { console.error(`[LearnHarness] Flashcards sync: ${error instanceof Error ? error.message : String(error)}`); }
		}, deps.delayMs ?? 2_000);
	});
}

/** Flashcards changed its library here (cards a generation adds come as `batch-changed`); what sync wrote doesn't count. */
export function isFlashcardsChange(event: ServerEvent): boolean {
	return event.type === "plugin-message" && event.pluginId === FLASHCARDS_PLUGIN_ID && (event.topic === "changed" || event.topic === "batch-changed") && !isSyncEcho(event.data);
}

const engineTimer = (run: () => void, ms: number): unknown => { const handle = setTimeout(run, ms); handle.unref?.(); return handle; };

/** The server's watcher (autostart.ts): active once a PC has exchanged Flashcards with it. */
export function startServerFlashcardsWatcher(): void {
	if (engine().watching) return;
	engine().watching = true;
	const stateOf = path.join(/* turbopackIgnore: true */ syncStateDir(), "flashcards.json");
	watchFlashcardsChanges({ subscribe, setTimer: engineTimer, active: () => fs.existsSync(/* turbopackIgnore: true */ stateOf), detect: () => flashcardsAuthority().detect() });
}

/** A paired desktop's watcher (loop.ts): notes its changes while the server can't be reached too. */
export function startDesktopFlashcardsWatcher(): void {
	if (engine().watching) return;
	engine().watching = true;
	const stateOf = path.join(/* turbopackIgnore: true */ syncStateDir(), "flashcards-desktop.json");
	watchFlashcardsChanges({ subscribe, setTimer: engineTimer, active: () => activePairing() !== null && fs.existsSync(/* turbopackIgnore: true */ stateOf), detect: () => flashcardsDesktop().detect() });
}

function backup(): string | null {
	try {
		return makeFlashcardsBackup(PATHS.data);
	} catch (error) {
		throw new Error(`The backup before the first Flashcards sync couldn't be made: ${error instanceof Error ? error.message : String(error)}`);
	}
}

interface FlashcardsEngine { files?: FlashcardsFiles; authority?: MapsAuthority; desktop?: MapsDesktop; watching?: boolean }
const globals = globalThis as typeof globalThis & { __lhFlashcardsSync?: FlashcardsEngine };
const engine = (): FlashcardsEngine => (globals.__lhFlashcardsSync ??= {});

export function flashcardsFiles(): FlashcardsFiles {
	return (engine().files ??= createFlashcardsFiles({ dataDir: PATHS.data, syncDir: syncStateDir(), now: Date.now, announce: announceFlashcardsChanged }));
}

/** Is a generation holding this side's Flashcards exchange? (The loop doesn't start a round for its notices then.) */
export function flashcardsBusy(): boolean {
	try { return flashcardsFiles().busy(); } catch { return false; }
}

export function flashcardsAuthority(): MapsAuthority {
	const files = flashcardsFiles();
	return (engine().authority ??= createMapsAuthority({
		files,
		state: authorityState(stateFile(path.join(/* turbopackIgnore: true */ syncStateDir(), "flashcards.json"), isAuthorityMapsState), files),
		now: Date.now,
		rules: FLASHCARDS_RULES,
		busy: () => files.busy(),
		locked: () => files.locked(),
		makeBackup: backup,
		// A new zone: every schedule here is worked out again in it, as the PC works them out.
		onTimeZone: (deviceId, zone) => { if (takeTimeZone(deviceId, zone)) files.rebuild(); },
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
		// The zone goes to the server (first, or after this PC moved): the server works every schedule
		// out again in it, and so does this PC, once per zone (not again while the server is busy).
		onTimeZoneChange: () => { files.rebuild(); },
		rules: FLASHCARDS_RULES,
		path: FLASHCARDS_SYNC_PATH,
		busy: () => files.busy(),
		locked: () => files.locked(),
		makeBackup: backup,
	}));
}
