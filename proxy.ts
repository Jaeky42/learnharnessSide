import { NextResponse, type NextRequest } from "next/server";
import { desktopAPIAuthorized } from "./src/server/desktop-access.ts";
import { SERVER_MARKER_COOKIE, serverGate, serverModeEnabled } from "./src/server/server-auth.ts";
import { heldElsewhereResponse, sessionWritePath } from "./src/server/sync/engine.ts";

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
	// Cloud sync (Phase 5): a session another device holds is read-only here.
	// Every write under /api/chats/<id> is refused in one place.
	const writes = sessionWritePath(request.method, pathname);
	const held = writes ? heldElsewhereResponse(writes) : null;
	if (held) return held;
	const response = NextResponse.next();
	// Lets the page know it's the cloud server without an extra request
	// (components/settings/server-mode.ts). Not a credential.
	if (serverModeEnabled() && !request.cookies.has(SERVER_MARKER_COOKIE)) {
		response.cookies.set(SERVER_MARKER_COOKIE, "1", { path: "/", sameSite: "lax", secure: true, maxAge: 365 * 24 * 60 * 60 });
	}
	return response;
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
