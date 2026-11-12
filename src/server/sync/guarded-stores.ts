/**
 * Cloud sync (Phase 5): the lease backstop around the entity stores, wired
 * at the composition root (src/server/stores.ts).
 *
 * A session held by another device is read-only here. The routes refuse
 * such writes up front with a proper answer (engine.ts); this is the net
 * under them. A write that still arrives, for example from background work
 * that was running when the session moved, is DROPPED, not thrown: the
 * session's truth is on the device that holds it, and a late writer here
 * must not be able to fork it.
 *
 * Reads always pass. With sync never started, `holds` is true for every
 * session and each method is the inner store's own.
 */

import type { ChatStore, JobStore } from "../../core/ports.ts";

function dropped(what: string, chatId: string): void {
	console.warn(`[LearnHarness] sync: ${what} for a session another device holds was not saved (${chatId}).`);
}

// Every call reaches the inner store's method AS IT IS AT THAT MOMENT, never a
// reference taken at wiring time: the inner store object stays the one place
// a method can be replaced (tests do exactly that).

export function guardChatStore(inner: ChatStore, holds: (chatId: string) => boolean): ChatStore {
	const held = (name: string, id: string): boolean => {
		if (holds(id)) return false;
		dropped(name, id);
		return true;
	};
	return {
		createChat: (title, kind) => inner.createChat(title, kind),
		getChat: (id) => inner.getChat(id),
		listChats: () => inner.listChats(),
		saveMessages(id, messages) { if (!held("a transcript", id)) inner.saveMessages(id, messages); },
		saveImageSnapshot(id, snapshotId, image) { if (!held("a picture", id)) inner.saveImageSnapshot(id, snapshotId, image); },
		saveTree(id, tree) { if (!held("a plan", id)) inner.saveTree(id, tree); },
		appendTurnUsage(id, entry) { if (!held("a usage entry", id)) inner.appendTurnUsage(id, entry); },
		appendExtractionUsage(id, entry) { if (!held("an extraction usage entry", id)) inner.appendExtractionUsage(id, entry); },
		saveSettings(id, settings) { if (!held("a model choice", id)) inner.saveSettings(id, settings); },
		renameChat(id, title) {
			if (!held("a new name", id)) return inner.renameChat(id, title);
			const record = inner.getChat(id);
			if (!record) throw new Error(`Chat not found: ${id}`);
			return record;
		},
		deleteChat(id) {
			return held("a deletion", id) ? false : inner.deleteChat(id);
		},
		// A Tutor (side question) answer that lands after the session moved:
		// the threads stay as they are, and `update` is never run.
		updateSideChats(id, update) {
			if (!held("a side question", id)) return inner.updateSideChats(id, update);
			// null would mean "no such session"; a record without threads has none.
			const record = inner.getChat(id);
			return record ? record.sideChats ?? [] : null;
		},
	};
}

export function guardJobStore(inner: JobStore, holds: (chatId: string) => boolean): JobStore {
	return {
		createJob: (init) => inner.createJob(init),
		getJob: (id) => inner.getJob(id),
		listJobs: (chatId) => inner.listJobs(chatId),
		findJobByToolCallId: (chatId, toolCallId) => inner.findJobByToolCallId(chatId, toolCallId),
		updateJob(id, patch) {
			const job = inner.getJob(id);
			if (job && !holds(job.chatId)) {
				dropped("a helper's progress", job.chatId);
				return job;
			}
			return inner.updateJob(id, patch);
		},
		deleteJobsForChat(chatId) {
			if (holds(chatId)) return inner.deleteJobsForChat(chatId);
			dropped("removing helper jobs", chatId);
			return 0;
		},
	};
}
