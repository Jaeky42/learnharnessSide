/**
 * STARTUP ANNOUNCEMENTS ARE OFF IN THIS FORK'S APP (owner's decision at the
 * upstream v0.7.0 merge). Upstream's packaged app fetches
 * learnharness.ai/startup-messages.json at launch and shows the newest message
 * once. The Side Tutor app never contacts that address and never shows the
 * box. Upstream's files (electron/startup-messages.cjs, the renderer's box)
 * stay in place so later releases merge cleanly; this pins, at source level,
 * that the main process never loads or starts the feed.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const main = readFileSync(fileURLToPath(new URL("../electron/main.cjs", import.meta.url)), "utf8");
const feed = readFileSync(fileURLToPath(new URL("../electron/startup-messages.cjs", import.meta.url)), "utf8");

/** The source with line and block comments taken out, so the explaining
 *  comment may name what it switched off. */
function code(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("startup announcements are off", () => {
	it("the main process never loads or starts the feed", () => {
		const live = code(main);
		assert.doesNotMatch(live, /startup-messages\.cjs/);
		assert.doesNotMatch(live, /startMessages\s*\(/);
		assert.doesNotMatch(live, /dismissalStore\s*\(/);
	});

	it("nothing in the main process names the feed's address, and the marker is there", () => {
		assert.doesNotMatch(code(main), /learnharness\.ai/);
		assert.match(main, /FORK \(startup announcements off\)/);
	});

	it("the two handlers stay and answer 'no message' while nothing was started", () => {
		const live = code(main);
		assert.match(live, /ipcMain\.handle\("lh:startup-message:take", event => messages && /);
		assert.match(live, /ipcMain\.handle\("lh:startup-message:dismiss", \(event, id\) => !!messages && /);
		// `messages` is declared and never assigned in the main process.
		assert.match(live, /let messages;/);
		assert.doesNotMatch(live, /\bmessages\s*=[^=]/);
	});

	it("upstream's feed file is still there, unchanged in how it is fetched", () => {
		assert.match(feed, /learnharness\.ai\/startup-messages\.json/);
	});
});
