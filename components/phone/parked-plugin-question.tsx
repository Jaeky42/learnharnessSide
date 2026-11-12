"use client";

/**
 * A PLUGIN QUESTION ON A PHONE (fork; see phone-plugins.ts). The teacher may
 * still ask one (flashcards, a coding question, a drawing…), but on a phone
 * it is parked: in place of the plugin's question box the dock shows the
 * owner's sentence, and the message box the chat passes in stays below it.
 *
 * Parking does nothing else: the question isn't answered, dismissed or
 * changed on the server, and the plugin's editor is never mounted, so the
 * same session opened on a computer shows the question as it was.
 *
 * Off a phone this is upstream's PluginQuestionDock, untouched.
 */

import type { ComponentProps, ReactNode } from "react";
import { PluginQuestionDock } from "@/components/plugin-question-dock";
import { useIsPhone } from "@/components/phone/use-phone";
import { PARKED_PLUGIN_QUESTION_TEXT } from "@/components/phone/phone-plugins";

/** The sentence alone (also what a test renders). */
export function ParkedPluginQuestion() {
	return (
		<div data-testid="plugin-question-parked" className="px-4 py-3">
			<p role="status" className="text-sm text-muted-foreground">{PARKED_PLUGIN_QUESTION_TEXT}</p>
		</div>
	);
}

export function PhonePluginQuestionDock({ composer, ...props }: ComponentProps<typeof PluginQuestionDock> & {
	/** The lesson's message box, shown under the sentence on a phone. */
	composer?: ReactNode;
}) {
	const phone = useIsPhone();
	if (!phone) return <PluginQuestionDock {...props} />;
	return (
		<>
			<ParkedPluginQuestion />
			{composer !== undefined && composer !== null && <div className="border-t border-border/60">{composer}</div>}
		</>
	);
}
