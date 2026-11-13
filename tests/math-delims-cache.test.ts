/**
 * Side-tutor fork (performance): transformMathDelimiters and repairMathForDisplay
 * are memoised by their input string. Output must be identical to the
 * uncached functions, on a first call and on repeats, and the memo bounded.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
	healOverescapedCommands, mathCacheForTests, MATH_CACHE_MAX_ENTRIES, repairMathForDisplay, restoreMathEscapes, transformMathDelimiters,
} from "../src/core/math-delims.ts";
import { recoverDocumentLayout } from "../src/core/content-reader.ts";

const table = [
	"",
	"plain text",
	"inline $x^2$ math",
	"legacy \\(x^2\\) inline",
	"legacy\n\n\\[\n\\int x\n\\]\n\nblock",
	"mid \\[x^2\\] para",
	"- item\n  \\[\n  x^2\n  \\]\n- next",
	"```\n\\(not math\\) $x$\n```",
	"`\\(code\\)` and $a$",
	"It costs $x = \\$5$ at market.",
	"escaped \\\\( and \\\\[ stay",
	"partial \\[ mid-stream",
	"$$a\\\\lambda b$$ and \\\\nu",
	"debris \u0008eta and tab\tfoo in $\\\u000brho$",
	"long " + "$x_{i}$ and \\(y\\) ".repeat(3000),
];

// The uncached composition, spelled out.
const uncachedRepair = (text: string) => healOverescapedCommands(restoreMathEscapes(recoverDocumentLayout(text)));

test("repairMathForDisplay: first and repeated calls equal the plain composition", () => {
	mathCacheForTests.clear();
	for (const value of table) {
		const want = uncachedRepair(value);
		assert.equal(repairMathForDisplay(value), want);
		assert.equal(repairMathForDisplay(value), want);
		assert.equal(repairMathForDisplay(value.slice(0)), want);
	}
});

test("transformMathDelimiters: first and repeated calls agree, and identity on text it must not touch", () => {
	mathCacheForTests.clear();
	const first = table.map(value => transformMathDelimiters(value));
	mathCacheForTests.clear();
	const cold = table.map(value => transformMathDelimiters(value));
	assert.deepEqual(first, cold);
	assert.deepEqual(table.map(value => transformMathDelimiters(value)), cold);
	assert.equal(transformMathDelimiters("a \\(x^2\\) b"), "a $$x^2$$ b");
	assert.equal(transformMathDelimiters("```\n$x = \\$5$\n```"), "```\n$x = \\$5$\n```");
	assert.equal(transformMathDelimiters(""), "");
});

test("a repeated string is served from the cache", () => {
	mathCacheForTests.clear();
	const value = "legacy \\(x\\) and $y$";
	transformMathDelimiters(value); repairMathForDisplay(value);
	assert.deepEqual(mathCacheForTests.stats(), { transform: { entries: 1, chars: value.length + transformMathDelimiters(value).length }, repair: { entries: 1, chars: value.length + repairMathForDisplay(value).length } });
});

test("the caches are bounded by entry count", () => {
	mathCacheForTests.clear();
	for (let i = 0; i < MATH_CACHE_MAX_ENTRIES * 3; i++) {
		// Different strings that don't extend one another, as separate messages are.
		transformMathDelimiters(`${i} message $a_${i}$`); repairMathForDisplay(`${i} message $a_${i}$`);
	}
	const { transform, repair } = mathCacheForTests.stats();
	assert.ok(transform.entries <= MATH_CACHE_MAX_ENTRIES, String(transform.entries));
	assert.ok(repair.entries <= MATH_CACHE_MAX_ENTRIES, String(repair.entries));
	// the newest are kept, the oldest are gone (they are computed again, with the same answer)
	const newest = `${MATH_CACHE_MAX_ENTRIES * 3 - 1} message $a_${MATH_CACHE_MAX_ENTRIES * 3 - 1}$`;
	assert.equal(transformMathDelimiters(newest), newest);
	assert.equal(transformMathDelimiters("0 message $a_0$"), "0 message $a_0$");
});

test("the caches are bounded by size: very long strings are not held", () => {
	mathCacheForTests.clear();
	const huge = "x $a$ ".repeat(60_000); // 360k chars: text plus result is over a quarter of the budget
	assert.equal(transformMathDelimiters(huge), huge);
	assert.equal(mathCacheForTests.stats().transform.entries, 0);
	for (let i = 0; i < 40; i++) transformMathDelimiters(`${i}`.repeat(1) + " " + "y $b$ ".repeat(20_000)); // ~120k chars each
	assert.ok(mathCacheForTests.stats().transform.chars <= 2_000_000, String(mathCacheForTests.stats().transform.chars));
});

test("a message being streamed does not fill the cache with its prefixes", () => {
	mathCacheForTests.clear();
	const full = "The result is \\(x^2\\) and then $y$ follows, " + "more words ".repeat(200);
	for (let end = 5; end <= full.length; end += 7) {
		const prefix = full.slice(0, end);
		assert.equal(transformMathDelimiters(prefix).length > 0, true); // each prefix is seen once, as a reply grows
	}
	const held = mathCacheForTests.stats().transform.entries;
	assert.ok(held <= 2, `prefixes were cached: ${held}`);
	// the settled text, once seen again on its own, is cached
	mathCacheForTests.clear();
	transformMathDelimiters("something else entirely"); transformMathDelimiters(full);
	assert.equal(mathCacheForTests.stats().transform.entries, 2);
});
