/**
 * Notes adapter: the learner's notes as Markdown files in their Obsidian
 * vault (`<vault>/LearnHarness/…`), plus the drawer's own bookkeeping under
 * `<data>/notes/`:
 *   settings.json          { version, vaultPath }
 *   sessions/<chatId>.json { homeFolder }  — the session's home folder
 *   pending/<key>.json     edits waiting for an unavailable vault
 *
 * Privacy (src/core/notes.ts): nothing here is read by any agent or written
 * into a chat record. The vault file IS the note — Obsidian and the drawer
 * edit the same file.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import {
	addSession,
	attachmentFolderFor,
	computeBacklinks,
	folderOf,
	INBOX_FOLDER,
	isImageName,
	isValidFolderPath,
	isValidName,
	isValidNotePath,
	isWithinFolder,
	joinPath,
	findLinks,
	mergeBodies,
	nameProblem,
	noteBody,
	noteName,
	NOTES_FOLDER,
	parseSections,
	pastedImageName,
	planSplit,
	readNoteMeta,
	relativeHref,
	resolveLink,
	withBody,
	withNoteMeta,
	wikiLink,
	countWords,
	type NotesStatus,
	type NotesTree,
	type NotesTreeNote,
	type SplitChoice,
} from "../core/notes.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

export class NotesError extends Error {
	constructor(readonly status: number, message: string, readonly detail?: Record<string, unknown>) {
		super(message);
	}
}

const SETTINGS_VERSION = 1;
const MAX_NOTES = 5000;
const MAX_DEPTH = 24;
const UNDO_TTL_MS = 30 * 60 * 1000;
const MAX_UNDO = 30;
const MAX_ASSET_BYTES = 25 * 1024 * 1024;

const dirs = {
	root: () => PATHS.notes,
	settings: () => path.join(/* turbopackIgnore: true */ PATHS.notes, "settings.json"),
	sessions: () => path.join(/* turbopackIgnore: true */ PATHS.notes, "sessions"),
	pending: () => path.join(/* turbopackIgnore: true */ PATHS.notes, "pending"),
};

export function hashText(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 24);
}

// ─── Settings ────────────────────────────────────────────────────────────────

interface NotesSettings {
	vaultPath: string | null;
}

function readSettings(): NotesSettings {
	try {
		const raw = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ dirs.settings(), "utf-8")) as { vaultPath?: unknown };
		return { vaultPath: typeof raw.vaultPath === "string" && path.isAbsolute(raw.vaultPath) ? raw.vaultPath : null };
	} catch {
		return { vaultPath: null };
	}
}

function writeSettings(s: NotesSettings): void {
	fs.mkdirSync(/* turbopackIgnore: true */ dirs.root(), { recursive: true });
	writeFileAtomicSync(dirs.settings(), JSON.stringify({ version: SETTINGS_VERSION, vaultPath: s.vaultPath }, null, "\t"), { allowInPlaceFallback: true });
}

function expandHome(p: string): string {
	const home = process.env.USERPROFILE || process.env.HOME || "";
	if (p === "~") return home;
	if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(/* turbopackIgnore: true */ home, p.slice(2));
	return p;
}

function isDir(p: string): boolean {
	try { return fs.statSync(/* turbopackIgnore: true */ p).isDirectory(); } catch { return false; }
}

function notesRootOf(vault: string): string {
	return path.join(/* turbopackIgnore: true */ vault, NOTES_FOLDER);
}

/** The vault's notes folder, created on demand, or null when unavailable. */
function liveRoot(): { vault: string; root: string } | null {
	const { vaultPath } = readSettings();
	if (!vaultPath || !isDir(vaultPath)) return null;
	const root = notesRootOf(vaultPath);
	try { fs.mkdirSync(/* turbopackIgnore: true */ root, { recursive: true }); } catch { return null; }
	return { vault: vaultPath, root };
}

function requireRoot(): { vault: string; root: string } {
	const { vaultPath } = readSettings();
	if (!vaultPath) throw new NotesError(409, "Choose your Obsidian vault folder first.");
	const live = liveRoot();
	if (!live) throw new NotesError(503, "Your vault folder can't be reached right now.", { offline: true });
	return live;
}

function obsidianAttachmentSetting(vault: string): string | null {
	try {
		const app = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ vault, ".obsidian", "app.json"), "utf-8")) as { attachmentFolderPath?: unknown };
		return typeof app.attachmentFolderPath === "string" ? app.attachmentFolderPath : null;
	} catch {
		return null;
	}
}

// ─── Paths ───────────────────────────────────────────────────────────────────

function absNote(root: string, rel: string): string {
	if (!isValidNotePath(rel)) throw new NotesError(400, "Invalid note path.");
	return contained(root, path.join(/* turbopackIgnore: true */ root, ...rel.split("/")));
}

function absFolder(root: string, rel: string): string {
	if (!isValidFolderPath(rel)) throw new NotesError(400, "Invalid folder path.");
	return contained(root, rel ? path.join(/* turbopackIgnore: true */ root, ...rel.split("/")) : root);
}

/** Refuses anything whose nearest existing ancestor resolves (through
 *  symlinks) outside the notes root. */
function contained(root: string, abs: string): string {
	const realRoot = fs.realpathSync.native(/* turbopackIgnore: true */ root);
	let probe = abs;
	while (!fs.existsSync(/* turbopackIgnore: true */ probe)) {
		const up = path.dirname(probe);
		if (up === probe) break;
		probe = up;
	}
	const real = fs.realpathSync.native(/* turbopackIgnore: true */ probe);
	const rel = path.relative(realRoot, real);
	if (rel.startsWith("..") || path.isAbsolute(rel)) throw new NotesError(400, "That path is outside the notes folder.");
	return abs;
}

function relOf(root: string, abs: string): string {
	return path.relative(root, abs).split(path.sep).join("/");
}

// ─── Reading the tree ────────────────────────────────────────────────────────

interface CachedNote {
	mtimeMs: number;
	size: number;
	text: string;
}

interface NotesGlobal {
	__lhNotesCache?: Map<string, CachedNote>;
	__lhNotesUndo?: Map<string, UndoOp>;
}

function cache(): Map<string, CachedNote> {
	const g = globalThis as typeof globalThis & NotesGlobal;
	return (g.__lhNotesCache ??= new Map());
}

function readText(abs: string): string {
	const st = fs.statSync(/* turbopackIgnore: true */ abs);
	const hit = cache().get(abs);
	if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.text;
	const text = fs.readFileSync(/* turbopackIgnore: true */ abs, "utf-8");
	cache().set(abs, { mtimeMs: st.mtimeMs, size: st.size, text });
	return text;
}

interface Scan {
	folders: string[];
	notes: Array<{ path: string; text: string; mtimeMs: number }>;
}

function scan(root: string, hiddenFolder: string | null): Scan {
	const out: Scan = { folders: [], notes: [] };
	const walk = (absDir: string, rel: string, depth: number) => {
		if (depth > MAX_DEPTH || out.notes.length >= MAX_NOTES) return;
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(/* turbopackIgnore: true */ absDir, { withFileTypes: true }); } catch { return; }
		for (const e of entries) {
			if (e.name.startsWith(".")) continue;
			const childRel = joinPath(rel, e.name);
			const childAbs = path.join(/* turbopackIgnore: true */ absDir, e.name);
			if (e.isDirectory()) {
				if (!isValidName(e.name) || childRel === hiddenFolder) continue;
				out.folders.push(childRel);
				walk(childAbs, childRel, depth + 1);
			} else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
				const relPath = `${childRel.slice(0, -3)}.md`;
				if (!isValidNotePath(relPath)) continue;
				try {
					const text = readText(childAbs);
					out.notes.push({ path: relPath, text, mtimeMs: fs.statSync(/* turbopackIgnore: true */ childAbs).mtimeMs });
				} catch { /* unreadable: skip */ }
			}
		}
	};
	walk(root, "", 0);
	out.folders.sort((a, b) => a.localeCompare(b));
	out.notes.sort((a, b) => a.path.localeCompare(b.path));
	return out;
}

function attachmentFolder(vault: string): string {
	return attachmentFolderFor(obsidianAttachmentSetting(vault), `${NOTES_FOLDER}/x.md`);
}

/** The attachments folder as a notes-relative path when it sits inside
 *  LearnHarness/ (it is hidden from the tree), else null. */
function hiddenAttachmentFolder(vault: string): string | null {
	const f = attachmentFolder(vault);
	if (f.startsWith(`${NOTES_FOLDER}/`)) return f.slice(NOTES_FOLDER.length + 1);
	return null;
}

function status(): NotesStatus {
	const { vaultPath } = readSettings();
	const live = vaultPath ? liveRoot() : null;
	return {
		configured: !!vaultPath,
		vaultPath,
		vaultName: vaultPath ? path.basename(vaultPath) : null,
		available: !!live,
		pending: pendingEntries().length,
		attachmentFolder: vaultPath ? attachmentFolder(vaultPath) : `${NOTES_FOLDER}/attachments`,
	};
}

function tree(): NotesTree {
	flushPending();
	const st = status();
	const live = st.available ? liveRoot() : null;
	if (!live) return { status: st, folders: [], notes: [], backlinks: {} };
	const s = scan(live.root, hiddenAttachmentFolder(live.vault));
	const notes: NotesTreeNote[] = s.notes.map((n) => {
		const meta = readNoteMeta(n.text);
		const body = noteBody(n.text);
		return {
			path: n.path,
			name: noteName(n.path),
			sessions: meta.sessions,
			parent: meta.parent,
			words: countWords(body),
			sections: parseSections(body).sections.length,
			mtimeMs: n.mtimeMs,
		};
	});
	const backlinks = computeBacklinks(s.notes.map((n) => ({ path: n.path, body: noteBody(n.text) })));
	return { status: st, folders: s.folders, notes, backlinks };
}

// ─── Pending edits (vault unavailable) ───────────────────────────────────────

interface PendingEntry {
	path: string;
	body: string;
	baseHash: string | null;
	chatId: string | null;
	savedAt: string;
}

function pendingFile(rel: string): string {
	return path.join(/* turbopackIgnore: true */ dirs.pending(), `${createHash("sha256").update(rel).digest("hex").slice(0, 32)}.json`);
}

function pendingEntries(): PendingEntry[] {
	let names: string[];
	try { names = fs.readdirSync(/* turbopackIgnore: true */ dirs.pending()); } catch { return []; }
	const out: PendingEntry[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		try {
			const e = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ dirs.pending(), name), "utf-8")) as PendingEntry;
			if (typeof e.path === "string" && typeof e.body === "string" && isValidNotePath(e.path)) out.push(e);
		} catch { /* corrupt: ignore */ }
	}
	return out;
}

function readPending(rel: string): PendingEntry | null {
	try {
		const e = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ pendingFile(rel), "utf-8")) as PendingEntry;
		return e.path === rel ? e : null;
	} catch {
		return null;
	}
}

function writePending(entry: PendingEntry): void {
	fs.mkdirSync(/* turbopackIgnore: true */ dirs.pending(), { recursive: true });
	writeFileAtomicSync(pendingFile(entry.path), JSON.stringify(entry, null, "\t"), { allowInPlaceFallback: true });
}

function uniqueNotePath(root: string, folder: string, base: string): string {
	let candidate = joinPath(folder, `${base}.md`);
	for (let n = 2; fs.existsSync(/* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ root, ...candidate.split("/"))); n++) candidate = joinPath(folder, `${base} ${n}.md`);
	return candidate;
}

/** Writes every waiting edit once the vault is back. A note that changed
 *  meanwhile (in Obsidian on another device, say) is never overwritten:
 *  the offline version lands beside it as "<name> (offline copy).md". */
function flushPending(): number {
	const entries = pendingEntries();
	if (!entries.length) return 0;
	const live = liveRoot();
	if (!live) return 0;
	let written = 0;
	for (const e of entries) {
		try {
			const abs = absNote(live.root, e.path);
			let target = e.path;
			let current: string | null = null;
			if (fs.existsSync(/* turbopackIgnore: true */ abs)) current = fs.readFileSync(/* turbopackIgnore: true */ abs, "utf-8");
			if (current !== null && e.baseHash && hashText(current) !== e.baseHash) {
				target = uniqueNotePath(live.root, folderOf(e.path), `${noteName(e.path)} (offline copy)`);
				current = withNoteMeta("", readNoteMeta(current));
			}
			const base = current ?? "";
			const text = withNoteMeta(withBody(base, e.body), addSession(readNoteMeta(base), e.chatId));
			const out = absNote(live.root, target);
			fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(out), { recursive: true });
			writeFileAtomicSync(out, text, { allowInPlaceFallback: true });
			fs.rmSync(/* turbopackIgnore: true */ pendingFile(e.path), { force: true });
			written++;
		} catch { /* keep it for the next attempt */ }
	}
	return written;
}

// ─── Notes ───────────────────────────────────────────────────────────────────

export interface NoteRead {
	path: string;
	body: string;
	hash: string | null;
	pending: boolean;
	sessions: string[];
	parent: string | null;
}

function read(rel: string): NoteRead {
	if (!isValidNotePath(rel)) throw new NotesError(400, "Invalid note path.");
	const live = liveRoot();
	const pending = readPending(rel);
	if (!live) {
		if (!readSettings().vaultPath) throw new NotesError(409, "Choose your Obsidian vault folder first.");
		if (pending) return { path: rel, body: pending.body, hash: pending.baseHash, pending: true, sessions: [], parent: null };
		throw new NotesError(503, "Your vault folder can't be reached right now.", { offline: true });
	}
	flushPending();
	const abs = absNote(live.root, rel);
	if (!fs.existsSync(/* turbopackIgnore: true */ abs)) throw new NotesError(404, "That note no longer exists.");
	const text = fs.readFileSync(/* turbopackIgnore: true */ abs, "utf-8");
	const meta = readNoteMeta(text);
	return { path: rel, body: noteBody(text), hash: hashText(text), pending: false, sessions: meta.sessions, parent: meta.parent };
}

export type SaveResult =
	| { ok: true; hash: string | null; pending: boolean }
	| { ok: false; conflict: { body: string; hash: string } };

/** Saves a BODY (the frontmatter is the store's). `baseHash` is the hash the
 *  editor loaded; a different file on disk is a conflict, never an
 *  overwrite. The session id joins `lh_sessions`. */
function save(rel: string, body: string, baseHash: string | null, chatId: string | null): SaveResult {
	if (!isValidNotePath(rel)) throw new NotesError(400, "Invalid note path.");
	if (!readSettings().vaultPath) throw new NotesError(409, "Choose your Obsidian vault folder first.");
	const live = liveRoot();
	if (!live) {
		const prior = readPending(rel);
		writePending({ path: rel, body, baseHash: prior ? prior.baseHash : baseHash, chatId: chatId ?? prior?.chatId ?? null, savedAt: new Date().toISOString() });
		return { ok: true, hash: baseHash, pending: true };
	}
	flushPending();
	const abs = absNote(live.root, rel);
	const current = fs.existsSync(/* turbopackIgnore: true */ abs) ? fs.readFileSync(/* turbopackIgnore: true */ abs, "utf-8") : null;
	if (current !== null && baseHash && hashText(current) !== baseHash) {
		return { ok: false, conflict: { body: noteBody(current), hash: hashText(current) } };
	}
	const base = current ?? "";
	const text = withNoteMeta(withBody(base, body), addSession(readNoteMeta(base), chatId));
	if (text !== current) {
		fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(abs), { recursive: true });
		writeFileAtomicSync(abs, text, { allowInPlaceFallback: true });
	}
	return { ok: true, hash: hashText(text), pending: false };
}

function assertName(name: string): void {
	const problem = nameProblem(name);
	if (problem) throw new NotesError(400, problem);
}

function create(folder: string, title: string, chatId: string | null): { path: string } {
	assertName(title);
	const { root } = requireRoot();
	const dir = absFolder(root, folder);
	const rel = joinPath(folder, `${title}.md`);
	const abs = absNote(root, rel);
	if (fs.existsSync(/* turbopackIgnore: true */ abs)) throw new NotesError(409, `A note named "${title}" already exists in this folder.`);
	fs.mkdirSync(/* turbopackIgnore: true */ dir, { recursive: true });
	writeFileAtomicSync(abs, withNoteMeta("", addSession({ sessions: [], parent: null }, chatId)), { allowInPlaceFallback: true });
	return { path: rel };
}

function createFolder(parent: string, name: string): { path: string } {
	assertName(name);
	const { root } = requireRoot();
	const rel = joinPath(parent, name);
	const abs = absFolder(root, rel);
	if (fs.existsSync(/* turbopackIgnore: true */ abs)) throw new NotesError(409, `A folder named "${name}" already exists here.`);
	fs.mkdirSync(/* turbopackIgnore: true */ abs, { recursive: true });
	return { path: rel };
}

// ─── Undo ────────────────────────────────────────────────────────────────────

interface UndoOp {
	at: number;
	/** Files in the order they were changed: content before (null = absent). */
	changes: Array<{ rel: string; before: string | null }>;
	/** Folders the op created (removed on undo when left empty). */
	createdFolders: string[];
}

function undoOps(): Map<string, UndoOp> {
	const g = globalThis as typeof globalThis & NotesGlobal;
	return (g.__lhNotesUndo ??= new Map());
}

class Recorder {
	readonly op: UndoOp = { at: Date.now(), changes: [], createdFolders: [] };
	private seen = new Set<string>();
	constructor(private root: string) {}
	private remember(rel: string) {
		if (this.seen.has(rel)) return;
		this.seen.add(rel);
		const abs = absNote(this.root, rel);
		this.op.changes.push({ rel, before: fs.existsSync(/* turbopackIgnore: true */ abs) ? fs.readFileSync(/* turbopackIgnore: true */ abs, "utf-8") : null });
	}
	write(rel: string, text: string) {
		this.remember(rel);
		const abs = absNote(this.root, rel);
		const dir = path.dirname(abs);
		if (!fs.existsSync(/* turbopackIgnore: true */ dir)) {
			fs.mkdirSync(/* turbopackIgnore: true */ dir, { recursive: true });
			this.op.createdFolders.push(relOf(this.root, dir));
		}
		writeFileAtomicSync(abs, text, { allowInPlaceFallback: true });
	}
	remove(rel: string) {
		this.remember(rel);
		fs.rmSync(/* turbopackIgnore: true */ absNote(this.root, rel), { force: true });
	}
	commit(): string {
		const id = randomUUID();
		const ops = undoOps();
		const now = Date.now();
		for (const [k, v] of ops) if (now - v.at > UNDO_TTL_MS) ops.delete(k);
		while (ops.size >= MAX_UNDO) ops.delete(ops.keys().next().value!);
		ops.set(id, this.op);
		return id;
	}
}

function undo(opId: string): { ok: true } {
	const op = undoOps().get(opId);
	if (!op || Date.now() - op.at > UNDO_TTL_MS) throw new NotesError(410, "That change can no longer be undone.");
	const { root } = requireRoot();
	for (const c of [...op.changes].reverse()) {
		const abs = absNote(root, c.rel);
		if (c.before === null) fs.rmSync(/* turbopackIgnore: true */ abs, { force: true });
		else {
			fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(abs), { recursive: true });
			writeFileAtomicSync(abs, c.before, { allowInPlaceFallback: true });
		}
	}
	for (const f of [...op.createdFolders].sort((a, b) => b.length - a.length)) {
		try { fs.rmdirSync(/* turbopackIgnore: true */ absFolder(root, f)); } catch { /* not empty: keep */ }
	}
	undoOps().delete(opId);
	return { ok: true };
}

// ─── Link maintenance ────────────────────────────────────────────────────────

/** Where an old link target now lives (heading null = the whole note). */
type Relocate = (oldTarget: string, heading: string | null) => { path: string; heading: string | null } | null;

/**
 * Rewrites links after notes moved or were split/merged, so every link the
 * learner wrote still points where it did. `oldPaths` is the world before;
 * `sourceOld` maps a CURRENT note path to the path its body was written at
 * (moved notes, split children). Name-style `[[Name]]` links stay as they
 * are unless the target's name changed — Obsidian resolves them by name.
 * Never adds a link.
 */
function fixLinks(root: string, rec: Recorder, oldPaths: readonly string[], sourceOld: (current: string) => string, relocate: Relocate): void {
	const current = scan(root, null).notes;
	for (const n of current) {
		const from = sourceOld(n.path);
		const body = noteBody(n.text);
		let changed = false;
		const next = (() => {
			let out = body;
			for (const link of findLinks(body).reverse()) {
				if (link.embed) continue;
				const r = resolveLink(link, from, oldPaths);
				if (r.kind !== "note") continue;
				const moved = relocate(r.path, link.heading);
				const dest = moved ?? { path: r.path, heading: link.heading };
				let text: string;
				if (link.kind === "markdown") {
					if (!moved && from === n.path) continue;
					const href = relativeHref(n.path, dest.path) + (dest.heading ? `#${encodeURIComponent(dest.heading)}` : "");
					text = `${link.embed ? "!" : ""}[${link.alias ?? ""}](${href})`;
				} else if (link.target.includes("/")) {
					if (!moved) continue;
					const vaultStyle = link.target.replace(/^\//, "").startsWith(`${NOTES_FOLDER}/`);
					const target = (vaultStyle ? `${NOTES_FOLDER}/` : "") + dest.path.slice(0, -3);
					text = wikiLink(target, dest.heading, link.alias);
				} else {
					if (!moved) continue;
					text = wikiLink(noteName(dest.path), dest.heading, link.alias);
				}
				if (text !== body.slice(link.start, link.end)) {
					out = out.slice(0, link.start) + text + out.slice(link.end);
					changed = true;
				}
			}
			return out;
		})();
		if (changed) rec.write(n.path, withBody(n.text, next));
	}
}

function allNotePaths(root: string): string[] {
	return scan(root, null).notes.map((n) => n.path);
}

// ─── Move ────────────────────────────────────────────────────────────────────

function move(from: string, toFolder: string): { path: string } {
	const { root } = requireRoot();
	const isNote = from.endsWith(".md");
	const srcAbs = isNote ? absNote(root, from) : absFolder(root, from);
	if (!from || !fs.existsSync(/* turbopackIgnore: true */ srcAbs)) throw new NotesError(404, "That item no longer exists.");
	const destDir = absFolder(root, toFolder);
	if (!isDir(destDir)) throw new NotesError(404, "That folder no longer exists.");
	if (!isNote && isWithinFolder(toFolder, from)) throw new NotesError(400, "A folder can't be moved into itself.");
	const base = from.split("/").pop()!;
	const to = joinPath(toFolder, base);
	if (to === from) return { path: from };
	const destAbs = isNote ? absNote(root, to) : absFolder(root, to);
	if (fs.existsSync(/* turbopackIgnore: true */ destAbs)) throw new NotesError(409, `"${isNote ? noteName(from) : base}" already exists in that folder.`);

	const oldPaths = allNotePaths(root);
	const map = new Map<string, string>();
	for (const p of oldPaths) {
		if (isNote ? p === from : isWithinFolder(p, from)) map.set(p, to + p.slice(from.length));
	}
	fs.renameSync(/* turbopackIgnore: true */ srcAbs, destAbs);
	// Sessions' home folders follow a moved folder.
	if (!isNote) retargetHomes(from, to);
	const reverse = new Map([...map].map(([a, b]) => [b, a]));
	const rec = new Recorder(root);
	fixLinks(root, rec, oldPaths, (cur) => reverse.get(cur) ?? cur, (t, h) => (map.has(t) ? { path: map.get(t)!, heading: h } : null));
	return { path: to };
}

// ─── Split / merge / extract ─────────────────────────────────────────────────

export interface SplitResult {
	opId: string;
	/** Where the original note (now the folder's summary) lives. */
	path: string;
	children: string[];
}

/**
 * Splits a note at its `## ` sections. "Voltage.md" becomes the folder
 * "Voltage/" holding "Voltage.md" (intro + sections left behind) and one
 * note per chosen section. Already a folder summary ("Voltage/Voltage.md")?
 * The children join that folder. Adds no links; rewrites the learner's
 * existing `[[Voltage#Section]]` links to the new notes.
 */
function split(rel: string, choices: readonly SplitChoice[], chatId: string | null): SplitResult {
	const { root } = requireRoot();
	const abs = absNote(root, rel);
	if (!fs.existsSync(/* turbopackIgnore: true */ abs)) throw new NotesError(404, "That note no longer exists.");
	if (!choices.length) throw new NotesError(400, "Pick at least one section.");
	const text = fs.readFileSync(/* turbopackIgnore: true */ abs, "utf-8");
	const body = noteBody(text);
	const { sections } = parseSections(body);
	const titles = new Set<string>();
	for (const c of choices) {
		if (!Number.isInteger(c.index) || c.index < 0 || c.index >= sections.length) throw new NotesError(400, "That section no longer exists. Reload the note.");
		assertName(c.title);
		const key = c.title.toLowerCase();
		if (titles.has(key)) throw new NotesError(400, `Two new notes are both named "${c.title}".`);
		titles.add(key);
	}
	const name = noteName(rel);
	const alreadySummary = folderOf(rel).split("/").pop() === name && folderOf(rel) !== "";
	const folder = alreadySummary ? folderOf(rel) : joinPath(folderOf(rel), name);
	const summaryPath = alreadySummary ? rel : joinPath(folder, `${name}.md`);
	if (!alreadySummary && fs.existsSync(/* turbopackIgnore: true */ absFolder(root, folder))) {
		throw new NotesError(409, `A folder named "${name}" already exists next to this note.`);
	}
	for (const c of choices) {
		const childPath = joinPath(folder, `${c.title}.md`);
		if (childPath.toLowerCase() === summaryPath.toLowerCase() || fs.existsSync(/* turbopackIgnore: true */ absNote(root, childPath))) {
			throw new NotesError(409, `"${c.title}" already exists in ${folder}/.`);
		}
	}

	const oldPaths = allNotePaths(root);
	const plan = planSplit(body, choices);
	const meta = readNoteMeta(text);
	const rec = new Recorder(root);
	const childMeta = addSession({ sessions: meta.sessions, parent: name }, chatId);
	const children: string[] = [];
	for (const child of plan.children) {
		const childPath = joinPath(folder, `${child.title}.md`);
		rec.write(childPath, withNoteMeta(child.body, childMeta));
		children.push(childPath);
	}
	const summaryText = withNoteMeta(withBody(text, plan.summaryBody), addSession(meta, chatId));
	if (summaryPath !== rel) rec.remove(rel);
	rec.write(summaryPath, summaryText);

	const headingTo = new Map(plan.children.map((c, i) => [c.heading.toLowerCase(), children[i]!]));
	fixLinks(
		root,
		rec,
		oldPaths,
		(cur) => (cur === summaryPath || children.includes(cur) ? rel : cur),
		(t, h) => {
			if (t !== rel) return null;
			if (h !== null && headingTo.has(h.toLowerCase())) return { path: headingTo.get(h.toLowerCase())!, heading: null };
			return summaryPath === rel ? null : { path: summaryPath, heading: h };
		},
	);
	return { opId: rec.commit(), path: summaryPath, children };
}

/**
 * Merges a split child back into its parent: the child's body becomes a
 * `## <child>` section of the folder's summary note, and the child file is
 * removed. When only the summary is left, it moves back out of the folder
 * (the exact reverse of a split). Links to the child become links to the
 * section.
 */
function merge(rel: string): { opId: string; path: string } {
	const { root } = requireRoot();
	const abs = absNote(root, rel);
	if (!fs.existsSync(/* turbopackIgnore: true */ abs)) throw new NotesError(404, "That note no longer exists.");
	const text = fs.readFileSync(/* turbopackIgnore: true */ abs, "utf-8");
	const meta = readNoteMeta(text);
	const folder = folderOf(rel);
	const folderName = folder.split("/").pop() ?? "";
	if (!meta.parent || !folder || meta.parent !== folderName) throw new NotesError(400, "This note wasn't split from a parent note in this folder.");
	const parentPath = joinPath(folder, `${folderName}.md`);
	const parentAbs = absNote(root, parentPath);
	const parentText = fs.existsSync(/* turbopackIgnore: true */ parentAbs) ? fs.readFileSync(/* turbopackIgnore: true */ parentAbs, "utf-8") : "";
	const childName = noteName(rel);

	const oldPaths = allNotePaths(root);
	const rec = new Recorder(root);
	const merged = mergeBodies(noteBody(parentText), childName, noteBody(text));
	const parentMeta = readNoteMeta(parentText);
	const sessions = [...new Set([...parentMeta.sessions, ...meta.sessions])];
	rec.write(parentPath, withNoteMeta(withBody(parentText, merged), { sessions, parent: parentMeta.parent }));
	rec.remove(rel);

	let finalParent = parentPath;
	const rest = fs.readdirSync(/* turbopackIgnore: true */ absFolder(root, folder)).filter((n) => !n.startsWith("."));
	const outer = folderOf(folder);
	const outPath = joinPath(outer, `${folderName}.md`);
	if (rest.length === 1 && rest[0] === `${folderName}.md` && !fs.existsSync(/* turbopackIgnore: true */ absNote(root, outPath))) {
		rec.write(outPath, fs.readFileSync(/* turbopackIgnore: true */ parentAbs, "utf-8"));
		rec.remove(parentPath);
		try { fs.rmdirSync(/* turbopackIgnore: true */ absFolder(root, folder)); } catch { /* keep */ }
		finalParent = outPath;
	}
	fixLinks(
		root,
		rec,
		oldPaths,
		(cur) => (cur === finalParent ? parentPath : cur),
		(t, h) => {
			if (t === rel) return { path: finalParent, heading: h ?? childName };
			if (t === parentPath && finalParent !== parentPath) return { path: finalParent, heading: h };
			return null;
		},
	);
	return { opId: rec.commit(), path: finalParent };
}

/** Moves the selected text [start, end) of a note's BODY into a new note in
 *  the same folder. The selection is removed; no link is left behind. */
function extract(rel: string, start: number, end: number, title: string, chatId: string | null): { opId: string; path: string } {
	assertName(title);
	const { root } = requireRoot();
	const abs = absNote(root, rel);
	if (!fs.existsSync(/* turbopackIgnore: true */ abs)) throw new NotesError(404, "That note no longer exists.");
	const text = fs.readFileSync(/* turbopackIgnore: true */ abs, "utf-8");
	const body = noteBody(text);
	if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > body.length || end <= start) {
		throw new NotesError(400, "Select some text first.");
	}
	const childPath = joinPath(folderOf(rel), `${title}.md`);
	if (fs.existsSync(/* turbopackIgnore: true */ absNote(root, childPath))) throw new NotesError(409, `A note named "${title}" already exists in this folder.`);
	const rec = new Recorder(root);
	const selected = body.slice(start, end).replace(/^\s+|\s+$/g, "");
	rec.write(childPath, withNoteMeta(`${selected}\n`, addSession({ sessions: readNoteMeta(text).sessions, parent: null }, chatId)));
	const before = body.slice(0, start).replace(/[ \t]+$/, "");
	const afterSel = body.slice(end).replace(/^[ \t]+/, "");
	const joiner = before && afterSel && !before.endsWith("\n") && !afterSel.startsWith("\n") ? " " : "";
	const rest = (before + joiner + afterSel).replace(/\n{3,}/g, "\n\n");
	rec.write(rel, withNoteMeta(withBody(text, rest), addSession(readNoteMeta(text), chatId)));
	return { opId: rec.commit(), path: childPath };
}

// ─── Attachments ─────────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	bmp: "image/bmp",
	avif: "image/avif",
};

function saveAttachment(noteRel: string, bytes: Buffer, ext: string): { name: string; embed: string } {
	const e = ext.toLowerCase().replace(/^\./, "");
	if (!MIME[e] || e === "svg") throw new NotesError(400, "Only pasted images can be saved.");
	if (bytes.length === 0 || bytes.length > MAX_ASSET_BYTES) throw new NotesError(413, "That image is too large.");
	if (!isValidNotePath(noteRel)) throw new NotesError(400, "Invalid note path.");
	const { vault } = requireRoot();
	const folder = attachmentFolderFor(obsidianAttachmentSetting(vault), `${NOTES_FOLDER}/${noteRel}`);
	const dirAbs = folder ? path.join(/* turbopackIgnore: true */ vault, ...folder.split("/")) : vault;
	const realVault = fs.realpathSync.native(/* turbopackIgnore: true */ vault);
	fs.mkdirSync(/* turbopackIgnore: true */ dirAbs, { recursive: true });
	const relCheck = path.relative(realVault, fs.realpathSync.native(/* turbopackIgnore: true */ dirAbs));
	if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) throw new NotesError(400, "The attachments folder is outside the vault.");
	let name = pastedImageName(new Date(), e);
	for (let n = 1; fs.existsSync(/* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ dirAbs, name)); n++) name = pastedImageName(new Date(), e).replace(`.${e}`, ` ${n}.${e}`);
	fs.writeFileSync(/* turbopackIgnore: true */ path.join(/* turbopackIgnore: true */ dirAbs, name), bytes);
	return { name, embed: `![[${name}]]` };
}

/** Finds an embedded image the way Obsidian does (vault-relative path, then
 *  by name: attachments folder, the note's folder, anywhere in the vault).
 *  Images only, inside the vault only. */
function asset(target: string, fromNoteRel: string): { bytes: Buffer; mime: string } | null {
	if (!isImageName(target) || target.includes("\0")) return null;
	const live = liveRoot();
	if (!live) return null;
	const realVault = fs.realpathSync.native(/* turbopackIgnore: true */ live.vault);
	const inVault = (abs: string) => {
		try {
			const r = path.relative(realVault, fs.realpathSync.native(/* turbopackIgnore: true */ abs));
			return !r.startsWith("..") && !path.isAbsolute(r);
		} catch { return false; }
	};
	const clean = target.replace(/\\/g, "/").replace(/^\/+/, "");
	const candidates: string[] = [];
	if (clean.includes("/")) {
		candidates.push(path.join(/* turbopackIgnore: true */ live.vault, ...clean.split("/")));
		candidates.push(path.join(/* turbopackIgnore: true */ live.root, ...folderOf(fromNoteRel).split("/").filter(Boolean), ...clean.split("/")));
	} else {
		const attach = attachmentFolderFor(obsidianAttachmentSetting(live.vault), `${NOTES_FOLDER}/${fromNoteRel}`);
		candidates.push(path.join(/* turbopackIgnore: true */ live.vault, ...attach.split("/").filter(Boolean), clean));
		candidates.push(path.join(/* turbopackIgnore: true */ live.root, ...folderOf(fromNoteRel).split("/").filter(Boolean), clean));
		candidates.push(path.join(/* turbopackIgnore: true */ live.vault, clean));
	}
	let found = candidates.find((c) => fs.existsSync(/* turbopackIgnore: true */ c) && fs.statSync(/* turbopackIgnore: true */ c).isFile() && inVault(c)) ?? null;
	if (!found && !clean.includes("/")) {
		let budget = 4000;
		const walk = (dir: string, depth: number): string | null => {
			if (depth > 8 || budget-- <= 0) return null;
			let entries: fs.Dirent[];
			try { entries = fs.readdirSync(/* turbopackIgnore: true */ dir, { withFileTypes: true }); } catch { return null; }
			for (const e of entries) if (e.isFile() && e.name.toLowerCase() === clean.toLowerCase()) return path.join(/* turbopackIgnore: true */ dir, e.name);
			for (const e of entries) {
				if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
				const hit = walk(path.join(/* turbopackIgnore: true */ dir, e.name), depth + 1);
				if (hit) return hit;
			}
			return null;
		};
		const hit = walk(live.vault, 0);
		if (hit && inVault(hit)) found = hit;
	}
	if (!found) return null;
	const st = fs.statSync(/* turbopackIgnore: true */ found);
	if (st.size > MAX_ASSET_BYTES) return null;
	const ext = found.split(".").pop()!.toLowerCase();
	return { bytes: fs.readFileSync(/* turbopackIgnore: true */ found), mime: MIME[ext] ?? "application/octet-stream" };
}

// ─── Session home folders ────────────────────────────────────────────────────

function homeFile(chatId: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(chatId)) throw new NotesError(400, "Invalid chat id.");
	return path.join(/* turbopackIgnore: true */ dirs.sessions(), `${chatId}.json`);
}

function getHome(chatId: string): string | null {
	try {
		const raw = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ homeFile(chatId), "utf-8")) as { homeFolder?: unknown };
		return typeof raw.homeFolder === "string" && isValidFolderPath(raw.homeFolder) ? raw.homeFolder : null;
	} catch {
		return null;
	}
}

function setHome(chatId: string, folder: string | null): void {
	if (folder !== null && !isValidFolderPath(folder)) throw new NotesError(400, "Invalid folder path.");
	fs.mkdirSync(/* turbopackIgnore: true */ dirs.sessions(), { recursive: true });
	if (folder === null) {
		fs.rmSync(/* turbopackIgnore: true */ homeFile(chatId), { force: true });
		return;
	}
	writeFileAtomicSync(homeFile(chatId), JSON.stringify({ homeFolder: folder }, null, "\t"), { allowInPlaceFallback: true });
}

function retargetHomes(from: string, to: string): void {
	let names: string[];
	try { names = fs.readdirSync(/* turbopackIgnore: true */ dirs.sessions()); } catch { return; }
	for (const n of names) {
		if (!n.endsWith(".json")) continue;
		const chatId = n.slice(0, -5);
		const home = getHome(chatId);
		if (home !== null && isWithinFolder(home, from)) setHome(chatId, to + home.slice(from.length));
	}
}

/** Session deletion: the notes stay (they belong to topics, not sessions);
 *  only the session's home-folder bookkeeping goes. */
function discardSession(chatId: string): void {
	try { fs.rmSync(/* turbopackIgnore: true */ homeFile(chatId), { force: true }); } catch { /* invalid id: nothing stored */ }
}

// ─── Vault choice ────────────────────────────────────────────────────────────

function setVault(input: string): NotesStatus {
	const raw = expandHome(input.trim());
	if (!raw || raw.includes("\0") || !path.isAbsolute(raw)) throw new NotesError(400, "Enter the full path to your vault folder.");
	const vault = path.resolve(/* turbopackIgnore: true */ raw);
	if (!isDir(vault)) throw new NotesError(404, "That folder doesn't exist.");
	if (path.resolve(/* turbopackIgnore: true */ vault) === path.resolve(/* turbopackIgnore: true */ PATHS.data) || vault.startsWith(path.resolve(/* turbopackIgnore: true */ PATHS.data) + path.sep)) {
		throw new NotesError(400, "Pick your Obsidian vault, not LearnHarness's data folder.");
	}
	fs.mkdirSync(/* turbopackIgnore: true */ notesRootOf(vault), { recursive: true });
	writeSettings({ vaultPath: vault });
	cache().clear();
	return status();
}

/** The cloud server's vault was disconnected (src/server/obsidian-sync.ts):
 *  the drawer goes back to its connect prompt. Pending edits can't exist
 *  there (the server's vault folder is always reachable). */
function clearVault(): void {
	if (!readSettings().vaultPath) return;
	writeSettings({ vaultPath: null });
	cache().clear();
}

export const notesStore = {
	status,
	tree,
	read,
	save,
	create,
	createFolder,
	move,
	split,
	merge,
	extract,
	undo,
	saveAttachment,
	asset,
	getHome,
	setHome,
	discardSession,
	setVault,
	clearVault,
	flushPending,
	inboxFolder: INBOX_FOLDER,
};

export type NotesStore = typeof notesStore;
