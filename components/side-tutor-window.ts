/**
 * The side tutor window's size on a computer (fork; owner's ask): which of
 * its edges resize it, and how far.
 *
 *   top bar                      moves the window (side-tutor.tsx)
 *   left side, right side        wider or narrower
 *   bottom side                  taller or shorter
 *   the two bottom corners       both at once
 *
 * The top edge never moves in a resize. The window keeps a smallest size and
 * stays inside the app window, the same margin from its edges as a dragged
 * window keeps. The size is remembered like the position (owner's choice).
 */

/** Smallest window (the frame's min-w-72 / min-h-56 in side-tutor.tsx). */
export const TUTOR_MIN_WIDTH = 288;
export const TUTOR_MIN_HEIGHT = 224;
/** Closest the window comes to the app window's edges. */
export const TUTOR_EDGE = 8;

export type TutorRect = { left: number; top: number; width: number; height: number };
export type TutorSize = { width: number; height: number };
export type TutorResizeEdge = "left" | "right" | "bottom" | "bottom-left" | "bottom-right";

/** The five resize zones, in the order they are drawn. */
export const TUTOR_RESIZE_EDGES: readonly TutorResizeEdge[] = ["left", "right", "bottom", "bottom-left", "bottom-right"];

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

/**
 * The window after `edge` has been dragged by (dx, dy) from `start`.
 *
 * - The right side moves the right edge; the left edge stays.
 * - The left side moves the left edge; the right edge stays where it was.
 * - The bottom moves the bottom edge; the top stays.
 */
export function resizeTutorRect(start: TutorRect, edge: TutorResizeEdge, dx: number, dy: number, viewport: TutorSize): TutorRect {
	let { left, width, height } = start;
	if (edge === "right" || edge === "bottom-right") {
		width = clamp(start.width + dx, TUTOR_MIN_WIDTH, viewport.width - TUTOR_EDGE - start.left);
	}
	if (edge === "left" || edge === "bottom-left") {
		const right = start.left + start.width;
		// Never jump a window that already sits closer to the edge than the margin.
		left = clamp(start.left + dx, Math.min(TUTOR_EDGE, start.left), right - TUTOR_MIN_WIDTH);
		width = right - left;
	}
	if (edge !== "left" && edge !== "right") {
		height = clamp(start.height + dy, TUTOR_MIN_HEIGHT, viewport.height - TUTOR_EDGE - start.top);
	}
	return { left, top: start.top, width, height };
}

/** A remembered size, or null when there is none worth using (nothing stored, or not numbers). */
export function storedTutorSize(raw: unknown): TutorSize | null {
	if (!raw || typeof raw !== "object") return null;
	const { width, height } = raw as { width?: unknown; height?: unknown };
	if (typeof width !== "number" || typeof height !== "number" || !Number.isFinite(width) || !Number.isFinite(height)) return null;
	return { width: Math.max(TUTOR_MIN_WIDTH, width), height: Math.max(TUTOR_MIN_HEIGHT, height) };
}

// ─── Opening from the bubble and closing into it (owner's pick: "Morph") ─────

/** How long the window takes to come out of the bubble, and to fold back into it. */
export const MORPH_OPEN_MS = 260;
export const MORPH_CLOSE_MS = 210;
/** The easing of the sync strip and the message box. */
export const MORPH_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

export interface MorphBox { left: number; top: number; width: number; height: number }

/**
 * The window squeezed onto the bubble: the transform that puts the window's
 * box exactly over the bubble's, the corner radius that makes that squeezed
 * box look round, and the scale that keeps the bubble's icon its own size
 * inside it. Animating from this to "no transform" (and back) is the morph;
 * only transform and opacity move, so nothing is laid out again on the way.
 * Null when either box has no size.
 */
export function morphStart(bubble: MorphBox, panel: MorphBox): { transform: string; borderRadius: string; iconTransform: string } | null {
	if (!(bubble.width > 0 && bubble.height > 0 && panel.width > 0 && panel.height > 0)) return null;
	const sx = bubble.width / panel.width;
	const sy = bubble.height / panel.height;
	const dx = bubble.left + bubble.width / 2 - (panel.left + panel.width / 2);
	const dy = bubble.top + bubble.height / 2 - (panel.top + panel.height / 2);
	const n = (value: number) => Number(value.toFixed(3));
	return {
		transform: `translate(${n(dx)}px, ${n(dy)}px) scale(${n(sx)}, ${n(sy)})`,
		borderRadius: `${n(bubble.width / 2 / sx)}px / ${n(bubble.height / 2 / sy)}px`,
		iconTransform: `scale(${n(1 / sx)}, ${n(1 / sy)})`,
	};
}
