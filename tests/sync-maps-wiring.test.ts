/**
 * Cloud sync Phase 5, slice 5: the item-by-item files against the REAL
 * stores and files. This process plays the cloud server.
 *
 * Pins: a desktop's changes land in the right files through the app's own
 * stores; settings that stay per device (appearance included) are untouched; a
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
	appearance: { theme: "light", fontFamily: "Georgia", proseFontSize: 20 },
	compaction: { thresholdTokens: 90_000 },
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
		assert.deepEqual([...items.keys()].sort(), ["n|src_server", "p|system-prompt.md", "s|agent.tools|web_search", "s|compaction.thresholdTokens", "x|n_server"], "no appearance: it is per device");
	});

	it("a desktop's first sync lands in the right files, and per-device settings stay exactly as they were", () => {
		const reply = exchange(DESK, {
			cursor: 0, all: true,
			changes: [
				change("s|appearance.theme", "default"),
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
		assert.deepEqual(settings.appearance, { theme: "light", fontFamily: "Georgia", proseFontSize: 20 }, "appearance is per device: the desktop's is answered \"same\" and not taken");
		assert.equal(settings.compaction?.thresholdTokens, undefined, "not set on the desktop: back to its default");
		assert.deepEqual(settings.agent?.tools, { run_code: false }, "the server-only switch went, the desktop's came");
		assert.deepEqual(settings.agent?.prompts, { "teacher/20-teaching.md": true });
		assert.equal(settings.dictation?.language, "sv");
		// Per device: untouched.
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
		assert.deepEqual(Object.keys(full).sort(), ["n|src_server", "p|system-prompt.md", "s|agent.tools|web_search", "s|compaction.thresholdTokens", "x|n_server"]);
		assert.deepEqual(reply.body.items.filter((i) => i.key === "s|appearance.theme").map((i) => i.same), [true], "a retired key an older desktop sends is agreed, never taken");
		// The sliders the desktop didn't send were written at their defaults: they follow in the next answer.
		const next = exchange(DESK, { cursor: reply.body.cursor, all: false, changes: [] });
		assert.deepEqual(next.body.items.map((i) => i.key).sort(), Object.keys(DEFAULT_RENDER_SETTINGS).filter((k) => k !== "nodeSize").map((k) => `r|${k}`).sort());
		assert.equal(full["s|compaction.thresholdTokens"], null);
		assert.deepEqual(announcedVaultFolders(SYNC), ["Journal", "Work", "LearnHarness"], "names only; the manager itself never leaves the notes folder out");
	});

	it("later, the newer change wins and the older one is answered with what the server has", () => {
		const first = exchange(DESK, { cursor: 0, all: false, changes: [] });
		const cursor = first.body.cursor;
		// The phone changes the dictation language now; the desktop's change is from an hour ago.
		const record = readSettings()!;
		writeSettings({ ...record, dictation: { ...record.dictation, language: "de" } });
		const reply = exchange(DESK, { cursor, all: false, changes: [change("s|dictation.language", "en", Date.now() - 3_600_000), change("x|n_desk", { x: 0, y: 0 }, Date.now())] });
		assert.equal(readSettings()!.dictation?.language, "de");
		assert.deepEqual(stores.graphStore.readPositions().n_desk, { x: 0, y: 0 });
		assert.deepEqual(reply.body.items.map((i) => [i.key, i.same ?? i.value]), [["s|dictation.language", "de"], ["x|n_desk", true]]);
	});

	it("a value the settings file adjusts is stored adjusted and sent back", () => {
		const cursor = exchange(DESK, { cursor: 0, all: false, changes: [] }).body.cursor;
		const reply = exchange(DESK, { cursor, all: false, changes: [change("s|compaction.thresholdTokens", 1, Date.now())] });
		const stored = readSettings()!.compaction?.thresholdTokens;
		assert.notEqual(stored, 1);
		assert.deepEqual(reply.body.items.map((i) => [i.key, i.value]), [["s|compaction.thresholdTokens", stored ?? null]]);
	});

	it("a request for a per-device setting is refused whole", async () => {
		const before = fs.readFileSync(path.join(DATA, "settings.json"), "utf8");
		assert.equal(exchange(DESK, { cursor: 0, all: false, changes: [change("s|dictation.language", "en", Date.now()), change("s|models.strong", { provider: "x", model: "y" })] }).status, 400);
		assert.equal(fs.readFileSync(path.join(DATA, "settings.json"), "utf8"), before);
		// And the route itself is closed without a device key.
		const response = await mapsExchangeResponse(new Request("http://localhost/api/sync/maps", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
		assert.equal(response.status, 401);
	});

	it("a damaged settings file is left alone: nothing read from it, nothing written into it", () => {
		const cursor = exchange(DESK, { cursor: 0, all: false, changes: [] }).body.cursor;
		const good = fs.readFileSync(path.join(DATA, "settings.json"), "utf8");
		fs.writeFileSync(path.join(DATA, "settings.json"), "{ this is not json");
		const reply = exchange(DESK, { cursor, all: false, changes: [change("s|dictation.language", "en", Date.now()), change("x|n_desk", { x: 7, y: 7 }, Date.now())] });
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

const { THEME_COLOR_KEYS } = await import("../src/core/themes.ts");
const { themeStore } = await import("../src/store/themes.ts");

describe("upstream 0.6.0 on the real files", () => {
	const THEMES = path.join(DATA, "themes");
	const colors = (accent: string) => Object.fromEntries(THEME_COLOR_KEYS.map((key) => [key, key === "accent" ? accent : "#202020"])) as never;
	const cursorNow = () => exchange(DESK, { cursor: 0, all: false, changes: [] }).body.cursor;

	it("custom themes are read and written through the theme store, one item per file; a deletion travels", () => {
		themeStore.writeTheme("phone-made", { name: "Phone made", mode: "light", colors: colors("#00aa00") });
		fs.writeFileSync(path.join(THEMES, "default.json"), "{}"); // a built-in id: not a custom theme, for the store or for sync
		fs.writeFileSync(path.join(THEMES, "notes.txt"), "not a theme");
		const read = mapFiles.read();
		assert.deepEqual([...read.items.keys()].filter((key) => key.startsWith("t|")), ["t|phone-made"]);
		assert.deepEqual(read.items.get("t|phone-made")!.value, { name: "Phone made", mode: "light", colors: colors("#00aa00") });

		const cursor = cursorNow();
		const reply = exchange(DESK, { cursor, all: false, changes: [change("t|desk-made", { name: "Desk made", mode: "dark", colors: colors("#aa0000") }, Date.now())] });
		assert.equal(reply.status, 200);
		assert.deepEqual(themeStore.readTheme("desk-made"), { id: "desk-made", builtin: false, name: "Desk made", mode: "dark", colors: colors("#aa0000") });
		assert.deepEqual(reply.body.items.map((i) => [i.key, i.same ?? null]), [["t|desk-made", true]], "written exactly as sent");

		const removed = exchange(DESK, { cursor: reply.body.cursor, all: false, changes: [change("t|desk-made", null, Date.now() + 1)] });
		assert.equal(removed.status, 200);
		assert.equal(fs.existsSync(path.join(THEMES, "desk-made.json")), false);
		assert.equal(themeStore.readTheme("phone-made")?.name, "Phone made", "the others stay");
	});

	it("a damaged theme file is left alone: not sent as deleted, not written over", () => {
		const cursor = cursorNow();
		fs.writeFileSync(path.join(THEMES, "phone-made.json"), "{ not json");
		const read = mapFiles.read();
		assert.equal(read.items.has("t|phone-made"), false);
		assert.deepEqual([...(read.unreadableKeys ?? [])], ["t|phone-made"]);
		const reply = exchange(DESK, { cursor, all: false, changes: [change("t|phone-made", { name: "Phone made", mode: "dark", colors: colors("#ffffff") }, Date.now() + 10)] });
		assert.equal(reply.status, 200);
		assert.equal(fs.readFileSync(path.join(THEMES, "phone-made.json"), "utf-8"), "{ not json");
		assert.deepEqual(reply.body.items.filter((i) => i.key.startsWith("t|")), []);
	});

	it("appearance is per device: an old table's appearance is forgotten, an older desktop's is agreed, and neither side's changes", () => {
		// A table an older build left, with appearance in it.
		const state = JSON.parse(fs.readFileSync(path.join(SYNC, "maps.json"), "utf-8")) as { items: Record<string, { seq: number }>; seq: number };
		state.items["s|appearance.mode"] = { h: "stale0000000000000000000", t: 1, seq: state.seq } as never;
		state.items["s|appearance.theme"] = { h: "stale1111111111111111111", t: 1, seq: state.seq } as never;
		fs.writeFileSync(path.join(SYNC, "maps.json"), JSON.stringify(state));
		const cursor = state.seq - 1;
		const settingsBefore = fs.readFileSync(path.join(DATA, "settings.json"), "utf-8");
		const first = exchange(DESK, { cursor, all: false, changes: [] });
		assert.equal(first.status, 200);
		assert.deepEqual(first.body.items.filter((i) => i.key.startsWith("s|appearance")), [], "nothing about appearance is said");
		const purged = JSON.parse(fs.readFileSync(path.join(SYNC, "maps.json"), "utf-8")) as { items: Record<string, unknown>; seq: number };
		assert.deepEqual(Object.keys(purged.items).filter((key) => key.startsWith("s|appearance")), []);
		assert.equal(purged.seq, state.seq, "forgetting is no change");

		// An older desktop with its own look, and a theme file, and a setting that still syncs.
		const dawn = { name: "Desk dawn", mode: "light" as const, colors: colors("#ff00ff") };
		const reply = exchange(DESK, { cursor: first.body.cursor, all: false, changes: [
			change("s|appearance.theme", "desk-dawn", Date.now() + 30),
			change("s|appearance.mode", "dark", Date.now() + 30),
			change("s|appearance.proseFontSize", 24, Date.now() + 30),
			change("s|appearance.colors.accent", "#00ff00", Date.now() + 30),
			change("t|desk-dawn", dawn, Date.now() + 30),
			change("s|dictation.language", "fr", Date.now() + 30),
		] });
		assert.equal(reply.status, 200, "an older desktop's request is never refused for it");
		const record = JSON.parse(fs.readFileSync(path.join(DATA, "settings.json"), "utf-8")) as { appearance?: unknown; dictation?: { language?: string } };
		assert.deepEqual(record.appearance, (JSON.parse(settingsBefore) as { appearance?: unknown }).appearance, "the server's look stays its own");
		assert.equal(record.dictation?.language, "fr");
		assert.deepEqual(themeStore.readTheme("desk-dawn"), { id: "desk-dawn", builtin: false, ...dawn }, "the theme file arrives");
		assert.deepEqual(reply.body.items.filter((i) => i.key.startsWith("s|appearance")).map((i) => [i.key, i.same]).sort(), [
			["s|appearance.colors.accent", true], ["s|appearance.mode", true], ["s|appearance.proseFontSize", true], ["s|appearance.theme", true],
		], "each agreed, so the desktop keeps its own and stops sending it");
		const stored = JSON.parse(fs.readFileSync(path.join(SYNC, "maps.json"), "utf-8")) as { items: Record<string, unknown> };
		assert.deepEqual(Object.keys(stored.items).filter((key) => key.startsWith("s|appearance")), [], "and never stored");
		const third = exchange(DESK, { cursor: reply.body.cursor, all: false, changes: [] });
		assert.deepEqual(third.body.items, [], "and nothing more after that");
	});
});
