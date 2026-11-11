/**
 * DRAGGING A ROW IN THE NOTES LIST: the rules (owner-approved design).
 *
 * The dragged line itself follows the pointer, the other rows slide out of
 * its way to open a gap, and the middle of a folder row lights that folder
 * instead. The list still sorts itself (owner's choice), so a drag decides
 * only WHICH FOLDER the item ends up in:
 *   - a gap among a folder's rows  → that folder (the line is indented);
 *   - a gap at the top level       → outside every folder;
 *   - the middle of a folder row   → inside that folder.
 *
 * Everything here is plain geometry on the list's visible rows, measured
 * once when the drag starts; notes-tree.tsx moves the DOM.
 *
 * Coordinates are pixels from the top of the list. `rest` is the list
 * without the dragged block, closed up. With the gap at index g, rows
 * before g sit at their closed-up place and rows from g on sit one block
 * lower. Rows are judged where they are SHOWN, so the row under the line
 * is always the one the rule is about; a gap only moves when the line's
 * centre crosses half of a neighbouring row, which is what keeps it from
 * flickering.
 */

import { folderOf, isWithinFolder } from "@/src/core";

export interface DragRow {
	path: string;
	folder: boolean;
	/** 0 at the top level. */
	depth: number;
	/** The folder it is in ("" = the top level). */
	parent: string;
	top: number;
	height: number;
}

export interface DragLevel {
	/** The folder a drop lands in ("" = outside every folder). */
	parent: string;
	depth: number;
}

export interface DragPlan {
	path: string;
	/** The dragged row, and for an open folder everything shown inside it. */
	block: DragRow[];
	blockTop: number;
	blockHeight: number;
	/** Height of the dragged row itself (the block's first row). */
	headHeight: number;
	/** The other rows, closed up: `top` is where each sits with no gap. */
	rest: DragRow[];
	/** Where each `rest` row was before the drag (same order). */
	restStart: number[];
	/** Height of the closed-up list. */
	restHeight: number;
	/** Where the block came from: its gap, and its folder. */
	homeGap: number;
	home: DragLevel;
}

export interface DragAim {
	/** The gap's index in `rest` (0 … rest.length). */
	gap: number;
	/** The folder a drop into that gap means. */
	level: DragLevel;
	/** The folder whose middle the line is on (a drop goes inside it). */
	over: string | null;
}

/** How much a row is indented per level (the rows' own padding step). */
export const INDENT_PX = 14;
/** The top and bottom quarter of a folder row mean "next to it"; the middle
 *  half means "inside it". */
export const EDGE_BAND = 0.25;
/** How long the line rests on a folder's middle before the folder lights and
 *  the gap closes, so crossing folders quickly doesn't make the list wobble. */
export const INTO_DWELL_MS = 110;
/** A folder just chosen for a gap holds until the line is clearly past its
 *  part of the gap (a quarter of a row), so a finger resting on the border
 *  between two folders doesn't flip between them. */
const LEVEL_STICK = 0.25;

const TOP_LEVEL: DragLevel = { parent: "", depth: 0 };

/** Splits the visible rows into the dragged block and the rest. Null when
 *  the row isn't in the list. */
export function planDrag(rows: readonly DragRow[], path: string): DragPlan | null {
	const start = rows.findIndex((r) => r.path === path);
	const head = rows[start];
	if (!head) return null;
	let end = start + 1;
	if (head.folder) while (end < rows.length && isWithinFolder(rows[end]!.path, path)) end += 1;
	const block = rows.slice(start, end);
	const last = block[block.length - 1]!;
	const blockHeight = last.top + last.height - head.top;
	const before = rows.slice(0, start);
	const after = rows.slice(end);
	const rest = [...before, ...after.map((r) => ({ ...r, top: r.top - blockHeight }))];
	const tail = rest[rest.length - 1];
	return {
		path,
		block,
		blockTop: head.top,
		blockHeight,
		headHeight: head.height,
		rest,
		restStart: [...before.map((r) => r.top), ...after.map((r) => r.top)],
		restHeight: tail ? tail.top + tail.height : 0,
		homeGap: start,
		home: { parent: head.parent, depth: head.depth },
	};
}

/** Top of the gap when it sits at `gap`. */
export function slotTop(plan: DragPlan, gap: number): number {
	const below = plan.rest[gap];
	return below ? below.top : plan.restHeight;
}

/** How far each `rest` row sits from where it started, with the gap at `gap`. */
export function rowShifts(plan: DragPlan, gap: number): number[] {
	return plan.rest.map((r, k) => r.top + (k >= gap ? plan.blockHeight : 0) - plan.restStart[k]!);
}

/**
 * The folders a drop into `gap` could mean, from the deepest (joining the
 * row above) to the shallowest (joining the row below).
 *
 * Right under a folder's own row the gap is inside that folder only when
 * its notes follow; under a folder showing nothing, the gap is next to it
 * (its middle is the way in). The exception is the item's own old place,
 * which always offers its own folder: an only note lifted out of its folder
 * and put straight back must stay there.
 */
export function gapLevels(plan: DragPlan, gap: number): DragLevel[] {
	const above = plan.rest[gap - 1];
	const below = plan.rest[gap];
	const deep: DragLevel = !above ? TOP_LEVEL : above.folder && below?.parent === above.path ? { parent: above.path, depth: above.depth + 1 } : { parent: above.parent, depth: above.depth };
	const shallow: DragLevel = below ? { parent: below.parent, depth: below.depth } : TOP_LEVEL;
	const out = [deep];
	for (let cur = deep; cur.depth > shallow.depth; ) {
		cur = { parent: folderOf(cur.parent), depth: cur.depth - 1 };
		out.push(cur);
	}
	if (gap === plan.homeGap && !out.some((l) => l.parent === plan.home.parent)) out.unshift(plan.home);
	return out;
}

function levelFor(plan: DragPlan, gap: number, probe: number, prev: DragAim | null): DragLevel {
	const levels = gapLevels(plan, gap);
	const top = slotTop(plan, gap);
	if (levels.length === 1) return levels[0]!;
	// Over the row above: join it. Over the row below: join that one.
	if (probe < top) return levels[0]!;
	if (probe > top + plan.blockHeight) return levels[levels.length - 1]!;
	// In its own old place the line keeps its own folder.
	if (gap === plan.homeGap) {
		const home = levels.find((l) => l.parent === plan.home.parent);
		if (home) return home;
	}
	// Inside the gap: the upper part joins the row above, the lower part the
	// row below. A gap is entered at its middle, so the first choice is the
	// folder ahead of the line, and it holds until the line clearly turns back.
	const span = plan.blockHeight / levels.length;
	const at = probe - top;
	if (prev && prev.gap === gap && prev.over === null) {
		const was = levels.findIndex((l) => l.parent === prev.level.parent);
		const stick = Math.min(plan.blockHeight, plan.headHeight) * LEVEL_STICK;
		if (was >= 0 && at > was * span - stick && at < (was + 1) * span + stick) return levels[was]!;
	}
	return levels[Math.min(levels.length - 1, Math.max(0, Math.floor(at / span)))]!;
}

/**
 * Where the line is aiming, from the centre of the dragged row (`probe`).
 * `shown` is the gap the rows are laid out for right now. `canEnter` says
 * whether the item may be dropped into a folder (not the one it is in).
 */
export function aimDrag(plan: DragPlan, probe: number, shown: number, prev: DragAim | null, canEnter: (folder: string) => boolean): DragAim {
	const n = plan.rest.length;
	const H = plan.blockHeight;
	const slot = slotTop(plan, shown);
	let gap = shown;
	let over: string | null = null;
	if (probe < slot && shown > 0) {
		// A row above the gap, shown at its closed-up place.
		let k = 0;
		for (let i = shown - 1; i >= 0; i--) {
			if (plan.rest[i]!.top <= probe) {
				k = i;
				break;
			}
		}
		({ gap, over } = onRow(plan.rest[k]!, k, Math.max(0, probe - plan.rest[k]!.top), false, canEnter));
	} else if (probe > slot + H && shown < n) {
		// A row below the gap, shown one block lower.
		let k = n;
		for (let i = shown; i < n; i++) {
			const r = plan.rest[i]!;
			if (probe < r.top + H + r.height) {
				k = i;
				break;
			}
		}
		if (k === n) gap = n; // below everything
		else ({ gap, over } = onRow(plan.rest[k]!, k, probe - (plan.rest[k]!.top + H), true, canEnter));
	}
	return { gap, over, level: levelFor(plan, gap, probe, prev) };
}

/** The line's centre is `into` pixels down a row: which side of it is the gap? */
function onRow(row: DragRow, index: number, into: number, belowGap: boolean, canEnter: (folder: string) => boolean): { gap: number; over: string | null } {
	const at = row.height > 0 ? into / row.height : 0;
	if (row.folder && canEnter(row.path)) {
		if (at < EDGE_BAND) return { gap: index, over: null };
		if (at > 1 - EDGE_BAND) return { gap: index + 1, over: null };
		// On its middle: the gap stays on the side the line came from.
		return { gap: belowGap ? index : index + 1, over: row.path };
	}
	return { gap: at < 0.5 ? index : index + 1, over: null };
}

/**
 * The gap to lay the rows out for while a folder is lit. No gap opens next
 * to a lit folder: the rows go back to where they started (the item's own
 * old place stays empty). The one exception is a folder that would itself
 * move by that; then the rows stay as they are.
 */
export function gapWhileOver(plan: DragPlan, folder: string, gap: number): number {
	const k = plan.rest.findIndex((r) => r.path === folder);
	if (k < 0) return gap;
	return k >= plan.homeGap === k >= gap ? plan.homeGap : gap;
}

/** Where a drop lands: the folder to move the item into, or null when it
 *  stays in the folder it is in. */
export function dropFolder(plan: DragPlan, aim: DragAim): string | null {
	const to = aim.over ?? aim.level.parent;
	return to === plan.home.parent ? null : to;
}

/** Keeps the line inside the list: not above its visible top (on a phone,
 *  the divider under the heading), not below its end or its visible bottom. */
export function clampLine(plan: DragPlan, lineTop: number, visibleTop: number, visibleBottom: number): number {
	const min = Math.max(0, visibleTop);
	const max = Math.max(min, Math.min(plan.restHeight + plan.blockHeight, visibleBottom) - plan.blockHeight);
	return Math.min(max, Math.max(min, lineTop));
}

/**
 * The point the rules read: the centre of the dragged row. Where the line
 * is held back at a limit, the pointer can pull that point on by up to half
 * a row, to the line's own edge. Without this the top quarter of the first
 * row could never be reached, and nothing could be put above Inbox.
 */
export function lineProbe(plan: DragPlan, wantedTop: number, lineTop: number): number {
	const half = plan.headHeight / 2;
	return lineTop + half + Math.max(-half, Math.min(half, wantedTop - lineTop));
}

/** Where the dropped item will sit after the move (for rows that changed path). */
export function movedPath(path: string, from: string, toFolder: string): string {
	const name = from.split("/").pop() ?? from;
	const to = toFolder ? `${toFolder}/${name}` : name;
	if (path === from) return to;
	return isWithinFolder(path, from) ? to + path.slice(from.length) : path;
}
