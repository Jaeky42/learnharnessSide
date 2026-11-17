/**
 * Fork: money is not math (owner's decision; it replaces "instructions only").
 *
 * The owner's report: "comparing $73,000 with $70,000 measures the lifetime
 * gain" was drawn as one italic formula with both dollar signs gone, because
 * two bare "$" in a paragraph are a formula's start and end. The renderer now
 * tells the two apart (`isMoneyPair` in src/core/content-reader.ts): a pair
 * that opens on a digit, and whose closing dollar looks like the start of an
 * amount or a formula and not the end of one, is money. Only the opening
 * dollar is given up (escaped for display); the one that would have closed
 * it is read afresh, so it can still open a real formula.
 *
 * The owner's condition: math must still be displayed properly. So this file
 * is two halves: money stays text, and every shape of real math is untouched.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageResponse, ToolContentResponse } from "../components/ai-elements/message.tsx";
import { readContentSpans } from "../src/core/content-reader.ts";
import { isMoneyPair, mathCacheForTests, transformMathDelimiters } from "../src/core/math-delims.ts";

const render = (md: string) => renderToStaticMarkup(<MessageResponse mode="static">{md}</MessageResponse>);
const renderTool = (md: string) => renderToStaticMarkup(<ToolContentResponse mode="static">{md}</ToolContentResponse>);
/** The rendered text, with each formula replaced by a marker. */
const shown = (html: string) => html
	.replace(/<span class="katex">[\s\S]*?<\/span><\/span><\/span>(<\/span>)*/g, "[math]")
	.replace(/<[^>]+>/g, "")
	.replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const formulas = (html: string) => (html.match(/<span class="katex">/g) ?? []).length;

describe("the rule", () => {
	it("opens on a digit, and the closing dollar starts the next amount or formula", () => {
		assert.equal(isMoneyPair("73,000 with ", "70"), true);
		assert.equal(isMoneyPair("100 is the price. Let ", "x$"), true, "a formula follows");
		assert.equal(isMoneyPair("5 fee and ", "\\f"), true, "a formula that starts with a command follows");
		assert.equal(isMoneyPair("5 and ", ".5"), true, "an amount under a dollar follows");
		assert.equal(isMoneyPair("100 (", "x$"), true, "after an opening bracket");
		assert.equal(isMoneyPair("5/", "6"), true, "straight after a separator, a digit follows");
		assert.equal(isMoneyPair("5-", "10"), true);
		assert.equal(isMoneyPair("100,", "20"), true);
	});
	it("while it is being written, the end of the text counts as a start", () => {
		assert.equal(isMoneyPair("73,000 with ", ""), true);
	});
	it("a formula that starts with a number is not money, whatever follows it", () => {
		for (const body of ["2x + 3 = 7", "5", "3", "2x", "40\\%", "3y", "36,000 \\times 40\\% = \\$14,400", "10^{-3}", "2(x+1)", "[0,1]", "5!", "2+2=", "1:", "3<"]) {
			for (const after of [" ", ".", "", "4", "5x", "a", ")"]) assert.equal(isMoneyPair(body, after), false, `${body} then ${JSON.stringify(after)}`);
		}
	});
	it("a formula typed with a space before its closing dollar stays math", () => {
		for (const after of [" a", ".", ", ", ") ", "\n", "; ", "! ", "? "]) {
			assert.equal(isMoneyPair("1 + 2 ", after), false, JSON.stringify(after));
			assert.equal(isMoneyPair("2x ", after), false, JSON.stringify(after));
		}
	});
	it("a pair that doesn't open on a digit is never money", () => {
		for (const body of ["x and ", "\\$5 and ", " 5 ", "x + y ", "-5 and "]) assert.equal(isMoneyPair(body, "5"), false, body);
	});
});

describe("money stays text", () => {
	const OWNER_1 = "The break is **Year 2 total comprehensive income**: comparing $73,000 with $70,000 measures the lifetime gain, not Year 2's result.";
	const OWNER_2 = "You identified two Year 2 OCI effects: the $3,000 fair-value loss and removing the remaining $3,000 accumulated gain on sale. What is their **combined OCI effect**, and what do you get when you add it to Year 2 net income?";
	const OWNER_3 = "On January 1, a company purchases a debt security at its face value of $100,000, classified as **available for sale**. It receives $6,000 of interest; the fair value is $96,000.";

	for (const [surface, draw] of [["a message", render], ["a tool's text", renderTool]] as const) {
		it(`${surface}: the owner's garbled sentences come out as written`, () => {
			for (const source of [OWNER_1, OWNER_2, OWNER_3]) {
				const html = draw(source);
				assert.equal(formulas(html), 0, "no formula");
				assert.equal(shown(html), source.replace(/\*\*/g, ""));
				assert.match(html, /<(strong|span)[^>]*>(Year 2 total comprehensive income|combined OCI effect|available for sale)</, "the bold is intact");
			}
		});
	}

	it("the opening dollar of each money pair is escaped, and nothing else changes", () => {
		assert.equal(transformMathDelimiters("comparing $73,000 with $70,000 measures"), "comparing \\$73,000 with $70,000 measures", "the second has no partner left and needs no escape");
		assert.equal(transformMathDelimiters("Costs $5, $6 and $7."), "Costs \\$5, \\$6 and $7.");
		assert.equal(transformMathDelimiters("Your $3,000 net-income gain."), "Your $3,000 net-income gain.", "one amount alone was never a pair");
	});

	it("many amounts in one paragraph, a list and a table", () => {
		const para = render("Paid $1, then $2, then $3, then $4, then $5.");
		assert.equal(formulas(para), 0);
		assert.equal(shown(para), "Paid $1, then $2, then $3, then $4, then $5.");
		const list = render("1. Cash paid: $594,000\n2. Loss: $3,060\n3. Gain: $1");
		assert.equal(formulas(list), 0);
		assert.match(shown(list), /Cash paid: \$594,000[\s\S]*Loss: \$3,060[\s\S]*Gain: \$1/);
		const table = render("| Item | Amount |\n|---|---|\n| Interest | $6,000 |\n| Fair value | $96,000 |");
		assert.equal(formulas(table), 0);
		assert.match(shown(table), /Interest\s*\$6,000\s*Fair value\s*\$96,000/);
	});

	it("amounts across the lines of one paragraph", () => {
		const html = render("Year 1: $70,000\nYear 2: $73,000");
		assert.equal(formulas(html), 0);
		assert.match(shown(html), /Year 1: \$70,000\s*Year 2: \$73,000/);
	});

	it("code is left exactly as written", () => {
		const source = "Run `echo $5 and $6` here.\n\n```sh\ncost=$5; total=$6\n```";
		assert.equal(transformMathDelimiters(source), source);
		assert.equal(formulas(render(source)), 0);
	});

	it("amounts the model already escaped stay as they are", () => {
		const source = "A face value of \\$100,000 and interest of \\$6,000.";
		assert.equal(transformMathDelimiters(source), source);
		assert.equal(shown(render(source)), "A face value of $100,000 and interest of $6,000.");
	});
});

describe("math is still displayed properly", () => {
	/** Each of these must come out of the transform byte for byte as it went in. */
	const UNTOUCHED = [
		"Let $2x + 3 = 7$ and $3y$, so $40\\%$ of $5$ apples is $2$.",
		"The DDB rate is $\\frac{2}{5} = 40\\%$. Although the proposed Year 3 charge is right,",
		"The values $3$, $4$ and $5$ form a triple: $3^2 + 4^2 = 5^2$.",
		"With $10^{-3}$ mol and $2\\pi r$ we get $6.02 \\times 10^{23}$.",
		"If $0 < x < 1$ then $1/x > 1$.",
		"A $2 \\times 2$ matrix and a $3$-cycle.",
		"$$\n36{,}000 \\times 40\\% = 14{,}400\n$$",
		"Inline double dollars: $$5x + 3$$ and $$2$$ more.",
		"Let $x$ be the price and $y$ the cost.",
	];
	for (const source of UNTOUCHED) {
		it(`untouched: ${source.replace(/\n/g, "⏎")}`, () => {
			assert.equal(transformMathDelimiters(source), source);
			const html = render(source);
			assert.ok(!html.includes("katex-error"), "no KaTeX error");
			assert.ok(formulas(html) > 0, "it is still drawn as math");
		});
	}

	it("the owner's old chat: money written inside formulas is one formula each, as before", () => {
		const html = render("it would reduce carrying amount below the $\\$25{,}000$ residual value. The allowable charge is:\n\n$$\n\\$36{,}000 - \\$25{,}000 = \\$11{,}000.\n$$");
		assert.ok(!html.includes("katex-error"));
		assert.equal(formulas(html), 2);
		assert.match(shown(html), /below the \[math\] residual value\./);
		const inline = render("so $\\$36{,}000 \\times 40\\% = \\$14{,}400$, which is too much.");
		assert.equal(formulas(inline), 1);
		assert.equal(shown(inline), "so [math], which is too much.");
	});

	it("counts: every formula in a mixed paragraph is still a formula", () => {
		assert.equal(formulas(render("Let $2x + 3 = 7$ and $3y$, so $40\\%$ of $5$ apples is $2$.")), 5);
		assert.equal(formulas(render("The values $3$, $4$ and $5$ form a triple: $3^2 + 4^2 = 5^2$.")), 4);
	});

	it("money and math in one paragraph: each is what it is", () => {
		const a = render("Each unit costs $5, so $x$ units cost $5x$ in total.");
		assert.ok(!a.includes("katex-error"));
		assert.equal(shown(a), "Each unit costs $5, so [math] units cost [math] in total.");
		const b = render("Pay $100 now (that is, $x$ each) or $200 later, where $x = 50$.");
		assert.equal(shown(b), "Pay $100 now (that is, [math] each) or $200 later, where [math].");
		const c = render("The $5 fee applies to $n$ items; the $6 fee to $m$ items; the $7 fee to $k$ items.");
		assert.equal(shown(c), "The $5 fee applies to [math] items; the $6 fee to [math] items; the $7 fee to [math] items.");
	});

	it("money, then a formula that starts with a number", () => {
		const a = render("Each unit costs $5, so $3$ units cost $15$ in all.");
		assert.ok(!a.includes("katex-error"));
		assert.equal(shown(a), "Each unit costs $5, so [math] units cost [math] in all.");
		const b = render("It costs $5 and $2x$ dollars for $x$ units, or $10 for $2x + 1$ units.");
		assert.equal(shown(b), "It costs $5 and [math] dollars for [math] units, or $10 for [math] units.");
	});

	it("a table with a money column beside a formula column", () => {
		const html = render("| Year | Depreciation | Formula |\n|---|---|---|\n| Year 3 | $11,000 | $36{,}000 - 25{,}000$ |\n| Year 4 | $0 | $0$ |\n| Year 5 | $7 | $x$ |");
		assert.ok(!html.includes("katex-error"));
		assert.equal(formulas(html), 3);
		assert.match(shown(html), /Year 3\s*\$11,000\s*\[math\]\s*Year 4\s*\$0\s*\[math\]\s*Year 5\s*\$7\s*\[math\]/);
	});

	// Found by the independent check of the first build: each of these was
	// right before the money rule and lost under its first form.
	it("a formula directly followed by a digit is still a formula", () => {
		for (const [source, count] of [["$3$4", 1], ["Formula $2x$5 weird", 1], ["Digit $2x$3 and $4y$5", 2], ["$5!$ and $5!$6", 2], ["$2+2=$4", 1], ["$10\\%$5", 1]] as const) {
			assert.equal(transformMathDelimiters(source), source);
			assert.equal(formulas(render(source)), count, source);
		}
	});

	it("a formula typed with a space before its closing dollar is still a formula, and so is the next one", () => {
		for (const [source, count] of [
			["Sum of $1 + 2 $ and $3$ here.", 2],
			["Equation $1 + 1 = 2 $ end", 1],
			["So $2x $, as said.", 1],
			["a $1 $ b", 1],
			["Now $3 \\times 4 $ end", 1],
		] as const) {
			assert.equal(transformMathDelimiters(source), source, source);
			const html = render(source);
			assert.ok(!html.includes("katex-error"));
			assert.equal(formulas(html), count, source);
		}
		assert.equal(shown(render("Sum of $1 + 2 $ and $3$ here.")), "Sum of [math] and [math] here.");
	});

	// Found by the second independent check.
	it("the same in a table cell, with the closing dollar against the pipe", () => {
		const source = "| a | b |\n|---|---|\n| $1 + 2 $| $3 |";
		assert.equal(transformMathDelimiters(source), source);
		assert.equal(formulas(render(source)), 1);
		assert.equal(isMoneyPair("1 + 2 ", "| "), false);
	});

	it("price ranges and amounts with no space between them are money", () => {
		for (const source of ["Between $5-$10 a month.", "Either $5/$6 or $7.", "Fees: $100,$200 and $300.", "Earn $5 (or $6) today.", "Fee $5 and $.50 more."]) {
			const html = render(source);
			assert.equal(formulas(html), 0, source);
			assert.equal(shown(html), source);
		}
	});

	it("old \\(…\\) and \\[…\\] math beside money still converts", () => {
		const html = render("It costs $5 or $6, and \\(x^2\\) is \\(y\\).");
		assert.equal(shown(html), "It costs $5 or $6, and [math] is [math].");
	});

	it("a formula being written never turns into text on the way", () => {
		mathCacheForTests.clear();
		const source = "Let $2x + 3 = 7$ and $40\\%$ of $5$ apples, so $3y = 12$ gives $4$.";
		for (let end = 1; end <= source.length; end++) {
			const prefix = source.slice(0, end);
			assert.equal(transformMathDelimiters(prefix), prefix, `changed at ${JSON.stringify(prefix)}`);
		}
	});

	it("money being written never becomes a formula on the way", () => {
		mathCacheForTests.clear();
		const source = "comparing $73,000 with $70,000 measures the gain, and $3,000 is left.";
		for (let end = 1; end <= source.length; end++) {
			assert.equal(formulas(render(source.slice(0, end))), 0, `a formula at ${JSON.stringify(source.slice(0, end))}`);
		}
	});
});

describe("the transform's own properties", () => {
	it("is stable: running it on its own output changes nothing", () => {
		for (const source of [
			"comparing $73,000 with $70,000 measures",
			"Each unit costs $5, so $x$ units cost $5x$ in total.",
			"Costs $5, $6 and $7.",
		]) {
			const once = transformMathDelimiters(source);
			assert.equal(transformMathDelimiters(once), once);
		}
	});

	it("a long run of alternating money and math: every amount is text, every formula a formula", () => {
		const source = Array.from({ length: 60 }, (_, i) => `the $${i + 1} fee for $n_{${i}}$ items`).join("; ");
		const out = transformMathDelimiters(source);
		assert.equal(out.split("\\$").join("$"), source, "only backslashes before dollars were added");
		assert.equal(out.split("\\$").length - 1, 60, "one escape per amount");
		const html = render(source);
		assert.equal(formulas(html), 60);
		assert.ok(!html.includes("katex-error"));
	});

	it("the reader's other users see money as prose too (a repair never works on the text between two amounts)", () => {
		const spans = readContentSpans("comparing $73,000 with $70,000 and $x$");
		assert.deepEqual(spans.filter((s) => s.kind === "math").map((s) => s.raw), ["$x$"]);
	});

	it("an amount, then a formula in brackets", () => {
		const html = render("Pay $100 ($x$ each).");
		assert.equal(shown(html), "Pay $100 ([math] each).");
	});

	it("the known limit: a formula with a space before its closing dollar, at the very end of the text", () => {
		// Recorded, not wanted: the end of the text has to count as "money still
		// being written", or every money sentence would flash as a formula while
		// a reply streams. If this starts failing the limit is gone: update the docs.
		assert.equal(formulas(render("So the sum is $1 + 2 $")), 0);
		assert.equal(formulas(render("So the sum is $1 + 2 $.")), 1, "anything after it and it is math again");
	});
});
