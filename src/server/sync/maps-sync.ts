/**
 * Cloud sync (Phase 5, docs/cloud-sync.md): the files that sync one item at
 * a time. The latest change to an item wins; times are on the server's clock.
 *
 * Neither side is told about changes as they happen. Each compares its
 * files with what it last agreed on ("what changed here since?"), which
 * needs no hook in any write path and also catches a file edited by hand.
 *
 *   the server   keeps a table: for every item, a fingerprint of its value,
 *                when it last changed, and a counter that says in which
 *                order changes reached the server
 *   a desktop    keeps the fingerprints it last agreed on, and its own
 *                changes the server hasn't taken yet, each with its time
 *
 * One exchange: the desktop sends its changes and its place in the server's
 * counter; the server takes each one that is newer than what it has, and
 * answers with everything that changed since that place.
 *
 * THE FIRST DESKTOP'S FIRST SYNC (owner's decision: "where the two sides
 * differ, the desktop's value is kept"): the desktop sends everything it
 * has, and for that one exchange its values win whatever the times say. A
 * synced SETTING the desktop doesn't have set is its default, so the
 * server's value for it goes too. Everything else is joined: a folder, a
 * prompt text, a custom theme, an imported-file record or a node's place
 * that only one side has is kept.
 *
 * A DESKTOP PAIRED LATER (owner's decision, Phase 6: "only the first PC
 * brings its settings", so a fresh install can't reset every device): at
 * its first sync the server's values stand. Its synced settings become
 * the server's, "not set" included; where both have the same folder,
 * prompt text, theme, record or node place, the server's is kept; and anything
 * of those kinds that only the new PC has is added, as above.
 *
 * A SECOND INSTANCE (Flashcards sync, docs/phone-plugins-plan.md): the same
 * exchange runs for the Flashcards library with its own kinds and checks
 * (`ExchangeRules`), its own route and its own state files. Because every
 * review is an item there, an exchange goes in PAGES both ways: the desktop
 * sends its changes a page at a time (`more: true` while more follow), then
 * the server answers what changed since the desktop's place a page at a time
 * (`more: true` in the answer). The desktop takes what arrived only once the
 * last page is in, in one step, so an interrupted exchange leaves nothing
 * half-agreed on its side. A small exchange is one request, as it always was.
 */

import { ABSENT, checkMapChange, isVaultFolderName, itemHash, kindOf, MAX_VAULT_FOLDERS, type MapChange } from "../../core/sync/maps.ts";
import type { StateFile } from "../../store/sync/state-file.ts";
import type { AuthorityReply } from "./authority.ts";
import type { SyncRequester } from "./desktop-sync.ts";
import type { MapFiles, MapSnapshot } from "./map-views.ts";

const MAX_CHANGES = 50_000;

/** One page of an exchange, each way: at most this many items, and about this many bytes of values. */
export const PAGE_ITEMS = 5_000;
export const PAGE_BYTES = 4 * 1024 * 1024;

/** What one instance of the exchange syncs. */
export interface ExchangeRules {
	/** The kind of a key, or null when it isn't one of this exchange's. */
	kindOf(key: string): string | null;
	/** A change received from the other side, or null when it can't be trusted. */
	checkChange(raw: unknown): MapChange | null;
	/**
	 * At the first desktop's first sync, a synced setting ("s" kind) the
	 * desktop didn't send is its default there, and goes back to it on the
	 * server too. Off for Flashcards: a library always sends every setting
	 * it has, and a PC with no library brings no settings.
	 */
	resetUnsentSettings: boolean;
	/** The refusal for a request that didn't arrive whole. */
	malformed: string;
	/** Items whose time can't matter (an item that never changes): `detect` leaves them to the next exchange. */
	untimed?: (key: string) => boolean;
}

/** The settings and the other small files (maps.ts). */
export const MAP_RULES: ExchangeRules = { kindOf, checkChange: checkMapChange, resetUnsentSettings: true, malformed: "The settings changes didn't arrive whole." };

/** An item that can be compared and written this round. */
const usable = (rules: ExchangeRules, snapshot: MapSnapshot, key: string): boolean => {
	const kind = rules.kindOf(key);
	return !!kind && !snapshot.unreadable.has(kind) && !snapshot.unreadableKeys?.has(key);
};

const valueOf = (snapshot: MapSnapshot, key: string): unknown => snapshot.items.get(key)?.value ?? null;

/** The fingerprint of an item's value; a cached snapshot brings its own. */
const hashOf = (snapshot: MapSnapshot, key: string): string => {
	const item = snapshot.items.get(key);
	return item?.h ?? itemHash(item?.value ?? null);
};

/** When a difference found in the files happened: the file's own time, never later than now. */
function changedAt(rules: ExchangeRules, snapshot: MapSnapshot, key: string, now: number): number {
	const mtime = snapshot.items.get(key)?.mtime ?? snapshot.fileTimes.get(rules.kindOf(key)!) ?? null;
	return mtime === null ? now : Math.min(Math.round(mtime), now);
}

const costOf = (key: string, value: unknown): number => JSON.stringify(value ?? null).length + key.length + 32;

/** Changes in pages of at most `items` changes and about `bytes` bytes. There is always one page. */
function paginate(changes: MapChange[], items: number, bytes: number): MapChange[][] {
	const pages: MapChange[][] = [[]];
	let size = 0;
	for (const change of changes) {
		const cost = costOf(change.key, change.value);
		const page = pages[pages.length - 1]!;
		if (page.length > 0 && (page.length >= items || size + cost > bytes)) { pages.push([change]); size = cost; } else { page.push(change); size += cost; }
	}
	return pages;
}

// ─── The server ──────────────────────────────────────────────────────────────

export interface AuthorityMapsState {
	version: 1;
	/** Counts every change that reached the server, its own included. */
	seq: number;
	items: Record<string, { h: string; t: number; seq: number }>;
	/** Desktops that have done their first sync. */
	devices: string[];
	/**
	 * Desktops part way through a first exchange that comes in pages: which
	 * rule they are under, and the settings they sent so far.
	 */
	firsts?: Record<string, { later: boolean; sent: string[] }>;
	/** The backup made before this side's first exchange, for an instance that makes one. */
	backup?: string | null;
}

export function isAuthorityMapsState(value: unknown): value is AuthorityMapsState {
	const v = value as AuthorityMapsState | null;
	return !!v && typeof v === "object" && v.version === 1 && typeof v.seq === "number" && !!v.items && typeof v.items === "object" && Array.isArray(v.devices);
}


export interface MapsAuthority {
	exchange(deviceId: string, body: unknown): AuthorityReply;
	/**
	 * Note what changed in the server's own files, with the time it changed,
	 * without a desktop asking (Flashcards: shortly after the plugin says its
	 * library changed, so a change made on the phone keeps its own time while
	 * every PC is away). Does nothing before the first exchange ever, nor
	 * when an exchange since `since` (ms) has already looked. Items whose time
	 * can't matter (`ExchangeRules.untimed`: Flashcards' reviews, which never
	 * change) are left to the next exchange, so a review session rewrites no
	 * table.
	 */
	detect(since?: number): void;
}

/** Copied on write: the saved table stays as it was until the exchange has done its work. */
function copyOf(state: AuthorityMapsState): AuthorityMapsState {
	return { ...state, items: { ...state.items }, devices: [...state.devices], ...(state.firsts ? { firsts: { ...state.firsts } } : {}) };
}

export function createMapsAuthority(deps: {
	files: MapFiles;
	state: StateFile<AuthorityMapsState>;
	now: () => number;
	/** A desktop's vault has these top-level folders (names only). */
	onVaultFolders?: (names: string[]) => void;
	/** A desktop says its time zone (the Flashcards exchange). The receiver checks it. */
	onTimeZone?: (deviceId: string, zone: string) => void;
	/** The instance: the settings and small files when not given. */
	rules?: ExchangeRules;
	/** True while this side can't take part: the desktop is told "busy" and tries again next round. */
	busy?: () => boolean;
	/** True while this side's files can't be read at all: the desktop is told "locked", and checks cheaply next time. */
	locked?: () => boolean;
	/** Made once, right before this side's first exchange; a throw stops the exchange. */
	makeBackup?: () => string | null;
	page?: { items: number; bytes: number };
}): MapsAuthority {
	const rules = deps.rules ?? MAP_RULES;
	const page = deps.page ?? { items: PAGE_ITEMS, bytes: PAGE_BYTES };
	const bad = (error: string): AuthorityReply => ({ status: 400, body: { error } });
	/**
	 * What each desktop sent in the earlier pages of an exchange under way
	 * (memory only), so the answer's pages say "same" for those items instead
	 * of sending them back. Lost with a restart: then the values go.
	 */
	const underway = new Map<string, Map<string, string>>();

	/** When an exchange last looked at the server's own files (this process; for `detect`). */
	let lastLook = -Infinity;

	/** The items of the server's own files that differ from the table (looked at without changing anything). */
	function ownChanges(items: AuthorityMapsState["items"], snapshot: MapSnapshot, skip?: (key: string) => boolean): string[] {
		const out: string[] = [];
		const look = (key: string): void => {
			if (skip?.(key)) return;
			if (usable(rules, snapshot, key) && (items[key]?.h ?? ABSENT) !== hashOf(snapshot, key)) out.push(key);
		};
		for (const key of snapshot.items.keys()) look(key);
		for (const key in items) if (!snapshot.items.has(key)) look(key);
		return out;
	}

	/** What changed in the server's own files since the table was last brought up to date. True when something did. */
	function noteOwnChanges(state: AuthorityMapsState, snapshot: MapSnapshot, now: number, keys = ownChanges(state.items, snapshot)): boolean {
		for (const key of keys) {
			const known = state.items[key];
			// A change found here is newer than what the table had, whatever the file's time says.
			state.items[key] = { h: hashOf(snapshot, key), t: Math.max(changedAt(rules, snapshot, key, now), (known?.t ?? -1) + 1), seq: ++state.seq };
		}
		return keys.length > 0;
	}

	return {
		detect(since) {
			if (deps.locked?.()) return;
			// An exchange since then (`since`: the newest change being noted) has noted it all, with the same times.
			if (since !== undefined && lastLook >= since) return;
			const stored = deps.state.read();
			if (!stored) return;
			const snapshot = deps.files.read();
			const keys = ownChanges(stored.items, snapshot, rules.untimed);
			if (keys.length === 0) return;
			const state = copyOf(stored);
			noteOwnChanges(state, snapshot, deps.now(), keys);
			deps.state.write(state);
		},
		exchange(deviceId, body) {
			const raw = (body ?? {}) as { cursor?: unknown; all?: unknown; changes?: unknown; more?: unknown; probe?: unknown; vaultFolders?: unknown; timeZone?: unknown };
			if (typeof raw.cursor !== "number" || !Number.isInteger(raw.cursor) || raw.cursor < 0 || !Array.isArray(raw.changes) || raw.changes.length > MAX_CHANGES) {
				return bad(rules.malformed);
			}
			const incoming: MapChange[] = [];
			for (const item of raw.changes) {
				const checked = rules.checkChange(item);
				if (!checked) return bad(rules.malformed);
				incoming.push(checked);
			}
			if (Array.isArray(raw.vaultFolders)) {
				const names = raw.vaultFolders.filter(isVaultFolderName).slice(0, MAX_VAULT_FOLDERS);
				if (names.length > 0) deps.onVaultFolders?.(names);
			}
			if (deps.busy?.()) return { status: 409, body: { error: "The server is busy with this. Try again in a moment.", code: "busy" } };
			if (deps.locked?.()) return { status: 409, body: { error: "The server can't read this right now.", code: "locked" } };
			// "Can you take part again?": answered without reading or writing anything.
			if (raw.probe === true) return { status: 200, body: { cursor: raw.cursor, items: [], time: deps.now() } };

			const stored = deps.state.read();
			let state: AuthorityMapsState = stored ?? { version: 1, seq: 0, items: {}, devices: [] };
			let dirty = !stored;
			/** Copied on the first change, so a step that fails midway leaves the table as it was saved. */
			const edit = (): AuthorityMapsState => { if (state === stored) state = copyOf(stored); dirty = true; return state; };
			// Before anything this exchange may write.
			if (deps.makeBackup && state.backup === undefined) edit().backup = deps.makeBackup();
			if (typeof raw.timeZone === "string") deps.onTimeZone?.(deviceId, raw.timeZone);
			const now = deps.now();
			let snapshot = deps.files.read();
			lastLook = now;
			const own = ownChanges(state.items, snapshot);
			if (own.length > 0) noteOwnChanges(edit(), snapshot, now, own);

			const first = !state.devices.includes(deviceId);
			const progress = state.firsts?.[deviceId];
			// Only the first desktop this server ever synced with brings its values; one part
			// way through its first exchange (in pages) counts as that first one too.
			const others = state.devices.length > 0 || Object.keys(state.firsts ?? {}).some((id) => id !== deviceId);
			const later = first && (progress ? progress.later : others);
			// A desktop the server doesn't know yet must say everything it has.
			if (first && raw.all !== true) {
				if (dirty) deps.state.write(state);
				return { status: 409, body: { error: "Send everything once first.", code: "send_all" } };
			}
			const cursor = raw.cursor > state.seq ? 0 : raw.cursor;
			/** More of the desktop's changes follow, in further requests of this exchange. */
			const more = raw.more === true;
			/**
			 * Has this desktop got an item the server holds? It has seen it (its place in the
			 * list is past it), or it is sending the item now or did earlier in this exchange
			 * (a card it made, taken before an answer that was lost: its place didn't move, but it
			 * holds the card).
			 */
			const desktopHad = (key: string): boolean => {
				const known = state.items[key];
				if (!known || known.h === ABSENT) return false;
				return known.seq <= cursor || sentHere.has(key) || (underway.get(deviceId)?.has(key) ?? false);
			};
			const sentHere = new Set(incoming.map((change) => change.key));

			const sent = new Map<string, string>();
			const taken = new Map<string, { value: unknown; t: number }>();
			for (const change of incoming) {
				if (!usable(rules, snapshot, change.key)) continue;
				const h = itemHash(change.value);
				sent.set(change.key, h);
				const known = state.items[change.key];
				if ((known?.h ?? ABSENT) === h) continue;
				const t = Math.min(Math.round(change.t), now);
				if (later) {
					const here = known !== undefined && known.h !== ABSENT;
					if (rules.kindOf(change.key) === "s") {
						// The server's setting stands. One it doesn't have set is noted as
						// such, so the answer below puts the new PC back to the default too.
						if (!known) edit().items[change.key] = { h: ABSENT, t: now, seq: ++state.seq };
					} else if (!here) {
						taken.set(change.key, { value: change.value, t: known ? Math.max(t, known.t + 1) : t });
					}
					continue;
				}
				if (first || !known || t > known.t) taken.set(change.key, { value: change.value, t: first && known ? Math.max(t, known.t + 1) : t });
			}
			const settingsSent = new Set([...(progress?.sent ?? []), ...[...sent.keys()].filter((key) => rules.kindOf(key) === "s")]);
			if (first && !later && !more && rules.resetUnsentSettings) {
				// A setting the desktop hasn't set is at its default there: that wins too.
				for (const [key, known] of Object.entries(state.items)) {
					if (rules.kindOf(key) === "s" && known.h !== ABSENT && !settingsSent.has(key) && usable(rules, snapshot, key)) taken.set(key, { value: null, t: Math.max(now, known.t + 1) });
				}
			}
			if (taken.size > 0) {
				deps.files.apply(new Map([...taken].map(([key, change]) => [key, change.value])), { senderHad: desktopHad });
				// What is really there now: a file may have refused or adjusted a value.
				snapshot = deps.files.read();
				const target = edit();
				for (const [key, change] of taken) {
					if (usable(rules, snapshot, key)) target.items[key] = { h: hashOf(snapshot, key), t: change.t, seq: ++target.seq };
				}
			}
			if (first && more) {
				const sentBefore = progress?.sent ?? [];
				if (!progress || progress.later !== later || settingsSent.size !== sentBefore.length) {
					edit().firsts = { ...state.firsts, [deviceId]: { later, sent: [...settingsSent] } };
				}
			} else if (first) {
				const target = edit();
				target.devices.push(deviceId);
				if (target.firsts) {
					delete target.firsts[deviceId];
					if (Object.keys(target.firsts).length === 0) delete target.firsts;
				}
			}
			if (dirty) deps.state.write(state);

			const before = underway.get(deviceId) ?? new Map<string, string>();
			for (const [key, h] of sent) before.set(key, h);
			const items: Array<Record<string, unknown>> = [];
			const answer = (key: string, known: { h: string; t: number }): number => {
				// The desktop's own value, taken as it was: no need to send it back.
				if (before.get(key) === known.h) { items.push({ key, same: true, t: known.t }); return key.length + 32; }
				const value = valueOf(snapshot, key);
				items.push({ key, value, t: known.t });
				return costOf(key, value);
			};
			for (const key of sent.keys()) {
				const known = state.items[key];
				if (known && usable(rules, snapshot, key)) answer(key, known);
			}
			// While the desktop's changes are still coming, only they are answered.
			let replyCursor = cursor;
			let truncated = false;
			if (!more && cursor < state.seq) {
				const since: Array<[string, { h: string; t: number; seq: number }]> = [];
				for (const key in state.items) {
					const known = state.items[key]!;
					if (known.seq > cursor && !sent.has(key) && usable(rules, snapshot, key)) since.push([key, known]);
				}
				since.sort((a, b) => a[1].seq - b[1].seq);
				let size = 0;
				for (const [key, known] of since) {
					if (items.length >= page.items || size >= page.bytes) { truncated = true; break; }
					size += answer(key, known);
					replyCursor = known.seq;
				}
				if (!truncated) replyCursor = state.seq;
			} else if (!more) replyCursor = state.seq;
			if (more || truncated) underway.set(deviceId, before); else underway.delete(deviceId);
			return { status: 200, body: { cursor: replyCursor, items, time: deps.now(), ...(truncated ? { more: true } : {}) } };
		},
	};
}

// ─── A desktop ───────────────────────────────────────────────────────────────

export interface DesktopMapsState {
	version: 1;
	/** The server and device this belongs to; another server starts over. */
	server: string;
	deviceId: string;
	/** Has the first exchange (everything sent) been answered? */
	synced: boolean;
	cursor: number;
	/** key → fingerprint of the value both sides last agreed on. */
	known: Record<string, string>;
	/** This desktop's changes the server hasn't taken yet. */
	pending: Record<string, { h: string; t: number }>;
	/** The vault folder names last sent, so they go again only when they change. */
	folders: string[] | null;
	/** The server's clock minus this PC's, as last measured (ms). */
	offset: number;
	/** The time zone last sent (the Flashcards exchange), so it goes again only when it changes. */
	zone?: string | null;
	/** The backup made before this side's first exchange with this server, for an instance that makes one. */
	backup?: string | null;
}

export function isDesktopMapsState(value: unknown): value is DesktopMapsState {
	const v = value as DesktopMapsState | null;
	return !!v && typeof v === "object" && v.version === 1 && typeof v.server === "string" && typeof v.deviceId === "string"
		&& typeof v.cursor === "number" && !!v.known && typeof v.known === "object" && !!v.pending && typeof v.pending === "object";
}

export type MapsRound = { ok: true; sent: number; applied: number } | { ok: false; reason: "not-paired" | "offline" | "paused" | "refused" | "busy" };

export interface MapsDesktop {
	/**
	 * Note what changed here since the last look, with the time it changed.
	 * Needs no server: it runs while offline too, so a change made on Monday
	 * is still Monday's when the desktop reconnects on Wednesday.
	 */
	detect(): void;
	round(): Promise<MapsRound>;
}

type ReplyItem = { key: string; t: number; same?: boolean; value?: unknown };

const copyOfDesktop = (state: DesktopMapsState): DesktopMapsState => ({ ...state, known: { ...state.known }, pending: { ...state.pending } });

export function createMapsDesktop(deps: {
	files: MapFiles;
	state: StateFile<DesktopMapsState>;
	identity: () => { server: string; deviceId: string } | null;
	request: SyncRequester;
	now: () => number;
	/** The server's clock minus this PC's (ms), or null when it hasn't been measured since the app started. */
	clockOffset: () => number | null;
	/** The top-level folder names of this desktop's Obsidian vault, or null when none is connected. */
	vaultFolders?: () => string[] | null;
	/** This PC's time zone (IANA name), sent when it changes. */
	timeZone?: () => string | null;
	/** Called before the files are read when the zone is about to be sent (it differs from the one last sent, or none was); once per zone. */
	onTimeZoneChange?: (zone: string) => void;
	/** The instance: the settings and small files when not given. */
	rules?: ExchangeRules;
	/** Where the exchange is sent. */
	path?: string;
	/** True while this side can't take part: the round is skipped ("busy") and tried again next round. */
	busy?: () => boolean;
	/** True while this side's files can't be read at all: the round is skipped, with no request and nothing written. */
	locked?: () => boolean;
	/** Made once, right before this side's first exchange with a server; a throw stops the round. */
	makeBackup?: () => string | null;
	page?: { items: number; bytes: number };
}): MapsDesktop {
	const rules = deps.rules ?? MAP_RULES;
	const page = deps.page ?? { items: PAGE_ITEMS, bytes: PAGE_BYTES };
	const route = deps.path ?? "/api/sync/maps";
	let running: Promise<MapsRound> | null = null;
	/** The server said it can't read its own files: next time, ask cheaply first. */
	let serverLocked = false;
	/** The zone `onTimeZoneChange` was last called for: once per zone, also while the server keeps answering "busy". */
	let announcedZone: string | null = null;

	/** The state for the server this desktop is paired with, or null. */
	function current(): DesktopMapsState | null {
		const identity = deps.identity();
		const state = deps.state.read();
		return identity && state && state.server === identity.server && state.deviceId === identity.deviceId ? state : null;
	}

	/** Bring `pending` up to date with the files. True when it changed. */
	function note(state: DesktopMapsState, snapshot: MapSnapshot): boolean {
		const measured = deps.clockOffset();
		let changed = false;
		// To the second is plenty, and keeps a quiet round from rewriting the record.
		if (measured !== null && Math.abs(measured - state.offset) >= 1000) { state.offset = measured; changed = true; }
		const now = deps.now();
		const look = (key: string): void => {
			if (!usable(rules, snapshot, key)) return;
			const h = hashOf(snapshot, key);
			if ((state.known[key] ?? ABSENT) === h) {
				if (state.pending[key]) { delete state.pending[key]; changed = true; }
			} else if (state.pending[key]?.h !== h) {
				// Never before 1970: an item timed 0 on a PC whose clock is ahead of the server's.
				state.pending[key] = { h, t: Math.max(0, changedAt(rules, snapshot, key, now) + state.offset) };
				changed = true;
			}
		};
		for (const key of snapshot.items.keys()) look(key);
		for (const key of Object.keys(state.known)) if (!snapshot.items.has(key)) look(key);
		for (const key of Object.keys(state.pending)) if (!snapshot.items.has(key) && !(key in state.known)) look(key);
		return changed;
	}

	const agree = (state: DesktopMapsState, key: string, h: string): void => {
		if (h === ABSENT) delete state.known[key]; else state.known[key] = h;
	};

	async function round(): Promise<MapsRound> {
		const identity = deps.identity();
		if (!identity) return { ok: false, reason: "not-paired" };
		if (deps.busy?.()) return { ok: false, reason: "busy" };
		// Nothing here can be read (Flashcards: a library in a newer format, or damaged): nothing to send or take.
		if (deps.locked?.()) return { ok: false, reason: "busy" };
		if (serverLocked) {
			const probe = await deps.request(route, { method: "POST", body: { cursor: 0, all: false, changes: [], probe: true } });
			if (!probe.ok) return probe.reason === "refused" ? { ok: false, reason: "busy" } : { ok: false, reason: probe.reason };
			serverLocked = false;
		}
		for (let attempt = 0; attempt < 2; attempt++) {
			const stored = current();
			// Worked on a copy: what arrives is agreed on only once it is in the files.
			const state: DesktopMapsState = stored ? copyOfDesktop(stored) : { version: 1, server: identity.server, deviceId: identity.deviceId, synced: false, cursor: 0, known: {}, pending: {}, folders: null, offset: 0 };
			if (deps.makeBackup && state.backup === undefined) {
				state.backup = deps.makeBackup();
				deps.state.write(state);
			}
			const zone = deps.timeZone?.() ?? null;
			const sendZone = zone !== null && zone !== (state.zone ?? null);
			if (sendZone && announcedZone !== zone) { deps.onTimeZoneChange?.(zone); announcedZone = zone; }
			const snapshot = deps.files.read();
			// Some of the files can't be read this round: what they hold is left alone, and so is the
			// place in the server's list, so nothing the server has for them is passed over.
			const partial = snapshot.unreadable.size > 0;
			note(state, snapshot);
			const now = deps.now();
			const changes: MapChange[] = [];
			const sent = new Map<string, string>();
			const keys = state.synced ? Object.keys(state.pending) : [...snapshot.items.keys()];
			for (const key of keys) {
				if (!usable(rules, snapshot, key)) continue;
				const value = valueOf(snapshot, key);
				sent.set(key, hashOf(snapshot, key));
				changes.push({ key, value, t: Math.max(0, state.pending[key]?.t ?? changedAt(rules, snapshot, key, now) + state.offset) });
			}
			const folders = deps.vaultFolders?.() ?? null;
			const sendFolders = folders !== null && JSON.stringify(folders) !== JSON.stringify(state.folders);

			const pages = paginate(changes, page.items, page.bytes);
			const replies: ReplyItem[] = [];
			let cursor = state.synced ? state.cursor : 0;
			let failed: Extract<Awaited<ReturnType<SyncRequester>>, { ok: false }> | null = null;
			for (let index = 0, more = false; index < pages.length || more; index++) {
				const last = index >= pages.length - 1;
				const reply = await deps.request<{ cursor: number; items: ReplyItem[]; more?: boolean }>(route, {
					method: "POST",
					body: {
						cursor, all: !state.synced, changes: pages[index] ?? [],
						...(last ? {} : { more: true }),
						...(index === 0 && sendFolders ? { vaultFolders: folders } : {}),
						...(index === 0 && sendZone ? { timeZone: zone } : {}),
					},
				});
				if (!reply.ok) { failed = reply; break; }
				replies.push(...(Array.isArray(reply.body.items) ? reply.body.items : []));
				cursor = reply.body.cursor;
				more = reply.body.more === true;
			}
			if (failed) {
				if (failed.reason === "refused" && failed.code === "send_all" && attempt === 0) {
					// The server doesn't know this desktop (it was reset): everything goes again.
					deps.state.write({ ...state, synced: false, cursor: 0, known: {}, pending: {}, folders: null, zone: null });
					continue;
				}
				// Keep the times of what changed here; it goes when the server is back.
				if (deps.state.exists() || Object.keys(state.pending).length > 0) deps.state.write(state);
				if (failed.reason === "refused" && failed.code === "locked") { serverLocked = true; return { ok: false, reason: "busy" }; }
				if (failed.reason === "refused" && failed.code === "busy") return { ok: false, reason: "busy" };
				return { ok: false, reason: failed.reason };
			}

			// The files may have changed while the requests were under way.
			const latest = deps.files.read();
			const apply = new Map<string, unknown>();
			// An item can be answered twice in a paged exchange; the later answer counts, against what was agreed before.
			const knownBefore = { ...state.known };
			for (const item of replies) {
				if (!item || typeof item.key !== "string" || !usable(rules, latest, item.key)) continue;
				const here = hashOf(latest, item.key);
				const expected = sent.get(item.key) ?? knownBefore[item.key] ?? ABSENT;
				if (item.same) {
					if (sent.has(item.key)) { agree(state, item.key, sent.get(item.key)!); apply.delete(item.key); }
				} else {
					const theirs = itemHash(item.value ?? null);
					agree(state, item.key, theirs);
					// Changed here again meanwhile: it stays, and goes to the server next round.
					if (here === expected && here !== theirs) apply.set(item.key, item.value ?? null); else apply.delete(item.key);
				}
				if (state.pending[item.key] && state.pending[item.key]!.h === sent.get(item.key)) delete state.pending[item.key];
			}
			if (apply.size > 0) {
				// The server had what this desktop agreed on with it before, and what it sent it now.
				deps.files.apply(apply, { senderHad: (key) => key in knownBefore || sent.has(key) });
				// What is really here now is what this desktop agrees to, so a value a
				// file adjusted on the way in doesn't come back as a change of its own.
				const after = deps.files.read();
				for (const key of apply.keys()) if (usable(rules, after, key)) agree(state, key, hashOf(after, key));
			}
			// Nothing passed over: the place in the server's list moves on.
			if (!partial && latest.unreadable.size === 0) { state.cursor = cursor; state.synced = true; }
			if (sendFolders) state.folders = folders;
			if (sendZone) state.zone = zone;
			note(state, deps.files.read());
			deps.state.write(state);
			return { ok: true, sent: changes.length, applied: apply.size };
		}
		return { ok: false, reason: "busy" };
	}

	return {
		detect() {
			if (running || deps.locked?.()) return;
			const stored = current();
			if (!stored) return;
			const state = copyOfDesktop(stored);
			if (note(state, deps.files.read())) deps.state.write(state);
		},
		round() {
			if (running) return Promise.resolve({ ok: false, reason: "busy" } as MapsRound);
			running = round().finally(() => { running = null; });
			return running;
		},
	};
}
