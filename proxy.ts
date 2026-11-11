import { NextResponse, type NextRequest } from "next/server";
import { apiRequestRefusal } from "./src/server/desktop-access.ts";
import { SERVER_MARKER_COOKIE, serverGate, serverModeEnabled } from "./src/server/server-auth.ts";
import { SYNC_MARKER_COOKIE } from "./src/core/sync/sessions.ts";
import { heldElsewhereResponse, sessionWritePath, syncInUse } from "./src/server/sync/engine.ts";

/** Protects API methods, including SSE and spending/settings routes. The one
 * streamed document route enforces the identical all-method request policy
 * inside its handler, avoiding Next's silently truncated Proxy body clone.
 * No public callback or worker bypass: legitimate self-HTTP still needs the capability.
 *
 * Side-tutor fork (cloud sync Phase 1): with LH_SERVER_MODE=1 the login
 * gate (src/server/server-auth.ts) covers every page and API, so the matcher
 * includes pages; static build files stay outside it. Without server mode
 * pages pass straight through.
 *
 * Which gate guards the API (owner's decision at the 0.6.0 merge): the
 * fork's login gate on the cloud server, upstream's request policy
 * (apiRequestRefusal) everywhere else. Upstream's browser-mode Host
 * allow-list would refuse the server's own domain, and the login gate
 * already refuses cross-site writes. `apiGate` in src/server/api-gate.ts is
 * the same rule for the one route that skips this proxy. */
export function proxy(request: NextRequest) {
	const gated = serverGate({ method: request.method, pathname: request.nextUrl.pathname, headers: request.headers, url: request.url });
	if (gated) return gated;
	const { pathname } = request.nextUrl;
	const refusal = (pathname === "/api" || pathname.startsWith("/api/")) && !serverModeEnabled() ? apiRequestRefusal(request) : undefined;
	if (refusal) {
		return NextResponse.json(
			{ error: refusal },
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
	// Cloud sync (Phase 6): the same kind of marker for "sync is in use here"
	// (components/cloud/sync-marker.ts). An app that was never paired never
	// gets it, so its pages ask nothing about sync.
	const inUse = syncInUse();
	if (inUse !== request.cookies.has(SYNC_MARKER_COOKIE)) {
		if (inUse) response.cookies.set(SYNC_MARKER_COOKIE, "1", { path: "/", sameSite: "lax", secure: serverModeEnabled(), maxAge: 365 * 24 * 60 * 60 });
		else response.cookies.set(SYNC_MARKER_COOKIE, "", { path: "/", sameSite: "lax", secure: serverModeEnabled(), maxAge: 0 });
	}
	return response;
}

export const config = {
	// Pages and every API route, except static build files and the one
	// streamed plugin document endpoint (exactly that path, not the documents
	// subtree or other plugin routes), which runs the same gates inside its
	// handler. Must remain static literals.
	matcher: ["/((?!_next/static|_next/image|favicon.ico|api/plugins/[^/]+/documents/markdown/?$).*)"],
};
