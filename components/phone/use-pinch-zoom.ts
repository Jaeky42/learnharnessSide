"use client";

/**
 * TWO-FINGER PINCH (cloud sync Phase 3) for the plan and diagram viewers,
 * which zoom with the mouse wheel and the − / + buttons on the desktop.
 *
 * Phone layout only, so a desktop touchscreen keeps today's behavior. While
 * two fingers are down, their pointer events stop at the viewport, so the
 * viewer's own one-finger pan doesn't also move the picture.
 */

import { useEffect, useRef, type RefObject } from "react";
import { isPhoneNow } from "@/components/phone/use-phone";

type Point = { x: number; y: number };

/** Pure rule, exported for tests: the zoom factor and focus between two
 *  finger positions and the previous pair. */
export function pinchStep(prev: [Point, Point], next: [Point, Point]): { factor: number; focus: Point } | null {
	const d0 = Math.hypot(prev[0].x - prev[1].x, prev[0].y - prev[1].y);
	const d1 = Math.hypot(next[0].x - next[1].x, next[0].y - next[1].y);
	if (d0 < 1 || d1 < 1) return null;
	return { factor: d1 / d0, focus: { x: (next[0].x + next[1].x) / 2, y: (next[0].y + next[1].y) / 2 } };
}

export function usePinchZoom(ref: RefObject<HTMLElement | null>, onPinch: (factor: number, focus: Point) => void): void {
	const onPinchRef = useRef(onPinch);
	onPinchRef.current = onPinch;
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const touches = new Map<number, Point>();
		let last: [Point, Point] | null = null;
		const local = (e: PointerEvent): Point => {
			const r = el.getBoundingClientRect();
			return { x: e.clientX - r.left, y: e.clientY - r.top };
		};
		const pair = (): [Point, Point] | null => {
			const pts = [...touches.values()];
			const [a, b] = pts;
			return pts.length === 2 && a && b ? [a, b] : null;
		};
		const onDown = (e: PointerEvent) => {
			if (e.pointerType !== "touch" || !isPhoneNow()) return;
			touches.set(e.pointerId, local(e));
			if (touches.size === 2) {
				last = pair();
				e.stopPropagation(); // the second finger doesn't start a pan
			}
		};
		const onMove = (e: PointerEvent) => {
			if (!touches.has(e.pointerId)) return;
			touches.set(e.pointerId, local(e));
			const now = pair();
			if (!now || !last) return;
			e.stopPropagation();
			const step = pinchStep(last, now);
			last = now;
			if (step) onPinchRef.current(step.factor, step.focus);
		};
		const onUp = (e: PointerEvent) => {
			if (!touches.delete(e.pointerId)) return;
			if (touches.size < 2) last = null;
		};
		el.addEventListener("pointerdown", onDown);
		el.addEventListener("pointermove", onMove);
		el.addEventListener("pointerup", onUp);
		el.addEventListener("pointercancel", onUp);
		return () => {
			el.removeEventListener("pointerdown", onDown);
			el.removeEventListener("pointermove", onMove);
			el.removeEventListener("pointerup", onUp);
			el.removeEventListener("pointercancel", onUp);
		};
	}, [ref]);
}
