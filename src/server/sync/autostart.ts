/**
 * Cloud sync (Phase 5): starts the sync loop in a desktop app that is
 * paired. Imported for its side effect by the server barrel, so it runs
 * when the app's first API request arrives, a moment after the app opens.
 *
 * It does nothing, and sets no timer, on the cloud server, in an app that
 * was never paired (no pairing file), while the app is being built, and in
 * tests.
 */

import { readCloudPairing } from "../../store/sync/pairing.ts";
import { serverModeEnabled } from "../server-auth.ts";
import { startSyncLoop } from "./loop.ts";

export function shouldAutostart(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.NODE_ENV === "test" || env.NEXT_PHASE === "phase-production-build" || env.LH_SYNC_LOOP === "off") return false;
	return !serverModeEnabled() && readCloudPairing() !== null;
}

if (shouldAutostart()) startSyncLoop();
