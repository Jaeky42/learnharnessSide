// The notes drawer (src/server/notes.ts): the learner's own notes in their
// Obsidian vault. Never read by any agent, never written into a chat record.
import { notesActionResponse, notesTreeResponse } from "@/src/server";

export async function GET(): Promise<Response> {
	return notesTreeResponse();
}

export async function POST(req: Request): Promise<Response> {
	return notesActionResponse(req);
}
