/**
 * WHEN AND WHERE A SELECTION TOOLBAR SHOWS (2026-10-31; semantics follow
 * T3 Code's selection actions, MIT). A pointer gesture reports after the
 * mouse is released — 500 ms later for double/triple clicks, so the
 * selection can finish growing — and a frame after that, once layout has
 * settled. Keyboard selection reports on selectionchange. Escape, blur,
 * resize, a new press and scrolling dismiss; with restoreAfterScroll the
 * toolbar comes back once scrolling settles.
 *
 * Side-tutor fork: a touch or pen gesture (pointerType, per gesture) reports
 * once the selection has rested for TOUCH_SETTLE_MS with no finger down; iOS
 * sends no mouseup after a press-and-hold selection, and its handles send
 * only selectionchange. Once shown, the toolbar follows the selection: a
 * change reports again at the next frame and never hides it (owner's choice,
 * "Stays, follows"); a scroll hides it until scrolling settles. A press that starts on the toolbar keeps it (and its
 * captured passage) until that press and its click are over, because a tap
 * on iOS can clear the selection first. Mouse timing is unchanged. See
 * components/phone/touch-selection.ts.
 */

import { isTouchPointer as isTouchType, TOUCH_ACTION_RELEASE_MS, TOUCH_FINGER_WAIT_MS, TOUCH_SETTLE_MS, touchSelectionHere } from "./phone/touch-selection";

export type SelectionActionPoint = { x: number; y: number };
export type RectLike = { left: number; top: number; right: number; bottom: number };
export type SelectionDismissReason = "interaction" | "cancel";

const EDGE = 8;
const MULTI_CLICK_SETTLE_MS = 500;
const SCROLL_SETTLE_MS = 150;

export function resolveSelectionActionPosition({ bounds, selectionRect, pointer, viewport }: {
	bounds: RectLike;
	selectionRect: RectLike | null;
	pointer: SelectionActionPoint | null;
	viewport: { width: number; height: number };
}): SelectionActionPoint {
	const preferred = pointer
		?? (selectionRect ? { x: selectionRect.right, y: selectionRect.bottom + 4 } : { x: bounds.right - 140, y: bounds.top + 12 });
	const minX = Math.max(bounds.left, 0) + EDGE;
	const maxX = Math.min(bounds.right, viewport.width) - EDGE;
	const minY = Math.max(bounds.top, 0) + EDGE;
	const maxY = Math.min(bounds.bottom, viewport.height) - EDGE;
	return {
		x: Math.min(Math.max(preferred.x, minX), Math.max(minX, maxX)),
		y: Math.min(Math.max(preferred.y, minY), Math.max(minY, maxY)),
	};
}

export function isSelectionRectVisible(rect: RectLike, clips: readonly RectLike[]): boolean {
	let { left, top, right, bottom } = rect;
	for (const clip of clips) {
		left = Math.max(left, clip.left);
		top = Math.max(top, clip.top);
		right = Math.min(right, clip.right);
		bottom = Math.min(bottom, clip.bottom);
	}
	return right > left && bottom > top;
}

export function observeSelectionActions({ element, getActionElement, restoreAfterScroll, onSelection, onDismiss }: {
	element: HTMLElement;
	getActionElement: () => HTMLElement | null;
	restoreAfterScroll: boolean;
	/** Side-tutor fork: `touch` is true when a touch or pen gesture made the
	 *  selection (the toolbar is then placed by touch rules). */
	onSelection: (pointer: SelectionActionPoint | null, touch?: boolean) => void;
	onDismiss: (reason: SelectionDismissReason) => void;
}): { selectionChanged: () => void; cancel: () => void; dispose: () => void } {
	const view = element.ownerDocument.defaultView!;
	const document = element.ownerDocument;
	let pointerDown = false;
	let gesture = false;
	let shown = false;
	let timer: number | undefined;
	let frame: number | undefined;
	let scrollTimer: number | undefined;
	// Side-tutor fork (touch): the last gesture was a touch or pen; the
	// fingers down (not on the toolbar) and when the last went down; a press
	// on the toolbar, and whether the selection changed under it.
	let touch = false;
	const fingers = new Set<number>();
	let fingerAt = 0;
	let actionPress: number | null = null;
	let actionTimer: number | undefined;
	let changedInPress = false;
	// Shown for a touch selection, and not dismissed since: the toolbar then
	// follows the selection instead of settling again.
	let following = false;
	// In a browser only: in the desktop app (a touch-screen PC too) every
	// gesture keeps upstream's behaviour.
	const touchHere = touchSelectionHere(view);
	const isTouchPointer = (event: { pointerType?: string }) => touchHere && isTouchType(event);

	const clearPending = () => {
		if (timer !== undefined) view.clearTimeout(timer);
		if (frame !== undefined) view.cancelAnimationFrame(frame);
		timer = frame = undefined;
	};
	const schedule = (delay: number, pointer: SelectionActionPoint | null) => {
		clearPending();
		timer = view.setTimeout(() => {
			timer = undefined;
			frame = view.requestAnimationFrame(() => {
				frame = undefined;
				shown = true;
				onSelection(pointer);
			});
		}, delay);
	};
	// Side-tutor fork (touch): show once the selection has rested and no
	// finger is down (a finger that never reported lifting holds it back at
	// most TOUCH_FINGER_WAIT_MS).
	const settleTouch = () => {
		clearPending();
		const check = () => {
			timer = undefined;
			if (fingers.size > 0 && Date.now() - fingerAt < TOUCH_FINGER_WAIT_MS) { timer = view.setTimeout(check, TOUCH_SETTLE_MS); return; }
			fingers.clear();
			frame = view.requestAnimationFrame(() => {
				frame = undefined;
				shown = true;
				following = true;
				onSelection(null, true);
			});
		};
		timer = view.setTimeout(check, TOUCH_SETTLE_MS);
	};
	// Side-tutor fork (touch): placed again for the selection as it is now, at
	// the next frame (at most once a frame), without hiding it first.
	const followTouch = () => {
		clearPending();
		frame = view.requestAnimationFrame(() => {
			frame = undefined;
			shown = true;
			following = true;
			onSelection(null, true);
		});
	};
	const endActionPress = () => {
		if (actionTimer !== undefined) view.clearTimeout(actionTimer);
		actionTimer = undefined;
		if (actionPress === null) return;
		actionPress = null;
		if (!changedInPress) return;
		changedInPress = false;
		if (following) { followTouch(); return; }
		if (shown) dismiss("cancel");
		settleTouch();
	};
	const dismiss = (reason: SelectionDismissReason, keepFollowing = false) => {
		clearPending();
		shown = false;
		if (!keepFollowing) following = false;
		onDismiss(reason);
	};
	const onAction = (target: EventTarget | null) => {
		const action = getActionElement();
		return !!action && target instanceof view.Node && action.contains(target);
	};

	const pointerDownCapture = (event: PointerEvent) => {
		if (onAction(event.target)) {
			clearPending();
			// Side-tutor fork (touch): hold the toolbar through this press.
			if (isTouchPointer(event)) { endActionPress(); actionPress = event.pointerId; changedInPress = false; }
			return;
		}
		if (shown || timer !== undefined) dismiss("interaction");
		// Side-tutor fork (touch): a touch or pen never sets pointerDown; it
		// is never cleared on iOS (no mouseup) and blocked the toolbar for good.
		touch = isTouchPointer(event);
		if (touch) { fingers.add(event.pointerId); fingerAt = Date.now(); gesture = false; return; }
		pointerDown = true;
		const target = event.target as Element | null;
		gesture = event.button === 0 && !event.defaultPrevented && element.contains(target) && !target?.closest("button, [role=button]");
	};
	const mouseUp = (event: MouseEvent) => {
		pointerDown = false;
		if (!gesture || event.button !== 0) return;
		gesture = false;
		schedule(event.detail >= 2 ? MULTI_CLICK_SETTLE_MS : 0, { x: event.clientX, y: event.clientY });
	};
	// Side-tutor fork (touch): a finger lifting, or the system taking it (a
	// press-and-hold selection, a scroll).
	const pointerUp = (event: PointerEvent) => {
		if (!isTouchPointer(event)) return;
		if (event.pointerId === actionPress) {
			if (actionTimer !== undefined) view.clearTimeout(actionTimer);
			actionTimer = view.setTimeout(endActionPress, TOUCH_ACTION_RELEASE_MS);
			return;
		}
		if (!fingers.delete(event.pointerId)) return;
		// A tap on the selection itself changes nothing: look again.
		if (event.type === "pointerup" && !shown && timer === undefined && frame === undefined) settleTouch();
	};
	const actionClick = (event: MouseEvent) => {
		if (actionPress !== null && onAction(event.target)) view.setTimeout(endActionPress, 0);
	};
	const keyDown = (event: KeyboardEvent) => {
		if (event.key === "Escape") { if (shown || timer !== undefined) dismiss("cancel"); return; }
		pointerDown = false;
		touch = false; // Side-tutor fork: keyboard selection reports as upstream's
	};
	const cancel = () => { if (shown || timer !== undefined) dismiss("cancel"); };
	// Side-tutor fork (touch): the system taking a touch (a press-and-hold
	// selection) must not drop a selection that is settling.
	const pointerCancel = (event: PointerEvent) => {
		if (!isTouchPointer(event)) { cancel(); return; }
		const again = shown || fingers.has(event.pointerId);
		pointerUp(event);
		if (shown) dismiss("cancel");
		if (again) settleTouch();
	};
	// Side-tutor fork (touch): Android fires contextmenu on a long press,
	// then selects; look again once the selection rests.
	const contextMenu = () => { dismiss("interaction"); if (touch) settleTouch(); };
	const focusIn = (event: FocusEvent) => { if (shown && !onAction(event.target)) dismiss("interaction"); };
	const scroll = () => {
		if (pointerDown) return; // autoscroll while dragging keeps the gesture
		// Side-tutor fork (touch): a touch selection still settling (a scroll
		// cancelled its touch first) comes back too.
		// A toolbar that was following (a handle dragged to the lesson's edge
		// autoscrolls) is hidden while the lesson moves and placed again as soon
		// as scrolling settles, with no settle wait on top.
		const wasShown = shown || (touch && (timer !== undefined || following));
		if (shown || timer !== undefined) dismiss("cancel", touch && following);
		if (!restoreAfterScroll || !wasShown) return;
		if (scrollTimer !== undefined) view.clearTimeout(scrollTimer);
		scrollTimer = view.setTimeout(() => { scrollTimer = undefined; if (touch && following) followTouch(); else if (touch) settleTouch(); else schedule(0, null); }, SCROLL_SETTLE_MS);
	};

	document.addEventListener("pointerdown", pointerDownCapture, true);
	document.addEventListener("mouseup", mouseUp, true);
	document.addEventListener("pointerup", pointerUp, true);
	document.addEventListener("click", actionClick);
	document.addEventListener("keydown", keyDown, true);
	document.addEventListener("focusin", focusIn, true);
	element.addEventListener("contextmenu", contextMenu);
	element.addEventListener("scroll", scroll, true);
	view.addEventListener("pointercancel", pointerCancel);
	view.addEventListener("blur", cancel);
	view.addEventListener("resize", cancel);

	return {
		selectionChanged() {
			// Side-tutor fork (touch): a press on the toolbar keeps it; once
			// shown it follows a handle drag (hidden while the lesson scrolls);
			// before that, the selection must rest first.
			if (actionPress !== null) { changedInPress = true; return; }
			if (touch && following) { if (scrollTimer === undefined) followTouch(); return; }
			if (touch) { if (shown) dismiss("cancel"); settleTouch(); return; }
			if (pointerDown) { if (shown) dismiss("cancel"); return; }
			if (timer === undefined && frame === undefined) schedule(0, null);
		},
		cancel() { clearPending(); shown = false; following = false; },
		dispose() {
			clearPending();
			if (scrollTimer !== undefined) view.clearTimeout(scrollTimer);
			if (actionTimer !== undefined) view.clearTimeout(actionTimer);
			document.removeEventListener("pointerdown", pointerDownCapture, true);
			document.removeEventListener("mouseup", mouseUp, true);
			document.removeEventListener("pointerup", pointerUp, true);
			document.removeEventListener("click", actionClick);
			document.removeEventListener("keydown", keyDown, true);
			document.removeEventListener("focusin", focusIn, true);
			element.removeEventListener("contextmenu", contextMenu);
			element.removeEventListener("scroll", scroll, true);
			view.removeEventListener("pointercancel", pointerCancel);
			view.removeEventListener("blur", cancel);
			view.removeEventListener("resize", cancel);
		},
	};
}
