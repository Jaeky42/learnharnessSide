// Embedded images for the notes Read view (vault images only).
import { noteAssetResponse } from "@/src/server";

export async function GET(req: Request): Promise<Response> {
	return noteAssetResponse(req);
}
