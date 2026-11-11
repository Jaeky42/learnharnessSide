/**
 * DRAGGING A ROW IN THE NOTES LIST: moving the rows on screen.
 *
 * The rules live in row-drag.ts; this file measures the list's rows when a
 * drag starts and then writes straight to their styles, one frame at a
 * time, so React doesn't re-render while a finger or the mouse moves:
 *   - the dragged rows follow the pointer (up and down only), kept inside
 *     the list;
 *   - the other rows slide to open the gap (a CSS transition on transform);
 *   - the line's indent follows the folder it would land in;
 *   - on a folder's middle the line turns a little smaller and see-through.
 *
 * Letting go: the line settles into the gap (or slips into the folder), the
 * move is made, and when the list comes back in its sorted order every row
 * slides from where it was to where it now belongs. A drop that changes
 * nothing, a refused move and Esc all slide everything back.
 *
 * notes-tree.tsx owns the row markup and the pointer events. Rows are found
 * by `data-drag-path`; folders carry `data-row-folder`, and every row its
 * `data-depth`.
 */

import { folderOf } from "@/src/core";
import { edgeScrollStep } from "@/components/phone/long-press";
import {
	aimDrag,
	clampLine,
	dropFolder,
	gapWhileOver,
	INDENT_PX,
	INTO_DWELL_MS,
	lineProbe,
	movedPath,
	planDrag,
	rowShifts,
	slotTop,
	type DragAim,
	type DragPlan,
	type DragRow,
} from "./row-drag";

export interface RowDragUi {
	/** The dragged item: its rows are drawn lifted. */
	path: string;
	/** The folder lit under the line. */
	over: string | null;
}

export interface RowDragHost {
	tree(): HTMLElement | null;
	/** May `from` be dropped into `folder`? */
	canEnter(from: string, folder: string): boolean;
	/** What the rows' classes follow. Called only when it changes. */
	setUi(ui: RowDragUi | null): void;
	/** Moves the item. Resolves true once the list shows the result. */
	move(from: string, toFolder: string): Promise<boolean>;
}

export interface RowDrag {
	active(): boolean;
	/** Starts dragging the row with this path from a pointer position. */
	start(path: string, x: number, y: number): boolean;
	move(x: number, y: number): void;
	/** The pointer was released. */
	end(): void;
	/** Puts everything back (Esc, a cancelled touch). */
	cancel(): void;
	/** Call after every render of the list. */
	afterRender(): void;
	destroy(): void;
}

const PART_MS = 180;
const SETTLE_MS = 200;
const SLIDE_MS = 260;
const EASE = "cubic-bezier(0.2, 0, 0, 1)";
/** How far the line tucks in from the left while it is over a lit folder. */
const INTO_TUCK = "30%";
/** If a move never answers, everything goes back after this long. */
const GIVE_UP_MS = 10_000;

interface Live {
	plan: DragPlan;
	block: HTMLElement[];
	blockPad: number[];
	rest: HTMLElement[];
	grab: number;
	x: number;
	y: number;
	lineTop: number;
	aim: DragAim;
	/** The gap the rows are laid out for. */
	shown: number;
	overFolder: string | null;
	overSince: number;
	/** The folder lit (the line has rested on it). */
	lit: string | null;
	frame: number;
	phase: "drag" | "back" | "wait" | "slide";
	timer: ReturnType<typeof setTimeout> | null;
	/** After the drop: where every row is shown, by the path it will have. */
	shownTops: Map<string, number> | null;
	moved: Set<string> | null;
	into: boolean;
}

function reducedMotion(): boolean {
	return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function rowElements(tree: HTMLElement): HTMLElement[] {
	return [...tree.querySelectorAll<HTMLElement>("[data-drag-path]")];
}

/** The list's visible rows, top to bottom, measured from the list's top. */
export function measureRows(tree: HTMLElement): { rows: DragRow[]; elements: HTMLElement[] } {
	const base = tree.getBoundingClientRect().top;
	const elements = rowElements(tree);
	const rows = elements.map((el): DragRow => {
		const box = el.getBoundingClientRect();
		const path = el.getAttribute("data-drag-path") ?? "";
		return {
			path,
			folder: el.hasAttribute("data-row-folder"),
			depth: Number(el.getAttribute("data-depth") ?? 0) || 0,
			parent: folderOf(path),
			top: box.top - base,
			height: box.height,
		};
	});
	return { rows, elements };
}

/** Everything a drag writes on a row, except its indent: React owns the
 *  rows' padding-left, so that one is put back, never removed. */
const STYLES = ["transform", "translate", "transition", "scale", "opacity", "margin-left", "clip-path", "border-radius", "will-change", "position", "z-index", "background-color", "box-shadow"] as const;
function clearStyles(el: HTMLElement): void {
	for (const name of STYLES) el.style.removeProperty(name);
}

export function createRowDrag(host: RowDragHost): RowDrag {
	let live: Live | null = null;
	const ms = (n: number) => (reducedMotion() ? 1 : n);

	const setPointerLook = (on: boolean) => {
		if (typeof document === "undefined") return;
		if (on) {
			document.body.style.setProperty("user-select", "none");
			document.body.style.setProperty("-webkit-user-select", "none");
		} else {
			document.body.style.removeProperty("user-select");
			document.body.style.removeProperty("-webkit-user-select");
		}
	};

	/** The list's visible part, measured from the list's top. */
	const visible = (tree: HTMLElement): { treeTop: number; top: number; bottom: number; box: DOMRect | null } => {
		const treeTop = tree.getBoundingClientRect().top;
		const scroller = tree.parentElement;
		if (!scroller) return { treeTop, top: 0, bottom: Number.POSITIVE_INFINITY, box: null };
		const box = scroller.getBoundingClientRect();
		return { treeTop, top: box.top - treeTop, bottom: box.bottom - treeTop, box };
	};

	const layRows = (d: Live, gap: number) => {
		if (gap === d.shown) return;
		d.shown = gap;
		const shifts = rowShifts(d.plan, gap);
		d.rest.forEach((el, k) => {
			const dy = shifts[k] ?? 0;
			el.style.transform = dy ? `translateY(${dy}px)` : "";
		});
	};

	/** The dragged rows move with `translate`, not `transform`: their `scale`
	 *  (smaller over a folder) would shrink a transform's distance too. */
	const placeBlock = (d: Live, top: number) => {
		const dy = Math.round((top - d.plan.blockTop) * 100) / 100;
		for (const el of d.block) el.style.translate = `0 ${dy}px`;
	};

	const indentBlock = (d: Live, depth: number) => {
		const by = (depth - d.plan.home.depth) * INDENT_PX;
		d.block.forEach((el, i) => {
			el.style.paddingLeft = `${Math.max(0, (d.blockPad[i] ?? 0) + by)}px`;
		});
	};

	const restoreIndent = (d: Live) => {
		d.block.forEach((el, i) => {
			el.style.paddingLeft = `${d.blockPad[i] ?? 0}px`;
		});
	};

	const lightFolder = (d: Live, folder: string | null) => {
		if (folder === d.lit) return;
		d.lit = folder;
		// Over a lit folder the line tucks in from the left, a little smaller and
		// see-through, so the folder's own name stays readable beside it.
		for (const el of d.block) {
			el.style.scale = folder ? "0.96" : "";
			el.style.opacity = folder ? "0.85" : "";
			el.style.marginLeft = folder ? INTO_TUCK : "";
		}
		host.setUi({ path: d.plan.path, over: folder });
	};

	const step = (d: Live, now: number) => {
		const tree = host.tree();
		if (!tree) return;
		let v = visible(tree);
		const scroller = tree.parentElement;
		if (v.box && scroller) {
			// Near the list's top or bottom edge it scrolls under the line.
			const by = edgeScrollStep(d.y, v.box.top, v.box.bottom);
			const before = scroller.scrollTop;
			if (by) scroller.scrollTop += by;
			if (scroller.scrollTop !== before) v = visible(tree);
		}
		const wanted = d.y - v.treeTop - d.grab;
		d.lineTop = clampLine(d.plan, wanted, v.top, v.bottom);
		const probe = lineProbe(d.plan, wanted, d.lineTop);
		d.aim = aimDrag(d.plan, probe, d.shown, d.aim, (folder) => host.canEnter(d.plan.path, folder));
		if (d.aim.over !== d.overFolder) {
			d.overFolder = d.aim.over;
			d.overSince = now;
		}
		const lit = d.aim.over && now - d.overSince >= INTO_DWELL_MS ? d.aim.over : null;
		layRows(d, lit ? gapWhileOver(d.plan, lit, d.aim.gap) : d.aim.gap);
		lightFolder(d, lit);
		if (!d.aim.over) indentBlock(d, d.aim.level.depth);
		placeBlock(d, d.lineTop);
	};
	const tick = () => {
		const d = live;
		if (!d || d.phase !== "drag") return;
		step(d, performance.now());
		d.frame = requestAnimationFrame(tick);
	};

	const finish = () => {
		const d = live;
		if (!d) return;
		if (d.timer) clearTimeout(d.timer);
		cancelAnimationFrame(d.frame);
		live = null;
		const tree = host.tree();
		if (tree) for (const el of rowElements(tree)) clearStyles(el);
		for (const el of [...d.block, ...d.rest]) clearStyles(el);
		restoreIndent(d);
		setPointerLook(false);
		host.setUi(null);
	};

	/** Everything slides back to where it started. */
	const back = (d: Live) => {
		cancelAnimationFrame(d.frame);
		if (d.timer) clearTimeout(d.timer);
		d.phase = "back";
		if (d.lit) host.setUi({ path: d.plan.path, over: null });
		d.lit = null;
		for (const el of d.block) {
			el.style.transition = `translate ${ms(SETTLE_MS)}ms ${EASE}, padding-left ${ms(SETTLE_MS)}ms ease, margin-left ${ms(SETTLE_MS)}ms ease, scale ${ms(SETTLE_MS)}ms ease, opacity ${ms(SETTLE_MS)}ms ease`;
			el.style.scale = "";
			el.style.opacity = "";
			el.style.marginLeft = "";
		}
		indentBlock(d, d.plan.home.depth);
		placeBlock(d, d.plan.blockTop);
		layRows(d, d.plan.homeGap);
		d.timer = setTimeout(finish, ms(SETTLE_MS) + 30);
	};

	/** The drop changes the item's folder: settle, move, then wait for the list. */
	const commit = (d: Live, toFolder: string) => {
		cancelAnimationFrame(d.frame);
		d.phase = "wait";
		d.into = d.aim.over !== null;
		const { plan } = d;
		const tops = new Map<string, number>();
		let blockTo: number;
		if (d.into && d.aim.over) {
			// Into a folder: the rows stay as they are, the line slips into the folder's row.
			const k = plan.rest.findIndex((r) => r.path === d.aim.over);
			const folder = plan.rest[k];
			blockTo = folder ? folder.top + (k >= d.shown ? plan.blockHeight : 0) : d.lineTop;
			if (d.lit !== d.aim.over) lightFolder(d, d.aim.over);
			for (const el of d.block) {
				el.style.transition = `translate ${ms(SETTLE_MS)}ms ${EASE}, scale ${ms(SETTLE_MS)}ms ease, opacity ${ms(SETTLE_MS)}ms ease`;
				el.style.scale = "0.9";
				el.style.opacity = "0";
			}
			for (const row of plan.block) tops.set(movedPath(row.path, plan.path, toFolder), blockTo);
		} else {
			layRows(d, d.aim.gap);
			blockTo = slotTop(plan, d.aim.gap);
			for (const el of d.block) el.style.transition = `translate ${ms(SETTLE_MS)}ms ${EASE}, padding-left ${ms(SETTLE_MS)}ms ease`;
			indentBlock(d, d.aim.level.depth);
			for (const row of plan.block) tops.set(movedPath(row.path, plan.path, toFolder), blockTo + (row.top - plan.blockTop));
		}
		placeBlock(d, blockTo);
		plan.rest.forEach((row, k) => tops.set(row.path, row.top + (k >= d.shown ? plan.blockHeight : 0)));
		d.shownTops = tops;
		d.moved = new Set(plan.block.map((row) => movedPath(row.path, plan.path, toFolder)));
		d.timer = setTimeout(() => {
			if (live === d && d.phase === "wait") back(d);
		}, GIVE_UP_MS);
		host.move(plan.path, toFolder).then(
			(ok) => {
				if (live !== d || d.phase !== "wait") return;
				if (!ok) return back(d);
				// The list has the result; afterRender() slides the rows once a
				// render shows it. Should none come, let go without a slide.
				let frames = 0;
				const wait = () => {
					if (live !== d || d.phase !== "wait") return;
					if (d.block.some((el) => !el.isConnected)) return slide(d);
					if (++frames > 45) return finish();
					requestAnimationFrame(wait);
				};
				requestAnimationFrame(wait);
			},
			() => {
				if (live === d && d.phase === "wait") back(d);
			},
		);
	};

	/** The list came back sorted: every row slides from where it was shown to
	 *  where it now belongs. */
	const slide = (d: Live) => {
		const tree = host.tree();
		if (!tree || !d.shownTops) return finish();
		if (d.timer) clearTimeout(d.timer);
		d.phase = "slide";
		const elements = rowElements(tree);
		for (const el of [...d.block, ...d.rest, ...elements]) clearStyles(el);
		restoreIndent(d);
		host.setUi(null);
		const base = tree.getBoundingClientRect().top;
		const moving: HTMLElement[] = [];
		for (const el of elements) {
			const path = el.getAttribute("data-drag-path") ?? "";
			const was = d.shownTops.get(path);
			const isMoved = d.moved?.has(path) ?? false;
			if (was === undefined) continue;
			const dy = was - (el.getBoundingClientRect().top - base);
			if (Math.abs(dy) < 0.5 && !isMoved) continue;
			el.style.transition = "none";
			el.style.transform = `translateY(${dy}px)`;
			if (isMoved) {
				// The dropped line stays on top, still looking lifted, while it travels.
				el.style.position = "relative";
				el.style.zIndex = "10";
				el.style.backgroundColor = "var(--popover)";
				el.style.boxShadow = "0 0 0 1px var(--border)";
				if (d.into) el.style.opacity = "0";
			}
			moving.push(el);
		}
		void tree.offsetHeight; // the starting positions are in place before the slide begins
		for (const el of moving) {
			el.style.transition = `transform ${ms(SLIDE_MS)}ms ${EASE}, opacity ${ms(SLIDE_MS)}ms ease`;
			el.style.transform = "";
			if (d.into) el.style.opacity = "";
		}
		d.timer = setTimeout(() => {
			for (const el of moving) {
				el.style.transition = `background-color ${ms(SETTLE_MS)}ms ease, box-shadow ${ms(SETTLE_MS)}ms ease`;
				el.style.removeProperty("background-color");
				el.style.removeProperty("box-shadow");
			}
			d.timer = setTimeout(finish, ms(SETTLE_MS) + 30);
		}, ms(SLIDE_MS) + 30);
	};

	return {
		active: () => live !== null,
		start(path, x, y) {
			if (live) return false;
			const tree = host.tree();
			if (!tree) return false;
			const { rows, elements } = measureRows(tree);
			const plan = planDrag(rows, path);
			if (!plan) return false;
			const byPath = new Map(rows.map((row, i) => [row.path, elements[i]!]));
			const block = plan.block.map((row) => byPath.get(row.path)!);
			const rest = plan.rest.map((row) => byPath.get(row.path)!);
			const treeTop = tree.getBoundingClientRect().top;
			const d: Live = {
				plan,
				block,
				blockPad: block.map((el) => Number.parseFloat(getComputedStyle(el).paddingLeft) || 0),
				rest,
				grab: y - treeTop - plan.blockTop,
				x,
				y,
				lineTop: plan.blockTop,
				aim: { gap: plan.homeGap, level: plan.home, over: null },
				shown: plan.homeGap,
				overFolder: null,
				overSince: 0,
				lit: null,
				frame: 0,
				phase: "drag",
				timer: null,
				shownTops: null,
				moved: null,
				into: false,
			};
			for (const el of rest) el.style.transition = `transform ${ms(PART_MS)}ms ${EASE}`;
			block.forEach((el, i) => {
				el.style.transition = `padding-left ${ms(150)}ms ease, margin-left ${ms(150)}ms ease, scale ${ms(150)}ms ease, opacity ${ms(150)}ms ease, box-shadow ${ms(150)}ms ease, background-color ${ms(150)}ms ease`;
				el.style.willChange = "translate";
				if (block.length === 1) return;
				// A folder with its rows is drawn as one piece: no edge or shadow
				// between its rows, and square corners where they meet.
				const first = i === 0;
				const last = i === block.length - 1;
				el.style.clipPath = `inset(${first ? "-40px" : "0"} -40px ${last ? "-40px" : "0"} -40px)`;
				if (!first) {
					el.style.borderTopLeftRadius = "0";
					el.style.borderTopRightRadius = "0";
				}
				if (!last) {
					el.style.borderBottomLeftRadius = "0";
					el.style.borderBottomRightRadius = "0";
				}
			});
			live = d;
			setPointerLook(true);
			host.setUi({ path, over: null });
			d.frame = requestAnimationFrame(tick);
			return true;
		},
		move(x, y) {
			if (!live || live.phase !== "drag") return;
			live.x = x;
			live.y = y;
		},
		end() {
			const d = live;
			if (!d || d.phase !== "drag") return;
			step(d, performance.now());
			const to = dropFolder(d.plan, d.aim);
			if (to === null) back(d);
			else commit(d, to);
		},
		cancel() {
			if (live && (live.phase === "drag" || live.phase === "wait")) back(live);
		},
		afterRender() {
			const d = live;
			if (!d) return;
			const gone = [...d.block, ...d.rest].some((el) => !el.isConnected);
			if (d.phase === "wait") {
				// The dragged row left its old place: the list now shows the move.
				if (d.block.some((el) => !el.isConnected)) slide(d);
				return;
			}
			// The list changed under a drag (a sync, say): let go of it.
			if (gone && d.phase !== "slide") finish();
		},
		destroy: finish,
	};
}
