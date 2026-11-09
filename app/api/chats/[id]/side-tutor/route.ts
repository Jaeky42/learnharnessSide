// The side-tutor window's transport (src/server/side-tutor.ts):
//   GET    → the stored side thread for this session
//   POST   {question}        → NDJSON stream of the answer
//   POST   {action:"abort"}  → stop the in-flight answer
//   DELETE → clear the side thread
// Nothing here touches the session record — side questions stay out of the
// main teacher's context by construction.
import { clearSideTutorResponse, sideTutorPostResponse, sideTutorThreadResponse } from "@/src/server";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	return sideTutorThreadResponse(id);
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	return sideTutorPostResponse(id, req);
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	return clearSideTutorResponse(id);
}
