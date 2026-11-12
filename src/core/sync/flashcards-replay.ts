/**
 * Flashcards sync (docs/phone-plugins-plan.md, "Flashcards sync"): schedules
 * never travel. Each device works a fact's schedule out again from the
 * combined reviews, in the order they were made, with the plugin's own
 * scheduler and the settings copy each review recorded.
 *
 * Pure: the scheduler is passed in (core code never imports plugins/), and
 * no clock is read. The plugin's rate-review step, which this repeats, is:
 *
 *   before = p.schedule; introduced = p.firstReviewedAt == null
 *   p.schedule = rate(before, rating, at, settings)
 *   p.learningCueId = state 1 or 3 ? cueId : null
 *   p.firstReviewedAt ??= at; cue.latestRating = rating; cue.lastReviewedAt = at
 *
 * and a new fact starts from createSchedule(<the moment it was made>).
 */

/** The plugin's scheduler (plugins/flashcards/src/scheduler.cjs), as far as the replay needs it. */
export interface FlashcardsScheduler {
	createSchedule(now: number): FlashcardsSchedule;
	rate(schedule: FlashcardsSchedule, rating: number, now: number, settings: Record<string, unknown>): FlashcardsSchedule;
}

export interface FlashcardsSchedule {
	due: number;
	state: number;
	[field: string]: unknown;
}

/** One review as the replay needs it. */
export interface ReplayReview {
	id: string;
	cueId: string;
	rating: number;
	at: number;
	settings: Record<string, unknown>;
}

export interface ReplayedReview {
	before: FlashcardsSchedule;
	after: FlashcardsSchedule;
	introduced: boolean;
}

export interface ReplayResult {
	schedule: FlashcardsSchedule;
	firstReviewedAt: number | null;
	learningCueId: string | null;
	/** Per cue: its latest rating and when. Only cues that were reviewed. */
	cues: Map<string, { rating: number; at: number }>;
	reviews: Map<string, ReplayedReview>;
}

/** The order reviews are replayed in: when they were made; equal times by id, the same on every device. */
export function byTime(a: { at: number; id: string }, b: { at: number; id: string }): number {
	return a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * One fact's schedule from its reviews. `reviews` must already be the ones
 * that count (see `countedReviews`); they are sorted here. A review the
 * scheduler refuses (settings it can't use) changes nothing and is reported
 * with its schedule unchanged, the same on every device.
 */
export function replayProposition(created: number, reviews: readonly ReplayReview[], scheduler: FlashcardsScheduler): ReplayResult {
	let schedule = scheduler.createSchedule(created);
	let firstReviewedAt: number | null = null;
	let learningCueId: string | null = null;
	const cues = new Map<string, { rating: number; at: number }>();
	const replayed = new Map<string, ReplayedReview>();
	for (const review of [...reviews].sort(byTime)) {
		const before = schedule;
		const introduced = firstReviewedAt === null;
		let after: FlashcardsSchedule;
		try { after = scheduler.rate(before, review.rating, review.at, review.settings); }
		catch { replayed.set(review.id, { before, after: before, introduced: false }); continue; }
		schedule = after;
		learningCueId = after.state === 1 || after.state === 3 ? review.cueId : null;
		firstReviewedAt ??= review.at;
		cues.set(review.cueId, { rating: review.rating, at: review.at });
		replayed.set(review.id, { before, after, introduced });
	}
	return { schedule, firstReviewedAt, learningCueId, cues, reviews: replayed };
}

/**
 * The reviews that count for a fact: its own, made after it was last
 * deleted (`epoch`, exclusive), so a fact deleted and made again starts
 * fresh. A review of a card that is still there always counts: deleting a
 * fact deletes every card it had, so a card still there belongs to the
 * fact as it is now (one made on another device at the same time as the
 * deletion keeps its reviews).
 */
export function countedReviews<T extends { at: number }>(reviews: readonly T[], epoch: number | undefined, cardStays: (review: T) => boolean = () => false): T[] {
	return epoch === undefined ? [...reviews] : reviews.filter((review) => review.at > epoch || cardStays(review));
}
