"use client";

/**
 * A PLUGIN'S QUESTION OR PRACTICE PROBLEM ON A PHONE (fork; see
 * phone-plugins.ts). The teacher may still ask a plugin question (flashcards,
 * a coding question, a drawing…), and a practice session started on a
 * computer may hold a plugin's problem. On a phone both are parked: in place
 * of the plugin's box the dock shows the owner's sentence, and the plugin's
 * editor is never mounted.
 *
 * A parked QUESTION also has "Dismiss question" (owner's decision): upstream's
 * server takes no typed message while a plugin question waits, so without it
 * the lesson could only go on from a computer. The button is upstream's own
 * dismissal, with upstream's words: the teacher is told the question was
 * dismissed, and the message box comes back.
 *
 * A parked PROBLEM has no button: upstream has no dismissal for one.
 *
 * Parking itself does nothing: nothing is answered, dismissed or changed on
 * the server, so the same session opened on a computer shows it as it was.
 *
 * Off a phone these are upstream's docks, untouched.
 */

import { useRef, useState, type ComponentProps } from "react";
import { finishDictation } from "@/components/dictation";
import { PluginProblemDock } from "@/components/plugin-problem-dock";
import { PluginQuestionDock } from "@/components/plugin-question-dock";
import { useIsPhone } from "@/components/phone/use-phone";
import { DISMISS_PLUGIN_QUESTION_TEXT, PARKED_PLUGIN_PROBLEM_TEXT, PARKED_PLUGIN_QUESTION_TEXT } from "@/components/phone/phone-plugins";
import { Button } from "@/components/ui/button";

/** The sentence, and the way to dismiss the question (also what a test renders). */
export function ParkedPluginQuestion({ ready = true, dismiss }: {
	/** Upstream's own gate for the dock's buttons. */
	ready?: boolean;
	dismiss?: () => Promise<void>;
}) {
	const [busy, setBusy] = useState(false);
	const latch = useRef(false);
	return (
		<div data-testid="plugin-question-parked" className="flex flex-col items-start gap-2 px-4 py-3">
			<p role="status" className="text-sm text-muted-foreground">{PARKED_PLUGIN_QUESTION_TEXT}</p>
			{dismiss && (
				<Button
					type="button"
					variant="ghost"
					data-testid="plugin-question-parked-dismiss"
					disabled={!ready || busy}
					onClick={() => {
						// As upstream's dock does it: once at a time, after any dictation run has ended.
						if (latch.current) return;
						latch.current = true;
						setBusy(true);
						void finishDictation().then(dismiss).catch(() => {}).finally(() => { latch.current = false; setBusy(false); });
					}}
				>
					{DISMISS_PLUGIN_QUESTION_TEXT}
				</Button>
			)}
		</div>
	);
}

export function PhonePluginQuestionDock(props: ComponentProps<typeof PluginQuestionDock>) {
	const phone = useIsPhone();
	if (!phone) return <PluginQuestionDock {...props} />;
	return <ParkedPluginQuestion ready={props.ready} dismiss={props.dismiss} />;
}

/** The sentence alone. */
export function ParkedPluginProblem() {
	return (
		<div data-testid="plugin-problem-parked" className="px-4 py-3">
			<p role="status" className="text-sm text-muted-foreground">{PARKED_PLUGIN_PROBLEM_TEXT}</p>
		</div>
	);
}

export function PhonePluginProblemDock(props: ComponentProps<typeof PluginProblemDock>) {
	const phone = useIsPhone();
	if (!phone) return <PluginProblemDock {...props} />;
	return <ParkedPluginProblem />;
}
