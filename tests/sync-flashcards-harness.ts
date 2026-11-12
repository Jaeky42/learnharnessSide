/**
 * Flashcards sync tests: the plugin's real back end on a scratch folder (as
 * plugins/flashcards/tests drive it: an in-memory worker service, a graph
 * given by the test, Date.now() set by the test), and a small stand-in for
 * the per-item exchange (latest change wins per key, on one clock) so two
 * devices can be synced against each other with the pure rules.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { applyFlashcardsChanges, readFlashcards, type FlashcardsFile, type FlashcardsMemory, type FlashcardsScheduler } from "../src/core/sync/flashcards.ts";
import { itemHash } from "../src/core/sync/maps.ts";

const require = createRequire(import.meta.url);
const { activate } = require("../plugins/flashcards/src/backend.cjs") as { activate: (ctx: unknown) => void };
export const scheduler = require("../plugins/flashcards/src/scheduler.cjs") as FlashcardsScheduler;
export const { defaults: pluginDefaults } = require("../plugins/flashcards/src/store.cjs") as { defaults: () => Record<string, unknown> };

export const DAY = 86_400_000;
export const MINUTE = 60_000;

/** One clock for every device in a test (Date.now() is replaced while a test runs). */
export const clock = { now: new Date(2026, 0, 5, 9).getTime() };

type Task = { id: string; workerId: string; requestId: string; input: unknown; status: string; turns: number; activity: string; result?: unknown };

function workerService() {
	const tasks = new Map<string, Task>();
	const waiters = new Map<string, Set<() => void>>();
	const definitions = new Map<string, { validateResult: (value: unknown, context: unknown) => void }>();
	const done = (task: Task): void => { for (const resolve of [...(waiters.get(task.id) ?? [])]) resolve(); };
	return {
		service: {
			register(value: { id: string; validateResult: (value: unknown, context: unknown) => void }) { definitions.set(value.id, value); return () => {}; },
			start(workerId: string, options: { requestId: string; input: unknown }) {
				const prior = [...tasks.values()].find((t) => t.requestId === options.requestId);
				if (prior) return structuredClone(prior);
				const task: Task = { id: randomUUID(), workerId, requestId: options.requestId, input: structuredClone(options.input), status: "running", turns: 0, activity: "waiting" };
				tasks.set(task.id, task);
				return structuredClone(task);
			},
			list: () => structuredClone([...tasks.values()]),
			get(id: string) { return structuredClone(tasks.get(id)!); },
			subscribe() { return () => {}; },
			wait(id: string, signal: AbortSignal) {
				if (tasks.get(id)!.status !== "running") return Promise.resolve();
				return new Promise<void>((resolve, reject) => {
					const set = waiters.get(id) ?? new Set();
					waiters.set(id, set);
					set.add(resolve);
					signal.addEventListener("abort", () => reject(new Error("disposed")), { once: true });
				});
			},
			cancel() {},
		},
		complete(id: string, value: unknown) {
			const task = tasks.get(id)!;
			definitions.get(task.workerId)!.validateResult(value, { input: task.input });
			task.status = "succeeded";
			task.result = structuredClone(value);
			done(task);
		},
	};
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

export interface GraphNode { id: string; name: string; statement: string; provenance: Array<{ chatId: string }> }
export const graphNode = (id: string, session = "session-1"): GraphNode => ({ id, name: `Fact ${id}`, statement: `Statement ${id}`, provenance: [{ chatId: session }] });

/** One device: the plugin's back end over its own folder, and that device's sync memory. */
export class Device {
	/** The plugin's data folder; a scratch folder unless one is given (the wiring tests use a data folder's). */
	readonly directory: string;
	graph: { propositions: GraphNode[]; chains: unknown[]; sessions: Record<string, string>; fileSources: Record<string, string> } = { propositions: [], chains: [], sessions: { "session-1": "Lesson one", "session-2": "Lesson two" }, fileSources: {} };
	memory: FlashcardsMemory | null = null;
	/** key → fingerprint both sides last agreed on (what the exchange keeps per desktop). */
	agreed = new Map<string, string>();
	writes = 0;
	/** When this device's file last changed (the exchange uses the file's own time for a change found in it). */
	touched = clock.now;
	private handlers = new Map<string, (input: unknown) => unknown>();
	private controller = new AbortController();
	private workers = workerService();

	constructor(readonly name: string, directory?: string) {
		this.directory = directory ?? fs.mkdtempSync(path.join(os.tmpdir(), "lh-fc-sync-"));
		this.activate();
	}

	/** (Re)start the back end: it reads its file once, as at app start. */
	activate(): void {
		this.controller.abort();
		this.controller = new AbortController();
		this.handlers = new Map();
		this.workers = workerService();
		activate({
			dataDirectory: this.directory, signal: this.controller.signal, workers: this.workers.service,
			learning: { graph: () => structuredClone(this.graph) },
			inference: { catalog: async () => ({ slots: { cheap: { model: { provider: "mock", id: "cheap" }, thinkingLevel: "off" } }, models: [{ provider: "mock", id: "cheap", name: "Mock", supportedLevels: ["off"], contextWindow: 100000, maxTokens: 8192 }] }) },
			events: { emit() {} }, handle: (name: string, handler: (input: unknown) => unknown) => this.handlers.set(name, handler), cleanup() {},
		});
	}

	async call<T = unknown>(name: string, input: Record<string, unknown> = {}): Promise<T> {
		const result = await this.handlers.get(name)!(input) as T;
		if (!["get-state", "get-catalog", "next-review", "reveal-review", "preflight"].includes(name)) this.touched = clock.now;
		return result;
	}
	state(): Promise<{ revision: number; decks: Array<{ id: string; name: string; newLimit: number; propositionIds: string[] }>; propositions: Array<{ id: string; version: number; cues: Array<{ id: string; question: string }> }> }> { return this.call("get-state"); }
	file(): FlashcardsFile | null {
		try { return JSON.parse(fs.readFileSync(path.join(this.directory, "flashcards.json"), "utf8")) as FlashcardsFile; } catch { return null; }
	}
	raw(): string | null { try { return fs.readFileSync(path.join(this.directory, "flashcards.json"), "utf8"); } catch { return null; } }

	/** Generate cards for graph facts, as the plugin does after a model's answer. */
	async generate(rows: Array<{ id: string; questions: string[]; session?: string }>): Promise<void> {
		for (const row of rows) if (!this.graph.propositions.some((n) => n.id === row.id)) this.graph.propositions.push(graphNode(row.id, row.session));
		const plan = await this.call<{ id: string }>("preflight", { propositionIds: rows.map((r) => r.id) });
		await this.call("start-generation", { preflightId: plan.id, requestId: randomUUID() });
		await flush();
		for (const task of this.workers.service.list().filter((t) => t.status === "running")) {
			const input = task.input as { targets: string[] };
			this.workers.complete(task.id, { propositions: rows.filter((r) => input.targets.includes(r.id)).map((r) => ({ propositionId: r.id, cards: r.questions.map((q) => ({ question: q, answer: `Answer: ${q}` })) })) });
			await flush();
		}
		await flush();
	}

	/** Review the next card in scope with this rating. Returns the card id, or null when nothing is due. */
	async grade(rating: number, scope: Record<string, unknown> = {}): Promise<string | null> {
		const { ticket } = await this.call<{ ticket: { id: string; cueId: string } | null }>("next-review", scope);
		if (!ticket) return null;
		await this.call("reveal-review", { ticketId: ticket.id });
		await this.call("rate-review", { ticketId: ticket.id, rating, requestId: randomUUID() });
		return ticket.cueId;
	}

	/** What the exchange's MapFiles.read() would do: read, keep the memory. */
	read() {
		const result = readFlashcards(this.file(), this.memory, clock.now);
		this.memory = result.memory;
		return result;
	}

	/** What MapFiles.apply() would do. `senderHad`: what the side the changes came from already had. */
	apply(changes: ReadonlyMap<string, unknown>, senderHad?: (key: string) => boolean): boolean {
		const result = applyFlashcardsChanges(this.file(), this.memory, changes, { now: clock.now, scheduler, senderHad });
		if (result.changed) {
			fs.writeFileSync(path.join(this.directory, "flashcards.json"), JSON.stringify(result.file));
			this.writes++;
			this.touched = clock.now;
		}
		this.memory = result.memory;
		// The plugin re-reads its file (the one approved edit to its store); here, by starting it again.
		if (result.changed) this.activate();
		return result.changed;
	}

	dispose(): void { this.controller.abort(); fs.rmSync(this.directory, { recursive: true, force: true }); }
}

/**
 * The server's table, as the exchange keeps it: per key the value and when
 * it last changed. A device's round: send what changed here since it last
 * agreed (with now as its time), the hub keeps the later; then take what the
 * hub has that differs.
 */
export class Hub {
	table = new Map<string, { value: unknown; t: number }>();

	round(device: Device): { sent: number; taken: number } {
		const here = device.read();
		const keys = new Set([...here.items.keys(), ...device.agreed.keys()]);
		let sent = 0;
		for (const key of keys) {
			if (here.missing.has(key)) continue;
			const value = here.items.get(key) ?? null;
			const h = itemHash(value);
			if (device.agreed.get(key) === h) continue;
			if (device.agreed.get(key) === undefined && h === "-") continue;
			const known = this.table.get(key);
			const t = Math.min(device.touched, clock.now);
			if (!known || t > known.t || (t === known.t && itemHash(value) !== itemHash(known.value))) { this.table.set(key, { value: structuredClone(value), t: known ? Math.max(t, known.t) : t }); sent++; }
		}
		const changes = new Map<string, unknown>();
		for (const [key, { value }] of this.table) if (!here.missing.has(key) && itemHash(value) !== itemHash(here.items.get(key) ?? null)) changes.set(key, structuredClone(value));
		// The hub had what this device agreed on with it before this round.
		const agreedBefore = new Set(device.agreed.keys());
		if (changes.size > 0) device.apply(changes, (key) => agreedBefore.has(key));
		for (const [key, { value }] of this.table) device.agreed.set(key, itemHash(value));
		return { sent, taken: changes.size };
	}

	/** Rounds until nothing moves (normalising writes travel back once). */
	settle(...devices: Device[]): void {
		for (let i = 0; i < 10; i++) {
			let moved = 0;
			for (const device of devices) { clock.now += 1000; const r = this.round(device); moved += r.sent + r.taken; }
			if (moved === 0) return;
		}
		throw new Error("The devices did not settle.");
	}
}
