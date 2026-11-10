/** Claude sign-in on the cloud server (side-tutor fork): src/server/claude-login-http.ts. 404 outside server mode. */
import { claudeLoginControlResponse, claudeLoginStatusResponse } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) { return claudeLoginStatusResponse(request); }
export function POST(request: Request) { return claudeLoginControlResponse(request); }
