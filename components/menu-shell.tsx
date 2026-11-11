"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { isPhoneNow, isTouchPhoneNow } from "@/components/phone/use-phone";

/**
 * THE shared menu shell (menu standardization, fix wave chunk B): one
 * placement body for the app's dropdown menus — portaled to document.body
 * (never clipped by an ancestor's overflow), fixed-anchored to the trigger's
 * rect, viewport-capped. PLACEMENT-ONLY by design: every site keeps its own
 * open/close/Esc contract (the layered-dismissal machinery differs
 * legitimately by surface — settings sections, the keys editor, the setup
 * dialog each own their Escape).
 *
 *  - Side: each site declares its preferred side — the composer opens UP
 *    (its control sits at screen bottom), the settings rows open DOWN;
 *    the shell flips when the preferred side cannot show the menu's
 *    content and the other side is roomier (the graph popovers'
 *    honest-fitting behavior, generalized).
 *  - Cap: max-height = min(60vh, the chosen side's available room); the
 *    menu scrolls internally instead of stretching the page or escaping
 *    the viewport (graph-view's max-h-[60vh] pattern).
 *  - Re-placement: capture-phase scroll + window resize — the settings
 *    menus' discipline (the settings dialog's inner content scroll
 *    included).
 *
 * Sites (model menus first, owner 2026-09-22; the graph popovers and the
 * stats-bar summary popover stay bespoke — seams stay open for later
 * adoption): the settings Agent section's slot + search-engine menus, the
 * Keys section's Add-provider menu, the composer's model/thinking menus
 * (model-picker.tsx), and the SetupDialog's slot pickers — portaling THOSE
 * out of the dialog's overflow-hidden frame so they extend beyond the
 * dialog exactly like the settings menus (owner, chunk B item 7).
 *
 * SSR: menus only mount client-side while open; the hidden measuring pass
 * below is the only pre-placement render, so a server render never emits
 * a positioned menu.
 */

const GAP = 4; // anchor edge → menu (the bespoke shells' settled 4px)
const EDGE = 8; // viewport floor the menu never enters
const CAP_VH = 0.6; // 60vh — the graph pattern's cap
const MIN_USABLE = 96; // floor: a shorter cap is an unusable sliver; the
// cap then overflows the edge instead of crushing the menu

/** A MenuShell mounted = a dropdown open (fix wave, owner ruling:
 *  the settings dialog's content column locks while any menu is down —
 *  no scrolling under a dropdown). The shell stays placement-only: it
 *  just ANNOUNCES, surfaces decide what to do with the fact (the
 *  settings dialog locks; anything un-lockable keeps the re-place-on-
 *  scroll fallback below). Count-based: overlapping menus open/close in
 *  any order and the accounting stays balanced. */
export const MENU_OPEN_EVENT = "lh:menu-open";
export const MENU_CLOSE_EVENT = "lh:menu-close";

export type MenuSide = "up" | "down";
export type MenuAlign = "left" | "right";

/** One placement decision. `style` is the fixed-position payload; the side
 *  rides back for the flip assertion in tests. */
export interface MenuPlacement {
	side: MenuSide;
	style: Record<string, string | number>;
	maxHeight: number;
}

/** PHONE (cloud sync Phase 3): the part of the screen a menu can use. On an
 *  iPhone the keyboard covers the page without changing innerHeight, so a
 *  menu placed from innerHeight ended up behind the keyboard (owner's
 *  iPhone); this is the visible height phone-viewport.tsx keeps in --lh-vvh. */
function phoneVisibleHeight(): number {
	const vvh = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--lh-vvh"));
	return Number.isFinite(vvh) && vvh > 0 ? Math.min(vvh, window.visualViewport?.height ?? vvh) : (window.visualViewport?.height ?? window.innerHeight);
}

/** PHONE: while the iPhone keyboard is up the body is shifted down
 *  (phone-viewport.tsx) and is the frame for fixed elements, so an anchor is
 *  measured from the body's top instead of the screen's. */
function phoneAnchorRect(r: DOMRect): { top: number; bottom: number; left: number; right: number } {
	const body = document.body;
	const shift = body.dataset.lhKeyboard !== undefined ? body.getBoundingClientRect().top : 0;
	return { top: r.top - shift, bottom: r.bottom - shift, left: r.left, right: r.right };
}

/** PHONE: an upward menu is pinned by its `top` (the anchor's top, minus
 *  the gap and the menu's own height) instead of `bottom`. `bottom` counts
 *  from the bottom of the fixed frame, and the iPhone doesn't report that
 *  reliably: the home-screen app's frame is taller than innerHeight, and the
 *  keyboard covers it without shrinking it, so the model list sat behind the
 *  keyboard (owner's iPhone). The top of the frame is the top of the screen
 *  (or of the shifted body, see phoneAnchorRect) in every case. Pure,
 *  exported for tests. */
export function phoneTopPlacement(p: MenuPlacement, anchorTop: number, menuHeight: number): MenuPlacement {
	if (typeof p.style.bottom !== "number") return p;
	const { bottom: _bottom, ...rest } = p.style;
	const height = Math.min(menuHeight, p.maxHeight);
	return { ...p, style: { ...rest, top: Math.max(EDGE, anchorTop - GAP - height) } };
}

/** Pure: the placement decision — anchored rect + viewport + the menu's
 *  UNCAPPED content height (scrollHeight, so re-placements after a search
 *  filter re-measure honestly) → side, fixed style, cap. Flip rule: stay
 *  on the preferred side unless it cannot show the full content AND the
 *  other side is roomier. The cap always keeps the menu inside its side's
 *  room when there is room; the floor keeps it usable when there isn't. */
export function computeMenuPlacement(
	rect: { top: number; bottom: number; left: number; right: number },
	viewport: { width: number; height: number },
	contentHeight: number,
	preferredSide: MenuSide,
	align: MenuAlign,
): MenuPlacement {
	const availDown = viewport.height - EDGE - (rect.bottom + GAP);
	const availUp = rect.top - GAP - EDGE;
	// contentHeight ≤ 0 (nothing measured yet) keeps the preferred side —
	// the hidden first pass re-measures and decides with real numbers.
	let side = preferredSide;
	if (contentHeight > 0) {
		const preferredAvail = preferredSide === "down" ? availDown : availUp;
		const otherAvail = preferredSide === "down" ? availUp : availDown;
		if (contentHeight > preferredAvail && otherAvail > preferredAvail) {
			side = preferredSide === "down" ? "up" : "down";
		}
	}
	const avail = side === "down" ? availDown : availUp;
	const maxHeight = Math.max(MIN_USABLE, Math.min(CAP_VH * viewport.height, avail));
	const horizontal: Record<string, number> =
		align === "right" ? { right: viewport.width - rect.right } : { left: rect.left };
	const vertical: Record<string, number> =
		side === "down" ? { top: rect.bottom + GAP } : { bottom: viewport.height - rect.top + GAP };
	return { side, style: { ...horizontal, ...vertical }, maxHeight };
}

/** PHONE (cloud sync Phase 3): keep a menu fully on screen. A narrow screen
 *  can't fit a menu beside its anchor (a session row's menu opened to the
 *  row's left, off the edge), so it slides back inside the 8px margin. Used
 *  only in the phone layout; the desktop placement is unchanged. */
export function clampMenuToScreen(placement: MenuPlacement, menuWidth: number, viewportWidth: number): MenuPlacement {
	const { left, right, ...rest } = placement.style as { left?: number; right?: number };
	const width = Math.min(menuWidth, viewportWidth - 2 * EDGE);
	const start = typeof left === "number" ? left : viewportWidth - (right ?? 0) - menuWidth;
	const clamped = Math.min(Math.max(EDGE, start), viewportWidth - EDGE - width);
	return { ...placement, style: { ...rest, left: clamped, maxWidth: viewportWidth - 2 * EDGE } };
}

/** The shared shell. Exactly one anchor seam: pass `anchorRef` (a live
 *  element ref) or `anchorTestid` (the settings section's pattern — the
 *  trigger is queried by testid at place time). */
export function MenuShell({
	anchorRef,
	anchorTestid,
	testid,
	preferredSide,
	align = "right",
	menuClass,
	children,
}: {
	anchorRef?: RefObject<HTMLElement | null>;
	anchorTestid?: string;
	/** The menu body's own testid (sites assert it). */
	testid: string;
	/** Which way the menu opens from the anchor when both sides fit. */
	preferredSide: MenuSide;
	/** Which anchor edge the menu's horizontal position keys off. */
	align?: MenuAlign;
	/** The menu body classes: width, border, bg, padding, text — the
	 *  shell adds position, z-index, the height cap, and scrolling. */
	menuClass: string;
	children: ReactNode;
}) {
	const menuRef = useRef<HTMLDivElement>(null);
	const [placed, setPlaced] = useState<MenuPlacement | null>(null);
	const focusedOnceRef = useRef(false);

	// Announce open↔close for lockable surfaces (see MENU_OPEN_EVENT).
	useEffect(() => {
		window.dispatchEvent(new CustomEvent(MENU_OPEN_EVENT));
		return () => {
			window.dispatchEvent(new CustomEvent(MENU_CLOSE_EVENT));
		};
	}, []);

	// Focus on open (owner, fix wave): the search menus land focus IN the
	// search; menus without one land it on the body (tabIndex -1 below) so
	// the arrow machine has a home. Once only — re-placements (scroll/
	// resize) must never steal focus back mid-walk. The lists' own mount
	// focus runs during the hidden measuring pass, where focus() silently
	// fails (visibility: hidden subtrees are not focusable) — this seam is
	// the one that actually lands.
	useEffect(() => {
		if (placed === null || focusedOnceRef.current) return;
		focusedOnceRef.current = true;
		const el = menuRef.current;
		if (!el) return;
		const input = el.querySelector<HTMLElement>("input");
		// PHONE: a touch phone lands on the menu body, not the search, so the
		// on-screen keyboard doesn't pop up over the list (owner's iPhone);
		// tapping the search still opens it.
		(isTouchPhoneNow() ? el : (input ?? el)).focus();
	}, [placed]);

	// The standard arrow machine for menus WITHOUT a search (owner: when a
	// dropdown is expanded, the arrow keys cycle the options and never
	// scroll the screen): ArrowDown/Up move DOM focus among the option
	// buttons with WRAP, Home/End hit the ends; Enter activates the
	// focused button natively. Search menus own their arrows inside the
	// input (their clamped-walk machine, 2026-09-17) — those events never
	// bubble here, and the input/textarea guard is belt-and-braces.
	const onBodyKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
		const { key } = e;
		if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") return;
		const buttons = Array.from(
			menuRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? [],
		);
		if (buttons.length === 0) return;
		e.preventDefault();
		if (key === "Home") {
			buttons[0]?.focus();
			return;
		}
		if (key === "End") {
			buttons[buttons.length - 1]?.focus();
			return;
		}
		const delta = key === "ArrowDown" ? 1 : -1;
		const idx = buttons.findIndex((b) => b === document.activeElement);
		// From the body (nothing focused yet): ArrowDown enters at the FIRST
		// option, ArrowUp at the last — the native-select convention.
		const base = idx === -1 ? (delta > 0 ? -1 : 0) : idx;
		const next = (base + delta + buttons.length) % buttons.length;
		buttons[next]?.focus();
	};

	const anchor = () => {
		if (anchorRef) return anchorRef.current;
		if (anchorTestid !== undefined) return document.querySelector(`[data-testid="${anchorTestid}"]`);
		return null;
	};

	// Measure + (re)place: on mount, then on every capture-phase scroll and
	// resize (rAF-throttled). scrollHeight keeps the flip decision honest
	// after the content changes shape (a search filtering the list).
	useLayoutEffect(() => {
		let raf = 0;
		const place = () => {
			const el = anchor();
			if (!el || !menuRef.current) return;
			const phone = isPhoneNow();
			const menu = menuRef.current;
			const rect = phone ? phoneAnchorRect(el.getBoundingClientRect()) : el.getBoundingClientRect();
			const p = computeMenuPlacement(
				rect,
				{ width: window.innerWidth, height: phone ? phoneVisibleHeight() : window.innerHeight },
				menu.scrollHeight,
				preferredSide,
				align,
			);
			if (!phone) {
				setPlaced(p);
				return;
			}
			// The rendered height: content plus the border, within the cap.
			const borders = menu.offsetHeight - menu.clientHeight;
			setPlaced(phoneTopPlacement(clampMenuToScreen(p, menu.offsetWidth, window.innerWidth), rect.top, menu.scrollHeight + borders));
		};
		place();
		const rePlace = () => {
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(place);
		};
		window.addEventListener("scroll", rePlace, true);
		window.addEventListener("resize", rePlace);
		// PHONE: the iPhone keyboard changes only the visual viewport, and a
		// top-pinned menu re-places when its content changes (a search
		// filtering the list), so it stays attached to its anchor.
		window.visualViewport?.addEventListener("resize", rePlace);
		const contentObserver = isPhoneNow() && menuRef.current ? new ResizeObserver(rePlace) : null;
		if (contentObserver && menuRef.current) for (const child of Array.from(menuRef.current.children)) contentObserver.observe(child);
		return () => {
			cancelAnimationFrame(raf);
			window.removeEventListener("scroll", rePlace, true);
			window.removeEventListener("resize", rePlace);
			window.visualViewport?.removeEventListener("resize", rePlace);
			contentObserver?.disconnect();
		};
	}, [anchorRef, anchorTestid, preferredSide, align]);

	// First pass: mounted hidden at the viewport's top-left so the layout
	// effect can measure the real content height before anything is seen.
	// The menu is positioned ONCE and then only re-anchored — no flash.
	if (placed === null) {
		return createPortal(
			<div
				ref={menuRef}
				data-testid={testid}
				data-lh-menu=""
				style={{ position: "fixed", left: 0, top: 0, visibility: "hidden" }}
				className={menuClass}
			>
				{children}
			</div>,
			document.body,
		);
	}
	return createPortal(
		<div
			ref={menuRef}
			data-testid={testid}
			data-lh-menu=""
			tabIndex={-1}
			onKeyDown={onBodyKeyDown}
			style={{ position: "fixed", zIndex: 60, ...placed.style, maxHeight: placed.maxHeight, overflowY: "auto" }}
			// The body is the arrow machine's focus home (input-less menus
			// land focus here on open) — the focus STAYS, but the browser's
			// default blue ring around it must not draw (owner, polish
			// round). Arrow cycling moves DOM focus to the buttons, which
			// carry their own hover/highlight; the ring is pure noise.
			className={`${menuClass} outline-none`}
		>
			{children}
		</div>,
		document.body,
	);
}