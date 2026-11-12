/**
 * Cloud sync (Phase 5): the pictures in a session are sent once, not with
 * every send of the session (approved with the plan).
 *
 * A session's pictures live inside its chat file, in two kinds of place:
 *
 *   imageSnapshots      the record's processed pictures, each named by the
 *                       SHA-256 of its bytes
 *   inside messages     (upstream 0.6.0) a picture the learner attached or
 *                       a tool returned is an image block in the message
 *                       itself: { type: "image", mimeType, data: <base64> }.
 *                       It has no name; it is given the same kind of name,
 *                       the SHA-256 of its bytes.
 *
 * On the wire the chat travels WITHOUT them, with a list of which pictures
 * belong where; a picture the other side doesn't have yet is fetched or
 * sent on its own, once. The receiver puts the file back together exactly,
 * byte for byte.
 *
 * That is only possible for a chat file in the app's own formatting (which
 * is every file the app wrote). Anything else travels whole, as before.
 */

import { createHash } from "node:crypto";

/** One picture inside the record: the keys and indexes that lead to its image block, and its id. */
export type InlinePicture = [Array<string | number>, string];

/** Where the pictures sit in the chat record, and each one's details without its bytes. */
export interface PictureList {
	/** The position of `imageSnapshots` among the record's keys; -1 when the record has none. */
	at: number;
	/** [picture id, the snapshot with `data` emptied], in the record's order. */
	list: Array<[string, Record<string, unknown>]>;
	/** The pictures inside messages, each block's `data` emptied in the chat that travels. */
	inline: InlinePicture[];
}

export const PICTURE_ID = /^[a-f0-9]{64}$/;
const MAX_PICTURES = 5000;
/** Image blocks inside messages; the same picture may sit in several. */
const MAX_INLINE = 20_000;
const MAX_PATH = 64;
/** An image block smaller than this stays in the chat: a request of its own would cost more than it saves. */
export const MIN_INLINE_CHARS = 1024;
/** A picture goes up in pieces of at most this many base64 characters. */
export const PICTURE_PART_CHARS = 8 * 1024 * 1024;
/** Above any real picture (the app refuses images over 25 MiB). */
export const MAX_PICTURE_CHARS = 48 * 1024 * 1024;

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const format = (record: unknown): string => JSON.stringify(record, null, "\t");
const IMAGE_BLOCK = /"type"\s*:\s*"image"/;
const mayHavePictures = (chat: string): boolean => chat.includes('"imageSnapshots"') || IMAGE_BLOCK.test(chat);

const idOf = (data: string): string => createHash("sha256").update(Buffer.from(data, "base64")).digest("hex");

/**
 * The bytes match the name, and the text is the one base64 spelling of
 * those bytes: two spellings of the same bytes would share a name, and the
 * file put back together on the other side would not be the same text.
 */
export function pictureMatches(id: string, data: string): boolean {
	return PICTURE_ID.test(id) && Buffer.from(data, "base64").toString("base64") === data && idOf(data) === id;
}

/** An image block inside a message whose bytes can travel on their own. */
function isInlineImage(value: Record<string, unknown>): value is Record<string, unknown> & { data: string } {
	return value.type === "image" && typeof value.mimeType === "string" && typeof value.data === "string" && value.data.length >= MIN_INLINE_CHARS;
}

/**
 * Every image block inside the record (outside imageSnapshots) whose text
 * is canonical base64, with where it sits. `visit` sees each one.
 */
function eachInline(record: Record<string, unknown>, visit: (path: Array<string | number>, block: Record<string, unknown> & { data: string }) => void): void {
	const walk = (value: unknown, path: Array<string | number>): void => {
		if (path.length > MAX_PATH) return;
		if (Array.isArray(value)) {
			value.forEach((item, index) => walk(item, [...path, index]));
			return;
		}
		if (!isObject(value)) return;
		if (isInlineImage(value) && Buffer.from(value.data, "base64").toString("base64") === value.data) {
			visit(path, value);
			return;
		}
		for (const [key, item] of Object.entries(value)) walk(item, [...path, key]);
	};
	for (const [key, value] of Object.entries(record)) if (key !== "imageSnapshots") walk(value, [key]);
}

/** The pictures in a chat file, id → base64 bytes. Empty when there are none or the file can't be read. */
export function picturesIn(chat: string | null | undefined): Map<string, string> {
	const out = new Map<string, string>();
	if (!chat || !mayHavePictures(chat)) return out;
	try {
		const record: unknown = JSON.parse(chat);
		if (!isObject(record)) return out;
		if (isObject(record.imageSnapshots)) {
			for (const [id, snapshot] of Object.entries(record.imageSnapshots)) {
				if (PICTURE_ID.test(id) && isObject(snapshot) && typeof snapshot.data === "string") out.set(id, snapshot.data);
			}
		}
		eachInline(record, (_path, block) => {
			const id = idOf(block.data);
			if (!out.has(id)) out.set(id, block.data);
		});
	} catch { /* not a chat file this build can take apart */ }
	return out;
}

/** Every picture a list names, once each. */
export function pictureIds(pictures: PictureList): string[] {
	return [...new Set([...pictures.list.map(([id]) => id), ...pictures.inline.map(([, id]) => id)])];
}

/**
 * The chat file without its pictures, or null when it has none or can't be
 * put back together exactly (then it travels whole).
 */
export function withoutPictures(chat: string): { chat: string; pictures: PictureList; data: Map<string, string> } | null {
	if (!mayHavePictures(chat)) return null;
	let record: unknown;
	try { record = JSON.parse(chat); } catch { return null; }
	if (!isObject(record) || format(record) !== chat) return null;
	const list: PictureList["list"] = [];
	const data = new Map<string, string>();
	const hasSnapshots = Object.hasOwn(record, "imageSnapshots");
	if (hasSnapshots) {
		if (!isObject(record.imageSnapshots)) return null;
		for (const [id, snapshot] of Object.entries(record.imageSnapshots)) {
			// A snapshot whose bytes don't match its name couldn't be checked on arrival.
			if (!isObject(snapshot) || typeof snapshot.data !== "string" || !pictureMatches(id, snapshot.data)) return null;
			list.push([id, { ...snapshot, data: "" }]);
			data.set(id, snapshot.data);
		}
	}
	const inline: InlinePicture[] = [];
	eachInline(record, (path, block) => {
		const id = idOf(block.data);
		if (!data.has(id)) data.set(id, block.data);
		inline.push([path, id]);
		// The record was parsed for this call alone: emptying the block here is safe.
		block.data = "";
	});
	if (list.length === 0 && inline.length === 0) return null;
	if (data.size > MAX_PICTURES || inline.length > MAX_INLINE) return null;
	const at = hasSnapshots ? Object.keys(record).indexOf("imageSnapshots") : -1;
	const { imageSnapshots: _pictures, ...rest } = record;
	const slim = { chat: format(rest), pictures: { at, list, inline }, data };
	// Proof that the other side can rebuild this exact file.
	let back: ReturnType<typeof withPictures>;
	try { back = withPictures(slim.chat, slim.pictures, (id) => data.get(id) ?? null); } catch { return null; }
	return "text" in back && back.text === chat ? slim : null;
}

/** The image block at `path`, or null when the path doesn't lead to an emptied one. */
function blockAt(record: Record<string, unknown>, path: ReadonlyArray<string | number>): Record<string, unknown> | null {
	let at: unknown = record;
	for (const step of path) {
		if (Array.isArray(at)) {
			if (typeof step !== "number" || step >= at.length) return null;
			at = at[step];
		} else if (isObject(at)) {
			if (typeof step !== "string" || !Object.hasOwn(at, step)) return null;
			at = at[step];
		} else return null;
	}
	return isObject(at) && at.type === "image" && at.data === "" ? at : null;
}

/**
 * The chat file put back together, or the pictures still needed for it.
 * Throws when the list doesn't fit the chat (it can't be trusted).
 */
export function withPictures(chat: string, pictures: PictureList, get: (id: string) => string | null): { text: string } | { missing: string[] } {
	const record = JSON.parse(chat) as Record<string, unknown>;
	if (!isObject(record) || (pictures.at >= 0 && Object.hasOwn(record, "imageSnapshots"))) throw new Error("The picture list doesn't fit this chat.");
	const missing = new Set<string>();
	const snapshots: Record<string, unknown> = {};
	for (const [id, details] of pictures.list) {
		const data = get(id);
		if (data === null) missing.add(id); else snapshots[id] = { ...details, data };
	}
	// Find every block first: a path that leads nowhere is a bad list, whatever is missing.
	const blocks = pictures.inline.map(([path, id]) => {
		const block = blockAt(record, path);
		if (!block) throw new Error("The picture list doesn't fit this chat.");
		return [block, id] as const;
	});
	for (const [block, id] of blocks) {
		const data = get(id);
		if (data === null) missing.add(id); else block.data = data;
	}
	if (missing.size > 0) return { missing: [...missing] };
	const entries = Object.entries(record);
	if (pictures.at >= 0) entries.splice(Math.min(pictures.at, entries.length), 0, ["imageSnapshots", snapshots]);
	return { text: format(Object.fromEntries(entries)) };
}

const isPathStep = (step: unknown): step is string | number =>
	(typeof step === "number" && Number.isInteger(step) && step >= 0) || (typeof step === "string" && step.length > 0 && step.length <= 256);

/** A picture list received from the other side, or null when it can't be trusted. */
export function checkPictureList(value: unknown): PictureList | null {
	if (!isObject(value) || typeof value.at !== "number" || !Number.isInteger(value.at) || value.at < -1 || !Array.isArray(value.list) || !Array.isArray(value.inline)) return null;
	if (value.list.length > MAX_PICTURES || value.inline.length > MAX_INLINE || (value.list.length === 0 && value.inline.length === 0)) return null;
	if (value.at === -1 && value.list.length > 0) return null;
	const seen = new Set<string>();
	for (const item of value.list) {
		if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string" || !PICTURE_ID.test(item[0]) || seen.has(item[0])) return null;
		if (!isObject(item[1]) || item[1].data !== "") return null;
		seen.add(item[0]);
	}
	for (const item of value.inline) {
		if (!Array.isArray(item) || item.length !== 2 || typeof item[1] !== "string" || !PICTURE_ID.test(item[1])) return null;
		const path: unknown = item[0];
		if (!Array.isArray(path) || path.length === 0 || path.length > MAX_PATH || !path.every(isPathStep)) return null;
		seen.add(item[1]);
	}
	if (seen.size > MAX_PICTURES) return null;
	return { at: value.at, list: value.list as PictureList["list"], inline: value.inline as InlinePicture[] };
}
