/** One-use redirect to Claude's sign-in page (side-tutor fork): src/server/claude-login-http.ts. */
import { claudeLoginOpenResponse } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) { return claudeLoginOpenResponse(request); }
