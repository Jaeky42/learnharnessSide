/**
 * NOTES STORE PINS — the vault-backed notes (src/store/notes.ts).
 * Runs against a temporary LH_DATA_DIR and a temporary "vault".
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-notes-"));
process.env.LH_DATA_DIR = path.join(TMP, "data");

const { notesStore, hashText } = await import("../src/store/notes.ts");

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let vault = "";
let n = 0;
const root = () => path.join(vault, "LearnHarness");
const file = (rel: string) => path.join(root(), ...rel.split("/"));
const write = (rel: string, text: string) => {
	fs.mkdirSync(path.dirname(file(rel)), { recursive: true });
	fs.writeFileSync(file(rel), text);
};
const readFile = (rel: string) => fs.readFileSync(file(rel), "utf-8");

beforeEach(() => {
	vault = path.join(TMP, `vault-${++n}`);
	fs.mkdirSync(vault, { recursive: true });
	notesStore.setVault(vault);
});

describe("vault and notes", () => {
	it("needs a real folder, and creates LearnHarness/ inside it", () => {
		assert.throws(() => notesStore.setVault(path.join(TMP, "missing")), /doesn't exist/);
		assert.throws(() => notesStore.setVault("relative/path"), /full path/);
		assert.ok(fs.statSync(root()).isDirectory());
		const st = notesStore.status();
		assert.equal(st.available, true);
		assert.equal(st.vaultName, path.basename(vault));
	});

	it("creates notes with the session in their properties, and saves bodies under them", () => {
		const { path: p } = notesStore.create("Electricity", "Current", "chat_1");
		assert.equal(p, "Electricity/Current.md");
		assert.match(readFile(p), /lh_sessions:\n {2}- chat_1/);
		const first = notesStore.read(p);
		const saved = notesStore.save(p, "Rate of charge flow.\n", first.hash, "chat_2");
		assert.ok(saved.ok);
		const text = readFile(p);
		assert.match(text, /- chat_1\n {2}- chat_2/);
		assert.match(text, /---\nRate of charge flow\.\n$/);
		assert.equal(notesStore.read(p).body, "Rate of charge flow.\n");
		assert.throws(() => notesStore.create("Electricity", "Current", null), /already exists/);
	});

	it("never overwrites a note changed in Obsidian: it reports a conflict", () => {
		const { path: p } = notesStore.create("", "Ohm's law", null);
		const loaded = notesStore.read(p);
		write(p, "Edited in Obsidian\n");
		const res = notesStore.save(p, "Drawer text\n", loaded.hash, null);
		assert.equal(res.ok, false);
		if (!res.ok) assert.equal(res.conflict.body, "Edited in Obsidian\n");
		assert.equal(readFile(p), "Edited in Obsidian\n");
	});

	it("lists folders and notes, hides the attachments folder, and builds Linked from", () => {
		write("Electricity/Ohm's law.md", "V = IR\n");
		write("Electricity/Voltage dividers.md", "Just [[Ohm's law]] twice.\n");
		write("attachments/readme.md", "x");
		write(".hidden/secret.md", "x");
		const t = notesStore.tree();
		assert.deepEqual(t.folders, ["Electricity"]);
		assert.deepEqual(t.notes.map((x) => x.path), ["Electricity/Ohm's law.md", "Electricity/Voltage dividers.md"]);
		assert.deepEqual(t.backlinks["Electricity/Ohm's law.md"], ["Electricity/Voltage dividers.md"]);
	});

	it("refuses paths that escape the notes folder", () => {
		assert.throws(() => notesStore.read("../outside.md"), /Invalid note path/);
		assert.throws(() => notesStore.create("../x", "a", null), /Invalid folder path/);
		const outside = path.join(TMP, `outside-${n}`);
		fs.mkdirSync(outside);
		fs.symlinkSync(outside, file("Linked"), process.platform === "win32" ? "junction" : "dir");
		assert.throws(() => notesStore.create("Linked", "escape", null), /outside the notes folder/);
	});
});

describe("offline vault", () => {
	it("holds edits while the vault is missing and writes them when it's back", () => {
		const { path: p } = notesStore.create("", "Resistance", null);
		const loaded = notesStore.read(p);
		const away = `${vault}-away`;
		fs.renameSync(vault, away);
		const res = notesStore.save(p, "Written offline\n", loaded.hash, null);
		assert.deepEqual(res, { ok: true, hash: loaded.hash, pending: true });
		assert.equal(notesStore.status().pending, 1);
		assert.equal(notesStore.read(p).body, "Written offline\n");
		fs.renameSync(away, vault);
		notesStore.tree();
		assert.equal(notesStore.status().pending, 0);
		assert.equal(notesStore.read(p).body, "Written offline\n");
	});

	it("keeps an offline copy instead of overwriting a note that changed meanwhile", () => {
		const { path: p } = notesStore.create("", "Charge", null);
		const loaded = notesStore.read(p);
		const away = `${vault}-away`;
		fs.renameSync(vault, away);
		notesStore.save(p, "Offline version\n", loaded.hash, null);
		fs.writeFileSync(path.join(away, "LearnHarness", "Charge.md"), "Changed elsewhere\n");
		fs.renameSync(away, vault);
		notesStore.flushPending();
		assert.equal(readFile("Charge.md"), "Changed elsewhere\n");
		assert.equal(notesStore.read("Charge (offline copy).md").body, "Offline version\n");
	});
});

describe("split, merge, extract, undo", () => {
	const voltage = "---\nlh_sessions:\n  - s1\n---\nVoltage is a push.\n\n## What voltage is\nEnergy per charge.\n\n## Voltage dividers\nVout = Vin R2/(R1+R2).\n\n## Units\nVolts.\n";

	it("splits into a folder, adds no links, and rewrites the learner's section links", () => {
		write("Electricity/Voltage.md", voltage);
		write("Electricity/Circuits.md", "See [[Voltage#Voltage dividers|dividers]] and [[Voltage#Units]] and [[Voltage]].\n");
		const res = notesStore.split("Electricity/Voltage.md", [{ index: 0, title: "What voltage is" }, { index: 1, title: "Voltage dividers" }], "s2");
		assert.equal(res.path, "Electricity/Voltage/Voltage.md");
		assert.deepEqual(res.children, ["Electricity/Voltage/What voltage is.md", "Electricity/Voltage/Voltage dividers.md"]);
		assert.ok(!fs.existsSync(file("Electricity/Voltage.md")));
		const summary = readFile("Electricity/Voltage/Voltage.md");
		assert.match(summary, /Voltage is a push\.\n\n## Units\nVolts\.\n$/);
		assert.doesNotMatch(summary, /\[\[/);
		const child = readFile("Electricity/Voltage/Voltage dividers.md");
		assert.match(child, /lh_sessions:\n {2}- s1\n {2}- s2\nlh_parent: "Voltage"\n---\nVout = Vin R2\/\(R1\+R2\)\.\n$/);
		assert.equal(readFile("Electricity/Circuits.md"), "See [[Voltage dividers|dividers]] and [[Voltage#Units]] and [[Voltage]].\n");

		notesStore.undo(res.opId);
		assert.equal(readFile("Electricity/Voltage.md"), voltage);
		assert.ok(!fs.existsSync(file("Electricity/Voltage")));
		assert.match(readFile("Electricity/Circuits.md"), /\[\[Voltage#Voltage dividers\|dividers\]\]/);
	});

	it("merges a child back, and folds the folder away when only the summary is left", () => {
		write("Electricity/Voltage.md", voltage);
		write("Electricity/Circuits.md", "[[What voltage is]]\n");
		notesStore.split("Electricity/Voltage.md", [{ index: 0, title: "What voltage is" }], null);
		const res = notesStore.merge("Electricity/Voltage/What voltage is.md");
		assert.equal(res.path, "Electricity/Voltage.md");
		assert.ok(!fs.existsSync(file("Electricity/Voltage")));
		assert.match(readFile("Electricity/Voltage.md"), /## What voltage is\n\nEnergy per charge\.\n$/);
		assert.equal(readFile("Electricity/Circuits.md"), "[[Voltage#What voltage is]]\n");
		assert.throws(() => notesStore.merge("Electricity/Circuits.md"), /wasn't split/);
	});

	it("extracts a selection into a new note without leaving a link", () => {
		write("Inbox/Scratch.md", "Keep this. Move this part. Keep end.\n");
		const body = notesStore.read("Inbox/Scratch.md").body;
		const start = body.indexOf("Move");
		const end = body.indexOf("Keep end");
		const res = notesStore.extract("Inbox/Scratch.md", start, end, "Moved", null);
		assert.equal(res.path, "Inbox/Moved.md");
		assert.equal(notesStore.read("Inbox/Moved.md").body, "Move this part.\n");
		assert.equal(notesStore.read("Inbox/Scratch.md").body, "Keep this. Keep end.\n");
		notesStore.undo(res.opId);
		assert.ok(!fs.existsSync(file("Inbox/Moved.md")));
	});
});

describe("moving", () => {
	it("moves a note and keeps path-style and relative links pointing at it", () => {
		write("Inbox/Capacitors.md", "Links back to [x](../Electricity/Current.md)\n");
		write("Electricity/Current.md", "[[LearnHarness/Inbox/Capacitors]] and [c](../Inbox/Capacitors.md) and [[Capacitors]]\n");
		const res = notesStore.move("Inbox/Capacitors.md", "Electricity");
		assert.equal(res.path, "Electricity/Capacitors.md");
		assert.equal(readFile("Electricity/Current.md"), "[[LearnHarness/Electricity/Capacitors]] and [c](Capacitors.md) and [[Capacitors]]\n");
		assert.equal(readFile("Electricity/Capacitors.md"), "Links back to [x](Current.md)\n");
	});

	it("moves a whole folder, refuses moving it into itself, and refuses name clashes", () => {
		write("Electricity/Voltage/Voltage.md", "x");
		fs.mkdirSync(file("Physics"), { recursive: true });
		notesStore.setHome("chat_a", "Electricity/Voltage");
		assert.throws(() => notesStore.move("Electricity", "Electricity/Voltage"), /into itself/);
		const res = notesStore.move("Electricity", "Physics");
		assert.equal(res.path, "Physics/Electricity");
		assert.ok(fs.existsSync(file("Physics/Electricity/Voltage/Voltage.md")));
		assert.equal(notesStore.getHome("chat_a"), "Physics/Electricity/Voltage");
		write("Taken.md", "a");
		write("Physics/Taken.md", "b");
		assert.throws(() => notesStore.move("Taken.md", "Physics"), /already exists/);
	});
});

describe("attachments and session homes", () => {
	it("saves pasted images to LearnHarness/attachments by default and finds them for the Read view", () => {
		const png = Buffer.from("89504e470d0a1a0a", "hex");
		const res = notesStore.saveAttachment("Electricity/Current.md", png, "png");
		assert.match(res.name, /^Pasted image \d{14}\.png$/);
		assert.ok(fs.existsSync(path.join(root(), "attachments", res.name)));
		const hit = notesStore.asset(res.name, "Electricity/Current.md");
		assert.ok(hit);
		assert.equal(hit.mime, "image/png");
		assert.equal(notesStore.asset("../../../etc/passwd", "a.md"), null);
		assert.throws(() => notesStore.saveAttachment("a.md", png, "html"), /Only pasted images/);
	});

	it("follows Obsidian's attachment folder setting", () => {
		fs.mkdirSync(path.join(vault, ".obsidian"), { recursive: true });
		fs.writeFileSync(path.join(vault, ".obsidian", "app.json"), JSON.stringify({ attachmentFolderPath: "Assets" }));
		const res = notesStore.saveAttachment("A.md", Buffer.from([1, 2, 3]), "jpg");
		assert.ok(fs.existsSync(path.join(vault, "Assets", res.name)));
	});

	it("stores a session's home folder and forgets it when the session is deleted", () => {
		notesStore.setHome("chat_b", "Electricity");
		assert.equal(notesStore.getHome("chat_b"), "Electricity");
		notesStore.discardSession("chat_b");
		assert.equal(notesStore.getHome("chat_b"), null);
	});

	it("hashes text stably", () => {
		assert.equal(hashText("a"), hashText("a"));
		assert.notEqual(hashText("a"), hashText("b"));
	});
});
