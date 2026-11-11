/** Cloud sync (Phase 5): this copy's own sync control. See src/server/sync/cloud-http.ts. */
import { cloudActionResponse, cloudStatusResponse } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET() { return cloudStatusResponse(); }
export function POST(request: Request) { return cloudActionResponse(request); }
