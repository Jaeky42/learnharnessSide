/** Cloud sync (Phase 5): make a pairing code, or unpair a desktop app. See src/server/sync/http.ts. 404 outside server mode. */
import { desktopsResponse } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(request: Request) { return desktopsResponse(request); }
