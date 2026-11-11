/** Cloud sync (Phase 5): settings and the other files that sync one item at a time. See src/server/sync/http.ts. 404 outside server mode. */
import { mapsExchangeResponse } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(request: Request) { return mapsExchangeResponse(request); }
