/** Server-mode login (cloud sync Phase 1): see src/server/server-auth.ts. 404 outside server mode. */
import { accountResponse } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) { return accountResponse(request); }
