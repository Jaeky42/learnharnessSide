/**
 * Cloud sync (Phase 5): starts the sync loop in a desktop app that is
 * paired. Imported for its side effect by the server barrel, so it runs
 * when the app's first API request arrives, a moment after the app opens.
 *
 * It does nothing, and sets no timer, on the cloud server, in an app that
 * was never paired (no pairing file) or that the learner unpaired here,
 * while the app is being built, and in tests.
 */

import { readCloudPairing } from "../../store/sync/pairing.ts";
import { serverModeEnabled } from "../server-auth.ts";
import { startServerFlashcardsWatcher } from "./flashcards-engine.ts";
import { startSyncLoop } from "./loop.ts";

export function shouldAutostart(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.NODE_ENV === "test" || env.NEXT_PHASE === "phase-production-build" || env.LH_SYNC_LOOP === "off") return false;
	if (serverModeEnabled()) return false;
	const pairing = readCloudPairing();
	return pairing !== null && !pairing.unpairedHere;
}

if (shouldAutostart()) startSyncLoop();

// The server notes its own Flashcards changes with their time (flashcards-engine.ts); it does
// anything only once a PC has exchanged Flashcards with it.
if (serverModeEnabled() && process.env.NODE_ENV !== "test" && process.env.NEXT_PHASE !== "phase-production-build") startServerFlashcardsWatcher();
