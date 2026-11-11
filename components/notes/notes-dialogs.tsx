"use client";

/**
 * The notes drawer's dialogs: Move to…, the split preview, and a one-field
 * name prompt (new folder, extract selection). Same shape as the app's
 * other dialogs (portaled z-50, card on a dimmed backdrop, Esc closes and
 * stops there).
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { FileTextIcon, FolderIcon, InboxIcon, LockIcon } from "lucide-react";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { cn } from "@/lib/utils";
import { deleteConfirmText, folderOf, INBOX_FOLDER, isWithinFolder, joinPath, nameProblem, noteName, parseSections, type FolderContents } from "@/src/core";

function Frame({ label, onClose, children, wide }: { label: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
	const backdrop = useBackdropDismiss(onClose);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);
	return createPortal(
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80" {...backdrop}>
			<div
				role="dialog"
				aria-modal="true"
				aria-label={label}
				onClick={(e) => e.stopPropagation()}
				className={cn("max-h-[calc(100dvh-4rem)] overflow-y-auto rounded-xl border bg-card p-5 shadow-xl", wide ? "w-[40rem] max-w-[calc(100vw-2rem)]" : "w-[26rem] max-w-[calc(100vw-2rem)]")}
			>
				{children}
			</div>
		</div>,
		document.body,
	);
}

function Actions({ onClose, onConfirm, label, busy, disabled, danger }: { onClose: () => void; onConfirm: () => void; label: string; busy?: boolean; disabled?: boolean; danger?: boolean }) {
	return (
		<div className="mt-5 flex justify-end gap-2">
			<button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
				Cancel
			</button>
			<button
				type="button"
				onClick={onConfirm}
				disabled={busy || disabled}
				className={cn(
					"rounded-md px-3 py-1.5 text-sm transition-colors disabled:opacity-40",
					danger ? "bg-destructive text-white hover:bg-destructive/90" : "bg-primary text-primary-foreground hover:bg-primary/90",
				)}
			>
				{busy ? "Working…" : label}
			</button>
		</div>
	);
}

function ErrorLine({ text }: { text: string | null }) {
	if (!text) return null;
	return <p role="alert" className="mt-3 text-xs text-destructive">{text}</p>;
}

// ─── Move to… ────────────────────────────────────────────────────────────────

export function MoveDialog({
	item,
	folders,
	onClose,
	onMove,
}: {
	/** A note path (".md") or a folder path. */
	item: string;
	folders: readonly string[];
	onClose: () => void;
	onMove: (toFolder: string) => Promise<void>;
}) {
	const isNote = item.endsWith(".md");
	const [filter, setFilter] = useState("");
	const [pick, setPick] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const current = folderOf(item);
	const options = useMemo(() => {
		const all = ["", ...folders.filter((f) => isNote || !isWithinFolder(f, item))];
		const q = filter.trim().toLowerCase();
		return all.filter((f) => !q || f.toLowerCase().includes(q));
	}, [folders, filter, isNote, item]);
	const name = isNote ? noteName(item) : item.split("/").pop();

	const run = async () => {
		if (pick === null) return;
		setBusy(true);
		setError(null);
		try {
			await onMove(pick);
			onClose();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setBusy(false);
		}
	};

	return (
		<Frame label="Move to" onClose={onClose}>
			<h2 className="text-sm font-semibold">Move to…</h2>
			<p className="mt-1 truncate font-prose text-(length:--lh-prose-size)">{name}</p>
			<label className="mt-3 block">
				<span className="sr-only">Filter folders</span>
				<input
					autoFocus
					value={filter}
					onChange={(e) => setFilter(e.target.value)}
					placeholder="Filter folders"
					className="h-7 w-full rounded-sm border border-border bg-background px-2 text-xs outline-none placeholder:text-muted-foreground focus:border-ring"
				/>
			</label>
			<div role="listbox" aria-label="Folders" className="mt-2 max-h-72 overflow-y-auto rounded-md border border-border/60 p-1">
				{options.map((f) => {
					const disabled = f === current;
					const depth = f ? f.split("/").length - 1 : 0;
					return (
						<button
							key={f || "(root)"}
							type="button"
							role="option"
							aria-selected={pick === f}
							disabled={disabled}
							onClick={() => setPick(f)}
							className={cn(
								"flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-left text-sm transition-colors hover:bg-accent/60 disabled:opacity-40",
								pick === f && "bg-accent",
							)}
							style={{ paddingLeft: 8 + (filter ? 0 : depth * 14) }}
						>
							{f === INBOX_FOLDER ? <InboxIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden /> : <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
							<span className="truncate">{f === "" ? "LearnHarness (top level)" : filter ? f : f.split("/").pop()}</span>
							{disabled && <span className="ml-auto shrink-0 text-xs text-muted-foreground">current</span>}
						</button>
					);
				})}
			</div>
			<ErrorLine text={error} />
			<Actions onClose={onClose} onConfirm={() => void run()} label="Move" busy={busy} disabled={pick === null} />
		</Frame>
	);
}

// ─── Name prompt ─────────────────────────────────────────────────────────────

export function NameDialog({
	title,
	description,
	initial,
	confirmLabel,
	onClose,
	onConfirm,
}: {
	title: string;
	description?: string;
	initial?: string;
	confirmLabel: string;
	onClose: () => void;
	onConfirm: (name: string) => Promise<void>;
}) {
	const [name, setName] = useState(initial ?? "");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const run = async () => {
		const problem = nameProblem(name);
		if (problem) return setError(problem);
		setBusy(true);
		setError(null);
		try {
			await onConfirm(name.trim());
			onClose();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setBusy(false);
		}
	};
	return (
		<Frame label={title} onClose={onClose}>
			<h2 className="text-sm font-semibold">{title}</h2>
			{description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
			<label className="mt-3 block">
				<span className="sr-only">Name</span>
				<input
					autoFocus
					value={name}
					onChange={(e) => {
						setName(e.target.value);
						setError(null);
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter") void run();
					}}
					className="lh-input h-8 w-full rounded-md border border-input bg-transparent px-2.5 font-prose text-sm outline-none focus:border-ring"
				/>
			</label>
			<ErrorLine text={error} />
			<Actions onClose={onClose} onConfirm={() => void run()} label={confirmLabel} busy={busy} />
		</Frame>
	);
}

// ─── Delete ──────────────────────────────────────────────────────────────────

/** "Delete … ?" for a note, or for a folder with everything in it (owner's
 *  choice: for good, no Undo). `contents` is null for a note. */
export function DeleteDialog({
	name,
	contents,
	onClose,
	onDelete,
}: {
	name: string;
	contents: FolderContents | null;
	onClose: () => void;
	onDelete: () => Promise<void>;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const { title, body } = deleteConfirmText(name, contents);
	const run = async () => {
		setBusy(true);
		setError(null);
		try {
			await onDelete();
			onClose();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setBusy(false);
		}
	};
	return (
		<Frame label={title} onClose={onClose}>
			<h2 className="text-sm font-semibold" data-testid="notes-delete-title">{title}</h2>
			<p className="mt-1 text-xs text-muted-foreground" data-testid="notes-delete-body">{body}</p>
			<ErrorLine text={error} />
			<Actions onClose={onClose} onConfirm={() => void run()} label="Delete" busy={busy} danger />
		</Frame>
	);
}

// ─── Split ───────────────────────────────────────────────────────────────────

export function SplitDialog({
	path,
	body,
	allNotePaths,
	initialChecked,
	onClose,
	onSplit,
}: {
	path: string;
	body: string;
	allNotePaths: readonly string[];
	/** Section indices checked at open (all, or the one "Move to new note"). */
	initialChecked: readonly number[];
	onClose: () => void;
	onSplit: (choices: Array<{ index: number; title: string }>) => Promise<void>;
}) {
	const { intro, sections } = useMemo(() => parseSections(body), [body]);
	const [checked, setChecked] = useState<boolean[]>(() => sections.map((_, i) => initialChecked.includes(i)));
	const [titles, setTitles] = useState<string[]>(() => sections.map((s) => s.heading));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const name = noteName(path);
	const alreadySummary = folderOf(path) !== "" && folderOf(path).split("/").pop() === name;
	const folder = alreadySummary ? folderOf(path) : joinPath(folderOf(path), name);
	const chosen = sections.map((s, i) => ({ index: i, title: titles[i]!.trim(), heading: s.heading })).filter((_, i) => checked[i]);
	const kept = sections.filter((_, i) => !checked[i]);

	const problems = chosen.map((c) => {
		const p = nameProblem(c.title);
		if (p) return p;
		if (c.title.toLowerCase() === name.toLowerCase()) return "Same name as the summary note.";
		if (chosen.filter((o) => o.title.toLowerCase() === c.title.toLowerCase()).length > 1) return "Two new notes have this name.";
		if (allNotePaths.some((p2) => p2.toLowerCase() === joinPath(folder, `${c.title}.md`).toLowerCase())) return "A note with this name is already in that folder.";
		return null;
	});
	const elsewhere = chosen
		.filter((c, i) => !problems[i] && allNotePaths.some((p2) => p2 !== path && noteName(p2).toLowerCase() === c.title.toLowerCase()))
		.map((c) => c.title);

	const run = async () => {
		if (!chosen.length || problems.some(Boolean)) return;
		setBusy(true);
		setError(null);
		try {
			await onSplit(chosen.map(({ index, title }) => ({ index, title })));
			onClose();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setBusy(false);
		}
	};

	return (
		<Frame label={`Split “${name}” into notes`} onClose={onClose} wide>
			<h2 className="text-sm font-semibold">Split “{name}” into notes</h2>
			<p className="mt-1 text-xs text-muted-foreground">
				Checked sections become their own notes in <span className="text-foreground">{folder}/</span>. Nothing else changes, and no links are added.
			</p>
			<div className="mt-4 grid gap-4 sm:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
				<div>
					<div className="mb-1.5 text-xs uppercase tracking-wider text-muted-foreground">Sections (your ## headings)</div>
					{intro.trim() && (
						<div className="mb-1.5 flex items-center gap-2 rounded-md border border-border/60 bg-muted px-2.5 py-1.5 text-xs text-muted-foreground">
							<LockIcon className="size-3.5 shrink-0" aria-hidden />
							<span className="flex-1">Intro text stays as the summary</span>
						</div>
					)}
					{sections.map((s, i) => (
						<div key={i} className="mb-1.5 rounded-md border border-border/60 px-2 py-1.5">
							<div className="flex items-center gap-2">
								<input
									type="checkbox"
									aria-label={`Make “${s.heading}” its own note`}
									checked={checked[i]}
									onChange={(e) => setChecked((c) => c.map((v, j) => (j === i ? e.target.checked : v)))}
									className="size-3.5 shrink-0 accent-primary"
								/>
								<input
									aria-label={`Name for the note from “${s.heading}”`}
									value={titles[i]}
									disabled={!checked[i]}
									onChange={(e) => setTitles((t) => t.map((v, j) => (j === i ? e.target.value : v)))}
									className="lh-input h-7 min-w-0 flex-1 rounded-sm border border-input bg-transparent px-2 font-prose text-sm outline-none focus:border-ring disabled:opacity-50"
								/>
								<span className="shrink-0 text-xs tabular-nums text-muted-foreground">{s.words} words</span>
							</div>
							{checked[i] && problems[chosen.findIndex((c) => c.index === i)] && (
								<p className="mt-1 text-xs text-destructive">{problems[chosen.findIndex((c) => c.index === i)]}</p>
							)}
						</div>
					))}
					{elsewhere.length > 0 && (
						<p className="mt-1 text-xs text-muted-foreground">
							Already a note elsewhere: {elsewhere.map((t) => `“${t}”`).join(", ")}. Links by name could point at either; consider a more specific name.
						</p>
					)}
				</div>
				<div>
					<div className="mb-1.5 text-xs uppercase tracking-wider text-muted-foreground">Result</div>
					<div className="rounded-md border border-border/60 p-2 text-sm">
						<div className="flex items-center gap-1.5">
							<FolderIcon className="size-3.5 text-muted-foreground" aria-hidden />
							{folder.split("/").pop()}/
						</div>
						<div className="mt-1 flex items-center gap-1.5 pl-4">
							<FileTextIcon className="size-3.5 text-muted-foreground" aria-hidden />
							{name} <span className="text-xs text-muted-foreground">summary</span>
						</div>
						<div className="pl-9 text-xs leading-relaxed text-muted-foreground">
							{intro.trim() ? <div>Intro text</div> : null}
							{kept.map((s) => (
								<div key={s.start}>## {s.heading}</div>
							))}
							{!intro.trim() && !kept.length && <div>Empty</div>}
						</div>
						{chosen.map((c) => (
							<div key={c.index} className="mt-1 flex items-center gap-1.5 pl-4">
								<FileTextIcon className="size-3.5 text-muted-foreground" aria-hidden />
								<span className="truncate">{c.title || "Untitled"}</span>
							</div>
						))}
					</div>
				</div>
			</div>
			<ErrorLine text={error} />
			<Actions
				onClose={onClose}
				onConfirm={() => void run()}
				label={chosen.length === 1 ? "Split into 1 note" : `Split into ${chosen.length} notes`}
				busy={busy}
				disabled={!chosen.length || problems.some(Boolean)}
			/>
		</Frame>
	);
}
