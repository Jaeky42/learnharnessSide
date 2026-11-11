/**
 * Cloud sync Phase 5, slice 3: take-over against this copy's REAL turn and
 * job machinery (owner's decision: the reply being written finishes first;
 * helpers and extraction stop here and start again on the new holder).
 *
 * This process plays the cloud server. LH_DATA_DIR and LH_AUTH_FILE are
 * redirected BEFORE the first config import.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sync-work-"));
process.env.LH_AUTH_FILE = path.join(TMP, "secrets", "auth.json");
process.env.LH_DATA_DIR = path.join(TMP, "data");
process.env.LH_SERVER_MODE = "1";

const { stores } = await import("../src/server/stores.ts");
await import("../src/server/sync/local-work.ts");
const engine = await import("../src/server/sync/engine.ts");
const { beginTurn, endTurn } = await import("../src/server/turn-liveness.ts");
const { registerJobAbort, isJobLive } = await import("../src/agent/subagents/aborts.ts");
const { recoverStaleJobs } = await import("../src/server/jobs.ts");

after(() => {
	delete process.env.LH_SERVER_MODE;
	fs.rmSync(TMP, { recursive: true, force: true });
});

const DESK = "dev_aaaaaaaaaaaaaaaa";

describe("a desktop asks the cloud for a session", () => {
	const chat = stores.chatStore.createChat("Motors");
	const job = stores.jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "tool_1", input: { question: "q" } });
	const controller = new AbortController();
	registerJobAbort(job.id, controller);

	it("the first sync starts the record and makes the backup", () => {
		assert.equal(engine.syncAuthority().active(), false);
		const reply = engine.syncAuthority().exchange(DESK, { cursor: 0 });
		assert.equal(reply.status, 200);
		assert.equal(engine.syncAuthority().active(), true);
		assert.equal(fs.readdirSync(path.join(TMP, "backups")).length, 1);
		assert.equal(engine.holdsSession(chat.id), true);
	});

	it("while a reply is being written it waits, and nothing is stopped", () => {
		assert.equal(beginTurn(chat.id), true);
		const reply = engine.syncAuthority().takeOver(DESK, chat.id, false);
		assert.equal(reply.body.status, "waiting");
		assert.equal(reply.body.reason, "reply");
		assert.equal(controller.signal.aborted, false);
		assert.equal(engine.holdsSession(chat.id), true);
		endTurn(chat.id);
	});

	it("then it moves: the helper stops here, its record stays \"running\" for the new holder", () => {
		const reply = engine.syncAuthority().takeOver(DESK, chat.id, false);
		assert.equal(reply.body.status, "moved");
		assert.equal(controller.signal.aborted, true);
		assert.equal(isJobLive(job.id), false);
		assert.equal(stores.jobStore.getJob(job.id)?.status, "running");
		assert.equal(engine.holdsSession(chat.id), false);
		assert.deepEqual(engine.sessionHolder(chat.id), { id: DESK, name: null });
	});

	it("and the helper is not restarted here, where the session is no longer held", () => {
		const warn = console.warn;
		console.warn = () => {};
		try { recoverStaleJobs(); } finally { console.warn = warn; }
		const record = stores.jobStore.getJob(job.id)!;
		assert.equal(record.activity, "starting", "untouched: no \"recovering: re-running\"");
	});
});
