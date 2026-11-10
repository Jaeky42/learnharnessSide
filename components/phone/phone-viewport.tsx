"use client";

/**
 * PHONE VIEWPORT (cloud sync Phase 3). On a phone the on-screen keyboard
 * covers the bottom of the page instead of shrinking it (iPhone Safari), so
 * the message box would sit underneath it. This keeps --lh-vvh equal to the
 * height that is actually visible; app/phone.css sizes the app's full-height
 * shells from it, so the layout ends where the keyboard begins.
 *
 * Mounted once in the root layout. Does nothing off a phone: the variable is
 * only ever read inside the phone media query.
 */

import { useEffect } from "react";
import { useIsPhone } from "@/components/phone/use-phone";

export function PhoneViewport() {
	const phone = useIsPhone();
	useEffect(() => {
		const root = document.documentElement;
		const vv = window.visualViewport;
		if (!phone || !vv) {
			root.style.removeProperty("--lh-vvh");
			return;
		}
		const sync = () => {
			root.style.setProperty("--lh-vvh", `${Math.round(vv.height)}px`);
			// With the keyboard up, Safari scrolls the page to reveal the
			// focused box; the layout already ends above the keyboard, so put
			// the page back. Only while the keyboard is up, so this never
			// fights a normal scroll or a pinch-zoom.
			const keyboardUp = window.innerHeight - vv.height > 120;
			if (keyboardUp && window.scrollY !== 0) window.scrollTo(0, 0);
		};
		sync();
		vv.addEventListener("resize", sync);
		vv.addEventListener("scroll", sync);
		return () => {
			vv.removeEventListener("resize", sync);
			vv.removeEventListener("scroll", sync);
			root.style.removeProperty("--lh-vvh");
		};
	}, [phone]);
	return null;
}
