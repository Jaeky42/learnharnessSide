"use client";

/**
 * The phone layout's page-wide pieces (cloud sync Phase 3), mounted once in
 * the root layout: the keyboard-aware height, press-and-hold menus and the window lock. The
 * keyboard-aware height does nothing outside the phone layout; press and hold
 * and the window lock hold on every touch screen in a browser (a tablet with
 * the computer layout too), and never in the desktop app.
 */

import { useEffect } from "react";
import { installLongPress } from "@/components/phone/long-press";
import { PhoneViewport } from "@/components/phone/phone-viewport";
import { installWindowLock } from "@/components/phone/window-lock";

export function PhoneRuntime() {
	useEffect(() => installLongPress(), []);
	useEffect(() => installWindowLock(), []);
	return <PhoneViewport />;
}
