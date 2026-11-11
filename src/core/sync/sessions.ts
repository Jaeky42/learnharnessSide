/**
 * Cloud sync (Phase 5, docs/cloud-sync.md): sessions and leases, the pure
 * part. A session travels WHOLE: its chat record, its side-tutor thread,
 * its notes home-folder record and its helper job files. Only the device
 * that holds the session's lease may change it or send it; the server is
 * the lease authority.
 *
 * The files travel as their exact text, so both sides hold the same bytes.
 */

import { createHash } from "node:crypto";

/** The server's own holder id (what the phone works through). */
export const CLOUD_HOLDER = "cloud";

/** One session's files, as text. */
export interface SessionBundle {
	/** chats/<id>.json */
	chat: string;
	/** side-tutor/<id>.json, or null when there is none. */
	sideTutor: string | null;
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
 * A bundle received from the other side, checked before anything is
 * written: every file must be the JSON it claims to be and belong to this
 * session. Returns null when it can't be trusted.
 */
export function checkBundle(chatId: string, value: unknown): SessionBundle | null {
	if (!isSessionId(chatId) || !value || typeof value !== "object" || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	const chat = parsedObject(raw.chat);
	if (!chat || chat.id !== chatId || !Array.isArray(chat.messages)) return null;
	if (raw.sideTutor !== null && !parsedObject(raw.sideTutor)) return null;
	if (raw.home !== null && !parsedObject(raw.home)) return null;
	if (!raw.jobs || typeof raw.jobs !== "object" || Array.isArray(raw.jobs)) return null;
	const jobs: Record<string, string> = {};
	for (const [jobId, text] of Object.entries(raw.jobs as Record<string, unknown>)) {
		const job = parsedObject(text);
		if (!isSessionId(jobId) || !job || job.id !== jobId || job.chatId !== chatId) return null;
		jobs[jobId] = text as string;
	}
	const bundle: SessionBundle = { chat: raw.chat as string, sideTutor: raw.sideTutor as string | null, home: raw.home as string | null, jobs };
	return bundleBytes(bundle) <= MAX_BUNDLE_BYTES ? bundle : null;
}

export function bundleBytes(bundle: SessionBundle): number {
	let total = Buffer.byteLength(bundle.chat) + Buffer.byteLength(bundle.sideTutor ?? "") + Buffer.byteLength(bundle.home ?? "");
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
	part("sideTutor", bundle.sideTutor);
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
