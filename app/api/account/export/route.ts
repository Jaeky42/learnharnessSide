/** Multi-account: "Download my data", a .zip of this copy's data folder. 404 unless the copy stands behind the gateway. See src/server/account-export.ts. */
import { accountExportResponse } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) { return accountExportResponse(request); }
