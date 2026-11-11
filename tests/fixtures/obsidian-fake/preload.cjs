/**
 * A stand-in for Obsidian's servers, loaded INTO the real `ob` program
 * (obsidian-headless): `node --require preload.cjs cli.js <command>`.
 * tests/obsidian-sync.test.ts uses it; nothing ships with the app.
 *
 * It replaces the two things ob talks to the outside world with:
 *   fetch      → the account and vault API (sign in, list vaults, vault access)
 *   WebSocket  → the sync service (file records, downloads, uploads)
 * so everything else is ob's own code: its prompts, its password handling,
 * its settings and state files, its sync engine and what it prints.
 *
 * The "remote" lives in one JSON file (LH_FAKE_OBSIDIAN) that the test
 * edits to play another device or to break things:
 *   account   { email, password, name, twoStep }      twoStep "" = off
 *   tokens    [..]                                     valid sign-ins
 *   vaults    [{ id, name, password, salt, standard }]
 *   version   highest record uid
 *   records   [{ uid, path, folder, deleted, hash, size, ctime, mtime, device, data }]
 *   offline   true → nothing answers
 *   initError "…" → the sync service refuses with that message
 *   pullDelayMs  wait before each download
 *
 * Vaults use ob's encryption version 0 (AES-256-GCM, scrypt key), which is
 * what this file implements; ob speaks it unchanged.
 */

"use strict";
const fs = require("node:fs");
const crypto = require("node:crypto");

const FILE = process.env.LH_FAKE_OBSIDIAN;
if (!FILE) throw new Error("LH_FAKE_OBSIDIAN is not set");

function load() {
	for (let attempt = 0; ; attempt++) {
		try { return JSON.parse(fs.readFileSync(FILE, "utf8")); }
		catch (error) { if (attempt >= 20) throw error; }
	}
}
function save(state) {
	const tmp = `${FILE}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
	fs.renameSync(tmp, FILE);
}

// ─── ob's encryption version 0 ───────────────────────────────────────────────

const keys = new Map();
function keyFor(vault) {
	const id = `${vault.password}\n${vault.salt}`;
	if (!keys.has(id)) {
		keys.set(id, crypto.scryptSync(Buffer.from(vault.password.normalize("NFKC"), "utf8"), Buffer.from(vault.salt.normalize("NFKC"), "utf8"), 32, { N: 32768, r: 8, p: 1, maxmem: 128 * 32768 * 8 * 2 }));
	}
	return keys.get(id);
}
function keyHash(key) {
	return crypto.createHash("sha256").update(key).digest("hex");
}
function seal(key, plain, iv) {
	const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
	return Buffer.concat([iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}
function open(key, sealed) {
	if (sealed.length <= 12) return Buffer.alloc(0);
	const decipher = crypto.createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12));
	decipher.setAuthTag(sealed.subarray(sealed.length - 16));
	return Buffer.concat([decipher.update(sealed.subarray(12, sealed.length - 16)), decipher.final()]);
}
function sealText(key, text) {
	const plain = Buffer.from(text, "utf8");
	return seal(key, plain, crypto.createHash("sha256").update(plain).digest().subarray(0, 12)).toString("hex");
}
function openText(key, hex) {
	return open(key, Buffer.from(hex, "hex")).toString("utf8");
}

// ─── The account and vault API ───────────────────────────────────────────────

function answer(body) {
	return { ok: true, status: 200, json: async () => body };
}

globalThis.fetch = async (url, init = {}) => {
	const state = load();
	if (state.offline) throw new TypeError("fetch failed");
	if (init.method === "OPTIONS") return answer({});
	const body = init.body ? JSON.parse(init.body) : {};
	const route = new URL(url).pathname;
	const signedIn = () => state.tokens.includes(body.token);
	switch (route) {
		case "/user/signin": {
			const { account } = state;
			if (body.email !== account.email || body.password !== account.password) return answer({ error: "Login failed, please double check your email and password." });
			if (account.twoStep && !body.mfa) return answer({ error: "Please enter your 2FA code." });
			if (account.twoStep && body.mfa !== account.twoStep) return answer({ error: "Your 2FA code is incorrect." });
			const token = `tok-${crypto.randomBytes(8).toString("hex")}`;
			state.tokens.push(token);
			save(state);
			return answer({ token, name: account.name, email: account.email });
		}
		case "/user/signout":
			state.tokens = state.tokens.filter((token) => token !== body.token);
			save(state);
			return answer({});
		case "/user/info":
			return signedIn() ? answer({ name: state.account.name, email: state.account.email }) : answer({ error: "Not logged in" });
		case "/vault/list":
			if (!signedIn()) return answer({ error: "Not logged in" });
			return answer({
				vaults: state.vaults.map((v) => ({ id: v.id, name: v.name, region: "test", host: "127.0.0.1:9", salt: v.salt, encryption_version: 0, password: v.standard ? v.password : "" })),
				shared: [],
			});
		case "/vault/access": {
			if (!signedIn()) return answer({ error: "Not logged in" });
			const vault = state.vaults.find((v) => v.id === body.vault_uid);
			if (!vault) return answer({ error: "Vault not found" });
			return body.keyhash === keyHash(keyFor(vault)) ? answer({}) : answer({ error: "Vault password is incorrect" });
		}
		default:
			return answer({ error: `unhandled ${route}` });
	}
};

// ─── The sync service ────────────────────────────────────────────────────────

class FakeSyncSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;

	constructor() {
		this.readyState = FakeSyncSocket.CONNECTING;
		this.binaryType = "arraybuffer";
		this.onopen = null;
		this.onmessage = null;
		this.onclose = null;
		this.onerror = null;
		this.key = null;
		this.sent = 0;
		this.upload = null;
		this.watch = null;
		this.out = Promise.resolve();
		setImmediate(() => {
			if (this.readyState !== FakeSyncSocket.CONNECTING) return;
			if (load().offline) {
				this.readyState = FakeSyncSocket.CLOSED;
				if (this.onerror) this.onerror({});
				return;
			}
			this.readyState = FakeSyncSocket.OPEN;
			if (this.onopen) this.onopen({});
		});
	}

	/** Messages arrive in the order they were sent, one per turn of the loop. */
	deliver(data, delayMs = 0) {
		this.out = this.out.then(() => new Promise((resolve) => {
			const go = () => {
				if (this.readyState === FakeSyncSocket.OPEN && this.onmessage) this.onmessage({ data });
				resolve();
			};
			if (delayMs > 0) setTimeout(go, delayMs); else setImmediate(go);
		}));
	}
	reply(message, delayMs = 0) { this.deliver(JSON.stringify(message), delayMs); }

	close() {
		if (this.readyState === FakeSyncSocket.CLOSED) return;
		this.readyState = FakeSyncSocket.CLOSED;
		if (this.watch) clearInterval(this.watch);
		const handler = this.onclose;
		setImmediate(() => { if (handler) handler({ code: 1000 }); });
	}

	pushRecord(record) {
		this.reply({
			op: "push", uid: record.uid, path: sealText(this.key, record.path), hash: record.hash ? sealText(this.key, record.hash) : "",
			size: record.size, ctime: record.ctime, mtime: record.mtime, folder: record.folder, deleted: record.deleted, device: record.device, user: 1,
		});
		this.sent = Math.max(this.sent, record.uid);
	}

	/** Records this client hasn't been told about, e.g. another device's change. */
	sendNews() {
		if (this.readyState !== FakeSyncSocket.OPEN) return;
		const state = load();
		for (const record of state.records.filter((r) => r.uid > this.sent).sort((a, b) => a.uid - b.uid)) this.pushRecord(record);
	}

	addRecord(fields) {
		const state = load();
		state.version += 1;
		const record = { uid: state.version, ...fields };
		state.records.push(record);
		save(state);
		return record;
	}

	send(data) {
		if (this.readyState !== FakeSyncSocket.OPEN) return;
		if (typeof data !== "string") return this.onBinary(Buffer.from(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data));
		const message = JSON.parse(data);
		switch (message.op) {
			case "ping":
				return this.reply({ op: "pong" });
			case "init": {
				const state = load();
				const vault = state.vaults.find((v) => v.id === message.id);
				if (state.initError) return this.reply({ res: "err", msg: state.initError });
				if (!state.tokens.includes(message.token)) return this.reply({ res: "err", msg: "Not logged in" });
				if (!vault) return this.reply({ res: "err", msg: "Vault not found" });
				this.key = keyFor(vault);
				if (message.keyhash !== keyHash(this.key)) return this.reply({ res: "err", msg: "Invalid key" });
				this.device = message.device;
				this.sent = message.version;
				this.reply({ res: "ok", perFileMax: 208666624, userId: 1 });
				for (const record of state.records.filter((r) => r.uid > message.version).sort((a, b) => a.uid - b.uid)) {
					if (message.initial && record.deleted) { this.sent = Math.max(this.sent, record.uid); continue; }
					this.pushRecord(record);
				}
				this.reply({ op: "ready", version: state.version });
				this.sent = Math.max(this.sent, state.version);
				this.watch = setInterval(() => this.sendNews(), 100);
				this.watch.unref();
				return;
			}
			case "pull": {
				const state = load();
				const record = state.records.find((r) => r.uid === message.uid);
				const delay = state.pullDelayMs || 0;
				if (!record || record.deleted) return this.reply({ deleted: true }, delay);
				const plain = Buffer.from(record.data || "", "base64");
				if (!plain.length) return this.reply({ size: 0, pieces: 0 }, delay);
				const sealed = seal(this.key, plain, crypto.randomBytes(12));
				this.reply({ size: sealed.length, pieces: 1 }, delay);
				return this.deliver(sealed.buffer.slice(sealed.byteOffset, sealed.byteOffset + sealed.byteLength));
			}
			case "push": {
				const filePath = openText(this.key, message.path);
				if (message.folder || message.deleted) {
					const record = this.addRecord({ path: filePath, folder: !!message.folder, deleted: !!message.deleted, hash: "", size: 0, ctime: 0, mtime: 0, device: this.device, data: "" });
					// The service tells every device, the sender included, before it answers.
					this.reply({ op: "push", uid: record.uid, path: message.path, hash: "", size: 0, ctime: 0, mtime: 0, folder: record.folder, deleted: record.deleted, device: this.device, user: 1 });
					this.sent = Math.max(this.sent, record.uid);
					return this.reply({ res: "ok" });
				}
				this.upload = { message, filePath, pieces: [] };
				if (!message.pieces) return this.finishUpload();
				return this.reply({ res: "next" });
			}
			default:
				return this.reply({ res: "ok" });
		}
	}

	onBinary(piece) {
		if (!this.upload) return;
		this.upload.pieces.push(piece);
		if (this.upload.pieces.length < this.upload.message.pieces) return this.reply({ res: "next" });
		this.finishUpload();
	}

	finishUpload() {
		const { message, filePath, pieces } = this.upload;
		this.upload = null;
		const plain = pieces.length ? open(this.key, Buffer.concat(pieces)) : Buffer.alloc(0);
		const record = this.addRecord({
			path: filePath, folder: false, deleted: false, hash: message.hash ? openText(this.key, message.hash) : "",
			size: plain.length, ctime: message.ctime, mtime: message.mtime, device: this.device, data: plain.toString("base64"),
		});
		this.reply({ op: "push", uid: record.uid, path: message.path, hash: message.hash, size: plain.length, ctime: message.ctime, mtime: message.mtime, folder: false, deleted: false, device: this.device, user: 1 });
		this.sent = Math.max(this.sent, record.uid);
		this.reply({ res: "ok" });
	}
}

globalThis.WebSocket = FakeSyncSocket;
