/** Cloud sync (Phase 5): a paired desktop asks for a session another device holds. See src/server/sync/http.ts. 404 outside server mode. */
import { sessionTakeResponse } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) { return sessionTakeResponse(request, (await params).id); }
