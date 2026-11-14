/**
 * SCROLL INTO A CHECK (owner: "like any normal question, where i scroll all
 * the way through the content, into blank space, then it opens").
 *
 * A teach check waits folded behind its "Check your understanding … Open"
 * bar until the learner opens it (upstream's W5). Fork: while it waits, the
 * lesson already has the blank space under it that the OPEN check will need
 * (the dock reserve is the open question's height), so opening it later
 * changes no scroll geometry: nothing grows, nothing slides, nothing can fold
 * it again (the first attempt, which opened it at the end of the text, grew
 * the reserve at the open, and on the owner's iPhone the finger on the screen
 * stopped the slide to the new bottom and the fold rule closed it again).
 *
 *   - The lesson RESTS at the end of the text: use-stick-to-bottom's target is
 *     the real bottom minus the blank space not yet "earned" (`extra`), so on
 *     load, and while following the teacher's text, the bar sits just under
 *     the last line and the blank space is below the fold.
 *   - Scrolling on down through the blank space to the real bottom opens the
 *     check and counts as opening it, exactly like a folded question that
 *     re-opens at the bottom. Never by itself: only after the lesson was seen
 *     away from the real bottom with the blank space in place, and only on a
 *     scroll that moved DOWN into it (a geometry change that clamps the lesson
 *     to its bottom, the keyboard closing for one, moves it up).
 *
 * Native questions only (QuestionDock keeps its open form mounted and laid out
 * while folded, so its height can be measured without opening it). A plugin's
 * check keeps upstream's behaviour: no blank space, Open only.
 * Pure helpers here; the wiring is DockOverlay's in components/chat.tsx.
 */

/** The hidden open form inside a folded QuestionDock (question-dock.tsx). */
export const OPEN_FORM_ATTR = "data-dock-open-form";

export interface OpenCheckMeasurements {
	/** The transcript scroller's clientHeight (the column the dock budgets against). */
	columnHeight: number;
	/** The dock block minus its viewport: the stats row and the block's padding. */
	outsideHeight: number;
	/** The viewport's body as it is now, folded (natural, uncapped). */
	bodyHeight: number;
	/** The shell's content as it is now, folded: the bar. */
	contentHeight: number;
	/** The open form's natural height, its question area uncapped. */
	formHeight: number;
}

/** The dock block's height once the check is open: the folded body with the
 *  bar swapped for the open form, capped as dockHeightBudget caps the open
 *  dock (components/dock-height.ts: the viewport never exceeds the column
 *  less 32 px less what sits outside it). */
export function openCheckBlockHeight(m: OpenCheckMeasurements): number {
	const viewportMax = Math.max(Math.max(m.columnHeight - 32, 0) - m.outsideHeight, 0);
	const natural = Math.max(m.bodyHeight - m.contentHeight + m.formHeight, 0);
	return m.outsideHeight + Math.min(natural, viewportMax);
}

/** The blank space under the waiting check that the resting point leaves out
 *  of view: the reserve beyond what the folded dock itself needs. */
export function blankSpaceExtra(reserve: number, foldedBlock: number, gradient: number): number {
	return Math.max(0, reserve - foldedBlock - gradient);
}

/** use-stick-to-bottom's target while a check waits: the end of the text. */
export function restingTarget(target: number, extra: number): number {
	return Math.max(0, target - extra);
}

/** Per waiting check: the blank space and what the fold machine has seen. */
export interface CheckSpace {
	/** The blank space beyond the folded dock, px (0: none, or not waiting). */
	extra: number;
	/** The blank space has been offered for this check. */
	ready: boolean;
	/** The lesson was seen away from the real bottom since then. */
	away: boolean;
	/** The last scroll that moved the lesson moved it down. */
	movedDown: boolean;
	lastTop: number | null;
	/** The lesson's place against the resting point at the last look (px past it). */
	gap: number | null;
}

export function createCheckSpace(): CheckSpace {
	return { extra: 0, ready: false, away: false, movedDown: false, lastTop: null, gap: null };
}

/** A new pending question (or none): start again. */
export function resetCheckSpace(s: CheckSpace): void {
	Object.assign(s, createCheckSpace());
}

/** The blank space was offered (or re-offered) for the waiting check. */
export function offerCheckSpace(s: CheckSpace, extra: number): void {
	s.extra = extra;
	if (!s.ready) {
		s.ready = true;
		s.away = false;
	}
}

/** use-stick-to-bottom's real target for a scroller (its bottom, less 1 px). */
export function bottomTarget(el: { scrollHeight: number; clientHeight: number }): number {
	return el.scrollHeight - 1 - el.clientHeight;
}

/** Where the lesson is now (a scroll event, a resize, or a look after an
 *  offer). `top` is its scrollTop, `distance` how far it is from the real
 *  bottom, `rest` the resting point. A look with the lesson unmoved keeps the
 *  last direction. */
export function noteCheckPlace(s: CheckSpace, top: number, distance: number, expandDist: number, rest: number): void {
	if (s.lastTop !== null && top !== s.lastTop) s.movedDown = top > s.lastTop;
	s.lastTop = top;
	s.gap = top - rest;
	if (s.ready && distance > expandDist) s.away = true;
}

/** At a resize of the lesson or its scroller: the lesson was at (or above)
 *  its resting point at the last look and finds itself past it. What is
 *  under it got shorter (messages drawn at their real height, smaller than
 *  the off-screen rule's estimate, often with scroll anchoring moving
 *  scrollTop down for a message above that grew), or the scroller got taller
 *  (the keyboard closing, a taller window). The browser keeps a lesson at its
 *  real bottom then; this keeps it at the end of the text, so the blank space
 *  stays out of view. A lesson the learner had scrolled into the blank space
 *  is left where it is. */
export function backToRest(s: CheckSpace, top: number, rest: number): boolean {
	return s.gap !== null && s.gap <= 2 && top > rest + 1;
}

/** Whether reaching the bottom now opens the waiting check (and reveals it). */
export function checkOpensOnScroll(s: CheckSpace, distance: number, expandDist: number): boolean {
	return s.ready && s.away && s.movedDown && distance < expandDist;
}

/** Read the open check's height from the folded dock's DOM. Null when there
 *  is no open form to measure (a malformed question, a plugin's dock). */
export function measureOpenCheck(els: {
	column: HTMLElement;
	block: HTMLElement;
	viewport: HTMLElement;
	body: HTMLElement;
	content: HTMLElement;
}): number | null {
	const wrapper = els.content.querySelector<HTMLElement>(`[${OPEN_FORM_ATTR}]`);
	const form = wrapper?.firstElementChild as HTMLElement | null | undefined;
	if (!form) return null;
	const h = (el: Element) => el.getBoundingClientRect().height;
	// The question area is capped at its CSS fallback while folded (55dvh);
	// open, the dock's budget caps it instead, so take its natural height.
	const area = form.querySelector<HTMLElement>("[data-dock-scroll-area]");
	const formHeight = h(form) + (area ? Math.max(area.scrollHeight - h(area), 0) : 0);
	return openCheckBlockHeight({
		columnHeight: els.column.clientHeight,
		outsideHeight: Math.max(h(els.block) - h(els.viewport), 0),
		bodyHeight: h(els.body),
		contentHeight: h(els.content),
		formHeight,
	});
}
