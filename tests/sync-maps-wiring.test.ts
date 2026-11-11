/**
 * Cloud sync Phase 5, slice 5: the item-by-item files against the REAL
 * stores and files. This process plays the cloud server.
 *
 * Pins: a desktop's changes land in the right files through the app's own
 * stores; settings that stay per device are untouched, byte for byte; a
 * damaged file is left alone; the vault folder names are kept for Obsidian
 * sync; and nothing is written for sync before a desktop first asks.
 *
 * LH_DATA_DIR and LH_AUTH_FILE are redirected BEFORE the first config import.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sync-maps-wiring-"));
const DATA = path.join(TMP, "data");
process.env.LH_AUTH_FILE = path.join(TMP, "secrets", "auth.json");
process.env.LH_DATA_DIR = DATA;
process.env.LH_SERVER_MODE = "1";
process.env.LH_VAULT_DIR = path.join(TMP, "vault");

const { stores } = await import("../src/server/stores.ts");
const { readSettings, writeSettings } = await import("../src/store/settings.ts");
const { promptOverrides } = await import("../src/store/prompt-overrides.ts");
const { readRenderSettings, DEFAULT_RENDER_SETTINGS } = await import("../src/store/render-settings.ts");
const { mapsAuthority } = await import("../src/server/sync/maps-engine.ts");
const { mapFiles } = await import("../src/server/sync/map-views.ts");
const { announcedVaultFolders, desktopVaultFolders } = await import("../src/store/sync/vault-folders.ts");
const { mapsExchangeResponse } = await import("../src/server/sync/http.ts");

after(() => {
	delete process.env.LH_SERVER_MODE;
	delete process.env.LH_VAULT_DIR;
	fs.rmSync(TMP, { recursive: true, force: true });
});

const DESK = "dev_aaaaaaaaaaaaaaaa";
const SYNC = path.join(DATA, "sync");
const NOW = Date.now();
type Reply = { cursor: number; items: Array<{ key: string; value?: unknown; same?: boolean; t: number }> };
const exchange = (deviceId: string, body: Record<string, unknown>) => {
	const reply = mapsAuthority().exchange(deviceId, body);
	return { status: reply.status, body: reply.body as unknown as Reply };
};
const change = (key: string, value: unknown, t = NOW) => ({ key, value, t });

// The server's own library before any desktop is paired.
writeSettings({
	version: 1,
	general: { autoUpdate: false },
	appearance: { mode: "light", fontFamily: "Georgia", proseFontSize: 20 },
	models: { strong: { provider: "anthropic", model: "server-model" } },
	agent: { tools: { web_search: false }, fileAccess: { restricted: true, folders: ["/data/home/files"] } },
});
promptOverrides.writeOverride("system-prompt.md", "the server's own base prompt");
stores.graphStore.writePositions({ n_server: { x: 1, y: 2 } });
stores.graphStore.upsertSource({ id: "src_server", filePath: "/data/import/a.md", importedAt: "2026-11-01T00:00:00.000Z" });

describe("the real files", () => {
	it("before a desktop asks, nothing is kept for sync", () => {
		assert.equal(fs.existsSync(SYNC), false);
		const { items, unreadable } = mapFiles.read();
		assert.deepEqual([...unreadable], []);
		assert.deepEqual([...items.keys()].sort(), ["n|src_server", "p|system-prompt.md", "s|agent.tools|web_search", "s|appearance.mode", "s|appearance.proseFontSize", "x|n_server"]);
	});

	it("a desktop's first sync lands in the right files, and per-device settings stay exactly as they were", () => {
		const reply = exchange(DESK, {
			cursor: 0, all: true,
			changes: [
				change("s|appearance.mode", "dark"),
				change("s|dictation.language", "sv"),
				change("s|agent.tools|run_code", false),
				change("s|agent.prompts|teacher/20-teaching.md", true),
				change("p|teacher/20-teaching.md", "teach like the desktop says"),
				change("r|nodeSize", DEFAULT_RENDER_SETTINGS.nodeSize),
				change("f|fold_1", { id: "fold_1", name: "Physics", parentId: null, createdAt: "2026-10-01T00:00:00.000Z" }),
				change("o|chat_x", { folderId: "fold_1" }),
				change("n|src_desk", { id: "src_desk", filePath: "C:\\Users\\me\\notes.md", importedAt: "2026-10-02T00:00:00.000Z" }),
				change("x|n_desk", { x: -4, y: 8 }),
			],
			vaultFolders: ["Journal", "Work", "../escape", "LearnHarness"],
		});
		assert.equal(reply.status, 200);
		const settings = readSettings()!;
		assert.equal(settings.appearance?.mode, "dark", "differs: the desktop's value is kept");
		assert.equal(settings.appearance?.proseFontSize, undefined, "not set on the desktop: back to its default");
		assert.deepEqual(settings.agent?.tools, { run_code: false }, "the server-only switch went, the desktop's came");
		assert.deepEqual(settings.agent?.prompts, { "teacher/20-teaching.md": true });
		assert.equal(settings.dictation?.language, "sv");
		// Per device: untouched.
		assert.equal(settings.appearance?.fontFamily, "Georgia");
		assert.deepEqual(settings.models, { strong: { provider: "anthropic", model: "server-model" } });
		assert.deepEqual(settings.general, { autoUpdate: false });
		assert.deepEqual(settings.agent?.fileAccess, { restricted: true, folders: ["/data/home/files"] });

		assert.equal(promptOverrides.readOverride("teacher/20-teaching.md"), "teach like the desktop says");
		assert.equal(promptOverrides.readOverride("system-prompt.md"), "the server's own base prompt", "a text only one side has is kept");
		assert.deepEqual(readRenderSettings(), DEFAULT_RENDER_SETTINGS);
		assert.deepEqual(stores.sourceOrganizationStore.read(), { version: 1, folders: [{ id: "fold_1", name: "Physics", parentId: null, createdAt: "2026-10-01T00:00:00.000Z" }], placements: { chat_x: { folderId: "fold_1" } } });
		assert.deepEqual(stores.graphStore.readSources().map((s) => s.id).sort(), ["src_desk", "src_server"]);
		assert.equal(stores.graphStore.readSources().find((s) => s.id === "src_desk")!.filePath, "C:\\Users\\me\\notes.md", "the path stays the importing device's");
		assert.deepEqual(stores.graphStore.readPositions(), { n_server: { x: 1, y: 2 }, n_desk: { x: -4, y: 8 } });

		// What the desktop is told: what it doesn't have yet, in full; its own, as "same".
		const full = Object.fromEntries(reply.body.items.filter((i) => !i.same).map((i) => [i.key, i.value]));
		assert.deepEqual(Object.keys(full).sort(), ["n|src_server", "p|system-prompt.md", "s|agent.tools|web_search", "s|appearance.proseFontSize", "x|n_server"]);
		// The sliders the desktop didn't send were written at their defaults: they follow in the next answer.
		const next = exchange(DESK, { cursor: reply.body.cursor, all: false, changes: [] });
		assert.deepEqual(next.body.items.map((i) => i.key).sort(), Object.keys(DEFAULT_RENDER_SETTINGS).filter((k) => k !== "nodeSize").map((k) => `r|${k}`).sort());
		assert.equal(full["s|appearance.proseFontSize"], null);
		assert.deepEqual(announcedVaultFolders(SYNC), ["Journal", "Work", "LearnHarness"], "names only; the manager itself never leaves the notes folder out");
	});

	it("later, the newer change wins and the older one is answered with what the server has", () => {
		const first = exchange(DESK, { cursor: 0, all: false, changes: [] });
		const cursor = first.body.cursor;
		// The phone changes the mode now; the desktop's change is from an hour ago.
		const record = readSettings()!;
		writeSettings({ ...record, appearance: { ...record.appearance, mode: "light" } });
		const reply = exchange(DESK, { cursor, all: false, changes: [change("s|appearance.mode", "dark", Date.now() - 3_600_000), change("x|n_desk", { x: 0, y: 0 }, Date.now())] });
		assert.equal(readSettings()!.appearance?.mode, "light");
		assert.deepEqual(stores.graphStore.readPositions().n_desk, { x: 0, y: 0 });
		assert.deepEqual(reply.body.items.map((i) => [i.key, i.same ?? i.value]), [["s|appearance.mode", "light"], ["x|n_desk", true]]);
	});

	it("a value the settings file adjusts is stored adjusted and sent back", () => {
		const cursor = exchange(DESK, { cursor: 0, all: false, changes: [] }).body.cursor;
		const reply = exchange(DESK, { cursor, all: false, changes: [change("s|appearance.proseFontSize", 999, Date.now())] });
		const stored = readSettings()!.appearance?.proseFontSize;
		assert.notEqual(stored, 999);
		assert.deepEqual(reply.body.items.map((i) => [i.key, i.value]), [["s|appearance.proseFontSize", stored ?? null]]);
	});

	it("a request for a per-device setting is refused whole", async () => {
		const before = fs.readFileSync(path.join(DATA, "settings.json"), "utf8");
		assert.equal(exchange(DESK, { cursor: 0, all: false, changes: [change("s|appearance.mode", "dark", Date.now()), change("s|models.strong", { provider: "x", model: "y" })] }).status, 400);
		assert.equal(fs.readFileSync(path.join(DATA, "settings.json"), "utf8"), before);
		// And the route itself is closed without a device key.
		const response = await mapsExchangeResponse(new Request("http://localhost/api/sync/maps", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
		assert.equal(response.status, 401);
	});

	it("a damaged settings file is left alone: nothing read from it, nothing written into it", () => {
		const cursor = exchange(DESK, { cursor: 0, all: false, changes: [] }).body.cursor;
		const good = fs.readFileSync(path.join(DATA, "settings.json"), "utf8");
		fs.writeFileSync(path.join(DATA, "settings.json"), "{ this is not json");
		const reply = exchange(DESK, { cursor, all: false, changes: [change("s|appearance.mode", "dark", Date.now()), change("x|n_desk", { x: 7, y: 7 }, Date.now())] });
		assert.equal(reply.status, 200);
		assert.equal(fs.readFileSync(path.join(DATA, "settings.json"), "utf8"), "{ this is not json");
		assert.deepEqual(reply.body.items.map((i) => i.key), ["x|n_desk"], "no settings are sent, so the desktop keeps its own");
		fs.writeFileSync(path.join(DATA, "settings.json"), good);
		const after = exchange(DESK, { cursor: reply.body.cursor, all: false, changes: [] });
		assert.deepEqual(after.body.items, [], "repaired with the same contents: nothing was deleted on either side");
	});

	it("a desktop reads its vault's top-level folder names, and nothing else", () => {
		assert.equal(desktopVaultFolders(), null, "no vault connected");
		const vault = path.join(TMP, "my-vault");
		for (const dir of ["Work", "Journal", "LearnHarness", ".obsidian", "Projects, old"]) fs.mkdirSync(path.join(vault, dir), { recursive: true });
		fs.writeFileSync(path.join(vault, "Welcome.md"), "hi");
		fs.mkdirSync(path.join(DATA, "notes"), { recursive: true });
		fs.writeFileSync(path.join(DATA, "notes", "settings.json"), JSON.stringify({ version: 1, vaultPath: vault }));
		assert.deepEqual(desktopVaultFolders(), ["Journal", "LearnHarness", "Projects, old", "Work"]);
		fs.rmSync(vault, { recursive: true });
		assert.equal(desktopVaultFolders(), null, "the vault is offline: nothing is said, rather than 'no folders'");
	});
});
