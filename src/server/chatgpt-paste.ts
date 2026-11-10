/**
 * ChatGPT "paste the address you landed on" (side-tutor fork, cloud sync
 * Phase 2; docs/cloud-sync.md). Server mode only.
 *
 * ChatGPT sign-in redirects the browser to http://127.0.0.1:<port>/auth/callback
 * on the SERVER (electron/chatgpt.cjs), which a phone can't open. The learner
 * pastes that address instead, and the server sends it to its own waiting
 * listener. The listener still checks the state and code itself; this only
 * decides what may be forwarded:
 *   - an http URL on 127.0.0.1 with path /auth/callback,
 *   - whose origin is exactly the PENDING sign-in's listener (so nothing else
 *     on the machine can be reached through this step),
 *   - carrying a code or error and a state.
 */

export type PasteCheck = { ok: true; url: string } | { ok: false; error: string };

const MAX_LENGTH = 8192;

export function checkPastedCallback(pasted: unknown, pendingOrigin: string | null): PasteCheck {
	if (!pendingOrigin) return { ok: false, error: "No ChatGPT sign-in is waiting. Start again with Connect." };
	if (typeof pasted !== "string" || !pasted.trim()) return { ok: false, error: "Paste the full address from the page that wouldn't load." };
	if (pasted.length > MAX_LENGTH) return { ok: false, error: "That address is too long. Copy it again from the address bar." };
	let url: URL;
	try {
		url = new URL(pasted.trim());
	} catch {
		return { ok: false, error: "That isn't a web address. Copy the whole address from the address bar." };
	}
	if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/auth/callback" || url.username || url.password) {
		return { ok: false, error: "That's not the sign-in address. It should start with http://127.0.0.1: and contain /auth/callback." };
	}
	if (url.origin !== pendingOrigin) {
		return { ok: false, error: "That address is from an older sign-in attempt. Press Connect again and use the new address." };
	}
	if (!url.searchParams.get("state") || !(url.searchParams.get("code") || url.searchParams.get("error"))) {
		return { ok: false, error: "The address is missing its sign-in code. Copy the whole address, including everything after the ?." };
	}
	return { ok: true, url: url.href };
}

/** Forward a checked address to the local listener; resolves when it answered. */
export async function forwardPastedCallback(url: string, request: typeof fetch = fetch): Promise<boolean> {
	try {
		const response = await request(url, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
		await response.body?.cancel().catch(() => {});
		return response.ok;
	} catch {
		return false;
	}
}
