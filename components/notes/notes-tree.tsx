"use client";

/**
 * The notes drawer's folder tree: folders that fold, notes edited in this
 * session marked with a dot, the Inbox pinned first with its count, drag
 * and drop for notes AND folders (onto a folder, or onto the empty space
 * below for the top level), and a right-click / ⋯ menu per row.
 */

import { useEffect, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronRightIcon, FileTextIcon, FolderIcon, FolderOpenIcon, InboxIcon, MoreHorizontalIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { folderOf, INBOX_FOLDER, isFolderSummary, isWithinFolder, noteName, type NotesTreeNote } from "@/src/core";

export const DRAG_TYPE = "application/x-lh-note-item";

export interface TreeFolder {
	path: string;
	name: string;
	folders: TreeFolder[];
	notes: NotesTreeNote[];
	/** Notes anywhere below. */
	count: number;
}

export function buildTree(folders: readonly string[], notes: readonly NotesTreeNote[]): TreeFolder {
	const root: TreeFolder = { path: "", name: "", folders: [], notes: [], count: 0 };
	const byPath = new Map<string, TreeFolder>([["", root]]);
	const ensure = (p: string): TreeFolder => {
		const hit = byPath.get(p);
		if (hit) return hit;
		const parent = ensure(folderOf(p));
		const f: TreeFolder = { path: p, name: p.split("/").pop()!, folders: [], notes: [], count: 0 };
		parent.folders.push(f);
		byPath.set(p, f);
		return f;
	};
	for (const f of folders) ensure(f);
	for (const n of notes) ensure(folderOf(n.path)).notes.push(n);
	const finish = (f: TreeFolder): number => {
		f.folders.sort((a, b) => {
			if (f.path === "" && a.name === INBOX_FOLDER) return -1;
			if (f.path === "" && b.name === INBOX_FOLDER) return 1;
			return a.name.localeCompare(b.name);
		});
		f.notes.sort((a, b) => Number(isFolderSummary(b.path)) - Number(isFolderSummary(a.path)) || a.name.localeCompare(b.name));
		f.count = f.notes.length + f.folders.reduce((sum, c) => sum + finish(c), 0);
		return f.count;
	};
	finish(root);
	return root;
}

/** Keeps only notes passing `keep`, and the folders leading to them. */
export function filterTree(root: TreeFolder, keep: (n: NotesTreeNote) => boolean): TreeFolder {
	const walk = (f: TreeFolder): TreeFolder | null => {
		const folders = f.folders.map(walk).filter((x): x is TreeFolder => !!x);
		const notes = f.notes.filter(keep);
		if (f.path !== "" && !folders.length && !notes.length) return null;
		return { ...f, folders, notes, count: notes.length + folders.reduce((s, c) => s + c.count, 0) };
	};
	return walk(root)!;
}

export type RowTarget = { kind: "note"; note: NotesTreeNote } | { kind: "folder"; folder: TreeFolder };

export interface TreeMenuItem {
	label: string;
	onSelect: () => void;
	danger?: boolean;
}

function RowMenu({ x, y, items, onClose }: { x: number; y: number; items: TreeMenuItem[]; onClose: () => void }) {
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
	const left = Math.min(x, window.innerWidth - 230);
	const top = Math.min(y, window.innerHeight - 40 - items.length * 30);
	return createPortal(
		<div
			ref={ref}
			role="menu"
			className="fixed z-50 min-w-48 rounded-lg border border-border bg-popover p-1 text-sm shadow-lg"
			style={{ left, top }}
		>
			{items.map((it) => (
				<button
					key={it.label}
					type="button"
					role="menuitem"
					onClick={() => {
						onClose();
						it.onSelect();
					}}
					className={cn(
						"block w-full rounded-md px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent",
						it.danger ? "text-destructive" : "text-foreground",
					)}
				>
					{it.label}
				</button>
			))}
		</div>,
		document.body,
	);
}

export function NotesTreeView({
	root,
	openPath,
	selectedFolder,
	expanded,
	forceOpen,
	chatId,
	onToggleFolder,
	onSelectFolder,
	onOpenNote,
	onMove,
	menuFor,
	flat,
}: {
	root: TreeFolder;
	openPath: string | null;
	selectedFolder: string | null;
	expanded: ReadonlySet<string>;
	/** Session view / search: every folder shown open. */
	forceOpen: boolean;
	chatId: string;
	onToggleFolder: (path: string) => void;
	onSelectFolder: (path: string | null) => void;
	onOpenNote: (path: string) => void;
	/** Drag and drop: move `from` (note or folder) into `toFolder`. */
	onMove: (from: string, toFolder: string) => void;
	menuFor: (target: RowTarget) => TreeMenuItem[];
	/** Search results: a flat list with folder paths. */
	flat?: NotesTreeNote[];
}) {
	const [dropTarget, setDropTarget] = useState<string | null>(null);
	const [menu, setMenu] = useState<{ x: number; y: number; items: TreeMenuItem[] } | null>(null);
	const dragging = useRef<string | null>(null);

	const canDrop = (from: string | null, toFolder: string) => {
		if (!from) return false;
		if (from.endsWith(".md")) return folderOf(from) !== toFolder;
		return !isWithinFolder(toFolder, from) && folderOf(from) !== toFolder;
	};

	const dragProps = (path: string) => ({
		draggable: true,
		onDragStart: (e: DragEvent) => {
			dragging.current = path;
			e.dataTransfer.setData(DRAG_TYPE, path);
			e.dataTransfer.effectAllowed = "move";
		},
		onDragEnd: () => {
			dragging.current = null;
			setDropTarget(null);
		},
	});

	const dropProps = (folder: string) => ({
		onDragOver: (e: DragEvent) => {
			if (!canDrop(dragging.current, folder)) return;
			e.preventDefault();
			e.stopPropagation();
			e.dataTransfer.dropEffect = "move";
			setDropTarget(folder);
		},
		onDragLeave: (e: DragEvent) => {
			if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setDropTarget((t) => (t === folder ? null : t));
		},
		onDrop: (e: DragEvent) => {
			e.preventDefault();
			e.stopPropagation();
			const from = e.dataTransfer.getData(DRAG_TYPE) || dragging.current;
			setDropTarget(null);
			dragging.current = null;
			if (from && canDrop(from, folder)) onMove(from, folder);
		},
	});

	const openMenu = (e: ReactMouseEvent, target: RowTarget) => {
		e.preventDefault();
		e.stopPropagation();
		const items = menuFor(target);
		if (items.length) setMenu({ x: e.clientX, y: e.clientY, items });
	};

	const noteRow = (n: NotesTreeNote, depth: number, sub?: string) => {
		const active = n.path === openPath;
		return (
			<div
				key={n.path}
				role="treeitem"
				aria-selected={active}
				tabIndex={-1}
				data-testid="notes-tree-note"
				{...dragProps(n.path)}
				onClick={() => onOpenNote(n.path)}
				onContextMenu={(e) => openMenu(e, { kind: "note", note: n })}
				className={cn(
					"group/row flex cursor-pointer items-center gap-1.5 rounded-sm py-1 pr-1 text-sm transition-colors hover:bg-accent/60",
					active && "bg-accent",
				)}
				style={{ paddingLeft: 8 + depth * 14 }}
			>
				<span className="w-3.5 shrink-0" aria-hidden />
				<FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
				<span className={cn("min-w-0 flex-1 truncate", isFolderSummary(n.path) && "text-muted-foreground")}>{n.name}</span>
				{isFolderSummary(n.path) && <span className="shrink-0 text-xs text-muted-foreground">summary</span>}
				{sub !== undefined && <span className="max-w-[45%] shrink-0 truncate text-xs text-muted-foreground">{sub || "top level"}</span>}
				{n.sessions.includes(chatId) && <span aria-label="Edited in this session" title="Edited in this session" className="size-1.5 shrink-0 rounded-full bg-foreground" />}
				<button
					type="button"
					aria-label={`More actions for ${n.name}`}
					onClick={(e) => openMenu(e, { kind: "note", note: n })}
					className="shrink-0 rounded-sm p-0.5 text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100"
				>
					<MoreHorizontalIcon className="size-3.5" />
				</button>
			</div>
		);
	};

	const folderRows = (f: TreeFolder, depth: number): React.ReactNode => {
		const open = forceOpen || expanded.has(f.path);
		const inbox = f.path === INBOX_FOLDER;
		const selected = selectedFolder === f.path;
		return (
			<div key={f.path} role="group" {...dropProps(f.path)}>
				<div
					role="treeitem"
					aria-expanded={open}
					aria-selected={selected}
					tabIndex={-1}
					data-testid="notes-tree-folder"
					{...dragProps(f.path)}
					onClick={() => {
						onSelectFolder(selected ? null : f.path);
						if (!forceOpen) onToggleFolder(f.path);
					}}
					onContextMenu={(e) => openMenu(e, { kind: "folder", folder: f })}
					className={cn(
						"group/row flex cursor-pointer items-center gap-1.5 rounded-sm py-1 pr-1 text-sm font-medium transition-colors hover:bg-accent/60",
						selected && "bg-accent/60",
						dropTarget === f.path && "bg-accent ring-1 ring-border",
					)}
					style={{ paddingLeft: 8 + depth * 14 }}
				>
					<ChevronRightIcon className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} aria-hidden />
					{inbox ? (
						<InboxIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
					) : open ? (
						<FolderOpenIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
					) : (
						<FolderIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
					)}
					<span className="min-w-0 flex-1 truncate">{f.name}</span>
					<span className={cn("shrink-0 text-xs tabular-nums", inbox && f.count ? "text-foreground" : "text-muted-foreground")}>{f.count}</span>
					<button
						type="button"
						aria-label={`More actions for ${f.name}`}
						onClick={(e) => openMenu(e, { kind: "folder", folder: f })}
						className="shrink-0 rounded-sm p-0.5 text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100"
					>
						<MoreHorizontalIcon className="size-3.5" />
					</button>
				</div>
				{open && (
					<div>
						{f.notes.map((n) => noteRow(n, depth + 1))}
						{f.folders.map((c) => folderRows(c, depth + 1))}
					</div>
				)}
			</div>
		);
	};

	return (
		<div role="tree" aria-label="Notes" className="flex min-h-full flex-col">
			{flat ? (
				flat.length ? flat.map((n) => noteRow(n, 0, folderOf(n.path))) : <div className="px-2 py-3 text-xs text-muted-foreground">No notes match.</div>
			) : (
				<>
					{/* Inbox and other folders first, then top-level notes. */}
					{root.folders.map((f) => folderRows(f, 0))}
					{root.notes.map((n) => noteRow(n, 0))}
					{root.count === 0 && root.folders.length === 0 && (
						<div className="px-2 py-3 text-xs text-muted-foreground">No notes yet. Use New note to start one.</div>
					)}
				</>
			)}
			{/* The empty space below the tree: drop here for the top level. */}
			{!flat && (
				<div
					data-testid="notes-tree-root-drop"
					{...dropProps("")}
					className={cn("min-h-8 flex-1 rounded-sm transition-colors", dropTarget === "" && "bg-accent/50")}
				/>
			)}
			{menu && <RowMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
		</div>
	);
}

/** The display name of an item path for messages. */
export function itemName(p: string): string {
	return p.endsWith(".md") ? noteName(p) : p.split("/").pop() || "LearnHarness";
}
