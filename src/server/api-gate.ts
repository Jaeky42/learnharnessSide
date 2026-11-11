import { apiRequestRefusal } from "./desktop-access.ts";
import { serverGate, serverModeEnabled } from "./server-auth.ts";

/**
 * Side-tutor fork: the API gate for a route that skips the proxy (the one
 * streamed plugin document endpoint). The same rule as proxy.ts: on the
 * cloud server the login gate decides, everywhere else upstream's request
 * policy. Checked before the route reads its parameters or its body.
 */
export function apiGate(request: Request): Response | undefined {
	if (serverModeEnabled()) {
		return serverGate({ method: request.method, pathname: new URL(request.url).pathname, headers: request.headers, url: request.url }) ?? undefined;
	}
	const error = apiRequestRefusal(request);
	return error ? Response.json({ error }, { status: 403, headers: { "Cache-Control": "no-store" } }) : undefined;
}
