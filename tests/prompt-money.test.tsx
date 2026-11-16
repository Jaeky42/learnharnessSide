/**
 * Fork: money amounts in what the agents write (owner's report: a practice
 * problem with two bare "$" amounts in one paragraph was drawn as one long
 * formula).
 *
 * The fix is one bullet in upstream's shared formatting fragment. This file
 * guards it twice:
 *   - the bullet is still in the fragment, and reaches every agent that
 *     writes for the learner (a later upstream merge must not drop it);
 *   - each form the bullet names renders as it says, through the app's real
 *     renderer, so the instruction and the renderer can't drift apart.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageResponse, ToolContentResponse } from "../components/ai-elements/message.tsx";
import { effectivePromptSegments } from "../src/agent/prompt-segments.ts";
import { composeSideChatInstructions } from "../src/agent/side-chat.ts";

const FRAGMENT = "shared/40-formatting.md";
const BULLET =
	"- Money: a bare `$` opens math, so two amounts in one paragraph turn everything between them into a formula. " +
	"Escape currency in prose as `\\$20` (in JSON strings: `\\\\$20`), or keep it inside math as `$\\$20$`. " +
	"Literal tokens such as `$HOME` go in inline code.";

describe("the money bullet in the formatting instructions", () => {
	it("is in the shared formatting fragment, word for word", () => {
		const source = readFileSync(new URL(`../src/agent/prompts/${FRAGMENT}`, import.meta.url), "utf8");
		assert.ok(source.split("\n").includes(BULLET), "the Money bullet is missing from shared/40-formatting.md");
	});

	for (const agent of ["prober", "teacher", "practice"] as const) {
		it(`reaches the ${agent}`, () => {
			const segment = effectivePromptSegments(agent, {}).find((s) => s.path === FRAGMENT);
			assert.ok(segment, `${agent} no longer composes ${FRAGMENT}`);
			assert.ok(JSON.stringify(segment).includes(JSON.stringify(BULLET).slice(1, -1)), `${agent}'s formatting text lacks the Money bullet`);
		});
	}

	it("reaches side questions (the Tutor)", () => {
		assert.ok(composeSideChatInstructions().includes(BULLET));
	});
});

describe("money renders as the bullet says", () => {
	const surfaces = {
		"a message": (md: string) => renderToStaticMarkup(<MessageResponse mode="static">{md}</MessageResponse>),
		"a tool's text (a problem statement)": (md: string) => renderToStaticMarkup(<ToolContentResponse mode="static">{md}</ToolContentResponse>),
	};
	/** The rendered text, with each formula replaced by a marker. */
	const shown = (html: string) => html
		.replace(/<span class="katex">[\s\S]*?<\/span><\/span><\/span>(<\/span>)*/g, "[math]")
		.replace(/<[^>]+>/g, "");

	for (const [surface, render] of Object.entries(surfaces)) {
		it(`${surface}: escaped amounts stay text, with the bold between them`, () => {
			const html = render("A face value of \\$100,000, classified as **available for sale**. It receives \\$6,000; the fair value is \\$96,000.");
			assert.ok(!html.includes("katex"), "escaped currency must not become math");
			assert.match(shown(html), /A face value of \$100,000, classified as available for sale\. It receives \$6,000; the fair value is \$96,000\./);
			assert.match(html, /<(strong|span)[^>]*>available for sale</);
		});

		it(`${surface}: an amount inside math is one formula each`, () => {
			const html = render("A face value of $\\$600{,}000$ and a carrying amount of $\\$588{,}000$.");
			assert.ok(!html.includes("katex-error"), "no KaTeX error");
			assert.equal(shown(html), "A face value of [math] and a carrying amount of [math].");
		});

		it(`${surface}: escaped money and real math share a paragraph`, () => {
			const html = render("Each unit costs \\$5, so $x$ units cost $\\$5x$, at most \\$40.");
			assert.ok(!html.includes("katex-error"), "no KaTeX error");
			assert.equal(shown(html), "Each unit costs $5, so [math] units cost [math], at most $40.");
		});

		it(`${surface}: escaped money in a table and a list`, () => {
			const table = render("| Item | Amount |\n|---|---|\n| Interest | \\$6,000 |\n| Fair value | \\$96,000 |");
			assert.ok(!table.includes("katex"));
			assert.match(shown(table), /Interest\s*\$6,000\s*Fair value\s*\$96,000/);
			const list = render("1. Cash paid: **\\$594,000**\n2. Loss: \\$3,060");
			assert.ok(!list.includes("katex"));
			assert.match(shown(list), /Cash paid: \$594,000[\s\S]*Loss: \$3,060/);
		});

		// The hazard the bullet describes. If this ever stops holding (upstream
		// teaches the renderer to tell money from math), the bullet can go.
		it(`${surface}: two bare amounts in one paragraph are still read as a formula`, () => {
			const html = render("A face value of $100,000 and it receives $6,000 of interest.");
			assert.ok(html.includes("katex"), "the renderer now tells money from math: revisit the Money bullet");
		});
	}
});
