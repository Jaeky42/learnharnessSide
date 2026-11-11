/** Cloud sync (Phase 5): one picture of a session, fetched or sent on its own by a paired desktop. See src/server/sync/http.ts. 404 outside server mode. */
import { sessionPictureResponse } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; picture: string }> };
export async function GET(request: Request, { params }: Ctx) { const { id, picture } = await params; return sessionPictureResponse(request, id, picture); }
export async function PUT(request: Request, { params }: Ctx) { const { id, picture } = await params; return sessionPictureResponse(request, id, picture); }
