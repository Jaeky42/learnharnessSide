/**
 * TEMPORARY: a readout of what the iPhone tells the page about its keyboard
 * (owner's iPhone: the first build of the keyboard-up marker never came on
 * there, and a stand-in keyboard in Chromium can't show why). To be removed
 * once the phone has answered.
 *
 * Off until asked for, and only in the phone layout (PhoneViewport calls it):
 *   - type the word  kbdebug  into any text box (the home-screen app has no
 *     address bar), or open a page with ?kbdebug in its address;
 *   - type  kbdebug off  to hide it. It is remembered for the tab's session.
 * It shows numbers only: sizes and switches, nothing typed and nothing stored
 * beyond its own on/off.
 */

const KEY = "lh:kbdebug";
let on: boolean | null = null;
let box: HTMLPreElement | null = null;

/** Pure rule, exported for tests: what a text box's whole text asks for:
 *  true (show), false (hide), or null (nothing). */
export function keyboardDebugWord(text: string): boolean | null {
	const word = text.trim().toLowerCase();
	if (word === "kbdebug") return true;
	if (word === "kbdebug off") return false;
	return null;
}

export function keyboardDebugOn(): boolean {
	if (on === null) {
		try {
			on = window.sessionStorage.getItem(KEY) === "1" || /[?&#]kbdebug\b/.test(window.location.search + window.location.hash);
		} catch {
			on = false;
		}
	}
	return on;
}

/** Reads the focused box; true when the readout was just switched on or off. */
export function noteKeyboardDebugWord(active: Element | null): boolean {
	if (!active) return false;
	const text = "value" in active && typeof (active as HTMLInputElement).value === "string" ? (active as HTMLInputElement).value : (active.textContent ?? "");
	if (text.length > 24) return false;
	const asked = keyboardDebugWord(text);
	if (asked === null || asked === keyboardDebugOn()) return false;
	on = asked;
	try {
		if (asked) window.sessionStorage.setItem(KEY, "1");
		else window.sessionStorage.removeItem(KEY);
	} catch {
		// Storage refused: the readout still shows until the page is left.
	}
	if (!asked) hideKeyboardDebug();
	return true;
}

export function hideKeyboardDebug(): void {
	box?.remove();
	box = null;
}

export function showKeyboardDebug(values: Record<string, string | number | boolean>): void {
	if (!box) {
		box = document.createElement("pre");
		box.setAttribute("aria-hidden", "true");
		box.dataset.lhKbdebug = "";
		box.style.cssText = "position:fixed;left:6px;top:calc(env(safe-area-inset-top,0px) + 96px);z-index:2147483647;margin:0;padding:6px 8px;max-width:calc(100vw - 12px);border-radius:8px;background:rgba(0,0,0,.86);color:#7dffa0;font:11px/1.35 ui-monospace,Menlo,monospace;white-space:pre-wrap;pointer-events:none";
		document.body.appendChild(box);
	}
	const probe = (inset: string) => {
		const el = document.createElement("div");
		el.style.cssText = `position:fixed;visibility:hidden;pointer-events:none;height:env(${inset},0px)`;
		document.body.appendChild(el);
		const h = el.getBoundingClientRect().height;
		el.remove();
		return Math.round(h);
	};
	const dock = document.querySelector<HTMLElement>('[data-phone="dock"]');
	const rect = dock?.getBoundingClientRect();
	const more: Record<string, string | number | boolean> = {
		...values,
		safe: `top ${probe("safe-area-inset-top")} bottom ${probe("safe-area-inset-bottom")}`,
		vvh: document.documentElement.style.getPropertyValue("--lh-vvh"),
		dock: dock && rect ? `${Math.round(rect.top)}-${Math.round(rect.bottom)} pad ${getComputedStyle(dock).paddingBottom}` : "none",
		body: `${Math.round(document.body.getBoundingClientRect().top)}-${Math.round(document.body.getBoundingClientRect().bottom)}`,
	};
	box.textContent = Object.entries(more).map(([k, v]) => `${k}: ${v}`).join("\n");
}
