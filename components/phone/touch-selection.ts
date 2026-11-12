/**
 * HIGHLIGHT, THEN ASK ON A TOUCH SCREEN (fork-owned; owner's iPhone and
 * iPad). Upstream's selection toolbar (Cite, Ask) reports a selection when
 * the mouse is released. A press-and-hold selection on iOS sends pointerdown,
 * then the system takes the touch (pointercancel), and never a mouseup; the
 * selection handles send the page nothing but selectionchange. So the
 * toolbar never showed on a phone or a tablet, only the system's own
 * Copy / Look Up box did.
 *
 * On a touch or pen gesture (decided per gesture from pointerType, never
 * from the screen width: an iPad has the computer layout, a touch-screen PC
 * has a mouse too) components/selection-actions.ts now shows the toolbar
 * once the selection has rested for TOUCH_SETTLE_MS with no finger down,
 * and components/selection-toolbar.tsx places it with
 * resolveTouchSelectionPosition below. The system's box stays as it is (a
 * page can neither replace it nor add to it).
 *
 * WHERE (owner's choice: "opposite side", over a fixed bar above the message
 * box and over always below the selection). A page can't see where iOS puts
 * its box, so it is predicted from the owner's measurements (iPhone,
 * home-screen app, 956 points tall): iOS puts its box on the side with more
 * room, i.e. BELOW the selection when the selection's vertical centre is
 * above the middle of the visible screen, ABOVE otherwise. The app's
 * buttons go on the other side:
 *
 *  - system box below → buttons above the START of the selection, from the
 *    first line's left end;
 *  - system box above → buttons below the END, from the last line's right
 *    end;
 *  - both TOUCH_HANDLE_GAP away from the text, clear of iOS's handle knobs
 *    (each about 14 points beyond its line);
 *  - no room on that side (the selection starts right under the top bar, or
 *    ends right above the dock) → the system box's side, beyond the box
 *    (SYSTEM_BOX_CLEARANCE from the text);
 *  - no room there either → under the end, clamped inside the lesson and the
 *    visible screen, as the computer's toolbar is clamped.
 *
 * The box is centred on the selection and nearly as wide as the screen, so
 * the buttons never try to sit beside it.
 */

import type { RectLike, SelectionActionPoint } from "../selection-actions";

/** How long a touch selection must stop changing before the toolbar shows. */
export const TOUCH_SETTLE_MS = 300;

/** A finger that went down and never reported lifting (no pointerup, no
 *  pointercancel) holds the toolbar back at most this long. */
export const TOUCH_FINGER_WAIT_MS = 1500;

/** After a press on the toolbar ends, how long its click may take to land
 *  before a selection that changed during the press is looked at again. */
export const TOUCH_ACTION_RELEASE_MS = 400;

/** Space between the selected text and the buttons on touch: clears iOS's
 *  selection-handle knobs (about 12 points beyond the first and last line,
 *  from the owner's screenshots). 24 at first; owner: "a tiny bit closer".
 *  The computer keeps its 4 px under the end. */
export const TOUCH_HANDLE_GAP = 18;

/** Where the system's box switches sides: the selection's vertical centre
 *  against this fraction of the visible height (owner's iPhone: the switch
 *  lies between 464 and 550 of 956 points). */
export const SYSTEM_BOX_SWITCH = 0.5;

/** From the selected text to beyond the system's box, on the box's side:
 *  the box is about 43 points tall and sits 15 to 19 points from the text. */
export const SYSTEM_BOX_CLEARANCE = 70;

/** The buttons on a touch selection (owner: "a little bigger", after seeing
 *  screenshots): 32 px tall instead of the computer's 24, 15 px text, a
 *  16 px icon and a little more side padding. Same look otherwise. Merged
 *  over the `xs` size by the Button's class merge. */
export const TOUCH_BUTTON_CLASS = "h-8 gap-1.5 px-3 has-[>svg]:px-3 text-[15px] [&_svg]:size-4";

/** The toolbar's height before it has been measured (one row of buttons in
 *  TOUCH_BUTTON_CLASS, h-8). */
export const TOUCH_TOOLBAR_HEIGHT = 32;

const EDGE = 8;

export function isTouchPointer(event: { pointerType?: string }): boolean {
	return event.pointerType === "touch" || event.pointerType === "pen";
}

/** Pure rule: is the system's box predicted below the selection? */
export function systemBoxBelow(firstLine: RectLike, lastLine: RectLike, visible: { top: number; height: number }): boolean {
	const centre = (firstLine.top + lastLine.bottom) / 2;
	return centre < visible.top + visible.height * SYSTEM_BOX_SWITCH;
}

/** Pure rule: the toolbar's top-left corner for a touch selection. */
export function resolveTouchSelectionPosition({ bounds, firstLine, lastLine, visible, toolbarHeight = TOUCH_TOOLBAR_HEIGHT, viewportWidth }: {
	/** The lesson's box. */
	bounds: RectLike;
	firstLine: RectLike;
	lastLine: RectLike;
	/** The visible screen, in the page's client coordinates. */
	visible: { top: number; height: number };
	toolbarHeight?: number;
	viewportWidth: number;
}): SelectionActionPoint & { side: "above-start" | "below-end" | "clamped" } {
	const minX = Math.max(bounds.left, 0) + EDGE;
	const maxX = Math.min(bounds.right, viewportWidth) - EDGE;
	const minY = Math.max(bounds.top, visible.top, 0) + EDGE;
	const maxY = Math.min(bounds.bottom, visible.top + visible.height) - EDGE;
	const clampX = (x: number) => Math.min(Math.max(x, minX), Math.max(minX, maxX));
	const above = (gap: number) => ({ x: clampX(firstLine.left), y: firstLine.top - gap - toolbarHeight });
	const below = (gap: number) => ({ x: clampX(lastLine.right), y: lastLine.bottom + gap });
	const fits = (p: { y: number }) => p.y >= minY && p.y + toolbarHeight <= maxY;
	const order = systemBoxBelow(firstLine, lastLine, visible)
		? [{ side: "above-start" as const, at: above(TOUCH_HANDLE_GAP) }, { side: "below-end" as const, at: below(SYSTEM_BOX_CLEARANCE) }]
		: [{ side: "below-end" as const, at: below(TOUCH_HANDLE_GAP) }, { side: "above-start" as const, at: above(SYSTEM_BOX_CLEARANCE) }];
	for (const choice of order) if (fits(choice.at)) return { ...choice.at, side: choice.side };
	const fallback = below(TOUCH_HANDLE_GAP);
	return { x: fallback.x, y: Math.min(Math.max(fallback.y, minY), Math.max(minY, maxY - toolbarHeight)), side: "clamped" };
}

/** The visible screen as the app already measures it: on a phone the
 *  height behind --lh-vvh (components/phone/phone-viewport.tsx; in the
 *  home-screen app it includes the clock strip the iPhone leaves out of
 *  innerHeight), elsewhere the visual viewport, then innerHeight. */
export function visibleScreen(win: Window): { top: number; height: number } {
	const vv = win.visualViewport;
	const top = vv ? Math.max(0, vv.offsetTop) : 0;
	const vvh = parseFloat(win.document.documentElement.style.getPropertyValue("--lh-vvh"));
	const height = Number.isFinite(vvh) && vvh > 0 ? vvh : vv?.height ?? win.innerHeight;
	return { top, height };
}
