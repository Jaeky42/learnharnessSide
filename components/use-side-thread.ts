"use client";

/** #451's single floating/docked companion, backed by #487's durable service.
 * Closing detaches a view; messages are already saved, and returning can
 * subscribe to a still-running answer. No close-time commits or tutor notes. */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { serializeCitation, sideSegmentId, type LhMessage, type TextSelector, type SideChatMessage, type SideChatThread } from "@/src/core";
import { useServerEvent, useServerResync } from "./server-events";

export type SideThreadAnchor = { kind: "range"; range: Range } | { kind: "element"; element: HTMLElement } | { kind: "composer" };
export interface SidePassage { text: string; sourceMessageId: string; selector?: Omit<TextSelector, "text"> }
export interface SideThreadOpenArgs {
	anchor: SideThreadAnchor;
	passage?: SidePassage;
	sourceMessageId?: string;
	questionCallId?: string;
}
export interface SideThreadState {
	threadId: string;
	segmentId: string;
	messages: SideChatMessage[];
	answering: boolean;
	streamText: string;
	pendingPassage?: SidePassage;
	mode: "popover" | "panel";
	anchor: SideThreadAnchor;
	error?: string;
	failedQuestion?: string;
}
export type SideThreadAction =
	| { type: "open"; segmentId: string; anchor: SideThreadAnchor; passage?: SidePassage; thread?: SideChatThread }
	| { type: "snapshot"; thread: SideChatThread; answering?: boolean; text?: string }
	| { type: "start"; threadId: string }
	| { type: "accepted"; threadId: string }
	| { type: "text"; threadId: string; text: string }
	| { type: "error"; threadId: string; error: string; question?: string }
	| { type: "done"; thread: SideChatThread }
	| { type: "mode"; mode: "popover" | "panel" }
	| { type: "close" };
export function sideThreadReducer(state: SideThreadState | null, action: SideThreadAction): SideThreadState | null {
	if (action.type === "close") return null;
	if (action.type === "open") {
		const threadId = action.thread?.id ?? `side_${action.segmentId}`;
		if (state?.threadId === threadId) return { ...state, ...(action.passage ? { pendingPassage: action.passage } : {}) };
		return { threadId, segmentId: action.segmentId, messages: action.thread?.messages ?? [], answering: false, streamText: "",
			mode: state?.mode ?? "popover", anchor: action.anchor, pendingPassage: action.passage };
	}
	if (!state) return state;
	if (action.type === "mode") return { ...state, mode: action.mode };
	const threadId = "thread" in action ? action.thread.id : action.threadId;
	if (threadId !== state.threadId) return state;
	if (action.type === "snapshot" || action.type === "done") {
		const next = {
			...state, messages: action.thread.messages,
			...(action.type === "done" || (action.type === "snapshot" && action.answering === false && action.thread.messages.at(-1)?.role === "assistant") ? { error: undefined } : {}),
			...(action.type === "done" ? { answering: false, streamText: "" } : {
				...(action.answering !== undefined ? { answering: action.answering } : {}),
				...(action.text !== undefined ? { streamText: action.text } : {}),
			}),
		};
		// Fork (performance): a snapshot that changes nothing keeps the state.
		return action.type === "snapshot" && sameState(state, next) ? state : next;
	}
	if (action.type === "start") return { ...state, answering: true, streamText: "", error: undefined, failedQuestion: undefined };
	if (action.type === "accepted") return { ...state, pendingPassage: undefined };
	if (action.type === "text") return { ...state, answering: true, streamText: action.text };
	return { ...state, answering: false, error: action.error, failedQuestion: action.question };
}

/** Fork (performance): the same fields with the same values (identity for objects). */
function sameState(a: SideThreadState, b: SideThreadState): boolean {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof SideThreadState>;
	for (const key of keys) if (!Object.is(a[key], b[key]) || Object.hasOwn(a, key) !== Object.hasOwn(b, key)) return false;
	return true;
}

export function useSideThread(chatId: string, messages: readonly LhMessage[], getWorking?: () => string) {
	const [state, dispatchToReact] = useReducer(sideThreadReducer, null);
	// Fork (performance): the reducer's state with every action applied, also
	// those React hasn't rendered yet, so a refresh can tell that its snapshot
	// would change nothing and not dispatch it (a dispatch always re-rendered
	// the lesson, even when the reducer kept the state).
	const reduced = useRef<SideThreadState | null>(null);
	const dispatch = useCallback((action: SideThreadAction) => {
		reduced.current = sideThreadReducer(reduced.current, action);
		dispatchToReact(action);
	}, []);
	// Fork (performance): the last list read, so an equal one sets no state.
	const lastRead = useRef<{ chatId: string; text: string; revision: number; payload: { threads: SideChatThread[]; answering: Record<string, string> } } | null>(null);
	const [threads, setThreads] = useState<SideChatThread[]>([]);
	const stateRef = useRef(state); stateRef.current = state;
	const messagesRef = useRef(messages); messagesRef.current = messages;
	const threadsRef = useRef(threads); threadsRef.current = threads;
	const workingRef = useRef(getWorking); workingRef.current = getWorking;
	const connection = useRef<{ controller: AbortController; token: number } | null>(null);
	const serial = useRef(0);
	const revision = useRef(0);
	const refreshSerial = useRef(0);
	const uncertain = useRef<{ segmentId: string; text: string; quote?: string; requestId: string } | null>(null);
	const drafts = useRef(new Map<string, string>());
	const [, syncExternalDraft] = useState(0);
	const draftFor = useCallback((threadId: string) => drafts.current.get(threadId) ?? "", []);
	const saveDraft = useCallback((threadId: string, text: string, notify = false) => {
		drafts.current.set(threadId, text);
		if (notify) syncExternalDraft((revision) => revision + 1);
	}, []);
	const adopt = useCallback((thread: SideChatThread) => {
		revision.current++;
		setThreads((current) => current.some((entry) => entry.id === thread.id)
			? current.map((entry) => entry.id === thread.id ? thread : entry) : [...current, thread]);
	}, []);
	const refresh = useCallback(async () => {
		const request = ++refreshSerial.current;
		const before = revision.current;
		try {
			const response = await fetch(`/api/chats/${chatId}/side-chats`, { cache: "no-store" });
			if (!response.ok) return;
			const text = await response.text();
			if (request !== refreshSerial.current || before !== revision.current) return;
			// Fork (performance): the same text, with nothing adopted since it was
			// set (adopt bumps revision), is the list on screen: keep it, and its
			// objects, so the snapshot below can be seen to change nothing.
			const last = lastRead.current;
			const same = last !== null && last.chatId === chatId && last.text === text && last.revision === revision.current;
			const payload = same ? last.payload : JSON.parse(text) as { threads: SideChatThread[]; answering: Record<string, string> };
			if (!same) { setThreads(payload.threads); lastRead.current = { chatId, text, revision: revision.current, payload }; }
			const current = stateRef.current;
			const thread = current && payload.threads.find((entry) => entry.id === current.threadId);
			if (thread) {
				const action: SideThreadAction = { type: "snapshot", thread,
					answering: Object.hasOwn(payload.answering, thread.id), text: payload.answering[thread.id] ?? "" };
				// The reducer would keep its state: nothing to dispatch.
				if (sideThreadReducer(reduced.current, action) !== reduced.current) dispatch(action);
			}
		} catch { /* a later change/resync retries a detached view's read */ }
	}, [chatId]);
	useEffect(() => { void refresh(); return () => { refreshSerial.current++; connection.current?.controller.abort(); }; }, [refresh]);
	useServerEvent("side-chats-changed", (event) => { if (event.chatId === chatId) void refresh(); });
	useServerEvent("record-changed", (event) => { if (event.chatId === chatId) void refresh(); });
	useServerResync(() => { void refresh(); });

	const consume = useCallback(async (response: Response, threadId: string, token: number) => {
		if (token !== connection.current?.token) { await response.body?.cancel(); return; }
		if (!response.ok) {
			const body = await response.json().catch(() => null) as { error?: string | { message?: string } } | null;
			throw new Error(typeof body?.error === "string" ? body.error : body?.error?.message ?? "The side conversation could not be reached.");
		}
		const reader = response.body?.getReader();
		if (!reader) throw new Error("The side answer had no response stream.");
		const decoder = new TextDecoder(); let buffer = ""; let terminal = false;
		const apply = (line: string) => {
			if (!line.trim() || token !== connection.current?.token) return;
			const event = JSON.parse(line) as { type: string; thread?: SideChatThread; text?: string; error?: string };
			if (event.type === "done" || event.type === "error") terminal = true;
			if (event.thread) {
				adopt(event.thread);
				dispatch({ type: event.type === "done" ? "done" : "snapshot", thread: event.thread });
				uncertain.current = null;
			} else if (event.type === "text") {
				revision.current++; // an older GET must not rewind a newer stream tail
				dispatch({ type: "text", threadId, text: event.text ?? "" });
			}
			else if (event.type === "error") throw new Error(event.error ?? "The side answer failed.");
		};
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) { buffer += decoder.decode(); if (buffer.trim()) apply(buffer); break; }
				buffer += decoder.decode(value, { stream: true });
				let newline: number;
				while ((newline = buffer.indexOf("\n")) >= 0) { apply(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
			}
			if (!terminal && token === connection.current?.token) throw new Error("The side answer disconnected. Reopen the conversation to reconnect.");
		} finally { reader.releaseLock(); }
	}, [adopt]);

	const attach = useCallback((thread: SideChatThread) => {
		connection.current?.controller.abort();
		const controller = new AbortController(); const token = ++serial.current;
		connection.current = { controller, token };
		void fetch(`/api/chats/${chatId}/side-chats/${thread.id}`, { cache: "no-store", signal: controller.signal })
			.then((response) => consume(response, thread.id, token))
			.catch((error) => { if (!controller.signal.aborted && token === connection.current?.token) dispatch({ type: "error", threadId: thread.id, error: String(error.message ?? error) }); });
	}, [chatId, consume]);
	const open = useCallback(({ anchor, passage, sourceMessageId, questionCallId }: SideThreadOpenArgs) => {
		const source = sourceMessageId ?? passage?.sourceMessageId ?? (questionCallId ? messagesRef.current.find((message) => message.role === "assistant" &&
			message.content.some((block) => block.type === "toolCall" && block.id === questionCallId))?.id : undefined);
		const segmentId = sideSegmentId(messagesRef.current, source);
		if (!segmentId) return;
		const thread = threadsRef.current.find((entry) => entry.anchor.messageId === segmentId);
		dispatch({ type: "open", segmentId, anchor, passage, thread });
		if (thread) attach(thread);
		else { connection.current?.controller.abort(); connection.current = null; }
	}, [attach]);
	const close = useCallback((expectedThreadId?: string) => {
		if (expectedThreadId && stateRef.current?.threadId !== expectedThreadId) return;
		connection.current?.controller.abort(); connection.current = null;
		dispatch({ type: "close" });
	}, []);
	const ask = useCallback(async (text: string, retry = false, expectedThreadId?: string): Promise<boolean> => {
		const current = stateRef.current;
		if (!current || (expectedThreadId && expectedThreadId !== current.threadId) || current.answering || (!text.trim() && !retry)) return false;
		const passage = current.pendingPassage;
		const quote = passage ? serializeCitation({ version: 1, chatId, messageId: passage.sourceMessageId, text: passage.text,
			...(passage.selector ?? { start: 0, end: passage.text.length, prefix: "", suffix: "" }) }) : undefined;
		const previous = uncertain.current;
		const requestId = previous?.segmentId === current.segmentId && previous.text === text && previous.quote === quote
			? previous.requestId : `ask_${crypto.randomUUID().replaceAll("-", "")}`;
		uncertain.current = { segmentId: current.segmentId, text, quote, requestId };
		connection.current?.controller.abort();
		const controller = new AbortController(); const token = ++serial.current;
		connection.current = { controller, token };
		revision.current++;
		dispatch({ type: "start", threadId: current.threadId });
		try {
			const existing = threadsRef.current.some((thread) => thread.id === current.threadId);
			const working = current.segmentId === sideSegmentId(messagesRef.current) ? workingRef.current?.() : undefined;
			const response = await fetch(`/api/chats/${chatId}/side-chats`, {
				method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
				body: JSON.stringify({ ...(existing ? { threadId: current.threadId } : { anchor: {
					messageId: current.segmentId, partId: `${current.segmentId}-t0`, blockIndex: 0, blockText: "This teaching segment and its question.",
				} }), text, quotes: passage ? [passage.text] : [], ...(quote ? { quoteCitations: [quote] } : {}), requestId, ...(retry ? { retry: true, threadId: current.threadId } : {}), ...(working ? { working } : {}) }),
			});
			if (!response.ok) { await consume(response, current.threadId, token); return false; }
			// Accepted and durable before streaming: the UI can clear its draft.
			dispatch({ type: "accepted", threadId: current.threadId });
			void consume(response, current.threadId, token).catch((error) => {
				if (!controller.signal.aborted && token === connection.current?.token) {
					dispatch({ type: "error", threadId: current.threadId, error: String(error.message ?? error) }); void refresh();
				}
			});
			return true;
		} catch (error) {
			if (!controller.signal.aborted && token === connection.current?.token) dispatch({ type: "error", threadId: current.threadId, error: String((error as Error).message ?? error), question: text });
			return false;
		}
	}, [chatId, consume, refresh]);
	const stop = useCallback(() => {
		const current = stateRef.current;
		if (current) void fetch(`/api/chats/${chatId}/side-chats/${current.threadId}/stop`, { method: "POST" }).catch(() => {});
	}, [chatId]);
	return { state, threads, open, close, ask, stop, draftFor, saveDraft, currentSegmentId: sideSegmentId(messages),
		expand: () => dispatch({ type: "mode", mode: "panel" }),
		float: () => dispatch({ type: "mode", mode: "popover" }),
		hasHistory: (sourceMessageId: string) => {
			const segmentId = sideSegmentId(messages, sourceMessageId);
			return threads.some((thread) => thread.anchor.messageId === segmentId && thread.messages.length > 0);
		},
	};
}
