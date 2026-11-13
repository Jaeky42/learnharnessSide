/**
 * Side-tutor fork (performance): the app's mermaid renderer reuses a render of
 * the same chart in the same mode, hands every caller an svg with an id of its
 * own, never caches a failure, and is bounded.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createMermaidRenderer } from "../components/mermaid-render.ts";

/** A raw renderer shaped like mermaid's output: the render id is the svg's root
 *  id, the scope of its style and the base of its marker id. */
function fake() {
	const calls: { id: string; chart: string; mode: string }[] = [];
	const raw = async (id: string, chart: string, mode: string) => {
		calls.push({ id, chart, mode });
		return `<svg id="${id}"><style>#${id}{fill:red}</style><marker id="${id}_arrow"/><text>${chart}-${mode}</text><path marker-end="url(#${id}_arrow)"/></svg>`;
	};
	return { calls, raw };
}
const idsOf = (svg: string) => [...svg.matchAll(/ id="([^"]+)"/g)].map(m => m[1]!);

test("the same chart and mode render once; each caller gets its own ids", async () => {
	const f = fake(); const r = createMermaidRenderer(f.raw);
	const [a, b, c] = await Promise.all([r.render("graph TD;A-->B", "dark"), r.render("graph TD;A-->B", "dark"), r.render("graph TD;A-->B", "dark")]);
	const d = await r.render("graph TD;A-->B", "dark");
	assert.equal(f.calls.length, 1);
	const all = [a, b, c, d];
	for (const svg of all) assert.match(svg, /<text>graph TD;A-->B-dark<\/text>/);
	const roots = all.map(svg => idsOf(svg)[0]!);
	assert.equal(new Set(roots).size, 4, "no two instances share an id");
	for (const svg of all) {
		const root = idsOf(svg)[0]!;
		assert.ok(!svg.includes(f.calls[0]!.id), "the shared render id never reaches a caller");
		assert.ok(svg.includes(`#${root}{fill:red}`) && svg.includes(`${root}_arrow`) && svg.includes(`url(#${root}_arrow)`));
	}
	// no id of one appears in another
	for (const [i, x] of all.entries()) for (const [j, y] of all.entries()) if (i !== j) assert.ok(!y.includes(idsOf(x)[0]!));
});

test("a different chart or a different mode renders again", async () => {
	const f = fake(); const r = createMermaidRenderer(f.raw);
	await r.render("a", "dark"); await r.render("a", "light"); await r.render("b", "dark"); await r.render("a", "dark");
	assert.deepEqual(f.calls.map(c => `${c.chart}/${c.mode}`), ["a/dark", "a/light", "b/dark"]);
});

test("a failed render is not cached and is tried again", async () => {
	let attempts = 0;
	const r = createMermaidRenderer(async (id) => { attempts++; if (attempts === 1) throw new Error("bad chart"); return `<svg id="${id}"/>`; });
	await assert.rejects(r.render("x", "dark"), /bad chart/);
	assert.equal(r.size(), 0);
	assert.match(await r.render("x", "dark"), /^<svg id="lh-mermaid-/);
	assert.equal(attempts, 2);
});

test("the cache is bounded by entries and by size", async () => {
	const f = fake(); const r = createMermaidRenderer(f.raw, { entries: 5, chars: 1_000_000 });
	for (let i = 0; i < 20; i++) await r.render(`chart ${i}`, "dark");
	assert.ok(r.size() <= 5, String(r.size()));
	await r.render("chart 19", "dark"); assert.equal(f.calls.length, 20, "the newest is kept");
	await r.render("chart 0", "dark"); assert.equal(f.calls.length, 21, "the oldest was dropped and renders again");
	const g = fake(); const small = createMermaidRenderer(g.raw, { entries: 100, chars: 400 });
	for (let i = 0; i < 10; i++) await small.render(`chart ${i}`, "dark");
	assert.ok(small.size() <= 4, String(small.size()));
});
