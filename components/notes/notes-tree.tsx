"use client";

/**
 * The notes drawer's folder tree: folders that fold, notes edited in this
 * session marked with a dot, the Inbox pinned first with its count, dragging
 * for notes AND folders, and a right-click / ⋯ menu per row.
 *
 * DRAGGING (owner-approved design): the row itself follows the pointer and
 * the other rows slide out of its way. The list still sorts itself, so a
 * drag decides only which folder the item ends up in: a gap among a
 * folder's rows means that folder, a gap at the top level (above Inbox
 * too) means outside every folder, and the middle of a folder row lights
 * the folder and means inside it. After the drop the row slides to its
 * sorted place.
 *   - With a mouse: press a row and move.
 *   - On a phone: press and hold opens the row's menu; holding and then
 *     moving drags the row instead (components/phone/long-press.ts).
 * The rules are in row-drag.ts, the movement in row-drag-dom.ts.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { MenuShell } from "@/components/menu-shell";
import { ChevronRightIcon, FileTextIcon, FolderIcon, FolderOpenIcon, InboxIcon, MoreHorizontalIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { folderOf, INBOX_FOLDER, isFolderSummary, isWithinFolder, noteName, type NotesTreeNote } from "@/src/core";
import { useIsPhone } from "@/components/phone/use-phone";
import { HOLD_DRAG_EVENT, type HoldDragDetail } from "@/components/phone/long-press";
import { createRowDrag, type RowDrag, type RowDragUi } from "./row-drag-dom";

/** May `from` (a note or a folder) be moved into `toFolder`? Not into the
 *  folder it is already in, and a folder never into itself. */
export function canDropInto(from: string | null, toFolder: string): boolean {
	if (!from) return false;
	if (from.endsWith(".md")) return folderOf(from) !== toFolder;
	return !isWithinFolder(toFolder, from) && folderOf(from) !== toFolder;
}

/** How far the mouse must move with the button down before a row is dragged. */
const MOUSE_DRAG_SLOP = 5;

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

/**
 * A menu opened at a point (a right-click, a press and hold, or under the
 * note's ⋯ button), on the host's menu layer (MenuShell): its paint order,
 * Esc and arrow keys are the host's, like the session list's menu. The
 * point is where it has always opened; `left`/`top` already hold the
 * clamps each caller used, and the shell's 4 px gap below its anchor is
 * taken off so the menu's top edge stays on the point.
 *
 * A press anywhere outside closes it (mousedown, capturing, as before);
 * a press inside one of the host's menus never does.
 */
export function PointMenu({ left, top, testid, menuClass, onClose, children }: {
	left: number;
	top: number;
	testid: string;
	menuClass: string;
	onClose: () => void;
	children: React.ReactNode;
}) {
	const latest = useRef(onClose);
	latest.current = onClose;
	useEffect(() => {
		const onDown = (e: MouseEvent) => {
			const target = e.target as Element | null;
			if (target?.closest?.(`[data-testid="${testid}"]`)) return;
			latest.current();
		};
		document.addEventListener("mousedown", onDown, true);
		return () => document.removeEventListener("mousedown", onDown, true);
	}, [testid]);
	const point = useRef({ left, top });
	point.current = { left, top };
	const anchorRect = useCallback(() => {
		const { left: x, top: y } = point.current;
		return { left: x, right: x, top: y - MENU_GAP, bottom: y - MENU_GAP };
	}, []);
	return (
		<MenuShell
			testid={testid}
			getAnchorRect={anchorRect}
			preferredSide="down"
			align="left"
			menuClass={menuClass}
			onClose={() => { latest.current(); return "closed"; }}
		>
			<div role="menu">{children}</div>
		</MenuShell>
	);
}

/** MenuShell's gap between an anchor and the menu below it. */
const MENU_GAP = 4;

function RowMenu({ x, y, items, onClose }: { x: number; y: number; items: TreeMenuItem[]; onClose: () => void }) {
	// Where it always opened: at the pointer, kept clear of the window's
	// right and bottom edges by the same rough measure as before.
	const left = Math.min(x, window.innerWidth - 230);
	const top = Math.min(y, window.innerHeight - 40 - items.length * 30);
	return (
		<PointMenu left={left} top={top} testid="notes-row-menu" menuClass="min-w-48 rounded-lg border border-border bg-popover p-1 text-sm shadow-lg" onClose={onClose}>
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
		</PointMenu>
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
	/** A drag ended on another folder: move `from` (note or folder) into
	 *  `toFolder`. Resolves true once the list shows the result, false when
	 *  the move was refused (the rows then slide back). */
	onMove: (from: string, toFolder: string) => Promise<boolean>;
	menuFor: (target: RowTarget) => TreeMenuItem[];
	/** Search results: a flat list with folder paths. They can't be dragged. */
	flat?: NotesTreeNote[];
}) {
	const [menu, setMenu] = useState<{ x: number; y: number; items: TreeMenuItem[] } | null>(null);
	const phone = useIsPhone();
	const treeRef = useRef<HTMLDivElement | null>(null);
	/** What is being dragged and the folder lit under it. Only the rows'
	 *  classes follow this; the movement is written straight to the rows. */
	const [dragUi, setDragUi] = useState<RowDragUi | null>(null);
	const latest = useRef({ onMove });
	latest.current = { onMove };
	const dragRef = useRef<RowDrag | null>(null);
	if (!dragRef.current) {
		dragRef.current = createRowDrag({
			tree: () => treeRef.current,
			canEnter: canDropInto,
			setUi: setDragUi,
			move: (from, toFolder) => latest.current.onMove(from, toFolder),
		});
	}
	const drag = dragRef.current;
	useEffect(() => () => drag.destroy(), [drag]);
	// After every render: a drop that is waiting for the list slides the rows
	// to their sorted places as soon as the list shows the move.
	useLayoutEffect(() => {
		drag.afterRender();
	});

	const canDrag = !flat;

	// TOUCH (a phone, and a tablet with the computer layout): press and hold
	// opens the row menu; hold, then move drags the row. Only a finger in a
	// browser sends these (components/phone/long-press.ts).
	useEffect(() => {
		if (!canDrag) return;
		const onHoldDrag = (event: Event) => {
			const d = (event as CustomEvent<HoldDragDetail>).detail;
			if (d.phase === "start") {
				const path = d.row.getAttribute("data-drag-path");
				if (!path || !treeRef.current?.contains(d.row)) return;
				setMenu(null);
				drag.start(path, d.x, d.y);
			} else if (d.phase === "move") drag.move(d.x, d.y);
			else if (d.phase === "end") drag.end();
			else drag.cancel();
		};
		document.addEventListener(HOLD_DRAG_EVENT, onHoldDrag);
		return () => {
			document.removeEventListener(HOLD_DRAG_EVENT, onHoldDrag);
			drag.cancel();
		};
	}, [canDrag, drag]);

	// MOUSE (and pen): press a row and move. A press that doesn't move is the
	// click it always was.
	useEffect(() => {
		const tree = treeRef.current;
		if (phone || !canDrag || !tree) return;
		let press: { path: string; x: number; y: number; id: number } | null = null;
		const swallowClick = () => {
			const stop = (e: MouseEvent) => {
				e.preventDefault();
				e.stopPropagation();
			};
			document.addEventListener("click", stop, true);
			setTimeout(() => document.removeEventListener("click", stop, true), 0);
		};
		const onDown = (e: PointerEvent) => {
			if (e.button !== 0 || e.pointerType === "touch" || drag.active()) return;
			const target = e.target as Element | null;
			const row = target?.closest?.("[data-drag-path]") ?? null;
			if (!row || !tree.contains(row) || target?.closest("button")) return;
			press = { path: row.getAttribute("data-drag-path") ?? "", x: e.clientX, y: e.clientY, id: e.pointerId };
		};
		const onMoved = (e: PointerEvent) => {
			if (!press || e.pointerId !== press.id) return;
			if (!drag.active()) {
				if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < MOUSE_DRAG_SLOP) return;
				if (!drag.start(press.path, press.x, press.y)) {
					press = null;
					return;
				}
				setMenu(null);
			}
			drag.move(e.clientX, e.clientY);
		};
		const onUp = (e: PointerEvent) => {
			if (!press || e.pointerId !== press.id) return;
			press = null;
			if (!drag.active()) return;
			swallowClick();
			if (e.type === "pointercancel") drag.cancel();
			else drag.end();
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || !press || !drag.active()) return;
			e.preventDefault();
			e.stopPropagation();
			press = null;
			drag.cancel();
		};
		tree.addEventListener("pointerdown", onDown);
		document.addEventListener("pointermove", onMoved);
		document.addEventListener("pointerup", onUp);
		document.addEventListener("pointercancel", onUp);
		document.addEventListener("keydown", onKey, true);
		return () => {
			tree.removeEventListener("pointerdown", onDown);
			document.removeEventListener("pointermove", onMoved);
			document.removeEventListener("pointerup", onUp);
			document.removeEventListener("pointercancel", onUp);
			document.removeEventListener("keydown", onKey, true);
			drag.cancel();
		};
	}, [phone, canDrag, drag]);

	const openMenu = (e: ReactMouseEvent, target: RowTarget) => {
		e.preventDefault();
		e.stopPropagation();
		const items = menuFor(target);
		if (items.length) setMenu({ x: e.clientX, y: e.clientY, items });
	};

	/** The dragged row (and, for a folder, the rows inside it) is drawn lifted. */
	const lifted = (path: string) => !!dragUi && isWithinFolder(path, dragUi.path) && "relative z-10 bg-popover shadow-lg ring-1 ring-border hover:bg-popover";

	const noteRow = (n: NotesTreeNote, depth: number, sub?: string) => {
		const active = n.path === openPath;
		return (
			<div
				key={n.path}
				role="treeitem"
				aria-selected={active}
				tabIndex={-1}
				data-testid="notes-tree-note"
				onClick={() => onOpenNote(n.path)}
				onContextMenu={(e) => openMenu(e, { kind: "note", note: n })}
				data-phone-press=""
				data-phone-drag={canDrag ? "" : undefined}
				data-drag-path={canDrag ? n.path : undefined}
				data-depth={depth}
				className={cn(
					"group/row flex cursor-pointer select-none items-center gap-1.5 rounded-sm py-1 pr-1 text-sm transition-colors hover:bg-accent/60",
					active && "bg-accent",
					lifted(n.path),
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
			<div key={f.path} role="group">
				<div
					role="treeitem"
					aria-expanded={open}
					aria-selected={selected}
					tabIndex={-1}
					data-testid="notes-tree-folder"
					onClick={() => {
						onSelectFolder(selected ? null : f.path);
						if (!forceOpen) onToggleFolder(f.path);
					}}
					onContextMenu={(e) => openMenu(e, { kind: "folder", folder: f })}
					data-phone-press=""
					data-phone-drag=""
					data-drag-path={f.path}
					data-row-folder=""
					data-depth={depth}
					data-drop-lit={dragUi?.over === f.path ? "" : undefined}
					className={cn(
						"group/row flex cursor-pointer select-none items-center gap-1.5 rounded-sm py-1 pr-1 text-sm font-medium transition-colors hover:bg-accent/60",
						selected && "bg-accent/60",
						dragUi?.over === f.path && "bg-accent ring-1 ring-border",
						lifted(f.path),
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
		<div ref={treeRef} role="tree" aria-label="Notes" data-dragging={dragUi ? "" : undefined} className="flex min-h-full flex-col">
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
			{menu && <RowMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
		</div>
	);
}

/** The display name of an item path for messages. */
export function itemName(p: string): string {
	return p.endsWith(".md") ? noteName(p) : p.split("/").pop() || "LearnHarness";
}
