"use client";

/**
 * The side tutor's Dictate button (fork; owner's ask): speak a question to
 * the tutor instead of typing it.
 *
 *   idle        a microphone button to the right of the typing box.
 *   listening   a small live waveform and a red Stop button in its place.
 *               Stop (or Send) ends the run and the words land in the
 *               tutor's typing box, as they do in the lesson.
 *
 * It borrows the page's one dictation run (components/dictation.tsx): the
 * same microphone, Deepgram key, language and shortcuts as the lesson's
 * Dictate. See side-tutor-dictation-state.ts for how the words are routed.
 */

import { useEffect, useState } from "react";
import { Loader2Icon, MicIcon } from "lucide-react";
import { DEEPGRAM_KEY_ID, DICTATION_KEYLESS, METER_TICK_MS, rmsToMeter, type Dictation } from "@/components/dictation";
import { blurAfterPointerClick } from "@/components/focus-hygiene";
import { useSettingsDialog } from "@/components/settings/settings-dialog";
import { claimSideDictation, useSideDictationOwned } from "@/components/side-tutor-dictation-state";

/** Bars in the small waveform (4 px each: the lesson meter's pitch). */
const METER_BARS = 14;

function Waveform({ levelRef }: { levelRef: { current: number } }) {
	const [levels, setLevels] = useState<number[]>(() => new Array(METER_BARS).fill(0));
	// The meter's own heartbeat, as in the lesson's bar: only this strip repaints.
	useEffect(() => {
		const id = setInterval(() => {
			setLevels((ring) => [...ring.slice(1), rmsToMeter(levelRef.current)]);
		}, METER_TICK_MS);
		return () => clearInterval(id);
	}, [levelRef]);
	return (
		<div className="flex h-9 w-14 shrink-0 items-center gap-[2px]" data-testid="side-tutor-meter" aria-hidden>
			{levels.map((v, i) => (
				<span key={i} className="min-w-0 flex-1 rounded-full bg-foreground/40" style={{ height: `${2 + Math.round(v * 14)}px` }} />
			))}
		</div>
	);
}

export function SideTutorDictate({ dictation, append }: { dictation: Dictation; append: (text: string) => void }) {
	const owned = useSideDictationOwned();
	const { open: openSettings } = useSettingsDialog();
	const mine = owned && dictation.active;
	/** The lesson is dictating: one microphone, one run. */
	const busyElsewhere = dictation.active && !owned;
	const keyless = dictation.error === DICTATION_KEYLESS;

	if (mine) {
		return (
			<div className="flex shrink-0 items-center gap-2" data-testid="side-tutor-dictation">
				<Waveform levelRef={dictation.levelRef} />
				<button
					type="button"
					onClick={(e) => {
						blurAfterPointerClick(e);
						dictation.toggle();
					}}
					disabled={dictation.phase === "stopping"}
					className="flex size-9 shrink-0 items-center justify-center rounded-md bg-destructive/10 text-destructive transition-colors hover:bg-destructive/20"
					aria-label="Stop dictation"
					title="Stop dictation (Esc)"
					data-testid="side-tutor-dictate"
				>
					{dictation.phase === "stopping" ? <Loader2Icon className="size-4 animate-spin" /> : <MicIcon className="size-4" />}
				</button>
			</div>
		);
	}

	return (
		<button
			type="button"
			onClick={(e) => {
				blurAfterPointerClick(e);
				if (busyElsewhere || dictation.phase !== "idle") return;
				if (keyless) {
					// As in the lesson's bar: the click leads to the missing key.
					dictation.clearError();
					openSettings("keys", DEEPGRAM_KEY_ID);
					return;
				}
				claimSideDictation(append);
				dictation.toggle();
			}}
			disabled={busyElsewhere}
			className="flex size-9 shrink-0 items-center justify-center rounded-md border border-input text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
			aria-label={dictation.error ? `Dictation failed: ${dictation.error}` : "Start dictation"}
			title={dictation.error ?? "Dictate"}
			data-testid="side-tutor-dictate"
		>
			<MicIcon className="size-4" />
		</button>
	);
}
