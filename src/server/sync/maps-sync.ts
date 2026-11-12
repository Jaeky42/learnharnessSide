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
 */

import { ABSENT, checkMapChange, isVaultFolderName, itemHash, kindOf, MAX_VAULT_FOLDERS, type MapChange } from "../../core/sync/maps.ts";
import type { StateFile } from "../../store/sync/state-file.ts";
import type { AuthorityReply } from "./authority.ts";
import type { SyncRequester } from "./desktop-sync.ts";
import type { MapFiles, MapSnapshot } from "./map-views.ts";

const MAX_CHANGES = 50_000;

/** An item that can be compared and written this round. */
const usable = (snapshot: MapSnapshot, key: string): boolean => {
	const kind = kindOf(key);
	return !!kind && !snapshot.unreadable.has(kind) && !snapshot.unreadableKeys?.has(key);
};

const valueOf = (snapshot: MapSnapshot, key: string): unknown => snapshot.items.get(key)?.value ?? null;

/** When a difference found in the files happened: the file's own time, never later than now. */
function changedAt(snapshot: MapSnapshot, key: string, now: number): number {
	const mtime = snapshot.items.get(key)?.mtime ?? snapshot.fileTimes.get(kindOf(key)!) ?? null;
	return mtime === null ? now : Math.min(Math.round(mtime), now);
}

// ─── The server ──────────────────────────────────────────────────────────────

export interface AuthorityMapsState {
	version: 1;
	/** Counts every change that reached the server, its own included. */
	seq: number;
	items: Record<string, { h: string; t: number; seq: number }>;
	/** Desktops that have done their first sync. */
	devices: string[];
}

export function isAuthorityMapsState(value: unknown): value is AuthorityMapsState {
	const v = value as AuthorityMapsState | null;
	return !!v && typeof v === "object" && v.version === 1 && typeof v.seq === "number" && !!v.items && typeof v.items === "object" && Array.isArray(v.devices);
}

export interface MapsAuthority {
	exchange(deviceId: string, body: unknown): AuthorityReply;
}

export function createMapsAuthority(deps: {
	files: MapFiles;
	state: StateFile<AuthorityMapsState>;
	now: () => number;
	/** A desktop's vault has these top-level folders (names only). */
	onVaultFolders?: (names: string[]) => void;
}): MapsAuthority {
	const bad = (error: string): AuthorityReply => ({ status: 400, body: { error } });

	/** What changed in the server's own files since the table was last brought up to date. */
	function noteOwnChanges(state: AuthorityMapsState, snapshot: MapSnapshot, now: number): void {
		for (const key of new Set([...snapshot.items.keys(), ...Object.keys(state.items)])) {
			if (!usable(snapshot, key)) continue;
			const h = itemHash(valueOf(snapshot, key));
			const known = state.items[key];
			if ((known?.h ?? ABSENT) === h) continue;
			// A change found here is newer than what the table had, whatever the file's time says.
			state.items[key] = { h, t: Math.max(changedAt(snapshot, key, now), (known?.t ?? -1) + 1), seq: ++state.seq };
		}
	}

	return {
		exchange(deviceId, body) {
			const raw = (body ?? {}) as { cursor?: unknown; all?: unknown; changes?: unknown; vaultFolders?: unknown };
			if (typeof raw.cursor !== "number" || !Number.isInteger(raw.cursor) || raw.cursor < 0 || !Array.isArray(raw.changes) || raw.changes.length > MAX_CHANGES) {
				return bad("The settings changes didn't arrive whole.");
			}
			const incoming: MapChange[] = [];
			for (const item of raw.changes) {
				const checked = checkMapChange(item);
				if (!checked) return bad("The settings changes didn't arrive whole.");
				incoming.push(checked);
			}
			if (Array.isArray(raw.vaultFolders)) {
				const names = raw.vaultFolders.filter(isVaultFolderName).slice(0, MAX_VAULT_FOLDERS);
				if (names.length > 0) deps.onVaultFolders?.(names);
			}

			const now = deps.now();
			const state: AuthorityMapsState = deps.state.read() ?? { version: 1, seq: 0, items: {}, devices: [] };
			let snapshot = deps.files.read();
			noteOwnChanges(state, snapshot, now);

			const first = !state.devices.includes(deviceId);
			// Only the first desktop this server ever synced with brings its values.
			const later = first && state.devices.length > 0;
			// A desktop the server doesn't know yet must say everything it has.
			if (first && raw.all !== true) {
				deps.state.write(state);
				return { status: 409, body: { error: "Send everything once first.", code: "send_all" } };
			}
			const cursor = raw.cursor > state.seq ? 0 : raw.cursor;

			const sent = new Map<string, string>();
			const taken = new Map<string, { value: unknown; t: number }>();
			for (const change of incoming) {
				if (!usable(snapshot, change.key)) continue;
				const h = itemHash(change.value);
				sent.set(change.key, h);
				const known = state.items[change.key];
				if ((known?.h ?? ABSENT) === h) continue;
				const t = Math.min(Math.round(change.t), now);
				if (later) {
					const here = known !== undefined && known.h !== ABSENT;
					if (kindOf(change.key) === "s") {
						// The server's setting stands. One it doesn't have set is noted as
						// such, so the answer below puts the new PC back to the default too.
						if (!known) state.items[change.key] = { h: ABSENT, t: now, seq: ++state.seq };
					} else if (!here) {
						taken.set(change.key, { value: change.value, t: known ? Math.max(t, known.t + 1) : t });
					}
					continue;
				}
				if (first || !known || t > known.t) taken.set(change.key, { value: change.value, t: first && known ? Math.max(t, known.t + 1) : t });
			}
			if (first && !later) {
				// A setting the desktop hasn't set is at its default there: that wins too.
				for (const [key, known] of Object.entries(state.items)) {
					if (kindOf(key) === "s" && known.h !== ABSENT && !sent.has(key) && usable(snapshot, key)) taken.set(key, { value: null, t: Math.max(now, known.t + 1) });
				}
			}
			if (taken.size > 0) {
				deps.files.apply(new Map([...taken].map(([key, change]) => [key, change.value])));
				// What is really there now: a file may have refused or adjusted a value.
				snapshot = deps.files.read();
				for (const [key, change] of taken) {
					if (usable(snapshot, key)) state.items[key] = { h: itemHash(valueOf(snapshot, key)), t: change.t, seq: ++state.seq };
				}
			}
			if (first) state.devices.push(deviceId);
			deps.state.write(state);

			const items: Array<Record<string, unknown>> = [];
			for (const [key, known] of Object.entries(state.items)) {
				if (!usable(snapshot, key) || (known.seq <= cursor && !sent.has(key))) continue;
				// The desktop's own value, taken as it was: no need to send it back.
				if (sent.get(key) === known.h) items.push({ key, same: true, t: known.t });
				else items.push({ key, value: valueOf(snapshot, key), t: known.t });
			}
			return { status: 200, body: { cursor: state.seq, items, time: deps.now() } };
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
}): MapsDesktop {
	let running: Promise<MapsRound> | null = null;

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
		for (const key of new Set([...snapshot.items.keys(), ...Object.keys(state.known), ...Object.keys(state.pending)])) {
			if (!usable(snapshot, key)) continue;
			const h = itemHash(valueOf(snapshot, key));
			if ((state.known[key] ?? ABSENT) === h) {
				if (state.pending[key]) { delete state.pending[key]; changed = true; }
			} else if (state.pending[key]?.h !== h) {
				state.pending[key] = { h, t: changedAt(snapshot, key, now) + state.offset };
				changed = true;
			}
		}
		return changed;
	}

	const agree = (state: DesktopMapsState, key: string, h: string): void => {
		if (h === ABSENT) delete state.known[key]; else state.known[key] = h;
	};

	async function round(): Promise<MapsRound> {
		const identity = deps.identity();
		if (!identity) return { ok: false, reason: "not-paired" };
		for (let attempt = 0; attempt < 2; attempt++) {
			const state: DesktopMapsState = current() ?? { version: 1, server: identity.server, deviceId: identity.deviceId, synced: false, cursor: 0, known: {}, pending: {}, folders: null, offset: 0 };
			const snapshot = deps.files.read();
			note(state, snapshot);
			const now = deps.now();
			const changes: MapChange[] = [];
			const sent = new Map<string, string>();
			const keys = state.synced ? Object.keys(state.pending) : [...snapshot.items.keys()];
			for (const key of keys) {
				if (!usable(snapshot, key)) continue;
				const value = valueOf(snapshot, key);
				sent.set(key, itemHash(value));
				changes.push({ key, value, t: state.pending[key]?.t ?? changedAt(snapshot, key, now) + state.offset });
			}
			const folders = deps.vaultFolders?.() ?? null;
			const sendFolders = folders !== null && JSON.stringify(folders) !== JSON.stringify(state.folders);

			const reply = await deps.request<{ cursor: number; items: ReplyItem[] }>("/api/sync/maps", {
				method: "POST",
				body: { cursor: state.synced ? state.cursor : 0, all: !state.synced, changes, ...(sendFolders ? { vaultFolders: folders } : {}) },
			});
			if (!reply.ok) {
				if (reply.reason === "refused" && reply.code === "send_all" && attempt === 0) {
					// The server doesn't know this desktop (it was reset): everything goes again.
					deps.state.write({ ...state, synced: false, cursor: 0, known: {}, pending: {}, folders: null });
					continue;
				}
				// Keep the times of what changed here; it goes when the server is back.
				if (deps.state.exists() || Object.keys(state.pending).length > 0) deps.state.write(state);
				return { ok: false, reason: reply.reason };
			}

			// The files may have changed while the request was under way.
			const latest = deps.files.read();
			const apply = new Map<string, unknown>();
			for (const item of reply.body.items) {
				if (!item || typeof item.key !== "string" || !usable(latest, item.key)) continue;
				const here = itemHash(valueOf(latest, item.key));
				const expected = sent.get(item.key) ?? state.known[item.key] ?? ABSENT;
				if (item.same) {
					if (sent.has(item.key)) agree(state, item.key, sent.get(item.key)!);
				} else {
					const theirs = itemHash(item.value ?? null);
					agree(state, item.key, theirs);
					// Changed here again meanwhile: it stays, and goes to the server next round.
					if (here === expected && here !== theirs) apply.set(item.key, item.value ?? null);
				}
				if (state.pending[item.key] && state.pending[item.key]!.h === sent.get(item.key)) delete state.pending[item.key];
			}
			if (apply.size > 0) {
				deps.files.apply(apply);
				// What is really here now is what this desktop agrees to, so a value a
				// file adjusted on the way in doesn't come back as a change of its own.
				const after = deps.files.read();
				for (const key of apply.keys()) if (usable(after, key)) agree(state, key, itemHash(valueOf(after, key)));
			}
			state.cursor = reply.body.cursor;
			state.synced = true;
			if (sendFolders) state.folders = folders;
			note(state, deps.files.read());
			deps.state.write(state);
			return { ok: true, sent: changes.length, applied: apply.size };
		}
		return { ok: false, reason: "busy" };
	}

	return {
		detect() {
			if (running) return;
			const state = current();
			if (!state) return;
			if (note(state, deps.files.read())) deps.state.write(state);
		},
		round() {
			if (running) return Promise.resolve({ ok: false, reason: "busy" } as MapsRound);
			running = round().finally(() => { running = null; });
			return running;
		},
	};
}
