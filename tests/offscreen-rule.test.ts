/** OFFSCREEN RULE: lesson messages off screen are skipped by the browser; one switch turns it off. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const css = readFileSync(path.join(root, "app/offscreen.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const layout = readFileSync(path.join(root, "app/layout.tsx"), "utf8");
type Rule = { selectors: string[]; decls: string[]; media: string | null };
const PHONE = "(max-width: 639.98px)";
/** Plain rules, and the rules inside one level of @media. */
function parse(text: string, media: string | null = null): Rule[] {
	const out: Rule[] = [];
	let rest = text;
	for (;;) {
		const at = /@media\s*([^{]+)\{/.exec(rest);
		const head = at ? rest.slice(0, at.index) : rest;
		for (const m of head.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
			out.push({ selectors: (m[1] ?? "").split(",").map((s) => s.trim()), decls: (m[2] ?? "").split(";").map((d) => d.trim()).filter(Boolean), media });
		}
		if (!at) return out;
		let depth = 1, i = at.index + at[0].length;
		for (; i < rest.length && depth > 0; i++) depth += rest[i] === "{" ? 1 : rest[i] === "}" ? -1 : 0;
		out.push(...parse(rest.slice(at.index + at[0].length, i - 1), (at[1] ?? "").trim()));
		rest = rest.slice(i);
	}
}
const rules = parse(css);
const USER = '[data-session-find-root] > [data-testid="user-message"]';
const ASSISTANT = "[data-session-find-root] > .is-assistant";
const OFF = 'html:not([data-lh-offscreen="off"]) ';

describe("app/offscreen.css", () => {
	it("is imported by the root layout", () => {
		assert.match(layout, /import "\.\/offscreen\.css";/);
	});
	it("has rules, all off under data-lh-offscreen=off", () => {
		assert.ok(rules.length > 0);
		for (const r of rules) for (const s of r.selectors) assert.match(s, /^html:not\(\[data-lh-offscreen="off"\]\) /, s);
	});
	it("sets content-visibility: auto with an estimate per kind of message", () => {
		const plain = rules.filter((r) => r.media === null);
		assert.deepEqual(plain.map((r) => [r.selectors, r.decls]), [
			[[OFF + USER], ["content-visibility: auto", "contain-intrinsic-size: auto 60px"]],
			[[OFF + ASSISTANT], ["content-visibility: auto", "contain-intrinsic-size: auto 700px"]],
			[[OFF + USER + "[data-lh-draw]", OFF + ASSISTANT + "[data-lh-draw]"], ["content-visibility: visible"]],
		]);
	});
	it("gives the phone layout a taller estimate for the learner's rows, and changes nothing else there", () => {
		assert.deepEqual([...new Set(rules.map((r) => r.media))], [null, PHONE]);
		const phone = rules.filter((r) => r.media === PHONE);
		assert.deepEqual(phone.map((r) => [r.selectors, r.decls]), [
			[[OFF + USER], ["contain-intrinsic-size: auto 100px"]],
		]);
	});
	it("isn't limited to browsers: the desktop app gets it too", () => {
		assert.doesNotMatch(css, /lh-electron/);
	});
	it("targets message blocks only, never the dock spacer", () => {
		const all = rules.flatMap((r) => r.selectors).join(" ");
		assert.doesNotMatch(all, /dock-spacer/);
		assert.doesNotMatch(all, /\*\s*$/m);
		assert.match(all, /user-message/);
		assert.match(all, /is-assistant/);
	});
});

describe("the off switch in the head script", () => {
	const m = /const ELECTRON_MARK = ("(?:[^"\\]|\\.)*");/.exec(layout);
	assert.ok(m, "ELECTRON_MARK found");
	const src = JSON.parse(m[1] ?? "\"\"") as string;
	const run = (search: string, ua = "Chrome") => {
		const attrs = new Map<string, string>();
		const classes = new Set<string>();
		const documentElement = { setAttribute: (k: string, v: string) => attrs.set(k, v), classList: { add: (c: string) => classes.add(c) } };
		vm.runInNewContext(src, { document: { documentElement }, navigator: { userAgent: ua }, location: { search } });
		return { attrs, classes };
	};
	it("sets the attribute only for offscreen=off", () => {
		assert.equal(run("?offscreen=off").attrs.get("data-lh-offscreen"), "off");
		assert.equal(run("?a=1&offscreen=off&b=2").attrs.get("data-lh-offscreen"), "off");
		for (const s of ["", "?offscreen=on", "?offscreen=offx", "?xoffscreen=off"]) assert.equal(run(s).attrs.size, 0, s);
	});
	it("still marks the desktop app, and never throws", () => {
		assert.ok(run("", "Electron/30").classes.has("lh-electron"));
		assert.doesNotThrow(() => vm.runInNewContext(src, {}));
	});
});
