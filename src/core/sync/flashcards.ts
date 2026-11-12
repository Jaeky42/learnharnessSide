/**
 * Flashcards sync (docs/phone-plugins-plan.md, decisions S1–S6 and
 * "Flashcards sync" under the smaller rules): the pure rules. The owner's
 * design is "combine everything": every change travels on its own, every
 * review from both devices is kept, and each fact's schedule is worked out
 * again from all its reviews. No lease, no Take over.
 *
 * The items and how they combine are in flashcards-items.ts, the replay in
 * flashcards-replay.ts. This file turns the plugin's one file
 * (core-plugin-data/flashcards/flashcards.json) into items and back.
 *
 * ─── HOW TO WIRE IT (the second per-item exchange, beside maps-sync.ts) ────
 *
 * Keep, per device, beside the exchange's own state file, the MEMORY this
 * module hands back (`FlashcardsMemory`, plain JSON). It is what this
 * device last read or wrote, and it is how a deletion is told apart from
 * "never had it": the plugin's file keeps no record of what it deleted.
 *
 *   read   (MapFiles.read)
 *     file   = flashcards.json parsed, or null when there is none
 *              (`isFlashcardsFile` false → report every kind unreadable;
 *              `flashcardsFormatTooNew(file.version)` → the same: leave it
 *              alone, never send it)
 *     result = readFlashcards(file, memory, Date.now())
 *     save result.memory when its JSON changed, BEFORE the items are sent
 *     anywhere: stamps and deletions are decided here, once
 *     items       → MapSnapshot.items (mtime: the file's mtime, every item)
 *     missing     → MapSnapshot.unreadableKeys (reviews this device had
 *                   and its file lost: left alone, never sent as gone)
 *
 *   apply  (MapFiles.apply, with the changes the exchange took)
 *     in ONE synchronous step, with no await between reading and writing,
 *     so the plugin (same process, synchronous writes) can't change the
 *     file in between:
 *       file    = flashcards.json parsed again (it may have changed)
 *       result  = applyFlashcardsChanges(file, memory, changes, { now: Date.now(), scheduler })
 *       if result.changed: write result.file (whole, atomically, as the plugin does)
 *       then save result.memory (after the file: a memory ahead of its
 *       file would read as deletions)
 *       then tell the page: plugin-message { pluginId: "flashcards", topic: "changed" }
 *     scheduler = require("plugins/flashcards/src/scheduler.cjs") (or the built copy),
 *     in a process whose time zone is the one the reviews were made in (S2)
 *
 *   the exchange
 *     kinds         flashcardsKindOf instead of maps.ts kindOf
 *     arrivals      checkFlashcardsChange instead of checkMapChange
 *     first PC      "s" is the settings kind, so the existing rule holds:
 *                   the first PC's values stand at its first sync, a PC
 *                   paired later takes the server's; a setting sent as
 *                   "not there" (null) is the plugin's default
 *     removals      readFlashcards never reports a permanent kind as gone
 *                   (PERMANENT_KINDS); one that arrives as null anyway is
 *                   ignored on apply, and the next read sends it back
 *
 * ─── WHAT IS LEFT AS IT IS IN THE FILE (device-only) ───────────────────────
 *
 * `revision` (written back as this device's + 1), each fact's `version`
 * (raised only where the fact really changed, so the plugin's open review
 * stays valid elsewhere), batches, creation and deletion receipts, the
 * model and thinking choice, the text of uploaded files, and anything the
 * plugin may add that this build doesn't know.
 */

import {
	combine, DECK_ORDER_KEY, FLASHCARDS_DEFAULT_SETTINGS, FLASHCARDS_FORMAT, flashcardsKindOf, idOf, isFlashcardsItem, ordered, PERMANENT_KINDS, reviewSettings, same,
	SYNCED_FLASHCARDS_SETTINGS, type CueItem, type DeckItem, type FileItem, type Items, type MembershipItem, type Placement, type PropItem, type ReviewItem,
} from "./flashcards-items.ts";
import { byTime, countedReviews, replayProposition, type FlashcardsScheduler, type FlashcardsSchedule, type ReplayedReview, type ReplayResult } from "./flashcards-replay.ts";

export * from "./flashcards-items.ts";
export * from "./flashcards-replay.ts";

// ─── The plugin's file ───────────────────────────────────────────────────────

export interface FlashcardsCue { id: string; question: string; answer: string; latestRating: number | null; lastReviewedAt?: number; deleted?: boolean; [field: string]: unknown }
export interface FlashcardsProposition {
	id: string; origin: string; name: string; statement: string; snapshot?: unknown; sourceId?: string;
	cues: FlashcardsCue[]; schedule: FlashcardsSchedule; firstReviewedAt: number | null; learningCueId: string | null; version: number;
	[field: string]: unknown;
}
export interface FlashcardsDeck { id: string; name: string; newLimit: number; propositionIds: string[]; sourceId?: string; [field: string]: unknown }
export interface FlashcardsReview {
	id: string; propositionId: string; cueId: string; rating: number; at: number;
	before: FlashcardsSchedule | null; after: FlashcardsSchedule | null; introduced: boolean; deckIds: string[]; settings: Record<string, unknown>;
	[field: string]: unknown;
}
export interface FlashcardsFileSource { id: string; name: string; fingerprint: string; deckId: string; deckName: string; newLimit: number; [field: string]: unknown }
export interface FlashcardsFile {
	version: number; revision: number; settings: Record<string, unknown>;
	decks: FlashcardsDeck[]; propositions: Record<string, FlashcardsProposition>; reviews: FlashcardsReview[]; batches: unknown[];
	fileSources?: Record<string, FlashcardsFileSource>; pendingSourceRemovals?: string[];
	[field: string]: unknown;
}

/** The plugin's own check when it opens its file (store.cjs): anything else it refuses to start on. */
export function isFlashcardsFile(value: unknown): value is FlashcardsFile {
	const v = value as FlashcardsFile | null;
	return !!v && typeof v === "object" && typeof v.version === "number" && Number.isSafeInteger(v.revision) && Array.isArray(v.decks)
		&& Array.isArray(v.reviews) && Array.isArray(v.batches) && !!v.propositions && typeof v.propositions === "object" && !!v.settings && typeof v.settings === "object";
}

/** A new library, as the plugin makes one. */
export function emptyFlashcardsFile(): FlashcardsFile {
	return { version: FLASHCARDS_FORMAT, revision: 0, settings: structuredClone(FLASHCARDS_DEFAULT_SETTINGS) as unknown as Record<string, unknown>, decks: [], propositions: {}, reviews: [], batches: [] };
}

// ─── The memory ──────────────────────────────────────────────────────────────

export interface FlashcardsMemory {
	version: 1;
	/** Every item but the reviews, as this device last read or wrote them. */
	items: Record<string, unknown>;
	/** The ids of every review this device has had in its file. */
	reviews: string[];
}

export function isFlashcardsMemory(value: unknown): value is FlashcardsMemory {
	const v = value as FlashcardsMemory | null;
	return !!v && typeof v === "object" && v.version === 1 && !!v.items && typeof v.items === "object" && !Array.isArray(v.items) && Array.isArray(v.reviews);
}

const toMemory = (items: Items, reviews: Iterable<string>): FlashcardsMemory => ({
	version: 1,
	items: Object.fromEntries([...items].filter(([key]) => key[0] !== "r").sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
	reviews: [...new Set(reviews)].sort(),
});

// ─── Reading ─────────────────────────────────────────────────────────────────

const liveCuesOf = (p: FlashcardsProposition): FlashcardsCue[] => (Array.isArray(p.cues) ? p.cues : []).filter((c) => c && !c.deleted);

/** The moment a fact was made, as its file shows it: a new schedule's due, or the first review's "before". */
function createdOf(p: FlashcardsProposition, reviews: readonly FlashcardsReview[]): number {
	if (p.firstReviewedAt == null) return typeof p.schedule?.due === "number" ? p.schedule.due : 0;
	const first = reviews.filter((r) => r.at === p.firstReviewedAt).sort(byTime)[0];
	const due = first?.before?.due;
	return typeof due === "number" && Number.isFinite(due) ? due : p.firstReviewedAt;
}

function propItemOf(p: FlashcardsProposition, created: number): PropItem {
	return {
		origin: p.origin, name: p.name, statement: p.statement,
		...(p.snapshot !== undefined ? { snapshot: p.snapshot } : {}),
		...(p.sourceId !== undefined ? { sourceId: p.sourceId } : {}),
		created,
	};
}

export function reviewItemOf(r: FlashcardsReview): ReviewItem {
	return { p: r.propositionId, c: r.cueId, rating: r.rating, at: r.at, deckIds: [...(r.deckIds ?? [])], settings: reviewSettings(r.settings) };
}

function reviewsByFact(reviews: readonly FlashcardsReview[]): Map<string, FlashcardsReview[]> {
	const out = new Map<string, FlashcardsReview[]>();
	for (const r of reviews) { const list = out.get(r.propositionId) ?? []; list.push(r); out.set(r.propositionId, list); }
	return out;
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((id, i) => id === b[i]);

export interface FlashcardsRead {
	/** Every item this device has, reviews included. */
	items: Items;
	/** Save this (when it changed) before the items go anywhere. */
	memory: FlashcardsMemory;
	/** Review keys this device had and its file no longer holds: leave them alone. */
	missing: Set<string>;
}

/**
 * What this device has, as items. `memory` is what the last read or write
 * of this module left (null the first time). Things the file lost since
 * are deletions made here: a deck gets an x, a card a k, a fact that went
 * an e (its reviews until now no longer count). `now` is this device's
 * clock (the clock its reviews are stamped with).
 */
export function readFlashcards(file: FlashcardsFile | null, memory: FlashcardsMemory | null, now: number): FlashcardsRead {
	const read = readAll(file, memory, now);
	const items = new Map(read.items);
	const missing = new Set(read.missing);
	// Never send what the other side would refuse: such an item is left alone on both sides.
	for (const [key, value] of items) if (!isFlashcardsItem(key, value)) { items.delete(key); missing.add(key); }
	return { items, memory: read.memory, missing };
}

/** The same, with every item, also those that wouldn't be sent. */
function readAll(file: FlashcardsFile | null, memory: FlashcardsMemory | null, now: number): FlashcardsRead {
	const known = memory ? new Map(Object.entries(memory.items)) : new Map<string, unknown>();
	const { items, placement: expected } = combine(known);
	const knownReviews = new Set(memory?.reviews ?? []);
	if (!file) {
		// No file but a memory: the file went missing. Say nothing went; the next write puts it back.
		return { items, memory: toMemory(items, knownReviews), missing: new Set([...knownReviews].map((id) => `r|${id}`)) };
	}
	let counter = 0;
	const base = Math.round(now) * 1000;
	const stamp = (): number => base + counter++;
	const deleted = (kind: "x" | "k", id: string): boolean => items.has(`${kind}|${id}`);

	for (const name of SYNCED_FLASHCARDS_SETTINGS) {
		const value = file.settings[name];
		if (value !== undefined && !same(value, items.get(`s|${name}`))) items.set(`s|${name}`, Array.isArray(value) ? [...value] : value);
	}

	// Decks. One that came back after it was deleted is a stale copy: the next write removes it again.
	const decks = file.decks.filter((d) => d && typeof d.id === "string" && !deleted("x", d.id));
	const deckIds = new Set(decks.map((d) => d.id));
	for (const d of decks) {
		const key = `d|${d.id}`;
		const old = items.get(key) as DeckItem | undefined;
		const fields = { name: d.name, newLimit: d.newLimit, ...(d.sourceId !== undefined ? { sourceId: d.sourceId } : {}) };
		if (old && same({ name: old.name, newLimit: old.newLimit, ...(old.sourceId !== undefined ? { sourceId: old.sourceId } : {}) }, fields)) continue;
		items.set(key, { ...fields, s: old?.s ?? stamp(), at: now } satisfies DeckItem);
	}
	for (const d of expected.decks) if (!deckIds.has(d.id)) items.set(`x|${d.id}`, 1);
	const deckList = decks.map((d) => d.id);
	if (!sameList(deckList, ordered(items.get(DECK_ORDER_KEY), deckList, (id) => (items.get(`d|${id}`) as DeckItem).s))) items.set(DECK_ORDER_KEY, deckList);

	// Facts and their cards.
	const byFact = reviewsByFact(file.reviews);
	const present = new Set<string>();
	for (const p of Object.values(file.propositions)) {
		if (!p || typeof p.id !== "string") continue;
		const cues = liveCuesOf(p).filter((c) => !deleted("k", c.id));
		if (cues.length === 0) continue;
		present.add(p.id);
		const created = createdOf(p, byFact.get(p.id) ?? []);
		const fact = propItemOf(p, created);
		const was = expected.props.get(p.id);
		const old = items.get(`p|${p.id}`) as PropItem | undefined;
		// Deleted and made again between two looks: none of its cards is left, and it was made anew.
		if (was && old && old.created !== created && !cues.some((c) => was.cues.some((w) => w.id === c.id))) items.set(`e|${p.id}`, created - 1);
		// Made again here after its deletion was noted: its own reviews count, however soon they came.
		const epoch = items.get(`e|${p.id}`);
		if (!was && typeof epoch === "number" && epoch >= created) items.set(`e|${p.id}`, created - 1);
		if (!same(old, fact)) items.set(`p|${p.id}`, fact);
		const ids = new Set<string>();
		for (const c of cues) {
			ids.add(c.id);
			const key = `c|${c.id}`;
			const prior = items.get(key) as CueItem | undefined;
			const fields = { p: p.id, q: c.question, a: c.answer };
			if (prior && same({ p: prior.p, q: prior.q, a: prior.a }, fields)) continue;
			items.set(key, { ...fields, s: prior?.s ?? stamp() } satisfies CueItem);
		}
		if (was) for (const w of was.cues) if (!ids.has(w.id)) { items.set(`k|${w.id}`, 1); items.delete(`c|${w.id}`); }
		const list = cues.map((c) => c.id);
		if (!sameList(list, ordered(items.get(`u|${p.id}`), list, (id) => (items.get(`c|${id}`) as CueItem).s))) items.set(`u|${p.id}`, list);
	}
	for (const [id, was] of expected.props) {
		if (present.has(id)) continue;
		items.set(`e|${id}`, now);
		for (const w of was.cues) { items.set(`k|${w.id}`, 1); items.delete(`c|${w.id}`); }
	}

	// Which decks each fact is in, and the order inside each deck.
	const memberships = new Map<string, MembershipItem>();
	for (const d of decks) for (const id of new Set(d.propositionIds)) {
		if (!present.has(id)) continue;
		const old = items.get(`m|${id}`) as MembershipItem | undefined;
		const next = memberships.get(id) ?? {};
		next[d.id] = old?.[d.id] ?? stamp();
		memberships.set(id, next);
	}
	for (const id of present) {
		const next = memberships.get(id);
		// A fact in no deck isn't something the plugin makes; keep what was known.
		if (next && !same(next, items.get(`m|${id}`))) items.set(`m|${id}`, next);
	}
	for (const d of decks) {
		const list = [...new Set(d.propositionIds)].filter((id) => present.has(id));
		const key = `q|${d.id}`;
		if (!sameList(list, ordered(items.get(key), list, (id) => (items.get(`m|${id}`) as MembershipItem | undefined)?.[d.id] ?? Infinity))) items.set(key, list);
	}

	for (const source of Object.values(file.fileSources ?? {})) {
		if (!source || typeof source.id !== "string") continue;
		const record: FileItem = { name: source.name, fingerprint: source.fingerprint, deckId: source.deckId };
		if (!same(record, items.get(`f|${source.id}`))) items.set(`f|${source.id}`, record);
	}

	const inFile = new Set<string>();
	for (const r of file.reviews) {
		if (!r || typeof r.id !== "string") continue;
		inFile.add(r.id);
		items.set(`r|${r.id}`, reviewItemOf(r));
	}
	const missing = new Set([...knownReviews].filter((id) => !inFile.has(id)).map((id) => `r|${id}`));
	return { items, memory: toMemory(items, [...inFile, ...knownReviews]), missing };
}

// ─── Applying ────────────────────────────────────────────────────────────────

export interface FlashcardsApplied {
	/** The file to write; the same object as the one passed in when nothing changed. */
	file: FlashcardsFile | null;
	changed: boolean;
	memory: FlashcardsMemory;
}

/**
 * Put changes the exchange took into this device's file. `changes` holds
 * values, or null for "not there". The library is combined (flashcards-items.ts
 * `combine`), every fact whose reviews changed gets its schedule worked out
 * again, and the file is written back with everything device-only kept.
 */
export function applyFlashcardsChanges(file: FlashcardsFile | null, memory: FlashcardsMemory | null, changes: ReadonlyMap<string, unknown>, deps: { now: number; scheduler: FlashcardsScheduler }): FlashcardsApplied {
	const read = readAll(file, memory, deps.now);
	const before = read.items;
	const items = new Map(before);
	for (const [key, value] of changes) {
		const kind = flashcardsKindOf(key);
		if (!kind) continue;
		if (value === null || value === undefined) {
			if (!PERMANENT_KINDS.has(kind)) items.delete(key);
		} else items.set(key, value);
	}
	const { items: combined, placement } = combine(items);
	const reviews = new Map<string, ReviewItem>();
	for (const [key, value] of combined) if (key[0] === "r") reviews.set(idOf(key), value as ReviewItem);
	const written = writeBack(file, placement, reviews, combined, before, deps.scheduler);
	const memoryReviews = [...reviews.keys(), ...[...read.missing].map(idOf)];
	return { file: written.file, changed: written.changed, memory: toMemory(combined, memoryReviews) };
}

/**
 * Work every fact's schedule out again from its reviews, whatever changed
 * (for tests and checks). `memory` says which facts were deleted and made
 * again; without it every review of a fact counts.
 */
export function rebuildFlashcards(file: FlashcardsFile, memory: FlashcardsMemory | null, scheduler: FlashcardsScheduler, now = 0): FlashcardsFile {
	const read = readAll(file, memory, now);
	const { items, placement } = combine(read.items);
	const reviews = new Map<string, ReviewItem>();
	for (const [key, value] of items) if (key[0] === "r") reviews.set(idOf(key), value as ReviewItem);
	return writeBack(file, placement, reviews, items, read.items, scheduler, true).file!;
}

/**
 * The file as it is after combining: everything device-only kept from this
 * device's file, a fact's version raised only where the fact changed, and
 * the plugin's own shapes and key order, so an exchange that changed
 * nothing writes nothing. Nothing passed in is changed; what didn't change
 * is shared with `local`, not copied.
 */
function writeBack(local: FlashcardsFile | null, placement: Placement, reviews: Map<string, ReviewItem>, combined: Items, before: Items, scheduler: FlashcardsScheduler, everything = false): { file: FlashcardsFile | null; changed: boolean } {
	if (!local && placement.decks.length === 0 && reviews.size === 0 && placement.settings.size === 0) return { file: null, changed: false };
	const base = local ?? emptyFlashcardsFile();
	let dirty = !local;
	const json = JSON.stringify;

	const settings = { ...base.settings };
	for (const name of SYNCED_FLASHCARDS_SETTINGS) {
		const value = placement.settings.has(name) ? placement.settings.get(name) : FLASHCARDS_DEFAULT_SETTINGS[name];
		if (json(value) !== json(base.settings[name])) { settings[name] = Array.isArray(value) ? [...value] : value; dirty = true; }
	}

	const localDecks = new Map(base.decks.map((d) => [d.id, d]));
	const decks = placement.decks.map(({ id, item, members }) => {
		const old = localDecks.get(id);
		const d: FlashcardsDeck = old ? { ...old } : { id, name: item.name, ...(item.sourceId !== undefined ? { sourceId: item.sourceId } : {}), newLimit: item.newLimit, propositionIds: [] };
		d.name = item.name;
		d.newLimit = item.newLimit;
		if (item.sourceId !== undefined) d.sourceId = item.sourceId; else delete d.sourceId;
		d.propositionIds = members;
		return d;
	});
	if (json(decks) !== json(base.decks)) dirty = true;

	// Reviews per fact, and which ones count.
	const byFact = new Map<string, Array<ReviewItem & { id: string }>>();
	for (const [id, r] of reviews) { const list = byFact.get(r.p) ?? []; list.push({ ...r, id }); byFact.set(r.p, list); }
	const localReviews = reviewsByFact(base.reviews);
	const localIds = new Set(base.reviews.map((r) => r.id));
	// A card still in the file keeps its reviews whatever the fact's deletion time says.
	const counted = (fact: string, epoch: number | undefined): Array<ReviewItem & { id: string }> => {
		const cards = new Set(placement.props.get(fact)?.cues.map((c) => c.id) ?? []);
		return countedReviews(byFact.get(fact) ?? [], epoch, (r) => cards.has(r.c)).sort(byTime);
	};
	const replayed = new Map<string, ReplayedReview>();
	const replay = (created: number, list: ReadonlyArray<ReviewItem & { id: string }>): ReplayResult => {
		const result = replayProposition(created, list.map((r) => ({ id: r.id, cueId: r.c, rating: r.rating, at: r.at, settings: r.settings })), scheduler);
		for (const [id, value] of result.reviews) replayed.set(id, value);
		return result;
	};

	const localProps = base.propositions;
	const order = [...Object.keys(localProps).filter((id) => placement.props.has(id)), ...[...placement.props.keys()].filter((id) => !Object.hasOwn(localProps, id))];
	if (!sameList(order, Object.keys(localProps))) dirty = true;
	const propositions: Record<string, FlashcardsProposition> = {};
	const rebuilt = new Set<string>();
	for (const id of order) {
		const placed = placement.props.get(id)!;
		const old = Object.hasOwn(localProps, id) ? localProps[id] : undefined;
		const item = placed.item;
		const p: FlashcardsProposition = old ? { ...old } : {
			id, origin: item.origin, ...(item.sourceId !== undefined ? { sourceId: item.sourceId } : {}), name: item.name, statement: item.statement,
			...(item.snapshot !== undefined ? { snapshot: item.snapshot } : {}),
			cues: [], schedule: scheduler.createSchedule(item.created), firstReviewedAt: null, learningCueId: null, version: 0,
		};
		p.origin = item.origin; p.name = item.name; p.statement = item.statement;
		if (item.snapshot !== undefined) { if (!old || json(old.snapshot) !== json(item.snapshot)) p.snapshot = item.snapshot; } else delete p.snapshot;
		if (item.sourceId !== undefined) p.sourceId = item.sourceId; else delete p.sourceId;
		const oldCues = new Map(old ? liveCuesOf(old).map((c) => [c.id, c]) : []);
		p.cues = placed.cues.map(({ id: cueId, item: cue }) => {
			const prior = oldCues.get(cueId);
			const c: FlashcardsCue = prior ? { ...prior } : { id: cueId, question: cue.q, answer: cue.a, latestRating: null };
			c.question = cue.q; c.answer = cue.a;
			return c;
		});
		const now = counted(id, placement.epochs.get(id));
		const oldCards = new Set(oldCues.keys());
		const was = old ? countedReviews(localReviews.get(id) ?? [], before.get(`e|${id}`) as number | undefined, (r) => oldCards.has(r.cueId)).sort(byTime).map((r) => r.id) : null;
		// Worked out again when its reviews, its cards or the moment it was made differ from the file's.
		const affected = everything || !old || !sameList(was!, now.map((r) => r.id)) || createdOf(old, localReviews.get(id) ?? []) !== item.created
			|| !sameList([...oldCards].sort(), p.cues.map((c) => c.id).sort());
		if (affected) {
			rebuilt.add(id);
			const result = replay(item.created, now);
			p.schedule = result.schedule;
			p.firstReviewedAt = result.firstReviewedAt;
			p.learningCueId = result.learningCueId;
			for (const c of p.cues) {
				const latest = result.cues.get(c.id);
				c.latestRating = latest?.rating ?? null;
				if (latest) c.lastReviewedAt = latest.at; else delete c.lastReviewedAt;
			}
		}
		if (!p.cues.some((c) => c.id === p.learningCueId)) p.learningCueId = null;
		if (!old) { propositions[id] = p; dirty = true; }
		// The same content (perhaps in another key order) isn't a change: the plugin's own object stays.
		else if (json(p) === json(old) || same({ ...p, version: 0 }, { ...old, version: 0 })) propositions[id] = old;
		else { p.version = old.version + 1; propositions[id] = p; dirty = true; }
	}

	// Reviews that arrived for a fact that wasn't worked out again (one not in the file), and
	// those from before its latest deletion, are worked out as chains of their own. A review
	// that no longer counts keeps what its device worked out; nothing reads those fields but the
	// plugin's charts of past days.
	const fresh = new Set<string>();
	for (const fact of rebuilt) for (const r of counted(fact, placement.epochs.get(fact))) fresh.add(r.id);
	for (const [fact, list] of byFact) {
		if (!list.some((r) => !localIds.has(r.id))) continue;
		const after = counted(fact, placement.epochs.get(fact));
		const counts = new Set(after.map((r) => r.id));
		const earlier = list.filter((r) => !counts.has(r.id)).sort(byTime);
		const created = (combined.get(`p|${fact}`) as PropItem | undefined)?.created;
		if (earlier.length > 0) replay(created !== undefined && created <= earlier[0]!.at ? created : earlier[0]!.at, earlier);
		if (!rebuilt.has(fact) && after.length > 0) replay(created ?? after[0]!.at, after);
	}
	const nextReviews = base.reviews.map((r) => {
		const derived = fresh.has(r.id) ? replayed.get(r.id) : undefined;
		if (!derived || (derived.introduced === r.introduced && json(derived.before) === json(r.before) && json(derived.after) === json(r.after))) return r;
		dirty = true;
		return { ...r, before: derived.before, after: derived.after, introduced: derived.introduced };
	});
	const arrived = [...reviews].filter(([id]) => !localIds.has(id)).map(([id, r]) => ({ ...r, id })).sort(byTime);
	for (const r of arrived) {
		const derived = replayed.get(r.id);
		nextReviews.push({
			id: r.id, propositionId: r.p, cueId: r.c, rating: r.rating, at: r.at,
			before: derived?.before ?? null, after: derived?.after ?? null, introduced: derived?.introduced ?? false,
			deckIds: [...r.deckIds], settings: r.settings,
		});
		dirty = true;
	}

	// Uploaded-file records: name and fingerprint travel; the deck's name and limit are mirrored as the plugin does.
	const localSources = base.fileSources ?? {};
	const deckItems = new Map(placement.decks.map((d) => [d.id, d.item]));
	const sources: Record<string, FlashcardsFileSource> = {};
	const sourceOrder = [...Object.keys(localSources).filter((id) => placement.files.has(id)), ...[...placement.files.keys()].filter((id) => !Object.hasOwn(localSources, id)).sort()];
	for (const id of sourceOrder) {
		const record = placement.files.get(id)!;
		const deck = deckItems.get(record.deckId)!;
		const old = Object.hasOwn(localSources, id) ? localSources[id] : undefined;
		const s: FlashcardsFileSource = old ? { ...old } : { id, name: record.name, fingerprint: record.fingerprint, deckId: record.deckId, deckName: deck.name, newLimit: deck.newLimit };
		s.name = record.name; s.fingerprint = record.fingerprint; s.deckId = record.deckId; s.deckName = deck.name; s.newLimit = deck.newLimit;
		sources[id] = s;
	}
	const next: FlashcardsFile = { ...base, settings, decks, propositions, reviews: nextReviews };
	if (base.fileSources !== undefined || sourceOrder.length > 0) {
		next.fileSources = sources;
		if (json(sources) !== json(base.fileSources ?? {})) dirty = true;
	}
	// A record that went: its saved text goes too, by the plugin's own clean-up queue.
	const gone = Object.keys(localSources).filter((id) => !placement.files.has(id));
	if (gone.length > 0) { next.pendingSourceRemovals = [...new Set([...(base.pendingSourceRemovals ?? []), ...gone])]; dirty = true; }

	if (local && !dirty) return { file: local, changed: false };
	next.revision = base.revision + 1;
	return { file: next, changed: true };
}
