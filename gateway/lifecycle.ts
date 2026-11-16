/**
 * Accounts and their copies over time (docs/multi-account-build.md slices 3b,
 * 4 and 5b): the owner's Pause, Resume, Remove, Restore and Delete now, the
 * copy made for a redeemed invite, deletions (the owner's, the 30 days, and
 * Delete my account), and one loop that keeps copies in step with accounts.
 *
 * Rules every step keeps:
 *   - One account's steps run one at a time (`serial`): an owner's action, a
 *     redeem and the loop never interleave on the same account.
 *   - A state change that must survive a crash is written BEFORE the maker is
 *     asked (an account is `deleting` before its copy and volume are removed;
 *     `copyPending` before a copy is (re)created), and the record is erased
 *     only after the maker confirmed the volume is gone.
 *   - A maker that doesn't answer (a timeout, a 5xx, an update under way)
 *     means "try again later", never "the copy doesn't exist". After a
 *     POST /copies without an answer a container may run with a secret the
 *     gateway never got, so the account keeps `copyPending` and the copy is
 *     made again (a fresh secret) before it is trusted.
 *   - A tag missing from GET /copies once is not acted on: the maker briefly
 *     hides a copy while it swaps it onto a new container. Only an absence
 *     seen in two passes in a row leads to a POST /copies.
 *   - A copy whose tag belongs to no account is left alone (logged once).
 *   - A NEW account's copy is asked for with `fresh: true` (the maker makes
 *     nothing when that tag's volume or container exists, e.g. after a lost
 *     state file); on that refusal another tag is tried. An abandoned
 *     reservation's container is removed but its volume kept: whether the
 *     volume was this attempt's own can't be known.
 *   - Only a member's own `lh-acct-<tag>:3000` is ever saved as its upstream.
 *   - Pause and Remove end the browser sessions and stop or remove the copy;
 *     they never unpair (the PC gets 503, keeps its key, carries on after
 *     Resume or Restore).
 *   - Log lines name an account's id or tag and the step; never a secret,
 *     code, password or token.
 */

import {
	abandonReservation,
	deleteDue,
	deleteNow as markDeleteNow,
	dueForDeletion,
	eraseAccount,
	findAccount,
	isReady,
	markCopyPending,
	memberUpstream,
	pauseAccount,
	pendingDeletions,
	removeAccount,
	restoreAccount,
	resumeAccount,
	retagReservation,
	rollbackReservation,
	saveCopy,
	unfinishedReservations,
	type AccountRecord,
	type GatewayState,
} from "../src/core/accounts.ts";
import { restoreFullText } from "../src/core/account-screens.ts";
import type { GatewayConfig } from "./config.ts";
import type { Unpairer } from "./copies.ts";
import { MakerRefused, MakerUnavailable, TagTaken, type CopySummary, type MakerClient } from "./maker-client.ts";
import type { GatewayStore } from "./state.ts";

/** The loop's rhythm. */
export const LIFECYCLE_INTERVAL_MS = 5 * 60_000;
/** A reservation with no copy after this long was cut off (a crash); it is undone. */
export const RESERVATION_STALE_MS = 2 * 60_000;
/** After a failure or an absence, the loop looks again this soon (only while it runs on its timer). */
export const FOLLOW_UP_MS = 30_000;
/** A new account tries at most this many tags whose volume turns out to exist. */
export const MAX_TAG_TRIES = 5;

/** The maker's answer is for this tag's copy, or it is not saved. */
class WrongUpstream extends Error {}

/**
 * A remake asked for an account with no copy yet (a reservation): never
 * without `fresh`, so never at all; only makeReservedCopy makes its copy.
 */
export class NotReady extends Error {
	constructor() { super("Remake refused: the account has no copy yet."); }
}

export type OpResult = { ok: true } | { ok: false; status: number; code: string; error?: string };

export interface LifecycleDeps {
	store: GatewayStore;
	maker: MakerClient;
	unpairer: Unpairer;
	config: Pick<GatewayConfig, "maxAccounts">;
	now: () => number;
	log: (line: string) => void;
}

export interface PassReport {
	/** Steps that changed something, e.g. "create ABC", "erase acct_x". */
	done: string[];
	/** Steps that failed and will be tried again. */
	failed: string[];
}

export interface Lifecycle {
	/** Runs `fn` after every earlier step of this account has finished. */
	serial<T>(accountId: string, fn: () => Promise<T>): Promise<T>;
	pause(accountId: string): Promise<OpResult>;
	resume(accountId: string): Promise<OpResult>;
	remove(accountId: string): Promise<OpResult>;
	restore(accountId: string): Promise<OpResult>;
	deleteNow(accountId: string): Promise<OpResult>;
	/**
	 * A redeemed invite's copy. `finish` runs in the same write that saves the
	 * copy (signing the person in). On failure the reservation is abandoned
	 * and its leftovers removed (`cleaned`: the record is erased too).
	 */
	makeReservedCopy<T>(accountId: string, finish: (state: GatewayState, copy: { upstream: string; gateSecret: string }) => { state: GatewayState; result: T }): Promise<{ ok: true; result: T } | { ok: false; cleaned: boolean }>;
	/** Finishes a `deleting` account in the background (Delete my account). */
	deleteSoon(accountId: string): void;
	/** One pass of the loop (one at a time; a second call joins the running one). */
	pass(): Promise<PassReport>;
	/** A pass now and every `intervalMs`; returns a stop function. */
	start(intervalMs?: number): () => void;
	/** Resolves once every queued step has finished (tests). */
	idle(): Promise<void>;
}

const isMakerTrouble = (error: unknown): boolean => error instanceof MakerUnavailable || error instanceof MakerRefused || error instanceof TagTaken || error instanceof WrongUpstream;

function checked(tag: string, copy: { upstream: string; gateSecret: string }): { upstream: string; gateSecret: string } {
	if (copy.upstream !== memberUpstream(tag)) throw new WrongUpstream();
	return copy;
}
const running = (summary: CopySummary): boolean => summary.state === "running" || summary.state === "restarting";

/** What a pass compares before acting on what it saw earlier. */
const fingerprint = (a: AccountRecord | null): string => a ? `${a.state}|${a.upstream ?? ""}|${a.gateSecret ?? ""}|${a.copyPending ? 1 : 0}` : "gone";

export function createLifecycle(deps: LifecycleDeps): Lifecycle {
	const { store, maker, unpairer, log } = deps;
	const tails = new Map<string, Promise<unknown>>();
	const inFlight = new Set<Promise<unknown>>();
	const complained = new Set<string>();
	const unknownTags = new Set<string>();
	let missingLastPass = new Set<string>();
	let passRunning: Promise<PassReport> | null = null;
	let timerStarted = false;
	let followUp: ReturnType<typeof setTimeout> | null = null;

	const say = (key: string, line: string): void => {
		if (complained.has(key)) return;
		complained.add(key);
		log(`[LearnHarness gateway] ${line}`);
	};
	const fixed = (key: string): void => { complained.delete(key); };

	const track = <T>(promise: Promise<T>): Promise<T> => {
		inFlight.add(promise);
		void promise.finally(() => inFlight.delete(promise)).catch(() => undefined);
		return promise;
	};

	function serial<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
		const previous = tails.get(accountId) ?? Promise.resolve();
		const run = previous.then(fn, fn);
		const tail = run.then(() => undefined, () => undefined);
		tails.set(accountId, tail);
		void tail.then(() => { if (tails.get(accountId) === tail) tails.delete(accountId); });
		track(tail);
		return run;
	}

	const read = (): GatewayState | null => {
		const r = store.read();
		return r.ok ? r.state : null;
	};
	const account = (id: string): AccountRecord | null => {
		const state = read();
		return state ? findAccount(state, id) : null;
	};

	function scheduleFollowUp(): void {
		if (!timerStarted || followUp) return;
		followUp = setTimeout(() => { followUp = null; void pass(); }, FOLLOW_UP_MS);
		followUp.unref?.();
	}

	const refusal = (code: string): OpResult => ({ ok: false, status: code === "not-found" ? 404 : 409, code });
	const unavailable = (): OpResult => ({ ok: false, status: 503, code: "maker_unavailable" });

	/**
	 * (Re)creates an existing account's copy: `copyPending` first, then the
	 * maker, then the new upstream and secret. A call without an answer is
	 * asked once more (the maker re-creates an existing name with a fresh
	 * secret); if that fails too the mark stays for the loop. Caller holds the lock.
	 */
	async function remake(accountId: string, tag: string, start: boolean): Promise<boolean> {
		const target = account(accountId);
		if (!target || !isReady(target) || target.tag !== tag) throw new NotReady();
		store.update((state) => ({ state: markCopyPending(state, accountId), result: undefined }));
		for (let attempt = 0; attempt < 2; attempt += 1) {
			try {
				const copy = checked(tag, await maker.createCopy(tag, { start }));
				store.update((state) => ({ state: findAccount(state, accountId) ? saveCopy(state, accountId, copy) : null, result: undefined }));
				fixed(`create:${accountId}`);
				return true;
			} catch (error) {
				if (!isMakerTrouble(error)) throw error;
			}
		}
		say(`create:${accountId}`, `Account ${accountId}: its copy couldn't be made; trying again later.`);
		scheduleFollowUp();
		return false;
	}

	/**
	 * A `deleting` account: container and network, then the volume, then the
	 * record. "later" when the maker couldn't finish (the account stays
	 * `deleting`); never erased while its volume might exist. Caller holds the lock.
	 */
	async function finishDeletion(accountId: string): Promise<"done" | "later" | "skip"> {
		const target = account(accountId);
		if (!target || target.state !== "deleting" || target.role === "owner") return "skip";
		if (target.tag) {
			try {
				await maker.removeCopy(target.tag);
				// A member that never had a copy keeps its volume: it may be an older account's (a lost state file).
				const keepVolume = target.keepVolume === true || !isReady(target);
				if (!keepVolume && await maker.removeVolume(target.tag) === "in-use") {
					say(`delete:${accountId}`, `Account ${accountId}: its data volume is still in use; deleting it later.`);
					scheduleFollowUp();
					return "later";
				}
			} catch (error) {
				if (!isMakerTrouble(error)) throw error;
				say(`delete:${accountId}`, `Account ${accountId}: its copy couldn't be deleted yet; trying again later.`);
				scheduleFollowUp();
				return "later";
			}
		}
		store.update((state) => ({ state: findAccount(state, accountId)?.state === "deleting" ? eraseAccount(state, accountId) : null, result: undefined }));
		fixed(`delete:${accountId}`);
		return "done";
	}

	const pause = (accountId: string): Promise<OpResult> => serial(accountId, async () => {
		const paused = store.update((state) => {
			const p = pauseAccount(state, accountId);
			return { state: p.ok ? p.state : null, result: p };
		});
		if (!paused.ok) return refusal(paused.code);
		if (paused.account.tag) {
			try {
				await maker.stopCopy(paused.account.tag);
				fixed(`stop:${accountId}`);
			} catch (error) {
				if (!isMakerTrouble(error)) throw error;
				say(`stop:${accountId}`, `Account ${accountId}: its copy couldn't be stopped yet; trying again later.`);
				scheduleFollowUp();
			}
		}
		return { ok: true };
	});

	const resume = (accountId: string): Promise<OpResult> => serial(accountId, async () => {
		const state = read();
		if (!state) return unavailable();
		const check = resumeAccount(state, accountId);
		if (!check.ok) return refusal(check.code);
		const tag = check.account.tag;
		if (!tag) return refusal("bad-state");
		// The copy first: an account that can't be started stays paused.
		if (check.account.copyPending) {
			if (!await remake(accountId, tag, true)) return unavailable();
		} else {
			let started: "ok" | "missing";
			try {
				started = await maker.startCopy(tag);
			} catch (error) {
				if (!isMakerTrouble(error)) throw error;
				return unavailable();
			}
			if (started === "missing" && !await remake(accountId, tag, true)) return unavailable();
		}
		const resumed = store.update((s) => {
			const r = resumeAccount(s, accountId);
			return { state: r.ok ? r.state : null, result: r.ok };
		});
		if (!resumed) return refusal("bad-state");
		if (account(accountId)?.unpairPending) void unpairer.attempt(accountId);
		return { ok: true };
	});

	const remove = (accountId: string): Promise<OpResult> => serial(accountId, async () => {
		const removed = store.update((state) => {
			const r = removeAccount(state, accountId, deps.now());
			return { state: r.ok ? r.state : null, result: r };
		});
		if (!removed.ok) return refusal(removed.code);
		if (removed.account.tag) {
			try {
				await maker.removeCopy(removed.account.tag);
				fixed(`remove:${accountId}`);
			} catch (error) {
				if (!isMakerTrouble(error)) throw error;
				say(`remove:${accountId}`, `Account ${accountId}: its copy couldn't be removed yet; trying again later.`);
				scheduleFollowUp();
			}
		}
		return { ok: true };
	});

	const restore = (accountId: string): Promise<OpResult> => serial(accountId, async () => {
		const cap = deps.config.maxAccounts;
		// The slot is taken in the same write as the check, so two restores can't both get the last one.
		const restored = store.update((state) => {
			const r = restoreAccount(state, accountId, cap);
			return { state: r.ok ? markCopyPending(r.state, accountId) : null, result: r };
		});
		if (!restored.ok) {
			return restored.code === "full" ? { ok: false, status: 409, code: "full", error: restoreFullText(cap) } : refusal(restored.code);
		}
		if (restored.account.tag) await remake(accountId, restored.account.tag, true);
		return { ok: true };
	});

	const deleteNow = (accountId: string): Promise<OpResult> => serial(accountId, async () => {
		const marked = store.update((state) => {
			const d = markDeleteNow(state, accountId);
			return { state: d.ok ? d.state : null, result: d };
		});
		if (!marked.ok) return refusal(marked.code);
		await finishDeletion(accountId);
		return { ok: true };
	});

	function makeReservedCopy<T>(accountId: string, finish: (state: GatewayState, copy: { upstream: string; gateSecret: string }) => { state: GatewayState; result: T }): Promise<{ ok: true; result: T } | { ok: false; cleaned: boolean }> {
		return serial(accountId, async () => {
			const first = account(accountId);
			if (!first || !first.tag || isReady(first) || first.state !== "active") return { ok: false as const, cleaned: false };
			// Tags whose volume exists (a lost state file) are avoided up front; best effort,
			// `fresh: true` is the maker's authoritative check.
			let avoid = new Set<string>();
			try { avoid = new Set(await maker.listVolumes()); } catch (error) { if (!isMakerTrouble(error)) throw error; }
			const retag = (): string | null => store.update((state) => {
				const r = retagReservation(state, accountId, avoid);
				return { state: r ? r.state : null, result: r ? r.tag : null };
			});
			let tag: string | null = avoid.has(first.tag) ? retag() : first.tag;
			/** A create whose outcome isn't known (no answer, or made but not saved). */
			let unknown = false;
			for (let tries = 0; tag !== null && tries < MAX_TAG_TRIES; tries += 1) {
				const tried: string = tag;
				try {
					const copy = checked(tried, await maker.createCopy(tried, { fresh: true }));
					const result = store.update((state) => {
						const current = findAccount(state, accountId);
						if (!current || current.state !== "active" || current.tag !== tried) return { state: null, result: null };
						const done = finish(saveCopy(state, accountId, copy), copy);
						return { state: done.state, result: { value: done.result } };
					});
					if (result) return { ok: true as const, result: result.value };
					unknown = true;
					break;
				} catch (error) {
					if (!(error instanceof TagTaken)) {
						if (!isMakerTrouble(error)) throw error;
						unknown = true;
						break;
					}
					// Nothing was made under that tag; it isn't this attempt's to clean up.
					avoid.add(tried);
					tag = retag();
					if (tag === null) break;
					continue;
				}
			}
			if (!unknown) {
				// Every tag tried was refused before anything was made: just undo the reservation.
				store.update((state) => ({ state: rollbackReservation(state, accountId), result: undefined }));
				return { ok: false as const, cleaned: true };
			}
			// The outcome under the current tag is unknown: its container goes, its volume stays.
			store.update((state) => {
				const a = abandonReservation(state, accountId);
				return { state: a.ok ? a.state : null, result: undefined };
			});
			return { ok: false as const, cleaned: await finishDeletion(accountId) === "done" };
		});
	}

	function deleteSoon(accountId: string): void {
		void serial(accountId, () => finishDeletion(accountId)).catch(() => undefined);
	}

	// ─── The loop ────────────────────────────────────────────────────────────

	async function step(report: PassReport, name: string, accountId: string, fn: () => Promise<boolean | null>): Promise<void> {
		try {
			const outcome = await serial(accountId, fn);
			if (outcome === true) report.done.push(name);
			else if (outcome === false) report.failed.push(name);
		} catch (error) {
			report.failed.push(name);
			if (!isMakerTrouble(error)) say(`step:${name}`, `The step "${name}" failed; trying again later.`);
		}
	}

	async function runPass(): Promise<PassReport> {
		const report: PassReport = { done: [], failed: [] };
		const first = read();
		if (!first) return report;
		const now = deps.now();

		// 1. Reservations cut off before their copy was made.
		for (const a of unfinishedReservations(first)) {
			if (now - a.createdAt < RESERVATION_STALE_MS) continue;
			await step(report, `abandon ${a.id}`, a.id, async () => {
				const current = account(a.id);
				if (!current || isReady(current) || current.state === "deleting") return null;
				store.update((state) => {
					const r = abandonReservation(state, a.id);
					return { state: r.ok ? r.state : null, result: undefined };
				});
				return await finishDeletion(a.id) === "done";
			});
		}

		// 2. Deletions that didn't finish.
		const afterAbandon = read() ?? first;
		for (const a of pendingDeletions(afterAbandon)) {
			await step(report, `erase ${a.id}`, a.id, async () => {
				const outcome = await finishDeletion(a.id);
				return outcome === "skip" ? null : outcome === "done";
			});
		}

		// 3. Removed accounts whose 30 days are over.
		for (const a of dueForDeletion(read() ?? first, now)) {
			await step(report, `erase ${a.id}`, a.id, async () => {
				const marked = store.update((state) => {
					const d = deleteDue(state, a.id, deps.now());
					return { state: d.ok ? d.state : null, result: d.ok };
				});
				if (!marked) return null;
				return await finishDeletion(a.id) === "done";
			});
		}

		// 4. Copies against accounts.
		let copies: CopySummary[] | null = null;
		try {
			copies = await maker.listCopies();
			fixed("list");
		} catch (error) {
			if (!isMakerTrouble(error)) throw error;
			say("list", "The maker couldn't list the copies; trying again later.");
			report.failed.push("list");
			scheduleFollowUp();
		}
		if (copies) await reconcile(report, copies);

		// 5. Desktop apps still to be unpaired.
		try { await unpairer.retryPending(); } catch { /* the unpairer logs its own */ }
		return report;
	}

	async function reconcile(report: PassReport, copies: CopySummary[]): Promise<void> {
		const state = read();
		if (!state) return;
		const byTag = new Map(copies.map((c) => [c.tag, c]));
		const missingNow = new Set<string>();
		const known = new Set(state.accounts.map((a) => a.tag).filter((t): t is string => t !== null));

		for (const seen of state.accounts) {
			if (seen.role === "owner" || !seen.tag) continue;
			const tag = seen.tag;
			const listed = byTag.get(tag) ?? null;
			const print = fingerprint(seen);
			// Acts only if the account is still as this pass saw it.
			const unchanged = (): AccountRecord | null => {
				const current = account(seen.id);
				return fingerprint(current) === print ? current : null;
			};

			if (seen.state === "removed" || seen.state === "deleting") {
				if (!listed) continue;
				await step(report, `remove ${tag}`, seen.id, async () => {
					if (!unchanged()) return null;
					await maker.removeCopy(tag);
					return true;
				});
				continue;
			}
			// A reservation still being made (or cut off: step 1).
			if (!isReady(seen)) continue;
			const wantRunning = seen.state === "active";

			if (seen.copyPending) {
				await step(report, `create ${tag}`, seen.id, async () => {
					if (!unchanged()) return null;
					return remake(seen.id, tag, wantRunning);
				});
				continue;
			}
			if (!listed) {
				if (!missingLastPass.has(tag)) {
					missingNow.add(tag);
					scheduleFollowUp();
					continue;
				}
				await step(report, `create ${tag}`, seen.id, async () => {
					if (!unchanged()) return null;
					return remake(seen.id, tag, wantRunning);
				});
				continue;
			}
			if (wantRunning && !running(listed)) {
				await step(report, `start ${tag}`, seen.id, async () => {
					if (!unchanged()) return null;
					if (await maker.startCopy(tag) === "missing") {
						missingNow.add(tag);
						return null;
					}
					if (account(seen.id)?.unpairPending) void unpairer.attempt(seen.id);
					return true;
				});
			} else if (!wantRunning && running(listed)) {
				await step(report, `stop ${tag}`, seen.id, async () => {
					if (!unchanged()) return null;
					await maker.stopCopy(tag);
					return true;
				});
			}
		}

		for (const copy of copies) {
			if (known.has(copy.tag) || unknownTags.has(copy.tag)) continue;
			unknownTags.add(copy.tag);
			log(`[LearnHarness gateway] The copy ${copy.tag} belongs to no account; it is left as it is.`);
		}
		missingLastPass = missingNow;
	}

	function pass(): Promise<PassReport> {
		if (passRunning) return passRunning;
		passRunning = track(runPass().catch(() => ({ done: [], failed: ["pass"] } as PassReport)).finally(() => { passRunning = null; }));
		return passRunning;
	}

	return {
		serial, pause, resume, remove, restore, deleteNow, makeReservedCopy, deleteSoon, pass,
		start(intervalMs = LIFECYCLE_INTERVAL_MS) {
			timerStarted = true;
			void pass();
			const timer = setInterval(() => { void pass(); }, intervalMs);
			timer.unref?.();
			return () => {
				timerStarted = false;
				clearInterval(timer);
				if (followUp) { clearTimeout(followUp); followUp = null; }
			};
		},
		async idle() {
			while (inFlight.size) await Promise.allSettled([...inFlight]);
		},
	};
}
