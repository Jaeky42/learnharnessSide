/**
 * NOTES CORE PINS — the notes drawer's pure logic (src/core/notes.ts).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	attachmentFolderFor,
	computeBacklinks,
	deleteConfirmText,
	findLinks,
	isValidNotePath,
	linkSuggestions,
	longNoteVerdict,
	mergeBodies,
	nameProblem,
	noteBody,
	parseSections,
	planSplit,
	readNoteMeta,
	relativeHref,
	resolveLink,
	suggestionLinkText,
	withBody,
	withNoteMeta,
} from "../src/core/notes.ts";

describe("properties (frontmatter)", () => {
	it("reads block and inline session lists and a quoted parent", () => {
		const block = "---\ntags: [physics]\nlh_sessions:\n  - abc\n  - def\nlh_parent: \"Voltage\"\n---\nBody";
		assert.deepEqual(readNoteMeta(block), { sessions: ["abc", "def"], parent: "Voltage" });
		assert.deepEqual(readNoteMeta("---\nlh_sessions: [abc, 'def']\n---\nx").sessions, ["abc", "def"]);
		assert.deepEqual(readNoteMeta("No frontmatter"), { sessions: [], parent: null });
	});

	it("writes our keys and keeps every other line verbatim", () => {
		const text = "---\ntags: [physics]\naliases:\n  - V\n---\n# Body\n";
		const out = withNoteMeta(text, { sessions: ["s1"], parent: "Voltage" });
		assert.equal(out, "---\ntags: [physics]\naliases:\n  - V\nlh_sessions:\n  - s1\nlh_parent: \"Voltage\"\n---\n# Body\n");
		assert.deepEqual(readNoteMeta(out), { sessions: ["s1"], parent: "Voltage" });
		// Removing our keys again leaves the user's frontmatter alone.
		assert.equal(withNoteMeta(out, { sessions: [], parent: null }), text);
	});

	it("drops a frontmatter block left empty, and adds one only when needed", () => {
		assert.equal(withNoteMeta("---\nlh_sessions:\n  - a\n---\nBody", { sessions: [], parent: null }), "Body");
		assert.equal(withNoteMeta("Body", { sessions: [], parent: null }), "Body");
		assert.equal(withNoteMeta("Body", { sessions: ["a"], parent: null }), "---\nlh_sessions:\n  - a\n---\nBody");
	});

	it("separates the body from the frontmatter, and replaces it without touching properties", () => {
		const text = "---\nlh_sessions:\n  - a\n---\nOld body";
		assert.equal(noteBody(text), "Old body");
		assert.equal(withBody(text, "New body"), "---\nlh_sessions:\n  - a\n---\nNew body");
		assert.equal(noteBody("---\nunclosed"), "---\nunclosed");
	});

	it("refuses names Obsidian and Windows can't store or link to", () => {
		assert.equal(nameProblem("Ohm's law"), null);
		assert.ok(nameProblem("a/b"));
		assert.ok(nameProblem("Q: what"));
		assert.ok(nameProblem("[[x]]"));
		assert.ok(nameProblem("trailing."));
		assert.ok(isValidNotePath("Electricity/Voltage/Voltage dividers.md"));
		assert.ok(!isValidNotePath("../escape.md"));
	});
});

describe("sections", () => {
	const body = "Intro line\n\n## Formula\nV = IR\n### Units\nvolts\n\n```\n## not a heading\n```\n## Equal resistors\nHalf.\n";

	it("splits at ## outside code, with sub-headings riding along", () => {
		const { intro, sections } = parseSections(body);
		assert.equal(intro, "Intro line\n\n");
		assert.deepEqual(sections.map((s) => s.heading), ["Formula", "Equal resistors"]);
		assert.match(sections[0]!.content, /### Units/);
		assert.match(sections[0]!.content, /## not a heading/);
	});

	it("flags long notes at 800 words or 4 sections", () => {
		assert.equal(longNoteVerdict(body).long, false);
		assert.equal(longNoteVerdict("## a\n## b\n## c\n## d\n").long, true);
		assert.equal(longNoteVerdict("word ".repeat(800)).long, true);
	});

	it("plans a split without adding any links", () => {
		const plan = planSplit(body, [{ index: 1, title: "Equal resistors" }]);
		assert.equal(plan.children.length, 1);
		assert.equal(plan.children[0]!.body, "Half.\n");
		assert.match(plan.summaryBody, /## Formula/);
		assert.doesNotMatch(plan.summaryBody, /Equal resistors|\[\[/);
	});

	it("merges a child back as a section", () => {
		assert.equal(mergeBodies("Intro\n", "Formula", "V = IR\n"), "Intro\n\n## Formula\n\nV = IR\n");
		assert.equal(mergeBodies("", "Formula", "V = IR"), "## Formula\n\nV = IR\n");
	});
});

describe("links", () => {
	const paths = ["Electricity/Ohm's law.md", "Electricity/Voltage/Voltage.md", "Electricity/Voltage/Voltage dividers.md", "FAR/Leases.md"];

	it("finds wiki and local markdown links, never inside code", () => {
		const links = findLinks("See [[Ohm's law#Rule|V=IR]], ![[img.png]], [x](../FAR/Leases.md) and `[[code]]` and [web](https://x.dev)");
		assert.deepEqual(
			links.map((l) => [l.kind, l.target, l.heading, l.alias, l.embed]),
			[
				["wiki", "Ohm's law", "Rule", "V=IR", false],
				["wiki", "img.png", null, null, true],
				["markdown", "../FAR/Leases.md", null, "x", false],
			],
		);
	});

	it("resolves by name, by vault or notes path, and relative markdown", () => {
		const from = "Electricity/Voltage/Voltage dividers.md";
		assert.deepEqual(resolveLink({ kind: "wiki", target: "Ohm's law" }, from, paths), { kind: "note", path: "Electricity/Ohm's law.md" });
		assert.deepEqual(resolveLink({ kind: "wiki", target: "LearnHarness/FAR/Leases" }, from, paths), { kind: "note", path: "FAR/Leases.md" });
		assert.deepEqual(resolveLink({ kind: "wiki", target: "FAR/Leases" }, from, paths), { kind: "note", path: "FAR/Leases.md" });
		assert.deepEqual(resolveLink({ kind: "markdown", target: "../../FAR/Leases.md" }, from, paths), { kind: "note", path: "FAR/Leases.md" });
		assert.deepEqual(resolveLink({ kind: "wiki", target: "Physics formulas" }, from, paths), { kind: "outside", target: "Physics formulas" });
	});

	it("builds Linked from, without self-links or embeds", () => {
		const back = computeBacklinks([
			{ path: "A.md", body: "[[B]] [[A]]" },
			{ path: "B.md", body: "![[A]]" },
			{ path: "C.md", body: "[[b]]" },
		]);
		assert.deepEqual(back, { "B.md": ["A.md", "C.md"] });
	});

	it("writes relative hrefs between folders", () => {
		assert.equal(relativeHref("Electricity/Voltage/Voltage dividers.md", "FAR/Leases.md"), "../../FAR/Leases.md");
		assert.equal(relativeHref("A.md", "Inbox/New note.md"), "Inbox/New%20note.md");
	});
});

describe("link suggestions", () => {
	const paths = ["Electricity/Ohm's law.md", "Electricity/Current.md", "Electricity/Voltage/Voltage dividers.md", "AC.md"];

	it("suggests the first unlinked mention of other notes only", () => {
		const body = "# Current notes\nIt's just ohm's law again. Current flows. Ohm's law twice. [[Current]] `Ohm's law` AC";
		const s = linkSuggestions(body, "Electricity/Voltage/Voltage dividers.md", paths);
		assert.deepEqual(s.map((x) => [x.text, x.path]), [["ohm's law", "Electricity/Ohm's law.md"], ["Current", "Electricity/Current.md"]]);
		assert.equal(suggestionLinkText(s[0]!), "[[Ohm's law|ohm's law]]");
		assert.equal(suggestionLinkText(s[1]!), "[[Current]]");
	});

	it("never suggests the note itself or partial words", () => {
		assert.deepEqual(linkSuggestions("Currently fine", "X.md", paths), []);
		assert.deepEqual(linkSuggestions("Current here", "Electricity/Current.md", paths), []);
	});
});

describe("attachments folder", () => {
	it("follows Obsidian's setting, defaulting to LearnHarness/attachments", () => {
		assert.equal(attachmentFolderFor(null, "LearnHarness/A/B.md"), "LearnHarness/attachments");
		assert.equal(attachmentFolderFor("/", "LearnHarness/A/B.md"), "");
		assert.equal(attachmentFolderFor("./", "LearnHarness/A/B.md"), "LearnHarness/A");
		assert.equal(attachmentFolderFor("./img", "LearnHarness/A/B.md"), "LearnHarness/A/img");
		assert.equal(attachmentFolderFor("Assets/Images", "LearnHarness/A/B.md"), "Assets/Images");
	});
});

describe("delete confirm (the owner's wording)", () => {
	const forGood = (what: string) => `This removes ${what} from your Obsidian vault for good.`;

	it("a note", () => {
		assert.deepEqual(deleteConfirmText("Electricity", null), { title: "Delete “Electricity”?", body: forGood("it") });
	});

	it("an empty folder", () => {
		assert.deepEqual(deleteConfirmText("Physics", { notes: 0, folders: 0, files: 0 }), { title: "Delete “Physics”?", body: forGood("the folder") });
	});

	it("a folder with things in it says how much goes with it", () => {
		const title = "Delete “Physics” and everything in it?";
		assert.deepEqual(deleteConfirmText("Physics", { notes: 3, folders: 1, files: 0 }), { title, body: forGood("3 notes and 1 folder") });
		assert.deepEqual(deleteConfirmText("Physics", { notes: 1, folders: 0, files: 0 }), { title, body: forGood("1 note") });
		assert.deepEqual(deleteConfirmText("Physics", { notes: 0, folders: 2, files: 0 }), { title, body: forGood("2 folders") });
		assert.deepEqual(deleteConfirmText("Physics", { notes: 3, folders: 1, files: 2 }), { title, body: forGood("3 notes, 1 folder and 2 other files") });
		assert.deepEqual(deleteConfirmText("Physics", { notes: 1, folders: 0, files: 1 }), { title, body: forGood("1 note and 1 other file") });
		assert.deepEqual(deleteConfirmText("Physics", { notes: 0, folders: 0, files: 2 }), { title, body: forGood("2 files") });
		assert.deepEqual(deleteConfirmText("Physics", { notes: 0, folders: 0, files: 1 }), { title, body: forGood("1 file") });
	});

	it("never mentions links (the owner declined that line)", () => {
		for (const c of [null, { notes: 0, folders: 0, files: 0 }, { notes: 2, folders: 2, files: 2 }]) {
			const { title, body } = deleteConfirmText("X", c);
			assert.doesNotMatch(`${title} ${body}`, /link/i);
		}
	});
});

describe("computeBacklinks on a large vault", () => {
	it("equals the plain per-link resolveLink loop", () => {
		let seed = 7;
		const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return Math.floor((seed / 0x80000000) * n); };
		const folders = ["", "Physics", "Physics/Optics", "Math", "Math/Algebra", "Inbox", "Deep/Er/Folder"];
		const names = Array.from({ length: 80 }, (_, i) => `Note ${i}`);
		const notes: { path: string; body: string }[] = [];
		const seen = new Set<string>();
		while (notes.length < 300) {
			const folder = folders[rnd(folders.length)]!;
			const name = names[rnd(names.length)]!;
			const path = folder ? `${folder}/${name}.md` : `${name}.md`;
			if (seen.has(path)) continue;
			seen.add(path);
			notes.push({ path, body: "" });
		}
		const target = () => {
			const n = notes[rnd(notes.length)]!;
			const nm = (n.path.split("/").pop() ?? "").replace(/\.md$/, "");
			switch (rnd(9)) {
				case 0: return `[[${nm}]]`;
				case 1: return `[[${nm.toUpperCase()}#Section]]`;
				case 2: return `[[${nm}|alias]]`;
				case 3: return `[[LearnHarness/${n.path.replace(/\.md$/, "")}]]`;
				case 4: return `[[${n.path}]]`;
				case 5: return `[txt](${encodeURI(n.path)})`;
				case 6: return `[txt](../${encodeURI(n.path)})`;
				case 7: return `[[Missing ${rnd(50)}]]`;
				default: return `![[${nm}]]`;
			}
		};
		for (const n of notes) n.body = Array.from({ length: 4 }, target).join(" and ");
		const paths = notes.map((n) => n.path);
		const expected: Record<string, Set<string>> = {};
		for (const n of notes) {
			for (const link of findLinks(n.body)) {
				if (link.embed) continue;
				const r = resolveLink(link, n.path, paths);
				if (r.kind !== "note" || r.path === n.path) continue;
				(expected[r.path] ??= new Set()).add(n.path);
			}
		}
		const reference = Object.fromEntries(Object.entries(expected).map(([k, v]) => [k, [...v].sort((a, b) => a.localeCompare(b))]));
		assert.ok(Object.keys(reference).length > 50);
		assert.deepEqual(computeBacklinks(notes), reference);
	});
});
