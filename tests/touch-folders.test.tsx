/**
 * PRESS AND HOLD ON A SESSION FOLDER (fork; owner's decision at the upstream
 * v0.7.0 merge). Upstream's sidebar folders (components/sidebar-folders.tsx)
 * were mouse-only. A held touch (about half a second) now opens the folder's
 * menu (Rename / New subfolder / Delete) on every touch screen in a browser,
 * as it does on a session row; the lifted finger neither toggles the folder
 * nor starts a rename; and the sidebar rows' mouse drag is off there, so the
 * browser's own drag can't compete with the hold. A computer, and the desktop
 * app even on a touch-screen PC, keep upstream's drag.
 *
 * The real folder row, session row, drag wrapper and hold listener run in a
 * DOM with scripted pointer events. The sidebar itself needs a router, the
 * settings dialog and a server, so its wiring (drag off on touch, the menu's
 * entries and shell) is pinned at source level.
 */

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { parseHTML } from "linkedom";

const dom = parseHTML(`<!doctype html><html><body><aside id="drawer"><div id="root"></div></aside></body></html>`);
const { document } = dom;
/** "computer": nothing matches; "phone": narrow; "tablet": wide with a touch screen. */
let layout: "computer" | "phone" | "tablet" = "phone";
class FakeMouseEvent extends dom.window.Event {
	clientX: number; clientY: number; button: number;
	constructor(type: string, init: { bubbles?: boolean; cancelable?: boolean; clientX?: number; clientY?: number; button?: number } = {}) {
		super(type, init);
		this.clientX = init.clientX ?? 0; this.clientY = init.clientY ?? 0; this.button = init.button ?? 0;
	}
}
Object.assign(dom.window, {
	matchMedia: (query: string) => ({
		matches: layout === "phone" ? query.includes("max-width") : layout === "tablet" ? query.includes("any-pointer: coarse") : false,
		addEventListener() {}, removeEventListener() {},
	}),
});
Object.assign(globalThis, {
	window: dom.window, document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
	CustomEvent: dom.window.CustomEvent, MouseEvent: FakeMouseEvent,
});

const { createRoot } = await import("react-dom/client");
const { HOLD_MS, installLongPress } = await import("../components/phone/long-press.ts");
const { isTouchScreenNow } = await import("../components/phone/use-phone.ts");
const { SidebarFolderRow } = await import("../components/sidebar-folders.tsx");
const { SessionRow } = await import("../components/sidebar.tsx");
const { SourceDragRow } = await import("../components/source-folder-tree.tsx");

const folder = { id: "f1", name: "Physics", parentId: null, createdAt: "2026-10-01T00:00:00.000Z" };
const chat = { id: "c1", title: "Ohm's law", updatedAt: new Date().toISOString(), busy: false } as never;

let calls: string[] = [];
let uninstall = () => {};
let root: ReturnType<typeof createRoot> | null = null;
let draggableFolder = true;
const menus = () => calls.filter((c) => c.endsWith("menu"));

/** The sidebar's rows as it wires them: both inside a drag wrapper, both
 *  opening a menu on a contextmenu event. */
function Rows() {
	return (
		<>
			<SidebarFolderRow folder={folder} depth={0} open={false} dropActive={false} renaming={false} draggable={draggableFolder}
				onToggle={() => calls.push("toggle")} onContextMenu={(e) => { e.preventDefault(); calls.push("folder-menu"); }}
				onRename={async () => {}} onRenameDone={() => calls.push("rename-done")} />
			<SourceDragRow kind="source" id="c1" name="Ohm's law" enabled={draggableFolder}>
				<SessionRow chat={chat} active={false} onOpen={() => calls.push("open")} onContextMenu={(e) => { e.preventDefault(); calls.push("session-menu"); }} />
			</SourceDragRow>
		</>
	);
}

const folderButton = () => document.querySelector<HTMLElement>('[data-testid="sidebar-folder-f1"]')!;
const sessionButton = () => document.querySelector<HTMLElement>('[data-testid="session-row"]')!;
function pointer(type: string, target: Element, over: Record<string, unknown> = {}) {
	const e = new dom.window.Event(type, { bubbles: true, cancelable: true });
	Object.assign(e, { pointerType: "touch", isPrimary: true, pointerId: 1, clientX: 40, clientY: 60, ...over });
	target.dispatchEvent(e);
	return e;
}
function plain(type: string, target: Element) {
	const e = new dom.window.Event(type, { bubbles: true, cancelable: true });
	target.dispatchEvent(e);
	return e;
}
/** A click; resolves to whether the hold listener cancelled it. NOTE: linkedom
 *  runs a capture listener after the bubbling ones, so a click that the
 *  listener stops (stopPropagation, in a real browser) still reaches React's
 *  onClick here. What these tests can see is that the listener claimed the click
 *  (defaultPrevented); that it is claimed in the capture phase, before React,
 *  is the browser's order and is pinned at source level below. */
async function click(target: Element): Promise<boolean> {
	let prevented = false;
	await act(async () => { prevented = target.dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true })) === false; });
	return prevented;
}
/** A finger held on `target` until the hold fires, then lifted. Real timers
 *  are put back before React is asked to do anything else. */
async function holdAndLift(target: Element, over: Record<string, unknown> = {}) {
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		pointer("pointerdown", target, over);
		mock.timers.tick(HOLD_MS);
	} finally {
		mock.timers.reset();
	}
	pointer("pointerup", target, over);
	const touchEnd = plain("touchend", target);
	const clickCancelled = await click(target); // browsers that send the tap anyway
	return { touchEndPrevented: touchEnd.defaultPrevented, clickCancelled };
}

async function mount() {
	root = createRoot(document.getElementById("root")!);
	await act(async () => root!.render(<Rows />));
}

beforeEach(() => {
	layout = "phone";
	calls = [];
	draggableFolder = true;
	uninstall = installLongPress(document as unknown as Document);
});
afterEach(async () => {
	uninstall();
	mock.timers.reset();
	if (root) await act(async () => root!.unmount());
	root = null;
});

describe("press and hold on a folder row", () => {
	it("opens the folder's menu where the session's does, and the lifted finger toggles nothing", async () => {
		await mount();
		assert.equal(folderButton().hasAttribute("data-phone-press"), true);
		const { touchEndPrevented, clickCancelled } = await holdAndLift(folderButton());
		assert.deepEqual(menus(), ["folder-menu"], "the menu opened once");
		assert.equal(calls.includes("rename-done"), false, "no rename started or ended");
		assert.equal(touchEndPrevented, true, "the lift's tap is cancelled");
		assert.equal(clickCancelled, true, "and so is a click the browser sends anyway, so the folder isn't toggled");
		// The second click is an ordinary one again.
		assert.equal(await click(folderButton()), false);
	});

	it("a plain tap still opens and closes the folder", async () => {
		await mount();
		pointer("pointerdown", folderButton());
		pointer("pointerup", folderButton());
		await click(folderButton());
		assert.deepEqual(calls, ["toggle"]);
	});

	it("a finger that moves before the half second is a scroll: no menu", async () => {
		await mount();
		mock.timers.enable({ apis: ["setTimeout"] });
		try {
			pointer("pointerdown", folderButton());
			pointer("pointermove", folderButton(), { clientY: 100 });
			mock.timers.tick(HOLD_MS * 2);
		} finally { mock.timers.reset(); }
		assert.deepEqual(calls, []);
	});

	it("a session row still works the same way", async () => {
		await mount();
		const { clickCancelled } = await holdAndLift(sessionButton());
		assert.deepEqual(menus(), ["session-menu"]);
		assert.equal(clickCancelled, true);
	});

	it("the menu event reaches the drawer, so a swipe in progress springs back (sidebar-swipe.ts listens there)", async () => {
		await mount();
		let atDrawer = 0;
		const drawer = document.getElementById("drawer")!;
		drawer.addEventListener("contextmenu", () => { atDrawer++; });
		await holdAndLift(folderButton());
		assert.equal(atDrawer, 1);
	});

	it("works on a tablet in a browser too", async () => {
		layout = "tablet";
		await mount();
		await holdAndLift(folderButton());
		assert.deepEqual(menus(), ["folder-menu"]);
	});

	it("never in the desktop app, also on a PC with a touch screen", async () => {
		layout = "tablet";
		await mount();
		const real = Object.getOwnPropertyDescriptor(globalThis, "navigator");
		Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/140.0.0.0 Electron/38.0.0 Safari/537.36" } });
		try {
			await holdAndLift(folderButton());
			assert.deepEqual(menus(), []);
		} finally {
			if (real) Object.defineProperty(globalThis, "navigator", real); else delete (globalThis as Record<string, unknown>).navigator;
		}
	});

	it("a mouse is not a hold", async () => {
		layout = "computer";
		await mount();
		mock.timers.enable({ apis: ["setTimeout"] });
		try {
			pointer("pointerdown", folderButton(), { pointerType: "mouse" });
			mock.timers.tick(HOLD_MS * 2);
		} finally { mock.timers.reset(); }
		assert.deepEqual(calls, []);
	});
});

describe("the mouse drag", () => {
	it("which layouts count as a touch screen: the phone layout, a tablet in a browser; not a computer, not the desktop app", () => {
		layout = "computer";
		assert.equal(isTouchScreenNow(), false);
		layout = "phone";
		assert.equal(isTouchScreenNow(), true);
		layout = "tablet";
		assert.equal(isTouchScreenNow(), true);
		const real = Object.getOwnPropertyDescriptor(globalThis, "navigator");
		Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "Electron/38.0.0" } });
		try {
			assert.equal(isTouchScreenNow(), false, "a touch-screen PC running the desktop app keeps upstream's drag");
		} finally {
			if (real) Object.defineProperty(globalThis, "navigator", real); else delete (globalThis as Record<string, unknown>).navigator;
		}
	});

	it("the rows' wrapper is draggable exactly when the sidebar says so", async () => {
		await mount();
		const draggable = () => [...document.querySelectorAll("[data-source-drag-row]")].map((el) => el.getAttribute("draggable"));
		assert.deepEqual(draggable(), ["true", "true"]);
		draggableFolder = false;
		await act(async () => root!.render(<Rows />));
		assert.deepEqual(draggable(), ["false", "false"]);
	});

	it("the sidebar turns the drag off for the session rows and the folder rows on a touch screen only, and the chains view is untouched", () => {
		const sidebar = readFileSync(new URL("../components/sidebar.tsx", import.meta.url), "utf8");
		assert.match(sidebar, /const touchScreen = useIsTouchScreen\(\);/);
		assert.match(sidebar, /kind="source" id=\{c\.id\} name=\{c\.title\} enabled=\{Boolean\(organization\) && renamingId !== c\.id && !touchScreen/);
		assert.match(sidebar, /draggable=\{Boolean\(organization\) && !touchScreen/);
		// Every other use of the drag wrapper outside the sidebar is as upstream wrote it.
		const chains = readFileSync(new URL("../components/source-folder-tree.tsx", import.meta.url), "utf8");
		assert.doesNotMatch(chains, /useIsTouchScreen|touchScreen/);
	});
});

describe("the folder's menu", () => {
	const sidebar = readFileSync(new URL("../components/sidebar.tsx", import.meta.url), "utf8");
	const at = sidebar.lastIndexOf('testid="folder-context-menu"');
	const menu = sidebar.slice(at - 200, at + 3000);

	it("is opened by the folder row's contextmenu handler, with Rename, New subfolder and Delete", () => {
		assert.match(sidebar, /onContextMenu=\{\(e\) => openFolderContext\(e, folder\.id\)\}/);
		assert.match(menu, /data-testid="folder-ctx-rename"[\s\S]*?Rename/);
		assert.match(menu, /data-testid="folder-ctx-new-subfolder"[\s\S]*?New subfolder/);
		assert.match(menu, /Delete/);
	});

	it("sits in the same menu shell as the session menu, which slides back inside a phone's screen", () => {
		assert.match(menu, /<MenuShell/);
		const sessionAt = sidebar.lastIndexOf('testid="session-context-menu"');
		const session = sidebar.slice(sessionAt - 200, sessionAt + 200);
		assert.match(session, /<MenuShell/);
		const shell = readFileSync(new URL("../components/menu-shell.tsx", import.meta.url), "utf8");
		assert.match(shell, /clampMenuToScreen\(p, menu\.offsetWidth, window\.innerWidth\)/);
	});

	it("the swipe to close the drawer listens for the menu event, not for particular rows", () => {
		const swipe = readFileSync(new URL("../components/phone/sidebar-swipe.ts", import.meta.url), "utf8");
		assert.match(swipe, /drawer\.addEventListener\("contextmenu", onContextMenu\)/);
		assert.doesNotMatch(swipe, /data-phone-press/);
	});

	it("the hold listener claims the lifted finger's click in the capture phase, ahead of the row's own onClick", () => {
		const press = readFileSync(new URL("../components/phone/long-press.ts", import.meta.url), "utf8");
		assert.match(press, /doc\.addEventListener\("click", onClick, opts\)/);
		assert.match(press, /const opts = \{ capture: true \} as const;/);
	});

	it("row text can't be selected while holding: the fork's rule covers any data-phone-press row", () => {
		const touch = readFileSync(new URL("../app/touch.css", import.meta.url), "utf8");
		assert.match(touch, /\[data-phone-press\] \{\s*-webkit-user-select: none;\s*user-select: none;\s*-webkit-touch-callout: none;/);
	});
});
