"use client";
/**
 * Settings → Accounts: the server owner's screen (side-tutor fork, several
 * accounts on one server; docs/multi-account-plan.md, "The owner's screen").
 * Shown only on the server's site to its owner: the `lh_server` and
 * `lh_owner` marker cookies decide whether it SHOWS, the gateway decides what
 * is allowed (GET and POST /api/accounts answer 404 to anyone else).
 *
 * Three groups: Accounts (one line each with a ⋯ menu: Reset password, Pause
 * or Resume, Remove), Invite codes, and Removed (Restore, Delete now). The
 * four confirm boxes and the two code boxes are on the host's dialog layer.
 * Every answer carries the fresh `view`, which replaces the list; the list is
 * also read on open and every 10 seconds while open. The wording is
 * owner-approved (src/core/account-screens.ts).
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CheckIcon, MoreHorizontalIcon } from "lucide-react";
import { MenuShell } from "@/components/menu-shell";
import type { CloseOutcome } from "@/components/interaction-layers";
import {
	ACCOUNTS_TEXT,
	accountStatusText,
	deleteNowConfirm,
	inviteBox,
	inviteUntilText,
	pauseConfirm,
	removeAccountConfirm,
	removedText,
	resetCodeBox,
	resetConfirm,
	restoreFullText,
	serverFullText,
	usedText,
	type AccountsView,
	type ConfirmText,
} from "@/src/core";
import { ConnectionDialog } from "./connection-controls.tsx";
import { SettingsGroup } from "./controls.tsx";
import { isOwnerMode } from "./owner-mode";
import { isServerMode } from "./server-mode";

const POLL_MS = 10_000;
/** The app's usual lines (account-section.tsx, cloud-server-section.tsx). */
const GENERIC_ERROR = "Something went wrong. Try again.";
const UNREACHABLE = "The server couldn't be reached. Check your connection and try again.";
const buttonClass = "rounded-sm border border-border px-3 py-1.5 font-ui text-sm text-foreground transition-colors hover:bg-accent disabled:opacity-50 max-sm:min-h-10";
const menuItemClass = "block w-full rounded-md px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent max-sm:py-2.5 max-sm:text-sm";

type Account = AccountsView["accounts"][number];
type ConfirmOp = "reset" | "pause" | "remove" | "delete-now";
type Confirm = { op: ConfirmOp; id: string; name: string };
type CodeBox = { kind: "invite"; code: string; expiresAt: number } | { kind: "reset"; name: string; code: string };
type Notice = { group: "accounts" | "invites" | "removed"; text: string };
type Reply = { ok: boolean; data: Record<string, unknown> };

function isView(body: unknown): body is AccountsView {
	const view = body as Partial<AccountsView> | null;
	return !!view && Array.isArray(view.accounts) && Array.isArray(view.invites) && Array.isArray(view.removed) && typeof view.used === "number" && typeof view.cap === "number";
}

/** Clipboard write with the legacy fallback (as the lesson's copy button). */
async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch { /* fall through */ }
	try {
		const area = document.createElement("textarea");
		area.value = text;
		area.setAttribute("readonly", "");
		area.style.position = "fixed";
		area.style.opacity = "0";
		document.body.appendChild(area);
		area.select();
		const ok = document.execCommand("copy");
		area.remove();
		return ok;
	} catch {
		return false;
	}
}

function confirmFor(confirm: Confirm): ConfirmText {
	switch (confirm.op) {
		case "reset": return resetConfirm(confirm.name);
		case "pause": return pauseConfirm(confirm.name);
		case "remove": return removeAccountConfirm(confirm.name);
		case "delete-now": return deleteNowConfirm(confirm.name);
	}
}

/** The two confirm boxes that ask for something that can't be taken back are red. */
const isDanger = (op: ConfirmOp): boolean => op === "remove" || op === "delete-now";

function Dialog({ label, testid, busy, onClose, children }: { label: string; testid: string; busy: boolean; onClose: () => CloseOutcome; children: ReactNode }) {
	return <ConnectionDialog label={label} testid={testid} backdropTestid={`${testid}-backdrop`} busy={busy} onClose={onClose}>{children}</ConnectionDialog>;
}

function ConfirmDialog({ text, danger, busy, onCancel, onConfirm }: { text: ConfirmText; danger: boolean; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
	return (
		<Dialog label={text.title} testid="accounts-confirm" busy={busy} onClose={() => { onCancel(); return "closed"; }}>
			<h2 className="text-sm font-semibold text-foreground" data-testid="accounts-confirm-title">{text.title}</h2>
			<p className="mt-1 text-xs text-muted-foreground" data-testid="accounts-confirm-body">{text.body}</p>
			<div className="mt-5 flex justify-end gap-2">
				<button type="button" onClick={onCancel} data-testid="accounts-confirm-cancel" className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground max-sm:min-h-10">{text.cancel}</button>
				{/* White on the theme's error colour, as upstream's destructive button. */}
				<button
					type="button"
					onClick={onConfirm}
					disabled={busy}
					data-testid="accounts-confirm-yes"
					className={`rounded-md px-3 py-1.5 text-sm transition-colors disabled:opacity-40 max-sm:min-h-10 ${danger ? "bg-destructive text-white hover:bg-destructive/90" : "bg-primary text-primary-foreground hover:bg-primary/90"}`}
				>
					{text.confirm}
				</button>
			</div>
		</Dialog>
	);
}

/** A code that can't be shown again: only Done closes it (Esc and a click outside don't). */
function CodeDialog({ title, body, code, copy, done, onDone }: { title: string; body: string; code: string; copy: string; done: string; onDone: () => void }) {
	const [copied, setCopied] = useState(false);
	return (
		<Dialog label={title} testid="accounts-code-box" busy={false} onClose={() => "blocked"}>
			<h2 className="text-sm font-semibold text-foreground" data-testid="accounts-code-title">{title}</h2>
			<p className="mt-3 select-all text-lg tracking-widest text-foreground [overflow-wrap:anywhere]" data-testid="accounts-code">{code}</p>
			<p className="mt-1 text-xs text-muted-foreground" data-testid="accounts-code-body">{body}</p>
			<div className="mt-5 flex justify-end gap-2">
				<button type="button" className={`${buttonClass} inline-flex items-center gap-1.5`} data-testid="accounts-code-copy" onClick={() => { void copyText(code).then(setCopied); }}>
					{copied && <CheckIcon aria-hidden="true" className="size-3.5" />}{copy}
				</button>
				<button type="button" className={buttonClass} data-testid="accounts-code-done" onClick={onDone}>{done}</button>
			</div>
		</Dialog>
	);
}

function RowMenu({ anchorRef, account, onPick, onClose }: { anchorRef: { current: HTMLElement | null }; account: Account; onPick: (item: "reset" | "pause" | "resume" | "remove") => void; onClose: () => void }) {
	const items: { id: "reset" | "pause" | "resume" | "remove"; label: string; danger?: boolean }[] = [
		{ id: "reset", label: ACCOUNTS_TEXT.menu.reset },
		account.state === "paused" ? { id: "resume", label: ACCOUNTS_TEXT.menu.resume } : { id: "pause", label: ACCOUNTS_TEXT.menu.pause },
		{ id: "remove", label: ACCOUNTS_TEXT.menu.remove, danger: true },
	];
	return (
		<MenuShell
			anchorRef={anchorRef}
			testid="accounts-menu"
			preferredSide="down"
			align="right"
			menuClass="min-w-44 rounded-lg border border-border bg-popover p-1 text-sm shadow-lg"
			onClose={() => { onClose(); return "closed"; }}
		>
			<div role="menu">
				{items.map((item) => (
					<button
						key={item.id}
						type="button"
						role="menuitem"
						data-testid={`accounts-menu-${item.id}`}
						onClick={() => { onClose(); onPick(item.id); }}
						className={`${menuItemClass} ${item.danger ? "text-error" : "text-foreground"}`}
					>
						{item.label}
					</button>
				))}
			</div>
		</MenuShell>
	);
}

function AccountsScreen({ divided }: { divided: boolean }) {
	/** undefined = still asking, null = couldn't ask and nothing to show. */
	const [view, setView] = useState<AccountsView | null | undefined>(undefined);
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState<Notice | null>(null);
	const [menu, setMenu] = useState<string | null>(null);
	const [confirm, setConfirm] = useState<Confirm | null>(null);
	const [codeBox, setCodeBox] = useState<CodeBox | null>(null);
	const alive = useRef(true);
	/** The newest list wins: a read that was under way when an answer came is dropped. */
	const seq = useRef(0);
	const menuAnchor = useRef<HTMLElement | null>(null);

	const load = useCallback(async () => {
		const ticket = ++seq.current;
		try {
			const response = await fetch("/api/accounts", { cache: "no-store", credentials: "same-origin" });
			const body: unknown = response.ok ? await response.json().catch(() => null) : null;
			if (!alive.current || ticket !== seq.current) return;
			if (isView(body)) setView(body);
			else setView((current) => current ?? null);
		} catch {
			if (alive.current && ticket === seq.current) setView((current) => current ?? null);
		}
	}, []);

	useEffect(() => {
		alive.current = true;
		void load();
		return () => { alive.current = false; };
	}, [load]);

	useEffect(() => {
		const timer = setInterval(() => { if (document.visibilityState !== "hidden") void load(); }, POLL_MS);
		return () => clearInterval(timer);
	}, [load]);

	const send = async (body: { op: string; id?: string }): Promise<Reply> => {
		setBusy(true);
		setNotice(null);
		let reply: Reply;
		try {
			const response = await fetch("/api/accounts", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
			reply = { ok: response.ok, data: (await response.json().catch(() => ({}))) as Record<string, unknown> };
		} catch {
			reply = { ok: false, data: { error: UNREACHABLE } };
		}
		if (!alive.current) return reply;
		setBusy(false);
		if (reply.ok && isView(reply.data.view)) { seq.current++; setView(reply.data.view); }
		return reply;
	};
	const failure = (reply: Reply): string => typeof reply.data.error === "string" && reply.data.error ? reply.data.error : GENERIC_ERROR;
	const cap = view?.cap ?? 0;

	const newInvite = async () => {
		const reply = await send({ op: "invite" });
		if (reply.ok && typeof reply.data.code === "string" && typeof reply.data.expiresAt === "number") {
			setCodeBox({ kind: "invite", code: reply.data.code, expiresAt: reply.data.expiresAt });
		} else if (reply.data.code === "full") {
			setNotice({ group: "invites", text: serverFullText(cap) });
			void load();
		} else setNotice({ group: "invites", text: failure(reply) });
	};

	const direct = async (op: "cancel-invite" | "resume" | "restore", id: string, group: Notice["group"]) => {
		const reply = await send({ op, id });
		if (reply.ok) return;
		if (op === "restore" && reply.data.code === "full") { setNotice({ group, text: restoreFullText(cap) }); void load(); }
		else setNotice({ group, text: failure(reply) });
	};

	const confirmed = async (box: Confirm) => {
		const reply = await send({ op: box.op, id: box.id });
		setConfirm(null);
		if (!reply.ok) { setNotice({ group: box.op === "delete-now" ? "removed" : "accounts", text: failure(reply) }); return; }
		if (box.op === "reset" && typeof reply.data.code === "string") setCodeBox({ kind: "reset", name: box.name, code: reply.data.code });
	};

	const pickFromMenu = (account: Account, item: "reset" | "pause" | "resume" | "remove") => {
		if (item === "resume") void direct("resume", account.id, "accounts");
		else setConfirm({ op: item, id: account.id, name: account.name });
	};

	/** One wrapper in every state, so the phone's group (account-accounts-group.tsx) keeps its element while the list loads. */
	const frame = (children: ReactNode) => <div data-testid="accounts-section" className={divided ? "mt-2 border-t border-border/60 pt-4" : undefined}>{children}</div>;
	if (view === undefined) return frame(<p className="text-xs text-muted-foreground/70" data-testid="accounts-loading">Loading…</p>);
	if (view === null) {
		return frame(
			<div className="flex flex-col items-start gap-2" data-testid="accounts-failed">
				<p role="alert" className="text-xs text-error">{GENERIC_ERROR}</p>
				<button type="button" className={buttonClass} onClick={() => void load()}>Try again</button>
			</div>,
		);
	}

	const now = Date.now();
	const full = view.used >= view.cap;
	const noticeFor = (group: Notice["group"]) => notice?.group === group ? <p role="alert" className="text-xs text-error" data-testid="accounts-error">{notice.text}</p> : null;
	const menuAccount = menu ? view.accounts.find((a) => a.id === menu) : undefined;
	const box = codeBox && (codeBox.kind === "invite" ? { ...inviteBox(codeBox.expiresAt), code: codeBox.code } : { ...resetCodeBox(codeBox.name), code: codeBox.code });

	return frame(
		<>
			<SettingsGroup label={ACCOUNTS_TEXT.group} testid="accounts-list">
				<ul className="flex max-w-md flex-col gap-1.5">
					{view.accounts.map((account) => (
						<li key={account.id} className="flex items-center justify-between gap-3" data-testid="accounts-row" data-account={account.id}>
							<span className="min-w-0 font-ui text-sm">
								<span className="block truncate text-foreground" data-testid="accounts-name">{account.name}</span>
								<span className="block text-xs text-muted-foreground" data-testid="accounts-status">{accountStatusText(account, now)}</span>
							</span>
							{account.role === "member" && (
								<button
									type="button"
									aria-label={`Menu for ${account.name}`}
									aria-haspopup="menu"
									aria-expanded={menu === account.id}
									data-testid="accounts-menu-button"
									disabled={busy}
									onClick={(event) => { menuAnchor.current = event.currentTarget; setMenu(menu === account.id ? null : account.id); }}
									className="flex size-8 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50 max-sm:size-10"
								>
									<MoreHorizontalIcon className="size-4" aria-hidden="true" />
								</button>
							)}
						</li>
					))}
				</ul>
				<p className="text-xs text-muted-foreground" data-testid="accounts-used">{usedText(view.used, view.cap)}</p>
				{noticeFor("accounts")}
			</SettingsGroup>

			<SettingsGroup label={ACCOUNTS_TEXT.invitesGroup} testid="accounts-invites">
				<button type="button" className={`${buttonClass} self-start`} disabled={busy || full} onClick={() => void newInvite()} data-testid="accounts-new-invite">{ACCOUNTS_TEXT.newInvite}</button>
				{full && <p className="text-xs text-muted-foreground" data-testid="accounts-full">{serverFullText(view.cap)}</p>}
				{view.invites.length > 0 && (
					<ul className="flex max-w-md flex-col gap-1.5">
						{view.invites.map((invite) => (
							<li key={invite.id} className="flex items-center justify-between gap-3" data-testid="accounts-invite">
								<span className="min-w-0 font-ui text-sm text-foreground">{inviteUntilText(invite.expiresAt)}</span>
								<button type="button" className={buttonClass} disabled={busy} onClick={() => void direct("cancel-invite", invite.id, "invites")} data-testid="accounts-cancel-invite">{ACCOUNTS_TEXT.cancelInvite}</button>
							</li>
						))}
					</ul>
				)}
				{noticeFor("invites")}
			</SettingsGroup>

			{view.removed.length > 0 && (
				<SettingsGroup label={ACCOUNTS_TEXT.removedGroup} testid="accounts-removed">
					<ul className="flex max-w-md flex-col gap-2">
						{view.removed.map((account) => (
							<li key={account.id} className="flex flex-col gap-1.5" data-testid="accounts-removed-row" data-account={account.id}>
								<span className="min-w-0 font-ui text-sm">
									<span className="block truncate text-foreground">{account.name}</span>
									<span className="block text-xs text-muted-foreground" data-testid="accounts-removed-line">{removedText(account.removedAt, account.deletedAt)}</span>
								</span>
								<div className="flex flex-wrap gap-2">
									<button type="button" className={buttonClass} disabled={busy} onClick={() => void direct("restore", account.id, "removed")} data-testid="accounts-restore">{ACCOUNTS_TEXT.restore}</button>
									<button type="button" className={buttonClass} disabled={busy} onClick={() => setConfirm({ op: "delete-now", id: account.id, name: account.name })} data-testid="accounts-delete-now">{ACCOUNTS_TEXT.deleteNow}</button>
								</div>
							</li>
						))}
					</ul>
					{noticeFor("removed")}
				</SettingsGroup>
			)}

			{menuAccount && <RowMenu anchorRef={menuAnchor} account={menuAccount} onPick={(item) => pickFromMenu(menuAccount, item)} onClose={() => setMenu(null)} />}
			{confirm && <ConfirmDialog text={confirmFor(confirm)} danger={isDanger(confirm.op)} busy={busy} onCancel={() => setConfirm(null)} onConfirm={() => void confirmed(confirm)} />}
			{box && <CodeDialog title={box.title} body={box.body} code={box.code} copy={box.copy} done={box.done} onDone={() => setCodeBox(null)} />}
		</>,
	);
}

/** `divided`: a divider above the first group, for the phone's group inside Account. */
export function AccountsSection({ divided = false }: { divided?: boolean }) {
	// The markers decide whether this shows; without them nothing is asked.
	if (!isServerMode() || !isOwnerMode()) return null;
	return <AccountsScreen divided={divided} />;
}
