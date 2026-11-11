/** Cloud sync (Phase 5): a paired desktop asks what changed. See src/server/sync/http.ts. 404 outside server mode. */
import { sessionsExchangeResponse } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(request: Request) { return sessionsExchangeResponse(request); }
