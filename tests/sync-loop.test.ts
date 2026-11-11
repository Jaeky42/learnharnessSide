/**
 * Cloud sync Phase 5, slice 6 (docs/cloud-sync.md): WHEN a paired desktop
 * syncs. Owner's decision: a round at app start; about 2 seconds after a
 * change; at once when a reply starts; every 10 seconds otherwise; quiet
 * retries while offline that slow to once every few minutes; and nothing
 * at all in an app that isn't paired.
 *
 * The clock and the timers are simulated.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sync-loop-"));
process.env.LH_AUTH_FILE = path.join(TMP, "secrets", "auth.json");
process.env.LH_DATA_DIR = path.join(TMP, "data");

const { createSyncLoop, retryDelayMs, POLL_MS, CHANGE_MS, RETRY_MAX_MS } = await import("../src/server/sync/loop.ts");
const { shouldAutostart } = await import("../src/server/sync/autostart.ts");
const { writeCloudPairing } = await import("../src/store/sync/pairing.ts");
import type { RoundOutcome } from "../src/server/sync/loop.ts";
import type { ServerEvent } from "../src/core/events.ts";

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function harness() {
	let now = 0;
	let nextId = 1;
	const timers = new Map<number, { due: number; run: () => void }>();
	let listener: ((event: ServerEvent) => void) | null = null;
	/** When each round started, in seconds from the start. */
	const rounds: number[] = [];
	let outcome: RoundOutcome = "ok";
	let roundMs = 0;
	let finish: Array<() => void> = [];
	const loop = createSyncLoop({
		round: () => {
			rounds.push(now / 1000);
			const result = outcome;
			if (roundMs === 0) return Promise.resolve(result);
			return new Promise((resolve) => { finish.push(() => resolve(result)); });
		},
		subscribe: (fn) => { listener = fn; return () => { listener = null; }; },
		now: () => now,
		setTimer: (run, ms) => { const id = nextId++; timers.set(id, { due: now + ms, run }); return id; },
		clearTimer: (handle) => { timers.delete(handle as number); },
	});
	const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
	return {
		loop, rounds, timers,
		/** Let time pass, running every timer that comes due, in order. */
		async pass(ms: number) {
			const until = now + ms;
			for (;;) {
				const next = [...timers.entries()].filter(([, t]) => t.due <= until).sort((a, b) => a[1].due - b[1].due)[0];
				if (!next) break;
				now = Math.max(now, next[1].due);
				timers.delete(next[0]);
				next[1].run();
				await settle();
			}
			now = until;
			await settle();
		},
		emit(type: ServerEvent["type"]) { listener?.({ type, chatId: "chat_1" } as ServerEvent); },
		listening: () => listener !== null,
		server(next: RoundOutcome) { outcome = next; },
		/** Rounds take real time from now on; finishRound() ends the one under way. */
		slowRounds() { roundMs = 1; },
		async finishRound() { const done = finish; finish = []; for (const f of done) f(); await settle(); },
	};
}

describe("a paired desktop's rhythm", () => {
	it("a round when the app starts, then one every 10 seconds", async () => {
		const h = harness();
		h.loop.start();
		await h.pass(35_000);
		assert.deepEqual(h.rounds, [0, 10, 20, 30]);
		assert.equal(POLL_MS, 10_000);
	});

	it("about 2 seconds after a change, and the 10 seconds count from there", async () => {
		const h = harness();
		h.loop.start();
		await h.pass(3_000);
		h.emit("turn-settled");
		await h.pass(1_000);
		h.emit("record-changed"); // a second change before the round: still one round
		await h.pass(20_000);
		assert.deepEqual(h.rounds, [0, 5, 15]);
		assert.equal(CHANGE_MS, 2_000);
	});

	it("a change just before the 10-second round doesn't push it back", async () => {
		const h = harness();
		h.loop.start();
		await h.pass(9_000);
		h.emit("chats-changed");
		await h.pass(2_000);
		assert.deepEqual(h.rounds, [0, 10]);
	});

	it("at once when a reply starts, so the server knows this desktop is busy", async () => {
		const h = harness();
		h.loop.start();
		await h.pass(4_000);
		h.emit("turn-started");
		await h.pass(0);
		assert.deepEqual(h.rounds, [0, 4]);
	});

	it("every kind of change counts: a helper, a folder, an extraction", async () => {
		for (const type of ["jobs-changed", "sources-changed", "activity-changed"] as const) {
			const h = harness();
			h.loop.start();
			await h.pass(1_000);
			h.emit(type);
			await h.pass(2_000);
			assert.deepEqual(h.rounds, [0, 3], type);
		}
		const h = harness();
		h.loop.start();
		await h.pass(1_000);
		h.emit("subscriptions-changed"); // nothing that syncs
		await h.pass(5_000);
		assert.deepEqual(h.rounds, [0]);
	});

	it("a change while a round is under way: one more round 2 seconds after it ends", async () => {
		const h = harness();
		h.slowRounds();
		h.loop.start();
		await h.pass(0);
		h.emit("turn-settled");
		h.emit("turn-started");
		await h.pass(30_000);
		assert.deepEqual(h.rounds, [0], "never two rounds at once");
		await h.finishRound();
		await h.pass(2_000);
		assert.deepEqual(h.rounds, [0, 32]);
	});
});

describe("while the server can't be reached", () => {
	it("the retries slow down to once every five minutes, and a change doesn't hurry them", async () => {
		const h = harness();
		h.server("offline");
		h.loop.start();
		await h.pass(0);
		h.emit("turn-settled");
		h.emit("turn-started");
		await h.pass(20 * 60_000);
		assert.deepEqual(h.rounds.slice(0, 8), [0, 10, 30, 70, 150, 310, 610, 910]);
		assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 20].map(retryDelayMs), [10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000]);
		assert.equal(RETRY_MAX_MS, 300_000);
	});

	it("back online: the next retry finds it, and the 10 seconds are back", async () => {
		const h = harness();
		h.server("offline");
		h.loop.start();
		await h.pass(35_000); // rounds at 0, 10, 30
		h.server("ok");
		await h.pass(60_000);
		assert.deepEqual(h.rounds, [0, 10, 30, 70, 80, 90]);
	});

	it("a round that throws counts as not reached", async () => {
		const h = harness();
		const loop = createSyncLoop({
			round: () => { h.rounds.push(-1); return Promise.reject(new Error("boom")); },
			subscribe: () => () => {},
			now: () => 0,
			setTimer: (run, ms) => { h.timers.set(999, { due: ms, run }); return 999; },
			clearTimer: () => {},
		});
		loop.start();
		await h.pass(0);
		assert.equal(h.timers.get(999)?.due, 10_000);
	});
});

describe("when a retry can't help", () => {
	it("paused (the versions differ) or unpaired by the server: a look every five minutes", async () => {
		for (const state of ["paused", "not-paired"] as const) {
			const h = harness();
			h.server(state);
			h.loop.start();
			await h.pass(11 * 60_000);
			assert.deepEqual(h.rounds, [0, 300, 600], state);
		}
	});

	it("\"Sync now\" and pairing again run a round at once and forget the slow pace", async () => {
		const h = harness();
		h.server("offline");
		h.loop.start();
		await h.pass(100_000); // 0, 10, 30, 70
		h.server("ok");
		h.loop.now();
		await h.pass(25_000);
		assert.deepEqual(h.rounds, [0, 10, 30, 70, 100, 110, 120]);
	});

	it("stopped, it sets no more timers and listens to nothing", async () => {
		const h = harness();
		h.loop.start();
		await h.pass(1_000);
		h.loop.stop();
		assert.equal(h.timers.size, 0);
		assert.equal(h.listening(), false);
		h.emit("turn-settled");
		await h.pass(60_000);
		assert.deepEqual(h.rounds, [0]);
		assert.equal(h.loop.started(), false);
	});
});

describe("an app that isn't paired starts nothing", () => {
	it("no pairing file: no loop. Paired: a loop, but never on the server, in a build or in tests", () => {
		const env = { NODE_ENV: "production" } as NodeJS.ProcessEnv;
		assert.equal(shouldAutostart(env), false, "never paired");
		writeCloudPairing({ version: 1, deviceId: "dev_aaaaaaaaaaaaaaaa", name: "Office PC", server: "https://learn.example.com", key: "k".repeat(43), pairedAt: 1 });
		assert.equal(shouldAutostart(env), true);
		assert.equal(shouldAutostart({ ...env, NODE_ENV: "test" }), false);
		assert.equal(shouldAutostart({ ...env, NEXT_PHASE: "phase-production-build" }), false);
		assert.equal(shouldAutostart({ ...env, LH_SYNC_LOOP: "off" }), false);
		process.env.LH_SERVER_MODE = "1";
		try { assert.equal(shouldAutostart(env), false, "the cloud server never starts one"); } finally { delete process.env.LH_SERVER_MODE; }
	});
});
