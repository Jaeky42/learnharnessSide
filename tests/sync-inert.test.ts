/**
 * Cloud sync Phase 5: THE rule every slice had to keep (docs/cloud-sync.md).
 * Where nothing is paired, the sync engine does nothing: an app that was
 * never paired, and a server with no paired desktop, make no request, set
 * no timer, and leave the data folder exactly as the app itself leaves it.
 *
 * This process is first an unpaired desktop app, then a server nobody has
 * paired with. Everything is driven through the real composition root.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sync-inert-"));
const DATA = path.join(TMP, "data");
const SECRETS = path.join(TMP, "secrets");
process.env.LH_AUTH_FILE = path.join(SECRETS, "auth.json");
process.env.LH_DATA_DIR = DATA;

const requests: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => { requests.push(String(input)); throw new Error("no network in this test"); }) as typeof fetch;

const server = await import("../src/server/index.ts");
const { stores } = await import("../src/server/stores.ts");
const { writeSettings } = await import("../src/store/settings.ts");
const { runSyncRound } = await import("../src/server/sync/round.ts");
const { mapsDesktop } = await import("../src/server/sync/maps-engine.ts");
const { shouldAutostart } = await import("../src/server/sync/autostart.ts");
const { syncInUse } = await import("../src/server/sync/engine.ts");
const { deleteChatSession } = await import("../src/server/chats.ts");
const { deleteGraphNode } = await import("../src/server/graph.ts");
const { initializePlugins } = await import("../src/server/plugins.ts");

after(() => {
	globalThis.fetch = realFetch;
	delete process.env.LH_SERVER_MODE;
	fs.rmSync(TMP, { recursive: true, force: true });
});

/** Every file under a folder, with its text. */
function tree(dir: string, base = dir): Record<string, string> {
	const out: Record<string, string> = {};
	if (!fs.existsSync(dir)) return out;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) Object.assign(out, tree(full, base)); else out[path.relative(base, full)] = fs.readFileSync(full, "utf-8");
	}
	return out;
}

const node = (id: string, chatId: string) => ({ id, name: id, statement: `${id} is so`, aliases: [], createdAt: "2026-11-01T10:00:00.000Z", provenance: [{ chatId, messageId: "" }] });

/** An ordinary stretch of use: sessions, the graph, settings, a deletion. */
async function useTheApp(tag: string): Promise<void> {
	const chat = stores.chatStore.createChat(`Circuits ${tag}`);
	stores.chatStore.saveMessages(chat.id, [{ role: "user", content: "hello", timestamp: 1 } as never]);
	stores.chatStore.renameChat(chat.id, `Circuits ${tag}, renamed`);
	stores.graphStore.appendNode(node(`n_${tag}_1`, chat.id));
	stores.graphStore.appendNode(node(`n_${tag}_2`, chat.id));
	stores.graphStore.appendChain({ id: `arg_${tag}`, premises: [`n_${tag}_1`], conclusion: `n_${tag}_2`, createdAt: "2026-11-01T10:00:00.000Z", provenance: [{ chatId: chat.id, messageId: "" }] });
	stores.graphStore.writePositions({ [`n_${tag}_1`]: { x: 1, y: 2 } });
	writeSettings({ version: 1, appearance: { theme: "catppuccin-latte" } });
	assert.equal(deleteGraphNode(`n_${tag}_2`).ok, true);
	const second = stores.chatStore.createChat(`Motors ${tag}`);
	assert.equal((await deleteChatSession(second.id, "delete-nodes")).ok, true);
}

describe("a desktop app that was never paired", () => {
	it("says it is off, and a round does nothing", async () => {
		const status = await (server.cloudStatusResponse()).json() as { paired: boolean; sync: { state: string }; held: object; notices: unknown[] };
		assert.deepEqual([status.paired, status.sync.state, status.held, status.notices], [false, "off", {}, []]);
		assert.deepEqual(await runSyncRound(), { sessions: { ok: false, reason: "not-paired" }, graph: null, maps: null });
		mapsDesktop().detect();
		assert.equal(shouldAutostart({ NODE_ENV: "production" } as NodeJS.ProcessEnv), false);
		assert.equal((globalThis as { __lhSyncLoop?: unknown }).__lhSyncLoop, undefined, "no loop, no timer");
		assert.equal(syncInUse(), false, "its pages get no marker, so they ask nothing about sync");
	});

	it("uses the app as ever: no sync folder, no pairing file, no backup, no request", async () => {
		// What the app itself starts with since upstream 0.6.0: the plugin host makes its (empty) plugins/ folder.
		await initializePlugins();
		await useTheApp("desk");
		await runSyncRound();
		assert.deepEqual(fs.readdirSync(DATA).sort(), ["chats", "graph", "jobs", "plugins", "settings.json"], "the app's own files, and nothing for sync");
		assert.deepEqual(fs.readdirSync(path.join(DATA, "plugins")), []);
		assert.equal(fs.existsSync(path.join(DATA, "sync")), false);
		assert.equal(fs.existsSync(path.join(TMP, "backups")), false);
		assert.deepEqual(fs.existsSync(SECRETS) ? fs.readdirSync(SECRETS) : [], []);
		assert.deepEqual(requests, []);
		// Nothing is read-only, and every session is this app's own.
		for (const chat of stores.chatStore.listChats()) assert.equal(server.holdsSession(chat.id), true);
	});

	it("every sync address answers 404 on a desktop: there is nothing to pair with", async () => {
		const call = (pathname: string, method = "POST") => new Request(`http://localhost${pathname}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${"k".repeat(43)}`, "x-lh-sync-protocol": "2" }, body: method === "GET" ? undefined : "{}" });
		assert.equal((await server.pairResponse(call("/api/sync/pair"))).status, 404);
		assert.equal(server.helloResponse(call("/api/sync/hello")).status, 404);
		assert.equal((await server.sessionsExchangeResponse(call("/api/sync/sessions"))).status, 404);
		assert.equal((await server.sessionBundleResponse(call("/api/sync/sessions/chat_1", "GET"), "chat_1")).status, 404);
		assert.equal((await server.sessionPictureResponse(call(`/api/sync/sessions/chat_1/pictures/${"a".repeat(64)}`, "GET"), "chat_1", "a".repeat(64))).status, 404);
		assert.equal((await server.sessionTakeResponse(call("/api/sync/sessions/chat_1/take"), "chat_1")).status, 404);
		assert.equal((await server.graphLogResponse(call("/api/sync/graph?after=0", "GET"))).status, 404);
		assert.equal((await server.mapsExchangeResponse(call("/api/sync/maps"))).status, 404);
		assert.equal(fs.existsSync(path.join(DATA, "sync")), false);
	});
});

describe("a server no desktop has paired with", () => {
	it("works as before: nothing kept for sync, nothing held elsewhere, and a stranger's key opens nothing", async () => {
		process.env.LH_SERVER_MODE = "1";
		const before = tree(DATA);
		const status = await (server.cloudStatusResponse()).json();
		assert.deepEqual(status, { role: "server", held: {}, desktops: [] });
		await useTheApp("cloud");
		const call = (pathname: string, method = "POST") => new Request(`http://localhost${pathname}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${"k".repeat(43)}`, "x-lh-sync-protocol": "2" }, body: method === "GET" ? undefined : "{}" });
		assert.equal((await server.sessionsExchangeResponse(call("/api/sync/sessions"))).status, 401);
		assert.equal((await server.graphLogResponse(call("/api/sync/graph?after=0", "GET"))).status, 401);
		assert.equal((await server.mapsExchangeResponse(call("/api/sync/maps"))).status, 401);
		assert.equal((await server.sessionPictureResponse(call(`/api/sync/sessions/chat_1/pictures/${"a".repeat(64)}`, "PUT"), "chat_1", "a".repeat(64))).status, 401);
		assert.equal(fs.existsSync(path.join(DATA, "sync")), false);
		assert.equal(fs.existsSync(path.join(TMP, "backups")), false);
		assert.equal(shouldAutostart({ NODE_ENV: "production" } as NodeJS.ProcessEnv), false);
		assert.equal(syncInUse(), false);
		assert.deepEqual(requests, []);
		// What the desktop part of this test wrote is still there, untouched.
		const now = tree(DATA);
		for (const [file, text] of Object.entries(before)) {
			if (file === "settings.json" || file.startsWith("graph")) continue; // the app itself rewrote these just now
			assert.equal(now[file], text, file);
		}
		for (const chat of stores.chatStore.listChats()) assert.equal(server.holdsSession(chat.id), true);
	});
});
