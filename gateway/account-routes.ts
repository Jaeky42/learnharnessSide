/**
 * Each person's account lifecycle at the gateway (docs/multi-account-build.md
 * slices 3b and 5b): redeeming an invite, the reset page (a recovery code or
 * the owner's reset code), new recovery codes and Delete my account. The
 * shapes follow ./routes.ts; every sentence comes from
 * src/core/account-screens.ts or today's routes. Where no approved sentence
 * exists the answer carries a bare status and a `code`, and the screen shows
 * the app's generic line.
 */

import {
	createAccountSession,
	hasOwner,
	markUnpairPending,
	removeSession,
	replaceRecoveryCodes,
	reserveMember,
	resetPassword,
	resolveSession,
	selfDelete,
	type AccountRecord,
	type GatewayState,
	type InviteRecord,
} from "../src/core/accounts.ts";
import { INVITE_TEXT, RESET_PAGE_TEXT, tooManyAttempts } from "../src/core/account-screens.ts";
import { deviceLabel } from "../src/core/server-auth.ts";
import { copyOf, DAMAGED_TEXT, findSessionCookie, NO_STORE, SIGN_IN_FIRST } from "./gate.ts";
import type { Lifecycle } from "./lifecycle.ts";
import { htmlResponse, invitePageHtml, resetPageHtml } from "./pages.ts";
import {
	addressOf,
	CLEAR_SITE_CACHE,
	json,
	readBody,
	redirect,
	sameSiteRefusal,
	signedInCookies,
	signedOutCookies,
	type Handler,
	type RouteDeps,
	type RouteTable,
} from "./routes.ts";
import { StateDamagedError } from "./state.ts";

export interface AccountDeps extends RouteDeps {
	lifecycle: Lifecycle;
}

/** Today's answer to a wrong current password (src/server/server-auth.ts, ./routes.ts `passwordRoute`). */
export const WRONG_CURRENT_PASSWORD = "Your current password is wrong.";

const damaged = (): Response => json({ error: DAMAGED_TEXT }, 503);
const damagedPage = (): Response => new Response(DAMAGED_TEXT, { status: 503, headers: { ...NO_STORE, "Content-Type": "text/plain; charset=utf-8" } });
const locked = (waitMs: number | undefined): Response => json({ error: tooManyAttempts(waitMs ?? 0) }, 429);

async function guarded(run: () => Promise<Response>): Promise<Response> {
	try {
		return await run();
	} catch (error) {
		if (error instanceof StateDamagedError) return damaged();
		throw error;
	}
}

const keepIfChanged = (next: GatewayState, before: GatewayState): GatewayState | null => (next === before ? null : next);

const signedIn = (request: Request, state: GatewayState, deps: RouteDeps): boolean => {
	const found = resolveSession(state, findSessionCookie(request.headers.get("cookie")), deps.now());
	return !!found && copyOf(found.account, deps.config) !== null;
};

// ─── Pages ───────────────────────────────────────────────────────────────────

export const invitePage: Handler = async (request, deps) => {
	const read = deps.store.read();
	if (!read.ok) return damagedPage();
	if (!hasOwner(read.state)) return redirect(request, "/setup", deps.config);
	if (signedIn(request, read.state, deps)) return redirect(request, "/", deps.config);
	return htmlResponse(invitePageHtml());
};

export const resetPage: Handler = async (request, deps) => {
	const read = deps.store.read();
	if (!read.ok) return damagedPage();
	if (!hasOwner(read.state)) return redirect(request, "/setup", deps.config);
	return htmlResponse(resetPageHtml());
};

// ─── Redeeming an invite ─────────────────────────────────────────────────────

/**
 * POST {code, name, password}. Reserve (the rules: code, cap, name,
 * password), have the maker make the copy, then save it and sign in, in one
 * write. The four recovery codes are in this answer only. If the copy can't
 * be made the reservation is undone, its leftovers removed and the invite
 * given back; 503 with no sentence.
 */
export const inviteRoute: Handler<AccountDeps> = (request, deps) => guarded(async () => {
	const refused = sameSiteRefusal(request);
	if (refused) return refused;
	const body = await readBody(request);
	if (!body) return json({ error: "Expected JSON." }, 400);
	// No maker: a copy can be neither made nor cleaned up; nothing is reserved.
	if (!deps.config.makerUrl || !deps.config.makerToken) return json({ code: "unavailable" }, 503);
	const now = deps.now();
	const address = addressOf(request, deps.config);
	const label = deviceLabel(request.headers.get("user-agent"));
	const previous = findSessionCookie(request.headers.get("cookie"));

	type Reserved = { ok: true; account: AccountRecord; codes: string[]; invite: InviteRecord } | { ok: false; response: Response };
	const reserved = deps.store.update<Reserved>((state) => {
		const r = reserveMember(state, { code: body.code, name: body.name, password: body.password }, deps.config.maxAccounts, address, now);
		if (r.ok) return { state: r.state, result: { ok: true, account: r.account, codes: r.codes, invite: r.invite } };
		const keep = keepIfChanged(r.state, state);
		switch (r.code) {
			case "locked": return { state: keep, result: { ok: false, response: locked(r.waitMs) } };
			case "invite-invalid": return { state: keep, result: { ok: false, response: json({ error: INVITE_TEXT.invalid }, 401) } };
			case "full": return { state: keep, result: { ok: false, response: json({ error: INVITE_TEXT.full }, 409) } };
			case "taken": return { state: keep, result: { ok: false, response: json({ error: INVITE_TEXT.taken }, 400) } };
			case "reserved": return { state: keep, result: { ok: false, response: json({ error: INVITE_TEXT.reserved }, 400) } };
			case "not-allowed": return { state: keep, result: { ok: false, response: json({ error: INVITE_TEXT.notAllowed }, 400) } };
			case "password-problem": return { state: keep, result: { ok: false, response: json({ error: r.message ?? "Enter a password." }, 400) } };
		}
	});
	if (!reserved.ok) return reserved.response;

	const made = await deps.lifecycle.makeReservedCopy(reserved.account.id, (state) => {
		const created = createAccountSession(state, reserved.account.id, label, now);
		// One browser holds one account: a session it had goes.
		const old = resolveSession(created.state, previous, now);
		const withoutOld = old && old.session.id !== created.session.id ? removeSession(created.state, old.session.id) : created.state;
		const next: GatewayState = { ...withoutOld, accounts: withoutOld.accounts.map((a) => a.id === reserved.account.id ? { ...a, lastSeenAt: now } : a) };
		return { state: next, result: created.token };
	});
	if (made.ok) {
		return json({ codes: reserved.codes }, 200, signedInCookies(made.result, reserved.account), CLEAR_SITE_CACHE);
	}
	// The invite works again (the slot it took is free: the account is erased or `deleting`).
	deps.store.update((state) => {
		if (state.invites.some((i) => i.id === reserved.invite.id) || reserved.invite.expiresAt <= deps.now()) return { state: null, result: undefined };
		return { state: { ...state, invites: [...state.invites, reserved.invite] }, result: undefined };
	});
	return json({ code: "unavailable" }, 503);
});

// ─── The reset page ──────────────────────────────────────────────────────────

/**
 * POST {name, code, password}: a recovery code or the owner's reset code.
 * Every session of the account ends and its desktop apps are unpaired. Not
 * signed in afterwards: the page goes to the sign-in page.
 */
export const resetRoute: Handler = (request, deps) => guarded(async () => {
	const refused = sameSiteRefusal(request);
	if (refused) return refused;
	const body = await readBody(request);
	if (!body) return json({ error: "Expected JSON." }, 400);
	const now = deps.now();
	const address = addressOf(request, deps.config);
	type Done = { ok: true; accountId: string } | { ok: false; response: Response };
	const done = deps.store.update<Done>((state) => {
		const r = resetPassword(state, { name: body.name, code: body.code, password: body.password }, address, now);
		if (r.ok) return { state: markUnpairPending(r.state, r.account.id), result: { ok: true, accountId: r.account.id } };
		const keep = keepIfChanged(r.state, state);
		switch (r.code) {
			case "locked": return { state: keep, result: { ok: false, response: locked(r.waitMs) } };
			case "reset-invalid": return { state: keep, result: { ok: false, response: json({ error: RESET_PAGE_TEXT.invalid }, 401) } };
			case "password-problem": return { state: keep, result: { ok: false, response: json({ error: r.message ?? "Enter a password." }, 400) } };
		}
	});
	if (!done.ok) return done.response;
	await deps.unpairer.attempt(done.accountId);
	return json({ ok: true }, 200, [], CLEAR_SITE_CACHE);
});

// ─── Signed in: recovery codes and Delete my account ─────────────────────────

/** POST {password}: four new codes, once. A wrong password answers as the password route's wrong current password. */
export const recoveryCodesRoute: Handler = (request, deps) => guarded(async () => {
	const refused = sameSiteRefusal(request);
	if (refused) return refused;
	const body = await readBody(request);
	if (!body) return json({ error: "Expected JSON." }, 400);
	const now = deps.now();
	const address = addressOf(request, deps.config);
	const token = findSessionCookie(request.headers.get("cookie"));
	return deps.store.update<Response>((state) => {
		const found = resolveSession(state, token, now);
		if (!found) return { state: null, result: json({ error: SIGN_IN_FIRST }, 401) };
		const r = replaceRecoveryCodes(state, found.account.id, body.password, address, now);
		if (r.ok) return { state: r.state, result: json({ codes: r.codes, recoveryCodesLeft: r.codes.length }) };
		const keep = keepIfChanged(r.state, state);
		switch (r.code) {
			case "locked": return { state: keep, result: locked(r.waitMs) };
			case "wrong-password": return { state: keep, result: json({ error: WRONG_CURRENT_PASSWORD }, 401) };
			case "not-found": return { state: keep, result: json({ error: SIGN_IN_FIRST }, 401) };
		}
	});
});

/**
 * POST {password}: Delete my account, at once and for good. The account is
 * marked `deleting` and signed out everywhere in one write, the answer goes
 * back with the cookies cleared, and the copy and its volume are removed in
 * the background, the record erased last. If the maker can't finish, the
 * account stays `deleting` (no sign-in, no slot, sync 401 not_paired) and the
 * lifecycle loop finishes it. The owner's account can't be deleted this way.
 */
export const deleteAccountRoute: Handler<AccountDeps> = (request, deps) => guarded(async () => {
	const refused = sameSiteRefusal(request);
	if (refused) return refused;
	const body = await readBody(request);
	if (!body) return json({ error: "Expected JSON." }, 400);
	const now = deps.now();
	const address = addressOf(request, deps.config);
	const token = findSessionCookie(request.headers.get("cookie"));
	type Done = { ok: true; accountId: string } | { ok: false; response: Response };
	const done = deps.store.update<Done>((state) => {
		const found = resolveSession(state, token, now);
		if (!found) return { state: null, result: { ok: false, response: json({ error: SIGN_IN_FIRST }, 401) } };
		const r = selfDelete(state, found.account.id, body.password, address, now);
		if (r.ok) return { state: r.state, result: { ok: true, accountId: r.account.id } };
		const keep = keepIfChanged(r.state, state);
		switch (r.code) {
			case "locked": return { state: keep, result: { ok: false, response: locked(r.waitMs) } };
			case "wrong-password": return { state: keep, result: { ok: false, response: json({ error: WRONG_CURRENT_PASSWORD }, 401) } };
			case "is-owner": return { state: keep, result: { ok: false, response: json({ code: "is-owner" }, 409) } };
			case "not-found":
			case "bad-state": return { state: keep, result: { ok: false, response: json({ error: SIGN_IN_FIRST }, 401) } };
		}
	});
	if (!done.ok) return done.response;
	deps.lifecycle.deleteSoon(done.accountId);
	return json({ ok: true }, 200, signedOutCookies(), CLEAR_SITE_CACHE);
});

export const ACCOUNT_ROUTES: RouteTable<AccountDeps> = {
	"/invite": { GET: invitePage },
	"/reset": { GET: resetPage },
	"/api/server-auth/invite": { POST: inviteRoute },
	"/api/server-auth/reset": { POST: resetRoute },
	"/api/server-auth/recovery-codes": { POST: recoveryCodesRoute },
	"/api/server-auth/delete-account": { POST: deleteAccountRoute },
};
