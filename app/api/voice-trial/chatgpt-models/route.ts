/** The GPT-Live trial (voice plan, Phase 0): a read-only hint, src/server/voice-trial.ts. 404 outside server mode. */
import { voiceTrialChatGPTModelsResponse } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) { return voiceTrialChatGPTModelsResponse(request); }
