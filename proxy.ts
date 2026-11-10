import { NextResponse, type NextRequest } from "next/server";
import { desktopAPIAuthorized } from "./src/server/desktop-access.ts";
import { serverGate } from "./src/server/server-auth.ts";

/** Applies to every API method, including SSE and spending/settings routes.
 * No public callback or worker bypass: internal jobs call server functions,
 * and any legitimate self-HTTP request must carry the private capability.
 *
 * Side-tutor fork (cloud sync Phase 1): with LH_SERVER_MODE=1 the login
 * gate (src/server/server-auth.ts) also covers every page, so the matcher
 * includes pages; static build files stay outside it. Without server mode
 * pages pass straight through, exactly as before. */
export function proxy(request: NextRequest) {
	const gated = serverGate({ method: request.method, pathname: request.nextUrl.pathname, headers: request.headers, url: request.url });
	if (gated) return gated;
	const { pathname } = request.nextUrl;
	if ((pathname === "/api" || pathname.startsWith("/api/")) && !desktopAPIAuthorized(request.headers)) {
		return NextResponse.json(
			{ error: "Desktop API access requires the trusted LearnHarness window." },
			{ status: 403, headers: { "Cache-Control": "no-store" } },
		);
	}
	return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
