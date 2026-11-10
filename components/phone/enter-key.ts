/**
 * THE ENTER KEY ON A PHONE (cloud sync Phase 3, owner decision): an on-screen
 * keyboard has no Shift+Enter, so on a touch phone Enter makes a new line
 * and the button sends. Desktop is unchanged: Enter sends, Shift+Enter is a
 * new line, and ⌘/Ctrl+Enter always sends.
 *
 * Every box that sends on Enter asks here, so the rule lives in one place.
 */

import { isTouchPhoneNow } from "@/components/phone/use-phone";

type EnterEvent = { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean };

/** Pure rule, exported for tests. */
export function enterSendsRule(e: EnterEvent, touchPhone: boolean): boolean {
	if (e.key !== "Enter") return false;
	if (e.metaKey || e.ctrlKey) return true;
	if (touchPhone) return false;
	return !e.shiftKey;
}

/** Does this keypress send (true) or belong to the box as a new line (false)? */
export function enterSends(e: EnterEvent): boolean {
	return enterSendsRule(e, isTouchPhoneNow());
}

/** For boxes with their own modifier rules: may a plain Enter send at all? */
export function plainEnterSends(): boolean {
	return !isTouchPhoneNow();
}
