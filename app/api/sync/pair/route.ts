/** Cloud sync (Phase 5): a desktop app trades its pairing code for a key. See src/server/sync/http.ts. 404 outside server mode. */
import { pairResponse } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(request: Request) { return pairResponse(request); }
