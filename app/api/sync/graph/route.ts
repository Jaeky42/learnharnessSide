/** Cloud sync (Phase 5): the graph log, fetched and added to by a paired desktop. See src/server/sync/http.ts. 404 outside server mode. */
import { graphLogResponse } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) { return graphLogResponse(request); }
export function POST(request: Request) { return graphLogResponse(request); }
