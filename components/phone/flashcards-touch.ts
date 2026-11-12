/**
 * FLASHCARDS ON A PHONE: the touch behaviour CSS can't give
 * (docs/phone-plugins-plan.md, decisions 5b and 5c and "The keyboard").
 * The look is app/phone-flashcards.css. Nothing here edits the plugin's
 * files: it works on the page the plugin and the host render.
 *
 *   - PRESS AND HOLD on a deck list row opens that row's own ⚙ menu. Rows
 *     that have a ⚙ are marked data-phone-press="flashcards", so the fork's
 *     one hold (long-press.ts, about half a second) turns a held finger into
 *     a contextmenu event on the row, and lifting the finger afterwards sends
 *     no tap (the card doesn't open, a rename doesn't start). The contextmenu
 *     is answered here by pressing the row's ⚙. No dragging.
 *   - THE RENAME ✕: while a deck's rename box is open, a small ✕ sits at its
 *     end (label "Cancel"). A tap sends the box the plugin's own Esc, which
 *     cancels and keeps the old name. The press doesn't take the focus, so
 *     the box isn't blurred first (a blur saves); should a browser blur it
 *     anyway, that blur is held back while the ✕ is pressed. Enter still saves.
 *   - THE KEYBOARD: a text box focused in the plugin's screens (the rename
 *     box, the search box, a card's Question and Answer in its boxes, the
 *     fields of Settings → Flashcards) is scrolled into the visible part,
 *     above the keyboard, when it is focused and whenever the visible height
 *     changes while it has focus. The app is already as tall as the visible
 *     part (--lh-vvh, phone-viewport.tsx); this moves the box inside it.
 *
 * Phone layout only (isPhoneNow): off it, nothing is marked, no ✕ is added
 * and no event is answered. Installed once by phone-runtime.tsx.
 */

import { isPhoneNow, PHONE_QUERY } from "@/components/phone/use-phone";
import { typingTarget } from "@/components/phone/phone-viewport";

/** The plugin's screens: the library page, its boxes, the review surface,
 *  Settings → Flashcards. Every one has this class on its root. */
export const FLASHCARDS_ROOT = ".fc-root";
/** A row of the deck list (the host's tree, rendered for the plugin). */
export const FLASHCARDS_ROW = ".fc-root [data-plugin-tree-row]";
/** A row's own ⚙: the plugin's "Deck actions", "Proposition actions" and
 *  "Cue actions" buttons, in the row's .fc-tree-more. */
export const ROW_MENU_BUTTON = '.fc-tree-more button[aria-label$=" actions"]';
/** The plugin's inline rename box. */
export const RENAME_INPUT = "input.fc-tree-rename";
/** data-phone-press value on the rows this file marks. */
export const PRESS_MARK = "flashcards";
/** data-phone value of the rename ✕. */
export const RENAME_CANCEL = "flashcards-rename-cancel";
/** The ✕'s hidden label, for screen readers (plan: for the owner to review). */
export const RENAME_CANCEL_LABEL = "Cancel";

/** The row's own ⚙ (never one of a nested row). */
export function rowMenuButton(row: Element): HTMLElement | null {
	for (const button of row.querySelectorAll<HTMLElement>(ROW_MENU_BUTTON)) {
		if (button.closest("[data-plugin-tree-row]") === row) return button;
	}
	return null;
}

function cancelButton(doc: Document): HTMLButtonElement {
	const button = doc.createElement("button");
	button.type = "button";
	button.dataset.phone = RENAME_CANCEL;
	button.setAttribute("aria-label", RENAME_CANCEL_LABEL);
	button.tabIndex = -1;
	button.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
	return button;
}

/** Brings the page in line with the rule: rows with a ⚙ are marked for the
 *  hold, an open rename box has its ✕, nothing else carries either. With
 *  phone false everything this file added is taken away. Idempotent. */
export function syncFlashcardsTouch(doc: Document, phone: boolean): void {
	for (const row of doc.querySelectorAll(`[data-phone-press="${PRESS_MARK}"]`)) {
		if (!phone || !row.matches(FLASHCARDS_ROW) || !rowMenuButton(row)) row.removeAttribute("data-phone-press");
	}
	for (const button of doc.querySelectorAll(`[data-phone="${RENAME_CANCEL}"]`)) {
		const input = button.previousElementSibling;
		if (!phone || !input?.matches(RENAME_INPUT) || !input.closest(FLASHCARDS_ROOT)) button.remove();
	}
	if (!phone || !doc.querySelector(FLASHCARDS_ROOT)) return;
	for (const row of doc.querySelectorAll(FLASHCARDS_ROW)) {
		if (!row.hasAttribute("data-phone-press") && rowMenuButton(row)) row.setAttribute("data-phone-press", PRESS_MARK);
	}
	for (const input of doc.querySelectorAll(`${FLASHCARDS_ROOT} ${RENAME_INPUT}`)) {
		if (input.nextElementSibling?.matches(`[data-phone="${RENAME_CANCEL}"]`)) continue;
		input.after(cancelButton(doc));
	}
}

/** Pure rule, exported for tests: how far to scroll (positive: down) so a
 *  box sits inside the visible band with a small margin. A box taller than
 *  the band keeps its top in view. */
export function scrollDelta(box: { top: number; bottom: number }, band: { top: number; bottom: number }, margin = 8): number {
	const top = band.top + margin;
	const bottom = band.bottom - margin;
	if (box.top < top) return box.top - top;
	if (box.bottom > bottom) return Math.max(0, Math.min(box.bottom - bottom, box.top - top));
	return 0;
}

function scrollsVertically(el: Element): boolean {
	const overflow = getComputedStyle(el).overflowY;
	return (overflow === "auto" || overflow === "scroll") && el.scrollHeight > el.clientHeight + 1;
}

/** Scrolls each scrolling box around the element, innermost first, so it
 *  ends inside both that box and the visible part of the screen. Never the
 *  window: the app's pages don't scroll it (phone-viewport.tsx). */
export function revealInVisiblePart(el: HTMLElement, doc: Document = el.ownerDocument): void {
	const view = doc.defaultView;
	if (!view) return;
	const vv = view.visualViewport;
	const visible = vv ? { top: vv.offsetTop, bottom: vv.offsetTop + vv.height } : { top: 0, bottom: view.innerHeight };
	for (let box = el.parentElement; box && box !== doc.body && box !== doc.documentElement; box = box.parentElement) {
		if (!scrollsVertically(box)) continue;
		const rect = box.getBoundingClientRect();
		const top = rect.top + box.clientTop;
		const band = { top: Math.max(top, visible.top), bottom: Math.min(top + box.clientHeight, visible.bottom) };
		if (band.bottom - band.top < 24) continue;
		const target = el.getBoundingClientRect();
		const delta = scrollDelta(target, band);
		if (delta !== 0) box.scrollTop += delta;
	}
}

export function installFlashcardsTouch(doc: Document = document): () => void {
	const view = doc.defaultView;
	if (!view) return () => {};
	let observer: MutationObserver | null = null;
	const sync = () => syncFlashcardsTouch(doc, isPhoneNow());
	const watch = () => {
		const phone = isPhoneNow();
		if (phone && !observer && typeof view.MutationObserver === "function") {
			observer = new view.MutationObserver(sync);
			observer.observe(doc.body, { childList: true, subtree: true });
		} else if (!phone && observer) {
			observer.disconnect();
			observer = null;
		}
		sync();
	};
	const query = typeof view.matchMedia === "function" ? view.matchMedia(PHONE_QUERY) : null;
	query?.addEventListener("change", watch);
	watch();

	// Press and hold: the row's contextmenu (long-press.ts, or Android's own)
	// presses the row's ⚙, which opens its menu.
	const onContextMenu = (e: Event) => {
		if (!isPhoneNow()) return;
		const row = (e.target as Element | null)?.closest?.(`[data-phone-press="${PRESS_MARK}"]`);
		if (!row) return;
		const button = rowMenuButton(row);
		if (!button) return;
		e.preventDefault();
		// The page's own click (isTrusted false): long-press.ts lets it
		// through, and still swallows the tap the lifted finger may send.
		button.dispatchEvent(new view.MouseEvent("click", { bubbles: true, cancelable: true }));
	};

	// The rename ✕.
	let pressed: HTMLInputElement | null = null;
	let heldBlur = false;
	const renameInputOf = (target: EventTarget | null) => {
		const button = (target as Element | null)?.closest?.(`[data-phone="${RENAME_CANCEL}"]`);
		const input = button?.previousElementSibling;
		return input instanceof view.HTMLInputElement && input.matches(RENAME_INPUT) ? input : null;
	};
	const onPress = (e: Event) => {
		const input = renameInputOf(e.target);
		if (!input) return;
		// Keep the focus in the box: a blur would save the new name.
		e.preventDefault();
		if (e.type === "pointerdown" || e.type === "touchstart") { pressed = input; heldBlur = false; }
	};
	const onBlur = (e: Event) => {
		if (pressed && e.target === pressed) { heldBlur = true; e.stopImmediatePropagation(); }
	};
	const onClick = (e: Event) => {
		const input = renameInputOf(e.target);
		pressed = null;
		heldBlur = false;
		// A tap the hold swallowed (long-press.ts, on the same document, runs
		// first): the finger held the row, it didn't tap the ✕.
		if (!input || !isPhoneNow() || e.defaultPrevented) return;
		e.preventDefault();
		e.stopPropagation();
		// The plugin's own Esc: cancel, keep the old name.
		input.dispatchEvent(new view.KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
	};
	const onCancelPress = () => {
		const input = pressed;
		const blurred = heldBlur;
		pressed = null;
		heldBlur = false;
		// The finger moved away (a scroll): the blur that was held back is
		// the plugin's to see after all, so it saves as it would have.
		if (input && blurred && input.isConnected && doc.activeElement !== input) input.dispatchEvent(new view.FocusEvent("blur"));
	};

	// The keyboard: a focused box into the visible part.
	let frame = 0;
	const focusedBox = () => {
		const active = doc.activeElement as HTMLElement | null;
		return active && typingTarget(active) && active.closest(FLASHCARDS_ROOT) ? active : null;
	};
	const reveal = () => {
		view.cancelAnimationFrame(frame);
		frame = view.requestAnimationFrame(() => {
			const box = isPhoneNow() ? focusedBox() : null;
			if (box) revealInVisiblePart(box, doc);
		});
	};
	const onFocusIn = () => { if (isPhoneNow() && focusedBox()) reveal(); };
	const onViewport = () => { if (isPhoneNow() && focusedBox()) reveal(); };

	const capture = { capture: true } as const;
	doc.addEventListener("contextmenu", onContextMenu);
	doc.addEventListener("pointerdown", onPress, capture);
	doc.addEventListener("mousedown", onPress, capture);
	doc.addEventListener("blur", onBlur, capture);
	doc.addEventListener("click", onClick, capture);
	doc.addEventListener("pointercancel", onCancelPress, capture);
	doc.addEventListener("focusin", onFocusIn);
	view.visualViewport?.addEventListener("resize", onViewport);
	return () => {
		query?.removeEventListener("change", watch);
		observer?.disconnect();
		observer = null;
		syncFlashcardsTouch(doc, false);
		view.cancelAnimationFrame(frame);
		doc.removeEventListener("contextmenu", onContextMenu);
		doc.removeEventListener("pointerdown", onPress, capture);
		doc.removeEventListener("mousedown", onPress, capture);
		doc.removeEventListener("blur", onBlur, capture);
		doc.removeEventListener("click", onClick, capture);
		doc.removeEventListener("pointercancel", onCancelPress, capture);
		doc.removeEventListener("focusin", onFocusIn);
		view.visualViewport?.removeEventListener("resize", onViewport);
	};
}
