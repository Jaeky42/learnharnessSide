/**
 * Cloud sync (Phase 5): this copy's own work on a session, for the sync
 * engine. A take-over waits for a reply being written, and stops helpers
 * and extraction (owner's decision: "finish the reply, move the helpers").
 *
 * Imported for its side effect by the server barrel, so every route has it.
 * Kept apart from engine.ts, which the proxy loads and which must not pull
 * in the agents.
 */

import { fireJobAbort } from "../../agent/subagents/aborts.ts";
import { abortExtraction } from "../../agent/subagents/extraction.ts";
import { jobStore } from "../../store/jobs.ts";
import { discardChatDeliveries } from "../jobs.ts";
import { isTurnRunning } from "../turn-liveness.ts";
import { abortTurn } from "../turn-runs.ts";
import { registerLocalWork } from "./engine.ts";

registerLocalWork({
	replying: (chatId) => isTurnRunning(chatId),
	stop(chatId, options) {
		if (options?.turn) abortTurn(chatId);
		abortExtraction(chatId);
		// A stopped helper writes nothing more: its record stays "running", so
		// the device that holds the session next starts it again from the top.
		for (const job of jobStore.listJobs(chatId)) {
			if (job.status === "running") fireJobAbort(job.id);
		}
		// Results waiting in memory to be delivered here belong to the new holder
		// now; they are in the job files that travel with the session.
		discardChatDeliveries(chatId);
	},
});
