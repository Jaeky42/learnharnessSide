/**
 * Cloud sync Phase 5, slice 2: the read-only rule at the app's real entry
 * points (owner's decision: a session another device holds can be read, and
 * sending a message, the side tutor, renaming, its model and deleting wait
 * for Take over; the notes drawer keeps working).
 *
 * This process plays a paired DESKTOP whose sync state says one session is
 * held by the cloud and one is its own. LH_DATA_DIR and LH_AUTH_FILE are
 * redirected BEFORE the first config import.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sync-gate-"));
process.env.LH_AUTH_FILE = path.join(TMP, "secrets", "auth.json");
process.env.LH_DATA_DIR = path.join(TMP, "data");

const { stores } = await import("../src/server/stores.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { runningWorkBlocker } = await import("../src/server/chats.ts");
const { noteSetHomeResponse } = await import("../src/server/notes.ts");
const engine = await import("../src/server/sync/engine.ts");
const { writeCloudPairing } = await import("../src/store/sync/pairing.ts");
const { proxy } = await import("../proxy.ts");
const { NextRequest } = await import("next/server");
const extractRoute = await import("../app/api/graph/coverage/extract/route.ts");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const DEVICE = "dev_aaaaaaaaaaaaaaaa";
const SERVER = "https://learn.example.com";

const mine = stores.chatStore.createChat("Mine");
const held = stores.chatStore.createChat("Held by the cloud");
stores.chatStore.saveMessages(held.id, [{ role: "user", content: "from the phone", timestamp: 1 } as never]);
const heldBytes = () => fs.readFileSync(path.join(TMP, "data", "chats", `${held.id}.json`), "utf-8");
const before = heldBytes();

function pairAndRecord(key: string | null): void {
	writeCloudPairing({ version: 1, deviceId: DEVICE, name: "Office PC", server: SERVER, key, pairedAt: 1 });
	fs.mkdirSync(path.join(TMP, "data", "sync"), { recursive: true });
	fs.writeFileSync(path.join(TMP, "data", "sync", "desktop.json"), JSON.stringify({
		version: 1, server: SERVER, deviceId: DEVICE, startedAt: 1, backup: null, cursor: 5,
		sessions: {
			[mine.id]: { mine: true, holder: DEVICE, holderName: "Office PC", serverVersion: 1, stamp: null, digest: null },
			[held.id]: { mine: false, holder: "cloud", holderName: null, serverVersion: 3, stamp: null, digest: null },
		},
	}));
}

const turn = (chatId: string) => new Request("http://localhost/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chatId, input: { type: "text", text: "hello" } }) });
const call = (method: string, pathname: string) => proxy(new NextRequest(`http://localhost${pathname}`, { method }));

describe("before this desktop has synced", () => {
	it("nothing is held elsewhere", () => {
		assert.equal(engine.holdsSession(held.id), true);
		assert.equal(runningWorkBlocker(held.id), null);
	});
});

describe("a session the cloud holds, on a paired desktop", () => {
	it("is known as held, with its holder", () => {
		pairAndRecord("k".repeat(43));
		assert.equal(engine.holdsSession(mine.id), true);
		assert.equal(engine.holdsSession(held.id), false);
		assert.deepEqual(engine.sessionHolder(held.id), { id: "cloud", name: null });
	});

	it("a message is refused before anything is written or any model is called", async () => {
		const response = await handleChatRequest(turn(held.id));
		assert.equal(response.status, 409);
		assert.deepEqual(await response.json(), {
			error: "This session is held by another device. Take it over to continue it here.",
			code: "session_held_elsewhere",
			holder: { id: "cloud", name: null },
		});
		assert.equal(heldBytes(), before);
	});

	it("rename, model, delete, dismiss, the side tutor and steering are refused at the door", async () => {
		for (const [method, suffix] of [["PUT", ""], ["DELETE", "?mode=delete-nodes"], ["PUT", "/settings"], ["POST", "/dismiss"], ["POST", "/artifact-ui"], ["POST", "/steer"], ["POST", "/side-tutor"], ["DELETE", "/side-tutor"]] as const) {
			const response = call(method, `/api/chats/${held.id}${suffix}`);
			assert.equal(response.status, 409, `${method} ${suffix}`);
			assert.equal(((await response.json()) as { code: string }).code, "session_held_elsewhere");
		}
	});

	it("reading it, and everything on a session this desktop holds, passes", () => {
		assert.notEqual(call("GET", `/api/chats/${held.id}`).status, 409);
		assert.notEqual(call("GET", `/api/chats/${held.id}/side-tutor`).status, 409);
		assert.notEqual(call("PUT", `/api/chats/${mine.id}`).status, 409);
		assert.notEqual(call("POST", `/api/chats/${mine.id}/side-tutor`).status, 409);
		assert.notEqual(call("POST", "/api/chats").status, 409);
	});

	it("the notes drawer works on: the home folder is left as it is, without an error", async () => {
		const response = await noteSetHomeResponse(held.id, new Request("http://localhost/x", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ homeFolder: "LearnHarness/Physics" }) }));
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { homeFolder: null });
		assert.equal(fs.existsSync(path.join(TMP, "data", "notes", "sessions", `${held.id}.json`)), false);
	});

	it("it can't be deleted through the sources view either, and extraction isn't started for it", async () => {
		assert.equal(runningWorkBlocker(held.id)?.code, "session_held_elsewhere");
		assert.equal(runningWorkBlocker(mine.id), null);
		const response = await extractRoute.POST(new Request("http://localhost/api/graph/coverage/extract", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chatId: held.id }) }));
		assert.equal(response.status, 409);
		assert.equal(((await response.json()) as { code: string }).code, "session_held_elsewhere");
	});

	it("a late write from background work is dropped, never saved", () => {
		const warn = console.warn;
		console.warn = () => {};
		try {
			stores.chatStore.saveMessages(held.id, []);
			stores.chatStore.appendExtractionUsage(held.id, { startedAt: "x" } as never);
			stores.chatStore.saveSettings(held.id, { thinkingLevel: "low" });
			assert.equal(stores.chatStore.renameChat(held.id, "Renamed").title, "Held by the cloud");
			assert.equal(stores.chatStore.deleteChat(held.id), false);
			stores.sideTutorStore.append(held.id, { id: "q", question: "?", answer: "!", status: "done", askedAt: 1 } as never);
		} finally {
			console.warn = warn;
		}
		assert.equal(heldBytes(), before);
		assert.equal(fs.existsSync(path.join(TMP, "data", "side-tutor", `${held.id}.json`)), false);
		stores.chatStore.renameChat(mine.id, "Mine, renamed");
		assert.equal(stores.chatStore.getChat(mine.id)?.title, "Mine, renamed");
	});

	it("stays read-only while the desktop is unpaired", () => {
		pairAndRecord(null);
		assert.equal(engine.holdsSession(held.id), false);
		assert.equal(engine.holdsSession(mine.id), true);
	});

	it("a pairing with a different server doesn't inherit this server's leases", () => {
		writeCloudPairing({ version: 1, deviceId: "dev_cccccccccccccccc", name: "Office PC", server: "https://other.example.org", key: "k".repeat(43), pairedAt: 2 });
		assert.equal(engine.holdsSession(held.id), true);
	});
});
