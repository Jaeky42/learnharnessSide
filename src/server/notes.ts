/**
 * THE NOTES SERVICE — HTTP for the notes drawer (store: src/store/notes.ts).
 *
 *   GET  /api/notes                         → { status, folders, notes, backlinks }
 *   POST /api/notes {action:"vault", path}  → choose the vault folder
 *   POST /api/notes {action:"create", folder, title, chatId}
 *   POST /api/notes {action:"folder", parent, name}
 *   POST /api/notes {action:"move", from, to}
 *   POST /api/notes {action:"split", path, choices, chatId}
 *   POST /api/notes {action:"merge", path}
 *   POST /api/notes {action:"extract", path, start, end, title, chatId}
 *   POST /api/notes {action:"undo", opId}
 *   GET  /api/notes/file?path=              → { body, hash, pending, sessions, parent }
 *   PUT  /api/notes/file {path, body, baseHash, chatId}
 *   POST /api/notes/attachment {notePath, ext, data(base64)}
 *   GET  /api/notes/asset?target=&from=     → image bytes
 *   GET/PUT /api/chats/:id/notes            → the session's home folder
 *
 * Privacy: this service never touches a chat record beyond checking that a
 * chat id exists; no agent calls it.
 */

import { notesStore, NotesError } from "../store/notes.ts";
import { obsidianSync } from "./obsidian-sync.ts";
import { serverModeEnabled } from "./server-auth.ts";
import { stores } from "./stores.ts";

function fail(error: unknown): Response {
	if (error instanceof NotesError) return Response.json({ error: error.message, ...(error.detail ?? {}) }, { status: error.status });
	const message = error instanceof Error ? error.message : String(error);
	return Response.json({ error: `Notes error: ${message}` }, { status: 500 });
}

function str(v: unknown): string | null {
	return typeof v === "string" ? v : null;
}

/** A chat id that exists, or null — notes record only real sessions. */
function knownChat(v: unknown): string | null {
	const id = str(v);
	if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
	return stores.chatStore.getChat(id) ? id : null;
}

async function json(req: Request): Promise<Record<string, unknown>> {
	try {
		const body = (await req.json()) as unknown;
		return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

export function notesTreeResponse(): Response {
	try {
		const tree = notesStore.tree();
		// Cloud server (Phase 4): the drawer shows when Obsidian sync has stopped,
		// and names the vault as Obsidian does (the server's folder is just
		// "vault"; obsidian:// links address the vault by its Obsidian name).
		if (serverModeEnabled()) {
			const manager = obsidianSync();
			const sync = manager.notesSync();
			if (sync) tree.status.sync = sync;
			const name = manager.vaultName();
			if (name && tree.status.configured) tree.status.vaultName = name;
		}
		return Response.json(tree, { headers: { "Cache-Control": "no-store" } });
	} catch (e) {
		return fail(e);
	}
}

export async function notesActionResponse(req: Request): Promise<Response> {
	const b = await json(req);
	try {
		switch (b.action) {
			case "vault": {
				// On the cloud server the vault folder is fixed and set by Settings → Obsidian.
				if (serverModeEnabled()) return Response.json({ error: "Connect your Obsidian vault in Settings." }, { status: 403 });
				const p = str(b.path);
				if (!p) return Response.json({ error: "Enter the full path to your vault folder." }, { status: 400 });
				return Response.json({ status: notesStore.setVault(p) });
			}
			case "create":
				return Response.json(notesStore.create(str(b.folder) ?? "", str(b.title) ?? "", knownChat(b.chatId)));
			case "folder":
				return Response.json(notesStore.createFolder(str(b.parent) ?? "", str(b.name) ?? ""));
			case "move":
				return Response.json(notesStore.move(str(b.from) ?? "", str(b.to) ?? ""));
			case "split": {
				const raw = Array.isArray(b.choices) ? b.choices : [];
				const choices = raw.flatMap((c) =>
					c && typeof c === "object" && typeof (c as { index?: unknown }).index === "number" && typeof (c as { title?: unknown }).title === "string"
						? [{ index: (c as { index: number }).index, title: (c as { title: string }).title }]
						: [],
				);
				return Response.json(notesStore.split(str(b.path) ?? "", choices, knownChat(b.chatId)));
			}
			case "merge":
				return Response.json(notesStore.merge(str(b.path) ?? ""));
			case "extract":
				return Response.json(
					notesStore.extract(str(b.path) ?? "", Number(b.start), Number(b.end), str(b.title) ?? "", knownChat(b.chatId)),
				);
			case "undo":
				return Response.json(notesStore.undo(str(b.opId) ?? ""));
			default:
				return Response.json({ error: "Unknown notes action" }, { status: 400 });
		}
	} catch (e) {
		return fail(e);
	}
}

export function noteReadResponse(req: Request): Response {
	const p = new URL(req.url).searchParams.get("path") ?? "";
	try {
		return Response.json(notesStore.read(p), { headers: { "Cache-Control": "no-store" } });
	} catch (e) {
		return fail(e);
	}
}

export async function noteSaveResponse(req: Request): Promise<Response> {
	const b = await json(req);
	const p = str(b.path);
	const body = str(b.body);
	if (!p || body === null) return Response.json({ error: "path and body are required" }, { status: 400 });
	if (body.length > 2_000_000) return Response.json({ error: "That note is too large to save." }, { status: 413 });
	try {
		const result = notesStore.save(p, body, str(b.baseHash), knownChat(b.chatId));
		if (!result.ok) return Response.json({ error: "This note changed outside the drawer.", conflict: result.conflict }, { status: 409 });
		return Response.json(result);
	} catch (e) {
		return fail(e);
	}
}

export async function noteAttachmentResponse(req: Request): Promise<Response> {
	const b = await json(req);
	const data = str(b.data);
	const notePath = str(b.notePath);
	const ext = str(b.ext);
	if (!data || !notePath || !ext) return Response.json({ error: "notePath, ext and data are required" }, { status: 400 });
	try {
		return Response.json(notesStore.saveAttachment(notePath, Buffer.from(data, "base64"), ext));
	} catch (e) {
		return fail(e);
	}
}

export function noteAssetResponse(req: Request): Response {
	const q = new URL(req.url).searchParams;
	try {
		const hit = notesStore.asset(q.get("target") ?? "", q.get("from") ?? "");
		if (!hit) return new Response("Not found", { status: 404 });
		return new Response(new Uint8Array(hit.bytes), {
			headers: {
				"Content-Type": hit.mime,
				"Cache-Control": "no-store",
				// SVGs render as images only — never as a document with scripts.
				"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
				"X-Content-Type-Options": "nosniff",
			},
		});
	} catch (e) {
		return fail(e);
	}
}

export function noteHomeResponse(chatId: string): Response {
	if (!stores.chatStore.getChat(chatId)) return Response.json({ error: "Unknown chat" }, { status: 404 });
	try {
		return Response.json({ homeFolder: notesStore.getHome(chatId) });
	} catch (e) {
		return fail(e);
	}
}

export async function noteSetHomeResponse(chatId: string, req: Request): Promise<Response> {
	if (!stores.chatStore.getChat(chatId)) return Response.json({ error: "Unknown chat" }, { status: 404 });
	const b = await json(req);
	const folder = b.homeFolder === null ? null : str(b.homeFolder);
	try {
		notesStore.setHome(chatId, folder);
		return Response.json({ homeFolder: folder });
	} catch (e) {
		return fail(e);
	}
}

/** Session deletion hook: the notes stay, the home-folder bookkeeping goes. */
export function discardSessionNotes(chatId: string): void {
	try {
		notesStore.discardSession(chatId);
	} catch {
		/* never blocks a delete */
	}
}
