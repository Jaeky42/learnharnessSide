/** Flashcards sync (docs/phone-plugins-plan.md): the Flashcards library, item by item. See src/server/sync/http.ts. 404 outside server mode. */
import { flashcardsExchangeResponse } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(request: Request) { return flashcardsExchangeResponse(request); }
