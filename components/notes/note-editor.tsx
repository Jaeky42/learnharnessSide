"use client";

/**
 * The notes drawer's editor: CodeMirror 6 over the note's Markdown BODY
 * (the Properties block stays on disk, untouched).
 *
 *  - `## ` sections (and every heading level) fold from the gutter while
 *    you type (lang-markdown's heading fold service).
 *  - `[[` opens note-name autocomplete.
 *  - Unlinked mentions of other notes get a faint underline and a small
 *    "link?" button; nothing is linked unless the learner clicks it.
 *  - Ctrl/⌘+click opens a link. Pasting an image saves it to the vault.
 *  - Esc leaves the editor and goes no further (it must never reach the
 *    global Esc chain, which aborts the teacher's turn).
 */

import { useEffect, useRef } from "react";
import { autocompletion, completionKeymap, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { codeFolding, foldGutter, foldKeymap, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Annotation, Compartment, EditorState, type Extension, RangeSetBuilder } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, keymap, placeholder, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { findLinks, linkSuggestions, noteName, suggestionLinkText, type LinkSuggestion, type NoteLink } from "@/src/core";

const External = Annotation.define<boolean>();

export interface NoteEditorHandle {
	focus(): void;
	selection(): { start: number; end: number };
}

const theme = EditorView.theme(
	{
		"&": {
			color: "var(--foreground)",
			backgroundColor: "transparent",
			fontFamily: "var(--font-prose)",
			fontSize: "var(--lh-prose-size)",
			height: "100%",
		},
		".cm-scroller": { fontFamily: "inherit", lineHeight: "1.5", overflow: "auto" },
		".cm-content": { padding: "4px 0 24px", caretColor: "var(--foreground)" },
		".cm-line": { padding: "0 4px 0 2px" },
		"&.cm-focused .cm-cursor": { borderLeftColor: "var(--foreground)" },
		"&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "rgba(230,230,230,0.16) !important" },
		".cm-gutters": { backgroundColor: "transparent", border: "none", color: "var(--muted-foreground)" },
		".cm-foldGutter .cm-gutterElement": { padding: "0 2px", cursor: "pointer" },
		".cm-foldPlaceholder": {
			backgroundColor: "var(--accent)",
			border: "none",
			color: "var(--muted-foreground)",
			fontFamily: "var(--font-ui)",
			fontSize: "11px",
			padding: "0 6px",
			borderRadius: "4px",
		},
		".cm-placeholder": { color: "var(--muted-foreground)" },
		".cm-lh-suggest": { textDecoration: "underline dotted var(--muted-foreground)", textUnderlineOffset: "3px" },
		".cm-lh-link": { textDecoration: "underline", textUnderlineOffset: "3px" },
		".cm-lh-link-btn": {
			fontFamily: "var(--font-ui)",
			fontSize: "11px",
			lineHeight: "1",
			color: "var(--muted-foreground)",
			border: "1px solid var(--border)",
			borderRadius: "4px",
			padding: "1px 4px",
			marginLeft: "4px",
			verticalAlign: "2px",
			cursor: "pointer",
			background: "transparent",
		},
		".cm-lh-link-btn:hover": { color: "var(--foreground)", borderColor: "var(--muted-foreground)" },
		".cm-tooltip": { backgroundColor: "var(--popover)", border: "1px solid var(--border)", borderRadius: "8px", overflow: "hidden" },
		".cm-tooltip-autocomplete > ul": { fontFamily: "var(--font-ui)", fontSize: "12.5px", maxHeight: "14rem" },
		".cm-tooltip-autocomplete > ul > li": { padding: "3px 8px" },
		".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--accent)", color: "var(--foreground)" },
		".cm-completionDetail": { color: "var(--muted-foreground)", fontStyle: "normal", marginLeft: "8px" },
	},
	{ dark: true },
);

const highlight = HighlightStyle.define([
	{ tag: tags.heading1, fontWeight: "var(--lh-heading-weight)", fontSize: "1.45em" },
	{ tag: tags.heading2, fontWeight: "var(--lh-heading-weight)", fontSize: "1.25em" },
	{ tag: tags.heading3, fontWeight: "var(--lh-heading-weight)", fontSize: "1.1em" },
	{ tag: [tags.heading4, tags.heading5, tags.heading6], fontWeight: "var(--lh-heading-weight)" },
	{ tag: tags.strong, fontWeight: "700", color: "var(--lh-ink-strong)" },
	{ tag: tags.emphasis, fontStyle: "italic", color: "var(--lh-ink-italic)" },
	{ tag: tags.strikethrough, textDecoration: "line-through" },
	{ tag: [tags.monospace], fontFamily: "var(--font-ui)", fontSize: "0.9em" },
	{ tag: [tags.processingInstruction, tags.meta, tags.contentSeparator], color: "var(--muted-foreground)" },
	{ tag: [tags.link, tags.url], color: "var(--muted-foreground)" },
	{ tag: tags.quote, color: "var(--muted-foreground)" },
]);

function chevron(open: boolean): HTMLElement {
	const span = document.createElement("span");
	span.setAttribute("aria-label", open ? "Fold section" : "Unfold section");
	span.style.display = "inline-flex";
	span.style.transform = open ? "rotate(90deg)" : "none";
	span.innerHTML =
		'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';
	return span;
}

class LinkButton extends WidgetType {
	constructor(readonly suggestion: LinkSuggestion) {
		super();
	}
	eq(other: LinkButton) {
		return other.suggestion.start === this.suggestion.start && other.suggestion.path === this.suggestion.path;
	}
	toDOM() {
		const b = document.createElement("button");
		b.type = "button";
		b.className = "cm-lh-link-btn";
		b.textContent = "link?";
		b.title = `Link to “${noteName(this.suggestion.path)}”`;
		b.dataset.lhSuggest = String(this.suggestion.start);
		return b;
	}
	ignoreEvent() {
		return false;
	}
}

interface Live {
	paths: readonly string[];
	self: string;
	onOpenLink: (link: NoteLink) => void;
	onPasteImage: (file: File) => Promise<string | null>;
	onChange: (value: string) => void;
	onSelection: (range: { start: number; end: number }) => void;
}

function decorationsFor(view: EditorView, live: Live): { deco: DecorationSet; suggestions: LinkSuggestion[] } {
	const text = view.state.doc.toString();
	const suggestions = linkSuggestions(text, live.self, live.paths);
	const marks: Array<{ from: number; to: number; deco: Decoration }> = [];
	for (const l of findLinks(text)) if (!l.embed) marks.push({ from: l.start, to: l.end, deco: Decoration.mark({ class: "cm-lh-link", attributes: { title: "Ctrl+click to open" } }) });
	for (const s of suggestions) {
		marks.push({ from: s.start, to: s.end, deco: Decoration.mark({ class: "cm-lh-suggest" }) });
		marks.push({ from: s.end, to: s.end, deco: Decoration.widget({ widget: new LinkButton(s), side: 1 }) });
	}
	marks.sort((a, b) => a.from - b.from || a.to - b.to);
	const builder = new RangeSetBuilder<Decoration>();
	for (const m of marks) builder.add(m.from, m.to, m.deco);
	return { deco: builder.finish(), suggestions };
}

export function NoteEditor({
	docKey,
	value,
	notePaths,
	selfPath,
	onChange,
	onOpenLink,
	onPasteImage,
	onSelection,
	handleRef,
}: {
	/** The note's path: a new key starts a fresh editor (own undo history). */
	docKey: string;
	value: string;
	notePaths: readonly string[];
	selfPath: string;
	onChange: (value: string) => void;
	onOpenLink: (link: NoteLink) => void;
	onPasteImage: (file: File) => Promise<string | null>;
	onSelection: (range: { start: number; end: number }) => void;
	handleRef?: React.MutableRefObject<NoteEditorHandle | null>;
}) {
	const host = useRef<HTMLDivElement | null>(null);
	const viewRef = useRef<EditorView | null>(null);
	const live = useRef<Live>({ paths: notePaths, self: selfPath, onOpenLink, onPasteImage, onChange, onSelection });
	live.current = { paths: notePaths, self: selfPath, onOpenLink, onPasteImage, onChange, onSelection };
	const refresh = useRef(new Compartment());

	useEffect(() => {
		if (!host.current) return;
		const suggestionsPlugin = ViewPlugin.fromClass(
			class {
				decorations: DecorationSet;
				suggestions: LinkSuggestion[];
				constructor(view: EditorView) {
					const r = decorationsFor(view, live.current);
					this.decorations = r.deco;
					this.suggestions = r.suggestions;
				}
				update(u: ViewUpdate) {
					if (u.docChanged || u.transactions.some((t) => t.reconfigured)) {
						const r = decorationsFor(u.view, live.current);
						this.decorations = r.deco;
						this.suggestions = r.suggestions;
					}
				}
			},
			{
				decorations: (v) => v.decorations,
				eventHandlers: {
					mousedown(e, view) {
						const target = e.target as HTMLElement;
						const btn = target.closest?.("[data-lh-suggest]") as HTMLElement | null;
						if (btn) {
							e.preventDefault();
							const start = Number(btn.dataset.lhSuggest);
							const s = this.suggestions.find((x) => x.start === start);
							if (s) view.dispatch({ changes: { from: s.start, to: s.end, insert: suggestionLinkText(s) } });
							return true;
						}
						if (e.ctrlKey || e.metaKey) {
							const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
							if (pos === null) return false;
							const link = findLinks(view.state.doc.toString()).find((l) => pos >= l.start && pos <= l.end);
							if (link) {
								e.preventDefault();
								live.current.onOpenLink(link);
								return true;
							}
						}
						return false;
					},
				},
			},
		);

		const wikiCompletion = (ctx: CompletionContext): CompletionResult | null => {
			const before = ctx.matchBefore(/\[\[[^\]|#\n]*$/);
			if (!before) return null;
			const after = ctx.state.sliceDoc(ctx.pos, ctx.pos + 2);
			const names = new Map<string, string>();
			for (const p of live.current.paths) if (p !== live.current.self && !names.has(noteName(p))) names.set(noteName(p), p);
			return {
				from: before.from + 2,
				options: [...names].map(([name, p]) => ({
					label: name,
					detail: p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "",
					apply: after === "]]" ? name : `${name}]]`,
				})),
				validFor: /^[^\]|#\n]*$/,
				filter: true,
			};
		};

		const extensions: Extension[] = [
			history(),
			keymap.of([...completionKeymap, ...foldKeymap, ...historyKeymap, ...defaultKeymap]),
			markdown(),
			syntaxHighlighting(highlight),
			codeFolding({ placeholderText: "…" }),
			foldGutter({ markerDOM: (open) => chevron(open) }),
			EditorView.lineWrapping,
			placeholder("Start typing. Use ## for a section heading."),
			autocompletion({ override: [wikiCompletion], icons: false, activateOnTyping: true }),
			theme,
			refresh.current.of([]),
			suggestionsPlugin,
			EditorView.domEventHandlers({
				keydown(e, view) {
					if (e.key === "Escape") {
						// One Esc, one action: leave the editor, nothing else.
						e.stopPropagation();
						view.contentDOM.blur();
						return true;
					}
					return false;
				},
				paste(e, view) {
					const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
					if (!file) return false;
					e.preventDefault();
					const at = view.state.selection.main;
					void live.current.onPasteImage(file).then((embed) => {
						if (!embed || viewRef.current !== view) return;
						const pos = Math.min(at.from, view.state.doc.length);
						const to = Math.min(at.to, view.state.doc.length);
						view.dispatch({ changes: { from: pos, to, insert: embed }, selection: { anchor: pos + embed.length } });
					});
					return true;
				},
			}),
			EditorView.updateListener.of((u) => {
				if (u.docChanged && !u.transactions.some((t) => t.annotation(External))) live.current.onChange(u.state.doc.toString());
				if (u.selectionSet || u.docChanged) {
					const m = u.state.selection.main;
					live.current.onSelection({ start: m.from, end: m.to });
				}
			}),
			EditorView.contentAttributes.of({ "aria-label": "Note text", spellcheck: "true" }),
		];

		const view = new EditorView({ parent: host.current, state: EditorState.create({ doc: value, extensions }) });
		viewRef.current = view;
		if (handleRef) {
			handleRef.current = {
				focus: () => view.focus(),
				selection: () => ({ start: view.state.selection.main.from, end: view.state.selection.main.to }),
			};
		}
		return () => {
			view.destroy();
			if (viewRef.current === view) viewRef.current = null;
			if (handleRef?.current) handleRef.current = null;
		};
		// A new note = a new editor; value changes for the same note sync below.
	}, [docKey]);

	// External content (reload after an Obsidian edit, a split rewrite…).
	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;
		const current = view.state.doc.toString();
		if (current === value) return;
		view.dispatch({ changes: { from: 0, to: current.length, insert: value }, annotations: External.of(true) });
	}, [value]);

	// The set of note names changed: recompute suggestions and link marks.
	const pathsKey = notePaths.join("\n");
	useEffect(() => {
		viewRef.current?.dispatch({ effects: refresh.current.reconfigure([]) });
	}, [pathsKey]);

	return <div ref={host} data-testid="note-editor" className="h-full min-h-40" />;
}
