/**
 * Cloud sync (Phase 5): the server address a desktop app pairs with.
 *
 * Approved with the plan: the desktop only connects to an https:// address.
 * Plain http is accepted for this machine alone (localhost, 127.0.0.1,
 * [::1]), which is how two copies are run side by side in tests.
 */

export type ServerAddress = { ok: true; url: string } | { ok: false; error: string };

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The server's origin ("https://learn.example.com"), without a path. */
export function normalizeServerAddress(input: unknown): ServerAddress {
	if (typeof input !== "string" || !input.trim()) return { ok: false, error: "Enter your server's address." };
	let text = input.trim();
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
	let url: URL;
	try { url = new URL(text); } catch { return { ok: false, error: "That doesn't look like a web address." }; }
	if (url.username || url.password) return { ok: false, error: "The address can't contain a user name or password." };
	if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
		return { ok: false, error: "The server's address must start with https://" };
	}
	return { ok: true, url: url.origin };
}
