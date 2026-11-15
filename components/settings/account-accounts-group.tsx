"use client";
/**
 * Settings → Accounts as a second group inside Account, on a phone (side-tutor
 * fork; owner's decision: the phone's Settings list stays at eight rows, as
 * Obsidian sits inside Cloud, see cloud-obsidian-group.tsx). Under the Account
 * section's own groups, after a divider, the unchanged AccountsSection. A
 * tablet and a computer keep the Accounts row and its own section. Shown to
 * the owner only (the caller checks the markers; AccountsSection does too).
 *
 * A link to Settings → Accounts on a phone opens Account with this group
 * scrolled to the top of the page: `scrollIntoView` is set
 * (components/settings/settings-dialog.tsx), the group is placed once it is on
 * screen and handed back with `onScrolled`. Its list loads after it mounts and
 * can grow, so it is kept at the top while sizes change, for a short while or
 * until the learner touches, scrolls or presses a key there.
 */

import { useEffect, useRef } from "react";
import { AccountsSection } from "./accounts-section.tsx";
import { phoneSettingsSection } from "@/components/phone/phone-plugins";

/** What a phone shows for a Settings section: Accounts is inside Account (and Obsidian inside Cloud, phone-plugins.ts). */
export function phoneSection(section: string): string {
	return section === "accounts" ? "account" : phoneSettingsSection(section);
}

/** How long the group is kept in view while the page settles. */
const KEEP_IN_VIEW_MS = 2000;
/** The learner taking over the column: the group is no longer held in view. */
const LET_GO = ["touchstart", "pointerdown", "wheel", "keydown"] as const;

export function AccountAccountsGroup({ scrollIntoView, onScrolled }: { scrollIntoView: boolean; onScrolled: () => void }) {
	// A hidden marker just before the group (display: none, no gap).
	const marker = useRef<HTMLSpanElement | null>(null);
	/** Ends the current keeping in view, if any. */
	const letGo = useRef<(() => void) | null>(null);
	useEffect(() => () => letGo.current?.(), []);
	useEffect(() => {
		if (!scrollIntoView) return;
		const group = marker.current?.nextElementSibling;
		const scroller = marker.current?.closest<HTMLElement>('[data-testid="settings-content"]');
		onScrolled();
		if (!group || !scroller) return;
		letGo.current?.();
		const place = () => {
			scroller.scrollTop += group.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
		};
		place();
		const observer = typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
		if (scroller.firstElementChild) observer?.observe(scroller.firstElementChild);
		let timer = 0;
		const stop = () => {
			observer?.disconnect();
			window.clearTimeout(timer);
			for (const type of LET_GO) scroller.removeEventListener(type, stop);
			if (letGo.current === stop) letGo.current = null;
		};
		timer = window.setTimeout(stop, KEEP_IN_VIEW_MS);
		for (const type of LET_GO) scroller.addEventListener(type, stop, { passive: true });
		letGo.current = stop;
	}, [scrollIntoView, onScrolled]);
	return (
		<>
			<span ref={marker} hidden />
			<AccountsSection divided />
		</>
	);
}
