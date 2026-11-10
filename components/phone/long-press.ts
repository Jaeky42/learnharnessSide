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
 *   - only touch, only in the phone layout;
 *   - moving the finger (a scroll) cancels;
 *   - lifting the finger after a hold sends no tap, so the row isn't also
 *     opened and menus that close on an outside press stay open;
 *   - Android fires its own contextmenu on a long press. Whichever comes
 *     first wins and the other is swallowed, so the menu opens once.
 */

import { isPhoneNow } from "@/components/phone/use-phone";

export const HOLD_MS = 500;
/** How far (px) the finger may drift before the hold counts as a scroll. */
export const HOLD_SLOP = 10;

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
		target.dispatchEvent(
			new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y, button: 2 }),
		);
	};

	const onDown = (e: PointerEvent) => {
		cancelTimer();
		held = false;
		if (e.pointerType !== "touch" || !e.isPrimary || !isPhoneNow()) return;
		const hit = (e.target as Element | null)?.closest?.("[data-phone-press]") ?? null;
		if (!hit) return;
		row = hit;
		start = { x: e.clientX, y: e.clientY, id: e.pointerId };
		timer = setTimeout(fire, HOLD_MS);
	};
	const onMove = (e: PointerEvent) => {
		if (start && e.pointerId === start.id && !stillHolding(start, { x: e.clientX, y: e.clientY })) cancelTimer();
	};
	const onUp = () => cancelTimer();
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
		if (timer && row && e.target instanceof Node && row.contains(e.target)) {
			// Android's came first: let it open the menu and drop our timer.
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
	doc.addEventListener("click", onClick, opts);
	doc.addEventListener("contextmenu", onContextMenu, opts);
	return () => {
		cancelTimer();
		doc.removeEventListener("pointerdown", onDown, opts);
		doc.removeEventListener("pointermove", onMove, opts);
		doc.removeEventListener("pointerup", onUp, opts);
		doc.removeEventListener("pointercancel", onUp, opts);
		doc.removeEventListener("touchend", onTouchEnd, active);
		doc.removeEventListener("click", onClick, opts);
		doc.removeEventListener("contextmenu", onContextMenu, opts);
	};
}
