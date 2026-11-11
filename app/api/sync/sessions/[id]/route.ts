/** Cloud sync (Phase 5): one session's files, fetched, sent by its holder, or deleted. See src/server/sync/http.ts. 404 outside server mode. */
import { sessionBundleResponse } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, { params }: Context) { return sessionBundleResponse(request, (await params).id); }
export async function PUT(request: Request, { params }: Context) { return sessionBundleResponse(request, (await params).id); }
export async function DELETE(request: Request, { params }: Context) { return sessionBundleResponse(request, (await params).id); }
