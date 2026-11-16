#!/usr/bin/env node
/**
 * build-gateway.mjs: bundle the multi-account gateway and maker
 * (docs/multi-account-build.md, slice 1d) into two single ESM files that the
 * server image runs with plain Node:
 *
 *   gateway/main.ts  -> gateway-dist/gateway.mjs   (`lh-gateway`)
 *   gateway/maker-main.ts -> gateway-dist/maker.mjs  (`lh-maker`)
 *
 * No dependency but Node's own modules (they stay external). Run in the
 * image's build stage; the output folder is git-ignored. The desktop app's
 * build (scripts/build-server.mjs, electron-builder) never reads it.
 *
 * Overrides, for tests: LH_GATEWAY_BUILD_OUT (output folder),
 * LH_GATEWAY_ENTRY_MAIN and LH_GATEWAY_ENTRY_MAKER (entry files).
 */
import { builtinModules } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.resolve(process.env.LH_GATEWAY_BUILD_OUT || path.join(ROOT, "gateway-dist"));
/** The run stage of the Dockerfile is node:26. */
const TARGET = "node26";

const entries = [
	{ name: "gateway", file: path.resolve(process.env.LH_GATEWAY_ENTRY_MAIN || path.join(ROOT, "gateway", "main.ts")) },
	{ name: "maker", file: path.resolve(process.env.LH_GATEWAY_ENTRY_MAKER || path.join(ROOT, "gateway", "maker-main.ts")) },
];

for (const entry of entries) {
	if (!fs.existsSync(entry.file)) {
		console.error(`[build-gateway] entry file missing: ${path.relative(ROOT, entry.file) || entry.file} (needed for ${entry.name}.mjs)`);
		process.exit(1);
	}
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// Bundled CommonJS code that calls require() needs one in an ES module.
const banner = 'import { createRequire as __lhCreateRequire } from "node:module"; const require = __lhCreateRequire(import.meta.url);';

for (const entry of entries) {
	try {
		await build({
			entryPoints: [entry.file],
			outfile: path.join(OUT, `${entry.name}.mjs`),
			bundle: true,
			platform: "node",
			format: "esm",
			target: TARGET,
			external: [...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
			banner: { js: banner },
			legalComments: "none",
			logLevel: "warning",
		});
	} catch (error) {
		console.error(`[build-gateway] ${entry.name} did not bundle: ${error instanceof Error ? error.message.split("\n")[0] : "unknown error"}`);
		process.exit(1);
	}
}

for (const entry of entries) {
	const bytes = fs.statSync(path.join(OUT, `${entry.name}.mjs`)).size;
	console.log(`[build-gateway] ${path.relative(ROOT, path.join(OUT, `${entry.name}.mjs`)) || `${entry.name}.mjs`} (${bytes} bytes)`);
}
