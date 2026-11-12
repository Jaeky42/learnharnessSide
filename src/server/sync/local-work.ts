/**
 * Cloud sync (Phase 5): this copy's own work on a session, for the sync
 * engine. A take-over waits for a reply being written, and stops helpers
 * and extraction (owner's decision: "finish the reply, move the helpers").
 *
 * A side question's answer (the Tutor, upstream 0.6.0) being written counts
 * as a reply being written: the holder finishes it, then hands over. When
 * the session goes anyway (it was lost to a take-over, or taken from the
 * cloud), a side answer still running for it stops with the other work.
 *
 * Imported for its side effect by the server barrel, so every route has it.
 * Kept apart from engine.ts, which the proxy loads and which must not pull
 * in the agents.
 */

import { fireJobAbort } from "../../agent/subagents/aborts.ts";
import { abortExtraction } from "../../agent/subagents/extraction.ts";
import { subscribe } from "../../core/events.ts";
import { jobStore } from "../../store/jobs.ts";
import { discardChatDeliveries } from "../jobs.ts";
import { sideChats } from "../side-chat.ts";
import { isTurnRunning } from "../turn-liveness.ts";
import { abortTurn } from "../turn-runs.ts";
import { registerLocalWork } from "./engine.ts";

/**
 * The sessions with a side answer being written. The side-chat service
 * announces `side-chats-changed` right after it starts a run and right
 * after it ends one; at each announcement the service's own list says
 * which threads are being answered. Kept from those events so that
 * "is anything being written?" (asked for every held session on every
 * round) never reads a chat record. On globalThis: Next builds each route
 * as its own module instance, and there must be one listener per process.
 */
interface SideAnswersGlobal { __lhSyncSideAnswers?: Set<string> }
const g = globalThis as typeof globalThis & SideAnswersGlobal;
const sideAnswering = g.__lhSyncSideAnswers ?? (() => {
	const set = new Set<string>();
	g.__lhSyncSideAnswers = set;
	subscribe((event) => {
		if (event.type !== "side-chats-changed") return;
		let answering = false;
		try { answering = Object.keys(sideChats.list(event.chatId)?.answering ?? {}).length > 0; } catch { /* the session is gone */ }
		if (answering) set.add(event.chatId); else set.delete(event.chatId);
	});
	return set;
})();

registerLocalWork({
	replying: (chatId) => isTurnRunning(chatId) || sideAnswering.has(chatId),
	stop(chatId, options) {
		if (options?.turn) abortTurn(chatId);
		abortExtraction(chatId);
		// A side answer still being written belongs to a session this copy is
		// giving up. Its stopped answer isn't kept: the session's files from
		// its new holder replace this copy's, and a late write is dropped
		// (guarded-stores.ts).
		sideChats.stopAll(chatId);
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
