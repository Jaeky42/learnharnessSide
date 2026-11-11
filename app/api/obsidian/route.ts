/** The Obsidian vault on the cloud server (side-tutor fork, Phase 4): src/server/obsidian-sync-http.ts. 404 outside server mode. */
import { obsidianControlResponse, obsidianStatusResponse } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) { return obsidianStatusResponse(request); }
export function POST(request: Request) { return obsidianControlResponse(request); }
