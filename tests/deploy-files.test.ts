import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createRequire } from "node:module";
import { sanitizeUserSettings } from "../src/core/settings.ts";

// The multi-account build and deploy files (docs/multi-account-build.md,
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
};
type Compose = { services: Record<"lh" | "gateway" | "maker" | "caddy", Service>; networks: Record<string, { internal?: boolean } | null>; volumes: Record<string, unknown> };
const compose = yaml.load(read("deploy/compose.yaml")) as Compose;
const networksOf = (service: Service) => (Array.isArray(service.networks) ? service.networks : Object.keys(service.networks ?? {})).sort();

describe("deploy/Caddyfile", () => {
	const caddyfile = read("deploy/Caddyfile");
	const route = caddyfile.slice(caddyfile.indexOf("route {"), caddyfile.indexOf("# Internal relay"));
	const relay = caddyfile.slice(caddyfile.indexOf("http://:9200"));

	it("strips the four X-LH-* headers before anything else is done", () => {
		const strip = /\(strip\) \{([^}]*)\}/.exec(caddyfile)?.[1] ?? "";
		for (const header of ["X-LH-Upstream", "X-LH-Gate", "X-LH-Relay", "X-LH-Client-Addr"]) {
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
		assert.match(toCopy, /copy_headers X-LH-Upstream X-LH-Gate/);
		assert.match(toCopy, /reverse_proxy \{http\.request\.header\.X-LH-Upstream\}/);
		assert.match(toCopy, /flush_interval -1/);
		assert.ok(caddyfile.indexOf("(to_copy)") < caddyfile.indexOf("import to_copy"), "a snippet is defined before it is imported");
		assert.match(route, /handle \{\s*import to_copy\s*\}\s*\}\s*\}\s*$/, "the default handler goes through the gateway");
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
	const run = (dir: string, socket: string) =>
		spawnSync("sh", [path.join(dir, "make-secrets.sh")], { cwd: os.tmpdir(), env: envOf({ LH_DOCKER_SOCKET: socket }), encoding: "utf8" });
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
