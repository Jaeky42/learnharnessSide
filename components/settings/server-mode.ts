"use client";
/**
 * Is this LearnHarness the cloud server (server mode, docs/cloud-sync.md)?
 * Side-tutor fork. The server's proxy sets a plain `lh_server=1` marker
 * cookie (proxy.ts); nothing else does, so the desktop app and local use
 * read false without making any request. undefined until mounted.
 */
import { useEffect, useState } from "react";

export function isServerMode(cookie: string | undefined = typeof document === "undefined" ? undefined : document.cookie): boolean {
	return typeof cookie === "string" && cookie.split(";").some((part) => part.trim() === "lh_server=1");
}

export function useServerMode(): boolean | undefined {
	const [server, setServer] = useState<boolean | undefined>(undefined);
	useEffect(() => { setServer(isServerMode()); }, []);
	return server;
}
