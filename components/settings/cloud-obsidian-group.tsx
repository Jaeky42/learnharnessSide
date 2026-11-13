"use client";
/**
 * Settings → Obsidian as a group inside Cloud, on a phone on the server's
 * site (side-tutor fork; owner's ask: the phone's Settings list was getting
 * cramped). Under the "Desktop apps" group, after a divider (SettingsGroup's
 * own, between two groups), the unchanged ObsidianSection under the heading
 * "Obsidian". A tablet and a computer keep Obsidian's own row and section;
 * the desktop app never shows Obsidian.
 *
 * A link to Settings → Obsidian on a phone opens Cloud with this group in
 * view: `scrollIntoView` is set (components/settings/settings-dialog.tsx),
 * the group scrolls to the top of the page once it is on screen (Settings
 * may still be loading when the link arrives) and hands the request back
 * with `onScrolled`. Both groups load their state after they mount, so the
 * group above can grow while the page settles: the group is kept at the top
 * of the scrolling column while sizes change, for a short while or until the
 * learner touches, scrolls or presses a key there.
 */

import { useEffect, useRef } from "react";
import { SettingsGroup } from "./controls.tsx";
import { ObsidianSection } from "./obsidian-section.tsx";

/** How long the group is kept in view while the page above it settles. */
const KEEP_IN_VIEW_MS = 2000;
/** The learner taking over the column: the group is no longer held in view. */
const LET_GO = ["touchstart", "pointerdown", "wheel", "keydown"] as const;

export function CloudObsidianGroup({ scrollIntoView, onScrolled }: { scrollIntoView: boolean; onScrolled: () => void }) {
	// A hidden marker just before the group (display: none, so it adds no gap):
	// the group stays the section's second child, so SettingsGroup draws the
	// divider above it.
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
			<SettingsGroup label="Obsidian" testid="cloud-obsidian-group">
				<ObsidianSection />
			</SettingsGroup>
		</>
	);
}
