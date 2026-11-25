/**
 * Cloud sync (docs/fork/cloud-sync.md) and upstream 0.7.0's folder Delete:
 * the sidebar deletes a folder, its subfolders and every session inside
 * (`DELETE /api/graph/sources/folders/<id>`). This process plays the cloud
 * server through the REAL route and stores; one desktop is built over its
 * own data folder (sessions on disk, its graph and small files in memory)
 * and its requests are delivered straight to the server's real authorities.
 *
 * Pins: the folder delete is logged as a named deletion (`delete-sources`,
 * never a `rewrite`), so the desktop repeats it; after the rounds both sides
 * have the same session files, folders, placements and graph, for both
 * modes; an idle round afterwards writes nothing; a folder with a session
 * the desktop holds is refused with nothing deleted; and moving that session
 * here leaves the reviewed scope as it was.
 *
 * LH_DATA_DIR and LH_AUTH_FILE are redirected BEFORE the first config import.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sync-folder-delete-"));
const SERVER = path.join(TMP, "server", "data");
const DESK_DIR = path.join(TMP, "desk", "data");
process.env.LH_AUTH_FILE = path.join(TMP, "server", "secrets", "auth.json");
process.env.LH_DATA_DIR = SERVER;
process.env.LH_SERVER_MODE = "1";
process.env.LH_SYNC_LOOP = "off";

const { DELETE } = await import("../app/api/graph/sources/folders/[id]/route.ts");
const { stores } = await import("../src/server/stores.ts");
const { sourceDirectory } = await import("../src/server/source-organization.ts");
const { folderDeletionScope } = await import("../src/core/session-folders.ts");
const { syncAuthority } = await import("../src/server/sync/engine.ts");
const { graphAuthority } = await import("../src/server/sync/graph-engine.ts");
const { mapsAuthority } = await import("../src/server/sync/maps-engine.ts");
const { createDesktopSync, isDesktopState } = await import("../src/server/sync/desktop-sync.ts");
const { createGraphDesktop } = await import("../src/server/sync/graph-sync.ts");
const { createMapsDesktop, isDesktopMapsState } = await import("../src/server/sync/maps-sync.ts");
const { sessionFiles, sessionDirsUnder } = await import("../src/store/sync/session-files.ts");
const { stateFile } = await import("../src/store/sync/state-file.ts");
const { makeFirstSyncBackup } = await import("../src/store/sync/backup.ts");
const { desktopGraphJournal } = await import("../src/store/sync/graph-journal.ts");
const graphLog = await import("../src/core/sync/graph-log.ts");
const { CLOUD_HOLDER, HELD_ELSEWHERE_CODE } = await import("../src/core/sync/sessions.ts");
const { CURRENT_CHAT_VERSION } = await import("../src/core/contracts/chat.ts");
import type { SyncReply } from "../src/server/sync/client.ts";
import type { AuthorityReply } from "../src/server/sync/authority.ts";
import type { MapFiles, MapItem } from "../src/server/sync/map-views.ts";
import type { GraphNode } from "../src/core/contracts.ts";
import type { LoggedEntry } from "../src/store/sync/graph-journal.ts";

after(() => {
	delete process.env.LH_SERVER_MODE;
	delete process.env.LH_SYNC_LOOP;
	fs.rmSync(TMP, { recursive: true, force: true });
});

const DESK = "dev_aaaaaaaaaaaaaaaa";
const asReply = <T>(result: AuthorityReply): SyncReply<T> => {
	const copy = JSON.parse(JSON.stringify(result)) as AuthorityReply;
	return copy.status === 200
		? { ok: true, body: copy.body as T }
		: { ok: false, reason: "refused", status: copy.status, code: typeof copy.body.code === "string" ? copy.body.code : null, error: String(copy.body.error), body: copy.body };
};
const wire = (body: unknown) => (body === undefined ? undefined : JSON.parse(JSON.stringify(body)) as unknown);

// ── the desktop ───────────────────────────────────────────────────────────

const deskSessions = createDesktopSync({
	files: sessionFiles(sessionDirsUnder(DESK_DIR)),
	state: stateFile(path.join(DESK_DIR, "sync", "desktop.json"), isDesktopState),
	identity: () => ({ server: "https://learn.example.com", deviceId: DESK }),
	request: async <T>(pathname: string, init: { method?: string; body?: unknown } = {}) => {
		const body = wire(init.body);
		const method = init.method ?? (body === undefined ? "GET" : "POST");
		const take = /^\/api\/sync\/sessions\/([^/]+)\/take$/.exec(pathname)?.[1];
		if (take) return asReply<T>(syncAuthority().takeOver(DESK, decodeURIComponent(take), (body as { force?: boolean }).force === true));
		const id = /^\/api\/sync\/sessions\/([^/]+)$/.exec(pathname)?.[1];
		if (!id) return asReply<T>(syncAuthority().exchange(DESK, body));
		const chatId = decodeURIComponent(id);
		return asReply<T>(method === "GET" ? syncAuthority().fetch(DESK, chatId)
			: method === "PUT" ? syncAuthority().store(DESK, chatId, body)
			: syncAuthority().remove(DESK, chatId));
	},
	now: Date.now,
	makeBackup: () => makeFirstSyncBackup(DESK_DIR),
});

const deskGraph = graphLog.memoryGraphStore(graphLog.emptyLedgers());
const deskGraphSync = createGraphDesktop({
	store: deskGraph,
	journal: desktopGraphJournal(path.join(DESK_DIR, "sync")),
	request: async <T>(pathname: string, init: { method?: string; body?: unknown } = {}) => {
		if (init.method === "POST") return asReply<T>(graphAuthority().push(DESK, wire(init.body)));
		const params = new URL(`http://x${pathname}`).searchParams;
		return asReply<T>(graphAuthority().pull(Number(params.get("after")), params.get("log")));
	},
});

/** The desktop's small files (folders and placements among them), in memory. */
const deskItems = new Map<string, MapItem>();
const deskFiles: MapFiles = {
	read: () => ({ items: new Map(deskItems), unreadable: new Set(), fileTimes: new Map() }),
	apply(changes) {
		for (const [key, value] of changes) {
			if (value === null) deskItems.delete(key); else deskItems.set(key, { value, mtime: Date.now() });
		}
	},
};
const deskMaps = createMapsDesktop({
	files: deskFiles,
	state: stateFile(path.join(DESK_DIR, "sync", "maps-desktop.json"), isDesktopMapsState),
	identity: () => ({ server: "https://learn.example.com", deviceId: DESK }),
	request: async <T>(_pathname: string, init: { method?: string; body?: unknown } = {}) => asReply<T>(mapsAuthority().exchange(DESK, wire(init.body)) as unknown as AuthorityReply),
	now: Date.now,
	clockOffset: () => 0,
});

async function round(): Promise<void> {
	const sessions = await deskSessions.tick();
	assert.equal(sessions.ok, true, JSON.stringify(sessions));
	assert.equal((await deskGraphSync.round()).ok, true);
	assert.equal((await deskMaps.round()).ok, true);
}

// ── what both sides have ──────────────────────────────────────────────────

/** Every session file under a data folder, with its text. */
function library(dataDir: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of ["chats", path.join("notes", "sessions"), "jobs"]) {
		const dir = path.join(dataDir, part);
		if (!fs.existsSync(dir)) continue;
		for (const name of fs.readdirSync(dir).sort()) out[path.join(part, name)] = fs.readFileSync(path.join(dir, name), "utf-8");
	}
	return out;
}
const serverLedgers = () => ({ nodes: stores.graphStore.readNodes(), chains: stores.graphStore.readChains(), coverage: stores.graphStore.readCoverage(), checkpoints: stores.graphStore.readCheckpoints() });
/** The organization as the desktop's small files hold it: folders and placements. */
const deskOrganization = () => {
	const folders = [...deskItems].filter(([key]) => key.startsWith("f|")).map(([, item]) => item.value as { id: string }).sort((a, b) => a.id.localeCompare(b.id));
	const placements = Object.fromEntries([...deskItems].filter(([key]) => key.startsWith("o|")).map(([key, item]) => [key.slice(2), item.value]).sort(([a], [b]) => String(a).localeCompare(String(b))));
	return { folders, placements };
};
const serverOrganization = () => {
	const { organization } = sourceDirectory.read();
	return {
		folders: [...organization.folders].sort((a, b) => a.id.localeCompare(b.id)),
		placements: Object.fromEntries(Object.entries(organization.placements).sort(([a], [b]) => a.localeCompare(b))),
	};
};
function sameOnBothSides(): void {
	assert.deepEqual(library(DESK_DIR), library(SERVER), "the same session files, byte for byte");
	assert.deepEqual(deskGraph.ledgers(), serverLedgers(), "the same graph ledgers");
	assert.deepEqual(deskOrganization(), serverOrganization(), "the same folders and placements");
}

/** Every file under both sides, with its modification time and text. */
function everyFile(): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (dir: string) => {
		if (!fs.existsSync(dir)) return;
		for (const name of fs.readdirSync(dir).sort()) {
			const file = path.join(dir, name);
			const stat = fs.statSync(file);
			if (stat.isDirectory()) walk(file);
			else out[path.relative(TMP, file)] = `${stat.mtimeMs}:${fs.readFileSync(file, "utf-8")}`;
		}
	};
	walk(TMP);
	return out;
}

const pulled = (after: number) => graphAuthority().pull(after, null).body as { entries: LoggedEntry[]; head: number };
const scopeOf = (id: string) => folderDeletionScope(sourceDirectory.read(), id);
const remove = (id: string, mode: string, scope: unknown = scopeOf(id)) => DELETE(
	new Request(`http://localhost/api/graph/sources/folders/${id}?mode=${mode}`, { method: "DELETE", body: JSON.stringify(scope), headers: { "Content-Type": "application/json" } }),
	{ params: Promise.resolve({ id }) },
);
const node = (id: string, sources: string[]): GraphNode =>
	({ id, name: id, statement: `${id} statement`, aliases: [], createdAt: "2026-11-20T10:00:00.000Z", provenance: sources.map((chatId) => ({ chatId, messageId: "m" })) });

// ── the server's library before the desktop's first round ────────────────

const physics = stores.chatStore.createChat("Ohm's law");
const drill = stores.chatStore.createChat("Ohm drill", "practice");
const motors = stores.chatStore.createChat("Motors");
const kept = stores.chatStore.createChat("Elsewhere");
stores.graphStore.upsertSource({ id: "book", filePath: "/data/import/book.md", importedAt: "2026-11-20T10:00:00.000Z" });
for (const n of [
	node("ohm_only", [physics.id]), node("drill_only", [drill.id]), node("motor_only", [motors.id]),
	node("shared", [physics.id, motors.id, kept.id]), node("book_only", ["book"]),
]) stores.graphStore.appendNode(n);
for (const chatId of [physics.id, drill.id, motors.id, kept.id]) {
	stores.graphStore.appendCoverage({ chatId, fp: `fp_${chatId}`, tokens: 5, foldedAt: "2026-11-20T10:00:00.000Z" });
	stores.graphStore.appendCheckpoint({ chatId, foldedAt: "2026-11-20T10:00:00.000Z" } as never);
}
stores.sourceOrganizationStore.write({ version: 1, folders: [
	{ id: "fold_phys", name: "Physics", parentId: null, createdAt: "2026-11-20T10:00:00.000Z" },
	{ id: "fold_ohm", name: "Ohm", parentId: "fold_phys", createdAt: "2026-11-20T10:00:00.000Z" },
	{ id: "fold_eng", name: "Engines", parentId: null, createdAt: "2026-11-20T10:00:00.000Z" },
	{ id: "fold_side", name: "Side", parentId: null, createdAt: "2026-11-20T10:00:00.000Z" },
], placements: {
	[physics.id]: { folderId: "fold_ohm" },
	[drill.id]: { folderId: "fold_phys" },
	[motors.id]: { folderId: "fold_eng" },
	[kept.id]: { folderId: "fold_side" },
	book: { folderId: "fold_ohm", name: "My book" },
} });

describe("a folder deleted with its sessions, and the desktop", () => {
	it("the desktop's first rounds give it the server's library", async () => {
		await round();
		await round();
		sameOnBothSides();
		assert.equal(deskGraph.ledgers().nodes.length, 5);
		assert.equal(deskOrganization().folders.length, 4);
	});

	it("preserve-graph: one delete-sources entry, and the desktop ends with the same files, folders and graph", async () => {
		const head = pulled(0).head;
		const response = await remove("fold_phys", "preserve-graph");
		assert.equal(response.status, 200);
		const body = await response.json() as { deletedChatIds: string[] };
		assert.deepEqual(new Set(body.deletedChatIds), new Set([physics.id, drill.id]));
		const news = pulled(head).entries.map((e) => e.change);
		assert.deepEqual(news, [{ kind: "delete-sources", ids: [physics.id, drill.id].sort(), mode: "preserve-graph" }], "one named deletion, no rewrite, no lines");
		assert.deepEqual(stores.graphStore.readNodes().map((n) => n.id).sort(), ["book_only", "drill_only", "motor_only", "ohm_only", "shared"], "the graph keeps their topics");
		assert.deepEqual(stores.graphStore.readCoverage().map((c) => c.chatId).sort(), [kept.id, motors.id].sort(), "their coverage goes");
		await round();
		await round();
		sameOnBothSides();
		assert.equal(fs.existsSync(path.join(DESK_DIR, "chats", `${physics.id}.json`)), false, "the sessions' files are gone on the desktop");
		assert.equal(fs.existsSync(path.join(DESK_DIR, "chats", `${drill.id}.json`)), false);
		assert.deepEqual(deskOrganization().folders.map((f) => f.id), ["fold_eng", "fold_side"], "the folder and its subfolder are gone there too");
		assert.deepEqual(deskOrganization().placements.book, { folderId: null, name: "My book" }, "the imported notes moved to the top level");
		assert.equal(deskItems.has(`o|${physics.id}`), false);
	});

	it("delete-nodes: the same, with the sessions' traces gone on both sides", async () => {
		const head = pulled(0).head;
		assert.equal((await remove("fold_eng", "delete-nodes")).status, 200);
		assert.deepEqual(pulled(head).entries.map((e) => e.change), [{ kind: "delete-sources", ids: [motors.id], mode: "delete-nodes" }]);
		assert.deepEqual(stores.graphStore.readNodes().map((n) => n.id).sort(), ["book_only", "drill_only", "ohm_only", "shared"]);
		await round();
		await round();
		sameOnBothSides();
		assert.ok(deskGraph.ledgers().nodes.every((n) => n.provenance.every((p) => p.chatId !== motors.id)));
		assert.deepEqual(deskOrganization().folders.map((f) => f.id), ["fold_side"]);
	});

	it("an empty folder logs no graph entry", async () => {
		stores.sourceOrganizationStore.write({ ...sourceDirectory.read().organization, folders: [...sourceDirectory.read().organization.folders, { id: "fold_empty", name: "Empty", parentId: null, createdAt: "2026-11-20T10:00:00.000Z" }] });
		await round();
		const head = pulled(0).head;
		assert.equal((await remove("fold_empty", "delete-nodes")).status, 200);
		assert.equal(pulled(0).head, head);
		await round();
		sameOnBothSides();
	});

	it("an idle round afterwards writes nothing on either side", async () => {
		await round();
		const before = everyFile();
		await round();
		await round();
		assert.deepEqual(everyFile(), before);
	});
});

describe("a folder with a session the desktop holds", () => {
	const chatId = "chat_desk_made";
	it("is refused with nothing deleted, and moving the session here keeps the reviewed scope", async () => {
		// The desktop makes a session and files it in a new folder.
		fs.mkdirSync(path.join(DESK_DIR, "chats"), { recursive: true });
		fs.writeFileSync(path.join(DESK_DIR, "chats", `${chatId}.json`), JSON.stringify({
			id: chatId, title: "Made on the PC", createdAt: "2026-11-20T10:00:00.000Z", updatedAt: "2026-11-20T10:00:00.000Z",
			messages: [{ role: "user", content: "hello" }], version: CURRENT_CHAT_VERSION,
		}, null, "\t"));
		const t = Date.now();
		deskItems.set("f|fold_pc", { value: { id: "fold_pc", name: "From the PC", parentId: null, createdAt: "2026-11-20T10:00:00.000Z" }, mtime: t });
		deskItems.set(`o|${chatId}`, { value: { folderId: "fold_pc" }, mtime: t });
		await round();
		await round();
		assert.equal(syncAuthority().holderOf(chatId)?.id, DESK, "the desktop holds it");
		const reviewed = scopeOf("fold_pc");
		assert.deepEqual(reviewed?.chatIds, [chatId]);

		const organization = structuredClone(sourceDirectory.read().organization);
		const ledgers = serverLedgers();
		const response = await remove("fold_pc", "delete-nodes", reviewed);
		assert.equal(response.status, 409);
		assert.equal((await response.json() as { code: string }).code, HELD_ELSEWHERE_CODE);
		assert.ok(stores.chatStore.getChat(chatId), "the session is still there");
		assert.deepEqual(sourceDirectory.read().organization, organization, "the organization is untouched");
		assert.deepEqual(serverLedgers(), ledgers, "the graph is untouched");

		// The page moves it here (the cloud asks; the online desktop hands over at its next round).
		assert.equal(syncAuthority().takeOver(CLOUD_HOLDER, chatId, true).body.status, "waiting");
		await round();
		assert.equal(syncAuthority().takeOver(CLOUD_HOLDER, chatId, true).body.status, "yours");
		assert.deepEqual(scopeOf("fold_pc"), reviewed, "moving the session here changed nothing the box reviewed");
		assert.equal((await remove("fold_pc", "delete-nodes", reviewed)).status, 200);
		await round();
		await round();
		sameOnBothSides();
		assert.equal(fs.existsSync(path.join(DESK_DIR, "chats", `${chatId}.json`)), false);
	});
});
