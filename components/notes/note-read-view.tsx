"use client";

/**
 * The notes drawer's Read view: the note rendered the way the lessons are
 * (the same Markdown renderer — `$V = IR$` math included), with `## `
 * sections that fold, clickable `[[links]]`, and embedded images from the
 * vault.
 */

import { createContext, useContext, useMemo, useState, type AnchorHTMLAttributes, type ReactNode } from "react";
import { ChevronRightIcon, ScissorsIcon } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { mdComponents } from "@/components/md-blocks";
import { findLinks, isImageName, parseSections, type NoteLink } from "@/src/core";
import { assetUrl } from "./notes-api";

const LINK_PREFIX = "#lhnote:";

const OpenLinkContext = createContext<(link: Pick<NoteLink, "kind" | "target" | "heading">) => void>(() => {});

function encodeHref(link: Pick<NoteLink, "kind" | "target" | "heading">): string {
	return LINK_PREFIX + encodeURIComponent(JSON.stringify({ k: link.kind, t: link.target, h: link.heading })).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

function escapeLinkText(s: string): string {
	return s.replace(/([[\]\\])/g, "\\$1");
}

/** Wiki links and embeds → plain Markdown the shared renderer understands. */
export function readViewMarkdown(body: string, selfPath: string): string {
	let out = body;
	for (const l of findLinks(body).reverse()) {
		let next: string;
		if (l.embed && isImageName(l.target)) {
			next = `![${escapeLinkText(l.alias ?? "")}](<${assetUrl(l.target, selfPath)}>)`;
		} else {
			const label = l.alias ?? (l.heading ? `${l.target || "this note"} › ${l.heading}` : l.target);
			next = `[${escapeLinkText(label)}](<${encodeHref(l)}>)`;
		}
		out = out.slice(0, l.start) + next + out.slice(l.end);
	}
	return out;
}

function NoteAnchor({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) {
	const open = useContext(OpenLinkContext);
	delete (rest as { node?: unknown }).node;
	if (href?.startsWith(LINK_PREFIX)) {
		let link: { k: NoteLink["kind"]; t: string; h: string | null } | null = null;
		try { link = JSON.parse(decodeURIComponent(href.slice(LINK_PREFIX.length))); } catch { link = null; }
		return (
			<a
				{...rest}
				href="#"
				className="cursor-pointer underline underline-offset-[3px]"
				onClick={(e) => {
					e.preventDefault();
					if (link) open({ kind: link.k, target: link.t, heading: link.h });
				}}
			>
				{children}
			</a>
		);
	}
	return (
		<a {...rest} href={href} target="_blank" rel="noreferrer" className="underline underline-offset-[3px]">
			{children}
		</a>
	);
}

// Built on first use, not at module load: since upstream 0.6.0, md-blocks
// reaches this file through a loop of imports (plugin renderers → the chat
// view → the notes drawer), so `mdComponents` may not exist yet up here.
let readComponentsCache: (typeof mdComponents & { a: typeof NoteAnchor }) | null = null;
const readComponents = () => (readComponentsCache ??= { ...mdComponents, a: NoteAnchor });

function Rendered({ text }: { text: string }) {
	if (!text.trim()) return null;
	return (
		<MessageResponse className="text-(length:--lh-prose-size)" components={readComponents()}>
			{text}
		</MessageResponse>
	);
}

export function NoteReadView({
	path,
	body,
	onOpenLink,
	onMoveSection,
}: {
	path: string;
	body: string;
	onOpenLink: (link: Pick<NoteLink, "kind" | "target" | "heading">) => void;
	onMoveSection: (index: number) => void;
}) {
	const [folded, setFolded] = useState<Record<string, boolean>>({});
	const parsed = useMemo(() => parseSections(body), [body]);
	if (!body.trim()) {
		return <p className="font-prose text-(length:--lh-prose-size) text-muted-foreground">This note is empty. Switch to Edit to start writing.</p>;
	}
	const key = (i: number) => `${path}:${i}`;
	let sections: ReactNode = null;
	sections = parsed.sections.map((s, i) => {
		const open = !folded[key(i)];
		return (
			<section key={`${i}-${s.heading}`} className="group/sec">
				<div className="mt-3 flex items-center gap-1">
					<button
						type="button"
						aria-expanded={open}
						onClick={() => setFolded((f) => ({ ...f, [key(i)]: open }))}
						className="flex min-w-0 flex-1 items-center gap-1 text-left font-prose text-[1.25em] [font-weight:var(--lh-heading-weight)]"
					>
						<ChevronRightIcon className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} aria-hidden />
						<span className="truncate">{s.heading}</span>
						{!open && <span className="ml-1.5 shrink-0 font-ui text-xs font-normal text-muted-foreground">folded</span>}
					</button>
					<button
						type="button"
						onClick={() => onMoveSection(i)}
						title="Move this section to a new note"
						aria-label={`Move “${s.heading}” to a new note`}
						className="shrink-0 rounded-sm p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/sec:opacity-100"
					>
						<ScissorsIcon className="size-3.5" />
					</button>
				</div>
				{open && (
					<div className="pl-[18px]">
						<Rendered text={readViewMarkdown(s.content, path)} />
					</div>
				)}
			</section>
		);
	});
	return (
		<OpenLinkContext.Provider value={onOpenLink}>
			<div data-testid="note-read-view" className="pb-6">
				<Rendered text={readViewMarkdown(parsed.intro, path)} />
				{sections}
			</div>
		</OpenLinkContext.Provider>
	);
}
