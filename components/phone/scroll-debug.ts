"use client";

/**
 * TEMPORARY scroll readout (cloud sync Phase 3, owner's ask): an on-screen
 * strip that lists what the phone scrolling just did, so a pull-back into
 * an opened question that only happens on the owner's iPhone can be read
 * off a screenshot. Remove this file and its `dlog` / `watchScrollDebug`
 * calls once the pull-back is fixed (grep for "scroll-debug").
 *
 * On with `?scrolldebug=1` in the address, off with `?scrolldebug=0`; the
 * choice is remembered in this browser. Off, every call is a cheap no-op.
 * The strip is plain DOM (no React), ignores taps, and shows the newest 12
 * lines: time (seconds.milliseconds), what happened, and the lesson's
 * distance from the bottom (d) at that moment.
 */

const KEY = "lh:scroll-debug";
const MAX_LINES = 12;

let on: boolean | null = null;
let transcript: HTMLElement | null = null;
let box: HTMLDivElement | null = null;
const lines: string[] = [];

export function scrollDebugOn(): boolean {
	if (on !== null) return on;
	on = false;
	if (typeof window === "undefined") return on;
	try {
		const param = new URLSearchParams(window.location.search).get("scrolldebug");
		if (param === "1") window.localStorage.setItem(KEY, "1");
		if (param === "0") window.localStorage.removeItem(KEY);
		on = window.localStorage.getItem(KEY) === "1";
	} catch {
		on = false;
	}
	return on;
}

/** Pure, exported for tests: one readout line. */
export function debugLine(nowMs: number, what: string, d: number | null): string {
	const t = ((nowMs / 1000) % 100).toFixed(3).padStart(6, "0");
	return `${t} ${what}${d === null ? "" : `  d=${Math.round(d)}`}`;
}

function distance(): number | null {
	const el = transcript;
	return el ? el.scrollHeight - el.clientHeight - el.scrollTop : null;
}

function render() {
	if (!box) {
		box = document.createElement("div");
		box.setAttribute("data-scroll-debug", "");
		box.style.cssText =
			"position:fixed;left:4px;right:4px;top:calc(env(safe-area-inset-top,0px) + 64px);z-index:2147483647;pointer-events:none;" +
			"font:10px/1.35 ui-monospace,Menlo,monospace;color:#d4f7d4;background:rgb(0 0 0/.72);border-radius:6px;padding:4px 6px;white-space:pre;overflow:hidden";
		document.body.appendChild(box);
	}
	box.textContent = lines.join("\n");
}

/** Log one event (no-op unless the readout is on). */
export function dlog(what: string) {
	if (!scrollDebugOn()) return;
	lines.push(debugLine(performance.now(), what, distance()));
	if (lines.length > MAX_LINES) lines.shift();
	render();
}

/**
 * Watch the transcript (for d) and the stick-to-bottom library's state: logs
 * when its slide to the bottom starts and ends, when it changes its mind
 * about being at the bottom, and when the lesson's content grows or shrinks.
 * Returns a cleanup; does nothing unless the readout is on.
 */
export function watchScrollDebug(el: HTMLElement, state: { animation?: unknown; isAtBottom: boolean; escapedFromLock: boolean }): () => void {
	if (!scrollDebugOn()) return () => {};
	transcript = el;
	dlog("readout on");
	let sliding = !!state.animation;
	let atBottom = state.isAtBottom;
	let escaped = state.escapedFromLock;
	let frame = 0;
	const tick = () => {
		const s = !!state.animation;
		if (s !== sliding) dlog(s ? "SLIDE to bottom started" : "slide ended");
		if (state.isAtBottom !== atBottom) dlog(`library: at bottom = ${state.isAtBottom}`);
		if (state.escapedFromLock !== escaped) dlog(`library: left the bottom = ${state.escapedFromLock}`);
		sliding = s;
		atBottom = state.isAtBottom;
		escaped = state.escapedFromLock;
		frame = requestAnimationFrame(tick);
	};
	frame = requestAnimationFrame(tick);
	const content = el.firstElementChild;
	let height = content?.getBoundingClientRect().height ?? 0;
	const ro = new ResizeObserver(() => {
		const h = content?.getBoundingClientRect().height ?? 0;
		if (Math.abs(h - height) >= 1) dlog(`content ${h > height ? "grew" : "shrank"} ${Math.round(Math.abs(h - height))}px`);
		height = h;
	});
	if (content) ro.observe(content);
	return () => {
		cancelAnimationFrame(frame);
		ro.disconnect();
		if (transcript === el) transcript = null;
	};
}
