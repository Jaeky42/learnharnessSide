/**
 * Multi-account (docs/multi-account-plan.md, "Smaller rules"): accounts that
 * use one browser share its storage. At sign-out, Sign out everywhere and
 * Delete my account, behind the gateway, whatever holds a person's own words
 * is removed; window positions and view state stay (they say nothing about
 * what the person wrote or learned).
 *
 * What the app keeps in the browser (audited; plugins' front ends keep nothing):
 *
 *   localStorage
 *     lh:notes-expanded            folders open in the notes list (their names)   content
 *     lh:notes-open-note:<chatId>  the note open in a session (path, session id)  content
 *     lh:notes-split-dismissed     paths of notes whose "split" hint was waved off content
 *     lh:notes-open|view|tree-open|tree-height|width|mode   drawer layout          view
 *     lh:side-tutor:pos|size       the Tutor window                                view
 *     lh:sidebar-open, lh:session-kind-filter                                      view
 *     lh.graph.camera.v1           the graph's zoom and pan                        view
 *     lh:keymap                    keyboard shortcut overrides (a preference)      view
 *   sessionStorage
 *     lh.openingPrompt.<chatId>    the first message of a new session, until it is sent   content
 *     lh:kbdebug                   a phone readout switch                          view
 *
 * Per-session keys count as content: the id and the note path tell the next
 * person at this browser what the last one had open. IndexedDB and cookies
 * hold nothing of the person's (the cookies are plain markers).
 */

/** Exact keys that hold content. */
export const CONTENT_KEYS: readonly string[] = ["lh:notes-expanded", "lh:notes-split-dismissed"];
/** Prefixes of keys that hold content (one key per session). */
export const CONTENT_PREFIXES: readonly string[] = ["lh:notes-open-note:", "lh.openingPrompt."];

const isContentKey = (key: string): boolean => CONTENT_KEYS.includes(key) || CONTENT_PREFIXES.some((prefix) => key.startsWith(prefix));

function clearStore(store: Storage | undefined): void {
	if (!store) return;
	try {
		const keys: string[] = [];
		for (let i = 0; i < store.length; i++) {
			const key = store.key(i);
			if (key !== null) keys.push(key);
		}
		for (const key of keys) if (isContentKey(key)) store.removeItem(key);
	} catch { /* blocked or unavailable storage: nothing to clear */ }
}

/** Remove what holds a person's content from this browser's local and session storage. */
export function clearAccountContent(): void {
	for (const name of ["localStorage", "sessionStorage"] as const) {
		let store: Storage | undefined;
		try { store = typeof window === "undefined" ? undefined : window[name]; } catch { store = undefined; }
		clearStore(store);
	}
}
