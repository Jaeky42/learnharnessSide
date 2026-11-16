/**
 * Cloud sync Phase 5, slice 5 (docs/cloud-sync.md): the files that sync one
 * item at a time, latest change wins.
 *
 * Pins the owner's decisions: the settings split (what travels and what
 * stays per device; appearance is per device since it was retired, and
 * older builds on the other side are met without a reset either way); at a desktop's first sync the desktop's value is kept
 * where the two sides differ; afterwards the latest change wins, on the
 * server's clock, also when the PC's clock is off; the chains-view folders,
 * imported-file records and node places travel item by item; the desktop
 * sends its vault's top-level folder names.
 *
 * Each side's files are held in memory here; the state files are real.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sync-maps-"));
process.env.LH_AUTH_FILE = path.join(TMP, "prod", "secrets", "auth.json");
process.env.LH_DATA_DIR = path.join(TMP, "prod", "data");

const maps = await import("../src/core/sync/maps.ts");
const { COLOR_OVERRIDE_KEYS, THEME_COLOR_KEYS } = await import("../src/core/themes.ts");
const { stateFile } = await import("../src/store/sync/state-file.ts");
const { createMapsAuthority, createMapsDesktop, isAuthorityMapsState, isDesktopMapsState, MAP_RULES } = await import("../src/server/sync/maps-sync.ts");
import type { ExchangeRules } from "../src/server/sync/maps-sync.ts";
import type { SyncReply } from "../src/server/sync/client.ts";
import type { MapFiles, MapItem } from "../src/server/sync/map-views.ts";
import type { MapKind } from "../src/core/sync/maps.ts";
import type { SourceOrganization } from "../src/core/source-organization.ts";

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const HOUR = 3_600_000;
const MONDAY = Date.UTC(2026, 10, 2, 12);

/** One side's synced files, in memory. */
function memoryFiles(clock: () => number) {
	const items = new Map<string, MapItem>();
	const unreadable = new Set<MapKind>();
	const unreadableKeys = new Set<string>();
	let adjust: (key: string, value: unknown) => unknown = (_key, value) => value;
	/** Keys the files don't report or take (a new build's settings store and appearance). */
	let hidden: (key: string) => boolean = () => false;
	const files: MapFiles = {
		read: () => ({ items: new Map([...items].filter(([key]) => !hidden(key))), unreadable: new Set(unreadable), unreadableKeys: new Set(unreadableKeys), fileTimes: new Map() }),
		apply(changes) {
			for (const [key, value] of changes) {
				if (hidden(key)) continue;
				const next = value === null ? null : adjust(key, value);
				if (next === null) items.delete(key); else items.set(key, { value: next, mtime: clock() });
			}
		},
	};
	return {
		files,
		/** The learner changes something in the app. */
		set(key: string, value: unknown) { if (value === null) items.delete(key); else items.set(key, { value, mtime: clock() }); },
		get: (key: string) => items.get(key)?.value ?? null,
		all: () => Object.fromEntries([...items].map(([key, item]) => [key, item.value]).sort(([a], [b]) => String(a).localeCompare(String(b)))),
		damage(kind: MapKind) { unreadable.add(kind); for (const key of [...items.keys()]) if (key.startsWith(`${kind}|`)) items.delete(key); },
		/** One item's own file is damaged (a theme file): it reads as nothing, and is marked. */
		damageKey(key: string) { unreadableKeys.add(key); items.delete(key); },
		repairKey(key: string, value: unknown) { unreadableKeys.delete(key); items.set(key, { value, mtime: clock() }); },
		adjustWith(fn: typeof adjust) { adjust = fn; },
		/** This side runs a new build: its files no longer report or take appearance. */
		hideRetired() { hidden = maps.isRetiredSettingKey; },
	};
}

/** The rules of a build from before appearance was retired. */
const OLD_RULES: ExchangeRules = { ...MAP_RULES, retired: undefined };

let worlds = 0;
function world(opts: { page?: { items: number; bytes: number }; oldServer?: boolean } = {}) {
	const root = path.join(TMP, `w${++worlds}`);
	/** The true time. Each side reads it through its own (possibly wrong) clock. */
	let time = MONDAY;
	const server = memoryFiles(() => time);
	const folders: string[][] = [];
	let serverState = stateFile(path.join(root, "server", "sync", "maps.json"), isAuthorityMapsState);
	const makeAuthority = (old: boolean) => createMapsAuthority({ files: server.files, state: serverState, now: () => time, onVaultFolders: (names) => folders.push(names), page: opts.page, ...(old ? { rules: OLD_RULES } : {}) });
	let authority = makeAuthority(opts.oldServer === true);

	function desktop(deviceId: string, o: { skewMs?: number; hold?: (body: { changes: unknown[]; more?: boolean }) => Promise<void>; old?: boolean } = {}) {
		const skew = o.skewMs ?? 0;
		const local = () => time + skew;
		const side = memoryFiles(local);
		let online = true;
		let vault: string[] | null = null;
		const hooks: { duringRequest?: () => void } = {};
		const requests: Array<{ changes: number; all: boolean; vaultFolders?: string[] }> = [];
		/** The keys each request carried. */
		const sentKeys: string[][] = [];
		const make = (old: boolean) => createMapsDesktop({
			files: side.files,
			state: stateFile(path.join(root, deviceId, "sync", "maps-desktop.json"), isDesktopMapsState),
			identity: () => ({ server: "https://learn.example.com", deviceId }),
			request: async <T>(_pathname: string, init: { method?: string; body?: unknown } = {}) => {
				if (!online) return { ok: false, reason: "offline" } as SyncReply<T>;
				const body = JSON.parse(JSON.stringify(init.body)) as { changes: unknown[]; all: boolean; more?: boolean; vaultFolders?: string[] };
				await o.hold?.(body);
				requests.push({ changes: body.changes.length, all: body.all, ...(body.vaultFolders ? { vaultFolders: body.vaultFolders } : {}) });
			sentKeys.push(body.changes.map((change) => (change as { key: string }).key));
				const result = authority.exchange(deviceId, body);
				hooks.duringRequest?.();
				hooks.duringRequest = undefined;
				const copy = JSON.parse(JSON.stringify(result)) as typeof result;
				return (copy.status === 200 ? { ok: true, body: copy.body } : { ok: false, reason: "refused", status: copy.status, code: copy.body.code ?? null, error: String(copy.body.error), body: copy.body }) as SyncReply<T>;
			},
			now: local,
			// Measured against the server whenever it was last reached.
			clockOffset: () => -skew,
			vaultFolders: () => vault,
			page: opts.page,
			...(old ? { rules: OLD_RULES } : {}),
		});
		const api = {
			...side, sync: make(o.old === true), requests, sentKeys, hooks, stateFile: path.join(root, deviceId, "sync", "maps-desktop.json"),
			setOnline: (value: boolean) => { online = value; }, setVault: (names: string[] | null) => { vault = names; },
			/** This desktop installs the new build (its state file stays as the old one left it). */
			upgrade() { api.sync = make(false); side.hideRetired(); },
		};
		return api;
	}
	return {
		root, server, folders, desktop,
		/** The server installs the new build (its state file stays as the old one left it). */
		upgradeServer() { authority = makeAuthority(false); server.hideRetired(); },
		pass: (ms: number) => { time += ms; },
		serverStateFile: path.join(root, "server", "sync", "maps.json"),
		/** The server lost its sync records (reset, or restored from a backup). */
		resetServer() {
			fs.rmSync(path.join(root, "server"), { recursive: true, force: true });
			serverState = stateFile(path.join(root, "server", "sync", "maps.json"), isAuthorityMapsState);
			authority = createMapsAuthority({ files: server.files, state: serverState, now: () => time, onVaultFolders: (names) => folders.push(names) });
		},
	};
}

describe("the settings split", () => {
	const record = {
		version: 1,
		general: { autoUpdate: false },
		dictation: { language: "sv" },
		claudeCode: { enabled: true },
		models: { strong: { provider: "x", model: "y" } },
		customProvider: { baseUrl: "http://localhost:1234" },
		appearance: {
			mode: "light", theme: "rose-pine", background: "#101010", colors: { surface: "#111111", accent: null, notAColor: "#222222" },
			fontFamily: "Georgia", proseFontSize: 18, codeLigatures: true, sessionNameSerif: false,
			mdRendering: { headingWeight: 700, boldColor: "#ff0000", italicColor: null },
		},
		graph: { enabled: true, rendering: false, extractionChunkTokens: 2048 },
		compaction: { thresholdTokens: 90_000, includeReasoning: true },
		agent: {
			models: { extractor: { model: "m" }, sideQuestion: { provider: "x", model: "side" } },
			workerRequestConcurrency: 4,
			tools: { web_search: false, read_file: true },
			search: { engine: "brave" },
			graphTools: { enabled: false },
			prompts: { "teacher/20-teaching.md": true },
			fileAccess: { restricted: true, folders: ["~/Documents"] },
		},
		keyboard: { "toggle-notes": "Ctrl+Shift+N" },
	};

	it("what travels: dictation language, graph, compaction, agent switches, prompt switches; no appearance at all", () => {
		assert.deepEqual(Object.fromEntries(maps.settingsItems(record)), {
			"s|dictation.language": "sv",
			"s|graph.enabled": true,
			"s|graph.rendering": false,
			"s|graph.extractionChunkTokens": 2048,
			"s|compaction.thresholdTokens": 90_000,
			"s|compaction.includeReasoning": true,
			"s|agent.search.engine": "brave",
			"s|agent.graphTools.enabled": false,
			"s|agent.tools|web_search": false,
			"s|agent.tools|read_file": true,
			"s|agent.prompts|teacher/20-teaching.md": true,
		});
	});

	it("applying items changes those settings and nothing else in the record", () => {
		const next = maps.withSettingsItems(record, new Map<string, unknown>([
			["s|dictation.language", "de"],
			// Retired: never written into the record, whatever arrives.
			["s|appearance.mode", "dark"],
			["s|appearance.theme", "nord"],
			["s|appearance.colors.accent", "#00ff00"],
			["s|appearance.colors.surface", null],
			["s|appearance.proseFontSize", null],
			["s|agent.tools|web_search", null],
			["s|agent.tools|run_code", false],
			["s|compaction.thresholdTokens", null],
			["s|compaction.includeReasoning", null],
			["s|models.strong", { provider: "evil", model: "z" }],
			["s|agent.fileAccess", { restricted: false, folders: [] }],
		]));
		assert.equal(next.dictation.language, "de");
		assert.deepEqual(next.appearance, record.appearance, "appearance is per device: left exactly as it was");
		assert.equal(next.agent.workerRequestConcurrency, 4);
		assert.deepEqual(next.agent.tools, { read_file: true, run_code: false });
		assert.equal("compaction" in next, false, "an emptied section goes");
		for (const section of ["general", "claudeCode", "models", "customProvider", "keyboard"] as const) assert.deepEqual(next[section], record[section]);
		assert.deepEqual(next.agent.fileAccess, record.agent.fileAccess);
		assert.deepEqual(next.agent.models, record.agent.models);
		assert.equal(record.appearance.mode, "light", "the record passed in is not changed");
	});

	it("a request can't reach a per-device setting, whatever it says", () => {
		const t = 1;
		for (const key of [
			"s|models.strong", "s|appearance.fontFamily", "s|agent.fileAccess", "s|agent.models|extractor", "s|general.autoUpdate", "s|claudeCode.enabled",
			"s|customProvider.baseUrl", "s|keyboard.toggle-notes", "s|agent.tools|", "s|", "z|x", "appearance.mode",
			// Per device since upstream 0.6.0 as well.
			"s|agent.workerRequestConcurrency", "s|agent.models.sideQuestion", "s|agent.models|sideQuestion", "s|appearance.colors", "s|appearance.colors.notAColor", "s|appearance.colors.bold",
		]) {
			assert.equal(maps.checkMapChange({ key, value: true, t }), null, key);
			if (key.startsWith("s|")) assert.equal(maps.checkMapChange({ key, value: null, t }), null, `${key} (removal)`);
		}
		assert.notEqual(maps.checkMapChange({ key: "s|agent.tools|web_search", value: false, t }), null);
		assert.notEqual(maps.checkMapChange({ key: "s|compaction.includeReasoning", value: false, t }), null);
		// Retired (appearance): still accepted from an older build, so its request isn't refused whole.
		for (const key of ["s|appearance.mode", "s|appearance.theme", "s|appearance.background", "s|appearance.colors.warning", "s|appearance.proseFontSize", "s|appearance.codeLigatures", "s|appearance.sessionNameSerif", "s|appearance.mdRendering.headingWeight", "s|appearance.mdRendering.boldColor", "s|appearance.mdRendering.italicColor"]) {
			assert.equal(maps.isRetiredSettingKey(key), true, key);
			assert.notEqual(maps.checkMapChange({ key, value: "x", t }), null, key);
			assert.notEqual(maps.checkMapChange({ key, value: null, t }), null, `${key} (removal)`);
		}
		for (const key of COLOR_OVERRIDE_KEYS) assert.equal(maps.isRetiredSettingKey(`s|appearance.colors.${key}`), true, key);
		for (const key of ["s|dictation.language", "s|appearance.fontFamily", "s|appearance.colors.notAColor", "s|appearance.colors", "appearance.theme", "t|dusk"]) assert.equal(maps.isRetiredSettingKey(key), false, key);
		assert.equal(maps.checkMapChange({ key: "s|appearance.mode", value: { nested: true }, t }), null, "the value rule of a setting still holds");
		assert.equal(maps.checkMapChange({ key: "p|teacher/20-teaching.md", value: 5, t }), null);
		assert.equal(maps.checkMapChange({ key: "f|fold_1", value: { id: "fold_2", name: "x", parentId: null, createdAt: "2026" }, t }), null, "a folder under another folder's key");
		assert.equal(maps.checkMapChange({ key: "x|n_1", value: { x: 1, y: Number.NaN }, t }), null);
		assert.equal(maps.checkMapChange({ key: "x|n_1", value: { x: 1, y: 2 }, t: -1 })!.t, 0, "a time before 1970 is the oldest time, not a refusal");
		assert.equal(maps.checkMapChange({ key: "x|n_1", value: { x: 1, y: 2 }, t: Number.NaN }), null);
	});

	it("a value's fingerprint doesn't depend on the order of its fields", () => {
		assert.equal(maps.itemHash({ a: 1, b: { c: 2, d: [1, 2] } }), maps.itemHash({ b: { d: [1, 2], c: 2 }, a: 1 }));
		assert.notEqual(maps.itemHash({ a: 1 }), maps.itemHash({ a: 2 }));
		assert.equal(maps.itemHash(null), maps.ABSENT);
		assert.notEqual(maps.itemHash(false), maps.ABSENT);
	});
});

describe("chains-view folders that two devices changed at once are made whole", () => {
	const folder = (id: string, parentId: string | null, createdAt = "2026-11-01") => ({ id, name: id, parentId, createdAt });
	const base: SourceOrganization = { version: 1, folders: [folder("a", null, "2026-11-01"), folder("b", null, "2026-11-02"), folder("c", "b", "2026-11-03")], placements: { chat_1: { folderId: "c" } } };

	it("two folders moved into each other: the older stays where it was put, the newer goes to the top", () => {
		const next = maps.withOrganizationItems(base, new Map<string, unknown>([["f|a", folder("a", "b", "2026-11-01")], ["f|b", folder("b", "a", "2026-11-02")]]));
		assert.deepEqual(next.folders.map((f) => [f.id, f.parentId]), [["a", null], ["b", "a"], ["c", "b"]]);
	});

	it("a folder whose parent was deleted on the other device moves to the top, and its sources are unfiled only if their own folder went", () => {
		const next = maps.withOrganizationItems(base, new Map<string, unknown>([["f|b", null]]));
		assert.deepEqual(next.folders.map((f) => [f.id, f.parentId]), [["a", null], ["c", null]]);
		assert.deepEqual(next.placements, { chat_1: { folderId: "c" } });
		assert.deepEqual(maps.withOrganizationItems(base, new Map<string, unknown>([["f|c", null]])).placements, { chat_1: { folderId: null } });
	});

	it("items in, items out", () => {
		assert.deepEqual([...maps.organizationItems(base).keys()], ["f|a", "f|b", "f|c", "o|chat_1"]);
		const next = maps.withOrganizationItems(base, new Map<string, unknown>([["f|d", folder("d", "a", "2026-11-04")], ["o|chat_2", { folderId: "d", name: "Renamed" }], ["o|chat_1", null]]));
		assert.deepEqual(next.folders.map((f) => f.id), ["a", "b", "c", "d"]);
		assert.deepEqual(next.placements, { chat_2: { folderId: "d", name: "Renamed" } });
	});
});

describe("where no desktop has synced, nothing is kept", () => {
	it("no state file on either side", () => {
		const w = world();
		const desk = w.desktop("dev_aaaaaaaaaaaaaaaa");
		w.server.set("s|agent.search.engine", "tavily");
		desk.set("s|agent.search.engine", "brave");
		desk.sync.detect();
		assert.equal(fs.existsSync(w.root), false);
	});
});

describe("a desktop's first sync", () => {
	function before() {
		const w = world();
		const desk = w.desktop("dev_aaaaaaaaaaaaaaaa");
		// The same setting, different on each side.
		desk.set("s|agent.search.engine", "brave");
		w.server.set("s|agent.search.engine", "tavily");
		// Set on the server only: on the desktop it is at its default.
		w.server.set("s|graph.extractionChunkTokens", 6000);
		w.server.set("s|agent.tools|web_search", false);
		// Set on the desktop only.
		desk.set("s|dictation.language", "sv");
		// Things that are joined.
		desk.set("f|fold_d", { id: "fold_d", name: "Physics", parentId: null, createdAt: "2026-10-01" });
		w.server.set("f|fold_c", { id: "fold_c", name: "From the phone", parentId: null, createdAt: "2026-10-02" });
		desk.set("p|teacher/20-teaching.md", "the desktop's text");
		w.server.set("p|teacher/20-teaching.md", "the phone's text");
		w.server.set("p|system-prompt.md", "only on the server");
		w.server.set("s|agent.prompts|system-prompt.md", true);
		desk.set("x|n_1", { x: 1, y: 1 });
		w.server.set("x|n_1", { x: 9, y: 9 });
		w.server.set("x|n_2", { x: 2, y: 2 });
		w.server.set("n|src_1", { id: "src_1", filePath: "/data/notes.md", importedAt: "2026-10-03" });
		return { w, desk };
	}

	it("where the two sides differ the desktop's value is kept; a setting the desktop hasn't set goes back to its default; the rest is joined", async () => {
		const { w, desk } = before();
		w.pass(HOUR);
		// Applied here: the phone's folder, its prompt text, its node place and its imported-file record.
		assert.deepEqual(await desk.sync.round(), { ok: true, sent: 5, applied: 4 });
		assert.deepEqual(desk.all(), w.server.all());
		assert.deepEqual(w.server.all(), {
			"f|fold_c": { id: "fold_c", name: "From the phone", parentId: null, createdAt: "2026-10-02" },
			"f|fold_d": { id: "fold_d", name: "Physics", parentId: null, createdAt: "2026-10-01" },
			"n|src_1": { id: "src_1", filePath: "/data/notes.md", importedAt: "2026-10-03" },
			"p|system-prompt.md": "only on the server",
			"p|teacher/20-teaching.md": "the desktop's text",
			"s|agent.search.engine": "brave",
			"s|dictation.language": "sv",
			"x|n_1": { x: 1, y: 1 },
			"x|n_2": { x: 2, y: 2 },
		});
		assert.deepEqual(desk.requests, [{ changes: 5, all: true }]);
	});

	it("a second round has nothing to say", async () => {
		const { w, desk } = before();
		await desk.sync.round();
		w.pass(10_000);
		assert.deepEqual(await desk.sync.round(), { ok: true, sent: 0, applied: 0 });
		assert.deepEqual(desk.requests[1], { changes: 0, all: false });
	});

	it("the server's records lost: the next desktop to sync is the first again", async () => {
		const { w, desk } = before();
		await desk.sync.round();
		w.resetServer();
		const laptop = w.desktop("dev_bbbbbbbbbbbbbbbb");
		laptop.set("s|agent.search.engine", "tavily");
		w.pass(HOUR);
		await laptop.sync.round();
		assert.equal(w.server.get("s|agent.search.engine"), "tavily", "nobody is on record as having synced, so it brings its values");
	});
});

describe("a PC paired later takes the server's settings (only the first PC brings its own)", () => {
	/** The first PC has synced; the server now carries its settings. */
	async function withFirstPc() {
		const w = world();
		const desk = w.desktop("dev_aaaaaaaaaaaaaaaa");
		desk.set("s|agent.search.engine", "brave");
		desk.set("s|dictation.language", "sv");
		desk.set("f|fold_d", { id: "fold_d", name: "Physics", parentId: null, createdAt: "2026-10-01" });
		desk.set("p|teacher/20-teaching.md", "the desktop's text");
		desk.set("x|n_1", { x: 1, y: 1 });
		await desk.sync.round();
		w.pass(HOUR);
		return { w, desk };
	}

	it("a fresh install changes nothing anywhere, and gets everything", async () => {
		const { w, desk } = await withFirstPc();
		const before = w.server.all();
		const laptop = w.desktop("dev_bbbbbbbbbbbbbbbb");
		assert.deepEqual(await laptop.sync.round(), { ok: true, sent: 0, applied: 5 });
		assert.deepEqual(w.server.all(), before, "nothing went back to a default");
		assert.deepEqual(laptop.all(), before);
		await desk.sync.round();
		assert.deepEqual(desk.all(), before);
	});

	it("its synced settings become the server's, \"not set\" included", async () => {
		const { w, desk } = await withFirstPc();
		const laptop = w.desktop("dev_bbbbbbbbbbbbbbbb");
		laptop.set("s|agent.search.engine", "tavily"); // differs from the server's
		laptop.set("s|graph.extractionChunkTokens", 8000); // not set on the server
		laptop.set("s|agent.tools|web_search", false); // not set on the server
		await laptop.sync.round();
		assert.equal(w.server.get("s|agent.search.engine"), "brave");
		assert.equal(laptop.get("s|agent.search.engine"), "brave");
		assert.equal(laptop.get("s|dictation.language"), "sv", "set on the server only: the laptop takes it");
		assert.equal(w.server.get("s|graph.extractionChunkTokens"), null, "the server's stays not set");
		assert.equal(laptop.get("s|graph.extractionChunkTokens"), null, "and the laptop goes back to the default");
		assert.equal(laptop.get("s|agent.tools|web_search"), null);
		assert.deepEqual(laptop.all(), w.server.all());
		// It doesn't come back at the next round, on either PC.
		w.pass(10_000);
		assert.deepEqual(await laptop.sync.round(), { ok: true, sent: 0, applied: 0 });
		await desk.sync.round();
		assert.equal(desk.get("s|agent.search.engine"), "brave");
		assert.equal(desk.get("s|graph.extractionChunkTokens"), null);
	});

	it("where both have the same item the server's is kept; what only the new PC has is added", async () => {
		const { w, desk } = await withFirstPc();
		const laptop = w.desktop("dev_bbbbbbbbbbbbbbbb");
		laptop.set("p|teacher/20-teaching.md", "the laptop's text");
		laptop.set("x|n_1", { x: 7, y: 7 });
		laptop.set("f|fold_d", { id: "fold_d", name: "Renamed on the laptop", parentId: null, createdAt: "2026-10-01" });
		laptop.set("f|fold_l", { id: "fold_l", name: "Only on the laptop", parentId: null, createdAt: "2026-10-05" });
		laptop.set("p|system-prompt.md", "only on the laptop");
		laptop.set("x|n_9", { x: 9, y: 9 });
		laptop.set("n|src_l", { id: "src_l", filePath: "C:\\notes.md", importedAt: "2026-10-06" });
		await laptop.sync.round();
		assert.equal(w.server.get("p|teacher/20-teaching.md"), "the desktop's text");
		assert.deepEqual(w.server.get("x|n_1"), { x: 1, y: 1 });
		assert.equal((w.server.get("f|fold_d") as { name: string }).name, "Physics");
		assert.equal((w.server.get("f|fold_l") as { name: string }).name, "Only on the laptop");
		assert.equal(w.server.get("p|system-prompt.md"), "only on the laptop");
		assert.deepEqual(w.server.get("x|n_9"), { x: 9, y: 9 });
		assert.equal((w.server.get("n|src_l") as { id: string }).id, "src_l");
		assert.deepEqual(laptop.all(), w.server.all());
		await desk.sync.round();
		assert.deepEqual(desk.all(), w.server.all());
	});

	it("afterwards the laptop is like any other PC: its latest change wins", async () => {
		const { w, desk } = await withFirstPc();
		const laptop = w.desktop("dev_bbbbbbbbbbbbbbbb");
		laptop.set("s|agent.search.engine", "tavily");
		await laptop.sync.round();
		assert.equal(laptop.get("s|agent.search.engine"), "brave");
		w.pass(HOUR);
		laptop.set("s|agent.search.engine", "tavily");
		await laptop.sync.round();
		assert.equal(w.server.get("s|agent.search.engine"), "tavily");
		await desk.sync.round();
		assert.equal(desk.get("s|agent.search.engine"), "tavily");
	});

	it("the first PC removed and paired anew is still not a first PC", async () => {
		const { w } = await withFirstPc();
		// A new device id (it paired with another server in between, or was reinstalled).
		const again = w.desktop("dev_cccccccccccccccc");
		again.set("s|agent.search.engine", "tavily");
		await again.sync.round();
		assert.equal(w.server.get("s|agent.search.engine"), "brave");
	});
});

describe("afterwards, the latest change wins", () => {
	async function synced(opts: { skewMs?: number } = {}) {
		const w = world();
		const desk = w.desktop("dev_aaaaaaaaaaaaaaaa", opts);
		desk.set("s|agent.search.engine", "brave");
		desk.set("f|fold_1", { id: "fold_1", name: "Physics", parentId: null, createdAt: "2026-10-01" });
		desk.set("p|system-prompt.md", "v1");
		await desk.sync.round();
		w.pass(HOUR);
		return { w, desk };
	}

	it("a change on the desktop reaches the server, and one on the phone reaches the desktop", async () => {
		const { w, desk } = await synced();
		desk.set("s|agent.search.engine", "tavily");
		assert.deepEqual(await desk.sync.round(), { ok: true, sent: 1, applied: 0 });
		assert.equal(w.server.get("s|agent.search.engine"), "tavily");
		w.pass(HOUR);
		w.server.set("s|graph.rendering", false);
		w.server.set("f|fold_1", { id: "fold_1", name: "Physics I", parentId: null, createdAt: "2026-10-01" });
		assert.deepEqual(await desk.sync.round(), { ok: true, sent: 0, applied: 2 });
		assert.deepEqual(desk.all(), w.server.all());
	});

	it("the desktop changes it on Monday offline, the phone on Tuesday: Tuesday's stays, on both", async () => {
		const { w, desk } = await synced();
		desk.setOnline(false);
		desk.set("p|system-prompt.md", "Monday, on the desktop");
		desk.sync.detect(); // the app notices while offline, and notes the time
		w.pass(24 * HOUR);
		w.server.set("p|system-prompt.md", "Tuesday, on the phone");
		w.server.set("s|compaction.thresholdTokens", 90_000);
		w.pass(24 * HOUR);
		desk.setOnline(true);
		assert.deepEqual(await desk.sync.round(), { ok: true, sent: 1, applied: 2 });
		assert.equal(w.server.get("p|system-prompt.md"), "Tuesday, on the phone");
		assert.equal(desk.get("p|system-prompt.md"), "Tuesday, on the phone");
		assert.equal(desk.get("s|compaction.thresholdTokens"), 90_000);
	});

	it("the phone on Monday, the desktop on Tuesday offline: the desktop's stays", async () => {
		const { w, desk } = await synced();
		desk.setOnline(false);
		w.server.set("p|system-prompt.md", "Monday, on the phone");
		w.pass(24 * HOUR);
		desk.set("p|system-prompt.md", "Tuesday, on the desktop");
		desk.set("s|agent.search.engine", "tavily");
		assert.deepEqual(await desk.sync.round(), { ok: false, reason: "offline" });
		w.pass(24 * HOUR);
		desk.setOnline(true);
		await desk.sync.round();
		assert.equal(w.server.get("p|system-prompt.md"), "Tuesday, on the desktop");
		assert.equal(w.server.get("s|agent.search.engine"), "tavily");
		assert.deepEqual(desk.all(), w.server.all());
	});

	it("a PC whose clock runs three hours ahead doesn't win with an older change", async () => {
		const { w, desk } = await synced({ skewMs: 3 * HOUR });
		desk.setOnline(false);
		desk.set("p|system-prompt.md", "first, on the desktop"); // true time: now
		desk.sync.detect();
		w.pass(HOUR);
		w.server.set("p|system-prompt.md", "an hour later, on the phone");
		w.pass(HOUR);
		desk.setOnline(true);
		await desk.sync.round();
		assert.equal(w.server.get("p|system-prompt.md"), "an hour later, on the phone");
		assert.equal(desk.get("p|system-prompt.md"), "an hour later, on the phone");
	});

	it("and one whose clock runs three hours behind doesn't lose with a newer change", async () => {
		const { w, desk } = await synced({ skewMs: -3 * HOUR });
		desk.setOnline(false);
		w.server.set("p|system-prompt.md", "first, on the phone");
		w.pass(HOUR);
		desk.set("p|system-prompt.md", "an hour later, on the desktop");
		desk.sync.detect();
		w.pass(HOUR);
		desk.setOnline(true);
		await desk.sync.round();
		assert.equal(w.server.get("p|system-prompt.md"), "an hour later, on the desktop");
		assert.equal(desk.get("p|system-prompt.md"), "an hour later, on the desktop");
	});

	it("a time from the future is cut back to now: it can't hold a setting for ever", async () => {
		const { w, desk } = await synced({ skewMs: 0 });
		const far = w.desktop("dev_cccccccccccccccc", { skewMs: 0 });
		void far;
		// A hand-made request with a time a year ahead.
		const state = stateFile(w.serverStateFile, isAuthorityMapsState);
		const authority = createMapsAuthority({ files: w.server.files, state, now: () => MONDAY + 2 * HOUR });
		assert.equal(authority.exchange("dev_aaaaaaaaaaaaaaaa", { cursor: 0, all: false, changes: [{ key: "s|agent.search.engine", value: "light", t: MONDAY + 365 * 24 * HOUR }] }).status, 200);
		assert.equal(state.read()!.items["s|agent.search.engine"]!.t, MONDAY + 2 * HOUR);
		void desk;
	});

	it("something removed is removed on the other side", async () => {
		const { w, desk } = await synced();
		desk.set("p|system-prompt.md", null);
		w.server.set("f|fold_1", null);
		assert.deepEqual(await desk.sync.round(), { ok: true, sent: 1, applied: 1 });
		assert.deepEqual(desk.all(), { "s|agent.search.engine": "brave" });
		assert.deepEqual(w.server.all(), { "s|agent.search.engine": "brave" });
	});

	it("changed here again while the request was under way: it isn't overwritten, and goes next round", async () => {
		const { w, desk } = await synced();
		w.server.set("s|agent.search.engine", "tavily");
		desk.hooks.duringRequest = () => { w.pass(1000); desk.set("s|agent.search.engine", "exa"); };
		await desk.sync.round();
		assert.equal(desk.get("s|agent.search.engine"), "exa");
		w.pass(10_000);
		await desk.sync.round();
		assert.equal(w.server.get("s|agent.search.engine"), "exa");
	});

	it("a value the server's file adjusts on the way in comes back adjusted, once", async () => {
		const { w, desk } = await synced();
		w.server.adjustWith((key, value) => (key === "s|graph.extractionChunkTokens" ? Math.min(Number(value), 16_384) : value));
		desk.set("s|graph.extractionChunkTokens", 99_999);
		assert.deepEqual(await desk.sync.round(), { ok: true, sent: 1, applied: 1 });
		assert.equal(desk.get("s|graph.extractionChunkTokens"), 16_384);
		w.pass(10_000);
		assert.deepEqual(await desk.sync.round(), { ok: true, sent: 0, applied: 0 });
	});

	it("two desktops and the phone end the same", async () => {
		const { w, desk } = await synced();
		const laptop = w.desktop("dev_bbbbbbbbbbbbbbbb");
		laptop.set("s|agent.search.engine", "brave");
		await laptop.sync.round();
		w.pass(HOUR);
		desk.set("x|n_1", { x: 1, y: 2 });
		w.pass(1000);
		laptop.set("x|n_1", { x: 5, y: 6 });
		w.pass(1000);
		w.server.set("s|dictation.language", "de");
		await desk.sync.round();
		await laptop.sync.round();
		await desk.sync.round();
		assert.deepEqual(desk.all(), w.server.all());
		assert.deepEqual(laptop.all(), w.server.all());
		assert.deepEqual(w.server.get("x|n_1"), { x: 5, y: 6 });
	});
});

describe("a file that is there but can't be read is left alone", () => {
	it("on the desktop: the server keeps its settings, and nothing is written into the damaged file", async () => {
		const w = world();
		const desk = w.desktop("dev_aaaaaaaaaaaaaaaa");
		desk.set("s|agent.search.engine", "brave");
		desk.set("x|n_1", { x: 1, y: 1 });
		await desk.sync.round();
		w.pass(HOUR);
		desk.damage("s");
		w.server.set("s|graph.rendering", false);
		w.server.set("x|n_1", { x: 3, y: 3 });
		assert.deepEqual(await desk.sync.round(), { ok: true, sent: 0, applied: 1 });
		assert.equal(w.server.get("s|agent.search.engine"), "brave", "not deleted because the desktop couldn't read its own");
		assert.deepEqual(desk.all(), { "x|n_1": { x: 3, y: 3 } });
	});

	it("on the server: a desktop's settings changes wait, and the desktop keeps its own", async () => {
		const w = world();
		const desk = w.desktop("dev_aaaaaaaaaaaaaaaa");
		desk.set("s|agent.search.engine", "brave");
		await desk.sync.round();
		w.pass(HOUR);
		w.server.damage("s");
		desk.set("s|agent.search.engine", "tavily");
		await desk.sync.round();
		assert.equal(desk.get("s|agent.search.engine"), "tavily");
		assert.equal(w.server.get("s|agent.search.engine"), null);
	});
});

describe("a server that lost its records", () => {
	it("asks the desktop for everything once, and the two are joined again", async () => {
		const w = world();
		const desk = w.desktop("dev_aaaaaaaaaaaaaaaa");
		desk.set("s|agent.search.engine", "brave");
		desk.set("f|fold_1", { id: "fold_1", name: "Physics", parentId: null, createdAt: "2026-10-01" });
		await desk.sync.round();
		w.pass(HOUR);
		w.resetServer();
		w.server.set("f|fold_1", null);
		w.server.set("x|n_9", { x: 9, y: 9 });
		assert.deepEqual(await desk.sync.round(), { ok: true, sent: 2, applied: 1 });
		assert.deepEqual(desk.requests.slice(1), [{ changes: 0, all: false }, { changes: 2, all: true }]);
		assert.deepEqual(desk.all(), w.server.all());
		assert.equal(Object.keys(w.server.all()).length, 3);
	});
});

describe("the vault's folder names", () => {
	it("go with the first round and again only when they change", async () => {
		const w = world();
		const desk = w.desktop("dev_aaaaaaaaaaaaaaaa");
		desk.setVault(["Journal", "Work"]);
		await desk.sync.round();
		await desk.sync.round();
		desk.setVault(["Journal", "Recipes", "Work"]);
		await desk.sync.round();
		desk.setVault(null); // the vault is offline: nothing is said
		await desk.sync.round();
		assert.deepEqual(w.folders, [["Journal", "Work"], ["Journal", "Recipes", "Work"]]);
		assert.deepEqual(desk.requests.map((r) => r.vaultFolders ?? null), [["Journal", "Work"], null, ["Journal", "Recipes", "Work"], null]);
	});

	it("only names: anything with a path in it is dropped by the server", () => {
		assert.equal(maps.isVaultFolderName("Work"), true);
		for (const bad of ["", "a/b", "a\\b", "..", ".", "x".repeat(300), 5, null]) assert.equal(maps.isVaultFolderName(bad), false, String(bad));
	});
});


describe("upstream 0.6.0: colors, and custom theme files", () => {
	const palette = (accent: string) => Object.fromEntries(THEME_COLOR_KEYS.map((key) => [key, key === "accent" ? accent : "#123456"]));
	const theme = (name: string, accent = "#ff8800") => ({ name, mode: "dark", colors: palette(accent) });

	it("color overrides are per device: none is read as a setting any more", () => {
		for (const key of COLOR_OVERRIDE_KEYS) {
			assert.deepEqual([...maps.settingsItems({ appearance: { colors: { [key]: "#010203" } } })], [], key);
		}
	});

	it("a theme item is a valid custom theme, under its own id", () => {
		const t = 1;
		assert.notEqual(maps.checkMapChange({ key: "t|dusk", value: theme("Dusk"), t }), null);
		assert.notEqual(maps.checkMapChange({ key: "t|dusk", value: null, t }), null, "deleting it");
		assert.equal(maps.checkMapChange({ key: "t|default", value: theme("Default"), t }), null, "a built-in theme can't be replaced");
		assert.equal(maps.checkMapChange({ key: "t|default", value: null, t }), null, "or deleted");
		assert.equal(maps.checkMapChange({ key: "t|../escape", value: theme("X"), t }), null);
		assert.equal(maps.checkMapChange({ key: "t|Dusk", value: theme("Dusk"), t }), null, "not the id grammar");
		assert.equal(maps.checkMapChange({ key: "t|dusk", value: { ...theme("Dusk"), mode: "dim" }, t }), null);
		assert.equal(maps.checkMapChange({ key: "t|dusk", value: { ...theme("Dusk"), colors: { accent: "red" } }, t }), null);
		assert.equal(maps.checkMapChange({ key: "t|dusk", value: { ...theme("Dusk"), extra: true }, t }), null, "only what the theme store would keep");
		assert.equal(maps.checkMapChange({ key: "t|dusk", value: theme(" Dusk "), t }), null);
	});

	it("first desktop: a theme only one side has is kept on both; the same id with different colors takes the desktop's", async () => {
		const w = world();
		const desk = w.desktop("dev_aaaaaaaaaaaaaaaa");
		desk.set("t|dusk", theme("Dusk", "#aa0000"));
		desk.set("t|desk-only", theme("Desk only"));
		w.server.set("t|dusk", theme("Dusk", "#00aa00"));
		w.server.set("t|phone-only", theme("Phone only"));
		w.pass(HOUR);
		await desk.sync.round();
		assert.deepEqual(desk.all(), w.server.all());
		assert.deepEqual(Object.keys(w.server.all()), ["t|desk-only", "t|dusk", "t|phone-only"]);
		assert.equal((w.server.get("t|dusk") as { colors: { accent: string } }).colors.accent, "#aa0000");
	});

	it("a desktop paired later: the server's theme stands, a new one is added, and later changes and deletions travel", async () => {
		const w = world();
		const desk = w.desktop("dev_aaaaaaaaaaaaaaaa");
		desk.set("t|dusk", theme("Dusk", "#aa0000"));
		await desk.sync.round();
		w.pass(HOUR);
		const laptop = w.desktop("dev_bbbbbbbbbbbbbbbb");
		laptop.set("t|dusk", theme("Dusk", "#0000aa"));
		laptop.set("t|laptop-only", theme("Laptop only"));
		await laptop.sync.round();
		assert.equal((laptop.get("t|dusk") as { colors: { accent: string } }).colors.accent, "#aa0000", "the server's is kept");
		assert.notEqual(w.server.get("t|laptop-only"), null, "one only the new PC has is added");

		w.pass(HOUR);
		laptop.set("t|dusk", null);
		laptop.set("t|laptop-only", theme("Laptop only", "#ffffff"));
		await laptop.sync.round();
		await desk.sync.round();
		assert.equal(desk.get("t|dusk"), null, "a deleted theme goes everywhere");
		assert.equal((desk.get("t|laptop-only") as { colors: { accent: string } }).colors.accent, "#ffffff");
		assert.deepEqual(desk.all(), w.server.all());
	});

	it("a damaged theme file is left alone on both sides; the others still sync", async () => {
		const w = world();
		const desk = w.desktop("dev_aaaaaaaaaaaaaaaa");
		desk.set("t|dusk", theme("Dusk"));
		desk.set("t|dawn", theme("Dawn"));
		await desk.sync.round();
		w.pass(HOUR);
		desk.damageKey("t|dusk");
		desk.set("t|dawn", theme("Dawn", "#000000"));
		assert.deepEqual(await desk.sync.round(), { ok: true, sent: 1, applied: 0 });
		assert.notEqual(w.server.get("t|dusk"), null, "not taken as deleted");
		assert.equal((w.server.get("t|dawn") as { colors: { accent: string } }).colors.accent, "#000000");
		// Changed on the server meanwhile: still not written over the damaged file.
		w.pass(HOUR);
		w.server.set("t|dusk", theme("Dusk", "#999999"));
		await desk.sync.round();
		assert.equal(desk.get("t|dusk"), null);
		desk.repairKey("t|dusk", theme("Dusk"));
		w.pass(1000);
		await desk.sync.round();
		assert.notEqual(desk.get("t|dusk"), null, "repaired: nothing was deleted on either side");
		assert.notEqual(w.server.get("t|dusk"), null);
	});
});

describe("a setting a file drops on the way in", () => {
	it("an old record naming it on either side: the deletion is exchanged once, then nothing; it never stalls or comes back", async () => {
		const w = world();
		const desk = w.desktop("dev_aaaaaaaaaaaaaaaa");
		desk.set("s|compaction.includeReasoning", true);
		desk.set("s|agent.search.engine", "brave");
		await desk.sync.round();
		w.pass(HOUR);
		desk.set("s|compaction.includeReasoning", false);
		desk.sync.detect(); // a change noted before the update, never sent
		assert.equal(w.server.get("s|compaction.includeReasoning"), true);

		// Both sides update: the settings store no longer reads the key, and drops it on every write.
		const drop = (key: string, value: unknown) => (key === "s|compaction.includeReasoning" ? null : value);
		for (const side of [w.server, desk]) { side.set("s|compaction.includeReasoning", null); side.adjustWith(drop); }
		w.pass(HOUR);
		assert.deepEqual(await desk.sync.round(), { ok: true, sent: 1, applied: 0 }, "the desktop says it is gone");
		assert.equal(w.server.get("s|compaction.includeReasoning"), null);
		w.pass(10_000);
		assert.deepEqual(await desk.sync.round(), { ok: true, sent: 0, applied: 0 }, "and then there is nothing more to say");
		w.pass(10_000);
		assert.deepEqual(await desk.sync.round(), { ok: true, sent: 0, applied: 0 });
		assert.equal(desk.get("s|agent.search.engine"), "brave", "the other settings carry on");

		// A desktop that still sends a value for it (a hand-edited state, say): taken, dropped, and answered as gone.
		const laptop = w.desktop("dev_bbbbbbbbbbbbbbbb");
		laptop.adjustWith(drop);
		laptop.set("s|compaction.includeReasoning", false);
		w.pass(HOUR);
		assert.equal((await laptop.sync.round()).ok, true);
		assert.equal(w.server.get("s|compaction.includeReasoning"), null);
		assert.equal(laptop.get("s|compaction.includeReasoning"), null, "it drops out there too");
		w.pass(10_000);
		assert.deepEqual(await laptop.sync.round(), { ok: true, sent: 0, applied: 0 });
		assert.deepEqual(await desk.sync.round(), { ok: true, sent: 0, applied: 0 });
	});
});

describe("first exchanges that come in pages", () => {
	it("two desktops whose first exchanges overlap: only the first brings its settings", async () => {
		const w = world({ page: { items: 2, bytes: 1 << 20 } });
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let held = false, pages = 0;
		// Held after its first page reached the server, before its second.
		const one = w.desktop("dev_aaaaaaaaaaaaaaaa", { hold: async () => { if (++pages === 2) { held = true; await gate; } } });
		const two = w.desktop("dev_bbbbbbbbbbbbbbbb");
		for (const [key, a, b] of [["s|agent.search.engine", "brave", "tavily"], ["s|dictation.language", "sv", "de"], ["s|graph.enabled", true, false]] as const) { one.set(key, a); two.set(key, b); }
		w.server.set("s|agent.search.engine", "exa");
		const first = one.sync.round();
		while (!held) await new Promise((resolve) => setImmediate(resolve));
		assert.equal((await two.sync.round()).ok, true);
		release();
		assert.equal((await first).ok, true);
		await two.sync.round();
		for (const side of [w.server, one, two]) {
			assert.equal(side.get("s|agent.search.engine"), "brave");
			assert.equal(side.get("s|dictation.language"), "sv");
			assert.equal(side.get("s|graph.enabled"), true);
		}
	});
});

describe("appearance is per device now (retired), with no protocol change", () => {
	const A = "dev_aaaaaaaaaaaaaaaa", B = "dev_bbbbbbbbbbbbbbbb";
	const THEME = "s|appearance.theme", SIZE = "s|appearance.proseFontSize", ACCENT = "s|appearance.colors.accent";
	const json = (file: string) => JSON.parse(fs.readFileSync(file, "utf-8")) as { known?: Record<string, unknown>; pending?: Record<string, unknown>; items?: Record<string, unknown>; devices?: string[] };
	const retired = (table: Record<string, unknown> | undefined) => Object.keys(table ?? {}).filter(maps.isRetiredSettingKey);
	const stamp = (file: string) => { const st = fs.statSync(file); return `${st.ino}:${st.mtimeMs}:${st.size}`; };
	const look = (side: { get(key: string): unknown }) => [side.get(THEME), side.get(SIZE), side.get(ACCENT)];

	/** An old pair, synced and with an appearance change on each side not yet exchanged; then both update. */
	async function updatedPair() {
		const w = world({ oldServer: true });
		const desk = w.desktop(A, { old: true });
		desk.set(THEME, "rose-pine"); desk.set(SIZE, 18); desk.set(ACCENT, "#ff0000"); desk.set("s|dictation.language", "sv");
		w.server.set(THEME, "nord");
		await desk.sync.round();
		assert.deepEqual(look(w.server), ["rose-pine", 18, "#ff0000"], "the old builds synced it");
		w.pass(HOUR);
		desk.set(THEME, "dracula");
		desk.sync.detect();
		w.server.set(SIZE, 22);
		assert.notDeepEqual(retired(json(desk.stateFile).known), []);
		assert.notDeepEqual(retired(json(desk.stateFile).pending), []);
		assert.notDeepEqual(retired(json(w.serverStateFile).items), []);
		w.upgradeServer();
		desk.upgrade();
		w.pass(HOUR);
		// After the update each side changes its own, a reset to the default included.
		desk.set(ACCENT, "#00ff00");
		desk.set(SIZE, null);
		w.server.set(THEME, "nord");
		desk.set("s|dictation.language", "de");
		w.server.set("s|graph.rendering", false);
		assert.equal((await desk.sync.round()).ok, true);
		w.pass(10_000);
		assert.equal((await desk.sync.round()).ok, true);
		return { w, desk };
	}

	it("both sides updated: neither side's appearance changes, the states forget it, the other settings still travel", async () => {
		const { w, desk } = await updatedPair();
		assert.deepEqual(look(desk), ["dracula", null, "#00ff00"]);
		assert.deepEqual(look(w.server), ["nord", 22, "#ff0000"], "nothing reset, nothing taken");
		assert.equal(w.server.get("s|dictation.language"), "de");
		assert.equal(desk.get("s|graph.rendering"), false);
		assert.deepEqual(retired(json(desk.stateFile).known), []);
		assert.deepEqual(retired(json(desk.stateFile).pending), []);
		assert.deepEqual(retired(json(w.serverStateFile).items), []);
		assert.deepEqual(desk.sentKeys.slice(1).flat().filter(maps.isRetiredSettingKey), [], "the updated desktop sends none");
	});

	it("after the one-time purge an idle round writes no state file on either side", async () => {
		const { w, desk } = await updatedPair();
		const before = [stamp(desk.stateFile), stamp(w.serverStateFile)];
		for (let i = 0; i < 3; i++) {
			w.pass(10_000);
			desk.sync.detect();
			assert.deepEqual(await desk.sync.round(), { ok: true, sent: 0, applied: 0 });
		}
		assert.deepEqual([stamp(desk.stateFile), stamp(w.serverStateFile)], before);
	});

	it("the server's own look at its files (detect) purges once, and then writes nothing", async () => {
		const w = world({ oldServer: true });
		const desk = w.desktop(A, { old: true });
		desk.set(THEME, "rose-pine");
		await desk.sync.round();
		w.upgradeServer();
		const authority = createMapsAuthority({ files: w.server.files, state: stateFile(w.serverStateFile, isAuthorityMapsState), now: () => MONDAY + HOUR });
		const seq = (json(w.serverStateFile) as { seq: number }).seq;
		authority.detect();
		assert.deepEqual(retired(json(w.serverStateFile).items), []);
		assert.equal((json(w.serverStateFile) as { seq: number }).seq, seq, "forgetting a key is no change: the counter doesn't move");
		const after = stamp(w.serverStateFile);
		authority.detect();
		assert.equal(stamp(w.serverStateFile), after);
		assert.equal(w.server.get(THEME), "rose-pine");
	});

	it("a new server and an old desktop, ongoing: the desktop's appearance changes are answered \"same\", and nothing changes on either side", async () => {
		const w = world({ oldServer: true });
		const desk = w.desktop(A, { old: true });
		desk.set(THEME, "rose-pine"); desk.set("s|dictation.language", "sv");
		await desk.sync.round();
		w.pass(HOUR);
		w.upgradeServer();
		w.server.set(THEME, "nord");
		w.server.set(ACCENT, "#ff0000");
		w.server.set("s|graph.rendering", false);
		desk.set(THEME, "dracula");
		desk.set(SIZE, 20);
		assert.deepEqual(await desk.sync.round(), { ok: true, sent: 2, applied: 1 });
		assert.deepEqual(json(desk.stateFile).pending, {}, "the old desktop agreed, and won't send them again");
		assert.deepEqual(look(w.server), ["nord", null, "#ff0000"]);
		assert.deepEqual(look(desk), ["dracula", 20, null]);
		assert.equal(desk.get("s|graph.rendering"), false);
		w.pass(HOUR);
		desk.set("s|dictation.language", "de");
		assert.deepEqual(await desk.sync.round(), { ok: true, sent: 1, applied: 0 });
		assert.equal(w.server.get("s|dictation.language"), "de");
		w.pass(10_000);
		assert.deepEqual(await desk.sync.round(), { ok: true, sent: 0, applied: 0 });
		assert.deepEqual(retired(json(w.serverStateFile).items), []);
	});

	it("a new server and an old desktop's first exchange, as the first desktop: no appearance is taken, reset or sent back", async () => {
		const w = world();
		w.server.hideRetired();
		w.server.set(THEME, "nord"); w.server.set(ACCENT, "#ff0000"); w.server.set("s|graph.rendering", false);
		// A table an old build left, with appearance in it and no desktop on record yet.
		fs.mkdirSync(path.dirname(w.serverStateFile), { recursive: true });
		fs.writeFileSync(w.serverStateFile, JSON.stringify({ version: 1, seq: 3, devices: [], items: {
			[THEME]: { h: maps.itemHash("nord"), t: MONDAY, seq: 1 },
			[ACCENT]: { h: maps.itemHash("#ff0000"), t: MONDAY, seq: 2 },
			"s|graph.rendering": { h: maps.itemHash(false), t: MONDAY, seq: 3 },
		} }));
		const desk = w.desktop(A, { old: true });
		desk.set(THEME, "rose-pine"); desk.set(SIZE, 18); desk.set("s|dictation.language", "sv");
		w.pass(HOUR);
		assert.equal((await desk.sync.round()).ok, true);
		assert.deepEqual(look(w.server), ["nord", null, "#ff0000"]);
		assert.deepEqual(look(desk), ["rose-pine", 18, null]);
		assert.equal(w.server.get("s|dictation.language"), "sv", "the first desktop's settings still win");
		assert.equal(w.server.get("s|graph.rendering"), null, "and one it hasn't set still goes back to its default");
		assert.deepEqual(json(desk.stateFile).pending, {});
		assert.deepEqual(retired(json(w.serverStateFile).items), []);
		assert.deepEqual(json(w.serverStateFile).devices, [A]);
		w.pass(10_000);
		assert.deepEqual(await desk.sync.round(), { ok: true, sent: 0, applied: 0 });
	});

	it("a new server and an old desktop's first exchange, as a later desktop: its appearance isn't put back to the server's", async () => {
		const w = world({ oldServer: true });
		const first = w.desktop(A, { old: true });
		first.set(THEME, "rose-pine"); first.set("s|dictation.language", "sv");
		await first.sync.round();
		w.pass(HOUR);
		w.upgradeServer();
		const laptop = w.desktop(B, { old: true });
		laptop.set(THEME, "dracula"); laptop.set(SIZE, 20);
		assert.equal((await laptop.sync.round()).ok, true);
		assert.deepEqual(look(laptop), ["dracula", 20, null], "not the server's theme, and not reset to the default");
		assert.equal(laptop.get("s|dictation.language"), "sv", "the server's other settings still stand");
		assert.equal(w.server.get(THEME), "rose-pine");
		assert.equal(w.server.get(SIZE), null);
		assert.deepEqual(json(laptop.stateFile).pending, {});
		w.pass(10_000);
		assert.deepEqual(await laptop.sync.round(), { ok: true, sent: 0, applied: 0 });
		assert.deepEqual(look(first), ["rose-pine", null, null]);
	});

	it("an old server and a new desktop, ongoing: the desktop sends no appearance, takes none, and the server's stays", async () => {
		const w = world({ oldServer: true });
		const desk = w.desktop(A, { old: true });
		desk.set(THEME, "rose-pine"); desk.set(SIZE, 18); desk.set("s|dictation.language", "sv");
		await desk.sync.round();
		w.pass(HOUR);
		desk.set(THEME, "dracula");
		desk.sync.detect(); // noted by the old build, never sent
		desk.upgrade();
		const from = desk.sentKeys.length;
		desk.set(ACCENT, "#00ff00");
		desk.set(SIZE, null);
		desk.set("s|graph.rendering", false);
		w.server.set(THEME, "nord");
		w.server.set("s|dictation.language", "de");
		assert.equal((await desk.sync.round()).ok, true);
		w.pass(10_000);
		assert.equal((await desk.sync.round()).ok, true);
		assert.deepEqual(desk.sentKeys.slice(from).flat().filter((key) => key.startsWith("s|appearance")), []);
		assert.deepEqual(desk.sentKeys.slice(from).flat(), ["s|graph.rendering"]);
		assert.deepEqual(look(w.server), ["nord", 18, null], "the old server's appearance is untouched");
		assert.deepEqual(look(desk), ["dracula", null, "#00ff00"]);
		assert.equal(w.server.get("s|graph.rendering"), false);
		assert.equal(desk.get("s|dictation.language"), "de");
		assert.deepEqual(retired(json(desk.stateFile).known), []);
		assert.deepEqual(retired(json(desk.stateFile).pending), []);
		w.pass(10_000);
		assert.deepEqual(await desk.sync.round(), { ok: true, sent: 0, applied: 0 });
	});

	it("custom theme files still travel both ways", async () => {
		const palette = (accent: string) => Object.fromEntries(THEME_COLOR_KEYS.map((key) => [key, key === "accent" ? accent : "#123456"]));
		const w = world();
		w.server.hideRetired();
		const desk = w.desktop(A);
		desk.hideRetired();
		desk.set("t|dusk", { name: "Dusk", mode: "dark", colors: palette("#aa0000") });
		desk.set(THEME, "dusk");
		await desk.sync.round();
		assert.deepEqual(w.server.get("t|dusk"), desk.get("t|dusk"));
		assert.equal(w.server.get(THEME), null, "the theme a device uses stays its own");
		w.pass(HOUR);
		w.server.set("t|dawn", { name: "Dawn", mode: "light", colors: palette("#00aa00") });
		w.server.set("t|dusk", { name: "Dusk", mode: "dark", colors: palette("#0000aa") });
		assert.deepEqual(await desk.sync.round(), { ok: true, sent: 0, applied: 2 });
		assert.deepEqual(desk.get("t|dawn"), w.server.get("t|dawn"));
		assert.equal((desk.get("t|dusk") as { colors: { accent: string } }).colors.accent, "#0000aa");
	});
});
