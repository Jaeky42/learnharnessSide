/**
 * Cloud sync (Phase 6, docs/cloud-sync.md): "Unpair this PC", the desktop's
 * own way out (owner's decisions).
 *
 *  1. If the server can be reached, this PC first sends everything it has
 *     (one last round), then tells the server to forget it. The server
 *     takes the sessions this PC held as its own.
 *  2. On this PC every session becomes its own to continue: it is no longer
 *     syncing, so nothing here is held by anyone else.
 *  3. The pairing file keeps the address, the name and the device id, so a
 *     new code reconnects this PC as the same device, and notes that the
 *     learner did this here, so nothing reminds them to pair again.
 *
 * It works without a connection too: the PC forgets its key, and `told`
 * says whether the server heard. Nothing on this PC is deleted.
 */

import { readCloudPairing, writeCloudPairing } from "../../store/sync/pairing.ts";
import { cloudStatus, resetCloudLink, syncRequest, type CloudStatus, type SyncDeps } from "./client.ts";
import { desktopSync } from "./engine.ts";
import { stopSyncLoop } from "./loop.ts";
import { runSyncRound } from "./round.ts";

export interface UnpairResult {
	status: CloudStatus;
	/** The server was told (or had already removed this PC). */
	told: boolean;
}

export async function unpairThisDesktop(deps: SyncDeps & { round?: () => Promise<unknown> } = {}): Promise<UnpairResult> {
	const pairing = readCloudPairing();
	if (!pairing) return { status: cloudStatus(), told: false };
	let told = false;
	if (pairing.key) {
		// Whatever this PC hasn't sent goes first, so the server's copy is whole.
		await (deps.round ?? runSyncRound)().catch(() => undefined);
		const reply = await syncRequest("/api/sync/unpair", { method: "POST", body: {} }, deps);
		told = reply.ok || reply.reason === "not-paired";
	}
	stopSyncLoop();
	desktopSync().release();
	// syncRequest drops the key itself when the server no longer knows this PC.
	const current = readCloudPairing() ?? pairing;
	writeCloudPairing({ ...current, key: null, unpairedHere: true });
	resetCloudLink();
	return { status: cloudStatus(), told };
}
