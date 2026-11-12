/**
 * Cloud sync (Phase 5, docs/cloud-sync.md): sessions and leases, the pure
 * part. A session travels WHOLE: its chat record (with its side questions
 * inside it, since upstream 0.6.0), its notes home-folder record and its
 * helper job files. Only the device that holds the session's lease may
 * change it or send it; the server is the lease authority.
 *
 * The files travel as their exact text, so both sides hold the same bytes.
 */

import { createHash } from "node:crypto";
import { CURRENT_CHAT_VERSION } from "../contracts/chat.ts";

/** The server's own holder id (what the phone works through). */
export const CLOUD_HOLDER = "cloud";

/** One session's files, as text. */
export interface SessionBundle {
	/** chats/<id>.json */
	chat: string;
	/** notes/sessions/<id>.json, or null when there is none. */
	home: string | null;
	/** jobs/<jobId>.json for every helper job of this session. */
	jobs: Record<string, string>;
}

/** Far above any real session; a guard against a runaway request. */
export const MAX_BUNDLE_BYTES = 128 * 1024 * 1024;

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isSessionId(value: unknown): value is string {
	return typeof value === "string" && SAFE_ID.test(value);
}

function parsedObject(text: unknown): Record<string, unknown> | null {
	if (typeof text !== "string") return null;
	try {
		const value: unknown = JSON.parse(text);
		return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
	} catch {
		return null;
	}
}

/**
 * A chat record this build can't read as its own format: stamped with a
 * newer `version` than CURRENT_CHAT_VERSION (written by a newer build). The
 * app's own store refuses to read such a file; sync neither sends one nor
 * takes one ("the second lock" beside the protocol number).
 */
export function chatFormatTooNew(chat: Record<string, unknown>): boolean {
	return typeof chat.version === "number" && chat.version > CURRENT_CHAT_VERSION;
}

/** The refusal for a session whose chat file is newer than this build's format. */
export const NEWER_FORMAT_CODE = "newer_format";

/** The same check on a chat file's text. An unreadable file isn't "too new" (it is refused elsewhere). */
export function chatFileTooNew(text: string): boolean {
	const chat = parsedObject(text);
	return chat !== null && chatFormatTooNew(chat);
}

/**
 * A bundle received from the other side, checked before anything is
 * written: every file must be the JSON it claims to be and belong to this
 * session, and the chat record must be in a format this build reads.
 * Returns null when it can't be trusted.
 */
export function checkBundle(chatId: string, value: unknown): SessionBundle | null {
	if (!isSessionId(chatId) || !value || typeof value !== "object" || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	const chat = parsedObject(raw.chat);
	if (!chat || chat.id !== chatId || !Array.isArray(chat.messages) || chatFormatTooNew(chat)) return null;
	if (raw.home !== null && !parsedObject(raw.home)) return null;
	if (!raw.jobs || typeof raw.jobs !== "object" || Array.isArray(raw.jobs)) return null;
	const jobs: Record<string, string> = {};
	for (const [jobId, text] of Object.entries(raw.jobs as Record<string, unknown>)) {
		const job = parsedObject(text);
		if (!isSessionId(jobId) || !job || job.id !== jobId || job.chatId !== chatId) return null;
		jobs[jobId] = text as string;
	}
	const bundle: SessionBundle = { chat: raw.chat as string, home: raw.home as string | null, jobs };
	return bundleBytes(bundle) <= MAX_BUNDLE_BYTES ? bundle : null;
}

export function bundleBytes(bundle: SessionBundle): number {
	let total = Buffer.byteLength(bundle.chat) + Buffer.byteLength(bundle.home ?? "");
	for (const text of Object.values(bundle.jobs)) total += Buffer.byteLength(text);
	return total;
}

/** One fingerprint for the whole bundle: equal digests mean equal files. */
export function bundleDigest(bundle: SessionBundle): string {
	const hash = createHash("sha256");
	const part = (label: string, text: string | null) => {
		hash.update(`${label}\0${text === null ? "-" : Buffer.byteLength(text)}\0`);
		if (text !== null) hash.update(text);
	};
	part("chat", bundle.chat);
	// The bundle had a side-tutor file until upstream 0.6.0. Its "none" stays
	// in the fingerprint, so the digests both sides saved before then still
	// match a session that had no such file (no mass re-send at the update,
	// and the re-pairing rules in desktop-sync.ts compare against them).
	part("sideTutor", null);
	part("home", bundle.home);
	for (const jobId of Object.keys(bundle.jobs).sort()) part(`job:${jobId}`, bundle.jobs[jobId]!);
	return hash.digest("hex");
}

/** What the holder last told the server about a session (the take-over warning's evidence). */
export type HolderWord = "all-sent" | "busy" | "unsent";

export function isHolderWord(value: unknown): value is HolderWord {
	return value === "all-sent" || value === "busy" || value === "unsent";
}

/** One line of the server's answer to "what changed since I last asked?". */
export interface SessionChange {
	id: string;
	version: number;
	/** A device id, or CLOUD_HOLDER. */
	holder: string;
	/** The holding desktop's name; null for the cloud. */
	holderName: string | null;
	deleted: boolean;
}

/** The refusal every write to a session held elsewhere gets. */
export const HELD_ELSEWHERE_CODE = "session_held_elsewhere";
export const HELD_ELSEWHERE_MESSAGE = "This session is held by another device. Take it over to continue it here.";

/**
 * A plain marker cookie the app's own server sets only where sync is in use
 * (Phase 6): a PC that is paired or was removed by its server, and a server
 * some desktop has synced with. Pages with the marker ask their server about
 * sync; pages without it never do, so an unpaired app makes no new request.
 * Not a credential.
 */
export const SYNC_MARKER_COOKIE = "lh_cloud";
