/**
 * THE NOTES DRAWER's pure logic — the learner's own notes, kept as plain
 * Markdown files in their Obsidian vault under `<vault>/LearnHarness/`.
 *
 * Privacy law: notes belong to the learner alone. Nothing here (or in the
 * store / service built on it) ever reaches a chat record, a teacher or
 * side-tutor prompt, compaction, or graph extraction, and the agents' file
 * tools refuse the notes folder (agent/tools/fs-shared.ts).
 *
 * Paths: every note path in this module is RELATIVE TO THE NOTES ROOT
 * (`<vault>/LearnHarness`), "/"-separated, ending ".md" — e.g.
 * "Electricity/Voltage/Voltage dividers.md". Folder paths have no suffix;
 * the root itself is "".
 *
 * Properties: LearnHarness keeps two keys in a note's YAML frontmatter
 * (Obsidian shows it as the Properties box): `lh_sessions` — the session
 * ids the note was edited in — and `lh_parent` — the note a split child
 * came from. Every other frontmatter line is preserved verbatim.
 *
 * Browser-safe: no node imports.
 */

export const NOTES_FOLDER = "LearnHarness";
export const INBOX_FOLDER = "Inbox";
export const DEFAULT_ATTACHMENTS_FOLDER = "attachments";
/** The split suggestion appears past either threshold (owner-approved). */
export const LONG_NOTE_WORDS = 800;
export const LONG_NOTE_SECTIONS = 4;
/** Link suggestions skip names shorter than this ("Is", "AC"…): too noisy. */
const MIN_SUGGESTION_NAME = 3;

// ─── Names and paths ─────────────────────────────────────────────────────────

/** Characters Obsidian (and Windows) refuse in a file name, plus the link
 *  syntax characters that would break `[[Name]]`. */
const BAD_NAME = /[\\/:*?"<>|#^[\]\u0000-\u001f]/;

export function isValidName(name: string): boolean {
	const n = name.trim();
	return n.length > 0 && n.length <= 120 && n === name && !BAD_NAME.test(n) && !n.startsWith(".") && !/[. ]$/.test(n);
}

/** Why a name is refused, for the UI. Null when valid. */
export function nameProblem(name: string): string | null {
	const n = name.trim();
	if (!n) return "Enter a name first.";
	if (n.length > 120) return "That name is too long.";
	if (n.startsWith(".")) return "Names can't start with a dot.";
	if (BAD_NAME.test(n)) return "Names can't contain \\ / : * ? \" < > | # ^ [ ]";
	if (/[. ]$/.test(n)) return "Names can't end with a dot or a space.";
	return null;
}

/** Validates a folder path relative to the notes root. "" is the root. */
export function isValidFolderPath(p: string): boolean {
	if (p === "") return true;
	return p.split("/").every(isValidName);
}

/** Validates a note path relative to the notes root. */
export function isValidNotePath(p: string): boolean {
	if (!p.endsWith(".md")) return false;
	const segments = p.split("/");
	const file = segments.pop()!;
	return isValidName(file.slice(0, -3)) && segments.every(isValidName);
}

export function noteName(notePath: string): string {
	const file = notePath.split("/").pop() ?? notePath;
	return file.endsWith(".md") ? file.slice(0, -3) : file;
}

export function folderOf(itemPath: string): string {
	const i = itemPath.lastIndexOf("/");
	return i === -1 ? "" : itemPath.slice(0, i);
}

export function joinPath(folder: string, name: string): string {
	return folder ? `${folder}/${name}` : name;
}

/** A note is its folder's summary note when it carries the folder's name
 *  ("Voltage/Voltage.md") — what a split leaves behind. */
export function isFolderSummary(notePath: string): boolean {
	const folder = folderOf(notePath);
	return folder !== "" && noteName(notePath) === (folder.split("/").pop() ?? "");
}

/** True when `inner` is `outer` or sits below it. */
export function isWithinFolder(inner: string, outer: string): boolean {
	if (outer === "") return true;
	return inner === outer || inner.startsWith(`${outer}/`);
}

// ─── Frontmatter (Properties) ────────────────────────────────────────────────

export interface NoteMeta {
	sessions: string[];
	parent: string | null;
}

interface FrontSplit {
	/** Raw lines between the fences, or null when the note has none. */
	lines: string[] | null;
	body: string;
	eol: string;
}

export function splitFrontmatter(text: string): FrontSplit {
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const m = /^---[ \t]*\r?\n/.exec(text);
	if (!m) return { lines: null, body: text, eol };
	const rest = text.slice(m[0].length);
	const close = /(^|\r?\n)---[ \t]*(\r?\n|$)/.exec(rest);
	if (!close) return { lines: null, body: text, eol };
	const inner = rest.slice(0, close.index);
	const body = rest.slice(close.index + close[0].length);
	return { lines: inner === "" ? [] : inner.split(/\r?\n/), body, eol };
}

/** The body only (what the drawer's editor shows). */
export function noteBody(text: string): string {
	return splitFrontmatter(text).body;
}

function unquote(v: string): string {
	const s = v.trim();
	if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
		try { return JSON.parse(s) as string; } catch { return s.slice(1, -1); }
	}
	if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
	return s;
}

const KEY_LINE = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/;
const LIST_ITEM = /^[ \t]+-[ \t]*(.*)$/;
const SESSION_ID = /^[A-Za-z0-9_-]+$/;

/** Reads LearnHarness's two properties. Tolerates hand edits in Obsidian
 *  (inline `[a, b]` lists, block lists, quoted values). */
export function readNoteMeta(text: string): NoteMeta {
	const { lines } = splitFrontmatter(text);
	const meta: NoteMeta = { sessions: [], parent: null };
	if (!lines) return meta;
	for (let i = 0; i < lines.length; i++) {
		const m = KEY_LINE.exec(lines[i]!);
		if (!m) continue;
		const [, key, value] = m;
		if (key === "lh_parent") {
			const v = unquote(value!);
			meta.parent = v && v !== "null" ? v : null;
		} else if (key === "lh_sessions") {
			const ids: string[] = [];
			const inline = value!.trim();
			if (inline.startsWith("[")) {
				for (const part of inline.replace(/^\[|\]$/g, "").split(",")) ids.push(unquote(part));
			} else if (inline) {
				ids.push(unquote(inline));
			} else {
				while (i + 1 < lines.length && LIST_ITEM.test(lines[i + 1]!)) ids.push(unquote(LIST_ITEM.exec(lines[++i]!)![1]!));
			}
			meta.sessions = [...new Set(ids.filter((id) => SESSION_ID.test(id)))];
		}
	}
	return meta;
}

/** Writes LearnHarness's two properties into `text`, keeping every other
 *  frontmatter line as it was. Empty values remove the key; a frontmatter
 *  block left with nothing in it is removed. */
export function withNoteMeta(text: string, meta: NoteMeta): string {
	const { lines, body, eol } = splitFrontmatter(text);
	const kept: string[] = [];
	const src = lines ?? [];
	for (let i = 0; i < src.length; i++) {
		const m = KEY_LINE.exec(src[i]!);
		if (m && (m[1] === "lh_sessions" || m[1] === "lh_parent")) {
			while (i + 1 < src.length && LIST_ITEM.test(src[i + 1]!)) i++;
			continue;
		}
		kept.push(src[i]!);
	}
	const sessions = [...new Set(meta.sessions.filter((id) => SESSION_ID.test(id)))];
	if (sessions.length) kept.push("lh_sessions:", ...sessions.map((id) => `  - ${id}`));
	if (meta.parent) kept.push(`lh_parent: ${JSON.stringify(meta.parent)}`);
	if (kept.length === 0 && lines === null) return body;
	if (kept.length === 0) return body;
	return `---${eol}${kept.join(eol)}${eol}---${eol}${body}`;
}

/** Replaces the body, keeping the frontmatter exactly. */
export function withBody(text: string, body: string): string {
	const { lines, eol } = splitFrontmatter(text);
	if (lines === null) return body;
	return `---${eol}${lines.join(eol)}${lines.length ? eol : ""}---${eol}${body}`;
}

export function addSession(meta: NoteMeta, chatId: string | null | undefined): NoteMeta {
	if (!chatId || !SESSION_ID.test(chatId) || meta.sessions.includes(chatId)) return meta;
	return { ...meta, sessions: [...meta.sessions, chatId] };
}

// ─── Code-aware scanning ─────────────────────────────────────────────────────

/** [start, end) ranges of fenced code blocks and inline code spans: links,
 *  headings and mentions inside them are text, not structure. */
export function codeRanges(text: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	const fence = /^( {0,3})(`{3,}|~{3,})[^\n]*$/gm;
	let open: { start: number; marker: string } | null = null;
	let m: RegExpExecArray | null;
	while ((m = fence.exec(text))) {
		const marker = m[2]!;
		if (!open) open = { start: m.index, marker };
		else if (marker[0] === open.marker[0] && marker.length >= open.marker.length && /^\s*(`{3,}|~{3,})\s*$/.test(m[0])) {
			ranges.push([open.start, m.index + m[0].length]);
			open = null;
		}
	}
	if (open) ranges.push([open.start, text.length]);
	const inside = (i: number) => ranges.some(([a, b]) => i >= a && i < b);
	const inline = /(`+)[^`\n]+?\1/g;
	while ((m = inline.exec(text))) if (!inside(m.index)) ranges.push([m.index, m.index + m[0].length]);
	return ranges;
}

function inRanges(i: number, ranges: Array<[number, number]>): boolean {
	return ranges.some(([a, b]) => i >= a && i < b);
}

// ─── Sections ────────────────────────────────────────────────────────────────

export interface NoteSection {
	/** Heading text without the `## `. */
	heading: string;
	/** Offset of the heading line in the body. */
	start: number;
	/** Offset just past the section (the next `## ` or the end). */
	end: number;
	/** Everything under the heading line (sub-headings included). */
	content: string;
	words: number;
}

export interface ParsedSections {
	intro: string;
	sections: NoteSection[];
}

const H2 = /^## +(.+?)[ \t]*#*[ \t]*$/gm;

/** Splits a BODY at its `## ` headings (outside code). Deeper headings ride
 *  with their section. */
export function parseSections(body: string): ParsedSections {
	const code = codeRanges(body);
	const starts: Array<{ start: number; heading: string; lineEnd: number }> = [];
	let m: RegExpExecArray | null;
	H2.lastIndex = 0;
	while ((m = H2.exec(body))) {
		if (inRanges(m.index, code)) continue;
		starts.push({ start: m.index, heading: m[1]!.trim(), lineEnd: m.index + m[0].length });
	}
	const intro = body.slice(0, starts[0]?.start ?? body.length);
	const sections = starts.map((s, i) => {
		const end = starts[i + 1]?.start ?? body.length;
		const content = body.slice(s.lineEnd, end).replace(/^\r?\n/, "");
		return { heading: s.heading, start: s.start, end, content, words: countWords(content) };
	});
	return { intro, sections };
}

export function countWords(text: string): number {
	const plain = text.replace(/[#>*_`~\-[\]()|!]+/g, " ");
	return plain.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

export interface LongNoteVerdict {
	long: boolean;
	words: number;
	sections: number;
}

export function longNoteVerdict(body: string): LongNoteVerdict {
	const words = countWords(body);
	const sections = parseSections(body).sections.length;
	return { long: words >= LONG_NOTE_WORDS || sections >= LONG_NOTE_SECTIONS, words, sections };
}

// ─── Links ───────────────────────────────────────────────────────────────────

export interface NoteLink {
	kind: "wiki" | "markdown";
	embed: boolean;
	start: number;
	end: number;
	/** As written: "Ohm's law", "Electricity/Ohm's law", "../Ohm's%20law.md"… */
	target: string;
	/** Heading anchor without the "#", or null. */
	heading: string | null;
	/** Wiki alias (after "|") or the markdown link text. */
	alias: string | null;
}

const WIKI = /(!?)\[\[([^[\]\n|#]*)(?:#([^[\]\n|]*))?(?:\|([^[\]\n]*))?\]\]/g;
const MD_LINK = /(!?)\[([^\]\n]*)\]\(<?([^)\s>]+?)>?\)/g;

/** Every link in a body, outside code. Markdown links count only when they
 *  point at a local file (no scheme). */
export function findLinks(text: string): NoteLink[] {
	const code = codeRanges(text);
	const links: NoteLink[] = [];
	let m: RegExpExecArray | null;
	WIKI.lastIndex = 0;
	while ((m = WIKI.exec(text))) {
		if (inRanges(m.index, code)) continue;
		links.push({
			kind: "wiki",
			embed: m[1] === "!",
			start: m.index,
			end: m.index + m[0].length,
			target: m[2]!.trim(),
			heading: m[3] !== undefined ? m[3].trim() : null,
			alias: m[4] !== undefined ? m[4] : null,
		});
	}
	MD_LINK.lastIndex = 0;
	while ((m = MD_LINK.exec(text))) {
		if (inRanges(m.index, code)) continue;
		const raw = m[3]!;
		if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("#")) continue;
		const hash = raw.indexOf("#");
		let target = hash === -1 ? raw : raw.slice(0, hash);
		try { target = decodeURI(target); } catch { /* keep as written */ }
		links.push({
			kind: "markdown",
			embed: m[1] === "!",
			start: m.index,
			end: m.index + m[0].length,
			target,
			heading: hash === -1 ? null : decodeURIComponentSafe(raw.slice(hash + 1)),
			alias: m[2]!,
		});
	}
	return links.sort((a, b) => a.start - b.start);
}

function decodeURIComponentSafe(s: string): string {
	try { return decodeURIComponent(s); } catch { return s; }
}

/** Normalizes "a/./b/../c" — returns null if it climbs above the root. */
function normalizeSegments(p: string): string | null {
	const out: string[] = [];
	for (const seg of p.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") {
			if (!out.length) return null;
			out.pop();
		} else out.push(seg);
	}
	return out.join("/");
}

/** Strips a vault-relative "LearnHarness/" prefix. Null if the path points
 *  OUTSIDE the notes folder (another part of the vault). */
function insideNotes(vaultRel: string): string | null {
	if (vaultRel === NOTES_FOLDER) return "";
	if (vaultRel.startsWith(`${NOTES_FOLDER}/`)) return vaultRel.slice(NOTES_FOLDER.length + 1);
	return null;
}

export type LinkResolution =
	| { kind: "note"; path: string }
	/** Not a note in LearnHarness/ — opens in Obsidian (vault-relative target). */
	| { kind: "outside"; target: string }
	| { kind: "missing"; target: string };

/**
 * Resolves a link the way Obsidian does, within the notes folder:
 *  - wiki "Name" → the note with that name (same folder first, then the
 *    shortest path); "Folder/Name" → vault-relative, then notes-relative;
 *  - markdown "../x.md" → relative to the linking note.
 * Anything not found in LearnHarness/ is "outside" (Obsidian may have it).
 */
export function resolveLink(link: Pick<NoteLink, "kind" | "target">, fromPath: string, notePaths: readonly string[]): LinkResolution {
	return resolveLinkIn(link, fromPath, buildLinkIndex(notePaths));
}

/** Lookups `resolveLink` needs, built once for many links. */
interface LinkIndex {
	/** lower-cased path → path (the last of equal ones, as a plain scan would). */
	lower: Map<string, string>;
	/** lower-cased note name → paths with it, in the given order. Built at first use: a
	 *  path-style link never needs it, so a single `resolveLink` call costs what it did. */
	byName(): Map<string, string[]>;
}

function buildLinkIndex(notePaths: readonly string[]): LinkIndex {
	const lower = new Map<string, string>();
	for (const p of notePaths) lower.set(p.toLowerCase(), p);
	let names: Map<string, string[]> | null = null;
	const byName = () => {
		if (names) return names;
		names = new Map();
		for (const p of notePaths) {
			const key = noteName(p).toLowerCase();
			const list = names.get(key);
			if (list) list.push(p); else names.set(key, [p]);
		}
		return names;
	};
	return { lower, byName };
}

function resolveLinkIn(link: Pick<NoteLink, "kind" | "target">, fromPath: string, index: LinkIndex): LinkResolution {
	const raw = link.target.replace(/\\/g, "/");
	if (!raw) return { kind: "note", path: fromPath };
	const { lower } = index;
	const withMd = (p: string) => (p.toLowerCase().endsWith(".md") ? p : `${p}.md`);

	if (link.kind === "markdown") {
		const rel = normalizeSegments(joinPath(folderOf(fromPath), raw));
		if (rel !== null) {
			const hit = lower.get(withMd(rel).toLowerCase());
			if (hit) return { kind: "note", path: hit };
		}
		return { kind: "outside", target: raw.replace(/^(\.\.\/)+/, "") };
	}

	if (raw.includes("/")) {
		const clean = normalizeSegments(raw.replace(/^\//, ""));
		if (clean !== null) {
			const asVault = insideNotes(clean);
			if (asVault !== null) {
				const hit = lower.get(withMd(asVault).toLowerCase());
				if (hit) return { kind: "note", path: hit };
			}
			const hit = lower.get(withMd(clean).toLowerCase());
			if (hit) return { kind: "note", path: hit };
		}
		return { kind: "outside", target: raw };
	}

	const name = raw.toLowerCase().endsWith(".md") ? raw.slice(0, -3) : raw;
	const matches = index.byName().get(name.toLowerCase()) ?? [];
	if (!matches.length) return { kind: "outside", target: raw };
	const here = folderOf(fromPath);
	const same = matches.find((p) => folderOf(p) === here);
	if (same) return { kind: "note", path: same };
	return { kind: "note", path: [...matches].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))[0]! };
}

/** "Linked from": note path → the notes that link to it (embeds excluded,
 *  self-links excluded), sorted. */
export function computeBacklinks(notes: ReadonlyArray<{ path: string; body: string }>): Record<string, string[]> {
	const index = buildLinkIndex(notes.map((n) => n.path));
	const out: Record<string, Set<string>> = {};
	for (const n of notes) {
		for (const link of findLinks(n.body)) {
			if (link.embed) continue;
			const r = resolveLinkIn(link, n.path, index);
			if (r.kind !== "note" || r.path === n.path) continue;
			(out[r.path] ??= new Set()).add(n.path);
		}
	}
	return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].sort((a, b) => a.localeCompare(b))]));
}

/** Applies replacements to `text`; `fn` returns new link text or null. */
export function rewriteLinks(text: string, fn: (link: NoteLink) => string | null): string {
	let out = text;
	for (const link of findLinks(text).reverse()) {
		const next = fn(link);
		if (next !== null && next !== text.slice(link.start, link.end)) out = out.slice(0, link.start) + next + out.slice(link.end);
	}
	return out;
}

export function wikiLink(target: string, heading: string | null, alias: string | null, embed = false): string {
	return `${embed ? "!" : ""}[[${target}${heading !== null ? `#${heading}` : ""}${alias !== null ? `|${alias}` : ""}]]`;
}

/** A relative markdown href from one note's folder to a target note. */
export function relativeHref(fromPath: string, toPath: string): string {
	const from = folderOf(fromPath).split("/").filter(Boolean);
	const to = toPath.split("/");
	let i = 0;
	while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
	const up = from.slice(i).map(() => "..");
	return encodeURI([...up, ...to.slice(i)].join("/"));
}

// ─── Link suggestions ────────────────────────────────────────────────────────

export interface LinkSuggestion {
	start: number;
	end: number;
	/** The note path the mention names. */
	path: string;
	/** The text as written in the note. */
	text: string;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Unlinked mentions of OTHER notes' names in a body — the drawer's "Link?"
 * suggestions. Never automatic: the learner accepts each one. First
 * mention per note only, outside code, links and heading lines; longer
 * names win overlaps ("Ohm's law" over "Ohm").
 */
export function linkSuggestions(body: string, selfPath: string, notePaths: readonly string[]): LinkSuggestion[] {
	const blocked: Array<[number, number]> = [...codeRanges(body), ...findLinks(body).map((l) => [l.start, l.end] as [number, number])];
	const headingLine = /^#{1,6} .*$/gm;
	let hm: RegExpExecArray | null;
	while ((hm = headingLine.exec(body))) blocked.push([hm.index, hm.index + hm[0].length]);
	const selfName = noteName(selfPath).toLowerCase();
	const byName = new Map<string, string>();
	for (const p of notePaths) {
		const n = noteName(p);
		if (n.length < MIN_SUGGESTION_NAME || n.toLowerCase() === selfName) continue;
		if (!byName.has(n.toLowerCase())) byName.set(n.toLowerCase(), p);
	}
	const names = [...byName.keys()].sort((a, b) => b.length - a.length);
	const taken: Array<[number, number]> = [];
	const out: LinkSuggestion[] = [];
	for (const lname of names) {
		const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(lname)}(?![\\p{L}\\p{N}_])`, "giu");
		let m: RegExpExecArray | null;
		while ((m = re.exec(body))) {
			const s = m.index;
			const e = s + m[0].length;
			if (inRanges(s, blocked) || taken.some(([a, b]) => s < b && e > a)) continue;
			taken.push([s, e]);
			out.push({ start: s, end: e, path: byName.get(lname)!, text: m[0] });
			break;
		}
	}
	return out.sort((a, b) => a.start - b.start);
}

/** The link text to insert for an accepted suggestion: `[[Name]]` when the
 *  mention matches the name exactly, else `[[Name|as written]]`. */
export function suggestionLinkText(s: LinkSuggestion): string {
	const name = noteName(s.path);
	return s.text === name ? wikiLink(name, null, null) : wikiLink(name, null, s.text);
}

// ─── Split / merge planning ──────────────────────────────────────────────────

export interface SplitChoice {
	/** Index into parseSections(body).sections. */
	index: number;
	/** The new note's name. */
	title: string;
}

export interface SplitPlan {
	/** The summary note's new body: intro + the sections left behind. */
	summaryBody: string;
	children: Array<{ title: string; heading: string; body: string }>;
}

function tidy(body: string): string {
	const t = body.replace(/\s+$/, "");
	return t ? `${t}\n` : "";
}

/** Pure split: no links are added anywhere (owner ruling — links only
 *  where the learner writes them). */
export function planSplit(body: string, choices: readonly SplitChoice[]): SplitPlan {
	const { intro, sections } = parseSections(body);
	const chosen = new Map(choices.map((c) => [c.index, c.title]));
	let summary = intro;
	const children: SplitPlan["children"] = [];
	sections.forEach((s, i) => {
		const title = chosen.get(i);
		if (title === undefined) summary += body.slice(s.start, s.end);
		else children.push({ title, heading: s.heading, body: tidy(s.content) });
	});
	return { summaryBody: tidy(summary), children };
}

/** Merge: the child's body becomes a `## <child name>` section at the end
 *  of the parent's body. */
export function mergeBodies(parentBody: string, childName: string, childBody: string): string {
	const base = parentBody.replace(/\s+$/, "");
	const section = `## ${childName}\n\n${childBody.replace(/^\s+|\s+$/g, "")}\n`;
	return base ? `${base}\n\n${section}` : section;
}

// ─── Attachments ─────────────────────────────────────────────────────────────

export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"] as const;

export function isImageName(name: string): boolean {
	const ext = name.split(".").pop()?.toLowerCase() ?? "";
	return (IMAGE_EXTENSIONS as readonly string[]).includes(ext);
}

/**
 * Where pasted images go, VAULT-relative ("" = vault root), from Obsidian's
 * `attachmentFolderPath` setting (.obsidian/app.json):
 *   "/"            → vault root
 *   "./" or "./x"  → the note's folder (or a subfolder of it)
 *   "x/y"          → that folder in the vault
 * No setting → LearnHarness/attachments (owner-approved default).
 */
export function attachmentFolderFor(setting: string | null | undefined, noteVaultPath: string): string {
	if (setting === undefined || setting === null || setting.trim() === "") return `${NOTES_FOLDER}/${DEFAULT_ATTACHMENTS_FOLDER}`;
	const s = setting.trim().replace(/\\/g, "/");
	if (s === "/") return "";
	if (s === "." || s === "./") return folderOf(noteVaultPath);
	if (s.startsWith("./")) return normalizeSegments(joinPath(folderOf(noteVaultPath), s.slice(2))) ?? `${NOTES_FOLDER}/${DEFAULT_ATTACHMENTS_FOLDER}`;
	return normalizeSegments(s.replace(/^\/+/, "")) ?? `${NOTES_FOLDER}/${DEFAULT_ATTACHMENTS_FOLDER}`;
}

/** Obsidian's pasted-image naming: "Pasted image 20261109013512.png". */
export function pastedImageName(now: Date, ext: string): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	return `Pasted image ${stamp}.${ext}`;
}

// ─── Wire shapes (shared by the service and the drawer) ──────────────────────

export interface NotesTreeNote {
	path: string;
	name: string;
	sessions: string[];
	parent: string | null;
	words: number;
	sections: number;
	mtimeMs: number;
}

export interface NotesStatus {
	configured: boolean;
	vaultPath: string | null;
	/** The vault folder's name — what obsidian:// links address. */
	vaultName: string | null;
	available: boolean;
	/** Notes waiting to be written because the vault was unavailable. */
	pending: number;
	/** Vault-relative folder pasted images go to. */
	attachmentFolder: string;
	/** Cloud server only (docs/cloud-sync.md, Phase 4): whether the vault is
	 *  syncing with Obsidian. Absent on the desktop and in local use. */
	sync?: "ok" | "stopped";
}

export interface NotesTree {
	status: NotesStatus;
	folders: string[];
	notes: NotesTreeNote[];
	backlinks: Record<string, string[]>;
}

/** What a folder holds, however deep (the delete confirm's numbers). */
export interface FolderContents {
	notes: number;
	folders: number;
	/** Pictures and anything else that isn't a note. */
	files: number;
}

function counted(n: number, one: string): string {
	return `${n} ${one}${n === 1 ? "" : "s"}`;
}

/** The delete confirm's wording (owner-approved). `contents` is null for a
 *  note and the folder's contents for a folder. */
export function deleteConfirmText(name: string, contents: FolderContents | null): { title: string; body: string } {
	if (!contents) return { title: `Delete “${name}”?`, body: "This removes it from your Obsidian vault for good." };
	const parts: string[] = [];
	if (contents.notes) parts.push(counted(contents.notes, "note"));
	if (contents.folders) parts.push(counted(contents.folders, "folder"));
	if (contents.files) parts.push(counted(contents.files, parts.length ? "other file" : "file"));
	if (!parts.length) return { title: `Delete “${name}”?`, body: "This removes the folder from your Obsidian vault for good." };
	const list = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]!}`;
	return { title: `Delete “${name}” and everything in it?`, body: `This removes ${list} from your Obsidian vault for good.` };
}

/** obsidian://open for a vault-relative target (a note outside LearnHarness/). */
export function obsidianUrl(vaultName: string, vaultRelTarget: string): string {
	return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(vaultRelTarget)}`;
}
