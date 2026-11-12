/**
 * PALM REJECTION ON THE DRAWING PAD (owner's iPad). The pad draws from the
 * Apple Pencil's pointer events and ignores fingers, but it doesn't stop
 * them: a palm resting on the pad is a finger held down, and Safari turned
 * that into a text selection, one big box over the pad that the Pencil
 * couldn't draw through or tap away. Three parts, in the fork's own files so
 * upstream's Drawing Pad stays as it is:
 *
 *  - app/touch.css: the pad and the frame around it can't be selected, and
 *    iOS's press-and-hold menu is off there;
 *  - this listener: a finger or palm touch that lands on the pad's drawing
 *    area is cancelled from the moment it lands until it lifts (no press and
 *    hold, no magnifier, no selection). The Pencil is never cancelled, and a
 *    touch that carries the Pencil and a palm together is left alone. The
 *    pad's buttons and its ✕ still take a finger tap;
 *  - any touch on the drawing area, finger or Pencil, clears a selection of
 *    page text, so a stuck one goes at the next touch. Not while the cursor
 *    is in a text box (the Tutor's typing box).
 *
 * Fingers already did nothing on the drawing area (even the Hand tool reads
 * only the mouse and the Pencil), so nothing is lost. In a browser only,
 * never in the desktop app. It finds the pad by upstream's class names;
 * tests/pad-palm.test.ts fails if upstream renames them.
 */

import { isBrowserNow } from "@/components/phone/use-phone";
import { isPencilTouch } from "@/components/phone/use-dock-touch-scroll";

/** The pad's drawing area (upstream's plugins/drawing-pad/src/sheet.ts): the
 *  sheet and the ink on it, not its toolbar. */
export const PAD_DRAWING_AREA = ".drawing-pad-viewport";

function onDrawingArea(target: EventTarget | null): boolean {
	return target instanceof Element && target.closest(PAD_DRAWING_AREA) !== null;
}

function typingNow(doc: Document): boolean {
	const el = doc.activeElement;
	if (!(el instanceof Element)) return false;
	return (el as HTMLElement).isContentEditable === true || /^(input|textarea|select)$/i.test(el.tagName);
}

function clearSelection(doc: Document): void {
	if (typingNow(doc)) return;
	const selection = doc.getSelection?.();
	if (selection && selection.rangeCount > 0) selection.removeAllRanges();
}

export function installPadPalm(doc: Document = document): () => void {
	// The fingers this listener cancelled, by touch identifier, until they lift.
	const cancelled = new Set<number>();
	const onStart = (e: TouchEvent) => {
		if (!isBrowserNow() || !onDrawingArea(e.target)) return;
		clearSelection(doc);
		const touches = Array.from(e.changedTouches ?? e.touches ?? []);
		if (touches.length === 0 || touches.some(isPencilTouch)) return;
		for (const t of touches) cancelled.add(t.identifier);
		if (e.cancelable) e.preventDefault();
	};
	const onMove = (e: TouchEvent) => {
		if (cancelled.size === 0) return;
		const touches = Array.from(e.changedTouches ?? []);
		if (touches.length > 0 && touches.every((t) => cancelled.has(t.identifier)) && e.cancelable) e.preventDefault();
	};
	const onEnd = (e: TouchEvent) => {
		for (const t of Array.from(e.changedTouches ?? [])) cancelled.delete(t.identifier);
		if (!e.touches || e.touches.length === 0) cancelled.clear();
	};
	// A pen that sends no touch events (a pen on a Windows tablet in a
	// browser) still clears a stuck selection.
	const onPointer = (e: PointerEvent) => {
		if (e.pointerType === "pen" && isBrowserNow() && onDrawingArea(e.target)) clearSelection(doc);
	};
	doc.addEventListener("touchstart", onStart, { passive: false, capture: true });
	doc.addEventListener("touchmove", onMove, { passive: false, capture: true });
	doc.addEventListener("touchend", onEnd, { capture: true });
	doc.addEventListener("touchcancel", onEnd, { capture: true });
	doc.addEventListener("pointerdown", onPointer, { passive: true, capture: true });
	return () => {
		doc.removeEventListener("touchstart", onStart, { capture: true });
		doc.removeEventListener("touchmove", onMove, { capture: true });
		doc.removeEventListener("touchend", onEnd, { capture: true });
		doc.removeEventListener("touchcancel", onEnd, { capture: true });
		doc.removeEventListener("pointerdown", onPointer, { capture: true });
	};
}
