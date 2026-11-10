"use client";

/**
 * The phone layout's page-wide pieces (cloud sync Phase 3), mounted once in
 * the root layout: the keyboard-aware height, press-and-hold menus, the
 * window lock and, in the home-screen app, the clock cover. All do nothing
 * outside the phone layout.
 */

import { useEffect, useSyncExternalStore } from "react";
import { installLongPress } from "@/components/phone/long-press";
import { PhoneViewport } from "@/components/phone/phone-viewport";
import { useIsPhone } from "@/components/phone/use-phone";
import { installWindowLock } from "@/components/phone/window-lock";

const STANDALONE_QUERY = "(display-mode: standalone)";

function standaloneNow(): boolean {
	const nav = navigator as Navigator & { standalone?: boolean };
	return nav.standalone === true || window.matchMedia(STANDALONE_QUERY).matches;
}

/** True in the home-screen app (iPhone or Android); false in a browser tab and on the server. */
function useIsStandalone(): boolean {
	return useSyncExternalStore(
		(onChange) => {
			const mq = window.matchMedia(STANDALONE_QUERY);
			mq.addEventListener("change", onChange);
			return () => mq.removeEventListener("change", onChange);
		},
		standaloneNow,
		() => false,
	);
}

export function PhoneRuntime() {
	const phone = useIsPhone();
	const standalone = useIsStandalone();
	useEffect(() => installLongPress(), []);
	useEffect(() => installWindowLock(), []);
	return (
		<>
			<PhoneViewport />
			{/* CLOCK COVER (owner's choice): since iOS 26 the iPhone draws a
			    "Liquid Glass" blur over the top of a home-screen web app that
			    runs under the clock, about 40 points below it too, which
			    softened the top bar. WebKit reportedly skips that blur when a
			    pinned, solid, full-width box covers the top edge, and uses the
			    box's colour instead. app/phone.css styles it; overlays draw
			    over it. Experimental: other developers' reports disagree. */}
			{phone && standalone && <div data-phone="clock-cover" aria-hidden="true" />}
		</>
	);
}
