/**
 * KEEP THE KEYBOARD (owner's decision, iPhone). With the keyboard up, a tap
 * on a button beside the box being typed in used to do nothing: a tap is
 * delivered as mousedown, mouseup and click in one task, the mousedown took
 * the focus off the box, the keyboard started to close, and the app took the
 * full height before the mouseup, so the button moved away from under the
 * finger and the click never reached it (phone-viewport.tsx waits one frame
 * for that now, so every tap lands).
 *
 * The owner's rule on top of that:
 *   - a tap on a control BESIDE the box being typed in acts and the keyboard
 *     stays up (the focus stays in the box);
 *   - a tap anywhere else acts and the keyboard closes, as it always did.
 *
 * "Beside" is the same bottom block: the lesson's dock (the message box, an
 * open question, their buttons and sliders) or the Tutor sheet's typing row
 * and its waiting-passage row. The Tutor's bubble is the exception: it opens
 * the sheet, so that tap acts and the keyboard closes.
 *
 * How, from what the owner's iPhone did on a test page: preventDefault() on a
 * button's mousedown kept the focus and the keyboard 7 of 7 times, with the
 * click still delivered. Dragging a range slider's knob never moves the focus
 * (it is touch-driven), but a TAP on a slider's line sends a mousedown and
 * takes the focus off the box. Preventing that mousedown also prevents the
 * slider's own jump to where it was pressed, so the value is set here from
 * the press point and announced like the slider's own change.
 *
 * One document listener, in the capture phase, touch phone layout only; it
 * stops nothing from propagating and listens to no touch events.
 */

import { typingTarget } from "@/components/phone/phone-viewport";
import { isTouchPhoneNow } from "@/components/phone/use-phone";

/** The bottom blocks: the lesson's dock, and the Tutor sheet's typing row and
 *  its passage row (siblings). */
export const KEEP_BLOCKS = '[data-phone="dock"], [data-phone="tutor-typing"]';
/** The bubble opens the Tutor's sheet: that tap acts and the keyboard closes. */
export const KEEP_EXCEPT = '[data-phone="tutor-bubble"]';
/** The confidence bar's knob, which the slider's own jump leaves a half of
 *  on each side. */
export const RANGE_THUMB_PX = 16;

function isTyping(el: Element): boolean {
	return typingTarget(el as unknown as { tagName: string; type?: string; isContentEditable?: boolean });
}

/** Does a press on `target` leave the keyboard up, with `focused` the box
 *  being typed in? Pure rule, exported for tests. */
export function keepsKeyboard(focused: Element | null, target: EventTarget | null): boolean {
	if (!focused || !isTyping(focused)) return false;
	const el = target as Element | null;
	if (!el || typeof el.closest !== "function") return false;
	const fb = focused.closest(KEEP_BLOCKS);
	const tb = el.closest(KEEP_BLOCKS);
	if (!fb || !tb) return false;
	if (fb !== tb && fb.parentElement !== tb.parentElement) return false;
	if (el.closest(KEEP_EXCEPT)) return false;
	// Something that takes typing itself behaves natively: the focused box,
	// another text box, a select, the notes editor.
	for (let node: Element | null = el; node; node = node.parentElement) {
		if (isTyping(node) || node.tagName.toUpperCase() === "SELECT" || node.classList?.contains("cm-editor")) return false;
		if (node === tb) break;
	}
	return true;
}

/** The value a slider's own jump would give for a press at `x`: the knob's
 *  centre follows the press, the value rounds to the step. Pure, exported. */
export function rangeValueAt(x: number, rect: { left: number; width: number }, min: number, max: number, step: number, thumb = RANGE_THUMB_PX): number {
	const ratio = Math.min(1, Math.max(0, (x - rect.left - thumb / 2) / Math.max(1, rect.width - thumb)));
	const unit = Number.isFinite(step) && step > 0 ? step : 1;
	const stepped = min + Math.round((ratio * (max - min)) / unit) * unit;
	return Math.min(max, Math.max(min, stepped));
}

/** Set a slider's value the way a person's change would reach React: through
 *  the native setter (React's value tracker ignores a plain assignment), then
 *  a bubbling input event. Only when the value changes. */
function pressRange(input: HTMLInputElement, x: number) {
	if (input.disabled) return;
	const number = (name: string, fallback: number) => {
		const raw = input.getAttribute(name);
		const n = raw === null || raw === "" ? NaN : Number(raw);
		return Number.isFinite(n) ? n : fallback;
	};
	const min = number("min", 0);
	const max = number("max", 100);
	const next = String(rangeValueAt(x, input.getBoundingClientRect(), min, max, number("step", 1)));
	if (input.value === next) return;
	const proto = Object.getPrototypeOf(input) as object;
	const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
	if (setter) setter.call(input, next);
	else input.value = next;
	const view = input.ownerDocument.defaultView as (Window & typeof globalThis) | null;
	const Ev = view?.Event ?? Event;
	input.dispatchEvent(new Ev("input", { bubbles: true }));
}

export function installKeepKeyboard(doc: Document = document): () => void {
	const onMouseDown = (e: MouseEvent) => {
		if (!isTouchPhoneNow()) return;
		if (!keepsKeyboard(doc.activeElement, e.target)) return;
		e.preventDefault();
		const target = e.target as Element;
		const range = target.closest?.('input[type="range"]') as HTMLInputElement | null;
		if (range) pressRange(range, e.clientX);
	};
	doc.addEventListener("mousedown", onMouseDown, { capture: true, passive: false });
	return () => doc.removeEventListener("mousedown", onMouseDown, { capture: true } as EventListenerOptions);
}
