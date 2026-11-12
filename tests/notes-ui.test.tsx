/**
 * NOTES DRAWER UI PINS — the tree model, the Read view's link rewriting,
 * and the drawer's first-run and Read-view rendering (fetch is scripted;
 * no server).
 */

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { NotesTree, NotesTreeNote } from "../src/core/notes.ts";
import { buildTree, canDropInto, filterTree } from "../components/notes/notes-tree.tsx";
import { readViewMarkdown } from "../components/notes/note-read-view.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { installModalDom } from "./modal-dom.ts";

const dom = parseHTML("<html><body></body></html>");
const storage = new Map<string, string>();
Object.assign(dom.window, {
	innerWidth: 390,
	innerHeight: 844,
	localStorage: {
		getItem: (k: string) => storage.get(k) ?? null,
		setItem: (k: string, v: string) => void storage.set(k, v),
		removeItem: (k: string) => void storage.delete(k),
	},
});
Object.assign(globalThis, { window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element });
// The drawer's dialogs and menus sit on the host's layers (HostDialog,
// MenuShell), which use a few browser APIs linkedom lacks.
const restoreModalDom = installModalDom(dom);
Object.assign(dom.window, { innerWidth: 390, innerHeight: 844 });
const modalStyle = globalThis.getComputedStyle;
const withVars = ((el: Element) => Object.assign(modalStyle(el), { getPropertyValue: () => "" })) as typeof getComputedStyle;
Object.assign(globalThis, { getComputedStyle: withVars, ResizeObserver: class { observe() {} disconnect() {} } });
Object.assign(dom.window, { getComputedStyle: withVars });
after(restoreModalDom);
const originalFetch = globalThis.fetch;
const roots: { root: Root; host: HTMLElement }[] = [];

afterEach(async () => {
	for (const { root, host } of roots.splice(0)) {
		await act(async () => root.unmount());
		host.remove();
	}
	globalThis.fetch = originalFetch;
	storage.clear();
});

const note = (path: string, sessions: string[] = [], extra: Partial<NotesTreeNote> = {}): NotesTreeNote => ({
	path,
	name: path.split("/").pop()!.replace(/\.md$/, ""),
	sessions,
	parent: null,
	words: 10,
	sections: 0,
	mtimeMs: 0,
	...extra,
});

describe("tree model", () => {
	const notes = [
		note("Electricity/Ohm's law.md"),
		note("Electricity/Voltage/Voltage.md"),
		note("Electricity/Voltage/Voltage dividers.md", ["chat_1"]),
		note("Inbox/Capacitors.md", ["chat_1"]),
		note("Loose.md"),
	];

	it("puts the Inbox first, summaries first in their folder, and counts notes below each folder", () => {
		const root = buildTree(["FAR", "Electricity/Voltage"], notes);
		assert.deepEqual(root.folders.map((f) => f.name), ["Inbox", "Electricity", "FAR"]);
		const elec = root.folders[1]!;
		assert.equal(elec.count, 3);
		assert.deepEqual(elec.folders[0]!.notes.map((n) => n.name), ["Voltage", "Voltage dividers"]);
		assert.equal(root.folders[2]!.count, 0);
		assert.deepEqual(root.notes.map((n) => n.name), ["Loose"]);
	});

	it("narrows to this session's notes and the folders leading to them", () => {
		const root = filterTree(buildTree(["FAR"], notes), (n) => n.sessions.includes("chat_1"));
		assert.deepEqual(root.folders.map((f) => f.name), ["Inbox", "Electricity"]);
		assert.equal(root.folders[1]!.folders[0]!.notes[0]!.name, "Voltage dividers");
		assert.deepEqual(root.notes, []);
	});

	it("a drag can end in another folder only: not where the item already is, and a folder never inside itself", () => {
		assert.equal(canDropInto(null, "Electricity"), false);
		// notes
		assert.equal(canDropInto("Electricity/Ohm's law.md", "Electricity"), false);
		assert.equal(canDropInto("Electricity/Ohm's law.md", "Electricity/Voltage"), true);
		assert.equal(canDropInto("Electricity/Ohm's law.md", ""), true);
		assert.equal(canDropInto("Loose.md", ""), false);
		assert.equal(canDropInto("Loose.md", "Inbox"), true);
		// folders
		assert.equal(canDropInto("Electricity", "Electricity"), false);
		assert.equal(canDropInto("Electricity", "Electricity/Voltage"), false);
		assert.equal(canDropInto("Electricity", ""), false);
		assert.equal(canDropInto("Electricity", "Electricity 2"), true);
		assert.equal(canDropInto("Electricity/Voltage", "Electricity"), false);
		assert.equal(canDropInto("Electricity/Voltage", ""), true);
		assert.equal(canDropInto("Electricity/Voltage", "FAR"), true);
	});
});

describe("Read view markdown", () => {
	it("turns wiki links into in-app links and image embeds into vault images, leaving code alone", () => {
		const md = readViewMarkdown("See [[Ohm's law#Rule|the rule]] and ![[Pasted image 1.png]] `[[code]]`", "Electricity/Voltage dividers.md");
		assert.match(md, /\[the rule\]\(<#lhnote:[^>]+>\)/);
		assert.doesNotMatch(md, /\(\s*<#lhnote:[^>]*\(/);
		assert.match(md, /!\[\]\(<\/api\/notes\/asset\?target=Pasted%20image%201\.png&from=Electricity%2FVoltage%20dividers\.md>\)/);
		assert.match(md, /`\[\[code\]\]`/);
	});
});

describe("the editor follows the theme", () => {
	it("CodeMirror's light or dark base follows the theme's mode, and every colour is a theme token", async () => {
		const { EditorState } = await import("@codemirror/state");
		const { EditorView } = await import("@codemirror/view");
		const { editorTheme } = await import("../components/notes/note-editor.tsx");
		assert.equal(EditorState.create({ extensions: editorTheme("dark") }).facet(EditorView.darkTheme), true);
		assert.equal(EditorState.create({ extensions: editorTheme("light") }).facet(EditorView.darkTheme), false);
		const source = (await import("node:fs")).readFileSync(new URL("../components/notes/note-editor.tsx", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
		assert.doesNotMatch(source, /rgba?\(|#[0-9a-fA-F]{3,6}\b|\{ dark: true \},\s*\);/, "no hard-coded colour, no fixed dark flag");
		assert.match(source, /color-mix\(in srgb, var\(--foreground\) 16%, transparent\)/, "the selection: the text colour at 16%, rgba(230,230,230,0.16) on the Default theme");
	});
});

async function mount(node: React.ReactElement) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push({ root, host });
	await act(async () => root.render(<InteractionLayersProvider>{node}</InteractionLayersProvider>));
	return host;
}

function scriptFetch(routes: Record<string, unknown>) {
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = String(input);
		const key = Object.keys(routes).find((k) => url.startsWith(k));
		if (!key) return new Response(JSON.stringify({ error: "not scripted" }), { status: 404 });
		return new Response(JSON.stringify(routes[key]), { status: 200, headers: { "Content-Type": "application/json" } });
	}) as typeof fetch;
}

const status = (over: Partial<NotesTree["status"]> = {}): NotesTree["status"] => ({
	configured: true,
	vaultPath: "C:\\Vault",
	vaultName: "Vault",
	available: true,
	pending: 0,
	attachmentFolder: "LearnHarness/attachments",
	...over,
});

describe("drawer", () => {
	it("asks for the vault folder first", async () => {
		scriptFetch({
			"/api/notes": { status: status({ configured: false, vaultPath: null, vaultName: null, available: false }), folders: [], notes: [], backlinks: {} },
			"/api/chats/": { homeFolder: null },
		});
		const { NotesDrawer } = await import("../components/notes/notes-drawer.tsx");
		const host = await mount(<NotesDrawer chatId="chat_1" onClose={() => {}} />);
		await act(async () => new Promise((r) => setTimeout(r, 20)));
		assert.match(host.textContent ?? "", /Your Obsidian vault/);
		assert.match(host.textContent ?? "", /The tutors can’t read them/);
		assert.match(host.textContent ?? "", /Use this folder/);
	});

	it("shows the tree, the open note in Read view, Linked from and the save line", async () => {
		storage.set("lh:notes-mode", JSON.stringify("read"));
		storage.set("lh:notes-expanded", JSON.stringify(["Electricity"]));
		storage.set("lh:notes-open-note:chat_1", JSON.stringify("Electricity/Ohm's law.md"));
		scriptFetch({
			"/api/notes/file": { path: "Electricity/Ohm's law.md", body: "Intro\n\n## The rule\nV = IR\n", hash: "h1", pending: false, sessions: ["chat_1"], parent: null },
			"/api/notes": {
				status: status(),
				folders: ["Electricity", "Inbox"],
				notes: [note("Electricity/Ohm's law.md", ["chat_1"], { sections: 1 }), note("Electricity/Current.md"), note("Inbox/Idea.md")],
				backlinks: { "Electricity/Ohm's law.md": ["Electricity/Current.md"] },
			},
			"/api/chats/": { homeFolder: "Electricity" },
		});
		const { NotesDrawer } = await import("../components/notes/notes-drawer.tsx");
		const host = await mount(<NotesDrawer chatId="chat_1" onClose={() => {}} />);
		await act(async () => new Promise((r) => setTimeout(r, 30)));
		const text = host.textContent ?? "";
		assert.match(text, /This session/);
		assert.match(text, /All topics/);
		assert.equal(host.querySelectorAll("[data-testid='notes-tree-folder']").length, 2);
		assert.ok(host.querySelector("[aria-label='Edited in this session']"));
		assert.ok(host.querySelector("[data-testid='note-read-view']"));
		assert.match(text, /The rule/);
		assert.match(text, /Linked from/);
		assert.match(text, /Current/);
		assert.match(text, /Saved · LearnHarness\/Electricity\/Ohm's law\.md/);
	});

	it("opened with Ctrl+Shift+N and no note open: the cursor is in the search box; the chip moves nothing", async () => {
		const routes = {
			"/api/notes/file": { path: "Electricity/Ohm's law.md", body: "Intro\n", hash: "h1", pending: false, sessions: ["chat_1"], parent: null },
			"/api/notes": { status: status(), folders: ["Electricity"], notes: [note("Electricity/Ohm's law.md", ["chat_1"])], backlinks: {} },
			"/api/chats/": { homeFolder: null },
		};
		const { NotesDrawer } = await import("../components/notes/notes-drawer.tsx");

		// (With a note open the shortcut switches it to its editor and focuses
		// CodeMirror, which can't mount in this DOM; a browser run covers it.)
		scriptFetch(routes);
		let host: HTMLElement;

		// The chip opens it without touching the view.
		storage.set("lh:notes-mode", JSON.stringify("read"));
		storage.set("lh:notes-open-note:chat_1", JSON.stringify("Electricity/Ohm's law.md"));
		host = await mount(<NotesDrawer chatId="chat_1" onClose={() => {}} />);
		await act(async () => new Promise((r) => setTimeout(r, 120)));
		assert.ok(host.querySelector("[data-testid='note-read-view']"), "opened with the chip: Read view stays");

		// No note open: the search box, which is only there once the list has loaded.
		storage.delete("lh:notes-open-note:chat_1");
		host = await mount(<NotesDrawer chatId="chat_1" onClose={() => {}} landInEditor />);
		await act(async () => new Promise((r) => setTimeout(r, 120)));
		const search = host.querySelector("input[placeholder='Search notes']");
		assert.ok(search, "the search box is on screen");
		assert.equal(document.activeElement, search, "the cursor is in the search box");
	});

	it("rows are dragged by the list itself, not by the browser: each says what it is and how deep it sits", async () => {
		const { host } = await drawerWithNotes();
		const rows = [...host.querySelectorAll("[role='tree'] [role='treeitem']")];
		assert.deepEqual(
			rows.map((r) => [r.getAttribute("data-drag-path"), r.hasAttribute("data-row-folder"), r.getAttribute("data-depth")]),
			[
				["Electricity", true, "0"],
				["Electricity/Current.md", false, "1"],
				["Electricity/Ohm's law.md", false, "1"],
				["Physics", true, "0"],
			],
		);
		// No browser drag and drop, and none of the old drag's pieces.
		assert.equal(host.querySelectorAll("[draggable]").length, 0);
		assert.ok(rows.every((r) => r.hasAttribute("data-phone-press") && r.hasAttribute("data-phone-drag")));
		for (const gone of ["notes-drag-label", "notes-drag-top-level", "notes-tree-root-drop"]) assert.equal(document.querySelector(`[data-testid='${gone}']`), null);
		assert.equal(host.querySelector("[role='tree']")?.hasAttribute("data-dragging"), false);
	});

	// ── Row menus and Delete (owner's wording) ──────────────────────────────
	const menuLabels = () => [...document.querySelectorAll("[role='menu'] [role='menuitem']")].map((b) => b.textContent);
	const menuItem = (label: string) => [...document.querySelectorAll("[role='menu'] [role='menuitem']")].find((b) => b.textContent === label) as HTMLElement;
	const dialogButton = (label: string) => [...document.querySelectorAll("[role='dialog'] button")].find((b) => b.textContent === label) as HTMLElement;
	const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)));
	async function openRowMenu(host: HTMLElement, testid: string, name: string) {
		const row = [...host.querySelectorAll(`[data-testid='${testid}']`)].find((r) => (r.textContent ?? "").includes(name));
		assert.ok(row, `no row named ${name}`);
		const event = new dom.window.Event("contextmenu", { bubbles: true, cancelable: true });
		Object.assign(event, { clientX: 40, clientY: 120 });
		await act(async () => { row.dispatchEvent(event); });
	}
	/** A drawer over a scripted vault: Electricity (the session's home folder,
	 *  open) with two notes, and Physics. Records every POST. */
	async function drawerWithNotes() {
		const posts: Record<string, unknown>[] = [];
		const gone = new Set<string>();
		const all = [note("Electricity/Ohm's law.md", ["chat_1"], { sections: 1 }), note("Electricity/Current.md"), note("Physics/Motion.md")];
		const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } });
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.startsWith("/api/chats/")) return json({ homeFolder: "Electricity" });
			if (url.startsWith("/api/notes") && init?.method === "POST") {
				const body = JSON.parse(String(init.body)) as Record<string, unknown>;
				posts.push(body);
				if (body.action === "contents") return json({ notes: 3, folders: 1, files: 0 });
				if (body.action === "delete") {
					gone.add(String(body.path));
					return json({ path: body.path });
				}
				return new Response(JSON.stringify({ error: "not scripted" }), { status: 404 });
			}
			if (url.startsWith("/api/notes/file")) return new Response(JSON.stringify({ error: "That note no longer exists." }), { status: 404 });
			if (url.startsWith("/api/notes")) {
				const left = (p: string) => ![...gone].some((g) => p === g || p.startsWith(`${g}/`));
				return json({ status: status(), folders: ["Electricity", "Physics"].filter(left), notes: all.filter((x) => left(x.path)), backlinks: {} });
			}
			return new Response(JSON.stringify({ error: "not scripted" }), { status: 404 });
		}) as typeof fetch;
		storage.set("lh:notes-expanded", JSON.stringify(["Electricity"]));
		const { NotesDrawer } = await import("../components/notes/notes-drawer.tsx");
		const host = await mount(<NotesDrawer chatId="chat_1" onClose={() => {}} />);
		await settle();
		return { host, posts };
	}

	it("a folder's menu reads New note, New folder (no \"here\") and ends with Delete", async () => {
		const { host } = await drawerWithNotes();
		await openRowMenu(host, "notes-tree-folder", "Physics");
		assert.deepEqual(menuLabels(), ["New note", "New folder", "Move to…", "Make this the session's home folder", "Delete"]);
		assert.match(menuItem("Delete").className, /text-destructive/);
		assert.doesNotMatch(menuItem("New note").className, /text-destructive/);
		await act(async () => { document.dispatchEvent(new dom.window.Event("mousedown", { bubbles: true })); });
		assert.deepEqual(menuLabels(), []);
		await openRowMenu(host, "notes-tree-folder", "Electricity");
		assert.deepEqual(menuLabels(), ["New note", "New folder", "Move to…", "This session's home folder", "Delete"]);
	});

	it("a note's menu ends with Delete, and Cancel deletes nothing", async () => {
		const { host, posts } = await drawerWithNotes();
		await openRowMenu(host, "notes-tree-note", "Ohm's law");
		assert.deepEqual(menuLabels(), ["Open", "Move to…", "Split note…", "Open in Obsidian", "Delete"]);
		assert.match(menuItem("Delete").className, /text-destructive/);
		await act(async () => { menuItem("Delete").click(); });
		assert.equal(document.querySelector("[data-testid='notes-delete-title']")?.textContent, "Delete “Ohm's law”?");
		assert.equal(document.querySelector("[data-testid='notes-delete-body']")?.textContent, "This removes it from your Obsidian vault for good.");
		assert.match(dialogButton("Delete").className, /bg-destructive/);
		await act(async () => { dialogButton("Cancel").click(); });
		assert.equal(document.querySelector("[role='dialog']"), null);
		assert.deepEqual(posts, []);
		assert.equal(host.querySelectorAll("[data-testid='notes-tree-note']").length, 2);
	});

	it("deleting a note asks first, then removes it and says so", async () => {
		const { host, posts } = await drawerWithNotes();
		await openRowMenu(host, "notes-tree-note", "Current");
		await act(async () => { menuItem("Delete").click(); });
		await act(async () => { dialogButton("Delete").click(); });
		await settle();
		assert.deepEqual(posts, [{ action: "delete", path: "Electricity/Current.md" }]);
		assert.equal(document.querySelector("[role='dialog']"), null);
		assert.deepEqual([...host.querySelectorAll("[data-testid='notes-tree-note']")].map((r) => r.textContent), ["Ohm's law"]);
		assert.match(host.textContent ?? "", /Deleted “Current”\./);
		assert.doesNotMatch(host.textContent ?? "", /Undo/);
		// One message line, in the note half, as before.
		assert.equal(host.querySelectorAll("[data-testid='notes-toast']").length, 1);
		assert.ok(host.querySelector("[data-phone='notes-note'] [data-testid='notes-toast']"));
		// It goes by itself after 5 seconds (owner's ask): the list already shows what happened.
		assert.equal(host.querySelector("[data-testid='notes-toast']")?.getAttribute("data-stays-ms"), "5000");
	});

	it("the message line goes after 5 seconds, or after 20 when it has an Undo button", async () => {
		const { notesMessageMs } = await import("../components/notes/notes-drawer.tsx");
		assert.equal(notesMessageMs({ text: "Moved “Current” to Physics/." }), 5_000);
		assert.equal(notesMessageMs({ text: "Deleted “Current”." }), 5_000);
		// One that says why something didn't happen goes as quickly (owner's choice).
		assert.equal(notesMessageMs({ text: "A note named “Current” is already in that folder." }), 5_000);
		// With Undo: its button is the only way to undo.
		assert.equal(notesMessageMs({ text: "Split into 2 new notes.", opId: "op_1", reopen: "A.md" }), 20_000);
		assert.equal(notesMessageMs({ text: "Merged “Charge” into “Electricity”.", opId: "op_2", reopen: "Charge.md" }), 20_000);
		assert.equal(notesMessageMs({ text: "Moved the selection to “Charge”.", opId: "op_3", reopen: "A.md" }), 20_000);
	});

	it("on a phone the message line also shows on the list screen, which hides the note half", async () => {
		Object.assign(dom.window, { matchMedia: (query: string) => ({ matches: query.includes("max-width"), addEventListener() {}, removeEventListener() {} }) });
		try {
			const { host } = await drawerWithNotes();
			assert.equal(host.querySelector("[data-phone='notes']")?.getAttribute("data-phone-screen"), "list");
			await openRowMenu(host, "notes-tree-note", "Current");
			await act(async () => { menuItem("Delete").click(); });
			await act(async () => { dialogButton("Delete").click(); });
			await settle();
			const inList = host.querySelector("[data-phone='notes-list'] [data-testid='notes-toast']");
			assert.match(inList?.textContent ?? "", /Deleted “Current”\./);
		} finally {
			delete (dom.window as unknown as Record<string, unknown>).matchMedia;
		}
	});

	it("deleting a folder says how much goes with it", async () => {
		const { host, posts } = await drawerWithNotes();
		await openRowMenu(host, "notes-tree-folder", "Electricity");
		await act(async () => { menuItem("Delete").click(); });
		await settle();
		assert.deepEqual(posts, [{ action: "contents", path: "Electricity" }]);
		assert.equal(document.querySelector("[data-testid='notes-delete-title']")?.textContent, "Delete “Electricity” and everything in it?");
		assert.equal(document.querySelector("[data-testid='notes-delete-body']")?.textContent, "This removes 3 notes and 1 folder from your Obsidian vault for good.");
		await act(async () => { dialogButton("Delete").click(); });
		await settle();
		assert.deepEqual(posts[1], { action: "delete", path: "Electricity" });
		assert.deepEqual([...host.querySelectorAll("[data-testid='notes-tree-folder']")].map((r) => r.textContent?.replace(/\d+$/, "")), ["Physics"]);
		assert.match(host.textContent ?? "", /Deleted “Electricity”\./);
	});

	// ── The host's layers (HostDialog, MenuShell; upstream 0.6.0) ──────────
	const escape = async () => {
		const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(event, { key: "Escape" });
		await act(async () => { document.dispatchEvent(event); });
		return event;
	};

	it("the row menu is a host menu: at the pointer, and Esc closes it and goes no further", async () => {
		const { host } = await drawerWithNotes();
		await openRowMenu(host, "notes-tree-note", "Current");
		const menu = document.querySelector<HTMLElement>("[data-testid='notes-row-menu']");
		assert.ok(menu?.hasAttribute("data-lh-menu"), "MenuShell's menu");
		assert.equal(menu?.style.left, "40px");
		assert.equal(menu?.style.top, "120px", "its top edge on the pointer, as before");
		const event = await escape();
		assert.deepEqual(menuLabels(), []);
		assert.equal(event.defaultPrevented, true, "the menu took the Esc");
	});

	it("a dialog is a host dialog: one layer, named, and Esc closes it without deleting", async () => {
		const { host, posts } = await drawerWithNotes();
		await openRowMenu(host, "notes-tree-note", "Current");
		await act(async () => { menuItem("Delete").click(); });
		const dialog = document.querySelector<HTMLElement>("[role='dialog']");
		assert.ok(dialog?.hasAttribute("data-interaction-layer"));
		assert.equal(dialog?.getAttribute("aria-label"), "Delete “Current”?");
		assert.equal(document.querySelectorAll("[role='dialog']").length, 1);
		const event = await escape();
		assert.equal(event.defaultPrevented, true);
		assert.equal(document.querySelector("[role='dialog']"), null);
		assert.deepEqual(posts, []);
	});

	it("the open note's ⋯ menu is a host menu under its button", async () => {
		storage.set("lh:notes-mode", JSON.stringify("read"));
		storage.set("lh:notes-open-note:chat_1", JSON.stringify("Electricity/Ohm's law.md"));
		scriptFetch({
			"/api/notes/file": { path: "Electricity/Ohm's law.md", body: "Intro\n\n## The rule\nV = IR\n", hash: "h1", pending: false, sessions: ["chat_1"], parent: null },
			"/api/notes": { status: status(), folders: ["Electricity"], notes: [note("Electricity/Ohm's law.md", ["chat_1"], { sections: 1 })], backlinks: {} },
			"/api/chats/": { homeFolder: "Electricity" },
		});
		const { NotesDrawer } = await import("../components/notes/notes-drawer.tsx");
		const host = await mount(<NotesDrawer chatId="chat_1" onClose={() => {}} />);
		await settle();
		const button = host.querySelector<HTMLElement>("[aria-label='Note actions']")!;
		button.getBoundingClientRect = () => ({ left: 300, right: 330, top: 50, bottom: 70, width: 30, height: 20, x: 300, y: 50, toJSON() {} });
		await act(async () => { button.click(); });
		const menu = document.querySelector<HTMLElement>("[data-testid='notes-note-menu']");
		assert.ok(menu?.hasAttribute("data-lh-menu"));
		assert.equal(menu?.style.left, "130px", "200 px left of the button's right edge, as before");
		assert.equal(menu?.style.top, "74px");
		assert.deepEqual([...document.querySelectorAll("[data-testid='notes-note-menu'] [role='menu'] [role='menuitem']")].map((b) => b.textContent), ["Move to…", "Split note…", "Open in Obsidian"]);
		await escape();
		assert.equal(document.querySelector("[data-testid='notes-note-menu']"), null);
	});

	it("tells the learner when the vault is offline and how many notes are waiting", async () => {
		scriptFetch({
			"/api/notes": { status: status({ available: false, pending: 2 }), folders: [], notes: [], backlinks: {} },
			"/api/chats/": { homeFolder: null },
		});
		const { NotesDrawer } = await import("../components/notes/notes-drawer.tsx");
		const host = await mount(<NotesDrawer chatId="chat_1" onClose={() => {}} />);
		await act(async () => new Promise((r) => setTimeout(r, 20)));
		assert.match(host.textContent ?? "", /can’t be reached right now/);
		assert.match(host.textContent ?? "", /2 notes waiting/);
	});
});
