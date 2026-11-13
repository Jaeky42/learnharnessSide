"use client";
/**
 * What the page knows about cloud sync (cloud sync Phase 6, docs/cloud-sync.md):
 * which sessions another device holds, this PC's sync state, and the
 * discards the learner hasn't been told about. One provider in the root
 * layout; the session list, the lesson's strip, the sync chip and the
 * discard box all read it.
 *
 * It asks its own server (GET /api/cloud) only where the `lh_cloud` marker
 * says sync is in use (sync-marker.ts). An app that was never paired has no
 * marker, so this provider makes no request and sets no timer there.
 * Where it is in use: once at the start, whenever the app's live channel
 * says a session changed or the sync state changed, and every 10 seconds.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { syncTrouble, syncTroubleDueIn, type SessionHolder, type SyncTrouble } from "@/src/core";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { useSyncInUse } from "./sync-marker";

export interface CloudNotice {
	chatId: string;
	title: string;
	turns: number;
	at: number;
}

export interface CloudSync {
	state: string;
	message: string | null;
	lastContactAt: number | null;
	/** Since when the server hasn't been reached, while it can't be. */
	offlineSince?: number | null;
}

export interface CloudState {
	/** null until the first answer, and for good where sync isn't in use. */
	role: "server" | "desktop" | null;
	held: Record<string, SessionHolder>;
	/** A desktop app's own sync state; null on the server's site. */
	sync: CloudSync | null;
	notices: CloudNotice[];
	/** Ask again now (after a take-over, a dismissed notice). */
	refresh: () => void;
}

const EMPTY: CloudState = { role: null, held: {}, sync: null, notices: [], refresh: () => {} };
const POLL_MS = 10_000;

/**
 * The state lives in a small external store, not in the context value, so a
 * poll that changes only a timestamp doesn't re-render the whole lesson:
 * `useCloud()` re-renders on any change, `useSessionHeld` and
 * `useSessionHolder` only when their own answer changes.
 */
interface CloudStore {
	get: () => CloudState;
	set: (next: Omit<CloudState, "refresh">) => void;
	subscribe: (listener: () => void) => () => void;
}

function createStore(refresh: () => void): CloudStore {
	// Every state the store holds carries the same `refresh`, so it is stable
	// and real from the first render on.
	let state: CloudState = { ...EMPTY, refresh };
	const listeners = new Set<() => void>();
	return {
		get: () => state,
		set: (next) => { state = { ...next, refresh }; for (const l of [...listeners]) l(); },
		subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
	};
}

/** Only read from outside a provider: `set` is never reachable through it. */
const CloudContext = createContext<CloudStore>(createStore(() => {}));


type Answer = { role?: unknown; held?: unknown; sync?: unknown; notices?: unknown };

function read(answer: Answer): Omit<CloudState, "refresh"> | null {
	if (answer.role !== "server" && answer.role !== "desktop") return null;
	const held = answer.held && typeof answer.held === "object" ? answer.held as Record<string, SessionHolder> : {};
	const sync = answer.role === "desktop" && answer.sync && typeof answer.sync === "object" ? answer.sync as CloudSync : null;
	return { role: answer.role, held, sync, notices: Array.isArray(answer.notices) ? answer.notices as CloudNotice[] : [] };
}

export function CloudProvider({ children }: { children: ReactNode }) {
	const inUse = useSyncInUse();
	const refreshRef = useRef<() => void>(() => {});
	const [store] = useState(() => createStore(() => refreshRef.current()));
	const aliveRef = useRef(true);
	const inUseRef = useRef(inUse);
	inUseRef.current = inUse;
	const lastRef = useRef("");

	const refresh = useCallback(() => {
		if (!inUseRef.current || !aliveRef.current) return;
		fetch("/api/cloud", { cache: "no-store" })
			.then((response) => (response.ok ? response.json() : null))
			.then((answer: Answer | null) => {
				const next = answer ? read(answer) : null;
				if (!next || !inUseRef.current || !aliveRef.current) return;
				// The same answer again changes nothing, so nothing re-renders.
				const text = JSON.stringify(next);
				if (text === lastRef.current) return;
				lastRef.current = text;
				store.set(next);
			})
			.catch(() => { /* asked again at the next look */ });
	}, [store]);

	refreshRef.current = refresh;
	useEffect(() => {
		aliveRef.current = true;
		return () => { aliveRef.current = false; };
	}, []);

	useEffect(() => {
		if (!inUse) {
			lastRef.current = "";
			if (store.get().role !== null) store.set({ role: null, held: {}, sync: null, notices: [] });
			return;
		}
		refresh();
		const timer = setInterval(() => { if (document.visibilityState !== "hidden") refresh(); }, POLL_MS);
		return () => clearInterval(timer);
	}, [inUse, refresh, store]);

	// A session moved, arrived or went; the PC's sync state changed.
	useServerEvent("chats-changed", refresh);
	useServerEvent("cloud-changed", refresh);
	useServerResync(refresh);

	return <CloudContext.Provider value={store}>{children}</CloudContext.Provider>;
}

export function useCloud(): CloudState {
	const store = useContext(CloudContext);
	return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** True when another device holds this session. Re-renders only when that flips. */
export function useSessionHeld(chatId: string | null | undefined): boolean {
	const store = useContext(CloudContext);
	const snapshot = useCallback(() => (chatId ? store.get().held[chatId] !== undefined : false), [store, chatId]);
	return useSyncExternalStore(store.subscribe, snapshot, snapshot);
}

/** Who holds this session, when it isn't this copy; null when it can be continued here.
 *  Re-renders only when this session's holder changes in value. */
export function useSessionHolder(chatId: string | null | undefined): SessionHolder | null {
	const store = useContext(CloudContext);
	const last = useRef<{ holder: SessionHolder | null; text: string }>({ holder: null, text: "null" });
	const snapshot = useCallback((): SessionHolder | null => {
		const holder = chatId ? store.get().held[chatId] ?? null : null;
		const text = JSON.stringify(holder);
		if (text !== last.current.text) last.current = { holder, text };
		return last.current.holder;
	}, [store, chatId]);
	return useSyncExternalStore(store.subscribe, snapshot, snapshot);
}

/**
 * What is off with this PC's sync, for the sync chip and the heads-up strip:
 * offline, paused, or removed by the server. Null when all is in step, on
 * the server's site and a phone, and on a PC that was never paired or that
 * the learner unpaired (no marker, so nothing is known here at all).
 * An offline spell shows after 30 seconds, so a short blip shows nothing.
 */
export function useSyncTrouble(): SyncTrouble | null {
	const { role, sync } = useCloud();
	const facts = role === "desktop" ? sync : null;
	const [, again] = useState(0);
	const state = facts?.state;
	const offlineSince = facts?.offlineSince;
	const lastContactAt = facts?.lastContactAt;
	useEffect(() => {
		const due = syncTroubleDueIn(state ? { state, offlineSince, lastContactAt: lastContactAt ?? null } : null, Date.now());
		if (!due || due.inMs === 0) return;
		const timer = setTimeout(() => again((n) => n + 1), due.inMs + 20);
		return () => clearTimeout(timer);
	}, [state, offlineSince, lastContactAt]);
	return syncTrouble(facts, Date.now());
}
