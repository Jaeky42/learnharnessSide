"use client";

/**
 * SPEAKING TO THE SIDE TUTOR (fork; owner's ask): who a dictation run
 * belongs to.
 *
 * A page has one dictation run at a time (components/dictation.tsx), and
 * its transcript normally lands in the lesson's own input. The side
 * tutor's Dictate button borrows that run: it claims the transcript here,
 * then starts the run. While the claim stands
 *   - the transcript goes to the tutor's typing box instead, and
 *   - the lesson's own dictation controls show no run (useSideDictationOwned).
 * dictation.tsx releases the claim whenever a run ends, however it ends,
 * so a claim never outlives its run.
 */

import { useSyncExternalStore } from "react";

let target: ((text: string) => void) | null = null;
const listeners = new Set<() => void>();

function emit(): void {
	for (const listener of listeners) listener();
}

/** Where the live run's transcript goes instead of the lesson's input, if claimed. */
export function sideDictationTarget(): ((text: string) => void) | null {
	return target;
}

/** The side tutor takes the next run's transcript. Claim, then start the run. */
export function claimSideDictation(append: (text: string) => void): void {
	target = append;
	emit();
}

export function releaseSideDictation(): void {
	if (!target) return;
	target = null;
	emit();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Is the current (or about to start) run the side tutor's? */
export function useSideDictationOwned(): boolean {
	return useSyncExternalStore(subscribe, () => target !== null, () => false);
}
