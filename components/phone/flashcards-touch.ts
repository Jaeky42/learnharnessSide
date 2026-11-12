/**
 * FLASHCARDS ON A PHONE: the touch behaviour CSS can't give
 * (docs/phone-plugins-plan.md, decisions 4b, 5b and 5c and "The keyboard").
 * The look is app/phone-flashcards.css. Nothing here edits the plugin's
 * files: it works on the page the plugin and the host render.
 *
 *   - PRESS AND HOLD on a deck list row opens that row's own ⚙ menu. Rows
 *     that have a ⚙ are marked data-phone-press="flashcards", so the fork's
 *     one hold (long-press.ts, about half a second) turns a held finger into
 *     a contextmenu event on the row, and lifting the finger afterwards sends
 *     no tap (the card doesn't open, a rename doesn't start). The contextmenu
 *     is answered here by pressing the row's ⚙. No dragging.
 *     A row whose rename box is open is NOT marked: holding a finger in a
 *     text box is how an iPhone moves the caret, and the ✕ beside it is a
 *     plain button. The mark comes back when the rename ends.
 *   - THE RENAME ✕: while a deck's rename box is open, a small ✕ sits at its
 *     end (label "Cancel"). A tap sends the box the plugin's own Esc, which
 *     cancels and keeps the old name. The press doesn't take the focus, so
 *     the box isn't blurred first (a blur saves). Should a browser blur it
 *     anyway, that blur is held back only for the ✕'s own tap: from its
 *     press to the click that follows. A press that ends any other way (the
 *     finger slid off, a scroll, a new touch elsewhere, or no click within
 *     TAP_SETTLE_MS of the lift) gives the plugin its blur back, so the box
 *     saves as it would have. Enter still saves.
 *   - LOADING BETWEEN CARDS: while the review waits for the next card the
 *     plugin hides the card and shows only "Loading next card…". The stage
 *     is then marked data-phone-review="loading", so the phone layout (the
 *     buttons' band at the bottom) stays put instead of falling back to the
 *     centred end-state layout for that moment. The true end states have
 *     other words and keep upstream's layout.
 *   - THE KEYBOARD: a text box focused in the plugin's screens (the rename
 *     box, the search box, a card's Question and Answer in its boxes, the
 *     fields of Settings → Flashcards) is scrolled into the visible part,
 *     above the keyboard, when it is focused and whenever the visible height
 *     changes while it has focus. The app is already as tall as the visible
 *     part (--lh-vvh, phone-viewport.tsx); this moves the box inside it.
 *
 * Cost: on pages without the plugin the only work is a look at each node a
 * mutation adds, for a plugin root. Each mounted root (.fc-root) gets its
 * own observer, and the page-wide clean-up runs only after this file has
 * marked something.
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
/** The review stage, and the plugin's words while it waits for a card
 *  (plugins/flashcards/src/review.js). */
export const REVIEW_STAGE = ".fc-review-stage";
export const LOADING_TEXT = "Loading next card…";
/** How long after the ✕'s lift its click may still come. */
export const TAP_SETTLE_MS = 400;

/** The row's own ⚙ (never one of a nested row). */
export function rowMenuButton(row: Element): HTMLElement | null {
	for (const button of row.querySelectorAll<HTMLElement>(ROW_MENU_BUTTON)) {
		if (button.closest("[data-plugin-tree-row]") === row) return button;
	}
	return null;
}

/** Pure rule, exported for tests: a row takes the hold when it has its own
 *  ⚙ and no rename box is open in it. */
export function rowTakesHold(row: Element): boolean {
	return !!rowMenuButton(row) && !row.querySelector(RENAME_INPUT);
}

/** Pure rule, exported for tests: is this stage waiting for the next card
 *  (card hidden, the footer holding only the plugin's loading line)? */
export function reviewLoading(stage: Element): boolean {
	const card = stage.querySelector(":scope > .fc-review-card");
	const footer = stage.querySelector(":scope > .fc-review-footer");
	if (!card || !card.hasAttribute("hidden") || !footer || footer.children.length !== 1) return false;
	const line = footer.firstElementChild!;
	return line.matches("p.fc-review-meta") && line.textContent?.trim() === LOADING_TEXT;
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

/** Brings one plugin root (or a whole document) in line with the rule: rows
 *  that take the hold are marked, an open rename box has its ✕, a stage
 *  waiting for a card is marked loading, nothing else carries any of these.
 *  With phone false everything this file added in the scope is taken away.
 *  Idempotent. Returns whether anything of this file's is left in scope. */
export function syncFlashcardsTouch(scope: ParentNode, phone: boolean): boolean {
	const doc = (scope as Node).ownerDocument ?? (scope as Document);
	let left = false;
	for (const row of scope.querySelectorAll(`[data-phone-press="${PRESS_MARK}"]`)) {
		if (!phone || !row.matches(FLASHCARDS_ROW) || !rowTakesHold(row)) row.removeAttribute("data-phone-press");
	}
	for (const button of scope.querySelectorAll(`[data-phone="${RENAME_CANCEL}"]`)) {
		const input = button.previousElementSibling;
		if (!phone || !input?.matches(RENAME_INPUT) || !input.closest(FLASHCARDS_ROOT)) button.remove();
	}
	for (const stage of scope.querySelectorAll(`${REVIEW_STAGE}[data-phone-review]`)) {
		if (!phone || !reviewLoading(stage)) stage.removeAttribute("data-phone-review");
	}
	if (!phone) return false;
	for (const row of scope.querySelectorAll(FLASHCARDS_ROW)) {
		if (row.hasAttribute("data-phone-press") || !rowTakesHold(row)) continue;
		row.setAttribute("data-phone-press", PRESS_MARK);
		left = true;
	}
	for (const input of scope.querySelectorAll(`${FLASHCARDS_ROOT} ${RENAME_INPUT}`)) {
		left = true;
		if (input.nextElementSibling?.matches(`[data-phone="${RENAME_CANCEL}"]`)) continue;
		input.after(cancelButton(doc));
	}
	for (const stage of scope.querySelectorAll(REVIEW_STAGE)) {
		if (!reviewLoading(stage)) continue;
		stage.setAttribute("data-phone-review", "loading");
		left = true;
	}
	return left || !!scope.querySelector(`[data-phone-press="${PRESS_MARK}"]`);
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

	// Each mounted plugin root has its own observer; the page's observer
	// only looks at added nodes for a root.
	const roots = new Map<Element, MutationObserver | null>();
	let marked = false;
	let pageObserver: MutationObserver | null = null;
	const syncRoot = (root: Element) => { if (syncFlashcardsTouch(root, true)) marked = true; };
	const attach = (root: Element) => {
		if (roots.has(root)) return;
		let observer: MutationObserver | null = null;
		if (typeof view.MutationObserver === "function") {
			observer = new view.MutationObserver(() => syncRoot(root));
			observer.observe(root, { childList: true, subtree: true });
		}
		roots.set(root, observer);
		syncRoot(root);
	};
	const detachGone = () => {
		for (const [root, observer] of roots) if (!root.isConnected) { observer?.disconnect(); roots.delete(root); }
	};
	const onPageMutations = (records: MutationRecord[]) => {
		for (const record of records) {
			for (const node of record.addedNodes) {
				if (node.nodeType !== 1) continue;
				const el = node as Element;
				if (el.matches(FLASHCARDS_ROOT)) attach(el);
				else if (el.firstElementChild) for (const root of el.querySelectorAll(FLASHCARDS_ROOT)) attach(root);
			}
			if (record.removedNodes.length && roots.size) detachGone();
		}
	};
	const stop = () => {
		pageObserver?.disconnect();
		pageObserver = null;
		for (const observer of roots.values()) observer?.disconnect();
		roots.clear();
		if (marked) { syncFlashcardsTouch(doc, false); marked = false; }
	};
	const watch = () => {
		if (!isPhoneNow()) { stop(); return; }
		if (!pageObserver && typeof view.MutationObserver === "function") {
			pageObserver = new view.MutationObserver(onPageMutations);
			pageObserver.observe(doc.body, { childList: true, subtree: true });
		}
		for (const root of doc.querySelectorAll(FLASHCARDS_ROOT)) attach(root);
	};
	const query = typeof view.matchMedia === "function" ? view.matchMedia(PHONE_QUERY) : null;
	query?.addEventListener("change", watch);
	watch();

	// Press and hold: the row's contextmenu (long-press.ts, or Android's own)
	// presses the row's ⚙, which opens its menu.
	const onContextMenu = (e: Event) => {
		if (!isPhoneNow()) return;
		const row = (e.target as Element | null)?.closest?.(`[data-phone-press="${PRESS_MARK}"]`);
		if (!row || !rowTakesHold(row)) return;
		const button = rowMenuButton(row);
		if (!button) return;
		e.preventDefault();
		// The page's own click (isTrusted false): long-press.ts lets it
		// through, and still swallows the tap the lifted finger may send.
		button.dispatchEvent(new view.MouseEvent("click", { bubbles: true, cancelable: true }));
	};

	// The rename ✕. `pressed` lives from the ✕'s press to its click; any
	// other end of the press settles it (and returns a held-back blur).
	let pressed: HTMLInputElement | null = null;
	let heldBlur = false;
	let settleTimer = 0;
	const renameInputOf = (target: EventTarget | null) => {
		const button = (target as Element | null)?.closest?.(`[data-phone="${RENAME_CANCEL}"]`);
		const input = button?.previousElementSibling;
		return input instanceof view.HTMLInputElement && input.matches(RENAME_INPUT) ? input : null;
	};
	const settle = () => {
		view.clearTimeout(settleTimer);
		const input = pressed;
		const blurred = heldBlur;
		pressed = null;
		heldBlur = false;
		// The blur that was held back is the plugin's to see after all, so it
		// saves as it would have.
		if (input && blurred && input.isConnected && doc.activeElement !== input) input.dispatchEvent(new view.FocusEvent("blur"));
	};
	const onPointerDown = (e: Event) => {
		const input = isPhoneNow() ? renameInputOf(e.target) : null;
		if (!input) {
			// A new touch anywhere else ends a press that never got its click.
			if (pressed) settle();
			return;
		}
		// Keep the focus in the box: a blur would save the new name.
		e.preventDefault();
		settle();
		pressed = input;
	};
	const onMouseDown = (e: Event) => {
		if (isPhoneNow() && renameInputOf(e.target)) e.preventDefault();
	};
	const onPointerUp = (e: Event) => {
		if (!pressed) return;
		view.clearTimeout(settleTimer);
		// Lifted off the ✕ (slid away): no tap of the ✕ is coming.
		if (renameInputOf(e.target) !== pressed && renameInputOf(doc.elementFromPoint?.((e as PointerEvent).clientX, (e as PointerEvent).clientY) ?? null) !== pressed) { settle(); return; }
		settleTimer = view.setTimeout(settle, TAP_SETTLE_MS);
	};
	const onBlur = (e: Event) => {
		if (pressed && e.target === pressed) { heldBlur = true; e.stopImmediatePropagation(); }
	};
	const onClick = (e: Event) => {
		const input = renameInputOf(e.target);
		view.clearTimeout(settleTimer);
		pressed = null;
		heldBlur = false;
		// A tap another handler already took (long-press.ts swallows the tap
		// after a hold) is not the ✕'s.
		if (!input || !isPhoneNow() || e.defaultPrevented) return;
		e.preventDefault();
		e.stopPropagation();
		// The plugin's own Esc: cancel, keep the old name.
		input.dispatchEvent(new view.KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
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
	doc.addEventListener("pointerdown", onPointerDown, capture);
	doc.addEventListener("mousedown", onMouseDown, capture);
	doc.addEventListener("pointerup", onPointerUp, capture);
	doc.addEventListener("pointercancel", settle, capture);
	doc.addEventListener("blur", onBlur, capture);
	doc.addEventListener("click", onClick, capture);
	doc.addEventListener("focusin", onFocusIn);
	view.visualViewport?.addEventListener("resize", onViewport);
	return () => {
		query?.removeEventListener("change", watch);
		stop();
		view.clearTimeout(settleTimer);
		view.cancelAnimationFrame(frame);
		doc.removeEventListener("contextmenu", onContextMenu);
		doc.removeEventListener("pointerdown", onPointerDown, capture);
		doc.removeEventListener("mousedown", onMouseDown, capture);
		doc.removeEventListener("pointerup", onPointerUp, capture);
		doc.removeEventListener("pointercancel", settle, capture);
		doc.removeEventListener("blur", onBlur, capture);
		doc.removeEventListener("click", onClick, capture);
		doc.removeEventListener("focusin", onFocusIn);
		view.visualViewport?.removeEventListener("resize", onViewport);
	};
}
