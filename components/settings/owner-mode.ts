"use client";
/**
 * Is the signed-in person this server's owner (several accounts on one
 * server; docs/fork/plans/multi-account-plan.md)? Side-tutor fork. The gateway sets a
 * plain `lh_owner=1` marker cookie for the owner. It only decides whether
 * Settings → Accounts SHOWS; the gateway decides what is allowed. Built like
 * server-mode.ts: nothing asks the server, so the desktop app and a
 * single-copy server read false. undefined until mounted.
 */
import { useEffect, useState } from "react";

export function isOwnerMode(cookie: string | undefined = typeof document === "undefined" ? undefined : document.cookie): boolean {
	return typeof cookie === "string" && cookie.split(";").some((part) => part.trim() === "lh_owner=1");
}

export function useOwnerMode(): boolean | undefined {
	const [owner, setOwner] = useState<boolean | undefined>(undefined);
	useEffect(() => { setOwner(isOwnerMode()); }, []);
	return owner;
}
