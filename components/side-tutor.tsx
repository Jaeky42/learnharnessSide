"use client";

/**
 * THE SIDE-TUTOR WINDOW — a small, persistent, draggable panel that floats
 * over a teaching session. The learner asks quick questions here; a second
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
import {
	SIDE_TUTOR_MAX_QUESTION_CHARS,
	type SideTutorEntry,
	type SideTutorThread,
	type SideTutorWireEvent,
} from "@/src/core";

/** The minimized bubble on a computer: its gap from the lesson's right edge,
 *  and its place under the top bar while an opened question leaves no room
 *  above the dock (the phone's own values are in app/phone.css). */
const BUBBLE_EDGE_GAP = 16;
const BUBBLE_TOP = 72;

const OPEN_KEY = "lh:side-tutor:open";
const POS_KEY = "lh:side-tutor:pos";
/** Default size/anchor: under the 60px top bar, against the right edge. */
const DEFAULT_WIDTH = 352;
const DEFAULT_TOP = 72;
const DEFAULT_RIGHT_GAP = 16;
const EDGE = 8;

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

export function SideTutor({ chatId, dictation }: { chatId: string; /** The page's dictation run, for the tutor's Dictate button. */ dictation?: Dictation }) {
	const [mounted, setMounted] = useState(false);
	const [open, setOpen] = useState(true);
	const [pos, setPos] = useState<Pos>({ left: 0, top: DEFAULT_TOP });
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
		setPos(clampPos(readStored(POS_KEY, defaultPos()), DEFAULT_WIDTH));
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
		return (
			<button
				type="button"
				data-testid="side-tutor-toggle"
				// A round bubble at the lesson's bottom right, just above the dock,
				// or in the top-right corner while an opened question leaves no
				// room there. PHONE: app/phone.css sizes and places it sideways.
				data-phone="tutor-bubble"
				data-place={anchor.place}
				data-phone-place={phone ? anchor.place : undefined}
				onClick={(e) => {
					blurAfterPointerClick(e);
					setOpenPersist(true);
				}}
				onKeyDown={(e) => e.stopPropagation()}
				style={
					(phone
						? anchor.place === "above-dock"
							? { top: anchor.top }
							: {}
						: { right: anchor.right + BUBBLE_EDGE_GAP, top: anchor.place === "above-dock" ? anchor.top : BUBBLE_TOP, WebkitAppRegion: "no-drag" }) as React.CSSProperties
				}
				className="fixed z-30 flex size-13 items-center justify-center rounded-full border border-border bg-card/85 text-muted-foreground shadow-[0_6px_18px_rgb(0_0_0/0.35)] backdrop-blur transition-colors hover:bg-accent hover:text-foreground"
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
	}

	return (
		<>
		{phone && <div data-phone="backdrop" data-phone-layer="sheet" aria-hidden="true" onClick={() => setOpenPersist(false)} />}
		<div
			ref={panelRef}
			data-testid="side-tutor"
			data-phone="tutor-sheet"
			role="complementary"
			aria-label="Side tutor"
			onKeyDown={onPanelKeyDown}
			style={(phone ? {} : { left: pos.left, top: pos.top, WebkitAppRegion: "no-drag" }) as React.CSSProperties}
			className="fixed z-30 flex h-[min(30rem,calc(100dvh-6rem))] min-h-56 w-[22rem] min-w-72 max-w-[calc(100vw-1rem)] resize flex-col overflow-hidden rounded-xl border border-border bg-background/95 shadow-xl backdrop-blur"
		>
			<div
				className="flex cursor-grab touch-none items-center gap-2 border-b border-border px-3 py-2 select-none active:cursor-grabbing"
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

			<div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3 text-sm">
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

			{notice && <div className="border-t border-border px-3 py-1.5 text-xs text-destructive">{notice}</div>}

			<div className="flex items-end gap-2 border-t border-border p-2">
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
					className="lh-prose field-sizing-content max-h-28 min-h-9 flex-1 resize-none rounded-md border border-input bg-transparent px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring"
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
						className="flex size-9 shrink-0 items-center justify-center rounded-md bg-secondary text-secondary-foreground hover:bg-secondary/80"
						aria-label="Stop the answer"
						title="Stop"
					>
						<SquareIcon className="size-3.5" />
					</button>
				) : (
					<button
						type="button"
						onClick={(e) => {
							blurAfterPointerClick(e);
							void ask();
						}}
						disabled={busy || (input.trim().length === 0 && !tutorDictating)}
						className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
						aria-label="Ask"
						title="Ask (Enter)"
					>
						<ArrowUpIcon className="size-4" />
					</button>
				)}
			</div>
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
