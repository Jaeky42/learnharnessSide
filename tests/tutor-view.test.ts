/**
 * The Tutor window's view of upstream's side conversations (side-tutor fork):
 * the order of the conversations and the words of each divider. Pure.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { orderTutorThreads, plainFirstWords, tutorStepLabel, type LhMessage } from "../src/core/index.ts";
import { removeOldSideTutorThreads } from "../src/server/side-tutor-cleanup.ts";

const lesson = (...entries: Array<[id: string, role: "user" | "assistant", text: string]>) =>
	entries.map(([id, role, text], index) => (role === "user" ? { id, role, content: text, timestamp: index } : { id, role, content: [{ type: "text", text }], timestamp: index })) as unknown as LhMessage[];

describe("a step's first words (the divider)", () => {
	it("are plain text: no formatting marks", () => {
		assert.equal(plainFirstWords("## The **determinant**\n\nIt says how much _area_ scales."), "The determinant");
		assert.equal(plainFirstWords("- First, look at `A`.\n- Then at B."), "First, look at A. Then at B.");
		assert.equal(plainFirstWords("> See [the proof](https://example.com/p) for *why*."), "See the proof for why.");
	});

	it("stop at the first formula", () => {
		assert.equal(plainFirstWords("A few special vectors only get stretched. For those, $A\\mathbf{v} = \\lambda \\mathbf{v}$."), "A few special vectors only get stretched. For those…");
		assert.equal(plainFirstWords("The characteristic equation is\n$$\\det(A - \\lambda I) = 0$$"), "The characteristic equation is…");
	});

	it("spell out a formula at the very start roughly, so the divider isn't empty", () => {
		assert.equal(plainFirstWords("$\\lambda$ is the eigenvalue."), "lambda is the eigenvalue.");
		assert.equal(plainFirstWords("\\(A\\mathbf{v}\\) keeps its line."), "Av keeps its line.");
	});

	it("skip code blocks and blank openings, and are cut when very long", () => {
		assert.equal(plainFirstWords("```js\nconst a = 1;\n```\n\nNow in words."), "Now in words.");
		assert.equal(plainFirstWords(""), "");
		const long = plainFirstWords("word ".repeat(80));
		assert.ok(long.length <= 161 && long.endsWith("…"));
	});

	it("come from the step's first prose, also when the step opens with a message that has none", () => {
		const messages = [
			...lesson(["u1", "user", "teach me"]),
			{ id: "a1", role: "assistant", content: [{ type: "toolCall", id: "t1", name: "plan", arguments: {} }], timestamp: 1 },
			{ id: "r1", role: "toolResult", toolCallId: "t1", toolName: "plan", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 2 },
			...lesson(["a1b", "assistant", "Let's **start** with vectors."], ["u2", "user", "ok"], ["a2", "assistant", "Next: matrices."]),
		] as unknown as LhMessage[];
		assert.equal(tutorStepLabel(messages, "a1"), "Let's start with vectors.");
		assert.equal(tutorStepLabel(messages, "a2"), "Next: matrices.");
		assert.equal(tutorStepLabel(messages, "gone"), "", "a step that is no longer in the record has no words");
	});
});

describe("the conversations' order", () => {
	it("is the lesson's, whatever order they were started or saved in", () => {
		const messages = lesson(["u1", "user", "a"], ["a1", "assistant", "one"], ["u2", "user", "b"], ["a2", "assistant", "two"], ["u3", "user", "c"], ["a3", "assistant", "three"]);
		const thread = (step: string, createdAt: string) => ({ id: `side_${step}`, createdAt, anchor: { messageId: step, partId: "", blockIndex: 0, blockText: "" } });
		const ordered = orderTutorThreads(messages, [thread("a3", "2026-11-10T10:00:01Z"), thread("a1", "2026-11-10T10:00:03Z"), thread("old", "2026-11-10T09:00:00Z"), thread("a2", "2026-11-10T10:00:02Z")]);
		assert.deepEqual(ordered.map((entry) => entry.id), ["side_old", "side_a1", "side_a2", "side_a3"], "a step summarised away comes first");
	});
});

describe("the fork's old Tutor files", () => {
	it("are removed once: the folder goes, a second start finds nothing, and nothing else is touched", () => {
		const data = fs.mkdtempSync(path.join(os.tmpdir(), "lh-tutor-cleanup-"));
		try {
			const old = path.join(data, "side-tutor");
			fs.mkdirSync(old);
			fs.writeFileSync(path.join(old, "chat_1.json"), "{}");
			fs.mkdirSync(path.join(data, "chats"));
			fs.writeFileSync(path.join(data, "chats", "chat_1.json"), "{}");
			assert.equal(removeOldSideTutorThreads(old), true);
			assert.equal(fs.existsSync(old), false);
			assert.equal(removeOldSideTutorThreads(old), false);
			assert.deepEqual(fs.readdirSync(data), ["chats"]);
		} finally {
			fs.rmSync(data, { recursive: true, force: true });
		}
	});
});
