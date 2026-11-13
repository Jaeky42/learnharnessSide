/**
 * The session stamp the browser sees (perf round), ONE function for the full
 * GET, `?only=stamp` and the lesson page, so they can never disagree.
 *
 * It is the chat file's stat stamp plus a short digest of the four values the
 * browser adopts from a full read that are NOT in the file: turnError, plugin
 * question and problem availability, and pricing. A change in any of them
 * (a failure held in memory, a plugin switched off, prices arriving) changes
 * the stamp with no file write. coverage, turnInFlight and compacting are
 * deliberately out: the lesson screen doesn't adopt them from a full read.
 *
 * No stamp at all (null) while a plugin question is pending or a plugin problem
 * is active: the page's first read never adopted the availability values, and
 * `?only=stamp` doesn't reconcile (a full read may write at catch-up time what
 * it didn't at mount). The browser treats a non-string stamp as "unknown" and
 * does the full read, which is how those sessions always behaved.
 */

import { createHash } from "node:crypto";
import type { ChatRecord } from "../core/contracts.ts";
import { activeProblemOf, pendingPluginQuestionOf } from "../core/native-messages.ts";
import { chatStamp } from "./chats.ts";
import { getPluginHost, getPluginQuestionTypeResolver } from "./plugins.ts";
import { pluginProblemAvailabilityOf, type ProblemTypeResolver } from "./plugin-problems.ts";
import { pluginQuestionAvailabilityOf, type QuestionTypeResolver } from "./plugin-questions.ts";
import { sessionCost } from "./pricing.ts";
import { stores } from "./stores.ts";
import { turnFailure } from "./turn-runs.ts";

export interface BrowserState {
	chat: ChatRecord;
	/** The composite stamp: file stat stamp + digest of the four values below;
	 *  null while a plugin question is pending or a plugin problem is active. */
	stamp: string | null;
	pluginQuestionAvailability: ReturnType<typeof pluginQuestionAvailabilityOf>;
	pluginProblemAvailability: ReturnType<typeof pluginProblemAvailabilityOf>;
	pricing: ReturnType<typeof sessionCost>;
	turnError: string | undefined;
}

/** True while the conservative rule applies: no stamp is given. */
function stampless(chat: ChatRecord): boolean {
	return !!pendingPluginQuestionOf(chat.messages) || !!activeProblemOf(chat.messages)?.pluginProblem;
}

function valuesOf(id: string, chat: ChatRecord, questionResolver?: QuestionTypeResolver, problemResolver?: ProblemTypeResolver) {
	return {
		turnError: turnFailure(id),
		pluginQuestionAvailability: pluginQuestionAvailabilityOf(chat, questionResolver),
		pluginProblemAvailability: pluginProblemAvailabilityOf(chat, problemResolver),
		pricing: sessionCost(chat),
	};
}

function compose(fileStamp: string | null, values: ReturnType<typeof valuesOf>): string {
	const digest = createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, 16);
	return `${fileStamp ?? "none"}.${digest}`;
}

/** From a record just read (and the file stamp taken BEFORE that read): resolve
 *  the plugin types the way the full GET does, re-reading after each await
 *  (and re-taking the stamp first), and compute the four values and the stamp.
 *  Null when the session vanished. Never writes. */
export async function browserState(id: string, initial: { chat: ChatRecord; fileStamp: string | null }): Promise<BrowserState | null> {
	let { chat, fileStamp } = initial;
	const reread = (): boolean => {
		fileStamp = chatStamp(id);
		const next = stores.chatStore.getChat(id);
		if (!next) return false;
		chat = next;
		return true;
	};
	let questionResolver: QuestionTypeResolver | undefined;
	if (pendingPluginQuestionOf(chat.messages)) {
		try { questionResolver = await getPluginQuestionTypeResolver(); } catch { /* unavailable fallback */ }
		// No awaited plugin startup may separate this read from the response projection.
		if (!reread()) return null;
	}
	let problemResolver: ProblemTypeResolver | undefined;
	if (activeProblemOf(chat.messages)?.pluginProblem) {
		try { problemResolver = (await getPluginHost()).resolveProblemType; } catch { /* unavailable fallback */ }
		if (!reread()) return null;
	}
	const values = valuesOf(id, chat, questionResolver, problemResolver);
	return { chat, stamp: stampless(chat) ? null : compose(fileStamp, values), ...values };
}

/** A fresh read for callers that need only the record and its stamp (`?only=stamp`,
 *  the page): stat first, then the record. Where a stamp is given it is exactly
 *  what browserState gives, and a stampless session needs no plugin resolvers. */
export async function readBrowserState(id: string): Promise<{ chat: ChatRecord; stamp: string | null } | null> {
	const fileStamp = chatStamp(id);
	const chat = stores.chatStore.getChat(id);
	if (!chat) return null;
	return { chat, stamp: stampless(chat) ? null : compose(fileStamp, valuesOf(id, chat)) };
}
