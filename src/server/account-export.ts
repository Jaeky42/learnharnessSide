/**
 * "Download my data" (multi-account slice 5c; docs/multi-account-plan.md,
 * "In each person's Settings → Account"): one .zip of this copy's data
 * folder, in the folder's own layout, so it can be put into a desktop app's
 * data folder.
 *
 * Only the listed parts go in (an allow-list, the parts the before-first-sync
 * backup keeps, src/store/sync/backup.ts, minus Flashcards sync's own files
 * under sync/). Never sync/, backups/, the sign-ins and keys (they live
 * beside the data folder), the Obsidian vault, the notes settings and
 * pending edits. Symbolic links are skipped, files that are still being
 * written by the app are read as they are at that moment.
 *
 * 404 unless this copy stands behind a gateway: the desktop app and a
 * single-copy server get no new endpoint.
 */

import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { nameShapeProblem } from "../core/accounts.ts";
import { behindGateway } from "./server-auth.ts";
import { ZIP_LIMITS, zipStream, type ZipSource } from "./zip-writer.ts";

/** What goes in, relative to the data folder. Everything else stays out. */
export const EXPORT_PARTS: readonly string[] = [
	"chats",
	"graph",
	"jobs",
	"settings.json",
	"prompts",
	"themes",
	"notes/sessions",
	"plugins-state.json",
	"core-plugin-data",
];

/** A temporary file the atomic writers leave beside a target (src/store/atomic-write.ts). */
const TEMP_MARKER = ".tmp-";

export interface ExportList { files: ZipSource[]; bytes: number }

/** The files to send: the allowed parts, no links, sorted so the archive is the same each time. */
export async function listExportFiles(dataDir: string): Promise<ExportList> {
	const files: ZipSource[] = [];
	let bytes = 0;
	const visit = async (full: string, name: string): Promise<void> => {
		let info: fs.Stats;
		try { info = await fs.promises.lstat(/* turbopackIgnore: true */ full); } catch { return; }
		if (info.isSymbolicLink()) return;
		if (info.isFile()) {
			if (path.basename(full).includes(TEMP_MARKER)) return;
			files.push({ name, path: full });
			bytes += info.size;
			return;
		}
		if (!info.isDirectory()) return;
		let entries: string[];
		try { entries = await fs.promises.readdir(/* turbopackIgnore: true */ full); } catch { return; }
		for (const entry of entries.sort()) await visit(path.join(/* turbopackIgnore: true */ full, entry), `${name}/${entry}`);
	};
	for (const part of EXPORT_PARTS) await visit(path.join(/* turbopackIgnore: true */ dataDir, ...part.split("/")), part);
	return { files, bytes };
}

/** `learnharness-<name>-<date>.zip`; the name only when it has an account name's shape. */
export function exportFileName(name: string | null, now: Date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
	const safe = name !== null && nameShapeProblem(name) !== "not-allowed";
	return safe ? `learnharness-${name}-${date}.zip` : `learnharness-${date}.zip`;
}

const GENERIC = "Something went wrong. Try again.";
const json = (body: object, status: number) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** One export at a time in this process (it reads the whole data folder). A lock older than an hour is ignored. */
let running: number | null = null;
const LOCK_MAX_MS = 60 * 60 * 1000;
/** For tests: forget an export that was never read to its end. */
export function resetExportLock(): void { running = null; }

export async function accountExportResponse(request: Request, options: { dataDir?: string; now?: Date } = {}): Promise<Response> {
	if (!behindGateway()) return new Response("Not found", { status: 404 });
	const now = options.now ?? new Date();
	if (running !== null && now.getTime() - running < LOCK_MAX_MS) return json({ error: GENERIC }, 429);
	running = now.getTime();
	let handedOn = false;
	try {
		const list = await listExportFiles(options.dataDir ?? PATHS.data);
		if (list.files.length > ZIP_LIMITS.maxFiles || list.bytes > ZIP_LIMITS.maxBytes) return json({ error: GENERIC }, 413);
		const stamp = running;
		const body = zipStream(list.files, () => { if (running === stamp) running = null; });
		handedOn = true;
		const name = new URL(request.url).searchParams.get("name");
		return new Response(body, {
			status: 200,
			headers: {
				"content-type": "application/zip",
				"content-disposition": `attachment; filename="${exportFileName(name, now)}"`,
				"cache-control": "no-store",
			},
		});
	} catch {
		return json({ error: GENERIC }, 500);
	} finally {
		if (!handedOn) running = null;
	}
}
