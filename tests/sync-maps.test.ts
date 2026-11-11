/**
 * Cloud sync Phase 5, slice 5 (docs/cloud-sync.md): the files that sync one
 * item at a time, latest change wins.
 *
 * Pins the owner's decisions: the settings split (what travels and what
 * stays per device); at a desktop's first sync the desktop's value is kept
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
const { stateFile } = await import("../src/store/sync/state-file.ts");
const { createMapsAuthority, createMapsDesktop, isAuthorityMapsState, isDesktopMapsState } = await import("../src/server/sync/maps-sync.ts");
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
	let adjust: (key: string, value: unknown) => unknown = (_key, value) => value;
	const files: MapFiles = {
		read: () => ({ items: new Map(items), unreadable: new Set(unreadable), fileTimes: new Map() }),
		apply(changes) {
			for (const [key, value] of changes) {
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
		adjustWith(fn: typeof adjust) { adjust = fn; },
	};
}

let worlds = 0;
function world() {
	const root = path.join(TMP, `w${++worlds}`);
	/** The true time. Each side reads it through its own (possibly wrong) clock. */
	let time = MONDAY;
	const server = memoryFiles(() => time);
	const folders: string[][] = [];
	let serverState = stateFile(path.join(root, "server", "sync", "maps.json"), isAuthorityMapsState);
	let authority = createMapsAuthority({ files: server.files, state: serverState, now: () => time, onVaultFolders: (names) => folders.push(names) });

	function desktop(deviceId: string, opts: { skewMs?: number } = {}) {
		const skew = opts.skewMs ?? 0;
		const local = () => time + skew;
		const side = memoryFiles(local);
		let online = true;
		let vault: string[] | null = null;
		const hooks: { duringRequest?: () => void } = {};
		const requests: Array<{ changes: number; all: boolean; vaultFolders?: string[] }> = [];
		const sync = createMapsDesktop({
			files: side.files,
			state: stateFile(path.join(root, deviceId, "sync", "maps-desktop.json"), isDesktopMapsState),
			identity: () => ({ server: "https://learn.example.com", deviceId }),
			request: async <T>(_pathname: string, init: { method?: string; body?: unknown } = {}) => {
				if (!online) return { ok: false, reason: "offline" } as SyncReply<T>;
				const body = JSON.parse(JSON.stringify(init.body)) as { changes: unknown[]; all: boolean; vaultFolders?: string[] };
				requests.push({ changes: body.changes.length, all: body.all, ...(body.vaultFolders ? { vaultFolders: body.vaultFolders } : {}) });
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
		});
		return { ...side, sync, requests, hooks, stateFile: path.join(root, deviceId, "sync", "maps-desktop.json"), setOnline: (value: boolean) => { online = value; }, setVault: (names: string[] | null) => { vault = names; } };
	}
	return {
		root, server, folders, desktop,
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
		appearance: { mode: "light", background: "#101010", fontFamily: "Georgia", proseFontSize: 18, sessionNameSerif: false, mdRendering: { headingWeight: 700, boldColor: "#ff0000", italicColor: null } },
		graph: { enabled: true, rendering: false, extractionChunkTokens: 2048 },
		compaction: { thresholdTokens: 90_000 },
		agent: {
			models: { extractor: { model: "m" } },
			tools: { web_search: false, read_file: true },
			search: { engine: "brave" },
			graphTools: { enabled: false },
			prompts: { "teacher/20-teaching.md": true },
			fileAccess: { restricted: true, folders: ["~/Documents"] },
		},
		keyboard: { "toggle-notes": "Ctrl+Shift+N" },
	};

	it("what travels: appearance without the font, dictation language, graph, compaction, agent switches, prompt switches", () => {
		assert.deepEqual(Object.fromEntries(maps.settingsItems(record)), {
			"s|appearance.mode": "light",
			"s|appearance.background": "#101010",
			"s|appearance.proseFontSize": 18,
			"s|appearance.sessionNameSerif": false,
			"s|appearance.mdRendering.headingWeight": 700,
			"s|appearance.mdRendering.boldColor": "#ff0000",
			"s|appearance.mdRendering.italicColor": null,
			"s|dictation.language": "sv",
			"s|graph.enabled": true,
			"s|graph.rendering": false,
			"s|graph.extractionChunkTokens": 2048,
			"s|compaction.thresholdTokens": 90_000,
			"s|agent.search.engine": "brave",
			"s|agent.graphTools.enabled": false,
			"s|agent.tools|web_search": false,
			"s|agent.tools|read_file": true,
			"s|agent.prompts|teacher/20-teaching.md": true,
		});
	});

	it("applying items changes those settings and nothing else in the record", () => {
		const next = maps.withSettingsItems(record, new Map<string, unknown>([
			["s|appearance.mode", "dark"],
			["s|agent.tools|web_search", null],
			["s|agent.tools|run_code", false],
			["s|compaction.thresholdTokens", null],
			["s|models.strong", { provider: "evil", model: "z" }],
			["s|agent.fileAccess", { restricted: false, folders: [] }],
		]));
		assert.equal(next.appearance.mode, "dark");
		assert.deepEqual(next.agent.tools, { read_file: true, run_code: false });
		assert.equal("compaction" in next, false, "an emptied section goes");
		for (const section of ["general", "claudeCode", "models", "customProvider", "keyboard"] as const) assert.deepEqual(next[section], record[section]);
		assert.equal(next.appearance.fontFamily, "Georgia");
		assert.deepEqual(next.agent.fileAccess, record.agent.fileAccess);
		assert.deepEqual(next.agent.models, record.agent.models);
		assert.equal(record.appearance.mode, "light", "the record passed in is not changed");
	});

	it("a request can't reach a per-device setting, whatever it says", () => {
		const t = 1;
		for (const key of ["s|models.strong", "s|appearance.fontFamily", "s|agent.fileAccess", "s|agent.models|extractor", "s|general.autoUpdate", "s|claudeCode.enabled", "s|customProvider.baseUrl", "s|keyboard.toggle-notes", "s|agent.tools|", "s|", "z|x", "appearance.mode"]) {
			assert.equal(maps.checkMapChange({ key, value: true, t }), null, key);
			if (key.startsWith("s|")) assert.equal(maps.checkMapChange({ key, value: null, t }), null, `${key} (removal)`);
		}
		assert.notEqual(maps.checkMapChange({ key: "s|appearance.mode", value: "dark", t }), null);
		assert.notEqual(maps.checkMapChange({ key: "s|agent.tools|web_search", value: false, t }), null);
		assert.equal(maps.checkMapChange({ key: "s|appearance.mode", value: { nested: true }, t }), null);
		assert.equal(maps.checkMapChange({ key: "p|teacher/20-teaching.md", value: 5, t }), null);
		assert.equal(maps.checkMapChange({ key: "f|fold_1", value: { id: "fold_2", name: "x", parentId: null, createdAt: "2026" }, t }), null, "a folder under another folder's key");
		assert.equal(maps.checkMapChange({ key: "x|n_1", value: { x: 1, y: Number.NaN }, t }), null);
		assert.equal(maps.checkMapChange({ key: "x|n_1", value: { x: 1, y: 2 }, t: -1 }), null);
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
		w.server.set("s|appearance.mode", "light");
		desk.set("s|appearance.mode", "dark");
		desk.sync.detect();
		assert.equal(fs.existsSync(w.root), false);
	});
});

describe("a desktop's first sync", () => {
	function before() {
		const w = world();
		const desk = w.desktop("dev_aaaaaaaaaaaaaaaa");
		// The same setting, different on each side.
		desk.set("s|appearance.mode", "dark");
		w.server.set("s|appearance.mode", "light");
		// Set on the server only: on the desktop it is at its default.
		w.server.set("s|appearance.proseFontSize", 20);
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
			"s|appearance.mode": "dark",
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
		laptop.set("s|appearance.mode", "light");
		w.pass(HOUR);
		await laptop.sync.round();
		assert.equal(w.server.get("s|appearance.mode"), "light", "nobody is on record as having synced, so it brings its values");
	});
});

describe("a PC paired later takes the server's settings (only the first PC brings its own)", () => {
	/** The first PC has synced; the server now carries its settings. */
	async function withFirstPc() {
		const w = world();
		const desk = w.desktop("dev_aaaaaaaaaaaaaaaa");
		desk.set("s|appearance.mode", "dark");
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
		laptop.set("s|appearance.mode", "light"); // differs from the server's
		laptop.set("s|appearance.proseFontSize", 22); // not set on the server
		laptop.set("s|agent.tools|web_search", false); // not set on the server
		await laptop.sync.round();
		assert.equal(w.server.get("s|appearance.mode"), "dark");
		assert.equal(laptop.get("s|appearance.mode"), "dark");
		assert.equal(laptop.get("s|dictation.language"), "sv", "set on the server only: the laptop takes it");
		assert.equal(w.server.get("s|appearance.proseFontSize"), null, "the server's stays not set");
		assert.equal(laptop.get("s|appearance.proseFontSize"), null, "and the laptop goes back to the default");
		assert.equal(laptop.get("s|agent.tools|web_search"), null);
		assert.deepEqual(laptop.all(), w.server.all());
		// It doesn't come back at the next round, on either PC.
		w.pass(10_000);
		assert.deepEqual(await laptop.sync.round(), { ok: true, sent: 0, applied: 0 });
		await desk.sync.round();
		assert.equal(desk.get("s|appearance.mode"), "dark");
		assert.equal(desk.get("s|appearance.proseFontSize"), null);
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
		laptop.set("s|appearance.mode", "light");
		await laptop.sync.round();
		assert.equal(laptop.get("s|appearance.mode"), "dark");
		w.pass(HOUR);
		laptop.set("s|appearance.mode", "light");
		await laptop.sync.round();
		assert.equal(w.server.get("s|appearance.mode"), "light");
		await desk.sync.round();
		assert.equal(desk.get("s|appearance.mode"), "light");
	});

	it("the first PC removed and paired anew is still not a first PC", async () => {
		const { w } = await withFirstPc();
		// A new device id (it paired with another server in between, or was reinstalled).
		const again = w.desktop("dev_cccccccccccccccc");
		again.set("s|appearance.mode", "light");
		await again.sync.round();
		assert.equal(w.server.get("s|appearance.mode"), "dark");
	});
});

describe("afterwards, the latest change wins", () => {
	async function synced(opts: { skewMs?: number } = {}) {
		const w = world();
		const desk = w.desktop("dev_aaaaaaaaaaaaaaaa", opts);
		desk.set("s|appearance.mode", "dark");
		desk.set("f|fold_1", { id: "fold_1", name: "Physics", parentId: null, createdAt: "2026-10-01" });
		desk.set("p|system-prompt.md", "v1");
		await desk.sync.round();
		w.pass(HOUR);
		return { w, desk };
	}

	it("a change on the desktop reaches the server, and one on the phone reaches the desktop", async () => {
		const { w, desk } = await synced();
		desk.set("s|appearance.mode", "light");
		assert.deepEqual(await desk.sync.round(), { ok: true, sent: 1, applied: 0 });
		assert.equal(w.server.get("s|appearance.mode"), "light");
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
		w.server.set("s|appearance.background", "#222222");
		w.pass(24 * HOUR);
		desk.setOnline(true);
		assert.deepEqual(await desk.sync.round(), { ok: true, sent: 1, applied: 2 });
		assert.equal(w.server.get("p|system-prompt.md"), "Tuesday, on the phone");
		assert.equal(desk.get("p|system-prompt.md"), "Tuesday, on the phone");
		assert.equal(desk.get("s|appearance.background"), "#222222");
	});

	it("the phone on Monday, the desktop on Tuesday offline: the desktop's stays", async () => {
		const { w, desk } = await synced();
		desk.setOnline(false);
		w.server.set("p|system-prompt.md", "Monday, on the phone");
		w.pass(24 * HOUR);
		desk.set("p|system-prompt.md", "Tuesday, on the desktop");
		desk.set("s|appearance.mode", "light");
		assert.deepEqual(await desk.sync.round(), { ok: false, reason: "offline" });
		w.pass(24 * HOUR);
		desk.setOnline(true);
		await desk.sync.round();
		assert.equal(w.server.get("p|system-prompt.md"), "Tuesday, on the desktop");
		assert.equal(w.server.get("s|appearance.mode"), "light");
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
		assert.equal(authority.exchange("dev_aaaaaaaaaaaaaaaa", { cursor: 0, all: false, changes: [{ key: "s|appearance.mode", value: "light", t: MONDAY + 365 * 24 * HOUR }] }).status, 200);
		assert.equal(state.read()!.items["s|appearance.mode"]!.t, MONDAY + 2 * HOUR);
		void desk;
	});

	it("something removed is removed on the other side", async () => {
		const { w, desk } = await synced();
		desk.set("p|system-prompt.md", null);
		w.server.set("f|fold_1", null);
		assert.deepEqual(await desk.sync.round(), { ok: true, sent: 1, applied: 1 });
		assert.deepEqual(desk.all(), { "s|appearance.mode": "dark" });
		assert.deepEqual(w.server.all(), { "s|appearance.mode": "dark" });
	});

	it("changed here again while the request was under way: it isn't overwritten, and goes next round", async () => {
		const { w, desk } = await synced();
		w.server.set("s|appearance.mode", "light");
		desk.hooks.duringRequest = () => { w.pass(1000); desk.set("s|appearance.mode", "dark-again"); };
		await desk.sync.round();
		assert.equal(desk.get("s|appearance.mode"), "dark-again");
		w.pass(10_000);
		await desk.sync.round();
		assert.equal(w.server.get("s|appearance.mode"), "dark-again");
	});

	it("a value the server's file adjusts on the way in comes back adjusted, once", async () => {
		const { w, desk } = await synced();
		w.server.adjustWith((key, value) => (key === "s|appearance.proseFontSize" ? Math.min(Number(value), 24) : value));
		desk.set("s|appearance.proseFontSize", 99);
		assert.deepEqual(await desk.sync.round(), { ok: true, sent: 1, applied: 1 });
		assert.equal(desk.get("s|appearance.proseFontSize"), 24);
		w.pass(10_000);
		assert.deepEqual(await desk.sync.round(), { ok: true, sent: 0, applied: 0 });
	});

	it("two desktops and the phone end the same", async () => {
		const { w, desk } = await synced();
		const laptop = w.desktop("dev_bbbbbbbbbbbbbbbb");
		laptop.set("s|appearance.mode", "dark");
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
		desk.set("s|appearance.mode", "dark");
		desk.set("x|n_1", { x: 1, y: 1 });
		await desk.sync.round();
		w.pass(HOUR);
		desk.damage("s");
		w.server.set("s|graph.rendering", false);
		w.server.set("x|n_1", { x: 3, y: 3 });
		assert.deepEqual(await desk.sync.round(), { ok: true, sent: 0, applied: 1 });
		assert.equal(w.server.get("s|appearance.mode"), "dark", "not deleted because the desktop couldn't read its own");
		assert.deepEqual(desk.all(), { "x|n_1": { x: 3, y: 3 } });
	});

	it("on the server: a desktop's settings changes wait, and the desktop keeps its own", async () => {
		const w = world();
		const desk = w.desktop("dev_aaaaaaaaaaaaaaaa");
		desk.set("s|appearance.mode", "dark");
		await desk.sync.round();
		w.pass(HOUR);
		w.server.damage("s");
		desk.set("s|appearance.mode", "light");
		await desk.sync.round();
		assert.equal(desk.get("s|appearance.mode"), "light");
		assert.equal(w.server.get("s|appearance.mode"), null);
	});
});

describe("a server that lost its records", () => {
	it("asks the desktop for everything once, and the two are joined again", async () => {
		const w = world();
		const desk = w.desktop("dev_aaaaaaaaaaaaaaaa");
		desk.set("s|appearance.mode", "dark");
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
