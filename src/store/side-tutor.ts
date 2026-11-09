/**
 * Side-tutor thread adapter: one JSON file per chat under
 * `<data>/side-tutor/<chatId>.json`. Kept apart from `chats/` on purpose —
 * the chat record is the main teacher's history, and side questions must
 * never ride into it (src/core/side-tutor.ts, law 1).
 *
 * Same discipline as the chat store: synchronous fs, atomic replace, a
 * forward-version guard on read, corrupt files read as an empty thread.
 */

import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import {
	emptySideTutorThread,
	SIDE_TUTOR_FORMAT_VERSION,
	type SideTutorEntry,
	type SideTutorStore,
	type SideTutorThread,
} from "../core/side-tutor.ts";
import { removeLeftoverTemps, writeFileAtomicSync } from "./atomic-write.ts";

/** Hard cap on stored entries per chat (oldest dropped first). */
const MAX_ENTRIES = 500;

function threadFile(chatId: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(chatId)) throw new Error(`Invalid chat id: ${chatId}`);
	return path.join(PATHS.sideTutor, `${chatId}.json`);
}

function read(chatId: string): SideTutorThread {
	const file = threadFile(chatId);
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		return emptySideTutorThread(chatId);
	}
	const thread = parsed as Partial<SideTutorThread> | null;
	if (!thread || typeof thread !== "object" || !Array.isArray(thread.entries)) return emptySideTutorThread(chatId);
	if (typeof thread.version === "number" && thread.version > SIDE_TUTOR_FORMAT_VERSION) {
		throw new Error(`Side-tutor thread for ${chatId} has format ${thread.version}; this build reads ${SIDE_TUTOR_FORMAT_VERSION}`);
	}
	const entries = thread.entries.filter(
		(e): e is SideTutorEntry =>
			!!e && typeof e === "object" && typeof (e as SideTutorEntry).id === "string" && typeof (e as SideTutorEntry).question === "string",
	);
	return { version: SIDE_TUTOR_FORMAT_VERSION, chatId, entries };
}

function write(thread: SideTutorThread): void {
	fs.mkdirSync(PATHS.sideTutor, { recursive: true });
	writeFileAtomicSync(threadFile(thread.chatId), JSON.stringify(thread, null, "\t"), { allowInPlaceFallback: true });
}

function append(chatId: string, entry: SideTutorEntry): SideTutorThread {
	const thread = read(chatId);
	const entries = [...thread.entries, entry].slice(-MAX_ENTRIES);
	const next = { ...thread, entries };
	write(next);
	return next;
}

function clear(chatId: string): void {
	const file = threadFile(chatId);
	try {
		fs.unlinkSync(file);
	} catch {
		// already gone
	}
	removeLeftoverTemps(file);
}

export const sideTutorStore: SideTutorStore = { read, append, clear };
