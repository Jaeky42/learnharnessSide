"use client";
/**
 * SEAMLESS SESSIONS (owner's decision; cloud sync, docs/cloud-sync.md): a
 * session looks and behaves the same whichever device holds it. Nothing is
 * greyed and nothing asks the learner to take it over: the session moves
 * here by itself.
 *
 *   - at the first typed character in one of the lesson's text boxes (the
 *     message box, a question's boxes, a practice answer, a plugin question's
 *     box, the Tutor's typing box), paste included, and at a press on
 *     Dictate: the move starts and nothing waits for it (a "pre-warm");
 *   - at any action that changes the session: the action waits for the move
 *     and goes through once the session is here.
 *
 * The move is `POST /api/cloud {op:"take-over", chatId, force:true}`:
 *   yours | moved | continued-offline   here now
 *   waiting                             asked again every 2 s, with no cap,
 *                                       for as long as the lesson is open
 *   anything else, a refusal, an error  the move failed
 *
 * Nothing is asked where sync isn't in use or the session isn't held
 * elsewhere (the cloud state's `held`, cloud-state.tsx): those calls answer
 * "here" at once, with no request.
 *
 * Every caller of one session shares one move. When it arrives, the cloud
 * state is asked again, and the open lesson (if it registered with
 * `onSessionArrival`) re-reads the record and says whether it now shows
 * turns it had not shown before: "here-changed". A send waiting for the move
 * is then dropped (its text stays in the box) so the learner sees those
 * turns first (session-core.ts).
 *
 * A move an action needed that failed raises a per-session flag
 * (`useMoveFailed`) for the box that says so; a later move that arrives, or
 * `clearMoveFailed`, lowers it. A failed pre-warm alone raises nothing.
 *
 * The safety net: the page's `held` can be stale. A write refused with 409
 * and `code: "session_held_elsewhere"` asks the cloud state again, moves the
 * session (whatever `held` says) and is tried once more
 * (`moveAfterRefusal`, `fetchHere`, and SessionModel's gate).
 */

import { useEffect, useSyncExternalStore } from "react";
import { SESSION_MOVE_FAILED_TEXT } from "@/src/core";

export type MoveResult = "here" | "here-changed" | "failed";

/** What the cloud state gives this module (CloudProvider connects it). */
export interface CloudSource {
	/** True when sync is in use and another device holds this session. */
	held: (chatId: string) => boolean;
	/** The cloud state as it is now; a new object whenever it changes. */
	snapshot: () => unknown;
	/** Ask the server again. */
	refresh: () => void;
}

/** The answers that mean the session is here now. */
const HERE_STATUSES = new Set(["yours", "moved", "continued-offline"]);
export const MOVE_ASK_AGAIN_MS = 2000;
/** The code of the server's refusal of a write to a session held elsewhere. */
export const HELD_ELSEWHERE_CODE = "session_held_elsewhere";

let source: CloudSource | null = null;
/** The cloud state's snapshot when a move arrived: until it changes, the
 *  session counts as here whatever that (older) snapshot says. */
const arrivedAt = new Map<string, unknown>();
interface Move { promise: Promise<MoveResult | "abandoned">; abandon: () => void }
const moves = new Map<string, Move>();
const arrivalHandlers = new Map<string, () => Promise<boolean>>();

const failed = new Set<string>();
const moving = new Set<string>();
const listeners = new Set<() => void>();
const notify = () => { for (const listener of [...listeners]) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** CloudProvider connects its state; the returned function disconnects it. */
export function connectCloudSource(next: CloudSource): () => void {
	source = next;
	return () => { if (source === next) source = null; };
}

/** Does an action on this session have to move it here first? */
export function sessionNeedsMove(chatId: string): boolean {
	if (!source || !source.held(chatId)) return false;
	if (arrivedAt.has(chatId)) {
		if (arrivedAt.get(chatId) === source.snapshot()) return false;
		arrivedAt.delete(chatId);
	}
	return true;
}

/** The open lesson re-reads the record when its session arrives, and says
 *  whether it now shows turns it had not shown. */
export function onSessionArrival(chatId: string, handler: () => Promise<boolean>): () => void {
	arrivalHandlers.set(chatId, handler);
	return () => { if (arrivalHandlers.get(chatId) === handler) arrivalHandlers.delete(chatId); };
}

async function askToMove(chatId: string): Promise<Record<string, unknown> | null> {
	try {
		const response = await fetch("/api/cloud", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "take-over", chatId, force: true }) });
		if (!response.ok) return null;
		return (await response.json()) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function startMove(chatId: string): Move {
	const existing = moves.get(chatId);
	if (existing) return existing;
	let abandoned = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let wake: (() => void) | null = null;
	const abandon = () => {
		abandoned = true;
		if (timer) clearTimeout(timer);
		wake?.();
	};
	const run = async (): Promise<MoveResult | "abandoned"> => {
		for (;;) {
			const answer = await askToMove(chatId);
			if (abandoned) return "abandoned";
			const status = answer?.status;
			if (typeof status === "string" && HERE_STATUSES.has(status)) break;
			if (status !== "waiting") return "failed";
			await new Promise<void>((resolve) => { wake = resolve; timer = setTimeout(resolve, MOVE_ASK_AGAIN_MS); });
			wake = null; timer = null;
			if (abandoned) return "abandoned";
		}
		arrivedAt.set(chatId, source?.snapshot());
		source?.refresh();
		const handler = arrivalHandlers.get(chatId);
		let changed = false;
		if (handler) {
			try { changed = await handler(); } catch { changed = true; }
		}
		return changed ? "here-changed" : "here";
	};
	const move: Move = {
		abandon,
		promise: run().then((result) => {
			if (result === "here" || result === "here-changed") failed.delete(chatId);
			return result;
		}).finally(() => {
			if (moves.get(chatId) === move) moves.delete(chatId);
			moving.delete(chatId);
			notify();
		}),
	};
	moves.set(chatId, move);
	moving.add(chatId);
	notify();
	return move;
}

async function settle(chatId: string, move: Move, raise: boolean): Promise<MoveResult> {
	const result = await move.promise;
	if (result === "abandoned") return "failed";
	if (result === "failed" && raise && !failed.has(chatId)) { failed.add(chatId); notify(); }
	return result;
}

/**
 * Make sure this session is here before an action that changes it. Answers
 * "here" at once, with no request, where nothing has to move. A failure
 * raises the session's "move failed" flag. Usable outside React and for a
 * session that isn't open (the session list's Rename and Delete).
 */
export function ensureSessionHere(chatId: string): Promise<MoveResult> {
	const move = moves.get(chatId) ?? (sessionNeedsMove(chatId) ? startMove(chatId) : null);
	if (!move) return Promise.resolve("here");
	return settle(chatId, move, true);
}

/** Start the move without waiting for it (typing, Dictate, Cite, Ask, a
 *  plugin button). A failure here raises nothing. */
export function prewarmSessionMove(chatId: string): void {
	if (moves.has(chatId) || !sessionNeedsMove(chatId)) return;
	void startMove(chatId).promise;
}

/** The safety net: a write was refused because another device holds the
 *  session, whatever the page believed. Ask the cloud state again and move it. */
export function moveAfterRefusal(chatId: string): Promise<MoveResult> {
	arrivedAt.delete(chatId);
	source?.refresh();
	return settle(chatId, startMove(chatId), true);
}

/** Stop asking for this session (the lesson closed). A send waiting for it
 *  is dropped quietly; the flag isn't raised. */
export function abandonSessionMove(chatId: string): void {
	moves.get(chatId)?.abandon();
}

/** Is this answer the server's refusal of a write to a session held elsewhere?
 *  Reads a copy of the body, so the answer can still be read. */
export async function isHeldRefusal(response: Response): Promise<boolean> {
	if (response.status !== 409) return false;
	try {
		const body = (await response.clone().json()) as { code?: unknown } | null;
		return body?.code === HELD_ELSEWHERE_CODE;
	} catch {
		return false;
	}
}

/** What a write gets when the session couldn't be moved here before it. Its
 *  `error` is the approved sentence, which the delete dialog and the Tutor show. */
function moveFailedResponse(): Response {
	return new Response(JSON.stringify({ code: HELD_ELSEWHERE_CODE, error: SESSION_MOVE_FAILED_TEXT }), { status: 409, headers: { "content-type": "application/json" } });
}

/**
 * A write to a session that goes through once the session is here, with the
 * safety net: for the writes that simply go through after arrival (Rename,
 * Delete, the model and thinking, the artifact switch, manual extraction,
 * the Tutor's Ask). Where nothing has to move this is a plain fetch.
 */
export async function fetchHere(chatId: string, input: string, init?: RequestInit): Promise<Response> {
	if (moves.has(chatId) || sessionNeedsMove(chatId)) {
		if ((await ensureSessionHere(chatId)) === "failed") return moveFailedResponse();
	}
	const response = await fetch(input, init);
	if (!(await isHeldRefusal(response))) return response;
	if ((await moveAfterRefusal(chatId)) === "failed") return response;
	return fetch(input, init);
}

/** SessionModel's gate (session-core.ts), for the session hook. */
export function sessionMoveGate(chatId: string) {
	return {
		needed: () => moves.has(chatId) || sessionNeedsMove(chatId),
		ensure: () => ensureSessionHere(chatId),
		recover: () => moveAfterRefusal(chatId),
	};
}

/** True while an action on this session couldn't go through because the
 *  session couldn't be moved here. */
export function isMoveFailed(chatId: string): boolean {
	return failed.has(chatId);
}

export function clearMoveFailed(chatId: string): void {
	if (failed.delete(chatId)) notify();
}

export function useMoveFailed(chatId: string): boolean {
	const snapshot = () => failed.has(chatId);
	return useSyncExternalStore(subscribe, snapshot, () => false);
}

/** True while this session is being moved here. */
export function useSessionMoving(chatId: string): boolean {
	const snapshot = () => moving.has(chatId);
	return useSyncExternalStore(subscribe, snapshot, () => false);
}

/** The window event the dictation shortcut raises (components/keyboard-shortcuts.tsx, dictation.tsx). */
const DICTATION_SHORTCUT_EVENT = "lh:kbd-toggle-dictation";

/** The lesson's text boxes and Dictate buttons: the blocks they live in. */
export const MOVE_TYPING_SCOPE = '[data-phone="dock"], [data-phone="tutor-typing"]';
/** A press that starts the move: the lesson's and the Tutor's Dictate, and a
 *  question's answer options ("I don't know" too), which the dock marks as
 *  keyboard rows. */
export const MOVE_PRESS = '[data-testid="dictation-toggle"], [data-lh-move-press], [data-phone="dock"] [data-kbdrow]';

function isTextBox(el: Element): boolean {
	const tag = el.tagName;
	if (tag === "TEXTAREA") return true;
	if (tag === "INPUT") {
		const type = ((el as HTMLInputElement).type || "text").toLowerCase();
		// The confidence bar (a range) counts: moving it is answering.
		return type === "text" || type === "search" || type === "url" || type === "email" || type === "number" || type === "tel" || type === "range";
	}
	return (el as HTMLElement).isContentEditable === true || el.closest?.("[contenteditable]:not([contenteditable='false'])") !== null;
}

/** Is this event the learner typing (or pasting) into one of the lesson's text
 *  boxes, or moving the confidence bar? */
export function isLessonTyping(target: EventTarget | null): boolean {
	const el = target as Element | null;
	if (!el || typeof el.closest !== "function") return false;
	return isTextBox(el) && el.closest(MOVE_TYPING_SCOPE) !== null;
}

/** Is this a press on Dictate (the lesson's or the Tutor's)? */
export function isMovePress(target: EventTarget | null): boolean {
	const el = target as Element | null;
	if (!el || typeof el.closest !== "function") return false;
	return el.closest(MOVE_PRESS) !== null;
}

/** Install the pre-warm triggers for one session: document listeners in the
 *  capture phase; they stop and prevent nothing. Focus alone starts nothing. */
export function installMoveTriggers(chatId: string, doc: Document = document): () => void {
	const onType = (event: Event) => { if (isLessonTyping(event.target)) prewarmSessionMove(chatId); };
	const onPress = (event: Event) => { if (isMovePress(event.target)) prewarmSessionMove(chatId); };
	doc.addEventListener("input", onType, true);
	doc.addEventListener("paste", onType, true);
	doc.addEventListener("click", onPress, true);
	// FORK (seamless sessions): dictation started by its keyboard shortcut
	// (src/core/keyboard.ts, handled in dictation.tsx) is a press on Dictate too.
	const onShortcut = () => prewarmSessionMove(chatId);
	doc.defaultView?.addEventListener(DICTATION_SHORTCUT_EVENT, onShortcut);
	return () => {
		doc.defaultView?.removeEventListener(DICTATION_SHORTCUT_EVENT, onShortcut);
		doc.removeEventListener("input", onType, true);
		doc.removeEventListener("paste", onType, true);
		doc.removeEventListener("click", onPress, true);
	};
}

/** The lesson's triggers, and the move abandoned when the lesson closes. */
export function useSessionMoveTriggers(chatId: string): void {
	useEffect(() => {
		const uninstall = installMoveTriggers(chatId);
		return () => { uninstall(); abandonSessionMove(chatId); };
	}, [chatId]);
}

/** Tests only: forget everything. */
export function resetSessionMoveForTests(): void {
	for (const move of moves.values()) move.abandon();
	moves.clear();
	arrivedAt.clear();
	arrivalHandlers.clear();
	failed.clear();
	moving.clear();
	source = null;
	notify();
}
