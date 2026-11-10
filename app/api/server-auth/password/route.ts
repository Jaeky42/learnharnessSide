/** Server-mode login (cloud sync Phase 1): see src/server/server-auth.ts. 404 outside server mode. */
import { changePasswordResponse } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(request: Request) { return changePasswordResponse(request); }
