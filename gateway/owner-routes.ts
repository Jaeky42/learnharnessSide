/**
 * Settings → Accounts at the gateway (docs/fork/plans/multi-account-build.md slice 4):
 * GET /api/accounts (the list) and POST /api/accounts {op, id?}. The owner
 * only, decided here from the session's account role (the `lh_owner` marker
 * cookie only decides what the page shows): anyone else, signed in or not,
 * gets the plain 404 an unknown path gets.
 *
 * Every refusal carries a `code`; only the two "full" answers carry an
 * approved sentence. The rules refuse acting on the owner's own account.
 */

import {
	accountsView,
	cancelInvite,
	createInvite,
	issueResetCode,
	resolveSession,
	type GatewayState,
} from "../src/core/accounts.ts";
import { serverFullText } from "../src/core/account-screens.ts";
import type { AccountDeps } from "./account-routes.ts";
import { DAMAGED_TEXT, findSessionCookie } from "./gate.ts";
import type { OpResult } from "./lifecycle.ts";
import { json, notFound, readBody, sameSiteRefusal, type Handler, type RouteTable } from "./routes.ts";
import { StateDamagedError } from "./state.ts";

const OPS = new Set(["invite", "cancel-invite", "reset", "pause", "resume", "remove", "restore", "delete-now"]);

const isOwner = (request: Request, state: GatewayState, now: number): boolean =>
	resolveSession(state, findSessionCookie(request.headers.get("cookie")), now)?.account.role === "owner";

const refusal = (code: string): Response => json({ code }, code === "not-found" ? 404 : 409);

function view(deps: AccountDeps): ReturnType<typeof accountsView> {
	const read = deps.store.read();
	if (!read.ok) throw new StateDamagedError();
	return accountsView(read.state, deps.config.maxAccounts, deps.now());
}

const opAnswer = (result: OpResult, deps: AccountDeps): Response => {
	if (result.ok) return json({ view: view(deps) });
	return json(result.error ? { error: result.error, code: result.code } : { code: result.code }, result.status);
};

export const accountsListRoute: Handler<AccountDeps> = async (request, deps) => {
	const read = deps.store.read();
	if (!read.ok) return json({ error: DAMAGED_TEXT }, 503);
	const now = deps.now();
	if (!isOwner(request, read.state, now)) return notFound();
	return json(accountsView(read.state, deps.config.maxAccounts, now));
};

export const accountsOpRoute: Handler<AccountDeps> = async (request, deps) => {
	try {
		const read = deps.store.read();
		if (!read.ok) return json({ error: DAMAGED_TEXT }, 503);
		if (!isOwner(request, read.state, deps.now())) return notFound();
		const refused = sameSiteRefusal(request);
		if (refused) return refused;
		const body = await readBody(request);
		if (!body) return json({ code: "bad_request" }, 400);
		const op = typeof body.op === "string" ? body.op : "";
		if (!OPS.has(op)) return json({ code: "bad_op" }, 400);
		const cap = deps.config.maxAccounts;
		if (op === "invite") {
			const made = deps.store.update((state) => {
				const r = createInvite(state, cap, deps.now());
				return { state: r.ok ? r.state : null, result: r };
			});
			if (!made.ok) return json({ error: serverFullText(cap), code: "full" }, 409);
			return json({ code: made.code, expiresAt: made.invite.expiresAt, view: view(deps) });
		}
		const id = typeof body.id === "string" && body.id.length > 0 && body.id.length <= 64 ? body.id : null;
		if (id === null) return json({ code: "bad_request" }, 400);
		switch (op) {
			case "cancel-invite": {
				const r = deps.store.update((state) => {
					const c = cancelInvite(state, id);
					return { state: c.ok ? c.state : null, result: c.ok };
				});
				return r ? json({ view: view(deps) }) : refusal("not-found");
			}
			case "reset": {
				// Under the account's lock, so a reset code can't land between a remove's steps.
				const r = await deps.lifecycle.serial(id, async () => deps.store.update((state) => {
					const issued = issueResetCode(state, id, deps.now());
					return { state: issued.ok ? issued.state : null, result: issued };
				}));
				if (!r.ok) return refusal(r.code);
				return json({ code: r.code, expiresAt: r.expiresAt, view: view(deps) });
			}
			case "pause": return opAnswer(await deps.lifecycle.pause(id), deps);
			case "resume": return opAnswer(await deps.lifecycle.resume(id), deps);
			case "remove": return opAnswer(await deps.lifecycle.remove(id), deps);
			case "restore": return opAnswer(await deps.lifecycle.restore(id), deps);
			case "delete-now": return opAnswer(await deps.lifecycle.deleteNow(id), deps);
		}
		return json({ code: "bad_op" }, 400);
	} catch (error) {
		if (error instanceof StateDamagedError) return json({ error: DAMAGED_TEXT }, 503);
		throw error;
	}
};

export const OWNER_ROUTES: RouteTable<AccountDeps> = {
	"/api/accounts": { GET: accountsListRoute, POST: accountsOpRoute },
};
