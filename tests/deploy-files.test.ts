import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createRequire } from "node:module";
import { ACCOUNT_NETWORK_PREFIX, COPY_MEMORY_BYTES, COPY_MEMORY_SWAP_BYTES, COPY_PIDS_LIMIT, TAG_ALPHABET, accountNetworkWouldLead, copyTemplate, networkName } from "../gateway/maker.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";

// The multi-account build and deploy files (docs/fork/plans/multi-account-build.md,
// slices 1d, 3c and 3d): the Caddyfile, the compose file, the entrypoint's
// seed, make-secrets.sh, build-gateway.mjs and the image's wrappers. They are
// shell and YAML that nothing else runs in a test, so they are pinned here.
const yaml = createRequire(import.meta.url)("js-yaml") as { load(source: string): unknown };
const root = path.join(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const envOf = (extra: Record<string, string>) => ({ PATH: process.env.PATH ?? "", ...extra }) as unknown as NodeJS.ProcessEnv;
const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `lh-deploy-${name}-`));

type Service = {
	image?: string;
	command?: string[];
	environment?: Record<string, string>;
	ports?: string[];
	expose?: string[];
	networks?: string[] | Record<string, unknown>;
	volumes?: string[];
	read_only?: boolean;
	cap_drop?: string[];
	security_opt?: string[];
	container_name?: string;
	group_add?: string[];
	depends_on?: string[];
	init?: boolean;
	mem_limit?: string;
	memswap_limit?: string;
	pids_limit?: number;
	tmpfs?: string[];
	stop_grace_period?: string;
	logging?: { driver?: string; options?: Record<string, string> };
};
type Compose = { services: Record<"lh" | "gateway" | "maker" | "caddy", Service>; networks: Record<string, { internal?: boolean; name?: string } | null>; volumes: Record<string, unknown> };
const compose = yaml.load(read("deploy/compose.yaml")) as Compose;
/** "1g", "128m", "10m" -> bytes (compose's own size suffixes). */
const bytesOf = (size: string) => {
	const m = /^(\d+)([bkmg])$/.exec(size);
	assert.ok(m, `a size like 1g: ${size}`);
	return Number(m[1]) * { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2] as "b" | "k" | "m" | "g"];
};
/** "[0-9A-HJKMNP-TV-Z]" -> the characters it names, sorted. */
const expandClass = (cls: string) => {
	const body = cls.slice(1, -1);
	let out = "";
	for (let i = 0; i < body.length; i++) {
		if (body[i + 1] === "-" && i + 2 < body.length) {
			for (let c = body.charCodeAt(i); c <= body.charCodeAt(i + 2); c++) out += String.fromCharCode(c);
			i += 2;
		} else out += body[i];
	}
	return [...out].sort().join("");
};
const networksOf = (service: Service) => (Array.isArray(service.networks) ? service.networks : Object.keys(service.networks ?? {})).sort();

describe("deploy/Caddyfile", () => {
	const caddyfile = read("deploy/Caddyfile");
	const route = caddyfile.slice(caddyfile.indexOf("route {"), caddyfile.indexOf("# Internal relay"));
	const relay = caddyfile.slice(caddyfile.indexOf("http://:9200"));

	it("strips the five X-LH-* headers before anything else is done", () => {
		const strip = /\(strip\) \{([^}]*)\}/.exec(caddyfile)?.[1] ?? "";
		for (const header of ["X-LH-Upstream", "X-LH-Gate", "X-LH-Relay", "X-LH-Client-Addr", "X-LH-Scope"]) {
			assert.ok(strip.includes(`request_header -${header}`), `${header} is stripped`);
		}
		const body = route.slice("route {".length).trim();
		assert.ok(body.startsWith("import strip"), "the strip is the first thing the site does");
		assert.ok(route.indexOf("import strip") < route.indexOf("handle"), "before any handler");
	});

	it("answers 404 for /api/internal/* and sends the gateway's paths to the gateway", () => {
		assert.match(route, /handle \/api\/internal\/\* \{\s*respond 404\s*\}/);
		const gatewayPaths = (/@gateway path ([^\n]+)/.exec(route)?.[1] ?? "").split(/\s+/);
		for (const p of ["/login", "/setup", "/invite", "/reset", "/manifest.webmanifest", "/api/accounts", "/api/sync/pair", "/api/server-auth/*"]) {
			assert.ok(gatewayPaths.includes(p), `${p} goes to the gateway`);
		}
		assert.match(route, /handle @gateway \{\s*reverse_proxy gateway:9000\s*\}/);
	});

	it("sends /api/server-auth/desktops to the copy, ahead of the gateway's wildcard", () => {
		assert.match(route, /@copyOwn path \/api\/server-auth\/desktops/);
		assert.ok(route.indexOf("handle @copyOwn") < route.indexOf("handle @gateway"), "the exact path is handled first");
		assert.match(route, /handle @copyOwn \{\s*import to_copy\s*\}/);
	});

	it("asks the gateway about everything else and proxies to the upstream it names", () => {
		const toCopy = /\(to_copy\) \{([\s\S]*?)\n\}/.exec(caddyfile)?.[1] ?? "";
		assert.match(toCopy, /forward_auth gateway:9000/);
		assert.match(toCopy, /uri \/gate/);
		assert.match(toCopy, /copy_headers X-LH-Upstream X-LH-Gate X-LH-Scope\n/);
		assert.match(toCopy, /reverse_proxy \{http\.request\.header\.X-LH-Upstream\}/);
		assert.match(toCopy, /flush_interval -1/);
		assert.ok(caddyfile.indexOf("(to_copy)") < caddyfile.indexOf("import to_copy"), "a snippet is defined before it is imported");
		assert.match(route, /handle \{\s*import to_copy\s*\}\s*\}\s*\}\s*$/, "the default handler goes through the gateway");
	});

	it("refuses a service worker: 403 for the request header, before the gateway or a copy is asked; and drops the response header", () => {
		assert.match(route, /@serviceWorker header Service-Worker \*\s*handle @serviceWorker \{\s*respond 403\s*\}/);
		assert.ok(route.indexOf("handle @serviceWorker") < route.indexOf("handle /api/internal/*"), "ahead of every other handler");
		assert.ok(route.indexOf("handle @serviceWorker") < route.indexOf("import to_copy"), "ahead of forward_auth");
		const toCopy = /\(to_copy\) \{([\s\S]*?)\n\}/.exec(caddyfile)?.[1] ?? "";
		assert.match(toCopy, /reverse_proxy \{http\.request\.header\.X-LH-Upstream\} \{[^}]*header_down -Service-Worker-Allowed/);
		assert.match(relay, /header_down -Service-Worker-Allowed/);
	});

	it("fails closed when the gateway's answer names no upstream", () => {
		const toCopy = /\(to_copy\) \{([\s\S]*?)\n\}/.exec(caddyfile)?.[1] ?? "";
		assert.match(toCopy, /@noUpstream expression `\{http\.request\.header\.X-LH-Upstream\} == ""`\s*respond @noUpstream 502/);
		assert.ok(toCopy.indexOf("forward_auth") < toCopy.indexOf("@noUpstream") && toCopy.indexOf("@noUpstream") < toCopy.indexOf("reverse_proxy"));
	});

	it("fails closed unless the gateway's answer names a copy and a scope (review: X-LH-Scope, the upstream allow-list)", () => {
		const toCopy = /\(to_copy\) \{([\s\S]*?)\n\}/.exec(caddyfile)?.[1] ?? "";
		assert.match(toCopy, /@notACopy not \{\s*import copy_upstream\s*\}\s*respond @notACopy 502/);
		assert.match(toCopy, /@noScope expression `\{http\.request\.header\.X-LH-Scope\} == ""`\s*respond @noScope 502/);
		for (const guard of ["@notACopy", "@noScope"]) {
			assert.ok(toCopy.indexOf("forward_auth") < toCopy.indexOf(guard) && toCopy.indexOf(guard) < toCopy.indexOf("reverse_proxy"), `${guard} sits between forward_auth and the proxy`);
		}
		assert.ok(!/request_header[^\n]*X-LH-Scope/.test(relay) && !/header_up[^\n]*X-LH-Scope/.test(relay), "the relay passes X-LH-Scope through untouched");
	});

	describe("never hands the gateway's session cookie to a copy", () => {
		const toCopy = /\(to_copy\) \{([\s\S]*?)\n\}/.exec(caddyfile)?.[1] ?? "";
		const proxy = toCopy.slice(toCopy.indexOf("reverse_proxy"));
		const forwardAuth = toCopy.slice(toCopy.indexOf("forward_auth"), toCopy.indexOf("}"));
		// The proxy's Cookie replacements, in order (Caddy applies each as a Go regexp, ReplaceAll).
		const rules = [...proxy.matchAll(/header_up Cookie "((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)"/g)]
			.map((m) => ({ search: new RegExp(m[1]!.replace(/\\\\/g, "\\"), "g"), replace: m[2]! }));
		const apply = (value: string) => rules.reduce((v, rule) => v.replace(rule.search, rule.replace), value);
		const S = "__Host-lh_session=tok_en-123";

		it("has the two replacements on the copy's proxy and none on forward_auth", () => {
			assert.equal(rules.length, 2);
			assert.ok(!/Cookie/.test(forwardAuth), "the gateway still gets the full header");
			assert.ok(!/header_up[^\n]*Cookie/.test(caddyfile.slice(caddyfile.indexOf("handle @gateway"))), "nor on the gateway's routes or the relay");
		});

		for (const [name, given, want] of [
			["alone", S, ""],
			["first", `${S}; lh_server=1; b=2`, "lh_server=1; b=2"],
			["middle", `lh_server=1; ${S}; lh_cloud=1`, "lh_server=1; lh_cloud=1"],
			["last", `lh_server=1; lh_owner=1; ${S}`, "lh_server=1; lh_owner=1"],
			["first, no space", `${S};lh_cloud=1;x=y`, "lh_cloud=1;x=y"],
			["middle, no space", `a=1;${S};b=2`, "a=1;b=2"],
			["last, no space", `a=1;${S}`, "a=1"],
			["twice", `${S}; a=1; ${S}`, "a=1"],
			["look-alike names stay", `x__Host-lh_session=1; __Host-lh_session2=2; ${S}`, "x__Host-lh_session=1; __Host-lh_session2=2"],
			["no session cookie", "lh_server=1; lh_cloud=1; lh_owner=1; any=thing", "lh_server=1; lh_cloud=1; lh_owner=1; any=thing"],
		] as const) {
			it(`${name}`, () => assert.equal(apply(given), want));
		}
	});

	it("turns Caddy's admin endpoint off (nothing reloads it, and it sits on every account's network)", () => {
		assert.match(caddyfile.slice(0, caddyfile.indexOf("(strip)")), /^\{[\s\S]*\n\tadmin off\n/);
	});

	it("lets the relay reach only the owner's copy or an account's copy, tag in the setup code's alphabet", () => {
		const snippet = /\(copy_upstream\) \{\n([\s\S]*?)\n\}/.exec(caddyfile)?.[1] ?? "";
		const cls = /^\s*header_regexp X-LH-Upstream \^\(lh\|lh-acct-(\[[^\]]+\])\{3\}\):3000\$\s*$/.exec(snippet)?.[1];
		assert.ok(cls, "the shared snippet matches the upstream with the pattern, and nothing else");
		assert.ok(caddyfile.indexOf("(copy_upstream)") < caddyfile.indexOf("import copy_upstream"), "defined before it is imported");
		assert.equal((caddyfile.match(/header_regexp X-LH-Upstream/g) ?? []).length, 1, "one pattern, in one place");
		const source = read("src/core/server-auth.ts");
		const alphabet = /const CODE_ALPHABET = "([0-9A-Z]+)"/.exec(source)?.[1];
		assert.ok(alphabet, "the setup code's alphabet");
		assert.equal(expandClass(cls), [...alphabet].sort().join(""), "the character class is exactly the alphabet");
		assert.equal(TAG_ALPHABET, alphabet, "and the maker's tag alphabet");
		assert.match(relay, /@ok \{\s*expression [^\n]*\n\s*import copy_upstream\s*\}/, "both conditions are in the one matcher");
	});

	it("has the relay on a plain internal port, guarded by the token, 404 otherwise", () => {
		assert.match(relay, /^http:\/\/:9200 \{/);
		assert.match(relay, /"\{\$LH_RELAY_TOKEN\}" != "" && \{header\.X-LH-Relay\} == "\{\$LH_RELAY_TOKEN\}"/, "an empty token never matches");
		assert.match(relay, /handle @ok \{[\s\S]*reverse_proxy \{http\.request\.header\.X-LH-Upstream\}/);
		assert.match(relay, /header_up -X-LH-Relay/);
		assert.match(relay, /header_up X-Forwarded-For \{http\.request\.header\.X-LH-Client-Addr\}/);
		assert.match(relay, /handle \{\s*respond 404\s*\}/);
		assert.ok(relay.indexOf("handle @ok") < relay.indexOf("respond 404"));
	});
});

describe("deploy/compose.yaml", () => {
	const { services } = compose;
	const raw = read("deploy/compose.yaml");

	it("publishes only Caddy's 80 and 443, and nothing on the relay, gateway, maker or copy ports", () => {
		const published = Object.entries(services).flatMap(([name, s]) => (s.ports ?? []).map((p) => [name, String(p)] as const));
		assert.deepEqual(published.map(([name]) => name).filter((name, i, all) => all.indexOf(name) === i), ["caddy"]);
		assert.deepEqual(published.map(([, p]) => p).sort(), ["443:443", "443:443/udp", "80:80"]);
		for (const port of ["9200", "9000", "9100", "3000"]) {
			assert.ok(!published.some(([, p]) => p.includes(port)), `${port} is not published`);
		}
		assert.ok(!(services.caddy.expose ?? []).includes("9200"), "the relay is not even exposed");
	});

	it("guards the three secrets (and the Docker group) so an empty one never reaches a container", () => {
		for (const name of ["LH_GATE_SECRET", "LH_MAKER_TOKEN", "LH_RELAY_TOKEN", "LH_DOCKER_GID"]) {
			const uses = raw.split("\n").filter((line) => line.includes(`\${${name}`));
			assert.ok(uses.length > 0, `${name} is used`);
			for (const line of uses) assert.match(line, new RegExp(`\\$\\{${name}:\\?[^}]+\\}`), `${name} uses :? in: ${line.trim()}`);
		}
		assert.match(raw, /LH_DOMAIN: \$\{LH_DOMAIN:\?/);
	});

	it("keeps the owner's copy on its own network, off the gateway's and the maker's", () => {
		assert.deepEqual(networksOf(services.lh), ["owner"]);
		assert.deepEqual(networksOf(services.caddy), ["front", "owner"]);
		assert.deepEqual(networksOf(services.gateway), ["front", "maker"]);
		assert.deepEqual(networksOf(services.maker), ["maker"]);
		assert.equal(compose.networks.maker?.internal, true, "the maker network has no way out or in");
		assert.ok(!compose.networks.front?.internal && !compose.networks.owner?.internal, "the others are ordinary");
	});

	it("names Caddy's outward network so that it sorts before every account network and the owner's", () => {
		// Docker gives a container with several networks its default route (and
		// the published ports) through the network whose name sorts first in byte
		// order (Docker 28+: after the gateway priority). With the project's name
		// in front ("stack_front" in CI) a new account network took it and cut the
		// requests in flight through Caddy. Fixed names make it independent of the
		// folder the stack runs from.
		const named: Record<string, string | undefined> = Object.fromEntries(Object.entries(compose.networks).map(([key, net]) => [key, net?.name]));
		assert.deepEqual({ ...named }, { front: "lh-0-front", owner: "lh-1-owner", maker: "lh-2-maker" });
		const front = named.front!;
		assert.ok(!front.includes("${"), "a fixed name, never from a variable");
		assert.ok(front < ACCOUNT_NETWORK_PREFIX, `${front} sorts before ${ACCOUNT_NETWORK_PREFIX}`);
		for (const tag of [TAG_ALPHABET[0]!.repeat(3), TAG_ALPHABET.at(-1)!.repeat(3)]) {
			assert.ok(front < networkName(tag), networkName(tag));
		}
		assert.ok(front < named.owner!, "front sorts before the owner's network, Caddy's other one");
		// Caddy's other networks never lead over an account network either, so the maker's warning stays quiet.
		assert.equal(accountNetworkWouldLead(networksOf(services.caddy).map((key) => named[key]!), networkName("000")), false);
		for (const name of Object.values(named)) assert.ok(!name!.startsWith(ACCOUNT_NETWORK_PREFIX), "never mistaken for an account network");
	});

	it("keeps the existing volumes and the service name so the switch-over reuses the data", () => {
		assert.deepEqual(services.lh.volumes, ["lh-data:/data"]);
		assert.ok("lh-data" in compose.volumes && "caddy-data" in compose.volumes && "caddy-config" in compose.volumes);
		assert.ok(services.caddy.volumes?.includes("caddy-data:/data") && services.caddy.volumes?.includes("caddy-config:/config"));
		assert.ok(services.caddy.volumes?.includes("./Caddyfile:/etc/caddy/Caddyfile:ro"));
		assert.ok(!/^name:/m.test(raw), "the compose project name stays the folder's");
		assert.ok(!("container_name" in services.lh), "the owner's copy keeps its generated name");
	});

	it("gives only the maker the Docker socket", () => {
		const sockets = Object.entries(services).filter(([, s]) => (s.volumes ?? []).some((v) => v.includes("docker.sock")));
		assert.deepEqual(sockets.map(([name]) => name), ["maker"]);
	});

	it("names Caddy's container for the maker, and gives it the relay's token", () => {
		assert.equal(services.caddy.container_name, "lh-caddy");
		assert.equal(services.maker.environment?.LH_CADDY_CONTAINER, "lh-caddy");
		assert.ok(services.caddy.environment?.LH_RELAY_TOKEN && services.gateway.environment?.LH_RELAY_TOKEN);
		assert.equal(services.gateway.environment?.LH_RELAY_URL, "http://caddy:9200");
		assert.ok(services.caddy.networks && !Array.isArray(services.caddy.networks) && "aliases" in (services.caddy.networks.front as object), "Caddy answers to `caddy` on front");
	});

	it("runs the gateway and the maker from the same image without the copy's entrypoint, hardened", () => {
		for (const name of ["gateway", "maker"] as const) {
			const s = services[name];
			assert.equal(s.image, services.lh.image, `${name} uses the copy's image`);
			assert.deepEqual(s.command, [name === "gateway" ? "lh-gateway" : "lh-maker"]);
			assert.deepEqual(s.cap_drop, ["ALL"]);
			assert.deepEqual(s.security_opt, ["no-new-privileges:true"]);
			assert.equal(s.read_only, true);
		}
		assert.equal(services.maker.environment?.LH_IMAGE, services.lh.image, "copies are made from the same image reference");
		assert.deepEqual(services.gateway.volumes, ["gateway-data:/gateway"]);
		// The image sets PORT=3000 for a copy; the maker and the gateway read PORT.
		assert.equal(services.gateway.environment?.PORT, "9000");
		assert.equal(services.maker.environment?.PORT, "9100");
		assert.equal(services.gateway.environment?.LH_GATEWAY_FILE, "/gateway/accounts.json");
		assert.equal(services.gateway.environment?.LH_OWNER_UPSTREAM, "lh:3000");
		assert.equal(services.gateway.environment?.LH_MAKER_URL, "http://maker:9100");
		assert.ok(services.gateway.environment?.LH_OWNER_GATE_SECRET, "the gateway holds the owner's copy's secret");
		assert.match(String(services.gateway.environment?.LH_MAX_ACCOUNTS), /LH_MAX_ACCOUNTS|4/);
	});

	it("gives the owner's copy the limits and hardening the maker gives an account's copy", () => {
		const lh = services.lh;
		const template = (copyTemplate({ tag: "ABC", image: "x", gateSecret: "a".repeat(43), timeZone: null }) as { HostConfig: Record<string, unknown> }).HostConfig;
		assert.equal(bytesOf(lh.mem_limit ?? ""), COPY_MEMORY_BYTES);
		assert.equal(bytesOf(lh.memswap_limit ?? ""), COPY_MEMORY_SWAP_BYTES);
		assert.equal(lh.pids_limit, COPY_PIDS_LIMIT);
		assert.deepEqual(lh.cap_drop, template.CapDrop);
		assert.deepEqual(lh.security_opt?.map((o) => o.replace(/:true$/, "")), template.SecurityOpt);
		assert.equal(lh.init, true);
		// Whatever else the template adds that compose can say, compose says the same.
		if ("Init" in template) assert.equal(lh.init, template.Init);
		if ("LogConfig" in template) {
			const log = template.LogConfig as { Type: string; Config: Record<string, string> };
			assert.equal(lh.logging?.driver, log.Type);
			assert.deepEqual(lh.logging?.options, log.Config);
		}
		assert.ok(!("privileged" in lh) && !("ports" in lh), "nothing privileged or published");
	});

	it("bounds every service's log files", () => {
		for (const name of ["lh", "caddy", "gateway", "maker"] as const) {
			assert.deepEqual(services[name].logging, { driver: "json-file", options: { "max-size": "10m", "max-file": "3" } }, name);
		}
	});

	it("pins the gateway's and the maker's memory, process, filesystem and shutdown limits", () => {
		const { gateway, maker } = services;
		assert.equal(bytesOf(gateway.mem_limit ?? ""), 256 * 1024 ** 2);
		assert.equal(gateway.pids_limit, 128);
		assert.equal(bytesOf(maker.mem_limit ?? ""), 128 * 1024 ** 2);
		assert.equal(maker.pids_limit, 64);
		assert.deepEqual(gateway.tmpfs, ["/tmp"]);
		assert.deepEqual(maker.tmpfs, ["/tmp"]);
		assert.equal(maker.stop_grace_period, "120s", "a running pass finishes before Docker kills the maker");
		assert.equal(gateway.stop_grace_period, "90s", "an account being made finishes (the gateway drains up to 75 s) before Docker kills the gateway");
		assert.equal(gateway.environment?.HOME, "/tmp");
		assert.equal(maker.environment?.HOME, "/tmp");
	});

	it("mounts the Docker socket from one variable that make-secrets.sh also reads", () => {
		assert.deepEqual(services.maker.volumes, ["${LH_DOCKER_SOCKET:-/var/run/docker.sock}:/var/run/docker.sock"]);
		const script = read("deploy/make-secrets.sh");
		assert.match(script, /LH_DOCKER_SOCKET/);
		assert.match(script, /socket="\$\{socket:-\/var\/run\/docker\.sock\}"/, "the same default");
	});

	it("lists the cap in .env.example", () => {
		assert.match(read("deploy/.env.example"), /^LH_MAX_ACCOUNTS=4$/m);
	});
});

describe("deploy/docker-entrypoint.sh seeds a new copy's settings", () => {
	const entrypoint = read("deploy/docker-entrypoint.sh");
	const start = entrypoint.indexOf('seed="${LH_SEED_WORKER_CONCURRENCY:-}"');
	const fragment = entrypoint.slice(start, entrypoint.indexOf("\nesac\n", start) + "\nesac\n".length);

	const run = (env: Record<string, string>, dataDir: string) =>
		spawnSync("sh", ["-c", fragment], { env: envOf({ LH_DATA_DIR: dataDir, ...env }), encoding: "utf8" });

	it("has the fragment, and still the pinned Obsidian version line", () => {
		assert.ok(start > 0 && fragment.includes("esac"));
		assert.match(entrypoint, /^OB_VERSION="\d+\.\d+\.\d+"$/m);
	});

	it("writes exactly the file the app writes when there is none", () => {
		const dir = path.join(tmp("seed"), "data");
		const result = run({ LH_SEED_WORKER_CONCURRENCY: "3" }, dir);
		assert.equal(result.status, 0, result.stderr);
		const text = fs.readFileSync(path.join(dir, "settings.json"), "utf8");
		const expected = JSON.stringify(sanitizeUserSettings({ version: 1, agent: { workerRequestConcurrency: 3 } }), null, "\t");
		assert.equal(text, expected, "the app's own sanitizer and writer would produce these bytes");
		assert.deepEqual(fs.readdirSync(dir), ["settings.json"], "no temporary file is left");
	});

	it("never touches an existing settings.json, byte for byte", () => {
		const dir = tmp("seed-existing");
		const original = '{\n\t"version": 1,\n\t"agent": {\n\t\t"workerRequestConcurrency": 8\n\t}\n}\n';
		fs.writeFileSync(path.join(dir, "settings.json"), original);
		assert.equal(run({ LH_SEED_WORKER_CONCURRENCY: "3" }, dir).status, 0);
		assert.equal(fs.readFileSync(path.join(dir, "settings.json"), "utf8"), original);
		assert.deepEqual(fs.readdirSync(dir), ["settings.json"]);
	});

	it("ignores a value that is not a positive whole number, and an absent one", () => {
		for (const value of ["abc", "", "0", "-3", "3.5", "03", "3 ", " 3", "1e3", "12345", "3;touch x"]) {
			const dir = path.join(tmp("seed-bad"), "data");
			assert.equal(run({ LH_SEED_WORKER_CONCURRENCY: value }, dir).status, 0, value);
			assert.ok(!fs.existsSync(path.join(dir, "settings.json")), `"${value}" writes nothing`);
		}
		const dir = path.join(tmp("seed-none"), "data");
		assert.equal(run({}, dir).status, 0);
		assert.ok(!fs.existsSync(dir), "a copy without the variable doesn't even create the folder");
	});
});

describe("deploy/make-secrets.sh", () => {
	const SECRETS = ["LH_GATE_SECRET", "LH_MAKER_TOKEN", "LH_RELAY_TOKEN"];
	const setup = () => {
		const dir = tmp("secrets");
		for (const file of ["make-secrets.sh", ".env.example"]) fs.copyFileSync(path.join(root, "deploy", file), path.join(dir, file));
		const socket = path.join(dir, "fake.sock");
		fs.writeFileSync(socket, "");
		return { dir, socket };
	};
	// `id -u` is stubbed: the script refuses root, and these tests may run as root.
	const withId = (uid: string) => {
		const bin = tmp("id-bin");
		fs.writeFileSync(path.join(bin, "id"), `#!/bin/sh\necho ${uid}\n`, { mode: 0o755 });
		return bin;
	};
	const run = (dir: string, socket: string, uid = "1000", extra: Record<string, string> = {}) =>
		spawnSync("sh", [path.join(dir, "make-secrets.sh")], { cwd: os.tmpdir(), env: { ...envOf({ LH_DOCKER_SOCKET: socket, ...extra }), PATH: `${withId(uid)}:${process.env.PATH}` } as NodeJS.ProcessEnv, encoding: "utf8" });
	const values = (dir: string) => Object.fromEntries(fs.readFileSync(path.join(dir, ".env"), "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

	it("starts from .env.example, adds the three secrets and the socket's group, mode 600, and prints no value", () => {
		const { dir, socket } = setup();
		const result = run(dir, socket);
		assert.equal(result.status, 0, result.stderr);
		const env = values(dir);
		for (const name of SECRETS) assert.match(env[name] ?? "", /^[0-9a-f]{64}$/, name);
		assert.equal(new Set(SECRETS.map((n) => env[n])).size, 3, "three different secrets");
		assert.match(env.LH_DOCKER_GID ?? "", /^\d+$/);
		assert.equal(env.LH_MAX_ACCOUNTS, "4", "what .env.example had is kept");
		assert.equal(fs.statSync(path.join(dir, ".env")).mode & 0o777, 0o600);
		for (const secret of Object.values(env)) if (secret.length >= 32) assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret));
		assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith(".env.")).sort(), [".env.example"], "no temporary file is left");
	});

	it("only adds what is missing and never replaces a value", () => {
		const { dir, socket } = setup();
		fs.writeFileSync(path.join(dir, ".env"), "LH_DOMAIN=learn.example.test\nLH_GATE_SECRET=keepme\nLH_MAKER_TOKEN=\nLH_DOCKER_GID=77", { mode: 0o644 });
		const result = run(dir, socket);
		assert.equal(result.status, 0, result.stderr);
		const env = values(dir);
		assert.equal(env.LH_GATE_SECRET, "keepme");
		assert.equal(env.LH_DOCKER_GID, "77");
		assert.equal(env.LH_DOMAIN, "learn.example.test");
		assert.match(env.LH_MAKER_TOKEN ?? "", /^[0-9a-f]{64}$/, "an empty value counts as missing");
		assert.equal((fs.readFileSync(path.join(dir, ".env"), "utf8").match(/^LH_MAKER_TOKEN=/gm) ?? []).length, 1);
		assert.equal(fs.statSync(path.join(dir, ".env")).mode & 0o777, 0o600, "a loose file is tightened");
		const before = fs.readFileSync(path.join(dir, ".env"), "utf8");
		assert.equal(run(dir, socket).status, 0);
		assert.equal(fs.readFileSync(path.join(dir, ".env"), "utf8"), before, "a second run changes nothing");
	});

	it("refuses to run as root, unless the existing .env is already root's", () => {
		const { dir, socket } = setup();
		const fresh = run(dir, socket, "0");
		assert.equal(fresh.status, 1);
		assert.match(fresh.stderr, /not as root/);
		assert.ok(!fs.existsSync(path.join(dir, ".env")), "nothing was created");
		fs.writeFileSync(path.join(dir, ".env"), "LH_DOMAIN=x\n");
		const mine = run(dir, socket, "0");
		const owner = fs.statSync(path.join(dir, ".env")).uid;
		// As root, a file root owns may be added to; one owned by anybody else may not.
		assert.equal(mine.status, owner === 0 ? 0 : 1, mine.stderr);
		if (owner !== 0) assert.equal(fs.readFileSync(path.join(dir, ".env"), "utf8"), "LH_DOMAIN=x\n");
	});

	it("reads the group of the same socket path compose mounts: the shell's, else .env's, else the default", () => {
		const { dir } = setup();
		const sock = path.join(dir, "from-env.sock");
		fs.writeFileSync(sock, "");
		fs.writeFileSync(path.join(dir, ".env"), `LH_DOCKER_SOCKET=${sock}\n`);
		const result = run(dir, "", "1000", { LH_DOCKER_SOCKET: "" });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(values(dir).LH_DOCKER_GID, String(fs.statSync(sock).gid), "the .env value was used");
		const missing = setup();
		fs.writeFileSync(path.join(missing.dir, ".env"), `LH_DOCKER_SOCKET=${path.join(missing.dir, "no-such.sock")}\n`);
		const refused = run(missing.dir, "", "1000", { LH_DOCKER_SOCKET: "" });
		assert.equal(refused.status, 1);
		assert.match(refused.stderr, /LH_DOCKER_GID: not found/);
	});

	it("refuses when .env is tracked by git", () => {
		const { dir, socket } = setup();
		fs.writeFileSync(path.join(dir, ".env"), "LH_DOMAIN=x\n");
		execFileSync("git", ["init", "-q", dir]);
		execFileSync("git", ["-C", dir, "add", "-f", ".env"]);
		const result = run(dir, socket);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /tracked by git/);
		assert.equal(fs.readFileSync(path.join(dir, ".env"), "utf8"), "LH_DOMAIN=x\n");
	});
});

describe("scripts/build-gateway.mjs", () => {
	const script = path.join(root, "scripts", "build-gateway.mjs");
	const run = (env: Record<string, string>) => spawnSync(process.execPath, [script], { env: envOf(env), encoding: "utf8" });

	it("fails clearly, naming the entry file, when one is missing", () => {
		const dir = tmp("bundle-missing");
		const maker = path.join(dir, "maker.ts");
		fs.writeFileSync(maker, "console.log('maker');\n");
		const result = run({ LH_GATEWAY_ENTRY_MAIN: path.join(dir, "no-such-main.ts"), LH_GATEWAY_ENTRY_MAKER: maker, LH_GATEWAY_BUILD_OUT: path.join(dir, "out") });
		assert.equal(result.status, 1);
		assert.match(result.stderr, /entry file missing: .*no-such-main\.ts/);
		assert.ok(!fs.existsSync(path.join(dir, "out", "gateway.mjs")));
	});

	it("bundles two entries, imports from src/core included, into single files that run on plain Node", () => {
		const dir = tmp("bundle-ok");
		fs.writeFileSync(path.join(dir, "main.ts"), `import { newSetupCode } from ${JSON.stringify(path.join(root, "src/core/server-auth.ts"))};\nimport fs from "node:fs";\nconsole.log("gateway", typeof fs.readFileSync, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(newSetupCode()));\n`);
		fs.writeFileSync(path.join(dir, "maker.ts"), `import http from "node:http";\nconsole.log("maker", typeof http.request);\n`);
		const out = path.join(dir, "out");
		const result = run({ LH_GATEWAY_ENTRY_MAIN: path.join(dir, "main.ts"), LH_GATEWAY_ENTRY_MAKER: path.join(dir, "maker.ts"), LH_GATEWAY_BUILD_OUT: out });
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(fs.readdirSync(out).sort(), ["gateway.mjs", "maker.mjs"]);
		assert.equal(execFileSync(process.execPath, [path.join(out, "gateway.mjs")], { encoding: "utf8" }).trim(), "gateway function true");
		assert.equal(execFileSync(process.execPath, [path.join(out, "maker.mjs")], { encoding: "utf8" }).trim(), "maker function");
	});

	it("bundles the maker from its own start file, so importing the maker's code never starts it", () => {
		const script = read("scripts/build-gateway.mjs");
		assert.match(script, /path\.join\(ROOT, "gateway", "maker-main\.ts"\)/);
		assert.match(script, /path\.join\(ROOT, "gateway", "main\.ts"\)/);
		assert.ok(!script.includes('"maker.ts"'));
	});

	it("is wired: esbuild pinned to the installed version, an npm script, an ignored output folder", () => {
		const pkg = JSON.parse(read("package.json"));
		const installed = JSON.parse(fs.readFileSync(path.join(root, "node_modules/esbuild/package.json"), "utf8")).version;
		assert.equal(pkg.devDependencies.esbuild, installed, "exact version, no range");
		assert.equal(pkg.scripts["gateway:build"], "node scripts/build-gateway.mjs");
		assert.match(read(".gitignore"), /^\/gateway-dist\/$/m);
		assert.match(read(".dockerignore"), /^gateway-dist$/m);
		assert.ok(!/^gateway\/?$/m.test(read(".dockerignore")), "gateway/ reaches the build stage");
	});

	it("is not picked up by the desktop build", () => {
		for (const file of ["scripts/build-server.mjs", "electron-builder.yml", "electron-builder.side-tutor.yml"]) {
			assert.ok(!/gateway/i.test(read(file)), `${file} doesn't mention the gateway`);
		}
		assert.match(read("electron-builder.yml"), /- "!\*\*\/\*"\n\s+- electron\/\*\*\/\*/, "only the shell goes in the asar");
	});
});

describe("the image's wrappers", () => {
	const dockerfile = read("Dockerfile");

	it("builds the bundles in the build stage and copies them into the run stage", () => {
		const build = dockerfile.slice(0, dockerfile.lastIndexOf("\nFROM "));
		const runStage = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
		assert.match(build, /RUN node scripts\/build-gateway\.mjs/);
		assert.match(runStage, /COPY --from=build \/src\/gateway-dist\/gateway\.mjs \/src\/gateway-dist\/maker\.mjs \/app\/gateway\//);
		assert.match(runStage, /printf '#!\/bin\/sh\\nexec node \/app\/gateway\/gateway\.mjs "\$@"\\n' > \/usr\/local\/bin\/lh-gateway/);
		assert.match(runStage, /printf '#!\/bin\/sh\\nexec node \/app\/gateway\/maker\.mjs "\$@"\\n' > \/usr\/local\/bin\/lh-maker/);
		assert.match(runStage, /chmod 755 [^\n]*lh-gateway[^\n]*lh-maker/);
		assert.match(runStage, /mkdir -p [^\n]*\/gateway/, "the gateway's volume folder exists, owned by the image user");
		assert.match(runStage, /chown -R node:node \/data \/gateway/);
		assert.match(runStage, /CMD \["lh-entrypoint"\]/, "the default command is the single-copy start, as before");
	});

	it("reset-password resets the gateway's owner where LH_GATEWAY_FILE is set, and is the old script elsewhere", () => {
		const format = /printf '((?:[^'\\]|\\.)*)' > \/usr\/local\/bin\/reset-password/.exec(dockerfile)?.[1];
		assert.ok(format, "the reset-password wrapper is a printf line");
		const dir = tmp("wrapper");
		const bin = path.join(dir, "bin");
		fs.mkdirSync(bin);
		const wrapper = path.join(bin, "reset-password");
		execFileSync("sh", ["-c", `printf '${format}' > "$OUT"`], { env: envOf({ OUT: wrapper }) });
		fs.chmodSync(wrapper, 0o755);
		// Stand-ins for the two programs the wrapper can start.
		fs.writeFileSync(path.join(bin, "lh-gateway"), '#!/bin/sh\necho "gateway $*"\n', { mode: 0o755 });
		fs.writeFileSync(path.join(bin, "node"), '#!/bin/sh\necho "node $*"\n', { mode: 0o755 });
		const call = (env: Record<string, string>) => execFileSync("sh", [wrapper, "--x"], { env: { ...envOf(env), PATH: `${bin}:${process.env.PATH}` } as NodeJS.ProcessEnv, encoding: "utf8" }).trim();
		assert.equal(call({ LH_GATEWAY_FILE: "/gateway/accounts.json" }), "gateway reset-owner --x");
		assert.equal(call({}), "node /app/scripts/server-reset-password.mjs --x");
		assert.equal(call({ LH_GATEWAY_FILE: "" }), "node /app/scripts/server-reset-password.mjs --x", "an empty variable is not the gateway");
	});

	it("leaves the single-copy reset script untouched", () => {
		const script = read("scripts/server-reset-password.mjs");
		assert.ok(!script.includes("LH_GATEWAY_FILE"), "the switch lives in the wrapper");
	});
});

describe("deploy/update.sh restarts the maker only when it is safe", () => {
	// A stand-in `docker`: `compose ps -q <service>` answers a container id from
	// <state>/<service>.before until `compose up` has run, then .after.
	const scenario = (ids: Record<string, [string, string]>) => {
		const dir = tmp("update");
		const bin = path.join(dir, "bin");
		const state = path.join(dir, "state");
		fs.mkdirSync(bin);
		fs.mkdirSync(state);
		fs.copyFileSync(path.join(root, "deploy", "update.sh"), path.join(dir, "update.sh"));
		fs.writeFileSync(
			path.join(bin, "docker"),
			[
				"#!/bin/sh",
				'echo "$*" >> "$STATE/calls"',
				'case "$1 $2" in',
				'  "compose ps") if [ -f "$STATE/upped" ]; then f="$STATE/$4.after"; else f="$STATE/$4.before"; fi; [ -f "$f" ] && cat "$f"; exit 0;;',
				'  "compose up") touch "$STATE/upped";;',
				"esac",
				"exit 0",
				"",
			].join("\n"),
			{ mode: 0o755 },
		);
		for (const [service, [before, after]] of Object.entries(ids)) {
			if (before) fs.writeFileSync(path.join(state, `${service}.before`), before);
			if (after) fs.writeFileSync(path.join(state, `${service}.after`), after);
		}
		const result = spawnSync("sh", [path.join(dir, "update.sh")], { env: { ...envOf({ STATE: state }), PATH: `${bin}:${process.env.PATH}` } as NodeJS.ProcessEnv, encoding: "utf8" });
		const calls = fs.existsSync(path.join(state, "calls")) ? fs.readFileSync(path.join(state, "calls"), "utf8").split("\n").filter(Boolean) : [];
		return { result, calls, restarted: calls.includes("compose restart maker") };
	};

	it("restarts a maker that kept running (nothing re-created it)", () => {
		const run = scenario({ maker: ["m1", "m1"], caddy: ["c1", "c1"] });
		assert.equal(run.result.status, 0, run.result.stderr);
		assert.ok(run.restarted);
	});

	it("leaves a maker that `up -d` re-created alone: it is already bringing the copies over", () => {
		const run = scenario({ maker: ["m1", "m2"], caddy: ["c1", "c1"] });
		assert.equal(run.result.status, 0, run.result.stderr);
		assert.ok(!run.restarted);
	});

	it("restarts it (its SIGTERM waits for a pass) when Caddy was re-created, which lost its network joins", () => {
		for (const maker of [["m1", "m1"], ["m1", "m2"]] as [string, string][]) {
			const run = scenario({ maker, caddy: ["c1", "c2"] });
			assert.ok(run.restarted, `maker ${maker.join("->")}`);
		}
	});

	it("does nothing to a maker that did not exist before: the first switch-over", () => {
		const run = scenario({ maker: ["", "m1"], caddy: ["c1", "c2"] });
		assert.equal(run.result.status, 0, run.result.stderr);
		assert.ok(!run.restarted);
		assert.ok(run.calls.some((c) => c.startsWith("compose up -d")), "the stack still comes up");
	});

	it("still prunes images and updates Claude Code", () => {
		const run = scenario({ maker: ["m1", "m1"], caddy: ["c1", "c1"] });
		assert.ok(run.calls.includes("image prune -f"));
		assert.ok(run.calls.includes("compose exec -T lh claude update"));
	});
});

describe("deploy/update.sh", () => {
	const update = read("deploy/update.sh");
	it("still pulls, brings the stack up and updates Claude Code, then re-reconciles the maker", () => {
		const lines = update.split("\n");
		const at = (needle: string) => lines.findIndex((line) => line.includes(needle));
		assert.ok(at("docker compose pull") > 0);
		assert.ok(at("docker compose up -d --remove-orphans") > at("docker compose pull"));
		assert.ok(at("docker compose restart maker") > at("docker compose up -d --remove-orphans"));
		assert.ok(at("exec -T lh claude update") > at("docker compose restart maker"));
		assert.match(update, /claude update[^\n]*\|\| true/, "never fails the update over Claude Code");
	});
});
