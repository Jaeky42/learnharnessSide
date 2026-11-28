import { notFound } from "next/navigation";
import { VoiceTrial } from "@/components/voice/voice-trial";
import { voiceTrialAvailable } from "@/src/server";

/**
 * VOICE (fork, Phase 0 of docs/fork/plans/voice-session-plan.md): the GPT-Live
 * trial page, on the server's site only. Elsewhere (the desktop app, a browser
 * on a desktop copy) it doesn't exist. Rendered per request, never prerendered:
 * whether this is the server is read when the page is asked for.
 */
export const dynamic = "force-dynamic";

export default function VoiceTrialPage() {
	if (!voiceTrialAvailable()) notFound();
	return <VoiceTrial />;
}
