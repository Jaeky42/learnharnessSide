"use client";

/**
 * The phone layout's page-wide pieces (cloud sync Phase 3), mounted once in
 * the root layout: the keyboard-aware height, press-and-hold menus and the window lock. The
 * keyboard-aware height does nothing outside the phone layout; press and hold
 * and the window lock hold on every touch screen in a browser (a tablet with
 * the computer layout too), and never in the desktop app. So does the Drawing
 * Pad's palm rejection (pad-palm.ts, owner's iPad).
 */

import { useEffect } from "react";
import { installLongPress } from "@/components/phone/long-press";
import { PhoneViewport } from "@/components/phone/phone-viewport";
import { installWindowLock } from "@/components/phone/window-lock";
import { installPadPalm } from "@/components/phone/pad-palm";

export function PhoneRuntime() {
	useEffect(() => installLongPress(), []);
	useEffect(() => installWindowLock(), []);
	useEffect(() => installPadPalm(), []);
	return <PhoneViewport />;
}
