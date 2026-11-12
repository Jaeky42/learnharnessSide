/**
 * Cloud sync (Phase 5, docs/cloud-sync.md): WHEN a paired desktop syncs
 * (owner's decision):
 *
 *   - a full round when the app starts;
 *   - about 2 seconds after something changes here (a turn settles, a
 *     session is renamed or deleted, a helper finishes, a folder moves,
 *     Flashcards changes its library);
 *   - at once when a reply starts, so the server knows this desktop is busy;
 *   - every 10 seconds otherwise, to ask the server for news;
 *   - while the server can't be reached: quiet retries that slow down,
 *     10 s, 20 s, 40 s … up to once every 5 minutes. A change here doesn't
 *     hurry them.
 *
 * There is no "final sync on quit": on Windows the app's server is killed
 * at once. What wasn't sent goes at the next start.
 *
 * Nothing here exists for an app that isn't paired: no timer is set until
 * the pairing file is there (see autostart.ts and the pair action).
 */

import { subscribe, type ServerEvent } from "../../core/events.ts";
import { activePairing } from "./client.ts";
import { isSyncEcho } from "./flashcards-engine.ts";
import { runSyncRound } from "./round.ts";

export const POLL_MS = 10_000;
export const CHANGE_MS = 2_000;
export const RETRY_MAX_MS = 5 * 60_000;

export type RoundOutcome = "ok" | "offline" | "paused" | "not-paired";

export interface SyncLoopDeps {
	round: () => Promise<RoundOutcome>;
	subscribe: (listener: (event: ServerEvent) => void) => () => void;
	now: () => number;
	setTimer: (run: () => void, ms: number) => unknown;
	clearTimer: (handle: unknown) => void;
}

export interface SyncLoop {
	start(): void;
	stop(): void;
	/** Sync now, whatever the loop was waiting for (after pairing; "Sync now"). */
	now(): void;
	started(): boolean;
}

/** How long to wait after the nth failure in a row. */
export function retryDelayMs(failures: number): number {
	return Math.min(POLL_MS * 2 ** Math.max(0, failures - 1), RETRY_MAX_MS);
}

/** Events that mean "something that syncs changed here". */
const CHANGES = new Set<ServerEvent["type"]>(["turn-settled", "record-changed", "chats-changed", "jobs-changed", "sources-changed", "activity-changed"]);

/**
 * Flashcards (docs/phone-plugins-plan.md) changed its library here. Cards a
 * generation adds are announced as `batch-changed`. What sync itself wrote
 * into the library is announced too (for open pages), and isn't a change made here.
 */
export function flashcardsChanged(event: ServerEvent): boolean {
	return event.type === "plugin-message" && event.pluginId === "flashcards" && (event.topic === "changed" || event.topic === "batch-changed") && !isSyncEcho(event.data);
}

export function createSyncLoop(deps: SyncLoopDeps): SyncLoop {
	let running = false;
	let unsubscribe: (() => void) | null = null;
	let timer: { handle: unknown; due: number } | null = null;
	let inFlight = false;
	/** Something changed while a round was under way: go again soon after it. */
	let again = false;
	let failures = 0;

	function schedule(ms: number, replace = false): void {
		if (!running) return;
		const due = deps.now() + ms;
		if (timer) {
			if (!replace && timer.due <= due) return;
			deps.clearTimer(timer.handle);
		}
		timer = { handle: deps.setTimer(fire, ms), due };
	}

	function fire(): void {
		timer = null;
		if (!running) return;
		if (inFlight) { again = true; return; }
		inFlight = true;
		again = false;
		void deps.round().catch((): RoundOutcome => "offline").then((outcome) => {
			inFlight = false;
			if (!running) return;
			if (outcome === "ok") {
				failures = 0;
				schedule(again ? CHANGE_MS : POLL_MS, true);
			} else if (outcome === "offline") {
				failures += 1;
				schedule(retryDelayMs(failures), true);
			} else {
				// Paused (the versions differ) or unpaired by the server: nothing a
				// retry can fix soon. Look again now and then.
				failures = 0;
				schedule(RETRY_MAX_MS, true);
			}
			again = false;
		});
	}

	function onEvent(event: ServerEvent): void {
		// What sync itself wrote is no change made here, also while a round is under way.
		if (event.type === "plugin-message" && isSyncEcho(event.data)) return;
		if (inFlight) { again = true; return; }
		// While the server can't be reached, the retries keep their own slow pace.
		if (failures > 0) return;
		// A side question (the Tutor, upstream 0.6.0) announces `side-chats-changed`
		// when its answer starts (the question is in the record by then) and when it
		// ends. Both go at once: the start tells the server this desktop is busy,
		// as a reply's start does, and the question isn't left unsent while the
		// answer is being written.
		if (event.type === "turn-started" || event.type === "side-chats-changed") schedule(0);
		else if (CHANGES.has(event.type) || flashcardsChanged(event)) schedule(CHANGE_MS);
	}

	return {
		start() {
			if (running) return;
			running = true;
			unsubscribe = deps.subscribe(onEvent);
			schedule(0);
		},
		stop() {
			running = false;
			unsubscribe?.();
			unsubscribe = null;
			if (timer) deps.clearTimer(timer.handle);
			timer = null;
		},
		now() {
			if (!running) return;
			failures = 0;
			if (inFlight) again = true; else schedule(0, true);
		},
		started: () => running,
	};
}

// ─── This app's own loop ─────────────────────────────────────────────────────

const globals = globalThis as typeof globalThis & { __lhSyncLoop?: SyncLoop };

async function oneRound(): Promise<RoundOutcome> {
	if (!activePairing()) return "not-paired";
	const round = await runSyncRound();
	for (const part of [round.sessions, round.graph, round.maps, round.flashcards]) {
		if (!part || part.ok) continue;
		if (part.reason === "not-paired" || part.reason === "paused") return part.reason;
		// "busy" (another round is under way) and a refusal are tried again at the usual pace.
		if (part.reason === "offline") return "offline";
	}
	return "ok";
}

/** Start this app's loop (once per process). */
export function startSyncLoop(): SyncLoop {
	const loop = (globals.__lhSyncLoop ??= createSyncLoop({
		round: oneRound,
		subscribe,
		now: Date.now,
		setTimer: (run, ms) => {
			const handle = setTimeout(run, ms);
			// The loop never keeps the app's server alive on its own.
			handle.unref?.();
			return handle;
		},
		clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	}));
	loop.start();
	return loop;
}

/** "Unpair this PC": this app's loop, if it runs, stops and sets no further timer. */
export function stopSyncLoop(): void {
	globals.__lhSyncLoop?.stop();
}

/** After pairing, or for "Sync now": make sure the loop runs, and run a round at once. */
export function kickSyncLoop(): void {
	startSyncLoop().now();
}
