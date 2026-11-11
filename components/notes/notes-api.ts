"use client";

/**
 * The notes drawer's transport (src/server/notes.ts). Every call is the
 * learner's own action; nothing here talks to an agent.
 */

import type { FolderContents, NotesStatus, NotesTree, SplitChoice } from "@/src/core";

export interface NoteFile {
	path: string;
	body: string;
	hash: string | null;
	pending: boolean;
	sessions: string[];
	parent: string | null;
}

export class NotesRequestError extends Error {
	constructor(readonly status: number, message: string, readonly body: Record<string, unknown> = {}) {
		super(message);
	}
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
	let res: Response;
	try {
		res = await fetch(url, init);
	} catch {
		throw new NotesRequestError(0, "LearnHarness couldn't be reached. Try again.");
	}
	let body: Record<string, unknown> = {};
	try { body = (await res.json()) as Record<string, unknown>; } catch { /* empty body */ }
	if (!res.ok) throw new NotesRequestError(res.status, typeof body.error === "string" ? body.error : `Request failed (${res.status})`, body);
	return body as T;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

export function fetchTree(): Promise<NotesTree> {
	return call<NotesTree>("/api/notes", { cache: "no-store" });
}

export function notesAction<T = Record<string, unknown>>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
	return call<T>("/api/notes", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ action, ...payload }) });
}

export function chooseVault(path: string): Promise<{ status: NotesStatus }> {
	return notesAction("vault", { path });
}

export function readNote(path: string): Promise<NoteFile> {
	return call<NoteFile>(`/api/notes/file?path=${encodeURIComponent(path)}`, { cache: "no-store" });
}

export type SaveOutcome =
	| { kind: "saved"; hash: string | null; pending: boolean }
	| { kind: "conflict"; body: string; hash: string };

export async function saveNote(path: string, body: string, baseHash: string | null, chatId: string | null): Promise<SaveOutcome> {
	try {
		const r = await call<{ hash: string | null; pending: boolean }>("/api/notes/file", {
			method: "PUT",
			headers: JSON_HEADERS,
			body: JSON.stringify({ path, body, baseHash, chatId }),
		});
		return { kind: "saved", hash: r.hash, pending: r.pending };
	} catch (e) {
		if (e instanceof NotesRequestError && e.status === 409 && e.body.conflict && typeof e.body.conflict === "object") {
			const c = e.body.conflict as { body: string; hash: string };
			return { kind: "conflict", body: c.body, hash: c.hash };
		}
		throw e;
	}
}

/** What a folder holds, however deep (for the delete confirm). */
export function folderContents(path: string): Promise<FolderContents> {
	return notesAction("contents", { path });
}

/** Deletes a note, or a folder with everything in it, for good. */
export function deleteItem(path: string): Promise<{ path: string }> {
	return notesAction("delete", { path });
}

export function createNote(folder: string, title: string, chatId: string | null): Promise<{ path: string }> {
	return notesAction("create", { folder, title, chatId });
}

export function createFolder(parent: string, name: string): Promise<{ path: string }> {
	return notesAction("folder", { parent, name });
}

export function moveItem(from: string, to: string): Promise<{ path: string }> {
	return notesAction("move", { from, to });
}

export function splitNote(path: string, choices: SplitChoice[], chatId: string | null): Promise<{ opId: string; path: string; children: string[] }> {
	return notesAction("split", { path, choices, chatId });
}

export function mergeNote(path: string): Promise<{ opId: string; path: string }> {
	return notesAction("merge", { path });
}

export function extractSelection(path: string, start: number, end: number, title: string, chatId: string | null): Promise<{ opId: string; path: string }> {
	return notesAction("extract", { path, start, end, title, chatId });
}

export function undoNotes(opId: string): Promise<{ ok: true }> {
	return notesAction("undo", { opId });
}

export async function getHomeFolder(chatId: string): Promise<string | null> {
	try {
		const r = await call<{ homeFolder: string | null }>(`/api/chats/${encodeURIComponent(chatId)}/notes`, { cache: "no-store" });
		return r.homeFolder;
	} catch {
		return null;
	}
}

export function setHomeFolder(chatId: string, folder: string | null): Promise<{ homeFolder: string | null }> {
	return call(`/api/chats/${encodeURIComponent(chatId)}/notes`, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ homeFolder: folder }) });
}

const IMAGE_EXT: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/bmp": "bmp",
	"image/avif": "avif",
};

export function pastedImageExtension(file: File): string | null {
	return IMAGE_EXT[file.type] ?? null;
}

export async function uploadImage(notePath: string, file: File): Promise<{ name: string; embed: string }> {
	const ext = pastedImageExtension(file);
	if (!ext) throw new NotesRequestError(400, "Only images can be pasted into notes.");
	const buf = new Uint8Array(await file.arrayBuffer());
	let bin = "";
	for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
	return call("/api/notes/attachment", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ notePath, ext, data: btoa(bin) }) });
}

export function assetUrl(target: string, fromNote: string): string {
	return `/api/notes/asset?target=${encodeURIComponent(target)}&from=${encodeURIComponent(fromNote)}`;
}
