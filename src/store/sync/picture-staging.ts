/**
 * Cloud sync (Phase 5): pictures a desktop has sent ahead of the session
 * they belong to, kept under <data>/sync/pictures/<chatId>/ until that
 * session's files arrive and take them in. A big picture arrives in pieces.
 */

import fs from "node:fs";
import path from "node:path";
import { MAX_PICTURE_CHARS, pictureMatches, PICTURE_ID } from "../../core/sync/pictures.ts";
import { isSessionId } from "../../core/sync/sessions.ts";

/** One session's waiting pictures may not take more than this (base64 characters). */
const MAX_WAITING_CHARS = 512 * 1024 * 1024;

export interface PictureStaging {
	/** Add one piece. "done" when the picture is whole and its bytes match its name. */
	add(chatId: string, id: string, part: number, of: number, data: string): "more" | "done" | "bad" | "full";
	get(chatId: string, id: string): string | null;
	clear(chatId: string): void;
}

export function pictureStaging(syncDir: string): PictureStaging {
	const dirOf = (chatId: string) => path.join(/* turbopackIgnore: true */ syncDir, "pictures", chatId);
	const fileOf = (chatId: string, id: string, partial = false) => path.join(/* turbopackIgnore: true */ dirOf(chatId), partial ? `${id}.part` : id);
	const sizeOf = (file: string): number => { try { return fs.statSync(/* turbopackIgnore: true */ file).size; } catch { return 0; } };
	function waiting(chatId: string): number {
		try {
			return fs.readdirSync(/* turbopackIgnore: true */ dirOf(chatId)).reduce((sum, name) => sum + sizeOf(path.join(/* turbopackIgnore: true */ dirOf(chatId), name)), 0);
		} catch {
			return 0;
		}
	}
	return {
		add(chatId, id, part, of, data) {
			if (!isSessionId(chatId) || !PICTURE_ID.test(id) || !Number.isInteger(part) || !Number.isInteger(of) || part < 0 || of < 1 || part >= of || of > 64) return "bad";
			if (!/^[A-Za-z0-9+/=]*$/.test(data)) return "bad";
			const partial = fileOf(chatId, id, true);
			if (part > 0 && sizeOf(partial) === 0) return "bad"; // pieces come in order, from the first
			if (sizeOf(partial) + data.length > MAX_PICTURE_CHARS) { fs.rmSync(/* turbopackIgnore: true */ partial, { force: true }); return "bad"; }
			if (waiting(chatId) + data.length > MAX_WAITING_CHARS) return "full";
			fs.mkdirSync(/* turbopackIgnore: true */ dirOf(chatId), { recursive: true });
			if (part === 0) fs.writeFileSync(/* turbopackIgnore: true */ partial, data, "utf-8");
			else fs.appendFileSync(/* turbopackIgnore: true */ partial, data, "utf-8");
			if (part < of - 1) return "more";
			const whole = fs.readFileSync(/* turbopackIgnore: true */ partial, "utf-8");
			if (!pictureMatches(id, whole)) { fs.rmSync(/* turbopackIgnore: true */ partial, { force: true }); return "bad"; }
			fs.renameSync(/* turbopackIgnore: true */ partial, fileOf(chatId, id));
			return "done";
		},
		get(chatId, id) {
			if (!isSessionId(chatId) || !PICTURE_ID.test(id)) return null;
			try { return fs.readFileSync(/* turbopackIgnore: true */ fileOf(chatId, id), "utf-8"); } catch { return null; }
		},
		clear(chatId) {
			if (isSessionId(chatId)) fs.rmSync(/* turbopackIgnore: true */ dirOf(chatId), { recursive: true, force: true });
		},
	};
}
