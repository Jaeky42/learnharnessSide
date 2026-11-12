import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

// The demo agent runs every demo in a browser before it is shown. The desktop
// app uses its own Electron for that; the server image has none, so it must
// carry a browser where the checker looks. Without one, every demo on the
// server failed with "No render engine available" (found by the owner).
const root = path.join(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("the server image has a browser for the demo agent", () => {
	it("installs Chromium in the stage that runs, at a path the checker tries", () => {
		const dockerfile = read("Dockerfile");
		const runStage = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
		const install = /apt-get install[^\n]*/.exec(runStage)?.[0] ?? "";
		assert.match(install, /(?:^|\s)chromium(?:\s|$)/, "the run stage installs Debian's chromium package");
		// Debian's package puts the program at /usr/bin/chromium.
		assert.match(read("src/agent/subagents/headless.ts"), /"\/usr\/bin\/chromium"/, "upstream's checker still looks there");
	});

	it("the image workflow starts that browser in the built image", () => {
		const workflow = read(".github/workflows/server-image.yml");
		assert.match(workflow, /docker exec lh chromium --headless --no-sandbox/);
	});
});
