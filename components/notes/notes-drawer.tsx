"use client";

/**
 * THE NOTES DRAWER — the learner's own notes beside the lesson, saved as
 * Markdown in their Obsidian vault (`<vault>/LearnHarness/`).
 *
 * PRIVACY LAW: nothing typed here reaches the teacher, the side tutor,
 * compaction or the knowledge graph. The drawer talks only to /api/notes
 * (src/server/notes.ts); the agents' file tools refuse the notes folder.
 *
 * Shape (owner-approved design, 2026-11-09): a full-height panel on the
 * right — header, the vault-offline banner, "This session / All topics",
 * search, the folding folder tree (drag and drop, ⋯ menus), then the open
 * note (CodeMirror Edit view or rendered Read view), the split
 * suggestion, "Linked from", and the save line.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
	ChevronLeftIcon,
	ChevronRightIcon,
	ChevronsDownUpIcon,
	ExternalLinkIcon,
	FolderPlusIcon,
	MoreHorizontalIcon,
	PlusIcon,
	ScissorsIcon,
	SearchIcon,
	SettingsIcon,
	XIcon,
} from "lucide-react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import {
	folderOf,
	INBOX_FOLDER,
	isWithinFolder,
	longNoteVerdict,
	nameProblem,
	noteName,
	NOTES_FOLDER,
	OBSIDIAN_TEXT,
	obsidianUrl,
	parseSections,
	resolveLink,
	type FolderContents,
	type NoteLink,
	type NotesTree,
	kbdEventForAction,
} from "@/src/core";
import {
	chooseVault,
	createFolder,
	createNote,
	deleteItem,
	extractSelection,
	fetchTree,
	folderContents,
	getHomeFolder,
	mergeNote,
	moveItem,
	NotesRequestError,
	readNote,
	saveNote,
	setHomeFolder,
	splitNote,
	undoNotes,
	uploadImage,
} from "./notes-api";
import { NoteEditor, type NoteEditorHandle } from "./note-editor";
import { NoteReadView } from "./note-read-view";
import { DeleteDialog, MoveDialog, NameDialog, SplitDialog } from "./notes-dialogs";
import { buildTree, filterTree, itemName, NotesTreeView, type RowTarget, type TreeMenuItem } from "./notes-tree";
import { isPhoneNow, useIsPhone } from "@/components/phone/use-phone";
import { useSettingsDialog } from "@/components/settings/settings-dialog";
import { useServerMode } from "@/components/settings/server-mode";

const TREE_POLL_MS = 4000;
const NOTE_POLL_MS = 2500;
const SAVE_DEBOUNCE_MS = 900;
const TOAST_MS = 20_000;
const MIN_WIDTH = 300;
const MAX_WIDTH = 720;

function load<T>(key: string, fallback: T): T {
	try {
		const raw = window.localStorage.getItem(key);
		return raw === null ? fallback : (JSON.parse(raw) as T);
	} catch {
		return fallback;
	}
}

function store(key: string, value: unknown): void {
	try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
}

function message(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

interface OpenDoc {
	path: string;
	body: string;
	hash: string | null;
	pending: boolean;
	parent: string | null;
}

type SaveState = "saved" | "saving" | "dirty" | "pending" | "error";

type Dialog =
	| { kind: "move"; item: string }
	| { kind: "split"; checked: number[] }
	| { kind: "folder"; parent: string }
	| { kind: "delete"; item: string; contents: FolderContents | null }
	| { kind: "extract"; start: number; end: number };

/** The open/closed state lives with the chat (Notes chip + Ctrl+Shift+N);
 *  this hook persists it across sessions and app restarts. */
export function useNotesDrawerOpen(): [boolean, (next: boolean | ((v: boolean) => boolean)) => void] {
	const [open, setOpenState] = useState(false);
	// PHONE (Phase 3): the drawer fills the screen there, so it always starts
	// closed and its state isn't remembered.
	useEffect(() => {
		if (!isPhoneNow()) setOpenState(load("lh:notes-open", false));
	}, []);
	const setOpen = useCallback((next: boolean | ((v: boolean) => boolean)) => {
		setOpenState((prev) => {
			const v = typeof next === "function" ? next(prev) : next;
			if (!isPhoneNow()) store("lh:notes-open", v);
			return v;
		});
	}, []);
	return [open, setOpen];
}

export function NotesDrawer({ chatId, onClose }: { chatId: string; onClose: () => void }) {
	const [tree, setTree] = useState<NotesTree | null>(null);
	const [treeError, setTreeError] = useState<string | null>(null);
	const [setupOpen, setSetupOpen] = useState(false);
	const [dragSlot, setDragSlot] = useState<HTMLElement | null>(null);
	const [view, setView] = useState<"session" | "all">(() => load("lh:notes-view", "all"));
	const [query, setQuery] = useState("");
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set(load<string[]>("lh:notes-expanded", [])));
	const [treeOpen, setTreeOpen] = useState<boolean>(() => load("lh:notes-tree-open", true));
	const [treeHeight, setTreeHeight] = useState<number>(() => load("lh:notes-tree-height", 240));
	const [width, setWidth] = useState<number>(() => load("lh:notes-width", 380));
	const [mode, setMode] = useState<"edit" | "read">(() => load("lh:notes-mode", "edit"));
	const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
	const [homeFolder, setHomeState] = useState<string | null>(null);
	const [openPath, setOpenPath] = useState<string | null>(() => load<string | null>(`lh:notes-open-note:${chatId}`, null));
	const [doc, setDoc] = useState<OpenDoc | null>(null);
	const [docError, setDocError] = useState<string | null>(null);
	const [saveState, setSaveState] = useState<SaveState>("saved");
	const [saveError, setSaveError] = useState<string | null>(null);
	const [conflict, setConflict] = useState<{ body: string; hash: string } | null>(null);
	const [dialog, setDialog] = useState<Dialog | null>(null);
	const [toast, setToast] = useState<{ text: string; opId?: string; reopen?: string } | null>(null);
	const [dismissed, setDismissed] = useState<string[]>(() => load("lh:notes-split-dismissed", []));
	const [selection, setSelection] = useState({ start: 0, end: 0 });
	const [newBox, setNewBox] = useState<{ title: string; folder: string | null; error: string | null } | null>(null);
	const [noteMenu, setNoteMenu] = useState<{ x: number; y: number } | null>(null);

	// ─── Phone layout (cloud sync Phase 3, owner's choice) ──────────────────
	// The drawer fills the screen and shows one half at a time: the list,
	// then the note with "‹ Notes" to go back. It opens on the note last
	// open in this session, if any.
	const phone = useIsPhone();
	// CLOUD SERVER (cloud sync Phase 4): the vault is connected in Settings →
	// Obsidian, never by typing a folder path. undefined until mounted, so the
	// desktop's first frame is unchanged.
	const onServer = useServerMode() === true;
	const { open: openSettings } = useSettingsDialog();
	const [phoneScreen, setPhoneScreen] = useState<"list" | "note">(() => (openPath ? "note" : "list"));
	useEffect(() => {
		setPhoneScreen(openPath ? "note" : "list");
	}, [openPath]);
	const showNoteOnPhone = () => setPhoneScreen("note");

	const editorRef = useRef<NoteEditorHandle | null>(null);
	const docRef = useRef<OpenDoc | null>(null);
	docRef.current = doc;
	const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const inFlight = useRef<Promise<void> | null>(null);
	const dirtyRef = useRef(false);
	/** Bumped whenever a save starts or ends: a background read that began
	 *  before a save is stale and must not be treated as an Obsidian edit. */
	const saveGen = useRef(0);
	const conflictRef = useRef(conflict);
	conflictRef.current = conflict;

	// ─── Persistence of view preferences ────────────────────────────────────
	useEffect(() => store("lh:notes-view", view), [view]);
	useEffect(() => store("lh:notes-expanded", [...expanded]), [expanded]);
	useEffect(() => store("lh:notes-tree-open", treeOpen), [treeOpen]);
	useEffect(() => store("lh:notes-tree-height", treeHeight), [treeHeight]);
	useEffect(() => store("lh:notes-width", width), [width]);
	useEffect(() => store("lh:notes-mode", mode), [mode]);
	useEffect(() => store(`lh:notes-open-note:${chatId}`, openPath), [chatId, openPath]);
	useEffect(() => store("lh:notes-split-dismissed", dismissed.slice(-300)), [dismissed]);

	// ─── Tree ───────────────────────────────────────────────────────────────
	const refreshTree = useCallback(async () => {
		try {
			const t = await fetchTree();
			// While the vault is unreachable keep showing the last tree.
			setTree((prev) => (t.status.available || !prev ? t : { ...prev, status: t.status }));
			setTreeError(null);
		} catch (e) {
			setTreeError(message(e));
		}
	}, []);

	useEffect(() => {
		void refreshTree();
		const id = setInterval(() => {
			if (document.visibilityState === "visible") void refreshTree();
		}, TREE_POLL_MS);
		return () => clearInterval(id);
	}, [refreshTree]);

	useEffect(() => {
		let live = true;
		void getHomeFolder(chatId).then((h) => live && setHomeState(h));
		setOpenPath(load<string | null>(`lh:notes-open-note:${chatId}`, null));
		return () => {
			live = false;
		};
	}, [chatId]);

	const status = tree?.status ?? null;
	const notes = useMemo(() => tree?.notes ?? [], [tree]);
	const paths = useMemo(() => notes.map((n) => n.path), [notes]);
	const folders = useMemo(() => {
		const set = new Set(tree?.folders ?? []);
		for (const p of paths) for (let f = folderOf(p); f; f = folderOf(f)) set.add(f);
		return [...set].sort((a, b) => a.localeCompare(b));
	}, [tree, paths]);

	// ─── Saving ─────────────────────────────────────────────────────────────
	const runSave = useCallback(async () => {
		const d = docRef.current;
		if (!d || !dirtyRef.current || conflictRef.current) return;
		dirtyRef.current = false;
		setSaveState("saving");
		const body = d.body;
		saveGen.current++;
		try {
			const r = await saveNote(d.path, body, d.hash, chatId);
			saveGen.current++;
			if (r.kind === "conflict") {
				dirtyRef.current = true;
				setConflict({ body: r.body, hash: r.hash });
				setSaveState("dirty");
				return;
			}
			setDoc((cur) => (cur && cur.path === d.path ? { ...cur, hash: r.hash, pending: r.pending } : cur));
			setSaveError(null);
			setSaveState(dirtyRef.current ? "dirty" : r.pending ? "pending" : "saved");
		} catch (e) {
			saveGen.current++;
			dirtyRef.current = true;
			setSaveError(message(e));
			setSaveState("error");
		}
	}, [chatId]);

	/** Saves now and waits — before switching notes or a structural change. */
	const flush = useCallback(async () => {
		if (saveTimer.current) {
			clearTimeout(saveTimer.current);
			saveTimer.current = null;
		}
		if (inFlight.current) await inFlight.current;
		if (dirtyRef.current) {
			inFlight.current = runSave();
			await inFlight.current;
			inFlight.current = null;
		}
	}, [runSave]);

	const schedule = useCallback(() => {
		if (saveTimer.current) clearTimeout(saveTimer.current);
		saveTimer.current = setTimeout(() => {
			saveTimer.current = null;
			const p = (inFlight.current ?? Promise.resolve()).then(runSave);
			inFlight.current = p;
			void p.finally(() => {
				if (inFlight.current === p) inFlight.current = null;
			});
		}, SAVE_DEBOUNCE_MS);
	}, [runSave]);

	useEffect(() => () => void flush(), [flush]);

	const onChange = useCallback(
		(body: string) => {
			setDoc((cur) => (cur ? { ...cur, body } : cur));
			dirtyRef.current = true;
			setSaveState("dirty");
			schedule();
		},
		[schedule],
	);

	// ─── The open note ──────────────────────────────────────────────────────
	const loadNote = useCallback(async (p: string) => {
		try {
			const n = await readNote(p);
			dirtyRef.current = false;
			setConflict(null);
			setDoc({ path: n.path, body: n.body, hash: n.hash, pending: n.pending, parent: n.parent });
			setSaveState(n.pending ? "pending" : "saved");
			setDocError(null);
		} catch (e) {
			setDoc(null);
			if (e instanceof NotesRequestError && e.status === 404) {
				setOpenPath(null);
				setDocError(null);
			} else setDocError(message(e));
		}
	}, []);

	useEffect(() => {
		if (!openPath) {
			setDoc(null);
			return;
		}
		if (docRef.current?.path !== openPath) void loadNote(openPath);
	}, [openPath, loadNote]);

	// Edits made in Obsidian show up here; unsaved drawer typing is never lost.
	useEffect(() => {
		if (!openPath) return;
		const id = setInterval(async () => {
			if (document.visibilityState !== "visible" || inFlight.current || saveTimer.current) return;
			const d = docRef.current;
			if (!d || d.path !== openPath || d.pending) return;
			const gen = saveGen.current;
			try {
				const n = await readNote(openPath);
				const cur = docRef.current;
				if (saveGen.current !== gen || !cur || cur.path !== openPath || n.hash === cur.hash || inFlight.current) return;
				if (dirtyRef.current) {
					if (n.hash) setConflict({ body: n.body, hash: n.hash });
				} else {
					setDoc({ path: n.path, body: n.body, hash: n.hash, pending: n.pending, parent: n.parent });
				}
			} catch (e) {
				if (e instanceof NotesRequestError && e.status === 404) {
					setOpenPath(null);
					void refreshTree();
				}
			}
		}, NOTE_POLL_MS);
		return () => clearInterval(id);
	}, [openPath, refreshTree]);

	const openNote = useCallback(
		async (p: string) => {
			await flush();
			setDialog(null);
			if (p === docRef.current?.path) return;
			setDoc(null);
			setOpenPath(p);
			const f = folderOf(p);
			if (f) {
				setExpanded((prev) => {
					const next = new Set(prev);
					for (let x = f; x; x = folderOf(x)) next.add(x);
					return next;
				});
			}
		},
		[flush],
	);

	// ─── Keyboard: Ctrl+Shift+E jumps into the editor ───────────────────────
	useEffect(() => {
		const onFocus = () => {
			setMode("edit");
			setTimeout(() => editorRef.current?.focus(), 0);
		};
		const ev = kbdEventForAction("focus-notes");
		window.addEventListener(ev, onFocus);
		return () => window.removeEventListener(ev, onFocus);
	}, []);

	// ─── Actions ────────────────────────────────────────────────────────────
	const showToast = (text: string, opId?: string, reopen?: string) => setToast({ text, opId, reopen });
	useEffect(() => {
		if (!toast) return;
		const id = setTimeout(() => setToast(null), TOAST_MS);
		return () => clearTimeout(id);
	}, [toast]);

	const guardConflict = () => {
		if (conflictRef.current) throw new Error("Resolve the “changed in Obsidian” notice first.");
	};

	const doMove = useCallback(
		async (from: string, to: string) => {
			guardConflict();
			await flush();
			const res = await moveItem(from, to);
			const remap = (p: string | null) => {
				if (!p) return p;
				if (from.endsWith(".md")) return p === from ? res.path : p;
				return isWithinFolder(p, from) ? res.path + p.slice(from.length) : p;
			};
			const nextOpen = remap(openPath);
			if (nextOpen !== openPath) {
				setDoc(null);
				setOpenPath(nextOpen);
			}
			setSelectedFolder((s) => (s && !from.endsWith(".md") && isWithinFolder(s, from) ? res.path + s.slice(from.length) : s));
			setExpanded((prev) => {
				const next = new Set<string>();
				for (const e of prev) next.add(!from.endsWith(".md") && isWithinFolder(e, from) ? res.path + e.slice(from.length) : e);
				for (let x = to; x; x = folderOf(x)) next.add(x);
				return next;
			});
			void getHomeFolder(chatId).then(setHomeState);
			await refreshTree();
			showToast(`Moved “${itemName(from)}” to ${to ? `${to}/` : "the top level"}.`);
		},
		[flush, openPath, chatId, refreshTree],
	);

	/** Delete for good (owner's choice: a confirm, no Undo). The open note goes
	 *  with it when it is the note or sits inside the folder; its unsaved
	 *  typing is dropped, never saved back into a new file. */
	const doDelete = async (item: string) => {
		const isNote = item.endsWith(".md");
		const gone = (p: string | null | undefined) => !!p && (isNote ? p === item : isWithinFolder(p, item));
		if (gone(docRef.current?.path) || gone(openPath)) {
			if (saveTimer.current) {
				clearTimeout(saveTimer.current);
				saveTimer.current = null;
			}
			dirtyRef.current = false;
			if (inFlight.current) await inFlight.current.catch(() => undefined);
			setConflict(null);
			setDoc(null);
			setOpenPath(null);
		}
		await deleteItem(item);
		if (!isNote) {
			setSelectedFolder((s) => (s && isWithinFolder(s, item) ? null : s));
			setExpanded((prev) => new Set([...prev].filter((e) => !isWithinFolder(e, item))));
			void getHomeFolder(chatId).then(setHomeState);
		}
		await refreshTree();
		showToast(`Deleted “${itemName(item)}”.`);
	};
	const askDelete = (item: string) => {
		if (item.endsWith(".md")) return setDialog({ kind: "delete", item, contents: null });
		void folderContents(item).then((contents) => setDialog({ kind: "delete", item, contents })).catch((e) => showToast(message(e)));
	};

	const onDragMove = (from: string, to: string) => {
		void doMove(from, to).catch((e) => showToast(message(e)));
	};

	const doSplit = async (choices: Array<{ index: number; title: string }>) => {
		const d = docRef.current;
		if (!d) return;
		guardConflict();
		await flush();
		const res = await splitNote(d.path, choices, chatId);
		setDoc(null);
		setOpenPath(res.path);
		setExpanded((prev) => new Set([...prev, folderOf(res.path)]));
		await refreshTree();
		await loadNote(res.path);
		showToast(`Split into ${res.children.length} new note${res.children.length === 1 ? "" : "s"}.`, res.opId, d.path);
	};

	const doMerge = async (path?: string) => {
		const target = path ?? docRef.current?.path;
		if (!target) return;
		try {
			guardConflict();
			await flush();
			const res = await mergeNote(target);
			setDoc(null);
			setOpenPath(res.path);
			await refreshTree();
			await loadNote(res.path);
			showToast(`Merged “${noteName(target)}” into “${noteName(res.path)}”.`, res.opId, target);
		} catch (e) {
			showToast(message(e));
		}
	};

	const doExtract = async (title: string, start: number, end: number) => {
		const d = docRef.current;
		if (!d) return;
		guardConflict();
		await flush();
		const res = await extractSelection(d.path, start, end, title, chatId);
		await refreshTree();
		await loadNote(d.path);
		showToast(`Moved the selection to “${title}”.`, res.opId, d.path);
	};

	const undo = async () => {
		if (!toast?.opId) return;
		const { opId, reopen } = toast;
		setToast(null);
		try {
			await flush();
			await undoNotes(opId);
			await refreshTree();
			if (reopen) {
				setDoc(null);
				setOpenPath(reopen);
				await loadNote(reopen);
			}
		} catch (e) {
			showToast(message(e));
		}
	};

	const openInObsidian = (vaultRel: string) => {
		if (!status?.vaultName) return;
		window.open(obsidianUrl(status.vaultName, vaultRel), "_blank");
	};

	const onOpenLink = (link: Pick<NoteLink, "kind" | "target" | "heading">) => {
		const from = docRef.current?.path ?? "";
		const r = resolveLink(link, from, paths);
		if (r.kind === "note") void openNote(r.path);
		else openInObsidian(r.target);
	};

	const onPasteImage = async (file: File): Promise<string | null> => {
		const d = docRef.current;
		if (!d) return null;
		try {
			const r = await uploadImage(d.path, file);
			return r.embed;
		} catch (e) {
			showToast(message(e));
			return null;
		}
	};

	// ─── New note ───────────────────────────────────────────────────────────
	const defaultFolder = selectedFolder ?? homeFolder;
	const startNewNote = () => {
		setNewBox({ title: "", folder: defaultFolder, error: null });
	};

	const submitNewNote = async (folderOverride?: string) => {
		if (!newBox) return;
		const title = newBox.title.trim();
		const problem = nameProblem(title);
		if (problem) return setNewBox({ ...newBox, error: problem });
		const folder = folderOverride ?? newBox.folder;
		if (folder === null) return setNewBox({ ...newBox, error: "Pick a folder, or put it in the Inbox." });
		try {
			await flush();
			const res = await createNote(folder, title, chatId);
			if (!homeFolder && folder !== INBOX_FOLDER) {
				await setHomeFolder(chatId, folder);
				setHomeState(folder);
			}
			setNewBox(null);
			await refreshTree();
			await openNote(res.path);
			setMode("edit");
			setTimeout(() => editorRef.current?.focus(), 50);
		} catch (e) {
			setNewBox({ ...newBox, error: message(e) });
		}
	};

	// ─── Menus ──────────────────────────────────────────────────────────────
	const menuFor = (t: RowTarget): TreeMenuItem[] => {
		if (t.kind === "note") {
			const n = t.note;
			const items: TreeMenuItem[] = [
				{ label: "Open", onSelect: () => void openNote(n.path) },
				{ label: "Move to…", onSelect: () => setDialog({ kind: "move", item: n.path }) },
			];
			if (n.sections > 0) items.push({ label: "Split note…", onSelect: () => void openNote(n.path).then(() => setDialog({ kind: "split", checked: [] })) });
			if (n.parent) items.push({ label: "Merge into parent", onSelect: () => void doMerge(n.path) });
			items.push({ label: "Open in Obsidian", onSelect: () => openInObsidian(`${NOTES_FOLDER}/${n.path}`) });
			items.push({ label: "Delete", danger: true, onSelect: () => askDelete(n.path) });
			return items;
		}
		const f = t.folder;
		return [
			// Owner's wording: no "here"; the folder you held says where.
			{ label: "New note", onSelect: () => setNewBox({ title: "", folder: f.path, error: null }) },
			{ label: "New folder", onSelect: () => setDialog({ kind: "folder", parent: f.path }) },
			{ label: "Move to…", onSelect: () => setDialog({ kind: "move", item: f.path }) },
			{
				label: homeFolder === f.path ? "This session's home folder" : "Make this the session's home folder",
				onSelect: () => {
					void setHomeFolder(chatId, f.path).then(() => setHomeState(f.path)).catch((e) => showToast(message(e)));
				},
			},
			{ label: "Delete", danger: true, onSelect: () => askDelete(f.path) },
		];
	};

	// ─── The message line ───────────────────────────────────────────────────
	const toastBar = toast && (
		<div role="status" data-testid="notes-toast" className="mx-3 mb-2 flex shrink-0 items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-xs">
			<span className="flex-1 text-muted-foreground">{toast.text}</span>
			{toast.opId && (
				<button type="button" className="text-foreground underline" onClick={() => void undo()}>
					Undo
				</button>
			)}
			<button type="button" aria-label="Dismiss" className="text-muted-foreground hover:text-foreground" onClick={() => setToast(null)}>
				<XIcon className="size-3" />
			</button>
		</div>
	);

	// ─── Derived view ───────────────────────────────────────────────────────
	const fullTree = useMemo(() => buildTree(folders, notes), [folders, notes]);
	const sessionTree = useMemo(() => filterTree(fullTree, (n) => n.sessions.includes(chatId)), [fullTree, chatId]);
	const q = query.trim().toLowerCase();
	const results = useMemo(() => (q ? notes.filter((n) => n.name.toLowerCase().includes(q) || n.path.toLowerCase().includes(q)) : undefined), [notes, q]);
	const shownTree = view === "session" ? sessionTree : fullTree;
	const verdict = useMemo(() => (doc ? longNoteVerdict(doc.body) : null), [doc]);
	const sections = useMemo(() => (doc ? parseSections(doc.body).sections.length : 0), [doc]);
	const backlinks = doc && tree ? (tree.backlinks[doc.path] ?? []) : [];
	const showSplitBanner = !!doc && !!verdict?.long && sections > 0 && !dismissed.includes(doc.path);

	// ─── Resizing ───────────────────────────────────────────────────────────
	const startWidthDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
		e.preventDefault();
		const startX = e.clientX;
		const startW = width;
		const move = (ev: PointerEvent) => setWidth(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startW + (startX - ev.clientX))));
		const up = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
	};
	const startTreeDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
		e.preventDefault();
		const startY = e.clientY;
		const startH = treeHeight;
		const move = (ev: PointerEvent) => setTreeHeight(Math.max(80, Math.min(640, startH + (ev.clientY - startY))));
		const up = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
	};

	const close = () => {
		void flush();
		onClose();
	};

	// On a phone the list has its own screen, so it never folds there; the
	// desktop's fold preference is untouched.
	const treeShown = phone || treeOpen;
	const needsSetup = setupOpen || (tree !== null && !tree.status.configured);
	const crumb = doc ? [NOTES_FOLDER, ...folderOf(doc.path).split("/").filter(Boolean)].join(" › ") : "";

	return (
		<aside
			aria-label="Notes"
			data-testid="notes-drawer"
			// PHONE hooks: app/phone.css makes this a full-screen drawer.
			data-phone="notes"
			data-phone-screen={phone ? phoneScreen : undefined}
			className="relative flex h-dvh shrink-0 flex-col border-l border-border bg-background"
			style={{ width }}
		>
			<div
				role="separator"
				aria-orientation="vertical"
				aria-label="Resize notes"
				data-phone="hide"
				onPointerDown={startWidthDrag}
				className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize"
			/>
			<header data-phone="notes-header" className="lh-drag lh-wco-gutter flex h-15 shrink-0 select-none items-center gap-2 border-b border-border pl-3">
				{phone && phoneScreen === "note" && (
					<button
						type="button"
						data-phone="notes-back"
						aria-label="Back to the note list"
						onClick={() => {
							void flush();
							setPhoneScreen("list");
						}}
						className="flex shrink-0 items-center gap-1 rounded-md py-1.5 pr-2 text-xs uppercase tracking-widest text-muted-foreground"
					>
						<ChevronLeftIcon className="size-4" aria-hidden />
						Notes
					</button>
				)}
				<span data-phone="notes-title" className="text-xs uppercase tracking-widest text-muted-foreground">Notes</span>
				{status?.vaultName && <span data-phone="notes-title" className="min-w-0 truncate text-xs text-muted-foreground">· {status.vaultName}</span>}
				<div className="min-w-2 flex-1" />
				<button
					type="button"
					onClick={startNewNote}
					data-phone="notes-list-action"
					disabled={!status?.configured}
					className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
				>
					<PlusIcon className="size-3" aria-hidden />
					New note
				</button>
				<button
					type="button"
					aria-label="New folder"
					data-phone="notes-list-action"
					title="New folder"
					disabled={!status?.configured}
					onClick={() => setDialog({ kind: "folder", parent: selectedFolder ?? "" })}
					className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
				>
					<FolderPlusIcon className="size-3.5" />
				</button>
				<button
					type="button"
					aria-label="Notes settings"
					data-phone="notes-list-action"
					title={onServer ? "Obsidian settings" : "Vault folder"}
					onClick={() => (onServer ? openSettings("obsidian") : setSetupOpen((v) => !v))}
					className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<SettingsIcon className="size-3.5" />
				</button>
				<button
					type="button"
					aria-label="Close notes"
					onClick={close}
					className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<XIcon className="size-3.5" />
				</button>
			</header>

			{needsSetup && onServer ? (
				<div className="flex flex-col items-start gap-3 p-4 text-sm" data-testid="notes-connect-obsidian">
					<div>
						<h2 className="text-sm font-semibold">Connect your Obsidian vault</h2>
						<p className="mt-1 text-xs leading-relaxed text-muted-foreground">Your notes live in your Obsidian vault. Connect it in Settings and they’ll appear here.</p>
					</div>
					<button
						type="button"
						onClick={() => openSettings("obsidian")}
						className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground transition-colors hover:bg-primary/90"
					>
						Open Settings
					</button>
				</div>
			) : needsSetup ? (
				<VaultSetup
					current={status?.vaultPath ?? null}
					onCancel={status?.configured ? () => setSetupOpen(false) : undefined}
					onChosen={async (p) => {
						await chooseVault(p);
						setSetupOpen(false);
						await refreshTree();
					}}
				/>
			) : tree === null ? (
				<div className="p-4 text-xs text-muted-foreground">{treeError ?? "Loading notes…"}</div>
			) : (
				<>
					{onServer && status?.sync === "stopped" && (
						<div role="status" data-testid="notes-not-syncing" className="mx-3 mt-3 rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
							{OBSIDIAN_TEXT.notSyncing}{" "}
							<button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => openSettings("obsidian")}>Settings</button>
						</div>
					)}
					{status && !status.available && (
						<div role="status" className="mx-3 mt-3 rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
							Your vault folder can’t be reached right now. Edits are kept here and written to the vault when it’s back
							{status.pending ? ` (${status.pending} note${status.pending === 1 ? "" : "s"} waiting)` : ""}.
						</div>
					)}

					{/* PHONE: the list half and the note half are grouped so a phone can
					    show one at a time. display:contents keeps the desktop layout
					    exactly as it was. */}
					<div data-phone="notes-list" className="contents">
					{newBox && (
						<NewNoteBox
							box={newBox}
							folders={folders}
							homeFolder={homeFolder}
							onChange={setNewBox}
							onCancel={() => setNewBox(null)}
							onSubmit={(f) => void submitNewNote(f)}
						/>
					)}

					<div data-phone="notes-filter" className="mx-3 mt-3 flex shrink-0 items-center gap-0.5 rounded-md border border-border/60 bg-background p-0.5">
							{(["session", "all"] as const).map((v) => (
							<button
								key={v}
								type="button"
								aria-pressed={view === v}
								onClick={() => setView(v)}
								className={cn(
									"flex-1 rounded-sm px-2 py-1 text-[11px] uppercase tracking-wider transition-colors",
									view === v ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
								)}
							>
								{v === "session" ? "This session" : "All topics"}
							</button>
						))}
					</div>

					<label data-phone="notes-filter" className="relative mx-3 mt-2 block shrink-0">
							<span className="sr-only">Search notes</span>
						<SearchIcon className="pointer-events-none absolute left-1.5 top-1/2 size-3 -translate-y-1/2 text-muted-foreground/70" aria-hidden />
						<input
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Escape") {
									e.stopPropagation();
									if (query) setQuery("");
									else (e.target as HTMLInputElement).blur();
								}
							}}
							placeholder="Search notes"
							className="h-6 w-full rounded-sm border border-border bg-background pl-6 pr-2 text-xs outline-none placeholder:text-muted-foreground/60 focus:border-ring"
						/>
					</label>

					<div data-phone="notes-tree-head" className="relative mx-3 mt-2 flex shrink-0 items-center gap-1">
						{/* PHONE drag: the tree lays its top-level drop box over this
						    heading. Out of the flow, so nothing here moves. */}
						<div ref={setDragSlot} className="pointer-events-none absolute inset-0" />
							<button
								type="button"
								aria-expanded={treeShown}
								data-phone="notes-tree-toggle"
								onClick={() => setTreeOpen((v) => !v)}
							className="flex items-center gap-1 text-[11px] uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground"
						>
							<ChevronRightIcon className={cn("size-3 transition-transform", treeShown && "rotate-90")} aria-hidden />
							{q ? "Results" : view === "session" ? "Notes from this session" : "Topics"}
						</button>
						<div className="flex-1" />
						{treeShown && !q && view === "all" && (
							<button
								type="button"
								onClick={() => setExpanded(new Set())}
								className="flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
							>
								<ChevronsDownUpIcon className="size-3" aria-hidden />
								Collapse all
							</button>
						)}
					</div>

					{treeShown && (
						<>
							<div data-phone="notes-tree" className="mx-2 mt-1 shrink-0 overflow-y-auto" style={{ height: treeHeight }}>
								<NotesTreeView
									root={shownTree}
									flat={results}
									dragSlot={dragSlot}
									openPath={openPath}
									selectedFolder={selectedFolder}
									expanded={expanded}
									forceOpen={view === "session"}
									chatId={chatId}
									onToggleFolder={(p) =>
										setExpanded((prev) => {
											const next = new Set(prev);
											if (next.has(p)) next.delete(p);
											else next.add(p);
											return next;
										})
									}
									onSelectFolder={setSelectedFolder}
									onOpenNote={(p) => {
										showNoteOnPhone();
										void openNote(p);
									}}
									onMove={onDragMove}
									menuFor={menuFor}
								/>
							</div>
							<div
								role="separator"
								aria-orientation="horizontal"
								aria-label="Resize the notes tree"
								data-phone="hide"
								onPointerDown={startTreeDrag}
								className="mx-3 h-2 shrink-0 cursor-row-resize border-b border-border"
							/>
						</>
					)}
					{/* PHONE: the list has its own screen there, so the message line
					    shows on it too (its usual place is in the note half, which
					    the list screen hides). */}
					{phone && toastBar}
					</div>

					<div data-phone="notes-note" className="contents">
					<NoteArea
						doc={doc}
						docError={docError}
						crumb={crumb}
						mode={mode}
						onMode={setMode}
						paths={paths}
						editorRef={editorRef}
						onChange={onChange}
						onOpenLink={onOpenLink}
						onPasteImage={onPasteImage}
						onSelection={setSelection}
						onMoveSection={(i) => setDialog({ kind: "split", checked: [i] })}
						onMenu={(x, y) => setNoteMenu({ x, y })}
					/>

					{doc && conflict && (
						<div role="alert" className="mx-3 mb-2 shrink-0 rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
							This note changed in Obsidian while you were typing here.
							<div className="mt-1.5 flex gap-3">
								<button
									type="button"
									className="text-foreground underline"
									onClick={() => {
										dirtyRef.current = false;
										setDoc({ ...doc, body: conflict.body, hash: conflict.hash });
										setConflict(null);
										setSaveState("saved");
									}}
								>
									Load Obsidian’s version
								</button>
								<button
									type="button"
									className="text-foreground underline"
									onClick={() => {
										setDoc({ ...doc, hash: conflict.hash });
										docRef.current = { ...doc, hash: conflict.hash };
										setConflict(null);
										conflictRef.current = null;
										dirtyRef.current = true;
										void flush();
									}}
								>
									Keep mine
								</button>
							</div>
						</div>
					)}

					{showSplitBanner && doc && (
						<div className="mx-3 mb-2 flex shrink-0 items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground">
							<ScissorsIcon className="size-3.5 shrink-0" aria-hidden />
							<span className="flex-1">This note is getting long. Split it?</span>
							<button type="button" className="text-foreground underline" onClick={() => setDialog({ kind: "split", checked: [] })}>
								Split…
							</button>
							<button type="button" className="hover:text-foreground" onClick={() => setDismissed((d) => [...d, doc.path])}>
								Not now
							</button>
						</div>
					)}

					{doc && (
						<div className="mx-3 mb-2 shrink-0 text-xs">
							<div className="mb-1 text-[11px] uppercase tracking-widest text-muted-foreground">Linked from</div>
							{backlinks.length ? (
								<div className="flex flex-wrap gap-x-3 gap-y-1">
									{backlinks.map((b) => (
										<button key={b} type="button" onClick={() => void openNote(b)} className="truncate font-prose text-sm underline underline-offset-[3px]" title={b}>
											{noteName(b)}
										</button>
									))}
								</div>
							) : (
								<div className="text-muted-foreground">No notes link here yet.</div>
							)}
						</div>
					)}

					{toastBar}

					{doc && <SaveLine state={saveState} error={saveError} path={doc.path} />}
					</div>
				</>
			)}

			{noteMenu && doc && (
				<NoteMenu
					x={noteMenu.x}
					y={noteMenu.y}
					onClose={() => setNoteMenu(null)}
					items={[
						{ label: "Move to…", onSelect: () => setDialog({ kind: "move", item: doc.path }) },
						...(sections > 0 ? [{ label: "Split note…", onSelect: () => setDialog({ kind: "split", checked: [] }) }] : []),
						...(mode === "edit" && selection.end > selection.start
							? [{ label: "Extract selection to new note…", onSelect: () => setDialog({ kind: "extract", start: selection.start, end: selection.end }) }]
							: []),
						...(doc.parent ? [{ label: "Merge into parent", onSelect: () => void doMerge() }] : []),
						{ label: "Open in Obsidian", onSelect: () => openInObsidian(`${NOTES_FOLDER}/${doc.path}`) },
					]}
				/>
			)}

			{dialog?.kind === "move" && (
				<MoveDialog item={dialog.item} folders={folders} onClose={() => setDialog(null)} onMove={(to) => doMove(dialog.item, to)} />
			)}
			{dialog?.kind === "split" && doc && (
				<SplitDialog
					path={doc.path}
					body={doc.body}
					allNotePaths={paths}
					initialChecked={dialog.checked.length ? dialog.checked : parseSections(doc.body).sections.map((_, i) => i)}
					onClose={() => setDialog(null)}
					onSplit={doSplit}
				/>
			)}
			{dialog?.kind === "delete" && (
				<DeleteDialog name={itemName(dialog.item)} contents={dialog.contents} onClose={() => setDialog(null)} onDelete={() => doDelete(dialog.item)} />
			)}
			{dialog?.kind === "folder" && (
				<NameDialog
					title="New folder"
					description={`Inside ${dialog.parent ? `${dialog.parent}/` : "LearnHarness/"}`}
					confirmLabel="Create folder"
					onClose={() => setDialog(null)}
					onConfirm={async (name) => {
						const res = await createFolder(dialog.parent, name);
						setExpanded((prev) => new Set([...prev, dialog.parent, res.path].filter(Boolean)));
						setSelectedFolder(res.path);
						await refreshTree();
					}}
				/>
			)}
			{dialog?.kind === "extract" && doc && (
				<NameDialog
					title="Extract selection to a new note"
					description={`The selected text moves into a new note in ${folderOf(doc.path) || "LearnHarness"}/. No link is left behind.`}
					confirmLabel="Extract"
					onClose={() => setDialog(null)}
					onConfirm={(name) => doExtract(name, dialog.start, dialog.end)}
				/>
			)}
		</aside>
	);
}

// ─── Pieces ──────────────────────────────────────────────────────────────────

function NoteArea({
	doc,
	docError,
	crumb,
	mode,
	onMode,
	paths,
	editorRef,
	onChange,
	onOpenLink,
	onPasteImage,
	onSelection,
	onMoveSection,
	onMenu,
}: {
	doc: OpenDoc | null;
	docError: string | null;
	crumb: string;
	mode: "edit" | "read";
	onMode: (m: "edit" | "read") => void;
	paths: readonly string[];
	editorRef: React.MutableRefObject<NoteEditorHandle | null>;
	onChange: (body: string) => void;
	onOpenLink: (link: Pick<NoteLink, "kind" | "target" | "heading">) => void;
	onPasteImage: (file: File) => Promise<string | null>;
	onSelection: (r: { start: number; end: number }) => void;
	onMoveSection: (index: number) => void;
	onMenu: (x: number, y: number) => void;
}) {
	if (!doc) {
		return (
			<div className="flex min-h-0 flex-1 items-start p-4 text-xs text-muted-foreground">
				{docError ?? "Pick a note in the tree, or make a new one with New note."}
			</div>
		);
	}
	return (
		<div className="flex min-h-0 flex-1 flex-col px-4 pt-3">
			<div className="truncate text-xs text-muted-foreground">{crumb}</div>
			<div className="mb-1 flex items-center gap-2">
				<h2 className="min-w-0 flex-1 truncate font-prose text-xl [font-weight:900]">{noteName(doc.path)}</h2>
				<div className="flex shrink-0 items-center gap-0.5 rounded-md border border-border/60 p-0.5">
					{(["edit", "read"] as const).map((m) => (
						<button
							key={m}
							type="button"
							aria-pressed={mode === m}
							onClick={() => onMode(m)}
							className={cn(
								"rounded-sm px-2 py-0.5 text-[11px] uppercase tracking-wider transition-colors",
								mode === m ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
							)}
						>
							{m === "edit" ? "Edit" : "Read"}
						</button>
					))}
				</div>
				<button
					type="button"
					aria-label="Note actions"
					onClick={(e) => {
						const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
						onMenu(r.right - 200, r.bottom + 4);
					}}
					className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<MoreHorizontalIcon className="size-4" />
				</button>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto">
				{mode === "edit" ? (
					<NoteEditor
						docKey={doc.path}
						value={doc.body}
						notePaths={paths}
						selfPath={doc.path}
						onChange={onChange}
						onOpenLink={onOpenLink}
						onPasteImage={onPasteImage}
						onSelection={onSelection}
						handleRef={editorRef}
					/>
				) : (
					<NoteReadView path={doc.path} body={doc.body} onOpenLink={onOpenLink} onMoveSection={onMoveSection} />
				)}
			</div>
		</div>
	);
}

function NoteMenu({ x, y, items, onClose }: { x: number; y: number; items: TreeMenuItem[]; onClose: () => void }) {
	const ref = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		const onDown = (e: MouseEvent) => {
			if (!ref.current?.contains(e.target as Node)) onClose();
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("mousedown", onDown, true);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown, true);
			document.removeEventListener("keydown", onKey);
		};
	}, [onClose]);
	return createPortal(
		<div ref={ref} role="menu" className="fixed z-50 w-52 rounded-lg border border-border bg-popover p-1 shadow-lg" style={{ left: Math.max(8, x), top: y }}>
			{items.map((it) => (
				<button
					key={it.label}
					type="button"
					role="menuitem"
					onClick={() => {
						onClose();
						it.onSelect();
					}}
					className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent"
				>
					{it.label}
					{it.label === "Open in Obsidian" && <ExternalLinkIcon className="ml-auto size-3 text-muted-foreground" aria-hidden />}
				</button>
			))}
		</div>,
		document.body,
	);
}

function SaveLine({ state, error, path }: { state: SaveState; error: string | null; path: string }) {
	const text =
		state === "saving"
			? "Saving…"
			: state === "dirty"
				? "Unsaved changes"
				: state === "pending"
					? "Kept here until your vault is back"
					: state === "error"
						? (error ?? "Couldn’t save. Retrying when you type again.")
						: `Saved · ${NOTES_FOLDER}/${path}`;
	return (
		<div
			role="status"
			className={cn("flex shrink-0 items-center gap-1.5 border-t border-border px-3 py-2 text-xs", state === "error" ? "text-destructive" : "text-muted-foreground")}
		>
			<span className="truncate" title={`${NOTES_FOLDER}/${path}`}>{text}</span>
		</div>
	);
}

function NewNoteBox({
	box,
	folders,
	homeFolder,
	onChange,
	onCancel,
	onSubmit,
}: {
	box: { title: string; folder: string | null; error: string | null };
	folders: readonly string[];
	homeFolder: string | null;
	onChange: (b: { title: string; folder: string | null; error: string | null }) => void;
	onCancel: () => void;
	onSubmit: (folderOverride?: string) => void;
}) {
	const [picking, setPicking] = useState(box.folder === null);
	const options = useMemo(() => ["", ...folders.filter((f) => f !== INBOX_FOLDER)], [folders]);
	return (
		<div className="mx-3 mt-3 shrink-0 rounded-lg border border-border bg-card p-2.5 text-xs">
			<label className="block">
				<span className="mb-1 block text-[11px] uppercase tracking-wider text-muted-foreground">New note</span>
				<input
					autoFocus
					value={box.title}
					placeholder="Note name"
					onChange={(e) => onChange({ ...box, title: e.target.value, error: null })}
					onKeyDown={(e) => {
						if (e.key === "Enter") onSubmit();
						if (e.key === "Escape") {
							e.stopPropagation();
							onCancel();
						}
					}}
					className="lh-input h-7 w-full rounded-md border border-input bg-background px-2 font-prose text-sm outline-none focus:border-ring"
				/>
			</label>
			<div className="mt-2 flex items-center gap-2 text-muted-foreground">
				<span className="shrink-0">Folder:</span>
				{picking ? (
					<select
						aria-label="Folder for the new note"
						value={box.folder ?? ""}
						onChange={(e) => onChange({ ...box, folder: e.target.value, error: null })}
						className="h-6 min-w-0 flex-1 rounded-sm border border-border bg-background px-1 text-xs text-foreground outline-none"
					>
						{box.folder === null && <option value="">Choose a folder…</option>}
						{options.map((f) => (
							<option key={f || "(root)"} value={f}>
								{f ? `${f}/` : "LearnHarness/ (top level)"}
							</option>
						))}
					</select>
				) : (
					<>
						<span className="min-w-0 truncate text-foreground">
							{box.folder ? `${box.folder}/` : "LearnHarness/"}
							{box.folder !== null && box.folder === homeFolder ? " (session home)" : ""}
						</span>
						<button type="button" className="shrink-0 underline" onClick={() => setPicking(true)}>
							Change
						</button>
					</>
				)}
			</div>
			{box.error && <p role="alert" className="mt-1.5 text-destructive">{box.error}</p>}
			<div className="mt-2 flex items-center justify-end gap-1.5">
				{!homeFolder && (
					<button type="button" onClick={() => onSubmit(INBOX_FOLDER)} className="mr-auto rounded-md px-2 py-1 text-muted-foreground underline hover:text-foreground">
						Skip: put it in the Inbox
					</button>
				)}
				<button type="button" onClick={onCancel} className="rounded-md px-2 py-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
					Cancel
				</button>
				<button
					type="button"
					onClick={() => onSubmit()}
					className="rounded-md bg-primary px-2.5 py-1 text-primary-foreground transition-colors hover:bg-primary/90"
				>
					Create
				</button>
			</div>
		</div>
	);
}

function VaultSetup({
	current,
	onCancel,
	onChosen,
}: {
	current: string | null;
	onCancel?: () => void;
	onChosen: (path: string) => Promise<void>;
}) {
	const [value, setValue] = useState(current ?? "");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const canPick = typeof window !== "undefined" && !!window.lh?.chooseAttachmentFolder;
	const submit = async (p: string) => {
		if (!p.trim()) return setError("Enter the full path to your vault folder.");
		setBusy(true);
		setError(null);
		try {
			await onChosen(p.trim());
		} catch (e) {
			setError(message(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="flex flex-col gap-3 p-4 text-sm">
			<div>
				<h2 className="text-sm font-semibold">Your Obsidian vault</h2>
				<p className="mt-1 text-xs leading-relaxed text-muted-foreground">
					Notes are saved as Markdown in a <span className="text-foreground">LearnHarness</span> folder inside your vault, so Obsidian and this drawer edit the same files. The tutors can’t read them.
				</p>
			</div>
			{canPick && (
				<button
					type="button"
					disabled={busy}
					onClick={async () => {
						const p = await window.lh?.chooseAttachmentFolder?.();
						if (p) {
							setValue(p);
							await submit(p);
						}
					}}
					className="self-start rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
				>
					Choose folder…
				</button>
			)}
			<label className="block">
				<span className="mb-1 block text-xs text-muted-foreground">{canPick ? "Or paste the folder's path" : "The folder's full path"}</span>
				<input
					value={value}
					onChange={(e) => {
						setValue(e.target.value);
						setError(null);
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter") void submit(value);
					}}
					placeholder="C:\Users\you\Documents\My Vault"
					className="h-8 w-full rounded-md border border-input bg-background px-2.5 text-xs outline-none placeholder:text-muted-foreground/60 focus:border-ring"
				/>
			</label>
			{error && <p role="alert" className="text-xs text-destructive">{error}</p>}
			<div className="flex gap-2">
				<button
					type="button"
					disabled={busy}
					onClick={() => void submit(value)}
					className="rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent disabled:opacity-40"
				>
					{busy ? "Saving…" : "Use this folder"}
				</button>
				{onCancel && (
					<button type="button" onClick={onCancel} className="rounded-md px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
						Cancel
					</button>
				)}
			</div>
		</div>
	);
}

