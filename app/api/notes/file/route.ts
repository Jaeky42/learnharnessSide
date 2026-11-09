// One note's body: GET ?path=, PUT {path, body, baseHash, chatId}.
import { noteReadResponse, noteSaveResponse } from "@/src/server";

export async function GET(req: Request): Promise<Response> {
	return noteReadResponse(req);
}

export async function PUT(req: Request): Promise<Response> {
	return noteSaveResponse(req);
}
