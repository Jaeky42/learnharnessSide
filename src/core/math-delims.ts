/** Shared Markdown/TeX boundaries for legacy delimiter compatibility and
 * display-only tool-content recovery. Source arguments are never rewritten. */
import {
	canParseTex, knownTexCommand, mapMathContent, numericPercentEscape, outsideTexComments,
	readContentSpans, recoverDocumentLayout, texRanges,
} from "./content-reader.ts";

/** Side-tutor fork (performance): a bounded string-keyed memo for the two
 * pure text functions below, so an unchanged string isn't parsed again on a
 * remount or re-render. Oldest entries go first, by entry count and by the
 * characters held. A string that only extends the previous input is a
 * streaming prefix and is computed without being stored, so a reply being
 * written never fills the cache with its own prefixes. */
export const MATH_CACHE_MAX_ENTRIES = 1000;
export const MATH_CACHE_MAX_CHARS = 2_000_000;
function boundedMemo(compute: (text: string) => string) {
	const entries = new Map<string, string>();
	let chars = 0, previous = "";
	const fn = (text: string): string => {
		const hit = entries.get(text);
		if (hit !== undefined) return hit;
		const result = compute(text);
		const growing = previous !== "" && text.length > previous.length && text.startsWith(previous);
		previous = text;
		if (growing || text === "" || text.length + result.length > MATH_CACHE_MAX_CHARS / 4) return result;
		entries.set(text, result);
		chars += text.length + result.length;
		for (const [key, value] of entries) {
			if (entries.size <= MATH_CACHE_MAX_ENTRIES && chars <= MATH_CACHE_MAX_CHARS) break;
			entries.delete(key); chars -= key.length + value.length;
		}
		return result;
	};
	return { fn, stats: () => ({ entries: entries.size, chars }), clear: () => { entries.clear(); chars = 0; previous = ""; } };
}

const escaped = (text: string, i: number) => {
	let n = 0; while (i > 0 && text[--i] === "\\") n++;
	return n % 2 === 1;
};

/** Preserve the legacy list-continuation policy: indented display math
 * degrades to inline rather than disrupting list structure. Literal code
 * indentation is already protected by the shared reader. */
function indented(text: string, i: number): boolean {
	const prefix = text.slice(text.lastIndexOf("\n", i - 1) + 1, i);
	return prefix.length > 0 && /^[ \t]+$/.test(prefix);
}
function blockPosition(text: string, i: number): boolean {
	return /^[ \t]*$/.test(text.slice(text.lastIndexOf("\n", i - 1) + 1, i));
}

/** micromark closes native single-dollar spans at escaped dollars too.
 * Replace an intended literal dollar with equivalent dollar-free TeX before
 * tokenization. Code, prose, unbalanced spans and display dollars stay raw. */
function replaceEscapedDollars(content: string): string {
	let out = "";
	for (let i = 0; i < content.length; i++) {
		if (content[i] === "\\" && content[i + 1] === "$" && !escaped(content, i)) {
			out += "\\text{\\textdollar}"; i++;
		} else out += content[i];
	}
	return out;
}

/** Read old \(...\)/\[...\] syntax without touching literal content or
 * reparsing native math as Markdown. Dollar authoring remains native. */
const transformMemo = boundedMemo(transformMathDelimitersUncached);
export const transformMathDelimiters: (markdown: string) => string = transformMemo.fn;
function transformMathDelimitersUncached(markdown: string): string {
	let offset = 0;
	return readContentSpans(markdown).map(span => {
		const start = offset; offset += span.raw.length;
		if (span.kind !== "math") return span.raw;
		if (span.open === "$") return "$" + replaceEscapedDollars(span.body) + span.close;
		if (span.open !== "\\(" && span.open !== "\\[") return span.raw;
		const body = span.body.trim();
		if (!body) return span.raw;
		if (span.open === "\\(") return `$$${body}$$`;
		if (indented(markdown, start)) return `$$${body.replace(/\s*\n\s*/g, " ")}$$`;
		const before = blockPosition(markdown, start) ? "" : "\n\n";
		const end = start + span.raw.length;
		const after = end === markdown.length || markdown[end] === "\n" ? "" : "\n\n";
		return `${before}$$\n${body}\n$$${after}`;
	}).join("");
}

const DEBRIS: Record<string, string> = {
	"\b": "\\b", "\t": "\\t", "\v": "\\v", "\f": "\\f", "\r": "\\r",
};

/** Recover JSON-swallowed command prefixes only in recognized math, never
 * in code or genuine TeX comments. Restore all debris in one pass. Physical
 * display newlines and CRLF remain source whitespace. Inline LF recovery is
 * limited to complete known n-command names. Under the approved typical-
 * model-authoring policy this includes newline+u→nu in inline math only;
 * already-correct commands are never decoded into whitespace. */
export function restoreMathEscapes(text: string): string {
	if (!/[\b\t\n\v\f\r]/.test(text)) return text;
	return mapMathContent(text, (body, display) => outsideTexComments(body, part => {
		const restored = part.replace(/[\b\t\v\f\r]/g, (char, offset: number) => {
			if (char === "\r" && part[offset + 1] === "\n") return char;
			const suffix = /^[A-Za-z]+/.exec(part.slice(offset + 1))?.[0];
			return suffix && knownTexCommand(DEBRIS[char]!.slice(1) + suffix) ? DEBRIS[char]! : char;
		});
		if (display) return restored;
		return restored.replace(/\n([A-Za-z]+)/g, (whole, suffix: string) =>
			knownTexCommand("n" + suffix) ? "\\n" + suffix : whole);
	}));
}

const commandSymbol = /[,;:!|{}%]/;

/** Decode prefixes and row separators according to ORIGINAL TeX context.
 * A native pair is literal; an encoded pair supplies a factor, so an encoded
 * four-backslash row becomes TWO, never a command prefix. Unknown commands
 * without that structural evidence are left alone. */
function recoverCommandRuns(inner: string, display: boolean): string {
	const ranges = texRanges(inner);
	const recovered = inner.replace(/\\+/g, (run: string, offset: number) => {
		const contexts = ranges.filter(r => offset >= r.start && offset < r.end);
		if (contexts.some(r => r.kind === "row" || r.kind === "comment") || run.length % 2 !== 0) return run;
		const next = inner[offset + run.length] ?? "";
		const encoded = contexts.filter(r => r.kind === "encoded").at(-1);
		const word = /^[A-Za-z]+/.exec(inner.slice(offset + run.length))?.[0];
		if (encoded) {
			const factor = encoded.factor!;
			const rows = run.length % (2 * factor) === 0;
			const command = word ? knownTexCommand(word) : commandSymbol.test(next);
			if (run.length % factor === 0 && (rows || command)) return "\\".repeat(run.length / factor);
			return run;
		}
		if (next === "%") return numericPercentEscape(inner, offset + run.length) ? "\\" : run;
		if (word) return word.length > 1 && knownTexCommand(word) ? "\\" : run;
		return next && commandSymbol.test(next) ? "\\" : run;
	});
	// Structural evidence is primary (parse success cannot prove row
	// preservation). As an additional guard, never turn parseable source into
	// a parse failure through partial command recovery.
	if (recovered !== inner && !canParseTex(recovered, display) && canParseTex(inner, display)) return inner;
	return recovered;
}

export function healOverescapedCommands(text: string): string {
	return text.includes("\\\\") ? mapMathContent(text, recoverCommandRuns) : text;
}

/** Presentation-only, language-independent recovery. Shape parsing, saved
 * identities, grading and model history must use the unprojected source. */
const repairMemo = boundedMemo(repairMathForDisplayUncached);
export const repairMathForDisplay: (text: string) => string = repairMemo.fn;
/** For tests: how much each cache holds, and emptying both. */
export const mathCacheForTests = {
	stats: () => ({ transform: transformMemo.stats(), repair: repairMemo.stats() }),
	clear: () => { transformMemo.clear(); repairMemo.clear(); },
};
function repairMathForDisplayUncached(text: string): string {
	return healOverescapedCommands(restoreMathEscapes(recoverDocumentLayout(text)));
}
