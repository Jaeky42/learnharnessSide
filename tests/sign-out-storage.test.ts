/**
 * Multi-account slice 5d: what holds a person's content in the browser goes
 * at sign-out (behind the gateway only); view state stays. Also pins the
 * audit: a new file that touches the browser's storage fails here until
 * someone has decided whether it holds content.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

class MemoryStorage {
	private readonly map = new Map<string, string>();
	get length() { return this.map.size; }
	key(i: number) { return [...this.map.keys()][i] ?? null; }
	getItem(k: string) { return this.map.get(k) ?? null; }
	setItem(k: string, v: string) { this.map.set(k, String(v)); }
	removeItem(k: string) { this.map.delete(k); }
	clear() { this.map.clear(); }
	keys() { return [...this.map.keys()].sort(); }
}

const local = new MemoryStorage();
const session = new MemoryStorage();
Object.assign(globalThis, { window: { localStorage: local, sessionStorage: session } });
const { CONTENT_KEYS, CONTENT_PREFIXES, clearAccountContent } = await import("../components/settings/sign-out-storage.ts");

const VIEW_LOCAL = [
	"lh:notes-open", "lh:notes-view", "lh:notes-tree-open", "lh:notes-tree-height", "lh:notes-width", "lh:notes-mode",
	"lh:side-tutor:pos", "lh:side-tutor:size", "lh:sidebar-open", "lh:session-kind-filter", "lh.graph.camera.v1", "lh:keymap",
	"some-other-site-key", "lh:notes-opened-later",
];
const CONTENT_LOCAL = ["lh:notes-expanded", "lh:notes-split-dismissed", "lh:notes-open-note:chat_1", "lh:notes-open-note:chat_abc"];

beforeEach(() => { local.clear(); session.clear(); });
afterEach(() => { Object.assign(globalThis, { window: { localStorage: local, sessionStorage: session } }); });

describe("clearAccountContent", () => {
	it("removes the keys that hold a person's words, and leaves window and view state alone", () => {
		for (const key of [...VIEW_LOCAL, ...CONTENT_LOCAL]) local.setItem(key, "x");
		session.setItem("lh.openingPrompt.chat_1", JSON.stringify({ text: "my unsent first message", attempted: false }));
		session.setItem("lh.openingPrompt.chat_2", "old raw stash");
		session.setItem("lh:kbdebug", "1");
		clearAccountContent();
		assert.deepEqual(local.keys(), [...VIEW_LOCAL].sort());
		assert.deepEqual(session.keys(), ["lh:kbdebug"]);
	});

	it("works on empty storage and survives storage that throws", () => {
		clearAccountContent();
		const broken = { get length(): number { throw new Error("blocked"); }, key() { return null; }, removeItem() { throw new Error("blocked"); } };
		Object.assign(globalThis, { window: { localStorage: broken, sessionStorage: session } });
		session.setItem("lh.openingPrompt.chat_1", "x");
		assert.doesNotThrow(clearAccountContent);
		assert.deepEqual(session.keys(), [], "the other storage is still cleared");
		Object.defineProperty(globalThis, "window", { configurable: true, value: { get localStorage(): Storage { throw new Error("denied"); }, sessionStorage: session } });
		assert.doesNotThrow(clearAccountContent);
	});

	it("lists exactly what the audit decided", () => {
		assert.deepEqual([...CONTENT_KEYS].sort(), ["lh:notes-expanded", "lh:notes-split-dismissed"]);
		assert.deepEqual([...CONTENT_PREFIXES].sort(), ["lh.openingPrompt.", "lh:notes-open-note:"]);
	});
});

describe("the audit: who touches the browser's storage", () => {
	const root = path.join(import.meta.dirname, "..");
	const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		if (e.name === "node_modules" || e.name === ".next" || e.name === "dist") return [];
		const full = path.join(dir, e.name);
		return e.isDirectory() ? walk(full) : /\.(ts|tsx|cjs|mjs|js)$/.test(e.name) ? [full] : [];
	});
	const uses = (file: string): boolean => fs.readFileSync(file, "utf8").split("\n").some((line) => {
		const t = line.trim();
		if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return false;
		return /\b(local|session)Storage\b/.test(line) || /\bindexedDB\b/.test(line);
	});

	it("only the audited files use it (a new one must be classified in sign-out-storage.ts)", () => {
		const scanned = ["components", "app", "lib", "hooks", path.join("src", "core"), "plugins"].map((d) => path.join(root, d)).filter((d) => fs.existsSync(d));
		const found = scanned.flatMap(walk).filter((f) => !f.includes(`${path.sep}tests${path.sep}`) && !f.includes(`${path.sep}node_modules${path.sep}`)).filter(uses).map((f) => path.relative(root, f).split(path.sep).join("/")).sort();
		assert.deepEqual(found, [
			"components/graph-view.tsx",
			"components/notes/notes-drawer.tsx",
			"components/opening-prompt.ts",
			"components/phone/keyboard-debug.ts",
			"components/settings/sign-out-storage.ts",
			"components/sidebar.tsx",
			"components/side-tutor.tsx",
			"src/core/keyboard.ts",
		].sort());
	});

	it("every key the notes drawer keeps is classified", () => {
		const source = fs.readFileSync(path.join(root, "components", "notes", "notes-drawer.tsx"), "utf8");
		const keys = [...new Set([...source.matchAll(/["`](lh:notes-[a-z-]+)(:\$\{chatId\})?["`]/g)].map((m) => m[1]! + (m[2] ? ":" : "")))].sort();
		const classified = new Set([...VIEW_LOCAL, ...CONTENT_KEYS, ...CONTENT_PREFIXES]);
		for (const key of keys) assert.ok(classified.has(key), `${key} is classified`);
	});
});
