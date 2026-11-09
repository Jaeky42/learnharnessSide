/**
 * NOTES DRAWER UI PINS — the tree model, the Read view's link rewriting,
 * and the drawer's first-run and Read-view rendering (fetch is scripted;
 * no server).
 */

import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { NotesTree, NotesTreeNote } from "../src/core/notes.ts";
import { buildTree, filterTree } from "../components/notes/notes-tree.tsx";
import { readViewMarkdown } from "../components/notes/note-read-view.tsx";

const dom = parseHTML("<html><body></body></html>");
const storage = new Map<string, string>();
Object.assign(dom.window, {
	localStorage: {
		getItem: (k: string) => storage.get(k) ?? null,
		setItem: (k: string, v: string) => void storage.set(k, v),
		removeItem: (k: string) => void storage.delete(k),
	},
});
Object.assign(globalThis, { window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent });
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

async function mount(node: React.ReactElement) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push({ root, host });
	await act(async () => root.render(node));
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
