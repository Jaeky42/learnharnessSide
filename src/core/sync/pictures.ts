/**
 * Cloud sync (Phase 5): the pictures in a session are sent once, not with
 * every send of the session (approved with the plan).
 *
 * A session's pictures live inside its chat file (`imageSnapshots`, each
 * named by the SHA-256 of its bytes). On the wire the chat travels WITHOUT
 * them, with a list of which pictures belong where; a picture the other
 * side doesn't have yet is fetched or sent on its own, once. The receiver
 * puts the file back together exactly, byte for byte.
 *
 * That is only possible for a chat file in the app's own formatting (which
 * is every file the app wrote). Anything else travels whole, as before.
 */

import { createHash } from "node:crypto";

/** Where the pictures sit in the chat record, and each one's details without its bytes. */
export interface PictureList {
	/** The position of `imageSnapshots` among the record's keys. */
	at: number;
	/** [picture id, the snapshot with `data` emptied], in the record's order. */
	list: Array<[string, Record<string, unknown>]>;
}

export const PICTURE_ID = /^[a-f0-9]{64}$/;
const MAX_PICTURES = 5000;
/** A picture goes up in pieces of at most this many base64 characters. */
export const PICTURE_PART_CHARS = 8 * 1024 * 1024;
/** Above any real picture (the app refuses images over 25 MiB). */
export const MAX_PICTURE_CHARS = 48 * 1024 * 1024;

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const format = (record: unknown): string => JSON.stringify(record, null, "\t");

export function pictureMatches(id: string, data: string): boolean {
	return PICTURE_ID.test(id) && createHash("sha256").update(Buffer.from(data, "base64")).digest("hex") === id;
}

/** The pictures in a chat file, id → base64 bytes. Empty when there are none or the file can't be read. */
export function picturesIn(chat: string | null | undefined): Map<string, string> {
	const out = new Map<string, string>();
	if (!chat || !chat.includes('"imageSnapshots"')) return out;
	try {
		const record: unknown = JSON.parse(chat);
		if (isObject(record) && isObject(record.imageSnapshots)) {
			for (const [id, snapshot] of Object.entries(record.imageSnapshots)) {
				if (PICTURE_ID.test(id) && isObject(snapshot) && typeof snapshot.data === "string") out.set(id, snapshot.data);
			}
		}
	} catch { /* not a chat file this build can take apart */ }
	return out;
}

/**
 * The chat file without its pictures, or null when it has none or can't be
 * put back together exactly (then it travels whole).
 */
export function withoutPictures(chat: string): { chat: string; pictures: PictureList; data: Map<string, string> } | null {
	if (!chat.includes('"imageSnapshots"')) return null;
	let record: unknown;
	try { record = JSON.parse(chat); } catch { return null; }
	if (!isObject(record) || !isObject(record.imageSnapshots) || format(record) !== chat) return null;
	const list: PictureList["list"] = [];
	const data = new Map<string, string>();
	for (const [id, snapshot] of Object.entries(record.imageSnapshots)) {
		if (!PICTURE_ID.test(id) || !isObject(snapshot) || typeof snapshot.data !== "string") return null;
		list.push([id, { ...snapshot, data: "" }]);
		data.set(id, snapshot.data);
	}
	if (list.length === 0 || list.length > MAX_PICTURES) return null;
	const at = Object.keys(record).indexOf("imageSnapshots");
	const { imageSnapshots: _pictures, ...rest } = record;
	const slim = { chat: format(rest), pictures: { at, list }, data };
	// Proof that the other side can rebuild this exact file.
	const back = withPictures(slim.chat, slim.pictures, (id) => data.get(id) ?? null);
	return "text" in back && back.text === chat ? slim : null;
}

/** The chat file put back together, or the pictures still needed for it. */
export function withPictures(chat: string, pictures: PictureList, get: (id: string) => string | null): { text: string } | { missing: string[] } {
	const record = JSON.parse(chat) as Record<string, unknown>;
	const snapshots: Record<string, unknown> = {};
	const missing: string[] = [];
	for (const [id, details] of pictures.list) {
		const data = get(id);
		if (data === null) missing.push(id); else snapshots[id] = { ...details, data };
	}
	if (missing.length > 0) return { missing };
	const entries = Object.entries(record);
	entries.splice(Math.min(pictures.at, entries.length), 0, ["imageSnapshots", snapshots]);
	return { text: format(Object.fromEntries(entries)) };
}

/** A picture list received from the other side, or null when it can't be trusted. */
export function checkPictureList(value: unknown): PictureList | null {
	if (!isObject(value) || typeof value.at !== "number" || !Number.isInteger(value.at) || value.at < 0 || !Array.isArray(value.list)) return null;
	if (value.list.length === 0 || value.list.length > MAX_PICTURES) return null;
	const seen = new Set<string>();
	for (const item of value.list) {
		if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string" || !PICTURE_ID.test(item[0]) || seen.has(item[0])) return null;
		if (!isObject(item[1]) || item[1].data !== "") return null;
		seen.add(item[0]);
	}
	return { at: value.at, list: value.list as PictureList["list"] };
}
