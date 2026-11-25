/**
 * FORK (dictation after the app was away): the rules the recorder in
 * `components/dictation.tsx` follows when its kept audio engine is dead after
 * the page was suspended (an iOS home-screen app that was in the background),
 * and when the microphone is taken away during a run. Constants and pure
 * rules only; no React. See "Dictation" in `docs/fork/lesson.md`.
 */

/** Owner-approved words: the run ended because no engine would run. */
export const DICTATION_MIC_DEAD = "Microphone didn't start. Try again.";

/** How long a start waits for `AudioContext.resume()` before looking at the state again. */
export const ENGINE_RESUME_CAP_MS = 500;
/** After the graph is connected: how long before a silent engine is taken for dead. */
export const ENGINE_SILENT_CHECK_MS = 700;
/** The wait for an engine there is nothing to fall back from: one made in this run
 *  (never a kept one), at its resume and at the silent check that would end the run.
 *  A healthy engine can be slow to start (the sound moving to a headset), and giving
 *  up on the last one early gains nothing. */
export const ENGINE_LAST_CHANCE_MS = 4000;
/** Events iOS queued while the page was frozen fire right after it is shown again. */
export const SHOWN_RECENTLY_MS = 2000;
/** With the page in front the whole time, soft evidence is looked at again after this. */
export const LOSS_GRACE_MS = 1500;

type TrackLike = { readyState?: unknown; muted?: unknown };
type EngineLike = { state?: unknown } | null | undefined;

/** True unless the engine positively reads a state other than "running".
 *  A stand-in without a string `state` counts as running (no resume, as before). */
export function engineRunning(ctx: EngineLike): boolean {
	const state = ctx?.state;
	return typeof state !== "string" || state === "running";
}

/** `"ended"`: a track ended. `"soft"`: a track is muted, or the engine isn't running.
 *  `null`: no positive evidence (missing properties mean "not lost"). */
export type CaptureEvidence = "ended" | "soft" | null;

export function captureEvidence(tracks: readonly TrackLike[], ctx: EngineLike): CaptureEvidence {
	if (tracks.some((track) => track.readyState === "ended")) return "ended";
	if (tracks.some((track) => track.muted === true)) return "soft";
	if (!engineRunning(ctx)) return "soft";
	return null;
}

export function captureLost(tracks: readonly TrackLike[], ctx: EngineLike): boolean {
	return captureEvidence(tracks, ctx) !== null;
}

export type LossAction = "none" | "stop" | "recheck";

/**
 * What to do when evidence is seen: stop now for an ended track, a hidden
 * page, or a page shown less than SHOWN_RECENTLY_MS ago; otherwise (the page
 * was in front the whole time) look again after LOSS_GRACE_MS.
 */
export function lossAction(
	evidence: CaptureEvidence,
	page: { hidden: boolean; shownAt: number | null; now: number },
): LossAction {
	if (!evidence) return "none";
	if (evidence === "ended" || page.hidden) return "stop";
	if (page.shownAt !== null && page.now - page.shownAt < SHOWN_RECENTLY_MS) return "stop";
	return "recheck";
}

/** The silent-engine net: alive when the worklet has said anything, or the clock moved. */
export function engineSilent(heard: boolean, clockAtArm: number, clockNow: unknown): boolean {
	if (heard) return false;
	return !(typeof clockNow === "number" && clockNow > clockAtArm);
}

/** The start path's mapping of a capture failure to its line (kept equal to the recorder's catch). */
export function captureErrorMessage(e: unknown): string {
	return e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError")
		? "Microphone permission denied"
		: e instanceof Error
			? e.message
			: "mic unavailable";
}

/** Call `resume()` and wait for it at most `ms`; a rejection or the cap both just resolve. */
export function resumeWithin(ctx: { resume: () => Promise<void> }, ms: number): Promise<void> {
	return new Promise((resolve) => {
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		let resumed: Promise<void>;
		try {
			resumed = ctx.resume();
		} catch {
			finish();
			return;
		}
		Promise.resolve(resumed).then(finish, finish);
	});
}

/** Whether the page is hidden right now; false where there is no document. */
export function pageHidden(): boolean {
	try {
		return typeof document !== "undefined" && document.visibilityState === "hidden";
	} catch {
		return false;
	}
}
