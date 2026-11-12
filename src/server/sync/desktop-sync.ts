/**
 * Cloud sync (Phase 5, docs/cloud-sync.md): the DESKTOP's side of session
 * sync. One call to tick() is one round with the server:
 *
 *   1. ask what changed since last time, and bring those sessions here;
 *   2. send the sessions this desktop holds that changed since they were
 *      last sent, and the new ones it created;
 *   3. tell the server about sessions deleted here.
 *
 * The first round is the first sync: the backup is made, every session
 * here goes up (held by this desktop) and every session there comes down
 * (held by whoever holds it there). Pairing never deletes anything.
 *
 * A session held by another device is read-only here (holds() is false):
 * its files are only ever replaced by what the server sends.
 *
 * A chat file in a newer format than this build reads (chatFileTooNew: a
 * newer build wrote it, and this one was installed over it) is never sent,
 * handed over or replaced by a discard here. It is left as it is.
 */

import { bundleDigest, chatFileTooNew, checkBundle, NEWER_FORMAT_CODE, type SessionBundle, type SessionChange } from "../../core/sync/sessions.ts";
import { picturesOnce } from "./pictures-transport.ts";
import type { SessionFiles } from "../../store/sync/session-files.ts";
import type { StateFile } from "../../store/sync/state-file.ts";
import type { LocalWork } from "./authority.ts";
import type { SyncReply } from "./client.ts";

export interface DesktopSession {
	/** This desktop holds the session. */
	mine: boolean;
	holder: string;
	holderName: string | null;
	/** The server's version these files correspond to. */
	serverVersion: number;
	/** The files as they were when last sent or fetched. */
	stamp: string | null;
	digest: string | null;
	/** Both sides had a session with this id before they ever synced. Left alone on both. */
	conflict?: true;
	/**
	 * The learner unpaired this PC ("Unpair this PC", Phase 6): it is no longer
	 * syncing, so every session is its own to continue (`mine` is true). This
	 * remembers whose it was, for when the PC is paired again.
	 */
	freed?: "mine" | "held";
}

/** Told to the learner after a discard (owner's rule: no copies, but never silently). */
export interface DiscardNotice {
	chatId: string;
	title: string;
	/** Messages the learner sent here that never reached the server. */
	turns: number;
	at: number;
}

export interface DesktopState {
	version: 1;
	/** The server this state belongs to; another server starts over. */
	server: string;
	deviceId: string;
	startedAt: number;
	backup: string | null;
	/** The server's counter up to which this desktop has asked. */
	cursor: number;
	sessions: Record<string, DesktopSession>;
	/** Discards the learner hasn't been told about yet. */
	notices?: DiscardNotice[];
	/** Paired again with the same server: a fresh backup comes before the next sync. */
	rebackup?: true;
}

export function isDesktopState(value: unknown): value is DesktopState {
	const v = value as Partial<DesktopState> | null;
	return !!v && typeof v === "object" && v.version === 1 && typeof v.server === "string" && typeof v.deviceId === "string" &&
		typeof v.cursor === "number" && !!v.sessions && typeof v.sessions === "object";
}

export type SyncRequester = <T = Record<string, unknown>>(
	pathname: string,
	init?: { method?: "GET" | "POST" | "PUT" | "DELETE"; body?: unknown },
) => Promise<SyncReply<T>>;

export interface DesktopSyncDeps {
	files: SessionFiles;
	state: StateFile<DesktopState>;
	/** Who this desktop is paired as, or null when it isn't paired. */
	identity: () => { server: string; deviceId: string } | null;
	request: SyncRequester;
	now: () => number;
	makeBackup: () => string | null;
	/** Tell this app's open windows that a session's files changed under them. */
	announce?: (chatId: string, what: "written" | "removed") => void;
	/** This desktop's own work on its sessions. */
	localWork?: LocalWork;
	/** A session was lost to a take-over (its unsent graph knowledge goes too). */
	onDiscard?: (chatId: string) => void;
}

export type TickResult =
	| { ok: true; fetched: string[]; sent: string[]; removed: string[]; lost: string[]; handed: string[] }
	| { ok: false; reason: "not-paired" | "offline" | "paused" | "refused" | "busy" };

export interface DesktopSync {
	/** Has this desktop ever synced with the server it is paired with? */
	active(): boolean;
	/** May this desktop change the session? */
	holds(chatId: string): boolean;
	holderOf(chatId: string): { id: string; name: string | null } | null;
	tick(): Promise<TickResult>;
	/**
	 * Ask the server for a session another device holds. Needs the server:
	 * an offline desktop can only continue what it already held. The answer's
	 * `status` is the server's ("yours", "moved", "waiting", "warning") or
	 * "offline" / "not-paired" / "paused".
	 */
	takeOver(chatId: string, force: boolean): Promise<Record<string, unknown>>;
	/** Every session this desktop may not change. */
	held(): Record<string, { id: string; name: string | null }>;
	notices(): DiscardNotice[];
	dismissNotice(chatId: string, at: number): void;
	/**
	 * The learner unpaired this PC here. Every session becomes its own to
	 * continue; what each one was is remembered for a later pairing.
	 */
	release(): void;
	/** This PC was paired again with the server it synced with before. */
	rejoin(): void;
}

const sessionPath = (id: string) => `/api/sync/sessions/${encodeURIComponent(id)}`;

export function createDesktopSync(deps: DesktopSyncDeps): DesktopSync {
	const { files } = deps;
	// A session's pictures travel on their own, once (pictures-transport.ts).
	const request = picturesOnce(deps.request, files);
	let running: Promise<TickResult> | null = null;
	/**
	 * A session the server named this round couldn't be fetched because the
	 * server stopped answering (not because it refused). The place in the
	 * server's list then stays where it was, so the next round is told again;
	 * what was already brought here is told again harmlessly.
	 */
	let missed = false;
	const note = <T>(reply: SyncReply<T>): SyncReply<T> => {
		if (!reply.ok && reply.reason !== "refused") missed = true;
		return reply;
	};

	/** The state for the server this desktop is paired with, or null. */
	function current(): DesktopState | null {
		const identity = deps.identity();
		const state = deps.state.read();
		return identity && state && state.server === identity.server && state.deviceId === identity.deviceId ? state : null;
	}

	function entryOf(chatId: string): DesktopSession | null {
		return current()?.sessions[chatId] ?? null;
	}

	/** Replace a session here with the server's files. */
	function adopt(state: DesktopState, change: SessionChange, bundle: SessionBundle, mine: boolean): void {
		files.write(change.id, bundle);
		state.sessions[change.id] = {
			mine,
			holder: change.holder,
			holderName: change.holderName,
			serverVersion: change.version,
			stamp: files.stamp(change.id),
			digest: bundleDigest(bundle),
		};
		deps.announce?.(change.id, "written");
	}

	/** How many messages the learner sent here are missing from the server's version. */
	function unsentTurns(local: SessionBundle, remote: SessionBundle): { turns: number; title: string } {
		type Record_ = { title?: unknown; messages?: Array<{ id?: unknown; role?: unknown }> };
		let mine: Record_ = {}, theirs: Record_ = {};
		try { mine = JSON.parse(local.chat) as Record_; theirs = JSON.parse(remote.chat) as Record_; } catch { /* counted as none */ }
		const there = new Set((theirs.messages ?? []).map((m) => m.id));
		const turns = (mine.messages ?? []).filter((m) => m.role === "user" && !there.has(m.id)).length;
		return { turns, title: typeof mine.title === "string" ? mine.title : "" };
	}

	/**
	 * This desktop held the session and another device holds it now. Whatever
	 * it hadn't sent is discarded and the server's version takes its place
	 * (owner's rule: no copies). If anything was discarded, a notice is kept.
	 */
	async function giveUp(state: DesktopState, change: SessionChange): Promise<boolean> {
		const entry = state.sessions[change.id];
		// Not this build's format: left as it is, never replaced by a discard.
		const before = files.read(change.id);
		if (before && chatFileTooNew(before.chat)) return false;
		// A reply, helpers and extraction still running here for it stop now.
		deps.localWork?.stop(change.id, { turn: true });
		const reply = note(await request<SessionChange & { bundle: unknown }>(sessionPath(change.id)));
		if (!reply.ok) return false;
		const remote = checkBundle(change.id, reply.body.bundle);
		if (!remote) return false;
		deps.onDiscard?.(change.id);
		const local = files.read(change.id);
		if (local && entry && bundleDigest(local) !== entry.digest && bundleDigest(local) !== bundleDigest(remote)) {
			const lost = unsentTurns(local, remote);
			state.notices = [...(state.notices ?? []), { chatId: change.id, title: lost.title, turns: lost.turns, at: deps.now() }].slice(-50);
		}
		adopt(state, { ...change, version: reply.body.version, holder: reply.body.holder, holderName: reply.body.holderName }, remote, false);
		return true;
	}

	async function fetchInto(state: DesktopState, change: SessionChange, mine: boolean): Promise<boolean> {
		const reply = note(await request<SessionChange & { bundle: unknown }>(sessionPath(change.id)));
		if (!reply.ok) return false;
		const bundle = checkBundle(change.id, reply.body.bundle);
		if (!bundle) return false;
		adopt(state, { ...change, version: reply.body.version, holder: reply.body.holder, holderName: reply.body.holderName }, bundle, mine);
		return true;
	}

	/**
	 * After "Unpair this PC" every session was this PC's to continue. Paired
	 * again, each one is settled once (owner's rules):
	 *  - not continued here since: it is whose it was, and the usual round
	 *    hears of anything that happened to it meanwhile;
	 *  - continued here only: this PC asks for it back and sends its version;
	 *  - continued on both sides: the server's version stays (no copies), and
	 *    a notice says what was discarded here.
	 */
	async function settleFreed(state: DesktopState, deviceId: string, lost: string[]): Promise<"ok" | "offline" | "paused" | "not-paired"> {
		const freed = Object.entries(state.sessions).filter(([, entry]) => entry.freed);
		if (freed.length === 0) return "ok";
		const stamps = files.stamps();
		for (const [id, entry] of freed) {
			const stamp = stamps.get(id);
			const local = stamp === undefined ? null : files.read(id);
			// Not this build's format: left freed, and as it is, until a build that reads it.
			if (local && chatFileTooNew(local.chat)) continue;
			const localDigest = local ? bundleDigest(local) : null;
			if (!local || stamp === entry.stamp || localDigest === entry.digest) {
				entry.mine = entry.freed === "mine";
				delete entry.freed;
				if (local && stamp !== undefined) entry.stamp = stamp;
				continue;
			}
			const reply = await request<SessionChange & { bundle: unknown }>(sessionPath(id));
			if (!reply.ok) {
				if (reply.reason !== "refused") return reply.reason;
				// The server's copy is in a format this build can't take: ask again later.
				if (reply.code === NEWER_FORMAT_CODE) continue;
				// The server has no such session any more (deleted there): step 2's send settles it.
				entry.mine = true;
				delete entry.freed;
				continue;
			}
			const remote = checkBundle(id, reply.body.bundle);
			if (!remote) continue;
			const remoteDigest = bundleDigest(remote);
			const theirs: SessionChange = { id, version: reply.body.version, holder: reply.body.holder, holderName: reply.body.holderName, deleted: false };
			if (theirs.holder === deviceId || remoteDigest === localDigest) {
				// Still this PC's on the server, or both sides ended up the same.
				entry.mine = theirs.holder === deviceId;
				entry.holder = theirs.holder;
				entry.holderName = theirs.holderName;
				entry.serverVersion = theirs.version;
				if (remoteDigest === localDigest) { entry.stamp = stamp!; entry.digest = localDigest; }
				delete entry.freed;
				continue;
			}
			if (remoteDigest === entry.digest) {
				// Only this PC continued it: ask for it back. A holder that is busy
				// with it is asked again next round; nothing is forced.
				const take = await request<SessionChange & { status: string }>(`${sessionPath(id)}/take`, { method: "POST", body: { force: false } });
				if (!take.ok) {
					if (take.reason !== "refused") return take.reason;
					continue;
				}
				if (take.body.status === "moved" || take.body.status === "yours") {
					entry.mine = true;
					entry.holder = take.body.holder;
					entry.holderName = take.body.holderName;
					entry.serverVersion = take.body.version;
					delete entry.freed;
				}
				continue;
			}
			// Continued on both sides: the server's version, and a notice.
			deps.localWork?.stop(id, { turn: true });
			deps.onDiscard?.(id);
			const gone = unsentTurns(local, remote);
			state.notices = [...(state.notices ?? []), { chatId: id, title: gone.title, turns: gone.turns, at: deps.now() }].slice(-50);
			adopt(state, theirs, remote, false);
			lost.push(id);
		}
		return "ok";
	}

	async function round(): Promise<TickResult> {
		const identity = deps.identity();
		if (!identity) return { ok: false, reason: "not-paired" };
		let state = current();
		if (!state) {
			// The first sync with this server: the backup comes first.
			state = { version: 1, server: identity.server, deviceId: identity.deviceId, startedAt: deps.now(), backup: deps.makeBackup(), cursor: 0, sessions: {} };
			deps.state.write(state);
		}
		if (state.rebackup) {
			// Paired again after a break: what is here is copied aside first.
			state.backup = deps.makeBackup();
			delete state.rebackup;
			deps.state.write(state);
		}
		const result = { ok: true as const, fetched: [] as string[], sent: [] as string[], removed: [] as string[], lost: [] as string[], handed: [] as string[] };
		const replying = (id: string): boolean => deps.localWork?.replying(id) === true;

		// ── 0. Paired again: the sessions this PC freed when it was unpaired ───
		const settled = await settleFreed(state, identity.deviceId, result.lost);
		if (settled !== "ok") { deps.state.write(state); return { ok: false, reason: settled }; }

		// ── 1. What changed on the server ─────────────────────────────────────
		// With the question goes this desktop's word on the sessions it holds:
		// "busy" while a reply is being written, "unsent" when it has changes the
		// server doesn't have yet. It is the evidence a take-over warning rests on.
		const localBefore = files.stamps();
		const reports: Record<string, "busy" | "unsent"> = {};
		for (const [id, entry] of Object.entries(state.sessions)) {
			if (!entry.mine || entry.freed) continue;
			if (replying(id)) reports[id] = "busy";
			else if (localBefore.has(id) && localBefore.get(id) !== entry.stamp) reports[id] = "unsent";
		}
		missed = false;
		const news = await request<{ seq: number; changes: SessionChange[]; handovers?: string[] }>("/api/sync/sessions", { method: "POST", body: { cursor: state.cursor, reports } });
		if (!news.ok) return { ok: false, reason: news.reason };
		for (const change of news.body.changes) {
			const entry = state.sessions[change.id];
			if (change.deleted) {
				if (entry) {
					files.remove(change.id);
					delete state.sessions[change.id];
					deps.announce?.(change.id, "removed");
					result.removed.push(change.id);
				}
				continue;
			}
			const mine = change.holder === identity.deviceId;
			if (!entry) {
				if (localBefore.has(change.id) && mine) {
					// The server says this desktop holds it, and the files are here, but
					// this desktop's own record of it is gone. Keep the files (they may
					// be newer) and let step 2 send them.
					state.sessions[change.id] = { mine: true, holder: change.holder, holderName: change.holderName, serverVersion: change.version, stamp: null, digest: null };
					continue;
				}
				if (localBefore.has(change.id)) {
					// Both sides made a session with this id before they ever synced.
					// Ids are random, so this means one side's data was copied from the
					// other. Equal files are simply the same session; different files
					// are left alone on both sides, never overwritten.
					const local = files.read(change.id);
					if (local && !mine) {
						const reply = note(await request<SessionChange & { bundle: unknown }>(sessionPath(change.id)));
						const remote = reply.ok ? checkBundle(change.id, reply.body.bundle) : null;
						if (!remote) continue;
						const same = bundleDigest(local) === bundleDigest(remote);
						state.sessions[change.id] = {
							mine: false, holder: change.holder, holderName: change.holderName, serverVersion: change.version,
							stamp: files.stamp(change.id), digest: bundleDigest(local), ...(same ? {} : { conflict: true as const }),
						};
						continue;
					}
				}
				if (await fetchInto(state, change, mine)) result.fetched.push(change.id);
				continue;
			}
			if (entry.conflict || entry.freed) continue;
			if (mine) {
				// The echo of this desktop's own send, or the lease coming to it.
				if (!entry.mine && change.version > entry.serverVersion) {
					// It comes with a newer version than the one here: fetch that first.
					if (await fetchInto(state, change, true)) result.fetched.push(change.id);
					continue;
				}
				entry.mine = true;
				entry.holder = change.holder;
				entry.holderName = change.holderName;
				entry.serverVersion = Math.max(entry.serverVersion, change.version);
				continue;
			}
			if (entry.mine) {
				// Another device holds it now: this desktop lost the session.
				if (await giveUp(state, change)) result.lost.push(change.id);
				continue;
			}
			if (change.version > entry.serverVersion || entry.holder !== change.holder) {
				if (change.version > entry.serverVersion) {
					if (await fetchInto(state, change, false)) result.fetched.push(change.id);
				} else {
					entry.holder = change.holder;
					entry.holderName = change.holderName;
				}
			}
		}
		if (!missed) state.cursor = news.body.seq;
		deps.state.write(state);

		// ── 2. What changed here ──────────────────────────────────────────────
		const local = files.stamps();
		for (const [id, stamp] of local) {
			const entry = state.sessions[id];
			if (entry?.conflict || entry?.freed) continue;
			if (entry && entry.stamp === stamp) continue;
			const bundle = files.read(id);
			if (!bundle) continue;
			// Not this build's format: never sent, and never put back from the server's copy.
			if (chatFileTooNew(bundle.chat)) continue;
			const digest = bundleDigest(bundle);
			if (entry && digest === entry.digest) { entry.stamp = stamp; continue; }
			if (entry && !entry.mine) {
				// A session this desktop doesn't hold changed here anyway (it
				// shouldn't: the stores refuse). Put the server's files back.
				await fetchInto(state, { id, version: entry.serverVersion, holder: entry.holder, holderName: entry.holderName, deleted: false }, false);
				continue;
			}
			const reply = await request<SessionChange>(sessionPath(id), { method: "PUT", body: { baseVersion: entry?.serverVersion ?? 0, bundle, word: replying(id) ? "busy" : "all-sent" } });
			if (reply.ok) {
				state.sessions[id] = { mine: true, holder: reply.body.holder, holderName: reply.body.holderName, serverVersion: reply.body.version, stamp, digest };
				result.sent.push(id);
				continue;
			}
			if (reply.reason === "refused" && reply.code === "lease_lost") {
				const change = reply.body as unknown as SessionChange;
				if (entry) {
					if (await giveUp(state, { id, version: change.version, holder: change.holder, holderName: change.holderName, deleted: false })) result.lost.push(id);
				}
				continue;
			}
			if (reply.reason === "refused" && reply.code === "deleted") {
				files.remove(id);
				delete state.sessions[id];
				deps.announce?.(id, "removed");
				result.removed.push(id);
				continue;
			}
			if (reply.reason !== "refused") { deps.state.write(state); return { ok: false, reason: reply.reason }; }
		}

		// ── 3. What was deleted here, and what went missing ───────────────────
		for (const [id, entry] of Object.entries(state.sessions)) {
			if (local.has(id) || entry.conflict || entry.freed) continue;
			if (entry.mine) {
				const reply = await request(sessionPath(id), { method: "DELETE" });
				if (reply.ok || (reply.reason === "refused" && (reply.status === 404 || reply.code === "deleted"))) {
					delete state.sessions[id];
					result.removed.push(id);
				} else if (reply.reason === "refused" && reply.code === "lease_lost") {
					// It was taken over before the delete got there: it lives on, elsewhere.
					const change = reply.body as unknown as SessionChange;
					await fetchInto(state, { id, version: change.version, holder: change.holder, holderName: change.holderName, deleted: false }, false);
				} else if (reply.reason !== "refused") { deps.state.write(state); return { ok: false, reason: reply.reason }; }
			} else {
				// A held session's files vanished here: bring them back.
				await fetchInto(state, { id, version: entry.serverVersion, holder: entry.holder, holderName: entry.holderName, deleted: false }, false);
			}
		}
		// ── 4. Sessions someone asked this desktop to hand over ───────────────
		for (const id of news.body.handovers ?? []) {
			const entry = state.sessions[id];
			if (!entry?.mine || entry.freed) continue;
			// A reply being written is finished first; the next round hands over.
			if (replying(id)) continue;
			// Helpers and extraction stop here; the new holder starts them again.
			deps.localWork?.stop(id);
			const stamp = files.stamp(id);
			const bundle = files.read(id);
			if (!bundle || chatFileTooNew(bundle.chat)) continue;
			const reply = await request<SessionChange>(sessionPath(id), { method: "PUT", body: { baseVersion: entry.serverVersion, bundle, word: "all-sent", release: true } });
			if (!reply.ok) continue;
			state.sessions[id] = {
				mine: reply.body.holder === identity.deviceId, holder: reply.body.holder, holderName: reply.body.holderName,
				serverVersion: reply.body.version, stamp, digest: bundleDigest(bundle),
			};
			if (reply.body.holder !== identity.deviceId) {
				result.handed.push(id);
				deps.announce?.(id, "written");
			}
		}
		deps.state.write(state);
		return result;
	}

	async function takeOver(chatId: string, force: boolean): Promise<Record<string, unknown>> {
		const identity = deps.identity();
		const state = current();
		if (!identity || !state) return { status: "not-paired" };
		const reply = await request<SessionChange & { status: string }>(`${sessionPath(chatId)}/take`, { method: "POST", body: { force } });
		if (!reply.ok) return { status: reply.reason === "refused" ? "refused" : reply.reason, ...(reply.reason === "refused" ? { error: reply.error } : {}) };
		if (reply.body.status === "moved" || reply.body.status === "yours") {
			// The session is this desktop's: bring the server's version here.
			const entry = state.sessions[chatId];
			if (!entry?.mine) {
				const change: SessionChange = { id: chatId, version: reply.body.version, holder: reply.body.holder, holderName: reply.body.holderName, deleted: false };
				if (!(await fetchInto(state, change, true))) return { status: "offline" };
				deps.state.write(state);
			}
		}
		return reply.body as unknown as Record<string, unknown>;
	}

	return {
		takeOver,
		held() {
			const out: Record<string, { id: string; name: string | null }> = {};
			for (const [id, entry] of Object.entries(current()?.sessions ?? {})) {
				if (!entry.mine && !entry.conflict) out[id] = { id: entry.holder, name: entry.holderName };
			}
			return out;
		},
		notices: () => current()?.notices ?? [],
		dismissNotice(chatId, at) {
			const state = current();
			if (!state?.notices) return;
			state.notices = state.notices.filter((n) => !(n.chatId === chatId && n.at === at));
			deps.state.write(state);
		},
		release() {
			const state = current();
			if (!state) return;
			const opened: string[] = [];
			for (const [id, entry] of Object.entries(state.sessions)) {
				if (entry.conflict || entry.freed) continue;
				entry.freed = entry.mine ? "mine" : "held";
				if (!entry.mine) opened.push(id);
				entry.mine = true;
			}
			deps.state.write(state);
			// Open windows learn that these can be continued here now.
			for (const id of opened) deps.announce?.(id, "written");
		},
		rejoin() {
			const state = current();
			if (!state || state.rebackup) return;
			state.rebackup = true;
			deps.state.write(state);
		},
		active: () => current() !== null,
		holds(chatId) {
			const entry = entryOf(chatId);
			return !entry || entry.mine || entry.conflict === true;
		},
		holderOf(chatId) {
			const entry = entryOf(chatId);
			return entry && !entry.mine && !entry.conflict ? { id: entry.holder, name: entry.holderName } : null;
		},
		tick() {
			if (running) return Promise.resolve({ ok: false, reason: "busy" } as TickResult);
			running = round().finally(() => { running = null; });
			return running;
		},
	};
}
