"use client";

/**
 * The phone layout's page-wide pieces (cloud sync Phase 3), mounted once in
 * the root layout: the keyboard-aware height and press-and-hold menus. Both
 * do nothing outside the phone layout.
 */

import { useEffect } from "react";
import { installLongPress } from "@/components/phone/long-press";
import { PhoneViewport } from "@/components/phone/phone-viewport";

export function PhoneRuntime() {
	useEffect(() => installLongPress(), []);
	return <PhoneViewport />;
}
