/** Cloud sync (Phase 5): a paired desktop's protocol check. See src/server/sync/http.ts. 404 outside server mode. */
import { helloResponse } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(request: Request) { return helloResponse(request); }
