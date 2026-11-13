/** OFFSCREEN RULE: lesson messages off screen are skipped by the browser; one switch turns it off. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const css = readFileSync(path.join(root, "app/offscreen.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const layout = readFileSync(path.join(root, "app/layout.tsx"), "utf8");
const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({ selectors: (m[1] ?? "").split(",").map((s) => s.trim()), body: m[2] ?? "" }));

describe("app/offscreen.css", () => {
	it("is imported by the root layout", () => {
		assert.match(layout, /import "\.\/offscreen\.css";/);
	});
	it("has rules, all off under data-lh-offscreen=off", () => {
		assert.ok(rules.length > 0);
		for (const r of rules) for (const s of r.selectors) assert.match(s, /^html:not\(\[data-lh-offscreen="off"\]\) /, s);
	});
	it("sets exactly content-visibility: auto and a contain-intrinsic-size", () => {
		for (const r of rules) {
			const decls = r.body.split(";").map((d) => d.trim()).filter(Boolean);
			assert.deepEqual(decls, ["content-visibility: auto", "contain-intrinsic-size: auto 600px"]);
		}
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
