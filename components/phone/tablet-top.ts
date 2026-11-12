/**
 * The tablet home-screen app's top inset (owner's iPad): how far app/tablet.css
 * moves the top edges down to clear iOS's clock and blur, in px. 0 everywhere
 * else: a Safari tab, a computer, the phone layout (its own --lh-safe-top) and
 * the desktop app. Read from a hidden probe whose height is the CSS value, so
 * the CSS stays the one place the amount is decided.
 */

let probe: HTMLDivElement | null = null;

export function tabletTopInset(): number {
	if (typeof document === "undefined" || !document.body) return 0;
	if (!probe || !probe.isConnected) {
		probe = document.createElement("div");
		probe.setAttribute("aria-hidden", "true");
		probe.style.cssText = "position:fixed;top:0;left:0;width:0;height:var(--lh-tablet-top,0px);visibility:hidden;pointer-events:none";
		document.body.appendChild(probe);
	}
	const height = probe.getBoundingClientRect().height;
	return Number.isFinite(height) && height > 0 ? height : 0;
}
