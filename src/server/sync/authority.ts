/**
 * Cloud sync (Phase 5, docs/cloud-sync.md): the SERVER as lease authority.
 * It records, for every session, which device holds it and which version
 * of its files is current. Only the holder's send is accepted; everyone
 * else fetches.
 *
 * The server's own sessions (what the phone works on) are held by
 * CLOUD_HOLDER. Their changes are found by comparing file stamps when a
 * desktop asks for news, so nothing in the server's own write path changes.
 *
 * NOTHING HERE RUNS until a paired desktop syncs for the first time: the
 * state file doesn't exist before that, holds() answers true for every
 * session, and no folder is created. The first sync starts with the backup.
 *
 * Every method is one synchronous stretch: requests can't interleave
 * inside it (the same argument as the stores' read-modify-write).
 */

import { checkPictureList, PICTURE_ID, picturesIn, withoutPictures, withPictures } from "../../core/sync/pictures.ts";
import type { PictureStaging } from "../../store/sync/picture-staging.ts";
import {
	bundleDigest,
	checkBundle,
	CLOUD_HOLDER,
	isHolderWord,
	isSessionId,
	type HolderWord,
	type SessionBundle,
	type SessionChange,
} from "../../core/sync/sessions.ts";
import type { SessionFiles } from "../../store/sync/session-files.ts";
import type { StateFile } from "../../store/sync/state-file.ts";

export interface AuthoritySession {
	holder: string;
	version: number;
	/** The authority's counter when this entry last changed. */
	seq: number;
	/** The files as the authority last saw them (stamp is the cheap check, digest the sure one). */
	stamp: string | null;
	digest: string | null;
	deletedAt?: number;
	/** A holding desktop's last word about this session. */
	report?: { at: number; word: HolderWord };
	/** Someone asked the (online) holder to hand the session over. */
	handover?: { to: string; at: number };
}

/** A desktop counts as online while the server heard from it this recently (three missed checks). */
export const ONLINE_WINDOW_MS = 30_000;
/** A hand-over request nobody repeats is forgotten: the asker went away. */
/** How often "last heard from" is written to the record. */
const SEEN_SAVE_MS = 60_000;
export const HANDOVER_REQUEST_MS = 60_000;

/** What a device is doing for a session, and how to stop it (wired in engine.ts). */
export interface LocalWork {
	/** A reply is being written for this session right now. */
	replying(chatId: string): boolean;
	/** Stop helpers and extraction for the session; with `turn`, the reply too. */
	stop(chatId: string, options?: { turn?: boolean }): void;
}

export interface AuthorityState {
	version: 1;
	startedAt: number;
	/** The before-first-sync backup folder, once made. */
	backup: string | null;
	seq: number;
	sessions: Record<string, AuthoritySession>;
	/** When each desktop was last heard from. */
	seen: Record<string, number>;
}

export function isAuthorityState(value: unknown): value is AuthorityState {
	const v = value as Partial<AuthorityState> | null;
	return !!v && typeof v === "object" && v.version === 1 && typeof v.seq === "number" &&
		!!v.sessions && typeof v.sessions === "object" && !!v.seen && typeof v.seen === "object";
}

export interface AuthorityDeps {
	files: SessionFiles;
	state: StateFile<AuthorityState>;
	now: () => number;
	/** A paired desktop's name, for "held by …". */
	deviceName: (deviceId: string) => string | null;
	/** Make the before-first-sync backup; returns its folder. */
	makeBackup: () => string | null;
	/** Tell this server's open pages that a session's files changed under them. */
	announce?: (chatId: string, what: "written" | "removed") => void;
	/** The server's own work on its sessions (a desktop may ask for one of them). */
	localWork?: LocalWork;
	/** Where pictures sent ahead of their session wait. */
	staging?: PictureStaging;
}

/** A session this server may not change, for "Held by …". */
export interface HeldSession {
	id: string;
	name: string | null;
	/** The holder was heard from in the last 30 seconds. */
	online: boolean;
	lastSeenAt: number | null;
	/** Its last word; anything but "all-sent" is evidence of unsent turns. */
	word: HolderWord;
}

export interface AuthorityReply {
	status: number;
	body: Record<string, unknown>;
}

export interface Authority {
	/** Has any desktop ever synced with this server? */
	active(): boolean;
	/** May THIS server change the session (is it the cloud's own)? */
	holds(chatId: string): boolean;
	/** Who holds a session this server doesn't, for the refusal. */
	holderOf(chatId: string): { id: string; name: string | null } | null;
	/** "What changed since `cursor`?" Also records the desktop's reports. */
	exchange(deviceId: string, body: unknown): AuthorityReply;
	fetch(deviceId: string, chatId: string): AuthorityReply;
	store(deviceId: string, chatId: string, body: unknown): AuthorityReply;
	/** One picture of a session, for a desktop that doesn't have it yet. */
	picture(deviceId: string, chatId: string, pictureId: string): AuthorityReply;
	/** A picture (or one piece of a big one) sent ahead of the session it belongs to. */
	storePicture(deviceId: string, chatId: string, pictureId: string, body: unknown): AuthorityReply;
	remove(deviceId: string, chatId: string): AuthorityReply;
	/** Notice the server's own changes now (tests; exchange does it itself). */
	scan(): void;
	/**
	 * `to` (a desktop, or CLOUD_HOLDER for the server itself) asks for a
	 * session. The answer's `status`: "yours" / "moved" (it holds it now),
	 * "waiting" (the holder is finishing a reply or handing over; ask again),
	 * or "warning" (the offline holder may have unsent turns; ask again with
	 * force to take it anyway).
	 */
	takeOver(to: string, chatId: string, force: boolean): AuthorityReply;
	/** Every session this server may not change, with what is known of its holder. */
	held(): Record<string, HeldSession>;
}

const bad = (error: string, status = 400, extra: Record<string, unknown> = {}): AuthorityReply => ({ status, body: { error, ...extra } });

export function createAuthority(deps: AuthorityDeps): Authority {
	const { files } = deps;

	/**
	 * When each desktop was last heard from, to the second. The record on
	 * disk follows only once a minute (SEEN_SAVE_MS), so a desktop asking for
	 * news every ten seconds doesn't rewrite the file each time.
	 */
	const heard = new Map<string, number>();
	function hear(state: AuthorityState, deviceId: string, now: number): void {
		heard.set(deviceId, now);
		if (now - (state.seen[deviceId] ?? 0) >= SEEN_SAVE_MS) state.seen[deviceId] = now;
	}
	const lastHeard = (state: AuthorityState, deviceId: string): number | null => {
		const at = Math.max(heard.get(deviceId) ?? 0, state.seen[deviceId] ?? 0);
		return at > 0 ? at : null;
	};

	/** The pictures in a session's chat file here; the last one asked about is kept at hand. */
	let lastPictures: { chatId: string; stamp: string | null; data: Map<string, string> } | null = null;
	function picturesHere(chatId: string): Map<string, string> {
		const stamp = files.stamp(chatId);
		if (!lastPictures || lastPictures.chatId !== chatId || lastPictures.stamp !== stamp) {
			lastPictures = { chatId, stamp, data: picturesIn(files.read(chatId)?.chat) };
		}
		return lastPictures.data;
	}

	function started(): AuthorityState {
		const existing = deps.state.read();
		if (existing) return existing;
		// The first sync ever: the backup comes before anything is recorded.
		const state: AuthorityState = { version: 1, startedAt: deps.now(), backup: deps.makeBackup(), seq: 0, sessions: {}, seen: {} };
		deps.state.write(state);
		return state;
	}

	function changeOf(id: string, entry: AuthoritySession): SessionChange {
		return {
			id,
			version: entry.version,
			holder: entry.holder,
			holderName: entry.holder === CLOUD_HOLDER ? null : deps.deviceName(entry.holder),
			deleted: entry.deletedAt !== undefined,
		};
	}

	/** Bring the record up to date with the server's own files. Returns true when something changed. */
	function scanInto(state: AuthorityState): boolean {
		let changed = false;
		const stamps = files.stamps();
		for (const [id, stamp] of stamps) {
			const entry = state.sessions[id];
			if (!entry || entry.deletedAt !== undefined) {
				// A session made on the server (or one that was here before the first sync).
				// A deleted id never comes back by itself: ids are random, so this is new.
				if (entry) continue;
				const bundle = files.read(id);
				if (!bundle) continue;
				state.sessions[id] = { holder: CLOUD_HOLDER, version: 1, seq: ++state.seq, stamp, digest: bundleDigest(bundle) };
				changed = true;
				continue;
			}
			if (entry.holder !== CLOUD_HOLDER || entry.stamp === stamp) continue;
			const bundle = files.read(id);
			if (!bundle) continue;
			const digest = bundleDigest(bundle);
			entry.stamp = stamp;
			if (digest !== entry.digest) {
				entry.digest = digest;
				entry.version += 1;
				entry.seq = ++state.seq;
			}
			changed = true;
		}
		for (const [id, entry] of Object.entries(state.sessions)) {
			// The cloud deleted one of its own sessions.
			if (entry.holder === CLOUD_HOLDER && entry.deletedAt === undefined && !stamps.has(id)) {
				entry.deletedAt = deps.now();
				entry.stamp = null;
				entry.digest = null;
				entry.version += 1;
				entry.seq = ++state.seq;
				changed = true;
			}
		}
		return changed;
	}

	function heldInfo(state: AuthorityState, entry: AuthoritySession): HeldSession {
		const seenAt = lastHeard(state, entry.holder);
		return {
			id: entry.holder,
			name: deps.deviceName(entry.holder),
			online: seenAt !== null && deps.now() - seenAt < ONLINE_WINDOW_MS,
			lastSeenAt: seenAt,
			word: entry.report?.word ?? "all-sent",
		};
	}

	/** Give the session to `to`. The files stay as they are; only the holder changes. */
	function move(state: AuthorityState, chatId: string, entry: AuthoritySession, to: string): void {
		entry.holder = to;
		delete entry.handover;
		if (to === CLOUD_HOLDER) delete entry.report;
		else entry.report = { at: deps.now(), word: "all-sent" };
		entry.seq = ++state.seq;
		deps.state.write(state);
		// The session list and an open view of the session learn of it.
		deps.announce?.(chatId, "written");
	}

	return {
		active: () => deps.state.exists(),

		held() {
			const state = deps.state.read();
			const out: Record<string, HeldSession> = {};
			if (!state) return out;
			for (const [id, entry] of Object.entries(state.sessions)) {
				if (entry.deletedAt === undefined && entry.holder !== CLOUD_HOLDER) out[id] = heldInfo(state, entry);
			}
			return out;
		},

		takeOver(to, chatId, force) {
			const state = deps.state.read();
			const entry = state?.sessions[chatId];
			if (!state || !entry || entry.deletedAt !== undefined) return bad("No such session.", 404);
			const now = deps.now();
			if (to !== CLOUD_HOLDER) { state.seen[to] = now; heard.set(to, now); }
			if (entry.holder === to) return { status: 200, body: { status: "yours", ...changeOf(chatId, entry) } };

			if (entry.holder === CLOUD_HOLDER) {
				// The server itself holds it. A reply in progress is finished first.
				if (deps.localWork?.replying(chatId)) return { status: 200, body: { status: "waiting", reason: "reply", ...changeOf(chatId, entry) } };
				// Helpers and extraction stop here; the new holder starts them again.
				deps.localWork?.stop(chatId);
				scanInto(state);
				move(state, chatId, entry, to);
				return { status: 200, body: { status: "moved", ...changeOf(chatId, entry) } };
			}

			const holder = heldInfo(state, entry);
			if (holder.online) {
				// Ask the holder to hand over: it finishes its reply, sends what
				// it has and lets go at its next check. No warning is needed.
				entry.handover = { to, at: now };
				deps.state.write(state);
				return { status: 200, body: { status: "waiting", reason: holder.word === "busy" ? "reply" : "handing-over", heldBy: holder, ...changeOf(chatId, entry) } };
			}
			// The holder can't be reached. Its last word is all the server has.
			if (holder.word !== "all-sent" && !force) {
				deps.state.write(state);
				return { status: 200, body: { status: "warning", heldBy: holder, ...changeOf(chatId, entry) } };
			}
			move(state, chatId, entry, to);
			return { status: 200, body: { status: "moved", previous: holder, ...changeOf(chatId, entry) } };
		},

		holds(chatId) {
			const state = deps.state.read();
			const entry = state?.sessions[chatId];
			return !entry || entry.deletedAt !== undefined || entry.holder === CLOUD_HOLDER;
		},

		holderOf(chatId) {
			const entry = deps.state.read()?.sessions[chatId];
			if (!entry || entry.deletedAt !== undefined || entry.holder === CLOUD_HOLDER) return null;
			return { id: entry.holder, name: deps.deviceName(entry.holder) };
		},

		scan() {
			const state = deps.state.read();
			if (state && scanInto(state)) deps.state.write(state);
		},

		exchange(deviceId, body) {
			const raw = (body ?? {}) as { cursor?: unknown; reports?: unknown };
			if (typeof raw.cursor !== "number" || !Number.isInteger(raw.cursor) || raw.cursor < 0) return bad("The sync request is missing its place in the list.");
			const state = started();
			scanInto(state);
			const now = deps.now();
			hear(state, deviceId, now);
			if (raw.reports && typeof raw.reports === "object" && !Array.isArray(raw.reports)) {
				for (const [id, word] of Object.entries(raw.reports as Record<string, unknown>)) {
					const entry = state.sessions[id];
					if (entry && entry.holder === deviceId && entry.deletedAt === undefined && isHolderWord(word)) entry.report = { at: now, word };
				}
			}
			// A cursor from a different life of this server (restored, reset) means: send everything.
			const cursor = raw.cursor > state.seq ? 0 : raw.cursor;
			const changes = Object.entries(state.sessions)
				.filter(([, entry]) => entry.seq > cursor)
				.sort((a, b) => a[1].seq - b[1].seq)
				.map(([id, entry]) => changeOf(id, entry));
			// Sessions this desktop holds that someone asked for, while the request is fresh.
			const handovers = Object.entries(state.sessions)
				.filter(([, entry]) => entry.holder === deviceId && entry.deletedAt === undefined && entry.handover && now - entry.handover.at < HANDOVER_REQUEST_MS)
				.map(([id]) => id);
			deps.state.write(state);
			return { status: 200, body: { seq: state.seq, changes, handovers, time: now } };
		},

		fetch(_deviceId, chatId) {
			const state = deps.state.read();
			if (!state || !isSessionId(chatId)) return bad("No such session.", 404);
			if (scanInto(state)) deps.state.write(state);
			const entry = state.sessions[chatId];
			if (!entry) return bad("No such session.", 404);
			if (entry.deletedAt !== undefined) return bad("That session was deleted.", 410, { code: "deleted" });
			const bundle = files.read(chatId);
			if (!bundle) return bad("No such session.", 404);
			// The pictures travel on their own, once (core/sync/pictures.ts).
			const slim = withoutPictures(bundle.chat);
			return { status: 200, body: { ...changeOf(chatId, entry), bundle: slim ? { ...bundle, chat: slim.chat, pictures: slim.pictures } : bundle } };
		},

		picture(_deviceId, chatId, pictureId) {
			const state = deps.state.read();
			const entry = state && isSessionId(chatId) ? state.sessions[chatId] : undefined;
			if (!entry || entry.deletedAt !== undefined || !PICTURE_ID.test(pictureId)) return bad("No such picture.", 404);
			const data = picturesHere(chatId).get(pictureId);
			return data === undefined ? bad("No such picture.", 404) : { status: 200, body: { data } };
		},

		storePicture(deviceId, chatId, pictureId, body) {
			if (!isSessionId(chatId) || !deps.staging) return bad("No such session.", 404);
			const sent = (body ?? {}) as { data?: unknown; part?: unknown; of?: unknown };
			if (typeof sent.data !== "string" || typeof sent.part !== "number" || typeof sent.of !== "number") return bad("The picture didn't arrive whole.");
			const state = started();
			const entry = state.sessions[chatId];
			if (entry?.deletedAt !== undefined) return bad("That session was deleted.", 410, { code: "deleted" });
			if (entry && entry.holder !== deviceId) return bad("Another device holds this session now.", 409, { code: "lease_lost", ...changeOf(chatId, entry) });
			const result = deps.staging.add(chatId, pictureId, sent.part, sent.of, sent.data);
			if (result === "full") return bad("Too many pictures are waiting for this session.", 413);
			if (result === "bad") return bad("The picture didn't arrive whole.");
			return { status: 200, body: { status: result } };
		},

		store(deviceId, chatId, body) {
			if (!isSessionId(chatId)) return bad("No such session.", 404);
			const sent = (body ?? {}) as { bundle?: unknown; word?: unknown; release?: unknown };
			const arrived = sent.bundle as { chat?: unknown; pictures?: unknown } | null | undefined;
			const slim = !!arrived && typeof arrived === "object" && arrived.pictures !== undefined;
			if (!slim && !checkBundle(chatId, sent.bundle)) return bad("The session's files didn't arrive whole.");
			const state = started();
			scanInto(state);
			const entry = state.sessions[chatId];
			if (entry?.deletedAt !== undefined) return bad("That session was deleted.", 410, { code: "deleted" });
			if (entry && entry.holder !== deviceId) {
				// The holder is the only one who may send. Anyone else has lost the
				// session (or never had it) and gets the current state instead.
				deps.state.write(state);
				return bad("Another device holds this session now.", 409, { code: "lease_lost", ...changeOf(chatId, entry) });
			}
			let whole: unknown = sent.bundle;
			if (slim) {
				// The chat came without its pictures: put it back together from the
				// ones already here and the ones sent ahead; ask for the rest.
				const pictures = checkPictureList(arrived.pictures);
				if (!pictures || typeof arrived.chat !== "string") return bad("The session's files didn't arrive whole.");
				const here = picturesHere(chatId);
				let joined: ReturnType<typeof withPictures>;
				try { joined = withPictures(arrived.chat, pictures, (id) => here.get(id) ?? deps.staging?.get(chatId, id) ?? null); }
				catch { return bad("The session's files didn't arrive whole."); }
				if ("missing" in joined) {
					deps.state.write(state);
					return bad("Some of this session's pictures haven't been sent yet.", 409, { code: "pictures_needed", ids: joined.missing });
				}
				const { pictures: _list, ...rest } = arrived;
				whole = { ...rest, chat: joined.text };
			}
			const bundle: SessionBundle | null = checkBundle(chatId, whole);
			if (!bundle) return bad("The session's files didn't arrive whole.");
			files.write(chatId, bundle);
			deps.staging?.clear(chatId);
			const next: AuthoritySession = {
				holder: deviceId,
				version: (entry?.version ?? 0) + 1,
				seq: ++state.seq,
				stamp: files.stamp(chatId),
				digest: bundleDigest(bundle),
				// Everything the holder had is here now, unless it says a reply is still being written.
				report: { at: deps.now(), word: sent.word === "busy" ? "busy" : "all-sent" },
				...(entry?.handover ? { handover: entry.handover } : {}),
			};
			state.sessions[chatId] = next;
			hear(state, deviceId, deps.now());
			if (sent.release === true && next.handover) {
				// The holder hands the session to whoever asked for it.
				move(state, chatId, next, next.handover.to);
				return { status: 200, body: changeOf(chatId, next) as unknown as Record<string, unknown> };
			}
			deps.state.write(state);
			deps.announce?.(chatId, "written");
			return { status: 200, body: changeOf(chatId, next) as unknown as Record<string, unknown> };
		},

		remove(deviceId, chatId) {
			const state = deps.state.read();
			const entry = state?.sessions[chatId];
			if (!state || !entry) return bad("No such session.", 404);
			if (entry.deletedAt !== undefined) return { status: 200, body: changeOf(chatId, entry) as unknown as Record<string, unknown> };
			if (entry.holder !== deviceId) return bad("Another device holds this session now.", 409, { code: "lease_lost", ...changeOf(chatId, entry) });
			files.remove(chatId);
			entry.deletedAt = deps.now();
			entry.stamp = null;
			entry.digest = null;
			entry.version += 1;
			entry.seq = ++state.seq;
			delete entry.report;
			deps.state.write(state);
			deps.announce?.(chatId, "removed");
			return { status: 200, body: changeOf(chatId, entry) as unknown as Record<string, unknown> };
		},
	};
}
