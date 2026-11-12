/**
 * Flashcards sync, decision S2 (docs/phone-plugins-plan.md): the server
 * follows the PC's time zone. Pins: a zone a paired desktop gives is kept
 * and used by this very process at once, by Date's local getters (the
 * plugin's scheduler) and by Intl's default zone (its review tickets); it
 * is used again at the next start, before the plugin works anything out;
 * the most recent one counts; a name that isn't a zone is ignored; and the
 * plugin's own study day follows. Also: the loop's 2-second trigger.
 *
 * This file changes its own process's time zone; the test runner gives
 * every file a process of its own.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-fc-zone-"));
process.env.LH_AUTH_FILE = path.join(TMP, "secrets", "auth.json");
process.env.LH_DATA_DIR = path.join(TMP, "data");
process.env.TZ = "UTC";

const zone = await import("../src/server/sync/flashcards-zone.ts");
const { createSyncLoop, CHANGE_MS, POLL_MS } = await import("../src/server/sync/loop.ts");
const { SYNC_ECHO } = await import("../src/server/sync/flashcards-engine.ts");
import type { ServerEvent } from "../src/core/events.ts";
const require = createRequire(import.meta.url);
const scheduler = require("../plugins/flashcards/src/scheduler.cjs") as { studyDay(now: number, dayStart?: number): string };

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const SYNC = path.join(TMP, "data", "sync");
/** 23:30 UTC on 4 May: still the 4th in London's winter… and the 5th in Stockholm (01:30). */
const MOMENT = Date.UTC(2026, 4, 4, 23, 30);

describe("the server follows the PC's time zone", () => {
	it("starts in the zone it was given (here UTC), and has nothing saved", () => {
		assert.equal(new Date(MOMENT).getHours(), 23);
		assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, "UTC");
		assert.equal(zone.storedTimeZone(SYNC), null);
		zone.applyStoredTimeZone(SYNC);
		assert.equal(process.env.TZ, "UTC", "nothing saved, nothing changed");
		assert.equal(fs.existsSync(SYNC), false);
	});

	it("a desktop's zone is kept, and this running process follows it at once: Date's local time and Intl's zone", () => {
		zone.takeTimeZone("dev_aaaaaaaaaaaaaaaa", "Europe/Stockholm", { syncDir: SYNC, now: 1 });
		assert.equal(process.env.TZ, "Europe/Stockholm");
		assert.equal(new Date(MOMENT).getHours(), 1);
		assert.equal(new Date(MOMENT).getDate(), 5);
		assert.equal(new Date(MOMENT).getTimezoneOffset(), -120);
		assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, "Europe/Stockholm");
		// The plugin's own study day (dayStart 0) is the Stockholm one.
		assert.equal(scheduler.studyDay(MOMENT, 0), "2026-05-05");
		assert.deepEqual(zone.storedTimeZone(SYNC), { version: 1, zone: "Europe/Stockholm", from: "dev_aaaaaaaaaaaaaaaa", at: 1 });
	});

	it("the same zone again writes nothing; a newer one wins", () => {
		const file = path.join(SYNC, "time-zone.json");
		const before = fs.statSync(file).mtimeMs;
		zone.takeTimeZone("dev_bbbbbbbbbbbbbbbb", "Europe/Stockholm", { syncDir: SYNC, now: 2 });
		assert.equal(fs.statSync(file).mtimeMs, before);
		zone.takeTimeZone("dev_bbbbbbbbbbbbbbbb", "America/New_York", { syncDir: SYNC, now: 3 });
		assert.equal(new Date(MOMENT).getHours(), 19);
		assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, "America/New_York");
		assert.equal(scheduler.studyDay(MOMENT, 0), "2026-05-04");
		assert.equal(zone.storedTimeZone(SYNC)!.from, "dev_bbbbbbbbbbbbbbbb");
	});

	it("a name that isn't a zone is ignored", () => {
		for (const bad of ["Mars/Olympus", "", "../../etc", "UTC; rm", 5 as unknown as string, "A".repeat(80)]) {
			zone.takeTimeZone("dev_cccccccccccccccc", bad, { syncDir: SYNC });
			assert.equal(process.env.TZ, "America/New_York");
		}
		assert.equal(zone.isTimeZoneName("UTC"), true);
		assert.equal(zone.isTimeZoneName("Asia/Kolkata"), true);
	});

	it("at the next start the saved zone is used again (instrumentation runs this before the plugins)", () => {
		process.env.TZ = "UTC";
		assert.equal(new Date(MOMENT).getHours(), 23);
		zone.applyStoredTimeZone(SYNC);
		assert.equal(process.env.TZ, "America/New_York");
		assert.equal(new Date(MOMENT).getHours(), 19);
		assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, "America/New_York");
	});

	it("instrumentation applies it before it initializes the plugins, on the server only", () => {
		const text = fs.readFileSync(path.join(import.meta.dirname, "..", "instrumentation.ts"), "utf8");
		const zoneAt = text.indexOf("applyStoredTimeZone()");
		assert.ok(zoneAt > 0 && zoneAt < text.indexOf("initializePlugins()"));
		assert.ok(text.lastIndexOf('process.env.LH_SERVER_MODE === "1"', zoneAt) > 0);
	});
});

describe("the loop's Flashcards trigger", () => {
	function loop() {
		const timers: Array<{ ms: number; run: () => void }> = [];
		let listener: ((event: ServerEvent) => void) | null = null;
		let rounds = 0;
		const l = createSyncLoop({
			round: async () => { rounds++; return "ok"; },
			subscribe: (fn) => { listener = fn; return () => { listener = null; }; },
			now: () => 0,
			setTimer: (run, ms) => { const t = { ms, run }; timers.push(t); return t; },
			clearTimer: (handle) => { const i = timers.indexOf(handle as never); if (i >= 0) timers.splice(i, 1); },
		});
		return { l, timers, emit: (event: ServerEvent) => listener!(event), rounds: () => rounds };
	}

	it("a change Flashcards announces (cards it adds come as batch-changed) is sent 2 seconds later; what sync wrote is not", async () => {
		const x = loop();
		x.l.start();
		x.timers.shift()!.run();
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(x.timers.map((t) => t.ms), [POLL_MS]);
		x.emit({ type: "plugin-message", pluginId: "flashcards", topic: "changed", data: SYNC_ECHO });
		x.emit({ type: "plugin-message", pluginId: "drawing-pad", topic: "changed" });
		x.emit({ type: "plugin-message", pluginId: "flashcards", topic: "agents-changed" });
		assert.deepEqual(x.timers.map((t) => t.ms), [POLL_MS], "nothing sooner");
		x.emit({ type: "plugin-message", pluginId: "flashcards", topic: "changed" });
		assert.deepEqual(x.timers.map((t) => t.ms), [CHANGE_MS]);
		x.timers.shift()!.run();
		await new Promise((resolve) => setImmediate(resolve));
		x.emit({ type: "plugin-message", pluginId: "flashcards", topic: "batch-changed" });
		assert.deepEqual(x.timers.map((t) => t.ms), [CHANGE_MS]);
		x.l.stop();
	});
});
