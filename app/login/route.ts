/** Server-mode login (cloud sync Phase 1): see src/server/server-auth.ts. 404 outside server mode. */
import { loginPageResponse } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = loginPageResponse;
