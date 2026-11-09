// The session's notes home folder (where new notes go by default).
import { noteHomeResponse, noteSetHomeResponse } from "@/src/server";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	return noteHomeResponse(id);
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	return noteSetHomeResponse(id, req);
}
