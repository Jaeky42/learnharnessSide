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

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SessionHolder } from "@/src/core";
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
const CloudContext = createContext<CloudState>(EMPTY);
const POLL_MS = 10_000;

type Answer = { role?: unknown; held?: unknown; sync?: unknown; notices?: unknown };

function read(answer: Answer): Omit<CloudState, "refresh"> | null {
	if (answer.role !== "server" && answer.role !== "desktop") return null;
	const held = answer.held && typeof answer.held === "object" ? answer.held as Record<string, SessionHolder> : {};
	const sync = answer.role === "desktop" && answer.sync && typeof answer.sync === "object" ? answer.sync as CloudSync : null;
	return { role: answer.role, held, sync, notices: Array.isArray(answer.notices) ? answer.notices as CloudNotice[] : [] };
}

export function CloudProvider({ children }: { children: ReactNode }) {
	const inUse = useSyncInUse();
	const [state, setState] = useState<Omit<CloudState, "refresh">>(EMPTY);
	const inUseRef = useRef(inUse);
	inUseRef.current = inUse;
	const lastRef = useRef("");

	const refresh = useCallback(() => {
		if (!inUseRef.current) return;
		fetch("/api/cloud", { cache: "no-store" })
			.then((response) => (response.ok ? response.json() : null))
			.then((answer: Answer | null) => {
				const next = answer ? read(answer) : null;
				if (!next || !inUseRef.current) return;
				// The same answer again changes nothing, so nothing re-renders.
				const text = JSON.stringify(next);
				if (text === lastRef.current) return;
				lastRef.current = text;
				setState(next);
			})
			.catch(() => { /* asked again at the next look */ });
	}, []);

	useEffect(() => {
		if (!inUse) {
			lastRef.current = "";
			setState(EMPTY);
			return;
		}
		refresh();
		const timer = setInterval(() => { if (document.visibilityState !== "hidden") refresh(); }, POLL_MS);
		return () => clearInterval(timer);
	}, [inUse, refresh]);

	// A session moved, arrived or went; the PC's sync state changed.
	useServerEvent("chats-changed", refresh);
	useServerEvent("cloud-changed", refresh);
	useServerResync(refresh);

	const value = useMemo(() => ({ ...state, refresh }), [state, refresh]);
	return <CloudContext.Provider value={value}>{children}</CloudContext.Provider>;
}

export function useCloud(): CloudState {
	return useContext(CloudContext);
}

/** Who holds this session, when it isn't this copy; null when it can be continued here. */
export function useSessionHolder(chatId: string | null | undefined): SessionHolder | null {
	const { held } = useCloud();
	return chatId ? held[chatId] ?? null : null;
}
