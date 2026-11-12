"use client";

/**
 * THE TUTOR WINDOW — a small, persistent panel that floats over a session
 * (teaching and practice). Its top bar moves it; its left, right and bottom
 * sides and its two bottom corners resize it (side-tutor-window.ts).
 *
 * Since upstream 0.6.0 the window has no engine of its own. What is asked
 * here are upstream's SIDE CONVERSATIONS (components/use-side-thread.ts,
 * src/server/side-chat.ts): stored in the chat record, one per lesson step,
 * delivered to the main teacher with its next turn, and counted in the
 * session's cost. The fork keeps the window, the bubble and the phone sheet,
 * and shows every step's conversation in ONE scroll, in lesson order, each
 * under its step's first words (owner's design). Upstream's own card, its
 * pinned column, the "?" markers and Ctrl+J are not shown.
 *
 * Upstream's hook holds ONE open conversation at a time. This window keeps it
 * on the step being asked about: the step the lesson is on, or the step of a
 * highlighted passage until that question is sent and answered.
 *
 * Keyboard isolation: every keydown inside the panel stops propagating, so
 * the session's document-level handlers (question-dock arrows/Tab, the
 * Enter-opens-check listener, the Esc abort chain) never fire from here.
 * Esc inside the panel minimizes it instead.
 */

import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpIcon, GripHorizontalIcon, MessageCircleQuestionIcon, MinusIcon, SquareIcon, XIcon } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { BrailleSpinner } from "@/components/braille-spinner";
import { blurAfterPointerClick } from "@/components/focus-hygiene";
import { cn } from "@/lib/utils";
import { isPhoneNow, useIsPhone } from "@/components/phone/use-phone";
import { useDockAnchor } from "@/components/phone/use-dock-anchor";
import { plainEnterSends } from "@/components/phone/enter-key";
import { joinDictation, type Dictation } from "@/components/dictation";
import { SIDE_TUTOR_DICTATION_ID, SideTutorDictate, tutorOwnsDictation } from "@/components/side-tutor-dictation";
import { resizeTutorRect, storedTutorSize, TUTOR_EDGE, TUTOR_RESIZE_EDGES, type TutorRect, type TutorResizeEdge, type TutorSize } from "@/components/side-tutor-window";
import { CitationActionsContext } from "@/components/citation-chip";
import { useServerResync } from "@/components/server-events";
import type { useSideThread } from "@/components/use-side-thread";
import {
	collectCitations,
	HELD_TEXT,
	orderTutorThreads,
	SIDE_QUESTION_MAX_CHARS,
	tutorStepLabel,
	type LhMessage,
	type SideChatMessage,
	type SideChatThread,
	type TutorCitation,
} from "@/src/core";

/** Upstream's side-conversation hook, as the lesson screen holds it. */
export type TutorSide = ReturnType<typeof useSideThread>;

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
 * where the conversation is, is darker than the bars and more see-through, so
 * the lesson behind it shows through, blurred.
 *
 * On a dark theme the middle is black at 60% (the owner's pick from five
 * shades). On a light theme black would hide the dark text, so the middle is
 * the theme's own background, see-through, with a little of its text colour
 * mixed in: darker than the bars, as on a dark theme.
 */
const BAR_BG = "bg-background/95";
const BODY_BG = "bg-[color-mix(in_srgb,var(--foreground)_10%,color-mix(in_srgb,var(--background)_62%,transparent))] dark:bg-black/60";

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

export function SideTutor({ chatId, messages, side, dictation, held = false, openRequest = 0 }: {
	chatId: string;
	/** The lesson's native record messages: the order of the steps, and each step's first words. */
	messages: readonly LhMessage[];
	/** Upstream's side conversations for this session (the lesson screen's one useSideThread). */
	side: TutorSide;
	/** The page's shared recorder (useDictation's own result, not the lesson's
	 *  main-input view), for the tutor's Dictate button. */
	dictation?: Dictation;
	/** Cloud sync (Phase 6): another device holds this session. The tutor can't
	 *  be asked until it is taken over: its window closes to a greyed bubble. */
	held?: boolean;
	/** Counts up each time the lesson's highlight toolbar asks about a passage:
	 *  the window opens with that passage waiting above the typing box. */
	openRequest?: number;
}) {
	const [mounted, setMounted] = useState(false);
	const [openWanted, setOpen] = useState(true);
	const open = openWanted && !held;
	const [pos, setPos] = useState<Pos>({ left: 0, top: DEFAULT_TOP });
	/** The size it was resized to; null until then (the frame's own size). */
	const [size, setSize] = useState<TutorSize | null>(null);
	const [input, setInputState] = useState("");
	/** The typing box's text, readable at once: a send that first ends a
	 *  dictation run must see the words that run just delivered. */
	const inputTextRef = useRef("");
	const setInput = useCallback((next: string) => {
		inputTextRef.current = next;
		setInputState(next);
	}, []);
	/** Spoken words join what is already typed (the lesson's separator rule). */
	const appendDictated = useCallback((text: string) => setInput(joinDictation(inputTextRef.current, text).slice(0, SIDE_QUESTION_MAX_CHARS)), [setInput]);
	const tutorDictating = tutorOwnsDictation(dictation);

	const panelRef = useRef<HTMLDivElement>(null);
	const resizeRef = useRef<{ edge: TutorResizeEdge; x: number; y: number; start: TutorRect } | null>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const dragRef = useRef<{ x: number; y: number; start: Pos } | null>(null);
	/** Last known panel width, for keeping the dragged window on screen. */
	const widthRef = useRef(DEFAULT_WIDTH);
	// PHONE (cloud sync Phase 3): a bubble above the message box that opens a
	// bottom sheet. It always starts closed there, can't be dragged or
	// resized, and never touches the desktop's saved open state or position.
	const phone = useIsPhone();
	// Minimized, the tutor is the same round bubble on a computer (owner's
	// ask): at the lesson's bottom right, just above the question, wherever
	// the open window was dragged to.
	const anchor = useDockAnchor(true);
	const citationActions = useContext(CitationActionsContext);

	// Client-only preferences (no SSR mismatch).
	useEffect(() => {
		setOpen(isPhoneNow() ? false : readStored(OPEN_KEY, true));
		const stored = storedTutorSize(readStored<unknown>(SIZE_KEY, null));
		setSize(stored);
		setPos(clampPos(readStored(POS_KEY, defaultPos()), Math.min(stored?.width ?? DEFAULT_WIDTH, window.innerWidth - 2 * EDGE)));
		setMounted(true);
	}, []);

	// ── the conversations (upstream's side conversations) ─────────────────
	const state = side.state;
	const currentStep = side.currentSegmentId;
	const answering = state?.answering === true;
	const passage = state?.pendingPassage;
	const openSide = side.open;
	const closeSide = side.close;
	const askSide = side.ask;

	/** A question sent from here that the conversation doesn't show yet. */
	const [sending, setSending] = useState<{ threadId: string; question: string; passage?: string; shown: number } | null>(null);
	/** Conversations whose answer is being written while the hook's one open
	 *  conversation is elsewhere (the lesson moved on, a passage of another
	 *  step was highlighted, the page was reloaded): they show a spinner until
	 *  the answer lands. */
	const [elsewhere, setElsewhere] = useState<ReadonlySet<string>>(new Set());
	/** A Retry on a conversation that isn't the open one: open it, then ask again. */
	const [retry, setRetry] = useState<{ threadId: string; segmentId: string } | null>(null);
	/** Whether the open conversation's answer stream is connected. Upstream's
	 *  open() connects only to a conversation it already knows. */
	const attachRef = useRef<{ threadId: string; attached: boolean } | null>(null);
	const lastStateRef = useRef<{ threadId: string; answering: boolean } | null>(null);

	// Which answers were already being written when this page loaded.
	const seedElsewhere = useCallback(async () => {
		try {
			const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/side-chats`, { cache: "no-store" });
			if (!res.ok) return;
			const listed = (await res.json()) as { answering?: Record<string, string> };
			setElsewhere(new Set(Object.keys(listed.answering ?? {})));
		} catch {
			// offline / server restarting: a later change brings the answers in
		}
	}, [chatId]);
	useEffect(() => {
		void seedElsewhere();
	}, [seedElsewhere]);
	useServerResync(() => void seedElsewhere());

	// Keep upstream's one open conversation on the step being asked about.
	useEffect(() => {
		if (held || retry || !currentStep) return;
		if (state && (state.answering || state.pendingPassage)) return;
		if (state?.segmentId === currentStep) return;
		openSide({ sourceMessageId: currentStep, anchor: { kind: "composer" } });
	}, [held, retry, currentStep, state, openSide]);

	// The answer stream of the open conversation, and the ones left behind.
	useEffect(() => {
		const last = lastStateRef.current;
		lastStateRef.current = state ? { threadId: state.threadId, answering: state.answering } : null;
		// Left while its answer was still being written: it finishes on the server.
		if (last?.answering && last.threadId !== state?.threadId) setElsewhere((set) => new Set(set).add(last.threadId));
		if (!state) {
			attachRef.current = null;
			return;
		}
		const known = side.threads.some((thread) => thread.id === state.threadId);
		if (attachRef.current?.threadId !== state.threadId) {
			// open() has just connected, if it knew the conversation.
			attachRef.current = { threadId: state.threadId, attached: known };
			return;
		}
		if (!attachRef.current.attached && known) {
			// Opened before the list had loaded: open it again, which connects.
			attachRef.current.attached = true;
			openSide({ sourceMessageId: state.segmentId, anchor: state.anchor });
		}
	}, [state, side.threads, openSide]);

	// An answer written elsewhere has landed once its conversation ends on it.
	useEffect(() => {
		setElsewhere((set) => {
			if (set.size === 0) return set;
			const next = new Set([...set].filter((id) => {
				if (id === state?.threadId) return false; // the open one is followed live
				const thread = side.threads.find((entry) => entry.id === id);
				return thread !== undefined && thread.messages.at(-1)?.role === "user";
			}));
			return next.size === set.size ? set : next;
		});
	}, [side.threads, state?.threadId]);

	// The question just sent shows at once; drop the stand-in once the
	// conversation has it, or the send was refused.
	useEffect(() => {
		if (!sending) return;
		if (!state || state.threadId !== sending.threadId || state.messages.length > sending.shown || (!state.answering && state.error !== undefined)) setSending(null);
	}, [sending, state]);

	// Retry on a conversation that wasn't the open one.
	useEffect(() => {
		if (!retry) return;
		if (held || state?.answering) {
			setRetry(null);
			return;
		}
		if (state?.threadId !== retry.threadId) {
			openSide({ sourceMessageId: retry.segmentId, anchor: { kind: "composer" } });
			return;
		}
		setRetry(null);
		attachRef.current = { threadId: retry.threadId, attached: true };
		void askSide("", true, retry.threadId);
	}, [retry, held, state, openSide, askSide]);

	// A failed send gives the question back (upstream returns it).
	const failedQuestion = state?.failedQuestion;
	useEffect(() => {
		if (failedQuestion && !inputTextRef.current.trim()) setInput(failedQuestion);
	}, [failedQuestion, setInput]);

	/** What the window shows: every conversation that has something in it, in
	 *  lesson order. The open one is read from the hook's live state. */
	const sections = useMemo(() => {
		const list: Array<{ id: string; segmentId: string; anchor: SideChatThread["anchor"]; createdAt: string; messages: SideChatMessage[] }> = side.threads.map((thread) => ({
			id: thread.id,
			segmentId: thread.anchor.messageId,
			anchor: thread.anchor,
			createdAt: thread.createdAt,
			messages: state?.threadId === thread.id ? state.messages : thread.messages,
		}));
		// A first question at a step: upstream's list doesn't have its conversation yet.
		if (state && !list.some((entry) => entry.id === state.threadId)) {
			list.push({ id: state.threadId, segmentId: state.segmentId, anchor: { messageId: state.segmentId, partId: "", blockIndex: 0, blockText: "" }, createdAt: "", messages: state.messages });
		}
		return orderTutorThreads(messages, list)
			.filter((entry) => entry.messages.length > 0 || sending?.threadId === entry.id || (state?.threadId === entry.id && state.answering))
			.map((entry) => ({ ...entry, label: tutorStepLabel(messages, entry.segmentId) }));
	}, [side.threads, state, messages, sending]);

	const busy = answering || elsewhere.size > 0 || sending !== null;

	// Keep the conversation being written in view: its end, wherever in the
	// scroll its step is. With nothing open, the newest (the bottom).
	const activeEndRef = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const end = activeEndRef.current;
		if (!end) {
			el.scrollTop = el.scrollHeight;
			return;
		}
		const bottom = end.offsetTop + end.offsetHeight;
		if (bottom > el.scrollTop + el.clientHeight || end.offsetTop < el.scrollTop) el.scrollTop = Math.max(0, bottom - el.clientHeight + 12);
	}, [state?.threadId, state?.messages, state?.streamText, sending, open]);

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

	// "Ask" on a highlighted passage (the lesson's toolbar) opens the window.
	const openRequestSeen = useRef(openRequest);
	useEffect(() => {
		if (openRequest === openRequestSeen.current) return;
		openRequestSeen.current = openRequest;
		if (held) return;
		setOpen(true);
		if (isPhoneNow()) return;
		writeStored(OPEN_KEY, true);
		window.setTimeout(() => inputRef.current?.focus(), 0);
	}, [openRequest, held]);

	const ask = async () => {
		// Still dictating to the tutor: end the run first, so the last words
		// are in the box before it is read (the lesson's "nothing gets lost").
		if (tutorDictating && dictation) await dictation.finishFor(SIDE_TUTOR_DICTATION_ID);
		const question = inputTextRef.current.trim();
		const target = side.state;
		if (!question || busy || !target) return;
		attachRef.current = { threadId: target.threadId, attached: true }; // the send's own stream
		setSending({ threadId: target.threadId, question, passage: target.pendingPassage?.text, shown: target.messages.length });
		setInput("");
		// Refused (the reason shows in the window): the question comes back.
		if (await askSide(question, false, target.threadId)) return;
		setSending(null);
		if (!inputTextRef.current.trim()) setInput(question);
	};

	const stop = () => side.stop();

	/** Drop the passage waiting above the typing box. Upstream's hook lets go
	 *  of one only by closing its conversation; the step it goes back to is
	 *  opened again above. */
	const dropPassage = () => {
		if (state?.answering) setElsewhere((set) => new Set(set).add(state.threadId));
		closeSide();
	};

	/** A quoted passage, clicked: show it in the lesson. On a phone the sheet
	 *  covers the lesson, so it closes first. */
	const showInLesson = (citation: TutorCitation, element: HTMLElement) => {
		if (phone) setOpenPersist(false);
		citationActions?.openSource?.(citation, element);
	};

	// ── dragging by the header ────────────────────────────────────────────
	const onDragStart = (e: React.PointerEvent) => {
		if (phone || (e.target as HTMLElement).closest("button")) return;
		e.preventDefault();
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		dragRef.current = { x: e.clientX, y: e.clientY, start: pos };
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
		resizeRef.current = { edge, x: e.clientX, y: e.clientY, start: { left: pos.left, top: pos.top, width: el.offsetWidth, height: el.offsetHeight } };
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
			style={(phone ? {} : { left: pos.left, top: pos.top, ...(size ? { width: size.width, height: size.height } : {}), WebkitAppRegion: "no-drag" }) as React.CSSProperties}
			className={phone ? "contents" : cn("fixed z-30", WINDOW_SIZE, FRAME_MAX_HEIGHT)}
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
				{sections.length === 0 && (
					// The empty window's one sentence (owner's ask).
					<p className="text-xs leading-relaxed text-muted-foreground">Stuck on a term or a step? Ask here.</p>
				)}
				{sections.map((section) => {
					const active = state?.threadId === section.id;
					const stream = active && state.answering;
					const pendingHere = sending?.threadId === section.id ? sending : null;
					const last = section.messages.at(-1);
					const waiting = !stream && !pendingHere && elsewhere.has(section.id);
					// Upstream's rule for when an answer can be asked for again.
					const canRetry = !stream && !pendingHere && !waiting && !busy && !held && (last?.role === "user" || (last?.role === "assistant" && last.error !== undefined));
					return (
						<section key={section.id} data-testid="side-tutor-step" data-step={section.segmentId} className="space-y-3">
							<StepDivider label={section.label} />
							{section.messages.map((message) =>
								message.role === "user" ? (
									<Question key={message.id} text={message.text} quotes={message.quotes} citations={message.quoteCitations} onShow={citationActions?.openSource ? showInLesson : undefined} />
								) : (
									<Answer key={message.id} text={message.text} stopped={message.stopped === true} error={message.error} />
								),
							)}
							{pendingHere && <Question text={pendingHere.question} quotes={pendingHere.passage ? [pendingHere.passage] : undefined} />}
							{(stream || pendingHere) && <Answer text={stream ? state.streamText : ""} streaming />}
							{waiting && <BrailleSpinner className="h-3.5" label="Answering" />}
							{/* A send that failed before an answer was saved: upstream's reason. */}
							{active && !stream && state.error !== undefined && last?.role === "user" && <div className="text-[0.92em] text-error">{state.error}</div>}
							{canRetry && (
								<button
									type="button"
									data-testid="side-tutor-retry"
									onClick={(e) => {
										blurAfterPointerClick(e);
										setRetry({ threadId: section.id, segmentId: section.segmentId });
									}}
									className="block text-[0.92em] text-muted-foreground underline underline-offset-2 hover:text-foreground"
								>
									Retry
								</button>
							)}
							{active && <div ref={activeEndRef} aria-hidden="true" />}
						</section>
					);
				})}
			</div>
			</div>

			{/* A refusal with nothing saved to show it under (no model set up, say): upstream's reason. */}
			{state?.error !== undefined && !answering && sections.find((section) => section.id === state.threadId)?.messages.at(-1)?.role !== "user" && (
				<div data-testid="side-tutor-notice" className={cn("border-t border-border px-3 py-1.5 text-xs text-error", BAR_BG)}>{state.error}</div>
			)}

			{/* A highlighted passage waiting for its question (the lesson's Ask). */}
			{passage && (
				<div data-testid="side-tutor-passage" className={cn("flex items-center gap-2 border-t border-border px-2 pt-2", BAR_BG)}>
					<Quote text={passage.text} className="min-w-0 flex-1" />
					<button
						type="button"
						onClick={(e) => {
							blurAfterPointerClick(e);
							dropPassage();
						}}
						className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
						aria-label="Remove the passage"
						title="Remove the passage"
					>
						<XIcon className="size-3.5" />
					</button>
				</div>
			)}

			<div className={cn("flex items-end gap-2 p-2", !passage && "border-t border-border", BAR_BG)} style={TYPING_ROW_VARS}>
				<textarea
					ref={inputRef}
					value={input}
					maxLength={SIDE_QUESTION_MAX_CHARS}
					// Nothing to ask about until the teacher has said something.
					disabled={!state && !currentStep}
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
				{answering ? (
					<button
						type="button"
						onClick={(e) => {
							blurAfterPointerClick(e);
							stop();
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
						disabled={busy || !state || (input.trim().length === 0 && !tutorDictating)}
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

/** A step's first words, between two hairlines (owner's design). One line. */
function StepDivider({ label }: { label: string }) {
	return (
		<div data-testid="side-tutor-divider" className="flex items-center gap-2 text-xs leading-snug text-muted-foreground">
			<span aria-hidden="true" className="h-px min-w-4 flex-1 bg-border" />
			{label && <span className="max-w-[75%] truncate">{label}</span>}
			<span aria-hidden="true" className="h-px min-w-4 flex-1 bg-border" />
		</div>
	);
}

/** A passage of the lesson, quoted. */
function Quote({ text, className, onClick }: { text: string; className?: string; onClick?: (element: HTMLElement) => void }) {
	const look = cn("lh-prose line-clamp-3 border-l-2 border-border pl-2 text-left text-[0.92em] italic text-muted-foreground", className);
	if (!onClick) return <div className={look}>{text}</div>;
	return (
		<button type="button" data-testid="side-tutor-quote" title="Show in the lesson" aria-label="Show the quoted tutor text" onClick={(e) => onClick(e.currentTarget)} className={cn(look, "cursor-pointer hover:text-foreground")}>
			{text}
		</button>
	);
}

function Question({ text, quotes, citations, onShow }: {
	text: string;
	quotes?: string[];
	/** Upstream's saved link for each quote: where in the lesson it is from. */
	citations?: string[];
	onShow?: (citation: TutorCitation, element: HTMLElement) => void;
}) {
	return (
		<div className="space-y-1.5">
			{quotes?.map((quote, index) => {
				const citation = collectCitations(citations?.[index] ?? "")[0]?.citation;
				return <Quote key={index} text={quote} className="ml-6 block" onClick={citation && onShow ? (element) => onShow(citation, element) : undefined} />;
			})}
			<div className="lh-prose ml-6 rounded-lg bg-muted px-2.5 py-1.5 whitespace-pre-wrap text-foreground">{text}</div>
		</div>
	);
}

function Answer({ text, streaming = false, stopped = false, error }: { text: string; streaming?: boolean; stopped?: boolean; error?: string }) {
	return (
		<div className={cn("min-w-0", error !== undefined && "text-muted-foreground")}>
			{text ? (
				<MessageResponse isAnimating={streaming} className="text-sm">
					{text}
				</MessageResponse>
			) : streaming ? (
				<BrailleSpinner className="h-3.5" label="Thinking" />
			) : null}
			{stopped && <div className="mt-1 text-[11px] text-muted-foreground">Stopped.</div>}
			{/* A failed answer: upstream's reason, in the theme's error colour. */}
			{error !== undefined && <div className="mt-1 text-[0.92em] text-error">{error}</div>}
		</div>
	);
}
