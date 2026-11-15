/**
 * The maker (multi-account slice 3a): the fixed template, the tag check, the
 * token, the call sequences, and the re-create on a new image, against a
 * stand-in Docker Engine API on a unix socket that records every request.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { DockerClient } from "../gateway/docker.ts";
import {
	COPY_CPU_SHARES,
	COPY_MEMORY_BYTES,
	COPY_MEMORY_SWAP_BYTES,
	COPY_PIDS_LIMIT,
	Maker,
	TAG_ALPHABET,
	copyTemplate,
	makerServer,
	readMakerConfig,
	type MakerConfig,
} from "../gateway/maker.ts";

const TOKEN = "t".repeat(20) + "0123456789abcdefghij";
const OLD_IMAGE = "sha256:" + "a".repeat(64);
const NEW_IMAGE = "sha256:" + "b".repeat(64);

// ─── A stand-in Docker Engine API ─────────────────────────────────────────────

interface FakeContainer {
	Id: string;
	Name: string;
	Image: string;
	Config: { Image: string; Env: string[]; Labels: Record<string, string> };
	HostConfig: Record<string, unknown>;
	State: { Status: string; Running: boolean };
	networks: Set<string>;
	body: Record<string, unknown> | null;
}

interface Call {
	method: string;
	path: string;
	query: Record<string, string>;
	body: unknown;
}

class FakeDocker {
	calls: Call[] = [];
	images = new Map<string, string>();
	containers = new Map<string, FakeContainer>();
	networks = new Map<string, { Id: string; Name: string; Labels: Record<string, string> }>();
	volumes = new Map<string, { Name: string; Labels: Record<string, string> }>();
	/** Return a status to fail that call instead of playing it. */
	failWith: ((call: Call) => number | null) | null = null;
	delayMs: ((call: Call) => number) | null = null;
	server: http.Server;
	private seq = 0;

	constructor(readonly socket: string) {
		this.server = http.createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on("data", (c: Buffer) => chunks.push(c));
			req.on("end", () => {
				const url = new URL(req.url ?? "/", "http://docker");
				const version = url.pathname.match(/^\/v1\.\d+/)?.[0];
				assert.equal(version, "/v1.44", "a versioned path");
				const text = Buffer.concat(chunks).toString("utf8");
				const call: Call = {
					method: req.method ?? "",
					path: decodeURIComponent(url.pathname.slice(version.length)),
					query: Object.fromEntries(url.searchParams),
					body: text ? JSON.parse(text) : undefined,
				};
				this.calls.push(call);
				const reply = (status: number, data?: unknown) => {
					const out = data === undefined ? "" : JSON.stringify(data);
					res.writeHead(status, { "Content-Type": "application/json" });
					res.end(out);
				};
				const play = () => {
					const failure = this.failWith?.(call) ?? null;
					if (failure) return reply(failure, { message: `injected failure ${failure}` });
					const [status, data] = this.route(call);
					reply(status, data);
				};
				const delay = this.delayMs?.(call) ?? 0;
				if (delay) setTimeout(play, delay);
				else play();
			});
		});
	}

	listen() {
		return new Promise<void>((resolve) => this.server.listen(this.socket, resolve));
	}

	close() {
		return new Promise<void>((resolve) => this.server.close(() => resolve()));
	}

	/** The calls as "METHOD /path" lines, the version left out. */
	lines() {
		return this.calls.map((c) => `${c.method} ${c.path}`);
	}

	addContainer(name: string, image: string, extra: Partial<FakeContainer> = {}): FakeContainer {
		const c: FakeContainer = {
			Id: (++this.seq).toString(16).padStart(64, "c"),
			Name: `/${name}`,
			Image: image,
			Config: { Image: image, Env: [], Labels: {} },
			HostConfig: {},
			State: { Status: "running", Running: true },
			networks: new Set(),
			body: null,
			...extra,
		};
		this.containers.set(c.Id, c);
		return c;
	}

	findContainer(ref: string): FakeContainer | null {
		for (const c of this.containers.values()) if (c.Name === `/${ref}` || c.Id === ref) return c;
		return null;
	}

	private inspect(c: FakeContainer) {
		const networks: Record<string, unknown> = {};
		for (const n of c.networks) networks[n] = {};
		return { Id: c.Id, Name: c.Name, Image: c.Image, Config: c.Config, State: c.State, NetworkSettings: { Networks: networks } };
	}

	private route(call: Call): [number, unknown?] {
		const { method, path: p, query, body } = call;
		let m: RegExpExecArray | null;
		if (method === "GET" && (m = /^\/images\/(.+)\/json$/.exec(p))) {
			const id = this.images.get(m[1]!) ?? ([...this.images.values()].includes(m[1]!) ? m[1]! : null);
			return id ? [200, { Id: id }] : [404, { message: "No such image" }];
		}
		if (method === "GET" && p === "/containers/json") {
			const filters = JSON.parse(query.filters ?? "{}") as Record<string, string[]>;
			const list = [...this.containers.values()].filter((c) => {
				for (const label of filters.label ?? []) {
					const [k, v] = label.split("=");
					if (c.Config.Labels[k!] !== v) return false;
				}
				for (const vol of filters.volume ?? []) {
					const mounts = ((c.HostConfig.Mounts as Array<{ Source: string }>) ?? []).map((x) => x.Source);
					if (!mounts.includes(vol)) return false;
				}
				return true;
			});
			return [
				200,
				list.map((c) => ({ Id: c.Id, Names: [c.Name], Image: c.Config.Image, ImageID: c.Image, State: c.State.Status, Labels: c.Config.Labels })),
			];
		}
		if (method === "POST" && p === "/containers/create") {
			const name = query.name!;
			if (this.findContainer(name)) return [409, { message: "Conflict" }];
			const b = body as { Image: string; Env: string[]; Labels: Record<string, string>; HostConfig: Record<string, unknown> };
			const id = this.images.get(b.Image) ?? ([...this.images.values()].includes(b.Image) ? b.Image : null);
			if (!id) return [404, { message: "No such image" }];
			const c = this.addContainer(name, id, {
				Config: { Image: b.Image, Env: b.Env, Labels: b.Labels },
				HostConfig: b.HostConfig,
				State: { Status: "created", Running: false },
				body: body as Record<string, unknown>,
			});
			c.networks.add(b.HostConfig.NetworkMode as string);
			return [201, { Id: c.Id, Warnings: [] }];
		}
		if ((m = /^\/containers\/([^/]+)(\/json|\/start|\/stop)?$/.exec(p))) {
			const c = this.findContainer(m[1]!);
			if (!c) return [404, { message: "No such container" }];
			if (method === "GET" && m[2] === "/json") return [200, this.inspect(c)];
			if (method === "POST" && m[2] === "/start") {
				if (c.State.Running) return [304];
				c.State = { Status: "running", Running: true };
				return [204];
			}
			if (method === "POST" && m[2] === "/stop") {
				if (!c.State.Running) return [304];
				c.State = { Status: "exited", Running: false };
				return [204];
			}
			if (method === "DELETE" && !m[2]) {
				this.containers.delete(c.Id);
				return [204];
			}
		}
		if (method === "GET" && p === "/networks") {
			const filters = JSON.parse(query.filters ?? "{}") as Record<string, string[]>;
			return [
				200,
				[...this.networks.values()].filter((n) => (filters.label ?? []).every((l) => n.Labels[l.split("=")[0]!] === l.split("=")[1])),
			];
		}
		if (method === "POST" && p === "/networks/create") {
			const b = body as { Name: string; Labels: Record<string, string> };
			if (this.networks.has(b.Name)) return [409, { message: "exists" }];
			this.networks.set(b.Name, { Id: `net-${b.Name}`, Name: b.Name, Labels: b.Labels });
			return [201, { Id: `net-${b.Name}` }];
		}
		if ((m = /^\/networks\/([^/]+)(\/connect|\/disconnect)?$/.exec(p))) {
			const n = this.networks.get(m[1]!);
			if (!n) return [404, { message: "No such network" }];
			if (method === "GET" && !m[2]) return [200, n];
			if (method === "POST") {
				const c = this.findContainer((body as { Container: string }).Container);
				if (!c) return [404, { message: "No such container" }];
				if (m[2] === "/connect") {
					if (c.networks.has(n.Name)) return [403, { message: "already exists" }];
					c.networks.add(n.Name);
				} else c.networks.delete(n.Name);
				return [200];
			}
			if (method === "DELETE" && !m[2]) {
				if ([...this.containers.values()].some((c) => c.networks.has(n.Name))) return [403, { message: "active endpoints" }];
				this.networks.delete(n.Name);
				return [204];
			}
		}
		if ((m = /^\/volumes\/(.+)$/.exec(p)) && m[1] !== "create") {
			const v = this.volumes.get(m[1]!);
			if (method === "GET") return v ? [200, v] : [404, { message: "no such volume" }];
			if (method === "DELETE") {
				if (!v) return [404, { message: "no such volume" }];
				const used = [...this.containers.values()].some((c) =>
					((c.HostConfig.Mounts as Array<{ Source: string }>) ?? []).some((x) => x.Source === v.Name),
				);
				if (used) return [409, { message: "volume is in use" }];
				this.volumes.delete(v.Name);
				return [204];
			}
		}
		if (method === "POST" && p === "/volumes/create") {
			const b = body as { Name: string; Labels: Record<string, string> };
			this.volumes.set(b.Name, { Name: b.Name, Labels: b.Labels });
			return [201, { Name: b.Name }];
		}
		return [404, { message: `unknown ${method} ${p}` }];
	}
}

// ─── Set-up ───────────────────────────────────────────────────────────────────

let dir: string;
let docker: FakeDocker;
let maker: Maker;
let server: http.Server;
let base: string;
let logs: string[];
let config: MakerConfig;

async function startMaker(overrides: Partial<MakerConfig> = {}) {
	if (server) await new Promise<void>((r) => server.close(() => r()));
	config = { token: TOKEN, image: "lh-image:test", selfId: "maker-self", caddyContainer: "caddy", timeZone: null, ...overrides };
	logs = [];
	maker = new Maker(config, DockerClient.overSocket(docker.socket), (line) => logs.push(line));
	server = makerServer(maker);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function call(method: string, p: string, body?: unknown, token: string | null = TOKEN) {
	const headers: Record<string, string> = {};
	if (token !== null) headers.Authorization = `Bearer ${token}`;
	const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
	return { status: res.status, body: (await res.json()) as Record<string, unknown> & unknown[], headers: res.headers };
}

/** Raw HTTP, so a path is sent exactly as written. */
function rawCall(method: string, p: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const { port } = server.address() as AddressInfo;
		const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: { Authorization: `Bearer ${TOKEN}` } }, (res) => {
			res.resume();
			res.on("end", () => resolve(res.statusCode ?? 0));
		});
		req.on("error", reject);
		req.end();
	});
}

function expectedBody(tag: string, image: string, secret: string, tz?: string) {
	const env = [`LH_GATE_SECRET=${secret}`, `LH_ACCOUNT_TAG=${tag}`, "LH_SEED_WORKER_CONCURRENCY=3", "LH_TRUST_PROXY=1"];
	if (tz) env.push(`TZ=${tz}`);
	return {
		Image: image,
		User: "node",
		Env: env,
		Labels: { "lh.account.tag": tag, "lh.managed": "1" },
		HostConfig: {
			Mounts: [{ Type: "volume", Source: `lh-acct-${tag}-data`, Target: "/data" }],
			Memory: 1073741824,
			MemorySwap: 2147483648,
			CpuShares: 1024,
			PidsLimit: 512,
			CapDrop: ["ALL"],
			SecurityOpt: ["no-new-privileges"],
			RestartPolicy: { Name: "unless-stopped" },
			Privileged: false,
			PublishAllPorts: false,
			NetworkMode: `lh-acct-${tag}-net`,
		},
		NetworkingConfig: { EndpointsConfig: { [`lh-acct-${tag}-net`]: {} } },
	};
}

function creates() {
	return docker.calls.filter((c) => c.method === "POST" && c.path === "/containers/create");
}

before(async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-maker-"));
});

beforeEach(async () => {
	if (docker) await docker.close();
	docker = new FakeDocker(path.join(dir, `docker-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`));
	docker.images.set("lh-image:test", OLD_IMAGE);
	docker.addContainer("caddy", "sha256:" + "d".repeat(64));
	docker.addContainer("maker-self", NEW_IMAGE);
	await docker.listen();
	await startMaker();
});

after(async () => {
	if (server) await new Promise<void>((r) => server.close(() => r()));
	if (docker) await docker.close();
	fs.rmSync(dir, { recursive: true, force: true });
});

// ─── The rules ────────────────────────────────────────────────────────────────

describe("rules", () => {
	test("the tag alphabet is the setup code's", () => {
		const source = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "core", "server-auth.ts"), "utf8");
		const literal = /const CODE_ALPHABET = "([^"]+)"/.exec(source)?.[1];
		assert.equal(TAG_ALPHABET, literal);
		assert.equal(new Set(TAG_ALPHABET).size, 32);
	});

	test("the limits are the approved first values", () => {
		assert.equal(COPY_MEMORY_BYTES, 1024 ** 3);
		assert.equal(COPY_MEMORY_SWAP_BYTES, 2 * 1024 ** 3);
		assert.equal(COPY_CPU_SHARES, 1024);
		assert.equal(COPY_PIDS_LIMIT, 512);
	});

	test("the config refuses a missing or short token and a missing Caddy", () => {
		assert.ok("error" in readMakerConfig({ LH_CADDY_CONTAINER: "caddy" }, "h"));
		assert.ok("error" in readMakerConfig({ LH_MAKER_TOKEN: "short", LH_CADDY_CONTAINER: "caddy" }, "h"));
		assert.ok("error" in readMakerConfig({ LH_MAKER_TOKEN: TOKEN }, "h"));
		assert.ok("error" in readMakerConfig({ LH_MAKER_TOKEN: TOKEN, LH_CADDY_CONTAINER: "../x" }, "h"));
		const ok = readMakerConfig({ LH_MAKER_TOKEN: TOKEN, LH_CADDY_CONTAINER: "deploy-caddy-1", TZ: "Europe/Stockholm" }, "abc123");
		assert.deepEqual(ok, { token: TOKEN, image: null, selfId: "abc123", caddyContainer: "deploy-caddy-1", timeZone: "Europe/Stockholm" });
		const odd = readMakerConfig({ LH_MAKER_TOKEN: TOKEN, LH_CADDY_CONTAINER: "caddy", TZ: "x\ny", LH_IMAGE: "img:1" }, "h");
		assert.ok(!("error" in odd) && odd.timeZone === null && odd.image === "img:1");
		// The reason names the variable, never a value.
		const refused = readMakerConfig({ LH_MAKER_TOKEN: "secret-but-short", LH_CADDY_CONTAINER: "caddy" }, "h");
		assert.ok("error" in refused && !refused.error.includes("secret-but-short"));
	});

	test("the program refuses to start without a token", () => {
		const env = { ...process.env, LH_MAKER_TOKEN: "", LH_CADDY_CONTAINER: "caddy", PORT: "0", DOCKER_SOCKET: path.join(dir, "none.sock") };
		const run = spawnSync(process.execPath, ["--import", "tsx", path.join(import.meta.dirname, "..", "gateway", "maker.ts")], {
			env,
			encoding: "utf8",
			timeout: 60_000,
		});
		assert.equal(run.status, 1);
		assert.match(run.stderr, /maker: not starting: LH_MAKER_TOKEN/);
		assert.doesNotMatch(run.stdout, /listening/);
	});

	test("the template refuses a bad tag or secret", () => {
		assert.throws(() => copyTemplate({ tag: "abc", image: "i", gateSecret: "x".repeat(43), timeZone: null }));
		assert.throws(() => copyTemplate({ tag: "ABC", image: "i", gateSecret: "short", timeZone: null }));
	});
});

// ─── The token ────────────────────────────────────────────────────────────────

describe("the token", () => {
	test("missing or wrong → 401 and no Docker call", async () => {
		for (const token of [null, "", "wrong", TOKEN + "x", TOKEN.slice(0, -1)]) {
			const r = await call("POST", "/copies", { tag: "ABC" }, token);
			assert.equal(r.status, 401);
			assert.equal(r.body.code, "unauthorized");
		}
		for (const header of [`bearer ${TOKEN}`, TOKEN, `Basic ${TOKEN}`]) {
			const res = await fetch(base + "/copies", { headers: { Authorization: header } });
			assert.equal(res.status, 401);
		}
		assert.equal((await call("GET", "/nowhere", undefined, null)).status, 401, "before routing");
		assert.deepEqual(docker.calls, []);
	});
});

// ─── Creating a copy ──────────────────────────────────────────────────────────

describe("POST /copies", () => {
	test("the exact create request and the call sequence", async () => {
		const r = await call("POST", "/copies", { tag: "K7Q" });
		assert.equal(r.status, 200);
		assert.equal(r.body.upstream, "lh-acct-K7Q:3000");
		const secret = r.body.gateSecret as string;
		assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
		assert.equal(Buffer.from(secret, "base64url").length, 32);
		assert.deepEqual(docker.lines(), [
			"GET /images/lh-image:test/json",
			"GET /networks/lh-acct-K7Q-net",
			"POST /networks/create",
			"GET /volumes/lh-acct-K7Q-data",
			"POST /volumes/create",
			"GET /containers/lh-acct-K7Q/json",
			"POST /containers/create",
			"GET /containers/caddy/json",
			"POST /networks/lh-acct-K7Q-net/connect",
			"POST /containers/lh-acct-K7Q/start",
		]);
		const [create] = creates();
		assert.deepEqual(create!.query, { name: "lh-acct-K7Q" });
		assert.deepEqual(create!.body, expectedBody("K7Q", OLD_IMAGE, secret));
		const hostConfig = (create!.body as { HostConfig: Record<string, unknown> }).HostConfig;
		for (const forbidden of ["Binds", "PortBindings", "Devices", "CapAdd", "VolumesFrom", "Sysctls"]) assert.ok(!(forbidden in hostConfig), forbidden);
		assert.equal(hostConfig.Privileged, false);
		assert.deepEqual(docker.calls.find((c) => c.path === "/networks/create")!.body, {
			Name: "lh-acct-K7Q-net",
			Driver: "bridge",
			Internal: false,
			Attachable: false,
			EnableIPv6: false,
			Labels: { "lh.account.tag": "K7Q", "lh.managed": "1" },
		});
		assert.deepEqual(docker.calls.find((c) => c.path === "/volumes/create")!.body, {
			Name: "lh-acct-K7Q-data",
			Driver: "local",
			Labels: { "lh.account.tag": "K7Q", "lh.managed": "1" },
		});
		assert.deepEqual(docker.calls.find((c) => c.path.endsWith("/connect"))!.body, { Container: "caddy" });
		assert.equal(docker.findContainer("lh-acct-K7Q")!.State.Running, true);
	});

	test("TZ from the maker's environment is passed on", async () => {
		await startMaker({ timeZone: "Europe/Stockholm" });
		const r = await call("POST", "/copies", { tag: "ABC" });
		assert.deepEqual(creates()[0]!.body, expectedBody("ABC", OLD_IMAGE, r.body.gateSecret as string, "Europe/Stockholm"));
	});

	test("fields beside the tag never reach Docker", async () => {
		const r = await call("POST", "/copies", {
			tag: "ABC",
			image: "evil:latest",
			binds: ["/:/host"],
			cmd: ["sh", "-c", "id"],
			env: ["LH_GATE_SECRET=known"],
			name: "caddy",
			HostConfig: { Privileged: true },
		});
		assert.equal(r.status, 200);
		assert.deepEqual(creates()[0]!.body, expectedBody("ABC", OLD_IMAGE, r.body.gateSecret as string));
		const sent = JSON.stringify(docker.calls);
		for (const word of ["evil", "/host", "known", "Privileged\":true", "\"id\""]) assert.ok(!sent.includes(word), word);
	});

	test("refused tags → 400 with no Docker call", async () => {
		for (const tag of ["AB", "ABCD", "abc", "aBC", "../x", "A/B", "A.B", "ILO", "UUU", "AB ", " AB", "", 123, null, ["ABC"], { tag: "ABC" }, "ÄBC", "AB\n"]) {
			const r = await call("POST", "/copies", { tag });
			assert.equal(r.status, 400, JSON.stringify(tag));
			assert.equal(r.body.code, "bad_tag");
		}
		for (const body of ["not json", "[]", "null", '"ABC"', "{}"]) assert.equal((await call("POST", "/copies", body)).status, 400, body);
		for (const [method, p] of [
			["POST", "/copies/..%2Fx/stop"],
			["POST", "/copies/AB%2FC/start"],
			["POST", "/copies/abc/start"],
			["POST", "/copies/%41BC/start"],
			["DELETE", "/copies/ILU"],
			["DELETE", "/copies/AB"],
			["DELETE", "/volumes/..%2F..%2Fx"],
			["DELETE", "/volumes/ABCD"],
		] as const) {
			assert.equal(await rawCall(method, p), 400, p);
		}
		for (const p of ["/copies/../volumes/ABC", "/copies/A/B/stop", "/copies/ABC/stop/x", "/volumes/ABC/x", "//copies"]) {
			assert.equal(await rawCall("DELETE", p), 404, p);
		}
		assert.deepEqual(docker.calls, []);
	});

	test("unknown paths 404, wrong methods 405, a large body 413", async () => {
		assert.equal((await call("GET", "/")).status, 404);
		assert.equal((await call("GET", "/containers/json")).status, 404);
		const wrong = await call("PUT", "/copies", { tag: "ABC" });
		assert.equal(wrong.status, 405);
		assert.equal(wrong.headers.get("allow"), "GET, POST");
		assert.equal((await call("GET", "/copies/ABC/stop")).status, 405);
		assert.equal((await call("POST", "/copies/ABC")).status, 405);
		assert.equal((await call("POST", "/volumes/ABC")).status, 405);
		assert.equal((await call("GET", "/reconcile")).status, 405);
		const big = await call("POST", "/copies", JSON.stringify({ tag: "ABC", pad: "x".repeat(600) }));
		assert.equal(big.status, 413);
		assert.deepEqual(docker.calls, []);
	});

	test("a copy made again keeps its volume and network and gets a new secret", async () => {
		const first = await call("POST", "/copies", { tag: "ABC" });
		const firstId = docker.findContainer("lh-acct-ABC")!.Id;
		docker.calls = [];
		const second = await call("POST", "/copies", { tag: "ABC" });
		assert.equal(second.status, 200);
		assert.notEqual(second.body.gateSecret, first.body.gateSecret);
		assert.deepEqual(docker.lines(), [
			"GET /images/lh-image:test/json",
			"GET /networks/lh-acct-ABC-net",
			"GET /volumes/lh-acct-ABC-data",
			"GET /containers/lh-acct-ABC/json",
			`POST /containers/${firstId}/stop`,
			`DELETE /containers/${firstId}`,
			"POST /containers/create",
			"GET /containers/caddy/json",
			"POST /containers/lh-acct-ABC/start",
		]);
		assert.deepEqual(creates()[0]!.body, expectedBody("ABC", OLD_IMAGE, second.body.gateSecret as string));
		assert.equal(docker.volumes.size, 1);
	});

	test("Restore after Remove: a kept volume gets a new container", async () => {
		await call("POST", "/copies", { tag: "ABC" });
		await call("DELETE", "/copies/ABC");
		docker.calls = [];
		const r = await call("POST", "/copies", { tag: "ABC" });
		assert.equal(r.status, 200);
		assert.ok(!docker.lines().includes("POST /volumes/create"));
		assert.ok(docker.lines().includes("POST /networks/create"));
		assert.ok(docker.findContainer("caddy")!.networks.has("lh-acct-ABC-net"));
	});

	test("two calls for one tag run one after the other", async () => {
		await call("POST", "/copies", { tag: "ABC" });
		docker.calls = [];
		docker.delayMs = (c) => (c.path === "/containers/create" ? 40 : 0);
		const first = call("POST", "/copies", { tag: "ABC" });
		while (docker.calls.length === 0) await new Promise((r) => setTimeout(r, 1));
		const [a, b] = await Promise.all([first, call("POST", "/copies/ABC/stop")]);
		assert.equal(a.status, 200);
		assert.equal(b.status, 200);
		const lines = docker.lines();
		assert.ok(lines.indexOf("POST /containers/lh-acct-ABC/start") < lines.findIndex((l) => l.endsWith("/stop")), lines.join("\n"));
		assert.equal(docker.findContainer("lh-acct-ABC")!.State.Running, false);
	});

	test("a missing image, a missing Caddy and Docker errors → 502 with a short code", async () => {
		docker.images.clear();
		const noImage = await call("POST", "/copies", { tag: "ABC" });
		assert.deepEqual([noImage.status, noImage.body], [502, { code: "no_image" }]);
		docker.images.set("lh-image:test", OLD_IMAGE);
		await startMaker({ caddyContainer: "gone" });
		const noCaddy = await call("POST", "/copies", { tag: "ABD" });
		assert.deepEqual([noCaddy.status, noCaddy.body], [502, { code: "no_caddy" }]);
		await startMaker();
		docker.failWith = (c) => (c.path === "/containers/create" ? 500 : null);
		const failed = await call("POST", "/copies", { tag: "ABE" });
		assert.deepEqual([failed.status, failed.body], [502, { code: "docker_error" }]);
		assert.ok(logs.some((l) => l.includes("ABE") && l.includes("docker_error 500")), logs.join("\n"));
	});

	test("Docker away → 502 docker_unreachable", async () => {
		await docker.close();
		const r = await call("POST", "/copies", { tag: "ABC" });
		assert.deepEqual([r.status, r.body], [502, { code: "docker_unreachable" }]);
		await docker.listen();
	});

	test("LH_IMAGE unset: the maker's own container's image", async () => {
		docker.images.set("lh-image:new", NEW_IMAGE);
		await startMaker({ image: null });
		const r = await call("POST", "/copies", { tag: "ABC" });
		assert.equal(r.status, 200);
		assert.equal(docker.lines()[0], "GET /containers/maker-self/json");
		assert.equal((creates()[0]!.body as { Image: string }).Image, NEW_IMAGE);
	});
});

// ─── Stop, start, remove ──────────────────────────────────────────────────────

describe("stop, start, remove", () => {
	test("stop and start", async () => {
		await call("POST", "/copies", { tag: "ABC" });
		const id = docker.findContainer("lh-acct-ABC")!.Id;
		docker.calls = [];
		assert.deepEqual((await call("POST", "/copies/ABC/stop")).body, { tag: "ABC", state: "stopped" });
		assert.deepEqual(docker.lines(), ["GET /containers/lh-acct-ABC/json", `POST /containers/${id}/stop`]);
		assert.equal(docker.calls[1]!.query.t, "10");
		docker.calls = [];
		assert.deepEqual((await call("POST", "/copies/ABC/start")).body, { tag: "ABC", state: "running" });
		assert.deepEqual(docker.lines(), [
			"GET /containers/lh-acct-ABC/json",
			"GET /networks/lh-acct-ABC-net",
			"GET /containers/caddy/json",
			`POST /containers/${id}/start`,
		]);
		assert.equal((await call("POST", "/copies/ABC/start")).status, 200, "already running is fine");
	});

	test("start or stop of a missing copy → 404", async () => {
		assert.deepEqual((await call("POST", "/copies/XYZ/start")).body, { code: "no_copy" });
		assert.equal((await call("POST", "/copies/XYZ/start")).status, 404);
		assert.equal((await call("POST", "/copies/XYZ/stop")).status, 404);
		assert.deepEqual(docker.lines(), ["GET /containers/lh-acct-XYZ/json", "GET /containers/lh-acct-XYZ/json", "GET /containers/lh-acct-XYZ/json"]);
	});

	test("removing a copy keeps its volume, and is idempotent", async () => {
		await call("POST", "/copies", { tag: "ABC" });
		const id = docker.findContainer("lh-acct-ABC")!.Id;
		docker.calls = [];
		assert.equal((await call("DELETE", "/copies/ABC")).status, 200);
		assert.deepEqual(docker.lines(), [
			"GET /containers/lh-acct-ABC/json",
			`POST /containers/${id}/stop`,
			`DELETE /containers/${id}`,
			"GET /networks/lh-acct-ABC-net",
			"POST /networks/lh-acct-ABC-net/disconnect",
			"DELETE /networks/lh-acct-ABC-net",
		]);
		assert.deepEqual(docker.calls[4]!.body, { Container: "caddy", Force: true });
		assert.ok(docker.volumes.has("lh-acct-ABC-data"));
		assert.equal(docker.networks.size, 0);
		docker.calls = [];
		assert.equal((await call("DELETE", "/copies/ABC")).status, 200);
		assert.deepEqual(docker.lines(), ["GET /containers/lh-acct-ABC/json", "GET /networks/lh-acct-ABC-net"]);
	});

	test("the volume goes only once no container uses it", async () => {
		await call("POST", "/copies", { tag: "ABC" });
		const refused = await call("DELETE", "/volumes/ABC");
		assert.deepEqual([refused.status, refused.body], [409, { code: "volume_in_use" }]);
		assert.ok(!docker.lines().includes("DELETE /volumes/lh-acct-ABC-data"));
		assert.ok(docker.volumes.has("lh-acct-ABC-data"));
		await call("DELETE", "/copies/ABC");
		docker.calls = [];
		assert.deepEqual((await call("DELETE", "/volumes/ABC")).body, { tag: "ABC", removed: true });
		assert.deepEqual(docker.lines(), ["GET /containers/json", "GET /containers/lh-acct-ABC/json", "DELETE /volumes/lh-acct-ABC-data"]);
		assert.deepEqual(JSON.parse(docker.calls[0]!.query.filters!), { volume: ["lh-acct-ABC-data"] });
		assert.deepEqual((await call("DELETE", "/volumes/ABC")).body, { tag: "ABC", removed: false }, "already gone is fine");
	});

	test("Docker's own 409 on a volume is answered 409", async () => {
		docker.volumes.set("lh-acct-ABC-data", { Name: "lh-acct-ABC-data", Labels: {} });
		docker.failWith = (c) => (c.method === "DELETE" && c.path.startsWith("/volumes/") ? 409 : null);
		assert.equal((await call("DELETE", "/volumes/ABC")).status, 409);
	});
});

// ─── The list and the re-create on a new image ────────────────────────────────

function secretOf(name: string) {
	return docker.findContainer(name)!.Config.Env.find((e) => e.startsWith("LH_GATE_SECRET="))!.slice(15);
}

describe("GET /copies and reconcile", () => {
	test("the list", async () => {
		await call("POST", "/copies", { tag: "BBB" });
		await call("POST", "/copies", { tag: "AAA" });
		await call("POST", "/copies/BBB/stop");
		docker.addContainer("lh-acct-ZZZ-other", OLD_IMAGE, { Config: { Image: OLD_IMAGE, Env: [], Labels: { "lh.managed": "1", "lh.account.tag": "ZZZ" } } });
		docker.addContainer("lh-acct-YYY", OLD_IMAGE, { Config: { Image: OLD_IMAGE, Env: [], Labels: {} } });
		docker.images.set("lh-image:test", NEW_IMAGE);
		const r = await call("GET", "/copies");
		assert.deepEqual(r.body, [
			{ tag: "AAA", state: "running", image: OLD_IMAGE, upToDate: false },
			{ tag: "BBB", state: "exited", image: OLD_IMAGE, upToDate: false },
		]);
		docker.images.set("lh-image:test", OLD_IMAGE);
		assert.equal(((await call("GET", "/copies")).body as Array<{ upToDate: boolean }>)[0]!.upToDate, true);
	});

	test("every copy onto the new image: same secret, stopped stays stopped, one at a time, past a failure", async () => {
		for (const tag of ["AAA", "BBB", "CCC", "DDD"]) await call("POST", "/copies", { tag });
		await call("POST", "/copies/BBB/stop");
		await call("POST", "/copies/DDD/stop");
		const secrets = Object.fromEntries(["AAA", "BBB", "CCC", "DDD"].map((t) => [t, secretOf(`lh-acct-${t}`)]));
		docker.images.set("lh-image:test", NEW_IMAGE);
		docker.calls = [];
		docker.failWith = (c) => (c.path === "/containers/create" && c.query.name === "lh-acct-CCC" ? 500 : null);
		docker.delayMs = (c) => (c.path === "/containers/create" ? 15 : 0);
		const r = await call("POST", "/reconcile");
		assert.equal(r.status, 200);
		assert.deepEqual(r.body, { updated: ["AAA", "BBB", "DDD"], failed: ["CCC"], unchanged: 0 });
		for (const tag of ["AAA", "BBB", "DDD"]) {
			const c = docker.findContainer(`lh-acct-${tag}`)!;
			assert.equal(c.Image, NEW_IMAGE, tag);
			assert.equal(secretOf(`lh-acct-${tag}`), secrets[tag], `${tag} keeps its secret`);
			assert.deepEqual(c.body, expectedBody(tag, NEW_IMAGE, secrets[tag]!));
		}
		assert.equal(docker.findContainer("lh-acct-AAA")!.State.Running, true);
		assert.equal(docker.findContainer("lh-acct-BBB")!.State.Running, false, "a paused account stays paused");
		assert.equal(docker.findContainer("lh-acct-DDD")!.State.Running, false);
		assert.ok(!docker.lines().includes("POST /containers/lh-acct-BBB/start"));
		// One at a time: each copy's calls are contiguous, in order.
		const tagOf = (c: Call) => /lh-acct-([A-Z0-9]{3})/.exec(c.path + (c.query.name ?? ""))?.[1] ?? null;
		const perCopy = docker.calls.filter((c) => c.method !== "GET" || c.path.startsWith("/containers/lh-acct-"));
		const sequence = perCopy.map(tagOf).filter((t): t is string => t !== null);
		const order = sequence.filter((t, i) => t !== sequence[i - 1]);
		assert.deepEqual(order, ["AAA", "BBB", "CCC", "DDD"], sequence.join(","));
		assert.ok(logs.some((l) => /update CCC: failed \(docker_error 500/.test(l)));
		// A second pass updates nothing.
		docker.failWith = null;
		const again = await call("POST", "/reconcile");
		assert.deepEqual(again.body, { updated: [], failed: [], unchanged: 3 });
	});

	test("a copy without a valid secret is left alone and logged", async () => {
		docker.addContainer("lh-acct-ABC", OLD_IMAGE, {
			Config: { Image: OLD_IMAGE, Env: ["LH_GATE_SECRET=short"], Labels: { "lh.managed": "1", "lh.account.tag": "ABC" } },
		});
		docker.images.set("lh-image:test", NEW_IMAGE);
		const r = await call("POST", "/reconcile");
		assert.deepEqual(r.body, { updated: [], failed: ["ABC"], unchanged: 0 });
		assert.equal(docker.findContainer("lh-acct-ABC")!.Image, OLD_IMAGE);
		assert.ok(logs.some((l) => l.includes("update ABC: failed (no_secret)")));
	});

	test("Caddy re-created without its networks is joined again", async () => {
		await call("POST", "/copies", { tag: "AAA" });
		await call("POST", "/copies", { tag: "BBB" });
		docker.findContainer("caddy")!.networks.clear();
		docker.calls = [];
		const r = await call("POST", "/reconcile");
		assert.deepEqual(r.body, { updated: [], failed: [], unchanged: 2 });
		assert.deepEqual(
			docker.lines().filter((l) => l.endsWith("/connect")),
			["POST /networks/lh-acct-AAA-net/connect", "POST /networks/lh-acct-BBB-net/connect"],
		);
		assert.deepEqual([...docker.findContainer("caddy")!.networks].sort(), ["lh-acct-AAA-net", "lh-acct-BBB-net"]);
		docker.calls = [];
		await call("POST", "/reconcile");
		assert.ok(!docker.lines().some((l) => l.endsWith("/connect")), "already joined: no call");
	});

	test("no secret or token in any log line", async () => {
		const made: string[] = [];
		for (const tag of ["AAA", "BBB"]) made.push((await call("POST", "/copies", { tag })).body.gateSecret as string);
		await call("POST", "/copies/AAA/stop");
		docker.images.set("lh-image:test", NEW_IMAGE);
		docker.failWith = (c) => (c.path === "/containers/create" && c.query.name === "lh-acct-BBB" ? 500 : null);
		await call("POST", "/reconcile");
		docker.failWith = null;
		await call("DELETE", "/copies/AAA");
		await call("DELETE", "/volumes/AAA");
		assert.ok(logs.length >= 5, logs.join("\n"));
		const all = logs.join("\n");
		for (const secret of made) assert.ok(!all.includes(secret));
		assert.ok(!all.includes(TOKEN));
	});

	test("a Docker message carrying a secret is redacted in the log", async () => {
		const secret = "Q".repeat(43);
		// Every Docker answer is an error whose message carries secret-shaped values.
		docker.server.removeAllListeners("request");
		docker.server.on("request", (req: http.IncomingMessage, res: http.ServerResponse) => {
			req.resume();
			req.on("end", () => {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ message: `bad env LH_GATE_SECRET=${secret} token ${TOKEN}` }));
			});
		});
		const r = await call("POST", "/copies", { tag: "ABC" });
		assert.equal(r.status, 502);
		assert.ok(!JSON.stringify(r.body).includes(secret));
		const all = logs.join("\n");
		assert.ok(!all.includes(secret) && !all.includes(TOKEN), all);
		assert.match(all, /\[redacted\]/);
	});
});
