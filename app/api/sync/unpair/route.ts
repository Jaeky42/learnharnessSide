/** Cloud sync (Phase 6): a paired desktop removes itself. See src/server/sync/http.ts. 404 outside server mode. */
import { unpairSelfResponse } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(request: Request) { return unpairSelfResponse(request); }
