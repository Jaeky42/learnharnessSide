// Pasted images → the vault's attachments folder.
import { noteAttachmentResponse } from "@/src/server";

export async function POST(req: Request): Promise<Response> {
	return noteAttachmentResponse(req);
}
