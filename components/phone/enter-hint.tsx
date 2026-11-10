"use client";

import { useIsTouchPhone } from "@/components/phone/use-phone";

/** The keyboard hint under an answer box. Hidden on a touch phone, where
 *  Enter makes a new line and the button sends (see enter-key.ts). */
export function EnterHint() {
	const touchPhone = useIsTouchPhone();
	return touchPhone ? null : <>↵ submits · ⇧↵ newline</>;
}
