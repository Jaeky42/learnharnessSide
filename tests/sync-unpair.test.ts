/**
 * Cloud sync Phase 6, slice 1 (docs/cloud-sync.md): "Unpair this PC".
 *
 * Pins the owner's decisions:
 *  - Unpairing on the PC sends what it has (when the server can be reached),
 *    then the server forgets the PC and takes the sessions it held.
 *  - On the PC every session can be continued afterwards: it is no longer
 *    syncing, so nothing there is held by anyone else.
 *  - Nothing reminds the learner to pair again: the state is "unpaired",
 *    not "needs-pairing", and no loop runs.
 *  - Paired again as the same device: a session continued on one side only
 *    is kept; continued on both, the server's version stays and the PC
 *    keeps a discard notice (no copies). A fresh backup is made first.
 *  - A PC the SERVER removed keeps the Phase 5 rule: other devices'
 *    sessions stay read-only there.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sync-unpair-"));
process.env.LH_AUTH_FILE = path.join(TMP, "prod", "secrets", "auth.json");
process.env.LH_DATA_DIR = path.join(TMP, "prod", "data");

const core = await import("../src/core/server-auth.ts");
const { sessionFiles, sessionDirsUnder } = await import("../src/store/sync/session-files.ts");
const { stateFile } = await import("../src/store/sync/state-file.ts");
const store = await import("../src/store/server-auth.ts");
const pairingStore = await import("../src/store/sync/pairing.ts");
const { createAuthority, isAuthorityState } = await import("../src/server/sync/authority.ts");
const { createDesktopSync, isDesktopState } = await import("../src/server/sync/desktop-sync.ts");
const server = await import("../src/server/server-auth.ts");
const syncHttp = await import("../src/server/sync/http.ts");
const client = await import("../src/server/sync/client.ts");
const cloudHttp = await import("../src/server/sync/cloud-http.ts");
const { unpairThisDesktop } = await import("../src/server/sync/unpair.ts");
const { shouldAutostart } = await import("../src/server/sync/autostart.ts");
import type { SyncReply } from "../src/server/sync/client.ts";
import type { AuthorityReply } from "../src/server/sync/authority.ts";

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let worlds = 0;
const SECOND = 1000;
const PC = "dev_aaaaaaaaaaaaaaaa";
const LAPTOP = "dev_bbbbbbbbbbbbbbbb";

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value, null, "\t"));
}

function makeSession(dataDir: string, id: string, title: string, turns: string[]): void {
	writeJson(path.join(dataDir, "chats", `${id}.json`), {
		id, title, createdAt: "2026-11-01T10:00:00.000Z", updatedAt: "2026-11-01T10:00:00.000Z", version: 1,
		messages: turns.map((text, i) => ({ id: `m_${id}_${i}`, role: "user", content: text })),
	});
}

function addTurn(dataDir: string, id: string, text: string): void {
	const file = path.join(dataDir, "chats", `${id}.json`);
	const record = JSON.parse(fs.readFileSync(file, "utf-8")) as { messages: unknown[] };
	record.messages.push({ id: `m_${text.replace(/\W+/g, "_")}`, role: "user", content: text });
	fs.writeFileSync(file, JSON.stringify(record, null, "\t"));
}

function turnsOf(dataDir: string, id: string): string[] {
	return (JSON.parse(fs.readFileSync(path.join(dataDir, "chats", `${id}.json`), "utf-8")) as { messages: Array<{ content: string }> }).messages.map((m) => m.content);
}

function world() {
	const root = path.join(TMP, `w${++worlds}`);
	const serverDir = path.join(root, "server", "data");
	let clock = 1_000_000;
	const names: Record<string, string> = {};
	const authority = createAuthority({
		files: sessionFiles(sessionDirsUnder(serverDir)),
		state: stateFile(path.join(serverDir, "sync", "authority.json"), isAuthorityState),
		now: () => clock,
		deviceName: (id) => names[id] ?? null,
		makeBackup: () => null,
	});
	const reply = <T>(result: AuthorityReply): SyncReply<T> => result.status === 200
		? { ok: true, body: result.body as T }
		: { ok: false, reason: "refused", status: result.status, code: typeof result.body.code === "string" ? result.body.code : null, error: String(result.body.error), body: result.body };

	function desktop(deviceId: string, name: string) {
		const dataDir = path.join(root, deviceId, "data");
		names[deviceId] = name;
		let online = true;
		let backups = 0;
		const discarded: string[] = [];
		const sync = createDesktopSync({
			files: sessionFiles(sessionDirsUnder(dataDir)),
			state: stateFile(path.join(dataDir, "sync", "desktop.json"), isDesktopState),
			identity: () => ({ server: "https://learn.example.com", deviceId }),
			request: async <T>(pathname: string, init: { method?: string; body?: unknown } = {}) => {
				if (!online) return { ok: false, reason: "offline" } as SyncReply<T>;
				const body = init.body === undefined ? undefined : JSON.parse(JSON.stringify(init.body)) as { force?: boolean };
				const take = /^\/api\/sync\/sessions\/(.+)\/take$/.exec(pathname)?.[1];
				const id = /^\/api\/sync\/sessions\/([^/]+)$/.exec(pathname)?.[1];
				const method = init.method ?? (body === undefined ? "GET" : "POST");
				const result = take ? authority.takeOver(deviceId, take, body?.force === true)
					: !id ? authority.exchange(deviceId, body)
					: method === "GET" ? authority.fetch(deviceId, id)
					: method === "PUT" ? authority.store(deviceId, id, body)
					: authority.remove(deviceId, id);
				return reply<T>(JSON.parse(JSON.stringify(result)) as AuthorityReply);
			},
			now: () => clock,
			makeBackup: () => `backup ${++backups}`,
			onDiscard: (id) => discarded.push(id),
		});
		return { dataDir, sync, deviceId, discarded, backups: () => backups, setOnline: (value: boolean) => { online = value; } };
	}
	return { root, serverDir, authority, desktop, pass: (ms: number) => { clock += ms; }, now: () => clock, forgetName: (id: string) => { delete names[id]; } };
}

const quiet = { ok: true, fetched: [], sent: [], removed: [], lost: [], handed: [] };

/** The PC holds "Circuits", the server holds "Motors"; both fully synced. */
async function synced() {
	const w = world();
	const desk = w.desktop(PC, "Desktop");
	makeSession(desk.dataDir, "chat_circuits", "Circuits", ["one"]);
	makeSession(w.serverDir, "chat_motors", "Motors", ["phone"]);
	await desk.sync.tick();
	w.pass(SECOND);
	return { w, desk };
}

/** "Unpair this PC" with the server reachable: a last round, the server lets go, the PC frees everything. */
async function unpaired() {
	const all = await synced();
	await all.desk.sync.tick();
	all.w.authority.releaseDevice(PC);
	all.desk.sync.release();
	all.w.pass(SECOND);
	return all;
}

describe("unpairing on the PC", () => {
	it("every session can be continued on the PC afterwards", async () => {
		const { desk } = await synced();
		assert.equal(desk.sync.holds("chat_motors"), false, "paired: the web app's session is read-only here");
		assert.deepEqual(Object.keys(desk.sync.held()), ["chat_motors"]);
		desk.sync.release();
		assert.equal(desk.sync.holds("chat_motors"), true);
		assert.equal(desk.sync.holds("chat_circuits"), true);
		assert.deepEqual(desk.sync.held(), {}, "nothing is held by anyone else any more");
		assert.equal(desk.sync.holderOf("chat_motors"), null);
	});

	it("the server takes the sessions that PC held, and nobody waits for it any more", async () => {
		const { w } = await synced();
		assert.deepEqual(Object.keys(w.authority.held()), ["chat_circuits"]);
		assert.deepEqual(w.authority.releaseDevice(PC), ["chat_circuits"]);
		assert.deepEqual(w.authority.held(), {}, "the web app can continue it without Take over");
		assert.equal(w.authority.holds("chat_circuits"), true);
		assert.deepEqual(w.authority.releaseDevice(PC), [], "a second time changes nothing");
	});

	it("the server knows to the second when it last heard from a PC, and forgets it at the unpairing", async () => {
		const { w } = await synced();
		assert.deepEqual(w.authority.presence(PC), { online: true, lastSeenAt: w.now() - SECOND });
		w.pass(31 * SECOND);
		assert.equal(w.authority.presence(PC).online, false, "three missed checks");
		assert.deepEqual(w.authority.presence(LAPTOP), { online: false, lastSeenAt: null }, "never heard from");
		w.authority.releaseDevice(PC);
		assert.deepEqual(w.authority.presence(PC), { online: false, lastSeenAt: null });
	});

	it("a PC removed on the server's site keeps its name on the sessions it still holds", async () => {
		const { w } = await synced();
		assert.equal(w.authority.held()["chat_circuits"]?.name, "Desktop");
		// Remove on the server's site: the login file no longer lists the PC.
		w.forgetName(PC);
		assert.equal(w.authority.held()["chat_circuits"]?.name, "Desktop", "\"Held by Desktop\" still has a name to show");
		assert.deepEqual(w.authority.holderOf("chat_circuits"), { id: PC, name: "Desktop" });
		// Also after the server restarts: the name is in its record.
		const record = JSON.parse(fs.readFileSync(path.join(w.serverDir, "sync", "authority.json"), "utf-8")) as { names?: Record<string, string> };
		assert.deepEqual(record.names, { [PC]: "Desktop" });
	});

	it("a server nobody ever synced with has nothing to release, and writes nothing", () => {
		const w = world();
		assert.deepEqual(w.authority.releaseDevice(PC), []);
		assert.equal(fs.existsSync(path.join(w.serverDir, "sync")), false);
	});

	it("a PC the SERVER removed keeps the old rule: other devices' sessions stay read-only", async () => {
		const { desk } = await synced();
		// No release(): that only happens for the learner's own Unpair.
		assert.equal(desk.sync.holds("chat_motors"), false);
		assert.equal(desk.sync.holds("chat_circuits"), true);
	});
});

describe("pairing the same PC again", () => {
	it("makes a fresh backup before the first sync, once", async () => {
		const { desk } = await unpaired();
		assert.equal(desk.backups(), 1, "the backup before the very first sync");
		desk.sync.rejoin();
		await desk.sync.tick();
		assert.equal(desk.backups(), 2);
		await desk.sync.tick();
		assert.equal(desk.backups(), 2);
	});

	it("nothing continued anywhere: each session is whose it now is on the server", async () => {
		const { w, desk } = await unpaired();
		desk.sync.rejoin();
		const round = await desk.sync.tick();
		assert.equal(round.ok, true);
		assert.equal(desk.sync.holds("chat_motors"), false, "the web app's again");
		assert.equal(desk.sync.holds("chat_circuits"), false, "the server took it at the unpairing");
		assert.deepEqual(desk.sync.notices(), []);
		assert.deepEqual(turnsOf(desk.dataDir, "chat_circuits"), ["one"]);
		assert.deepEqual(await desk.sync.tick(), quiet);
		assert.deepEqual(Object.keys(w.authority.held()), []);
	});

	it("continued on the phone only: the PC takes the server's version, with no notice", async () => {
		const { w, desk } = await unpaired();
		addTurn(w.serverDir, "chat_circuits", "on the phone");
		addTurn(w.serverDir, "chat_motors", "more on the phone");
		desk.sync.rejoin();
		await desk.sync.tick();
		assert.deepEqual(turnsOf(desk.dataDir, "chat_circuits"), ["one", "on the phone"]);
		assert.deepEqual(turnsOf(desk.dataDir, "chat_motors"), ["phone", "more on the phone"]);
		assert.deepEqual(desk.sync.notices(), []);
		assert.equal(desk.sync.holds("chat_circuits"), false);
	});

	it("continued on the PC only: the PC gets the session back and its turns reach the server", async () => {
		const { w, desk } = await unpaired();
		addTurn(desk.dataDir, "chat_circuits", "unpaired, on the PC");
		addTurn(desk.dataDir, "chat_motors", "the phone's session, continued on the PC");
		desk.sync.rejoin();
		const round = await desk.sync.tick();
		assert.equal(round.ok, true);
		assert.deepEqual(round.ok && round.lost, []);
		assert.deepEqual(round.ok && round.sent.sort(), ["chat_circuits", "chat_motors"]);
		assert.deepEqual(turnsOf(w.serverDir, "chat_circuits"), ["one", "unpaired, on the PC"]);
		assert.deepEqual(turnsOf(w.serverDir, "chat_motors"), ["phone", "the phone's session, continued on the PC"]);
		assert.equal(desk.sync.holds("chat_circuits"), true);
		assert.equal(desk.sync.holds("chat_motors"), true);
		assert.deepEqual(Object.keys(w.authority.held()).sort(), ["chat_circuits", "chat_motors"], "the PC holds both now");
		assert.deepEqual(desk.sync.notices(), []);
		assert.deepEqual(await desk.sync.tick(), quiet);
	});

	it("continued on both sides: the server's version stays, and a notice says what was discarded", async () => {
		const { w, desk } = await unpaired();
		addTurn(desk.dataDir, "chat_motors", "pc one");
		addTurn(desk.dataDir, "chat_motors", "pc two");
		addTurn(w.serverDir, "chat_motors", "phone again");
		desk.sync.rejoin();
		const round = await desk.sync.tick();
		// "Circuits" went to the server at the unpairing and wasn't touched here: no notice for it.
		assert.deepEqual(round, { ...quiet, lost: ["chat_motors", "chat_circuits"] });
		assert.deepEqual(turnsOf(desk.dataDir, "chat_motors"), ["phone", "phone again"], "the server's version, no copy");
		assert.deepEqual(turnsOf(w.serverDir, "chat_motors"), ["phone", "phone again"]);
		assert.deepEqual(desk.sync.notices(), [{ chatId: "chat_motors", title: "Motors", turns: 2, at: w.now() }]);
		assert.equal(desk.sync.holds("chat_motors"), false);
		assert.equal(desk.discarded.includes("chat_motors"), true, "its unsent graph knowledge goes too");
		assert.deepEqual(fs.readdirSync(path.join(desk.dataDir, "chats")).sort(), ["chat_circuits.json", "chat_motors.json"]);
	});

	it("a session made on the PC while unpaired goes up as a new one", async () => {
		const { w, desk } = await unpaired();
		makeSession(desk.dataDir, "chat_new", "Made while unpaired", ["hello"]);
		desk.sync.rejoin();
		const round = await desk.sync.tick();
		assert.deepEqual(round.ok && round.sent, ["chat_new"]);
		assert.deepEqual(turnsOf(w.serverDir, "chat_new"), ["hello"]);
		assert.equal(desk.sync.holds("chat_new"), true);
	});

	it("a session deleted on the server meanwhile goes on the PC too", async () => {
		const { w, desk } = await unpaired();
		addTurn(desk.dataDir, "chat_motors", "continued on the PC");
		fs.rmSync(path.join(w.serverDir, "chats", "chat_motors.json"));
		desk.sync.rejoin();
		const round = await desk.sync.tick();
		assert.equal(round.ok, true);
		assert.equal(fs.existsSync(path.join(desk.dataDir, "chats", "chat_motors.json")), false);
	});

	it("unpaired without a connection: what the PC hadn't sent is settled the same way", async () => {
		const { w, desk } = await synced();
		desk.setOnline(false);
		addTurn(desk.dataDir, "chat_circuits", "never sent");
		desk.sync.release(); // the server was not told: it still lists the PC as the holder
		addTurn(desk.dataDir, "chat_circuits", "and one more");
		desk.setOnline(true);
		desk.sync.rejoin();
		const round = await desk.sync.tick();
		assert.deepEqual(round.ok && round.sent, ["chat_circuits"]);
		assert.deepEqual(turnsOf(w.serverDir, "chat_circuits"), ["one", "never sent", "and one more"]);
		assert.equal(desk.sync.holds("chat_circuits"), true);
	});

	it("another desktop holds it and is online: the PC waits, keeps its turns, and gets it at the hand-over", async () => {
		const { w, desk } = await synced();
		const laptop = w.desktop(LAPTOP, "Laptop");
		await laptop.sync.tick();
		assert.equal((await laptop.sync.takeOver("chat_motors", false)).status, "moved");
		await desk.sync.tick();
		assert.equal(desk.sync.holderOf("chat_motors")?.name, "Laptop");
		w.authority.releaseDevice(PC);
		desk.sync.release();
		addTurn(desk.dataDir, "chat_motors", "continued on the PC");
		w.pass(SECOND);
		await laptop.sync.tick(); // the laptop is online
		desk.sync.rejoin();
		const first = await desk.sync.tick();
		assert.equal(first.ok, true);
		assert.equal(first.ok && first.lost.includes("chat_motors"), false, "nothing is forced");
		assert.deepEqual(desk.sync.notices(), [], "and nothing is discarded");
		assert.deepEqual(turnsOf(desk.dataDir, "chat_motors"), ["phone", "continued on the PC"]);
		assert.equal(desk.sync.holds("chat_motors"), true, "it can still be continued here meanwhile");
		// The laptop hands over at its next round; the PC's next round settles it.
		w.pass(SECOND);
		const handed = await laptop.sync.tick();
		assert.deepEqual(handed.ok && handed.handed, ["chat_motors"]);
		w.pass(SECOND);
		const second = await desk.sync.tick();
		assert.deepEqual(second.ok && second.sent, ["chat_motors"]);
		assert.deepEqual(turnsOf(w.serverDir, "chat_motors"), ["phone", "continued on the PC"]);
		assert.equal(w.authority.held()["chat_motors"]?.id, PC);
	});
});

// ─── The action itself, through the real routes ─────────────────────────────

const SERVER = "https://learn.example.com";
const HOST = "learn.example.com";
const PASSWORD = "correct horse battery";

async function asServer<T>(run: () => T | Promise<T>): Promise<T> {
	const previous = process.env.LH_SERVER_MODE;
	process.env.LH_SERVER_MODE = "1";
	try { return await run(); } finally {
		if (previous === undefined) delete process.env.LH_SERVER_MODE; else process.env.LH_SERVER_MODE = previous;
	}
}

function browserPost(pathname: string, body: unknown, cookie?: string): Request {
	return new Request(SERVER + pathname, {
		method: "POST",
		headers: { "content-type": "application/json", origin: SERVER, host: HOST, "user-agent": "Mozilla/5.0 (iPhone) Safari/605.1", ...(cookie ? { cookie } : {}) },
		body: JSON.stringify(body),
	});
}

async function serverWithLogin(): Promise<string> {
	const code = core.newSetupCode();
	store.writeServerAuthState({ ...core.emptyServerAuthState(), setupCodeHash: core.setupCodeHash(code) });
	const response = await asServer(() => server.setupResponse(browserPost("/api/server-auth/setup", { code, password: PASSWORD })));
	assert.equal(response.status, 200);
	return (response.headers.get("set-cookie") ?? "").split(";")[0]!;
}

async function pairingCode(cookie: string): Promise<string> {
	const response = await asServer(() => syncHttp.desktopsResponse(browserPost("/api/server-auth/desktops", { op: "code" }, cookie)));
	return ((await response.json()) as { code: string }).code;
}

const serverFetch: typeof fetch = async (input, init) => {
	const request = new Request(input as string, init);
	const url = new URL(request.url);
	return asServer(async () => {
		const gated = server.serverGate({ method: request.method, pathname: url.pathname, headers: request.headers, url: request.url });
		if (gated) return gated;
		if (url.pathname === "/api/sync/pair") return syncHttp.pairResponse(request);
		if (url.pathname === "/api/sync/hello") return syncHttp.helloResponse(request);
		if (url.pathname === "/api/sync/unpair") return syncHttp.unpairSelfResponse(request);
		return Response.json({ error: "Not found." }, { status: 404 });
	});
};
const noNetwork: typeof fetch = async () => { throw new Error("offline"); };
const desktops = () => store.readServerAuthState().devices.map((d) => d.name);

describe("Unpair this PC, end to end", () => {
	beforeEach(() => {
		fs.rmSync(path.join(TMP, "prod"), { recursive: true, force: true });
		client.resetCloudLink();
	});

	it("tells the server after a last round, forgets the key, and reads \"unpaired\"", async () => {
		const cookie = await serverWithLogin();
		assert.equal((await client.pairWithServer({ server: SERVER, code: await pairingCode(cookie), name: "Desktop" }, { fetch: serverFetch })).ok, true);
		assert.deepEqual(desktops(), ["Desktop"]);
		const before = pairingStore.readCloudPairing()!;
		const order: string[] = [];
		const result = await unpairThisDesktop({
			round: async () => { order.push("round"); },
			fetch: async (input, init) => { order.push(new URL(String(input)).pathname); return serverFetch(input, init); },
		});
		assert.deepEqual(order, ["round", "/api/sync/unpair"], "what the PC has goes first");
		assert.equal(result.told, true);
		assert.deepEqual(desktops(), [], "the server has forgotten this PC");
		assert.deepEqual(pairingStore.readCloudPairing(), { ...before, key: null, unpairedHere: true });
		assert.equal(result.status.sync.state, "unpaired");
		assert.equal(result.status.paired, false);
		assert.equal(result.status.server, SERVER, "the address stays, for the form");
		assert.equal(result.status.device?.name, "Desktop");
		assert.equal(shouldAutostart({ NODE_ENV: "production" } as NodeJS.ProcessEnv), false, "no loop starts for a PC the learner unpaired");
	});

	it("the old key opens nothing afterwards", async () => {
		const cookie = await serverWithLogin();
		await client.pairWithServer({ server: SERVER, code: await pairingCode(cookie), name: "Desktop" }, { fetch: serverFetch });
		const key = pairingStore.readCloudPairing()!.key!;
		await unpairThisDesktop({ round: async () => undefined, fetch: serverFetch });
		const hello = await serverFetch(`${SERVER}/api/sync/hello`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-lh-sync-protocol": "3" }, body: "{}" });
		assert.equal(hello.status, 401);
	});

	it("works without a connection: the PC is unpaired, and says the server couldn't be told", async () => {
		const cookie = await serverWithLogin();
		await client.pairWithServer({ server: SERVER, code: await pairingCode(cookie), name: "Desktop" }, { fetch: serverFetch });
		const result = await unpairThisDesktop({ round: async () => { throw new Error("offline"); }, fetch: noNetwork });
		assert.equal(result.told, false);
		assert.equal(result.status.sync.state, "unpaired");
		assert.equal(pairingStore.readCloudPairing()!.key, null);
		assert.deepEqual(desktops(), ["Desktop"], "the server still lists it until it is removed there");
	});

	it("a PC the server already removed counts as told", async () => {
		const cookie = await serverWithLogin();
		await client.pairWithServer({ server: SERVER, code: await pairingCode(cookie), name: "Desktop" }, { fetch: serverFetch });
		const id = store.readServerAuthState().devices[0]!.id;
		await asServer(() => syncHttp.desktopsResponse(browserPost("/api/server-auth/desktops", { op: "remove", id }, cookie)));
		const result = await unpairThisDesktop({ round: async () => undefined, fetch: serverFetch });
		assert.equal(result.told, true);
		assert.equal(result.status.sync.state, "unpaired");
	});

	it("a new code pairs it again as the same device, and the reminder-free mark is gone", async () => {
		const cookie = await serverWithLogin();
		await client.pairWithServer({ server: SERVER, code: await pairingCode(cookie), name: "Desktop" }, { fetch: serverFetch });
		const deviceId = pairingStore.readCloudPairing()!.deviceId;
		await unpairThisDesktop({ round: async () => undefined, fetch: serverFetch });
		const again = await client.pairWithServer({ server: SERVER, code: await pairingCode(cookie), name: "Desktop" }, { fetch: serverFetch });
		assert.equal(again.ok, true);
		const pairing = pairingStore.readCloudPairing()!;
		assert.equal(pairing.deviceId, deviceId);
		assert.equal(pairing.unpairedHere, undefined);
		assert.equal(typeof pairing.key, "string");
		assert.equal(client.cloudStatus().sync.state, "ok");
		assert.deepEqual(store.readServerAuthState().devices.map((d) => d.id), [deviceId]);
	});

	it("a PC the server removed reads \"needs-pairing\", not \"unpaired\"", async () => {
		const cookie = await serverWithLogin();
		await client.pairWithServer({ server: SERVER, code: await pairingCode(cookie), name: "Desktop" }, { fetch: serverFetch });
		const id = store.readServerAuthState().devices[0]!.id;
		await asServer(() => syncHttp.desktopsResponse(browserPost("/api/server-auth/desktops", { op: "remove", id }, cookie)));
		await client.contactServer({ fetch: serverFetch });
		assert.equal(client.cloudStatus().sync.state, "needs-pairing");
		assert.equal(pairingStore.readCloudPairing()!.unpairedHere, undefined);
	});

	it("never paired: Unpair does nothing and writes nothing", async () => {
		const result = await unpairThisDesktop({ round: async () => { throw new Error("must not run"); }, fetch: noNetwork });
		assert.equal(result.status.sync.state, "off");
		assert.equal(fs.existsSync(path.dirname(process.env.LH_AUTH_FILE!)), false);
	});

	it("the app's own route: POST /api/cloud {op:\"unpair\"}; the server has no such action", async () => {
		const cookie = await serverWithLogin();
		await client.pairWithServer({ server: SERVER, code: await pairingCode(cookie), name: "Desktop" }, { fetch: serverFetch });
		const realFetch = globalThis.fetch;
		globalThis.fetch = noNetwork;
		try {
			const response = await cloudHttp.cloudActionResponse(new Request("http://127.0.0.1/api/cloud", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "unpair" }) }));
			assert.equal(response.status, 200);
			const body = (await response.json()) as { told: boolean; status: { sync: { state: string } } };
			assert.equal(body.told, false);
			assert.equal(body.status.sync.state, "unpaired");
			const onServer = await asServer(() => cloudHttp.cloudActionResponse(new Request("http://127.0.0.1/api/cloud", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "unpair" }) })));
			assert.equal(onServer.status, 404);
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	it("pairing again through the app's route asks for a fresh backup before the next sync", async () => {
		const cookie = await serverWithLogin();
		const realFetch = globalThis.fetch;
		globalThis.fetch = serverFetch;
		const pair = async () => cloudHttp.cloudActionResponse(new Request("http://127.0.0.1/api/cloud", {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ op: "pair", server: SERVER, code: await pairingCode(cookie), name: "Desktop" }),
		}));
		try {
			assert.equal((await pair()).status, 200);
			const pairing = pairingStore.readCloudPairing()!;
			// This PC has synced with that server before.
			const file = path.join(process.env.LH_DATA_DIR!, "sync", "desktop.json");
			writeJson(file, { version: 1, server: pairing.server, deviceId: pairing.deviceId, startedAt: 1, backup: null, cursor: 0, sessions: {} });
			assert.equal((JSON.parse(fs.readFileSync(file, "utf-8")) as { rebackup?: boolean }).rebackup, undefined);
			await unpairThisDesktop({ round: async () => undefined, fetch: serverFetch });
			assert.equal((await pair()).status, 200);
			assert.equal((JSON.parse(fs.readFileSync(file, "utf-8")) as { rebackup?: boolean }).rebackup, true);
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	it("the \"sync is in use\" marker: never for an unpaired app, set while paired or removed by the server, gone after Unpair", async () => {
		const { proxy } = await import("../proxy.ts");
		const { NextRequest } = await import("next/server");
		const { isSyncInUse } = await import("../components/cloud/sync-marker.ts");
		const page = (cookie?: string) => proxy(new NextRequest("http://127.0.0.1:3000/login", cookie ? { headers: { cookie } } : undefined)).headers.get("set-cookie") ?? "";
		assert.equal(page(), "", "never paired: no cookie of any kind");
		const cookie = await serverWithLogin();
		await client.pairWithServer({ server: SERVER, code: await pairingCode(cookie), name: "Desktop" }, { fetch: serverFetch });
		assert.match(page(), /lh_cloud=1/);
		assert.equal(page("lh_cloud=1"), "", "already marked: nothing is sent again");
		// The server removed this PC: the chip and the strips still have something to say.
		const id = store.readServerAuthState().devices[0]!.id;
		await asServer(() => syncHttp.desktopsResponse(browserPost("/api/server-auth/desktops", { op: "remove", id }, cookie)));
		await client.contactServer({ fetch: serverFetch });
		assert.equal(page("lh_cloud=1"), "");
		// The learner's own Unpair: the marker is taken away.
		await client.pairWithServer({ server: SERVER, code: await pairingCode(cookie), name: "Desktop" }, { fetch: serverFetch });
		await unpairThisDesktop({ round: async () => undefined, fetch: serverFetch });
		assert.match(page("lh_cloud=1"), /lh_cloud=;.*Max-Age=0/i);
		assert.equal(page(), "");
		assert.equal(isSyncInUse("a=1; lh_cloud=1"), true);
		assert.equal(isSyncInUse("lh_cloud=0; lh_server=1"), false);
		assert.equal(isSyncInUse(undefined), false);
	});

	it("the marker on the server: only once a desktop is paired or has synced", async () => {
		const { proxy } = await import("../proxy.ts");
		const { NextRequest } = await import("next/server");
		const cookie = await serverWithLogin();
		const page = () => asServer(() => proxy(new NextRequest(`${SERVER}/login`, { headers: { host: HOST, cookie: "lh_server=1" } })).headers.get("set-cookie") ?? "");
		assert.equal(await page(), "", "nobody paired: nothing new on the server's pages");
		await client.pairWithServer({ server: SERVER, code: await pairingCode(cookie), name: "Desktop" }, { fetch: serverFetch });
		assert.match(await page(), /lh_cloud=1/);
	});

	it("the server's own status lists its paired desktop apps, never a key", async () => {
		const cookie = await serverWithLogin();
		await client.pairWithServer({ server: SERVER, code: await pairingCode(cookie), name: "Desktop" }, { fetch: serverFetch });
		const status = (await (await asServer(() => cloudHttp.cloudStatusResponse())).json()) as { role: string; desktops: Array<Record<string, unknown>> };
		assert.equal(status.role, "server");
		assert.equal(status.desktops.length, 1);
		assert.deepEqual(Object.keys(status.desktops[0]!).sort(), ["id", "lastSeenAt", "name", "online", "pairedAt"]);
		assert.equal(status.desktops[0]!.name, "Desktop");
		assert.equal(status.desktops[0]!.online, false, "paired, but it hasn't synced yet");
		assert.equal(typeof status.desktops[0]!.lastSeenAt, "number");
	});

	it("only a paired desktop's key reaches the server's unpair request", async () => {
		await serverWithLogin();
		const refused = await serverFetch(`${SERVER}/api/sync/unpair`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, body: "{}" });
		assert.equal(refused.status, 401);
		assert.equal((await syncHttp.unpairSelfResponse(new Request(`${SERVER}/api/sync/unpair`, { method: "POST" }))).status, 404, "404 outside server mode");
	});
});

