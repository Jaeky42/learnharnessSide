/** Multi-account: the gateway unpairs every desktop app of this copy. See unpairAllResponse in src/server/server-auth.ts. 404 unless behind a gateway, and without its secret and scope "internal". */
import { unpairAllResponse } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(request: Request) { return unpairAllResponse(request); }
