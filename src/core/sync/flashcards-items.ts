/**
 * Flashcards sync (docs/phone-plugins-plan.md, "Flashcards sync"): the
 * shared items a Flashcards library is made of, what may arrive, and the
 * rules that combine them. Pure. The file itself is turned into items and
 * back by flashcards.ts.
 *
 * THE ITEMS. Every key is `<kind>|<id>`; each travels on its own, latest
 * change wins (the per-item exchange of maps.ts / maps-sync.ts):
 *
 *   s|<setting>    retention, learningSteps, relearningSteps, dayStart, chunkBudget
 *   d|<deck id>    a deck: { name, newLimit, sourceId?, s, at }
 *   x|<deck id>    a deck was deleted (1)
 *   o|decks        the deck order, once someone changed it (deck ids)
 *   q|<deck id>    the order of the facts in a deck, once changed (fact ids)
 *   p|<fact id>    a fact (proposition): { origin, name, statement, snapshot?, sourceId?, created }
 *   e|<fact id>    the fact was deleted at this time: earlier reviews don't count (ms)
 *   m|<deck id>|<fact id>
 *                  the fact in that deck, or taken out of it: { in, s }
 *   c|<card id>    a card (cue): { p: fact id, q: question, a: answer, s }
 *   k|<card id>    the card was deleted (1): final, whatever was edited later
 *   u|<fact id>    the order of a fact's cards, once changed (card ids)
 *   r|<review id>  one review, never changed: { p, c, rating, at, deckIds, settings }
 *   f|<source id>  an uploaded file's record: { name, fingerprint, deckId }
 *
 * WHY THIS SHAPE (each owner rule, and how it holds when two devices change
 * different things while apart):
 *
 * - Nothing is ever deleted by a missing item. A deletion is an item of its
 *   own (x, k, e); the parts of a deck or fact stay (d, p, m, u, q), so a
 *   deck deleted on one device while a card was put in it on the other
 *   still has its name, and a fact still has its text. Latest-change-wins
 *   only ever chooses between two values, never between a value and a
 *   deletion.
 * - A delete always wins for a card: k is never taken back, and a card with
 *   a k is gone whatever its c says. Its c is then removed, to keep the
 *   library small.
 * - A deck that still has cards after combining stays (its x is cleared),
 *   and a fact is never left without a deck: a fact can only be placed in a
 *   deck that exists, and a deck with a fact in it exists.
 * - A fact deleted and made again starts fresh: e says from when its
 *   reviews count (a review of a card that is still there always counts).
 *   A fact is alive while it has a card. Its moment of making (`created`)
 *   travels, so a fact nobody reviewed yet has the same schedule everywhere.
 * - Membership (m) is per fact AND deck, the deck's name and limit (d) per
 *   deck, and orders are items of their own: cards generated into a deck on
 *   one device and the deck renamed on the other touch different items, and
 *   both stay. A fact put into a deck on one device and into another deck
 *   on the other is in both afterwards (nothing a first sync combines is
 *   dropped); taking it out of a deck is an item of its own ({ in: false })
 *   and travels like any change. If every deck a fact was in took it out,
 *   it stays where it was put last (a fact is never left in no deck).
 * - Order: an order item only exists once someone really reordered (o, q,
 *   u). Adding at the end changes no order item; what an order doesn't
 *   know follows it, in the order it was added (the stamp `s`, then the
 *   id), so the later reorder wins and anything it doesn't know comes
 *   after, as the owner asked.
 * - Two decks from the same session or source (sourceId), or made from the
 *   same uploaded file (fingerprint), are joined: the earliest made (s,
 *   then id) stays; name and limit come from the most recently changed (at,
 *   then id).
 * - The same question, word for word after trimming, twice on one fact,
 *   when the two cards meet for the first time from two devices (one
 *   device had one, the other device had the other, neither had both): the
 *   earlier card (s, then id) stays, the other gets a k. The device that
 *   takes in the second card decides (`duplicateDeletions`). Two cards a
 *   device already holds together are both kept, there and everywhere.
 *
 * `s` is a stamp: when the device that made the thing first saw it (ms ×
 * 1000 + a counter, so things seen in one look keep their order). `at` on a
 * deck: when its name or limit last changed.
 */

import { canonical } from "./maps.ts";

/** The Flashcards file format this build reads and writes (flashcards.json `version`). */
export const FLASHCARDS_FORMAT = 1;

/** The format lock: a file (or its `version`) newer than this build reads is neither sent nor taken. */
export function flashcardsFormatTooNew(version: unknown): boolean {
	return typeof version === "number" && version > FLASHCARDS_FORMAT;
}

/** The scheduling settings and the chunk budget travel; the model choice never does. */
export const SYNCED_FLASHCARDS_SETTINGS = ["retention", "learningSteps", "relearningSteps", "dayStart", "chunkBudget"] as const;
export type SyncedFlashcardsSetting = (typeof SYNCED_FLASHCARDS_SETTINGS)[number];

/** The plugin's own defaults (plugins/flashcards/src/store.cjs `defaults()`); a test keeps them equal. */
export const FLASHCARDS_DEFAULT_SETTINGS = { retention: 0.9, learningSteps: [1, 10], relearningSteps: [10], dayStart: 4, fuzz: false, chunkBudget: 4000, modelOverride: null } as const;

/** What a review's own copy of the settings keeps when it travels. */
const REVIEW_SETTINGS = ["retention", "learningSteps", "relearningSteps", "dayStart", "fuzz", "chunkBudget"] as const;

export const FLASHCARDS_KINDS = ["s", "d", "x", "o", "q", "p", "e", "m", "c", "k", "u", "r", "f"] as const;
export type FlashcardsKind = (typeof FLASHCARDS_KINDS)[number];

/**
 * Kinds whose items are never removed by a missing value: an arriving "not
 * there" is ignored, and this device's next read sends its value back. A
 * card's c goes only with its k (a deleted card), and a device that has the k
 * removes the c by itself. Only a setting ("back to the default") and a
 * deck's x (cleared when the deck keeps a fact) can arrive as "not there".
 */
export const PERMANENT_KINDS: ReadonlySet<FlashcardsKind> = new Set(["d", "o", "q", "p", "e", "m", "c", "k", "u", "r", "f"]);

export const DECK_ORDER_KEY = "o|decks";

export function flashcardsKindOf(key: string): FlashcardsKind | null {
	const kind = key[0] as FlashcardsKind;
	return key[1] === "|" && key.length > 2 && FLASHCARDS_KINDS.includes(kind) ? kind : null;
}

export const idOf = (key: string): string => key.slice(2);

// ─── Item values ─────────────────────────────────────────────────────────────

export interface DeckItem { name: string; newLimit: number; sourceId?: string; s: number; at: number }
export interface PropItem { origin: string; name: string; statement: string; snapshot?: unknown; sourceId?: string; created: number }
export interface CueItem { p: string; q: string; a: string; s: number }
export interface ReviewItem { p: string; c: string; rating: number; at: number; deckIds: string[]; settings: Record<string, unknown> }
export interface FileItem { name: string; fingerprint: string; deckId: string }
export interface MembershipItem { in: boolean; s: number }

/** m|<deck id>|<fact id>: the key of one fact's place in one deck. */
export const membershipKey = (deck: string, fact: string): string => `m|${deck}|${fact}`;

/** The deck and the fact of a membership key, or null. */
export function membershipOf(key: string): { deck: string; fact: string } | null {
	if (key[0] !== "m" || key[1] !== "|") return null;
	const at = key.indexOf("|", 2);
	if (at < 0) return null;
	return { deck: key.slice(2, at), fact: key.slice(at + 1) };
}

/** Every membership, by fact: deck → entry. */
export function membershipsByFact(items: Items): Map<string, Map<string, MembershipItem>> {
	const out = new Map<string, Map<string, MembershipItem>>();
	for (const [key, value] of items) {
		const ref = membershipOf(key);
		if (!ref) continue;
		let decks = out.get(ref.fact);
		if (!decks) { decks = new Map(); out.set(ref.fact, decks); }
		decks.set(ref.deck, value as MembershipItem);
	}
	return out;
}

export type Items = Map<string, unknown>;

/** A review's settings copy, without the per-device model choice. */
export function reviewSettings(settings: unknown): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (settings && typeof settings === "object") {
		for (const key of REVIEW_SETTINGS) {
			const value = (settings as Record<string, unknown>)[key];
			if (value !== undefined) out[key] = Array.isArray(value) ? [...value] : value;
		}
	}
	return out;
}

/** Equal values; the same JSON first (the common case), then regardless of key order. */
export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b) || canonical(a) === canonical(b);

// ─── What may arrive ─────────────────────────────────────────────────────────

const MAX_KEY = 512;
const MAX_VALUE_BYTES = 2 * 1024 * 1024;
const MAX_LIST = 200_000;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 256 && !/[\u0000-\u001f|]/.test(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isSafeInt = (v: unknown, min: number): v is number => Number.isSafeInteger(v) && (v as number) >= min;

function isSteps(v: unknown, strict: boolean): boolean {
	if (!Array.isArray(v)) return false;
	if (strict) return v.length > 0 && v.every((step, i) => Number.isSafeInteger(step) && step >= 1 && step < 1440 && (i === 0 || step > v[i - 1]));
	return v.every((step) => typeof step === "number" && Number.isFinite(step) && step > 0);
}

/** A synced setting's value, by the plugin's own rules for saving one (backend.cjs validateSettings). */
export function isFlashcardsSetting(name: string, value: unknown): boolean {
	switch (name) {
		case "retention": return typeof value === "number" && Number.isFinite(value) && value >= 0.7 && value <= 0.99;
		case "learningSteps":
		case "relearningSteps": return isSteps(value, true);
		case "dayStart": return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 23;
		case "chunkBudget": return isSafeInt(value, 1);
		default: return false;
	}
}

/** A review's own settings copy: what the scheduler accepts (scheduler.cjs settingsFor). */
function isReviewSettings(v: unknown): boolean {
	if (!isObject(v)) return false;
	const { retention, learningSteps, relearningSteps, dayStart, fuzz, chunkBudget } = v;
	if (retention !== undefined && !(typeof retention === "number" && Number.isFinite(retention) && retention > 0 && retention <= 1)) return false;
	if (learningSteps !== undefined && !isSteps(learningSteps, false)) return false;
	if (relearningSteps !== undefined && !isSteps(relearningSteps, false)) return false;
	if (dayStart !== undefined && !(Number.isInteger(dayStart) && (dayStart as number) >= 0 && (dayStart as number) <= 23)) return false;
	if (fuzz !== undefined && typeof fuzz !== "boolean") return false;
	if (chunkBudget !== undefined && !isSafeInt(chunkBudget, 1)) return false;
	return Object.keys(v).every((key) => (REVIEW_SETTINGS as readonly string[]).includes(key));
}

const isIdList = (v: unknown): boolean => Array.isArray(v) && v.length <= MAX_LIST && v.every(isId) && new Set(v).size === v.length;

function isValue(kind: FlashcardsKind, id: string, v: unknown): boolean {
	switch (kind) {
		case "s": return isFlashcardsSetting(id, v);
		case "d": return isObject(v) && isText(v.name) && isSafeInt(v.newLimit, 0) && (v.sourceId === undefined || isText(v.sourceId)) && isTime(v.s) && isTime(v.at);
		case "x":
		case "k": return v === 1;
		case "o": return id === "decks" && isIdList(v);
		case "q":
		case "u": return isIdList(v);
		case "p": return isObject(v) && ["graph", "file", "manual"].includes(v.origin as string) && typeof v.name === "string" && typeof v.statement === "string"
			&& (v.snapshot === undefined || isObject(v.snapshot)) && (v.sourceId === undefined || isId(v.sourceId)) && isTime(v.created);
		case "e": return isTime(v);
		case "m": return isObject(v) && typeof v.in === "boolean" && isTime(v.s) && Object.keys(v).length === 2;
		case "c": return isObject(v) && isId(v.p) && isText(v.q) && isText(v.a) && isTime(v.s);
		case "r": return isObject(v) && isId(v.p) && isId(v.c) && Number.isInteger(v.rating) && (v.rating as number) >= 1 && (v.rating as number) <= 4
			&& isTime(v.at) && Array.isArray(v.deckIds) && v.deckIds.length <= 10_000 && v.deckIds.every(isId) && isReviewSettings(v.settings);
		case "f": return isObject(v) && typeof v.name === "string" && isText(v.fingerprint) && isId(v.deckId);
	}
}

const isKey = (key: string): boolean => {
	const kind = flashcardsKindOf(key);
	const id = idOf(key);
	if (key.length > MAX_KEY || !kind) return false;
	if (kind === "s") return (SYNCED_FLASHCARDS_SETTINGS as readonly string[]).includes(id);
	if (kind === "m") { const ref = membershipOf(key)!; return !!ref && isId(ref.deck) && isId(ref.fact); }
	return isId(id);
};

/**
 * An item this side would take. A read only sends items that pass, so one
 * odd value in a file (an old plugin's, a hand edit) can't make the other
 * side refuse the whole exchange; it is left alone instead.
 */
export function isFlashcardsItem(key: string, value: unknown): boolean {
	// Canonical JSON has the length of plain JSON, which is much quicker to make.
	return isKey(key) && value !== null && value !== undefined && JSON.stringify(value).length <= MAX_VALUE_BYTES && isValue(flashcardsKindOf(key)!, idOf(key), value);
}

/** A Flashcards change received from the other side, or null when it can't be trusted. */
export function checkFlashcardsChange(raw: unknown): { key: string; value: unknown; t: number } | null {
	if (!isObject(raw) || typeof raw.key !== "string" || !isKey(raw.key)) return null;
	if (typeof raw.t !== "number" || !Number.isFinite(raw.t) || raw.t < 0) return null;
	const value = raw.value === undefined ? null : raw.value;
	if (value !== null && !isFlashcardsItem(raw.key, value)) return null;
	return { key: raw.key, value, t: raw.t };
}

// ─── Combining ───────────────────────────────────────────────────────────────

/** Members in the order `order` gives; the ones it doesn't know after it, by stamp, then id. */
export function ordered(order: unknown, members: Iterable<string>, stampOf: (id: string) => number): string[] {
	const set = new Set(members);
	const out: string[] = [];
	if (Array.isArray(order)) for (const id of order) if (typeof id === "string" && set.has(id)) { out.push(id); set.delete(id); }
	const rest = [...set].sort((a, b) => stampOf(a) - stampOf(b) || (a < b ? -1 : a > b ? 1 : 0));
	return [...out, ...rest];
}

const byStamp = (a: { s: number; id: string }, b: { s: number; id: string }): number => a.s - b.s || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export interface PlacedDeck { id: string; item: DeckItem; members: string[] }
export interface PlacedProp { id: string; item: PropItem; decks: string[]; cues: Array<{ id: string; item: CueItem }> }

/** What the file holds after combining. */
export interface Placement {
	settings: Map<string, unknown>;
	/** Decks, in order. */
	decks: PlacedDeck[];
	/** Facts that are in the file, in the order first met going through the decks. */
	props: Map<string, PlacedProp>;
	/** Uploaded-file records whose deck is in the file (deckId already the joined deck's). */
	files: Map<string, FileItem>;
	epochs: Map<string, number>;
	/** A joined deck's id → the deck it was joined into. */
	joined: Map<string, string>;
}

/**
 * The items made whole, and what the file holds. The same items give the
 * same result on every device, in whatever order they arrived: everything
 * here depends only on the items, sorted where an order is needed.
 *
 * What is made whole (and so travels back as changes of this device's):
 * a card with a k loses its c; a second card with the same question gets a
 * k; a joined deck gets an x and its facts and file records move to the
 * deck it was joined into, which takes the newest name and limit; a deleted
 * deck that still has facts loses its x.
 */
export function combine(input: Items): { items: Items; placement: Placement } {
	const items = new Map(input);
	const get = <T>(key: string): T | undefined => items.get(key) as T | undefined;

	// Cards: a k is final.
	const liveCues = new Map<string, Array<{ id: string; item: CueItem }>>();
	for (const [key, value] of [...items]) {
		if (key[0] !== "c" || key[1] !== "|") continue;
		const id = idOf(key);
		if (items.has(`k|${id}`)) { items.delete(key); continue; }
		const item = value as CueItem;
		const list = liveCues.get(item.p) ?? [];
		list.push({ id, item });
		liveCues.set(item.p, list);
	}
	for (const list of liveCues.values()) list.sort((a, b) => byStamp({ s: a.item.s, id: a.id }, { s: b.item.s, id: b.id }));

	// Facts that are alive: they have a fact item and a card.
	const alive = new Set<string>();
	for (const [p, list] of liveCues) if (list.length > 0 && items.has(`p|${p}`)) alive.add(p);
	const memberOf = membershipsByFact(items);
	const entriesOf = (p: string): Map<string, MembershipItem> => memberOf.get(p) ?? new Map();

	// Decks that may be in the file: not deleted, or deleted but still holding a fact.
	const deckIds = [...items.keys()].filter((key) => key[0] === "d" && key[1] === "|").map(idOf).sort();
	const holders = new Map<string, number>();
	for (const p of alive) for (const [deck, entry] of entriesOf(p)) if (entry.in) holders.set(deck, (holders.get(deck) ?? 0) + 1);
	const candidates = deckIds.filter((id) => !items.has(`x|${id}`) || (holders.get(id) ?? 0) > 0);

	// Twin decks: the same session or source, or the same uploaded file.
	const parent = new Map(candidates.map((id) => [id, id]));
	const root = (id: string): string => { let at = id; while (parent.get(at) !== at) at = parent.get(at)!; return at; };
	const join = (a: string, b: string): void => { const ra = root(a), rb = root(b); if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb); };
	const bySource = new Map<string, string>();
	for (const id of candidates) {
		const sourceId = get<DeckItem>(`d|${id}`)!.sourceId;
		if (sourceId === undefined) continue;
		const first = bySource.get(sourceId);
		if (first === undefined) bySource.set(sourceId, id); else join(first, id);
	}
	const fileKeys = [...items.keys()].filter((key) => key[0] === "f" && key[1] === "|").sort();
	const byPrint = new Map<string, string>();
	for (const key of fileKeys) {
		const record = get<FileItem>(key)!;
		if (!parent.has(record.deckId)) continue;
		const first = byPrint.get(record.fingerprint);
		if (first === undefined) byPrint.set(record.fingerprint, record.deckId); else join(first, record.deckId);
	}
	const groups = new Map<string, string[]>();
	for (const id of candidates) { const r = root(id); groups.set(r, [...(groups.get(r) ?? []), id]); }
	const joined = new Map<string, string>();
	for (const group of groups.values()) {
		if (group.length < 2) continue;
		const decks = group.map((id) => ({ id, item: get<DeckItem>(`d|${id}`)! }));
		const keep = [...decks].sort((a, b) => byStamp({ s: a.item.s, id: a.id }, { s: b.item.s, id: b.id }))[0]!;
		const newest = [...decks].sort((a, b) => b.item.at - a.item.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))[0]!;
		const merged: DeckItem = { ...keep.item, name: newest.item.name, newLimit: newest.item.newLimit, at: newest.item.at };
		if (!same(merged, keep.item)) items.set(`d|${keep.id}`, merged);
		for (const { id } of decks) if (id !== keep.id) { joined.set(id, keep.id); items.set(`x|${id}`, 1); }
	}
	const target = (deck: string): string => joined.get(deck) ?? deck;

	// Memberships follow a join: a fact in a joined deck is in the deck it was joined into
	// (with the earliest stamp), unless that deck already says where the fact stands.
	for (const p of alive) {
		const entries = entriesOf(p);
		const moved = new Map<string, number>();
		for (const [deck, entry] of entries) {
			const to = target(deck);
			if (to !== deck && entry.in && !entries.has(to)) moved.set(to, Math.min(moved.get(to) ?? Infinity, entry.s));
		}
		for (const [to, s] of moved) {
			const value: MembershipItem = { in: true, s };
			items.set(membershipKey(to, p), value);
			entries.set(to, value);
			memberOf.set(p, entries);
		}
	}

	// Placed facts: alive, in at least one deck that exists. Taken out of every deck it was
	// in: it stays in the one it was put in last (a fact is never left in no deck).
	const deckOf = new Map<string, string[]>();
	const placedIn = new Map<string, string[]>();
	const exists = (deck: string): boolean => items.has(`d|${deck}`) && !joined.has(deck);
	for (const p of [...alive].sort()) {
		const entries = [...entriesOf(p)].filter(([deck]) => exists(deck));
		let decks = entries.filter(([, entry]) => entry.in).map(([deck]) => deck).sort();
		if (decks.length === 0 && entries.length > 0) decks = [entries.sort(([a, x], [b, y]) => y.s - x.s || (a < b ? -1 : a > b ? 1 : 0))[0]![0]];
		placedIn.set(p, decks);
		for (const deck of decks) deckOf.set(deck, [...(deckOf.get(deck) ?? []), p]);
	}

	// Decks in the file: a deleted deck that still holds a fact stays, and is no longer deleted.
	const liveDecks = candidates.filter((id) => !joined.has(id) && (!items.has(`x|${id}`) || (deckOf.get(id)?.length ?? 0) > 0));
	for (const id of liveDecks) items.delete(`x|${id}`);
	const deckOrder = ordered(items.get(DECK_ORDER_KEY), liveDecks, (id) => get<DeckItem>(`d|${id}`)!.s);
	const decks: PlacedDeck[] = deckOrder.map((id) => {
		const members = ordered(items.get(`q|${id}`), deckOf.get(id) ?? [], (p) => entriesOf(p).get(id)?.s ?? Infinity);
		return { id, item: get<DeckItem>(`d|${id}`)!, members };
	});

	const live = new Set(liveDecks);
	const props = new Map<string, PlacedProp>();
	for (const deck of decks) for (const p of deck.members) {
		if (props.has(p)) continue;
		const cues = liveCues.get(p)!;
		const stamps = new Map(cues.map(({ id, item }) => [id, item.s]));
		const order = ordered(items.get(`u|${p}`), cues.map(({ id }) => id), (id) => stamps.get(id)!);
		const byId = new Map(cues.map((cue) => [cue.id, cue]));
		const inDecks = (placedIn.get(p) ?? []).filter((d) => live.has(d));
		props.set(p, { id: p, item: get<PropItem>(`p|${p}`)!, decks: inDecks, cues: order.map((id) => byId.get(id)!) });
	}

	// Uploaded-file records follow their deck; one whose deck is gone isn't in the file.
	const files = new Map<string, FileItem>();
	for (const key of fileKeys) {
		const record = get<FileItem>(key)!;
		const to = target(record.deckId);
		const next = to === record.deckId ? record : { ...record, deckId: to };
		if (next !== record) items.set(key, next);
		if (live.has(to)) files.set(idOf(key), next);
	}

	const settings = new Map<string, unknown>();
	for (const name of SYNCED_FLASHCARDS_SETTINGS) if (items.has(`s|${name}`)) settings.set(name, items.get(`s|${name}`));
	const epochs = new Map<string, number>();
	for (const [key, value] of items) if (key[0] === "e" && key[1] === "|") epochs.set(idOf(key), value as number);

	return { items, placement: { settings, decks, props, files, epochs, joined } };
}

/**
 * Two cards with the same question (after trimming) on one fact that meet
 * here for the first time from two devices: this device holds one, the
 * other arrives, and the side that sent it never had this device's card
 * (`senderHad`). The later of the two (s, then id) gets a k. Cards that
 * arrive together, or a device's own two cards, are never paired: a device
 * that holds both meant to.
 */
export function duplicateDeletions(before: Items, incoming: ReadonlyMap<string, unknown>, senderHad: (key: string) => boolean): string[] {
	const local = new Map<string, Array<{ id: string; item: CueItem }>>();
	for (const [key, value] of before) {
		if (key[0] !== "c" || key[1] !== "|") continue;
		const id = idOf(key);
		if (before.has(`k|${id}`) || incoming.get(`k|${id}`) === 1) continue;
		const item = value as CueItem;
		const list = local.get(item.p) ?? [];
		list.push({ id, item });
		local.set(item.p, list);
	}
	const losers = new Set<string>();
	for (const [key, value] of incoming) {
		if (key[0] !== "c" || key[1] !== "|" || value === null || value === undefined || before.has(key)) continue;
		const id = idOf(key);
		if (before.has(`k|${id}`) || incoming.get(`k|${id}`) === 1) continue;
		const item = value as CueItem;
		for (const mine of local.get(item.p) ?? []) {
			if (losers.has(mine.id) || mine.item.q.trim() !== item.q.trim() || senderHad(`c|${mine.id}`)) continue;
			const later = byStamp({ s: mine.item.s, id: mine.id }, { s: item.s, id }) < 0 ? id : mine.id;
			losers.add(later);
			if (later === id) break;
		}
	}
	return [...losers].sort();
}
