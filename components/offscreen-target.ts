/**
 * Side-tutor fork (performance): jumps to a passage in a message the browser
 * has skipped drawing.
 *
 * app/offscreen.css lets the browser skip off-screen lesson messages
 * (`content-visibility: auto`). Inside a skipped message a Range can measure
 * as all zeros (Chromium gives zeros on the first measurement), so a jump
 * computed from it scrolls nowhere near the passage; and the messages around
 * the passage only take their real heights once they are on screen, which can
 * move it after it was placed.
 *
 * So, before a jump measures, the message it lands in is drawn, and so is
 * every skipped message that the jump brings on screen beside it, and those
 * above it up to two window heights over the lesson's top (the browser draws
 * what comes that near by itself a few frames later; where it has no scroll
 * anchoring, as Safari may not, their real heights would move the passage).
 * They get `data-lh-draw`, which app/offscreen.css answers with
 * `content-visibility: visible`. Once the layout has settled (a few frames)
 * the passage is measured again and put back ONCE if it moved, unless the
 * learner scrolled (a wheel, a touch, a press or a scroll key anywhere on the
 * page) or another jump started meanwhile. Then the attribute is
 * removed: a message on screen stays drawn, and one off screen keeps its real
 * height as its remembered size ("auto" in the stylesheet).
 *
 * An attribute and not an inline style: session Find re-reads every match when
 * a style in the lesson changes (its MutationObserver), which cost about 270
 * ms per change in a 950-message lesson.
 *
 * Does nothing beyond the plain jump when no message near the passage is
 * skipped (also where the browser doesn't know the rule), and where the page
 * has no computed styles or animation frames (the tests' DOMs).
 */

/** The messages app/offscreen.css lets the browser skip. The same two
 *  selectors as the stylesheet;
 *  tests/offscreen-target.test.ts keeps the two equal. */
export const OFFSCREEN_BLOCK_SELECTORS = [
	'[data-session-find-root] > [data-testid="user-message"]',
	"[data-session-find-root] > .is-assistant",
] as const;
const BLOCK = OFFSCREEN_BLOCK_SELECTORS.join(", ");
/** The attribute that has app/offscreen.css draw a skipped message. */
export const DRAW_ATTRIBUTE = "data-lh-draw";
/** A row of the transcript column: a message, a divider, a card. */
const ROW = "[data-session-find-root] > *";

/** The one check waits until neither the passage nor the lesson's height has
 *  moved for SETTLE_STILL_FRAMES frames, and at least SETTLE_MIN_FRAMES have
 *  passed: the browser draws the messages it brought on screen only a few
 *  frames after the jump (3 to 5 in Chromium). SETTLE_MAX_FRAMES at most. */
export const SETTLE_MIN_FRAMES = 4;
export const SETTLE_STILL_FRAMES = 3;
export const SETTLE_MAX_FRAMES = 20;
/** If no frame comes for this long (a hidden tab), the attribute goes
 *  without the check. */
export const RELEASE_FALLBACK_MS = 1_000;
/** A move smaller than this isn't corrected. */
const DRIFT_PX = 1;
/** Messages above the lesson's top are drawn this many window heights up. */
const DRAW_ABOVE_WINDOWS = 2;
/** Passes of "draw what came near, then place again" per placement. */
const DRAW_PASSES = 3;
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

let active: { cancel(): void } | null = null;

type Win = Window & typeof globalThis;

function targetElement(target: Range | HTMLElement): Element | null {
	if (!("startContainer" in target)) return target;
	const node = target.startContainer;
	return node.nodeType === 1 ? node as Element : node.parentElement;
}

/** Skipped right now: its contents aren't drawn. Unknown (no checkVisibility)
 *  counts as skipped; drawing an already drawn message changes nothing. */
function skipped(view: Win, block: HTMLElement): boolean {
	if (view.getComputedStyle(block).contentVisibility !== "auto") return false;
	const child = block.firstElementChild as (Element & { checkVisibility?: (options?: object) => boolean }) | null;
	if (!child) return false;
	return typeof child.checkVisibility === "function" ? !child.checkVisibility({ contentVisibilityAuto: true }) : true;
}

function topIn(target: Range | HTMLElement, main: HTMLElement): number {
	return target.getBoundingClientRect().top - main.getBoundingClientRect().top;
}

/**
 * Run `place` (the jump's own measuring and scrolling) with the passage's
 * message drawn, then check once after the layout has settled. `main` is the
 * lesson's scroller; `place` may run a second time, for the correction.
 */
export function revealOffscreenTarget(target: Range | HTMLElement, main: HTMLElement | null, place: () => void): void {
	active?.cancel();
	active = null;
	const element = targetElement(target);
	const doc = element?.ownerDocument;
	const view = doc?.defaultView as Win | null | undefined;
	const row = element?.closest<HTMLElement>(ROW) ?? null;
	if (!main || !view || !doc || !row || !main.contains(row)
		|| typeof view.getComputedStyle !== "function" || typeof view.requestAnimationFrame !== "function") {
		place();
		return;
	}

	const forced = new Set<HTMLElement>();
	const draw = (block: HTMLElement): boolean => {
		if (forced.has(block) || block.hasAttribute(DRAW_ATTRIBUTE) || !skipped(view, block)) return false;
		forced.add(block);
		block.setAttribute(DRAW_ATTRIBUTE, "");
		return true;
	};
	/** Draws the skipped messages beside the passage's row that are on screen,
	 *  or above it within DRAW_ABOVE_WINDOWS window heights. */
	const drawNear = (): boolean => {
		const box = main.getBoundingClientRect();
		const above = box.top - DRAW_ABOVE_WINDOWS * (view.innerHeight || box.height);
		let drew = false;
		// Below first: drawing those doesn't move the passage; drawing the ones
		// above does, so the next pass places it again before looking again.
		for (let el = row.nextElementSibling as HTMLElement | null; el; el = el.nextElementSibling as HTMLElement | null) {
			if (el.getBoundingClientRect().top >= box.bottom) break;
			if (el.matches(BLOCK) && draw(el)) drew = true;
		}
		for (let el = row.previousElementSibling as HTMLElement | null; el; el = el.previousElementSibling as HTMLElement | null) {
			if (el.getBoundingClientRect().bottom <= above) break;
			if (el.matches(BLOCK) && draw(el)) drew = true;
		}
		return drew;
	};
	const placeDrawn = () => {
		place();
		for (let pass = 0; pass < DRAW_PASSES && drawNear(); pass++) place();
	};

	if (row.matches(BLOCK)) draw(row);
	placeDrawn();
	// Nothing near the passage was skipped: the plain jump, nothing more.
	if (forced.size === 0) return;

	const expected = topIn(target, main);
	let frame = 0;
	let timer = 0;
	let frames = 0;
	let still = 0;
	let height = main.scrollHeight;
	let top = expected;
	const restore = () => {
		for (const block of forced) block.removeAttribute(DRAW_ATTRIBUTE);
		forced.clear();
	};
	const stopWatching = () => {
		if (frame) view.cancelAnimationFrame?.(frame);
		view.clearTimeout(timer);
		frame = 0;
		doc.removeEventListener("wheel", onInput, true);
		doc.removeEventListener("touchstart", onInput, true);
		doc.removeEventListener("pointerdown", onInput, true);
		doc.removeEventListener("keydown", onKey, true);
		if (active === handle) active = null;
	};
	/** The learner scrolls: no correction. Heard on the whole page, not on the
	 *  lesson alone: a wheel or a drag on the dock (the lesson's sibling) scrolls
	 *  the lesson from script, and the check would take that for the passage
	 *  having moved and put it back. The attribute stays two more frames,
	 *  so a message still on screen isn't skipped before the browser has
	 *  seen it there. */
	const onInput = () => {
		stopWatching();
		const release = view.setTimeout(restore, RELEASE_FALLBACK_MS);
		view.requestAnimationFrame(() => view.requestAnimationFrame(() => { view.clearTimeout(release); restore(); }));
	};
	const onKey = (event: KeyboardEvent) => {
		const typing = (event.target as Element | null)?.closest?.("input, textarea, select, [contenteditable]");
		if (SCROLL_KEYS.has(event.key) && !typing) onInput();
	};
	const giveUp = () => { stopWatching(); restore(); };
	const tick = () => {
		frame = 0;
		frames += 1;
		view.clearTimeout(timer);
		timer = view.setTimeout(giveUp, RELEASE_FALLBACK_MS);
		const nowHeight = main.scrollHeight;
		const nowTop = topIn(target, main);
		still = nowHeight === height && Math.abs(nowTop - top) <= DRIFT_PX ? still + 1 : 0;
		height = nowHeight;
		top = nowTop;
		if (frames < SETTLE_MAX_FRAMES && (frames < SETTLE_MIN_FRAMES || still < SETTLE_STILL_FRAMES)) {
			frame = view.requestAnimationFrame(tick);
			return;
		}
		stopWatching();
		if (Math.abs(nowTop - expected) > DRIFT_PX) placeDrawn();
		restore();
	};
	const handle = { cancel: giveUp };
	active = handle;
	doc.addEventListener("wheel", onInput, { capture: true, passive: true });
	doc.addEventListener("touchstart", onInput, { capture: true, passive: true });
	doc.addEventListener("pointerdown", onInput, { capture: true, passive: true });
	doc.addEventListener("keydown", onKey, true);
	frame = view.requestAnimationFrame(tick);
	timer = view.setTimeout(giveUp, RELEASE_FALLBACK_MS);
}
