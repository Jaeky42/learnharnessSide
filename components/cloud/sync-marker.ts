"use client";
/**
 * Is cloud sync in use on this copy (cloud sync Phase 6, docs/cloud-sync.md)?
 * The app's own server sets a plain `lh_cloud=1` marker cookie (proxy.ts)
 * only where a PC is paired (or was removed by its server), or where a
 * desktop has synced with this server. Nothing else sets it, so an app that
 * was never paired reads false and makes no request about sync at all.
 *
 * Pairing and unpairing happen in Settings → Cloud, which says so with
 * SYNC_MARKER_EVENT; the cookie itself follows on the app's next request.
 */
import { useEffect, useState } from "react";

export const SYNC_MARKER_EVENT = "lh:cloud-sync-changed";

export function isSyncInUse(cookie: string | undefined = typeof document === "undefined" ? undefined : document.cookie): boolean {
	return typeof cookie === "string" && cookie.split(";").some((part) => part.trim() === "lh_cloud=1");
}

/** Settings → Cloud paired or unpaired this copy: sync is (or isn't) in use from now on. */
export function announceSyncInUse(inUse: boolean): void {
	window.dispatchEvent(new CustomEvent(SYNC_MARKER_EVENT, { detail: { inUse } }));
}

/** false until mounted, and for good in an app that isn't paired. */
export function useSyncInUse(): boolean {
	const [inUse, setInUse] = useState(false);
	useEffect(() => {
		setInUse(isSyncInUse());
		const onChange = (event: Event) => setInUse((event as CustomEvent<{ inUse: boolean }>).detail.inUse);
		window.addEventListener(SYNC_MARKER_EVENT, onChange);
		return () => window.removeEventListener(SYNC_MARKER_EVENT, onChange);
	}, []);
	return inUse;
}
