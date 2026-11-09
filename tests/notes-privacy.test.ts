/**
 * NOTES PRIVACY PINS — the learner's notes are for them alone.
 *
 *  1. The agents' file tools (read, ls, find, grep all resolve through
 *     fs-shared) refuse the vault's LearnHarness/ folder and the drawer's
 *     own data folder, and walks skip them. The rest of the vault stays
 *     readable (owner ruling: notes folder only).
 *  2. Note edits through the service, with a session id, leave the session
 *     record (the teacher's whole context) byte-for-byte untouched.
 *  3. Deleting a session leaves its notes in the vault.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-notes-privacy-"));
process.env.LH_DATA_DIR = path.join(TMP, "data");

const { notesStore } = await import("../src/store/notes.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { resolveSourcePath, walkFiles, privateNotesRoots } = await import("../src/agent/tools/fs-shared.ts");
const { noteSaveResponse, notesActionResponse } = await import("../src/server/notes.ts");
const { deleteChatSession } = await import("../src/server/chats.ts");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const vault = path.join(TMP, "Vault");
fs.mkdirSync(path.join(vault, "Other"), { recursive: true });
fs.writeFileSync(path.join(vault, "Other", "Public.md"), "readable");
notesStore.setVault(vault);
notesStore.create("Electricity", "Secret note", null);
notesStore.save("Electricity/Secret note.md", "my private thoughts\n", null, null);
const notePath = path.join(vault, "LearnHarness", "Electricity", "Secret note.md");

describe("agents' file tools", () => {
	it("refuse the notes folder, its files and the drawer's data folder", () => {
		assert.throws(() => resolveSourcePath(notePath), /private notes folder/);
		assert.throws(() => resolveSourcePath(path.join(vault, "LearnHarness")), /private notes folder/);
		assert.throws(() => resolveSourcePath(path.join(vault, "learnharness", "electricity")), /private notes folder/);
		assert.throws(() => resolveSourcePath(path.join(TMP, "data", "notes", "settings.json")), /private notes folder/);
		assert.ok(privateNotesRoots().some((r) => r.endsWith(path.join("Vault", "LearnHarness"))));
	});

	it("keep the rest of the vault readable", () => {
		assert.equal(resolveSourcePath(path.join(vault, "Other", "Public.md")), fs.realpathSync.native(path.join(vault, "Other", "Public.md")));
	});

	it("skip the notes folder when walking the vault", async () => {
		const seen: string[] = [];
		await walkFiles(vault, (f) => {
			seen.push(f);
			return false;
		});
		assert.ok(seen.some((f) => f.endsWith("Public.md")));
		assert.ok(!seen.some((f) => f.includes(`${path.sep}LearnHarness${path.sep}`)));
	});
});

describe("session records", () => {
	it("stay byte-identical while notes are written for that session", async () => {
		const chat = chatStore.createChat("Intro to electricity");
		const chatFile = path.join(TMP, "data", "chats", `${chat.id}.json`);
		const before = fs.readFileSync(chatFile, "utf-8");

		const created = await notesActionResponse(
			new Request("http://lh/api/notes", { method: "POST", body: JSON.stringify({ action: "create", folder: "Electricity", title: "Current", chatId: chat.id }) }),
		);
		assert.equal(created.status, 200);
		const saved = await noteSaveResponse(
			new Request("http://lh/api/notes/file", {
				method: "PUT",
				body: JSON.stringify({ path: "Electricity/Current.md", body: "Charge per second.\n", baseHash: null, chatId: chat.id }),
			}),
		);
		assert.equal(saved.status, 200);
		assert.deepEqual(notesStore.read("Electricity/Current.md").sessions, [chat.id]);
		assert.equal(fs.readFileSync(chatFile, "utf-8"), before);
		assert.doesNotMatch(fs.readFileSync(chatFile, "utf-8"), /Charge per second/);
	});

	it("ignore unknown session ids instead of recording them", async () => {
		await noteSaveResponse(
			new Request("http://lh/api/notes/file", {
				method: "PUT",
				body: JSON.stringify({ path: "Electricity/Secret note.md", body: "still private\n", baseHash: null, chatId: "not_a_chat" }),
			}),
		);
		assert.deepEqual(notesStore.read("Electricity/Secret note.md").sessions, []);
	});

	it("deleting a session keeps its notes and drops only its home folder", async () => {
		const chat = chatStore.createChat("doomed");
		notesStore.setHome(chat.id, "Electricity");
		notesStore.create("Electricity", "Kept", chat.id);
		const outcome = await deleteChatSession(chat.id, "preserve-graph");
		assert.ok(outcome.ok);
		assert.equal(notesStore.getHome(chat.id), null);
		assert.ok(fs.existsSync(path.join(vault, "LearnHarness", "Electricity", "Kept.md")));
	});
});
