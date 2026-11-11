"use client";

/**
 * THE SIDE-TUTOR WINDOW — a small, persistent panel that floats over a
 * teaching session. Its top bar moves it; its left, right and bottom sides
 * and its two bottom corners resize it (side-tutor-window.ts). The learner asks quick questions here; a second
 * agent answers with read-only sight of the lesson (server: src/server/
 * side-tutor.ts). Nothing typed here enters the lesson's transcript, so
 * the main teacher's context window never grows from it.
 *
 * Keyboard isolation: every keydown inside the panel stops propagating, so
 * the session's document-level handlers (question-dock arrows/Tab, the
 * Enter-opens-check listener, the Esc abort chain) never fire from here.
 * Esc inside the panel minimizes it instead.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpIcon, GripHorizontalIcon, MessageCircleQuestionIcon, MinusIcon, SquareIcon, Trash2Icon } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { BrailleSpinner } from "@/components/braille-spinner";
import { blurAfterPointerClick } from "@/components/focus-hygiene";
import { cn } from "@/lib/utils";
import { isPhoneNow, useIsPhone } from "@/components/phone/use-phone";
import { useDockAnchor } from "@/components/phone/use-dock-anchor";
import { plainEnterSends } from "@/components/phone/enter-key";
import { joinDictation, type Dictation } from "@/components/dictation";
import { SideTutorDictate } from "@/components/side-tutor-dictation";
import { useSideDictationOwned } from "@/components/side-tutor-dictation-state";
import { resizeTutorRect, storedTutorSize, TUTOR_EDGE, TUTOR_RESIZE_EDGES, type TutorRect, type TutorResizeEdge, type TutorSize } from "@/components/side-tutor-window";
import {
	HELD_TEXT,
	SIDE_TUTOR_MAX_QUESTION_CHARS,
	type SideTutorEntry,
	type SideTutorThread,
	type SideTutorWireEvent,
} from "@/src/core";

/** The minimized bubble on a computer (the phone's own values are in
 *  app/phone.css). Owner's placing, after trying it right on the bar's end
 *  (too close): off to the side at the lesson's bottom right, this far in
 *  from the lesson's right edge and this far above the question bar. On a
 *  wide lesson that is beside the bar's end, not over it. */
const BUBBLE_EDGE_GAP = 16;
const BUBBLE_BAR_GAP = 20;
/** While an opened question leaves no room above the bar: under the top
 *  bar, the same distance in from the lesson's right edge. */
const BUBBLE_TOP = 72;

/**
 * The window's colours (owner's ask). Its bars (the top bar, the message line
 * and the typing row) keep the app's background, nearly solid. The middle,
 * where the conversation is, is closer to black and more see-through, so the
 * lesson behind it shows through, blurred.
 */
const BAR_BG = "bg-background/95";
const BODY_BG = "bg-black/60";

/**
 * The typing row's sizes. The Dictate and Send buttons are squares as tall as
 * the one-line typing box (owner's ask): one line of the box's text plus its
 * padding and border. The text is the lesson's reading size (a setting), or
 * 16 px on a phone (app/phone.css sets --lh-tutor-text there), so the sizes
 * are worked out from that instead of written as numbers. The hint is a
 * little smaller than typed text (owner's ask) on the same line height, so it
 * sits where the typed words will.
 */
const TYPING_ROW_VARS = {
	"--lh-tutor-line": "calc(var(--lh-tutor-text, var(--lh-prose-size)) * var(--lh-prose-leading))",
	"--lh-tutor-row": "calc(var(--lh-tutor-line) + 1rem + 2px)",
	"--lh-tutor-hint": "calc(var(--lh-tutor-text, var(--lh-prose-size)) * 0.875)",
} as React.CSSProperties;

const OPEN_KEY = "lh:side-tutor:open";
const POS_KEY = "lh:side-tutor:pos";
/** The size the window was last dragged to (owner's choice: remembered, like its position). */
const SIZE_KEY = "lh:side-tutor:size";
/** Default size/anchor: under the 60px top bar, against the right edge. */
const DEFAULT_WIDTH = 352;
const DEFAULT_TOP = 72;
const DEFAULT_RIGHT_GAP = 16;
/** Under a strip the window keeps the gap it has under the top bar at its default place. */
const STRIP_GAP = 12;
const EDGE = TUTOR_EDGE;

/** The window's size until it is resized (the phone's sheet is sized by app/phone.css). */
const WINDOW_SIZE = "h-[min(30rem,calc(100dvh-6rem))] min-h-56 w-[22rem] min-w-72 max-w-[calc(100vw-1rem)]";
/** On a computer the height has a limit too, like the width: a size
 *  remembered from a big app window still fits a small one. */
const FRAME_MAX_HEIGHT = "max-h-[calc(100dvh-1rem)]";

/**
 * Where each resize zone is, and its pointer. Nothing is drawn. The zones sit
 * ON the window's edges (owner's ask: mostly outside it, they were hard to
 * find): each strip is 12 px thick, 8 px inside the window's edge and 4 px
 * outside it. Those 8 px are the window's own empty rim (the padding round
 * the typing row and the conversation), so no strip covers anything to press.
 *
 * - The side strips start under the top bar (40 px), which is for moving.
 * - A corner is an L: it runs 28 px along both of its edges, so it is found
 *   from either side. Its inner square is cut away (CORNER_SHAPE), leaving
 *   the typing box's and Send's own corners alone.
 */
const RESIZE_ZONES: Record<TutorResizeEdge, string> = {
	left: "top-10 bottom-7 -left-1 w-3 cursor-ew-resize",
	right: "top-10 bottom-7 -right-1 w-3 cursor-ew-resize",
	bottom: "-bottom-1 left-7 right-7 h-3 cursor-ns-resize",
	"bottom-left": "-bottom-1 -left-1 size-8 cursor-nesw-resize",
	"bottom-right": "-bottom-1 -right-1 size-8 cursor-nwse-resize",
};
/** The corners' L shapes, in their 32 px boxes: two arms as thick as the strips. */
const CORNER_SHAPE: Partial<Record<TutorResizeEdge, string>> = {
	"bottom-left": "polygon(0 0, 12px 0, 12px 20px, 32px 20px, 32px 32px, 0 32px)",
	"bottom-right": "polygon(20px 0, 32px 0, 32px 32px, 0 32px, 0 20px, 20px 20px)",
};

type Pos = { left: number; top: number };

function defaultPos(): Pos {
	return { left: window.innerWidth - DEFAULT_WIDTH - DEFAULT_RIGHT_GAP, top: DEFAULT_TOP };
}

function readStored<T>(key: string, fallback: T): T {
	try {
		const raw = window.localStorage.getItem(key);
		return raw === null ? fallback : (JSON.parse(raw) as T);
	} catch {
		return fallback;
	}
}

function writeStored(key: string, value: unknown): void {
	try {
		window.localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// storage unavailable — the preference just doesn't stick
	}
}

function clampPos(pos: Pos, width: number, height = 64): Pos {
	const maxLeft = Math.max(EDGE, window.innerWidth - width - EDGE);
	const maxTop = Math.max(EDGE, window.innerHeight - Math.min(height, 120) - EDGE);
	const left = Number.isFinite(pos.left) ? pos.left : maxLeft;
	const top = Number.isFinite(pos.top) ? pos.top : DEFAULT_TOP;
	return {
		left: Math.min(Math.max(EDGE, left), maxLeft),
		top: Math.min(Math.max(EDGE, top), maxTop),
	};
}

export function SideTutor({ chatId, dictation, held = false, clearBelow = 0 }: {
	chatId: string;
	/** The page's dictation run, for the tutor's Dictate button. */
	dictation?: Dictation;
	/** Cloud sync (Phase 6): another device holds this session. The tutor can't
	 *  be asked until it is taken over: its window closes to a greyed bubble. */
	held?: boolean;
	/** Cloud sync (Phase 6): where a strip open under the top bar ends, in px
	 *  from the top (0 = no strip). On a computer the window keeps below it for
	 *  as long as the strip is there, and is back at its own place after. */
	clearBelow?: number;
}) {
	const [mounted, setMounted] = useState(false);
	const [openWanted, setOpen] = useState(true);
	const open = openWanted && !held;
	const [pos, setPos] = useState<Pos>({ left: 0, top: DEFAULT_TOP });
	/** The size it was resized to; null until then (the frame's own size). */
	const [size, setSize] = useState<TutorSize | null>(null);
	const [entries, setEntries] = useState<SideTutorEntry[]>([]);
	const [live, setLive] = useState<{ question: string; text: string } | null>(null);
	const [remoteRunning, setRemoteRunning] = useState(false);
	const [input, setInputState] = useState("");
	/** The typing box's text, readable at once: a send that first ends a
	 *  dictation run must see the words that run just delivered. */
	const inputTextRef = useRef("");
	const setInput = useCallback((next: string) => {
		inputTextRef.current = next;
		setInputState(next);
	}, []);
	/** Spoken words join what is already typed (the lesson's separator rule). */
	const appendDictated = useCallback((text: string) => setInput(joinDictation(inputTextRef.current, text).slice(0, SIDE_TUTOR_MAX_QUESTION_CHARS)), [setInput]);
	const tutorDictating = useSideDictationOwned() && dictation?.active === true;
	const [notice, setNotice] = useState<string | null>(null);

	const panelRef = useRef<HTMLDivElement>(null);
	const resizeRef = useRef<{ edge: TutorResizeEdge; x: number; y: number; start: TutorRect } | null>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const dragRef = useRef<{ x: number; y: number; start: Pos } | null>(null);
	/** Last known panel width, for keeping the dragged window on screen. */
	const widthRef = useRef(DEFAULT_WIDTH);
	const fetchAbortRef = useRef<AbortController | null>(null);
	// PHONE (cloud sync Phase 3): a bubble above the message box that opens a
	// bottom sheet. It always starts closed there, can't be dragged or
	// resized, and never touches the desktop's saved open state or position.
	const phone = useIsPhone();
	// Minimized, the tutor is the same round bubble on a computer (owner's
	// ask): at the lesson's bottom right, just above the question, wherever
	// the open window was dragged to.
	const anchor = useDockAnchor(true);

	// Client-only preferences (no SSR mismatch).
	useEffect(() => {
		setOpen(isPhoneNow() ? false : readStored(OPEN_KEY, true));
		const stored = storedTutorSize(readStored<unknown>(SIZE_KEY, null));
		setSize(stored);
		setPos(clampPos(readStored(POS_KEY, defaultPos()), Math.min(stored?.width ?? DEFAULT_WIDTH, window.innerWidth - 2 * EDGE)));
		setMounted(true);
	}, []);

	const loadThread = useCallback(async () => {
		try {
			const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/side-tutor`);
			if (!res.ok) return;
			const thread = (await res.json()) as SideTutorThread & { running?: boolean };
			setEntries(thread.entries);
			setRemoteRunning(thread.running === true);
		} catch {
			// offline / server restarting — keep what we have
		}
	}, [chatId]);

	useEffect(() => {
		void loadThread();
		return () => fetchAbortRef.current?.abort();
	}, [loadThread]);

	// An answer started from an earlier mount is still finishing: poll until
	// it lands, then show it.
	useEffect(() => {
		if (!remoteRunning || live) return;
		const t = window.setInterval(() => void loadThread(), 1500);
		return () => window.clearInterval(t);
	}, [remoteRunning, live, loadThread]);

	// Keep the newest content in view.
	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [entries, live, open]);

	// Re-clamp on viewport resize and after opening/closing changes the size.
	useEffect(() => {
		if (!mounted) return;
		const onResize = () => {
			const el = panelRef.current;
			if (el) widthRef.current = el.offsetWidth;
			setPos((p) => clampPos(p, widthRef.current, el?.offsetHeight));
		};
		onResize();
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, [mounted, open]);

	const setOpenPersist = (next: boolean) => {
		// Minimizing ends a dictation to the tutor; its words stay in the box.
		if (!next && tutorDictating) dictation?.stop();
		if (!next && panelRef.current) widthRef.current = panelRef.current.offsetWidth;
		setOpen(next);
		if (isPhoneNow()) return; // no auto-focus either: it would pop the keyboard up
		writeStored(OPEN_KEY, next);
		if (next) window.setTimeout(() => inputRef.current?.focus(), 0);
	};

	const busy = live !== null || remoteRunning;

	const ask = async () => {
		// Still dictating to the tutor: end the run first, so the last words
		// are in the box before it is read (the lesson's "nothing gets lost").
		if (tutorDictating && dictation) await dictation.finish();
		const question = inputTextRef.current.trim();
		if (!question || busy) return;
		setNotice(null);
		setInput("");
		setLive({ question, text: "" });
		const controller = new AbortController();
		fetchAbortRef.current = controller;
		try {
			const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/side-tutor`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ question }),
				signal: controller.signal,
			});
			if (!res.ok || !res.body) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				setNotice(body?.error ?? `The side tutor is unavailable (${res.status}).`);
				setInput(question); // give the question back
				return;
			}
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let nl: number;
				while ((nl = buffer.indexOf("\n")) >= 0) {
					const line = buffer.slice(0, nl).trim();
					buffer = buffer.slice(nl + 1);
					if (!line) continue;
					let event: SideTutorWireEvent;
					try {
						event = JSON.parse(line) as SideTutorWireEvent;
					} catch {
						continue;
					}
					if (event.type === "text") setLive({ question, text: event.text });
					else if (event.type === "done") setEntries((prev) => [...prev, event.entry]);
					else if (event.type === "error") {
						if (event.entry) setEntries((prev) => [...prev, event.entry!]);
						setNotice(event.error);
					}
				}
			}
		} catch (err) {
			if (!(err instanceof DOMException && err.name === "AbortError")) {
				setNotice("Lost the connection to the side tutor.");
				void loadThread();
			}
		} finally {
			if (fetchAbortRef.current === controller) fetchAbortRef.current = null;
			setLive(null);
		}
	};

	const stop = async () => {
		try {
			await fetch(`/api/chats/${encodeURIComponent(chatId)}/side-tutor`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "abort" }),
			});
		} catch {
			fetchAbortRef.current?.abort();
		}
	};

	const clear = async () => {
		if (busy || entries.length === 0) return;
		const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/side-tutor`, { method: "DELETE" }).catch(() => null);
		if (res?.ok) {
			setEntries([]);
			setNotice(null);
		}
	};

	// ── keeping clear of the strip under the top bar (cloud sync) ─────────
	// The window is shown below the strip while there is one; its own place
	// (pos, and what is remembered) doesn't change unless it is dragged then.
	// A window too tall to move down stays where it is.
	const shownTop = phone || clearBelow <= 0 ? pos.top
		: Math.max(pos.top, Math.min(clearBelow + STRIP_GAP, Math.max(pos.top, window.innerHeight - EDGE - (panelRef.current?.offsetHeight ?? 0))));
	// It glides there with the strip (200 ms, the strip's own easing), and
	// only then: a transition on `top` would make dragging lag.
	const [gliding, setGliding] = useState(false);
	const glidedRef = useRef(false);
	useEffect(() => {
		if (!glidedRef.current) { glidedRef.current = true; return; }
		setGliding(true);
		const timer = setTimeout(() => setGliding(false), 260);
		return () => clearTimeout(timer);
	}, [clearBelow]);

	// ── dragging by the header ────────────────────────────────────────────
	const onDragStart = (e: React.PointerEvent) => {
		if (phone || (e.target as HTMLElement).closest("button")) return;
		e.preventDefault();
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		dragRef.current = { x: e.clientX, y: e.clientY, start: { left: pos.left, top: shownTop } };
	};
	const onDragMove = (e: React.PointerEvent) => {
		const d = dragRef.current;
		if (!d) return;
		const el = panelRef.current;
		if (el) widthRef.current = el.offsetWidth;
		setPos(clampPos({ left: d.start.left + (e.clientX - d.x), top: d.start.top + (e.clientY - d.y) }, widthRef.current, el?.offsetHeight));
	};
	const onDragEnd = (e: React.PointerEvent) => {
		if (!dragRef.current) return;
		dragRef.current = null;
		(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
		setPos((p) => {
			writeStored(POS_KEY, p);
			return p;
		});
	};

	// ── resizing by the sides and the bottom corners (computer only) ──────
	const onResizeStart = (edge: TutorResizeEdge) => (e: React.PointerEvent) => {
		const el = panelRef.current;
		if (phone || !el || e.button > 0) return;
		e.preventDefault(); // no text selection, and the typing box keeps its focus
		(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
		// From the size it really has: a remembered size can be held smaller by a small app window.
		resizeRef.current = { edge, x: e.clientX, y: e.clientY, start: { left: pos.left, top: shownTop, width: el.offsetWidth, height: el.offsetHeight } };
	};
	const onResizeMove = (e: React.PointerEvent) => {
		const r = resizeRef.current;
		if (!r) return;
		const next = resizeTutorRect(r.start, r.edge, e.clientX - r.x, e.clientY - r.y, { width: window.innerWidth, height: window.innerHeight });
		widthRef.current = next.width;
		setPos({ left: next.left, top: next.top });
		setSize({ width: next.width, height: next.height });
	};
	const onResizeEnd = (e: React.PointerEvent) => {
		if (!resizeRef.current) return;
		resizeRef.current = null;
		(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
		// Read back through the setters: the last move's values, not this render's.
		setSize((s) => {
			if (s) writeStored(SIZE_KEY, s);
			return s;
		});
		setPos((p) => {
			writeStored(POS_KEY, p);
			return p;
		});
	};

	if (!mounted) return null;

	const onPanelKeyDown = (e: React.KeyboardEvent) => {
		e.stopPropagation();
		if (e.key === "Escape") {
			e.preventDefault();
			// Esc cancels a dictation to the tutor first, as it does in the lesson.
			if (tutorDictating) {
				dictation?.cancel();
				return;
			}
			(document.activeElement as HTMLElement | null)?.blur?.();
			setOpenPersist(false);
		}
	};

	if (!open) {
		// On a computer the bubble is drawn inside the dock, above its top right
		// corner, which is the lesson's bottom right (owner's ask): it then keeps
		// its place against the question bar exactly, while the lesson scrolls
		// and while a question opens or folds. With no room above an opened
		// question it sits under the top bar, as far right as here.
		// On a held session there is no question bar to sit above (the dock is
		// hidden): the greyed bubble keeps to the lesson's bottom right.
		const onDock = !phone && !held && anchor.place === "above-dock" && anchor.dock !== null;
		const bubble = (
			<button
				type="button"
				data-testid="side-tutor-toggle"
				// PHONE: a round bubble above the dock, or in the top-right corner
				// while an opened question fills the screen; app/phone.css sizes it
				// and places it sideways.
				data-phone="tutor-bubble"
				data-place={anchor.place}
				data-phone-place={phone ? anchor.place : undefined}
				data-held={held ? "" : undefined}
				aria-disabled={held || undefined}
				title={held ? HELD_TEXT.blocked : undefined}
				onClick={(e) => {
					blurAfterPointerClick(e);
					if (held) return;
					setOpenPersist(true);
				}}
				onKeyDown={(e) => e.stopPropagation()}
				style={
					(phone
						? anchor.place === "above-dock"
							? { top: anchor.top }
							: {}
						: onDock
							? { right: BUBBLE_EDGE_GAP, bottom: `calc(100% + ${BUBBLE_BAR_GAP}px)`, WebkitAppRegion: "no-drag" }
							: held
								? { right: anchor.right + BUBBLE_EDGE_GAP, bottom: BUBBLE_BAR_GAP, WebkitAppRegion: "no-drag" }
								: { right: anchor.right + BUBBLE_EDGE_GAP, top: BUBBLE_TOP, WebkitAppRegion: "no-drag" }) as React.CSSProperties
				}
				className={cn(
					"z-30 flex size-13 items-center justify-center rounded-full border border-border bg-card/85 text-muted-foreground shadow-[0_6px_18px_rgb(0_0_0/0.35)] backdrop-blur transition-colors",
					held ? "cursor-default opacity-40" : "hover:bg-accent hover:text-foreground",
					// The dock lets clicks through to the lesson; the bubble takes its own.
					onDock ? "pointer-events-auto absolute" : "fixed",
				)}
				aria-label="Open the side tutor"
			>
				<MessageCircleQuestionIcon className="size-6" />
				{busy && (
					<span className="absolute -right-0.5 -top-0.5 rounded-full bg-background px-1 py-0.5 text-[0.625rem] leading-none text-foreground">
						<BrailleSpinner className="h-3" label="Answering" />
					</span>
				)}
			</button>
		);
		return onDock && anchor.dock ? createPortal(bubble, anchor.dock) : bubble;
	}

	return (
		<>
		{phone && <div data-phone="backdrop" data-phone-layer="sheet" aria-hidden="true" onClick={() => setOpenPersist(false)} />}
		{/* The frame: on a computer it holds the window's place and size, and
		    the resize zones around the window. On a phone it is no box at all
		    (the sheet is placed by app/phone.css). */}
		<div
			data-testid="side-tutor-frame"
			style={(phone ? {} : { left: pos.left, top: shownTop, ...(size ? { width: size.width, height: size.height } : {}), ...(gliding ? { transition: "top 200ms cubic-bezier(0.2, 0.8, 0.2, 1)" } : {}), WebkitAppRegion: "no-drag" }) as React.CSSProperties}
			className={phone ? "contents" : cn("fixed z-30 motion-reduce:!transition-none", WINDOW_SIZE, FRAME_MAX_HEIGHT)}
		>
		<div
			ref={panelRef}
			data-testid="side-tutor"
			data-phone="tutor-sheet"
			role="complementary"
			aria-label="Side tutor"
			onKeyDown={onPanelKeyDown}
			style={(phone ? {} : { WebkitAppRegion: "no-drag" }) as React.CSSProperties}
			className={cn("flex flex-col overflow-hidden rounded-xl border border-border shadow-xl backdrop-blur", phone ? cn("fixed z-30", WINDOW_SIZE) : "size-full")}
		>
			<div
				className={cn("flex cursor-grab touch-none items-center gap-2 border-b border-border px-3 py-2 select-none active:cursor-grabbing", BAR_BG)}
				onPointerDown={onDragStart}
				onPointerMove={onDragMove}
				onPointerUp={onDragEnd}
				onPointerCancel={onDragEnd}
			>
				<GripHorizontalIcon data-phone="hide" className="size-3.5 text-muted-foreground/60" />
				{/* The title is one word and there is no tagline (owner's wording). */}
				<div className="min-w-0 flex-1 text-sm font-medium leading-tight">Tutor</div>
				<button
					type="button"
					onClick={(e) => {
						blurAfterPointerClick(e);
						void clear();
					}}
					disabled={busy || entries.length === 0}
					className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
					aria-label="Clear side questions"
					title="Clear side questions"
				>
					<Trash2Icon className="size-3.5" />
				</button>
				<button
					type="button"
					onClick={(e) => {
						blurAfterPointerClick(e);
						setOpenPersist(false);
					}}
					className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					aria-label="Minimize the side tutor"
					title="Minimize (Esc)"
				>
					<MinusIcon className="size-3.5" />
				</button>
			</div>

			<div data-testid="side-tutor-body" className={cn("flex min-h-0 flex-1 flex-col text-sm", BODY_BG)}>
			{/* On a computer the scrolling part stops 8 px short of the window's
			    right edge, so its scrollbar isn't under the resize strip there.
			    The words keep their place: the 8 px come off the right padding. */}
			<div ref={scrollRef} data-testid="side-tutor-scroll" className={cn("min-h-0 flex-1 space-y-3 overflow-y-auto py-3", phone ? "px-3" : "mr-2 pl-3 pr-1")}>
				{entries.length === 0 && !live && (
					// The empty window's one sentence (owner's ask).
					<p className="text-xs leading-relaxed text-muted-foreground">Stuck on a term or a step? Ask here.</p>
				)}
				{entries.map((entry) => (
					<Exchange
						key={entry.id}
						question={entry.question}
						answer={entry.answer}
						status={entry.status}
						error={entry.error}
					/>
				))}
				{live && <Exchange question={live.question} answer={live.text} status="streaming" />}
				{remoteRunning && !live && (
					<div className="flex items-center gap-2 text-xs text-muted-foreground">
						<BrailleSpinner className="h-3" label="Answering" /> Finishing an earlier answer…
					</div>
				)}
			</div>
			</div>

			{notice && <div className={cn("border-t border-border px-3 py-1.5 text-xs text-destructive", BAR_BG)}>{notice}</div>}

			<div className={cn("flex items-end gap-2 border-t border-border p-2", BAR_BG)} style={TYPING_ROW_VARS}>
				<textarea
					ref={inputRef}
					value={input}
					maxLength={SIDE_TUTOR_MAX_QUESTION_CHARS}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey && plainEnterSends() && !e.nativeEvent.isComposing) {
								e.preventDefault();
								void ask();
						}
					}}
					rows={1}
					placeholder="Ask a follow-up…"
					className="lh-prose field-sizing-content max-h-28 min-h-(--lh-tutor-row) flex-1 resize-none rounded-md border border-input bg-transparent px-2.5 py-2 text-sm outline-none placeholder:text-(length:--lh-tutor-hint) placeholder:leading-(--lh-tutor-line) placeholder:text-muted-foreground focus-visible:border-ring"
					aria-label="Ask the side tutor"
				/>
				{/* Speak instead of typing (owner's ask): a microphone, and while it
				    listens a small live waveform with Stop. */}
				{dictation && <SideTutorDictate dictation={dictation} append={appendDictated} />}
				{live ? (
					<button
						type="button"
						onClick={(e) => {
							blurAfterPointerClick(e);
							void stop();
						}}
						className="flex size-(--lh-tutor-row) shrink-0 items-center justify-center rounded-md bg-secondary text-secondary-foreground hover:bg-secondary/80"
						aria-label="Stop the answer"
						title="Stop"
					>
						<SquareIcon className="size-4" />
					</button>
				) : (
					<button
						type="button"
						onClick={(e) => {
							blurAfterPointerClick(e);
							void ask();
						}}
						disabled={busy || (input.trim().length === 0 && !tutorDictating)}
						className="flex size-(--lh-tutor-row) shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
						aria-label="Ask"
						title="Ask (Enter)"
					>
						<ArrowUpIcon className="size-4.5" />
					</button>
				)}
			</div>
		</div>
		{/* The resize zones (owner's ask): the left, right and bottom sides and
		    the two bottom corners. They sit over the window's edges, outside
		    its clipped box. */}
		{!phone &&
			TUTOR_RESIZE_EDGES.map((edge) => (
				<div
					key={edge}
					data-testid={`side-tutor-resize-${edge}`}
					aria-hidden="true"
					onPointerDown={onResizeStart(edge)}
					onPointerMove={onResizeMove}
					onPointerUp={onResizeEnd}
					onPointerCancel={onResizeEnd}
					style={{ WebkitAppRegion: "no-drag", ...(CORNER_SHAPE[edge] ? { clipPath: CORNER_SHAPE[edge] } : {}) } as React.CSSProperties}
					className={cn("absolute touch-none", RESIZE_ZONES[edge])}
				/>
			))}
		</div>
		</>
	);
}

function Exchange({
	question,
	answer,
	status,
	error,
}: {
	question: string;
	answer: string;
	status: SideTutorEntry["status"] | "streaming";
	error?: string;
}) {
	return (
		<div className="space-y-1.5">
			<div className="lh-prose ml-6 rounded-lg bg-muted px-2.5 py-1.5 whitespace-pre-wrap text-foreground">{question}</div>
			<div className={cn("min-w-0", status === "error" && "text-muted-foreground")}>
				{answer ? (
					<MessageResponse isAnimating={status === "streaming"} className="text-sm">
						{answer}
					</MessageResponse>
				) : status === "streaming" ? (
					<BrailleSpinner className="h-3.5" label="Thinking" />
				) : null}
				{status === "aborted" && <div className="mt-1 text-[11px] text-muted-foreground">Stopped.</div>}
				{status === "error" && (
					<div className="mt-1 text-[11px] text-destructive">{error ?? "The side tutor could not answer."}</div>
				)}
			</div>
		</div>
	);
}
