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
 */

import { bundleDigest, checkBundle, type SessionBundle, type SessionChange } from "../../core/sync/sessions.ts";
import type { SessionFiles } from "../../store/sync/session-files.ts";
import type { StateFile } from "../../store/sync/state-file.ts";
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
}

export type TickResult =
	| { ok: true; fetched: string[]; sent: string[]; removed: string[]; lost: string[] }
	| { ok: false; reason: "not-paired" | "offline" | "paused" | "refused" | "busy" };

export interface DesktopSync {
	/** Has this desktop ever synced with the server it is paired with? */
	active(): boolean;
	/** May this desktop change the session? */
	holds(chatId: string): boolean;
	holderOf(chatId: string): { id: string; name: string | null } | null;
	tick(): Promise<TickResult>;
}

const sessionPath = (id: string) => `/api/sync/sessions/${encodeURIComponent(id)}`;

export function createDesktopSync(deps: DesktopSyncDeps): DesktopSync {
	const { files } = deps;
	let running: Promise<TickResult> | null = null;

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

	async function fetchInto(state: DesktopState, change: SessionChange, mine: boolean): Promise<boolean> {
		const reply = await deps.request<SessionChange & { bundle: unknown }>(sessionPath(change.id));
		if (!reply.ok) return false;
		const bundle = checkBundle(change.id, reply.body.bundle);
		if (!bundle) return false;
		adopt(state, { ...change, version: reply.body.version, holder: reply.body.holder, holderName: reply.body.holderName }, bundle, mine);
		return true;
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
		const result = { ok: true as const, fetched: [] as string[], sent: [] as string[], removed: [] as string[], lost: [] as string[] };

		// ── 1. What changed on the server ─────────────────────────────────────
		const news = await deps.request<{ seq: number; changes: SessionChange[] }>("/api/sync/sessions", { method: "POST", body: { cursor: state.cursor, reports: {} } });
		if (!news.ok) return { ok: false, reason: news.reason };
		const localBefore = files.stamps();
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
						const reply = await deps.request<SessionChange & { bundle: unknown }>(sessionPath(change.id));
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
			if (entry.conflict) continue;
			if (mine) {
				// The echo of this desktop's own send, or the lease coming to it.
				entry.mine = true;
				entry.holder = change.holder;
				entry.holderName = change.holderName;
				entry.serverVersion = Math.max(entry.serverVersion, change.version);
				continue;
			}
			if (entry.mine) {
				// Another device holds it now: this desktop lost the session. What it
				// hadn't sent is discarded (owner's rule: no copies) and the server's
				// version takes its place.
				if (await fetchInto(state, change, false)) result.lost.push(change.id);
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
		state.cursor = news.body.seq;
		deps.state.write(state);

		// ── 2. What changed here ──────────────────────────────────────────────
		const local = files.stamps();
		for (const [id, stamp] of local) {
			const entry = state.sessions[id];
			if (entry?.conflict) continue;
			if (entry && entry.stamp === stamp) continue;
			const bundle = files.read(id);
			if (!bundle) continue;
			const digest = bundleDigest(bundle);
			if (entry && digest === entry.digest) { entry.stamp = stamp; continue; }
			if (entry && !entry.mine) {
				// A session this desktop doesn't hold changed here anyway (it
				// shouldn't: the stores refuse). Put the server's files back.
				await fetchInto(state, { id, version: entry.serverVersion, holder: entry.holder, holderName: entry.holderName, deleted: false }, false);
				continue;
			}
			const reply = await deps.request<SessionChange>(sessionPath(id), { method: "PUT", body: { baseVersion: entry?.serverVersion ?? 0, bundle } });
			if (reply.ok) {
				state.sessions[id] = { mine: true, holder: reply.body.holder, holderName: reply.body.holderName, serverVersion: reply.body.version, stamp, digest };
				result.sent.push(id);
				continue;
			}
			if (reply.reason === "refused" && reply.code === "lease_lost") {
				const change = reply.body as unknown as SessionChange;
				if (await fetchInto(state, { id, version: change.version, holder: change.holder, holderName: change.holderName, deleted: false }, false)) result.lost.push(id);
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
			if (local.has(id) || entry.conflict) continue;
			if (entry.mine) {
				const reply = await deps.request(sessionPath(id), { method: "DELETE" });
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
		deps.state.write(state);
		return result;
	}

	return {
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
