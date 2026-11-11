"use client";

/**
 * The phone layout's page-wide pieces (cloud sync Phase 3), mounted once in
 * the root layout: the keyboard-aware height, press-and-hold menus and the window lock. All
 * do nothing outside the phone layout.
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
