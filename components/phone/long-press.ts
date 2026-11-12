/**
 * PRESS AND HOLD (cloud sync Phase 3, owner decision): a phone has no
 * right-click, so holding a finger on a session, note or folder row for
 * about half a second opens the same menu right-click opens on the desktop.
 *
 * Rows opt in with data-phone-press. One document-level listener turns a
 * held touch into a "contextmenu" event on the row, so each row's existing
 * onContextMenu handler opens its menu; no row code changes.
 *
 * Details that matter:
 *   - only touch, and only in a browser: the phone layout, and a tablet
 *     with the computer layout (owner's choice); never the desktop app;
 *   - moving the finger (a scroll) cancels;
 *   - lifting the finger after a hold sends no tap, so the row isn't also
 *     opened and menus that close on an outside press stay open;
 *   - Android fires its own contextmenu on a long press. Whichever comes
 *     first wins and the other is swallowed, so the menu opens once.
 *
 * HOLD, THEN MOVE (owner's choice for dragging notes into folders): rows
 * that also carry data-phone-drag can be dragged with the same touch. Once
 * the hold has opened the menu, moving the finger past the slop announces
 * a drag (HOLD_DRAG_EVENT on the document: start, move, end or cancel), and
 * the page is kept from scrolling under it. Lifting without moving leaves
 * the menu open, as before. The row's owner does the rest (notes-tree.tsx).
 */

import { isBrowserNow } from "@/components/phone/use-phone";

export const HOLD_MS = 500;
/** How far (px) the finger may drift before the hold counts as a scroll. */
export const HOLD_SLOP = 10;

export const HOLD_DRAG_EVENT = "lh-hold-drag";
export interface HoldDragDetail {
	phase: "start" | "move" | "end" | "cancel";
	x: number;
	y: number;
	/** The row that was held. */
	row: Element;
}

/** How fast (px per frame) a list scrolls while a dragged row is held near
 *  its top or bottom edge: nothing in the middle, faster towards the edge.
 *  Pure, exported for tests. */
export function edgeScrollStep(y: number, top: number, bottom: number, zone = 56, max = 14): number {
	if (bottom - top < zone * 2) return 0;
	if (y < top + zone) return -Math.ceil(max * Math.min(1, (top + zone - y) / zone));
	if (y > bottom - zone) return Math.ceil(max * Math.min(1, (y - (bottom - zone)) / zone));
	return 0;
}

/** Pure rule, exported for tests: is this still a hold, not a scroll? */
export function stillHolding(start: { x: number; y: number }, now: { x: number; y: number }): boolean {
	return Math.hypot(now.x - start.x, now.y - start.y) <= HOLD_SLOP;
}

export function installLongPress(doc: Document = document): () => void {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let start: { x: number; y: number; id: number } | null = null;
	let row: Element | null = null;
	/** This touch already opened a menu: what the finger does next belongs to
	 *  the hold, not to the page. Cleared when the next touch starts. */
	let held = false;
	/** Where a hold fired on a draggable row; moving away from it is a drag. */
	let heldAt: { x: number; y: number; id: number; row: Element } | null = null;
	let dragging = false;

	const emit = (phase: HoldDragDetail["phase"], at: { x: number; y: number }) => {
		if (!heldAt) return;
		doc.dispatchEvent(new CustomEvent<HoldDragDetail>(HOLD_DRAG_EVENT, { detail: { phase, x: at.x, y: at.y, row: heldAt.row } }));
	};
	const endDrag = (phase: "end" | "cancel", at: { x: number; y: number }) => {
		if (dragging) emit(phase, at);
		heldAt = null;
		dragging = false;
	};

	const cancelTimer = () => {
		if (timer) clearTimeout(timer);
		timer = null;
		start = null;
		row = null;
	};

	const fire = () => {
		const target = row;
		const at = start;
		cancelTimer();
		if (!target || !at) return;
		held = true;
		heldAt = target.hasAttribute("data-phone-drag") ? { x: at.x, y: at.y, id: at.id, row: target } : null;
		target.dispatchEvent(
			new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y, button: 2 }),
		);
	};

	const onDown = (e: PointerEvent) => {
		cancelTimer();
		endDrag("cancel", { x: e.clientX, y: e.clientY });
		held = false;
		// Any touch screen in a browser: a phone, and a tablet with the computer
		// layout, which has no right-click either (owner's choice). Never the desktop app.
		if (e.pointerType !== "touch" || !e.isPrimary || !isBrowserNow()) return;
		const hit = (e.target as Element | null)?.closest?.("[data-phone-press]") ?? null;
		if (!hit) return;
		row = hit;
		start = { x: e.clientX, y: e.clientY, id: e.pointerId };
		timer = setTimeout(fire, HOLD_MS);
	};
	const onMove = (e: PointerEvent) => {
		const now = { x: e.clientX, y: e.clientY };
		if (start && e.pointerId === start.id && !stillHolding(start, now)) cancelTimer();
		if (heldAt && e.pointerId === heldAt.id) {
			if (!dragging && !stillHolding(heldAt, now)) {
				dragging = true;
				emit("start", now);
			} else if (dragging) emit("move", now);
		}
	};
	const onUp = (e: PointerEvent) => {
		cancelTimer();
		if (heldAt && e.pointerId === heldAt.id) endDrag(e.type === "pointercancel" ? "cancel" : "end", { x: e.clientX, y: e.clientY });
	};
	// After a hold on a draggable row the finger belongs to the drag: the page
	// must not scroll under it. Decided on the first movement, before the
	// browser starts a scroll of its own (it can't be stopped once started).
	const onTouchMove = (e: TouchEvent) => {
		if (heldAt && e.cancelable) e.preventDefault();
	};
	// Lifting the finger after a hold: cancel the simulated mouse press and
	// tap the browser would send next. Without this the tap opens the row
	// and the mouse press closes menus that close on any outside press.
	const onTouchEnd = (e: TouchEvent) => {
		if (held && e.cancelable) e.preventDefault();
	};
	// Fallback for browsers that send the tap anyway.
	const onClick = (e: MouseEvent) => {
		if (!held) return;
		held = false;
		e.preventDefault();
		e.stopPropagation();
	};
	const onContextMenu = (e: MouseEvent) => {
		if (!e.isTrusted) return; // our own event: let it through
		if (held) {
			// Android's own long-press menu after ours: the menu is already open.
			e.preventDefault();
			e.stopPropagation();
			return;
		}
		if (timer && row && start && e.target instanceof Node && row.contains(e.target)) {
			// Android's came first: let it open the menu and drop our timer.
			heldAt = row.hasAttribute("data-phone-drag") ? { x: start.x, y: start.y, id: start.id, row } : null;
			cancelTimer();
			held = true;
		}
	};

	const opts = { capture: true } as const;
	const active = { capture: true, passive: false } as const;
	doc.addEventListener("pointerdown", onDown, opts);
	doc.addEventListener("pointermove", onMove, opts);
	doc.addEventListener("pointerup", onUp, opts);
	doc.addEventListener("pointercancel", onUp, opts);
	doc.addEventListener("touchend", onTouchEnd, active);
	doc.addEventListener("touchmove", onTouchMove, active);
	doc.addEventListener("click", onClick, opts);
	doc.addEventListener("contextmenu", onContextMenu, opts);
	return () => {
		cancelTimer();
		doc.removeEventListener("touchmove", onTouchMove, active);
		doc.removeEventListener("pointerdown", onDown, opts);
		doc.removeEventListener("pointermove", onMove, opts);
		doc.removeEventListener("pointerup", onUp, opts);
		doc.removeEventListener("pointercancel", onUp, opts);
		doc.removeEventListener("touchend", onTouchEnd, active);
		doc.removeEventListener("click", onClick, opts);
		doc.removeEventListener("contextmenu", onContextMenu, opts);
	};
}
