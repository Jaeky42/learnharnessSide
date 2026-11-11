/**
 * Cloud sync (Phase 5): a desktop's side of "pictures are sent once"
 * (core/sync/pictures.ts). It wraps the one function every sync request
 * goes through, so the rest of the desktop's sync code still sees whole
 * session files:
 *
 *   fetching a session   the chat arrives without its pictures; the ones
 *                        not already in this desktop's copy are fetched
 *                        one by one, and the file is put back together
 *   sending a session    the chat goes without its pictures; if the server
 *                        says which ones it lacks, those are sent (a big
 *                        one in pieces) and the session is sent again
 */

import { checkPictureList, PICTURE_PART_CHARS, pictureMatches, picturesIn, withoutPictures, withPictures } from "../../core/sync/pictures.ts";
import type { SessionBundle } from "../../core/sync/sessions.ts";
import type { SessionFiles } from "../../store/sync/session-files.ts";
import type { SyncReply } from "./client.ts";
import type { SyncRequester } from "./desktop-sync.ts";

const SESSION = /^\/api\/sync\/sessions\/([A-Za-z0-9_-]+)$/;
const broken = <T>(error: string): SyncReply<T> => ({ ok: false, reason: "refused", status: 502, code: null, error, body: {} });

export function picturesOnce(request: SyncRequester, files: Pick<SessionFiles, "read">): SyncRequester {
	return async <T = Record<string, unknown>>(pathname: string, init: Parameters<SyncRequester>[1] = {}): Promise<SyncReply<T>> => {
		const match = SESSION.exec(pathname);
		const method = init.method ?? "GET";
		if (!match || (method !== "GET" && method !== "PUT")) return request<T>(pathname, init);
		const chatId = match[1]!;

		if (method === "GET") {
			const reply = await request<{ bundle?: { chat?: unknown; pictures?: unknown } }>(pathname, init);
			if (!reply.ok || !reply.body.bundle || reply.body.bundle.pictures === undefined) return reply as SyncReply<T>;
			const pictures = checkPictureList(reply.body.bundle.pictures);
			if (!pictures || typeof reply.body.bundle.chat !== "string") return broken("The session's files didn't arrive whole.");
			const here = picturesIn(files.read(chatId)?.chat);
			const fetched = new Map<string, string>();
			for (const [id] of pictures.list) {
				if (here.has(id)) continue;
				const picture = await request<{ data?: unknown }>(`${pathname}/pictures/${id}`);
				if (!picture.ok) return picture as SyncReply<T>;
				if (typeof picture.body.data !== "string" || !pictureMatches(id, picture.body.data)) return broken("A picture didn't arrive whole.");
				fetched.set(id, picture.body.data);
			}
			let joined: ReturnType<typeof withPictures>;
			try { joined = withPictures(reply.body.bundle.chat, pictures, (id) => here.get(id) ?? fetched.get(id) ?? null); }
			catch { return broken("The session's files didn't arrive whole."); }
			if ("missing" in joined) return broken("The session's files didn't arrive whole.");
			const { pictures: _list, ...rest } = reply.body.bundle;
			return { ok: true, body: { ...reply.body, bundle: { ...rest, chat: joined.text } } as T };
		}

		const body = init.body as { bundle?: SessionBundle } | undefined;
		const slim = body?.bundle ? withoutPictures(body.bundle.chat) : null;
		if (!body || !slim) return request<T>(pathname, init);
		const sending = { ...init, body: { ...body, bundle: { ...body.bundle, chat: slim.chat, pictures: slim.pictures } } };
		const reply = await request<T>(pathname, sending);
		if (reply.ok || reply.reason !== "refused" || reply.code !== "pictures_needed") return reply;
		const ids = Array.isArray(reply.body.ids) ? reply.body.ids.filter((id): id is string => typeof id === "string") : [];
		for (const id of ids) {
			const data = slim.data.get(id);
			if (data === undefined) return reply;
			const of = Math.max(1, Math.ceil(data.length / PICTURE_PART_CHARS));
			for (let part = 0; part < of; part++) {
				const sent = await request(`${pathname}/pictures/${id}`, { method: "PUT", body: { part, of, data: data.slice(part * PICTURE_PART_CHARS, (part + 1) * PICTURE_PART_CHARS) } });
				if (!sent.ok) return sent as SyncReply<T>;
			}
		}
		return request<T>(pathname, sending);
	};
}
