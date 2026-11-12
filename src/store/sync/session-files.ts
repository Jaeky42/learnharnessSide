/**
 * Cloud sync (Phase 5): a session's files on disk, read and written as
 * whole texts. The sync engine uses this instead of the entity stores on
 * purpose: it moves exact bytes, and it must be able to write a session
 * this device does not hold (the stores refuse that).
 *
 * The three places a session lives:
 *   chats/<id>.json            the chat record (its side questions are inside it)
 *   notes/sessions/<id>.json   its notes home folder
 *   jobs/<jobId>.json          its helper jobs (each names its chatId)
 *
 * Until upstream 0.6.0 a fourth, side-tutor/<id>.json, travelled too. A
 * leftover one is no longer read, sent or written here.
 */

import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../../config.ts";
import { isSessionId, type SessionBundle } from "../../core/sync/sessions.ts";
import { removeLeftoverTemps, writeFileAtomicSync } from "../atomic-write.ts";

export interface SessionDirs {
	chats: string;
	notesSessions: string;
	jobs: string;
}

export function sessionDirsUnder(dataDir: string): SessionDirs {
	return {
		chats: path.join(/* turbopackIgnore: true */ dataDir, "chats"),
		notesSessions: path.join(/* turbopackIgnore: true */ dataDir, "notes", "sessions"),
		jobs: path.join(/* turbopackIgnore: true */ dataDir, "jobs"),
	};
}

export function productionSessionDirs(): SessionDirs {
	return { chats: PATHS.chats, notesSessions: path.join(/* turbopackIgnore: true */ PATHS.notes, "sessions"), jobs: path.join(/* turbopackIgnore: true */ PATHS.data, "jobs") };
}

export interface SessionFiles {
	/** Every session with a chat record on this device. */
	listIds(): string[];
	/** A cheap stamp of the session's files (times and sizes): it changes
	 *  whenever one of them is written. null when there is no chat record. */
	stamp(chatId: string): string | null;
	/** The stamp of every session here, in one pass over the folders. */
	stamps(): Map<string, string>;
	read(chatId: string): SessionBundle | null;
	/** Replace the session's files with exactly this bundle. */
	write(chatId: string, bundle: SessionBundle): void;
	remove(chatId: string): void;
}

function statPart(file: string): string {
	try {
		const st = fs.statSync(/* turbopackIgnore: true */ file);
		return `${st.mtimeMs}:${st.size}`;
	} catch {
		return "-";
	}
}

function readText(file: string): string | null {
	try { return fs.readFileSync(/* turbopackIgnore: true */ file, "utf-8"); } catch { return null; }
}

function writeText(file: string, text: string, options: { strict?: boolean } = {}): void {
	fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(file), { recursive: true });
	writeFileAtomicSync(file, text, options.strict ? { mode: 0o600 } : { allowInPlaceFallback: true });
}

/**
 * A plugin-linked helper job (upstream 0.6.0) is written the way the job
 * store writes one: replaced atomically, never in place, readable by its
 * owner only (src/store/jobs.ts writeJob).
 */
function pluginLinked(text: string): boolean {
	try {
		const job = JSON.parse(text) as { kind?: unknown; plugin?: unknown };
		return job.kind === "plugin" || job.plugin !== undefined;
	} catch {
		return false;
	}
}

function removeFile(file: string): void {
	try { fs.unlinkSync(/* turbopackIgnore: true */ file); } catch { /* already gone */ }
	removeLeftoverTemps(file);
}

export function sessionFiles(dirs: SessionDirs = productionSessionDirs()): SessionFiles {
	/** jobs/<file> → which session it belongs to, remembered per (time, size). */
	const jobOwners = new Map<string, { stamp: string; chatId: string | null }>();

	const chatFile = (id: string) => path.join(/* turbopackIgnore: true */ dirs.chats, `${id}.json`);
	const homeFile = (id: string) => path.join(/* turbopackIgnore: true */ dirs.notesSessions, `${id}.json`);
	const jobFile = (jobId: string) => path.join(/* turbopackIgnore: true */ dirs.jobs, `${jobId}.json`);

	/** Every session's jobs (jobId and stamp), in one pass over the jobs folder. */
	function jobsBySession(): Map<string, Array<{ jobId: string; stamp: string }>> {
		let names: string[];
		const out = new Map<string, Array<{ jobId: string; stamp: string }>>();
		try { names = fs.readdirSync(/* turbopackIgnore: true */ dirs.jobs); } catch { return out; }
		const live = new Set<string>();
		for (const name of names.sort()) {
			if (!name.endsWith(".json")) continue;
			const jobId = name.slice(0, -5);
			if (!isSessionId(jobId)) continue;
			live.add(jobId);
			const stamp = statPart(jobFile(jobId));
			let known = jobOwners.get(jobId);
			if (!known || known.stamp !== stamp) {
				let owner: string | null = null;
				try {
					const parsed = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ jobFile(jobId), "utf-8")) as { chatId?: unknown };
					owner = typeof parsed.chatId === "string" ? parsed.chatId : null;
				} catch { /* unreadable: belongs to nobody */ }
				known = { stamp, chatId: owner };
				jobOwners.set(jobId, known);
			}
			if (known.chatId !== null) {
				const list = out.get(known.chatId);
				if (list) list.push({ jobId, stamp }); else out.set(known.chatId, [{ jobId, stamp }]);
			}
		}
		for (const jobId of jobOwners.keys()) if (!live.has(jobId)) jobOwners.delete(jobId);
		return out;
	}

	const jobsOf = (chatId: string) => jobsBySession().get(chatId) ?? [];

	function stampOf(chatId: string, jobs: Array<{ jobId: string; stamp: string }>): string | null {
		const chat = statPart(chatFile(chatId));
		if (chat === "-") return null;
		// "s-" was the side-tutor file's place (until upstream 0.6.0): kept as
		// "none", so stamps saved before then still match.
		return `c${chat}|s-|h${statPart(homeFile(chatId))}|j${jobs.map((j) => `${j.jobId}=${j.stamp}`).join(",")}`;
	}

	function listIds(): string[] {
		let names: string[];
		try { names = fs.readdirSync(/* turbopackIgnore: true */ dirs.chats); } catch { return []; }
		return names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).filter(isSessionId).sort();
	}

	return {
		listIds,
		stamp(chatId) {
			return isSessionId(chatId) ? stampOf(chatId, jobsOf(chatId)) : null;
		},
		stamps() {
			const jobs = jobsBySession();
			const out = new Map<string, string>();
			for (const id of listIds()) {
				const stamp = stampOf(id, jobs.get(id) ?? []);
				if (stamp !== null) out.set(id, stamp);
			}
			return out;
		},
		read(chatId) {
			if (!isSessionId(chatId)) return null;
			const chat = readText(chatFile(chatId));
			if (chat === null) return null;
			const jobs: Record<string, string> = {};
			for (const { jobId } of jobsOf(chatId)) {
				const text = readText(jobFile(jobId));
				if (text !== null) jobs[jobId] = text;
			}
			return { chat, home: readText(homeFile(chatId)), jobs };
		},
		write(chatId, bundle) {
			if (!isSessionId(chatId)) throw new Error(`Invalid session id: ${chatId}`);
			// Helpers first, the chat record last: a reader never finds a record
			// whose jobs aren't there yet.
			const keep = new Set(Object.keys(bundle.jobs));
			for (const { jobId } of jobsOf(chatId)) if (!keep.has(jobId)) removeFile(jobFile(jobId));
			for (const [jobId, text] of Object.entries(bundle.jobs)) {
				if (readText(jobFile(jobId)) !== text) writeText(jobFile(jobId), text, { strict: pluginLinked(text) });
			}
			if (bundle.home === null) removeFile(homeFile(chatId));
			else if (readText(homeFile(chatId)) !== bundle.home) writeText(homeFile(chatId), bundle.home);
			if (readText(chatFile(chatId)) !== bundle.chat) writeText(chatFile(chatId), bundle.chat);
		},
		remove(chatId) {
			if (!isSessionId(chatId)) return;
			for (const { jobId } of jobsOf(chatId)) removeFile(jobFile(jobId));
			removeFile(homeFile(chatId));
			removeFile(chatFile(chatId));
		},
	};
}
