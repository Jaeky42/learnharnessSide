/** The GPT-Live trial (voice plan, Phase 0): src/server/voice-trial.ts. 404 outside server mode. */
import { voiceTrialHangupResponse } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(request: Request) { return voiceTrialHangupResponse(request); }
