/**
 * THE SIDE-TUTOR SERVICE — the HTTP-facing half of the side window.
 *
 *   GET    /api/chats/:id/side-tutor            → the stored thread
 *   POST   /api/chats/:id/side-tutor {question} → NDJSON stream of SideTutorWireEvent
 *   POST   /api/chats/:id/side-tutor {action:"abort"} → stop the in-flight answer
 *   DELETE /api/chats/:id/side-tutor            → clear the thread
 *
 * Isolation (src/core/side-tutor.ts): this service READS the chat record
 * to build the lesson snapshot and NEVER writes it — no messages, no
 * usage, no settings. It takes no turn claim either, so a side question
 * runs alongside a live teacher turn without a 409 from the main lane.
 * One side question per chat at a time (its own small registry).
 */

import type { Usage } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { isSubscriptionProvider } from "../agent/subscription-connections.ts";
import { runSideTutor } from "../agent/subagents/side-tutor.ts";
import { resolveConversationSpec } from "../core/settings-resolution.ts";
import { modelsNotConfigured, providerKeyMissing } from "../core/settings.ts";
import {
	lessonSnapshot,
	parseSideTutorQuestion,
	sideHistoryText,
	type SideTutorEntry,
	type SideTutorWireEvent,
} from "../core/side-tutor.ts";
import type { ThinkingLevel } from "../../config.ts";
import { providerKeyPresent } from "./keys.ts";
import { refreshConnectionCatalog } from "./model-catalog.ts";
import { effectiveSettings, stores } from "./stores.ts";

/** Side answers run on the session's model at a fixed medium thinking
 *  level — enough reasoning for worked problems, still quick for a side
 *  window (pi clamps natively when the model has no such level). */
const SIDE_TUTOR_THINKING: ThinkingLevel = "medium";
/** Live-text fan-out cadence. */
const FLUSH_MS = 60;

interface SideTutorGlobal {
	__lhSideTutorRuns?: Map<string, AbortController>;
}

function runs(): Map<string, AbortController> {
	const g = globalThis as typeof globalThis & SideTutorGlobal;
	return (g.__lhSideTutorRuns ??= new Map());
}

export function sideTutorRunning(chatId: string): boolean {
	return runs().has(chatId);
}

/** Test seam: inject a scripted engine and skip the readiness gates. */
export interface SideTutorOptions {
	engine?: PiEngine;
}

export function sideTutorThreadResponse(chatId: string): Response {
	if (!stores.chatStore.getChat(chatId)) return Response.json({ error: "Unknown chat" }, { status: 404 });
	const thread = stores.sideTutorStore.read(chatId);
	return Response.json({ ...thread, running: sideTutorRunning(chatId) });
}

export function clearSideTutorResponse(chatId: string): Response {
	if (!stores.chatStore.getChat(chatId)) return Response.json({ error: "Unknown chat" }, { status: 404 });
	if (sideTutorRunning(chatId)) {
		return Response.json({ error: "A side answer is still streaming — stop it first" }, { status: 409 });
	}
	stores.sideTutorStore.clear(chatId);
	return Response.json({ ok: true });
}

/** Session deletion hook: drop the thread and stop any in-flight answer. */
export function discardSideTutor(chatId: string): void {
	runs().get(chatId)?.abort();
	runs().delete(chatId);
	try {
		stores.sideTutorStore.clear(chatId);
	} catch {
		// best effort — an orphan thread file is harmless
	}
}

async function resolveEngine(chatId: string): Promise<PiEngine | Response> {
	const record = stores.chatStore.getChat(chatId);
	if (!record) return Response.json({ error: "Unknown chat" }, { status: 404 });
	const effective = effectiveSettings();
	const spec = resolveConversationSpec(record.settings, effective.models.strong);
	if (!spec) return Response.json(modelsNotConfigured(["strong"]), { status: 503 });
	if (isSubscriptionProvider(spec.provider)) await refreshConnectionCatalog(spec.provider);
	if (!providerKeyPresent(spec.provider)) return Response.json(providerKeyMissing(spec.provider, ["strong"]), { status: 503 });
	try {
		// Foreground: the learner asked, right now.
		return piEngineForSpec({ ...spec, thinkingLevel: SIDE_TUTOR_THINKING }, false, undefined, () =>
			stores.settingsStore.readSettings()?.models?.strong?.cacheRetention,
		);
	} catch {
		return Response.json({ error: "The session's model is unavailable." }, { status: 503 });
	}
}

export async function sideTutorPostResponse(chatId: string, req: Request, opts: SideTutorOptions = {}): Promise<Response> {
	let body: { question?: unknown; action?: unknown };
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	if (body.action === "abort") {
		const run = runs().get(chatId);
		if (!run) return Response.json({ ok: false, reason: "not_running" }, { status: 409 });
		run.abort();
		return Response.json({ ok: true });
	}

	const parsed = parseSideTutorQuestion(body.question);
	if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400 });
	const record = stores.chatStore.getChat(chatId);
	if (!record) return Response.json({ error: "Unknown chat" }, { status: 404 });
	if (sideTutorRunning(chatId)) {
		return Response.json({ error: "The side tutor is still answering your last question" }, { status: 409 });
	}

	const resolved = opts.engine ?? (await resolveEngine(chatId));
	if (resolved instanceof Response) return resolved;
	const engine = resolved;

	// Claim the lane synchronously (no await between the check and the set).
	if (sideTutorRunning(chatId)) {
		return Response.json({ error: "The side tutor is still answering your last question" }, { status: 409 });
	}
	const controller = new AbortController();
	runs().set(chatId, controller);

	// The lesson is read fresh at ask time — whatever has settled so far.
	const fresh = stores.chatStore.getChat(chatId) ?? record;
	const lesson = lessonSnapshot(fresh.messages, { title: fresh.title });
	const history = sideHistoryText(stores.sideTutorStore.read(chatId).entries);
	const question = parsed.question;
	const entryBase = {
		id: `st_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
		question,
		askedAt: new Date().toISOString(),
		model: `${engine.model.provider}:${engine.model.id}`,
	};

	const encoder = new TextEncoder();
	let closed = false;
	let latest = "";
	let usage: Usage | undefined;

	const stream = new ReadableStream<Uint8Array>({
		start(sink) {
			const send = (event: SideTutorWireEvent) => {
				if (closed) return;
				try {
					sink.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
				} catch {
					closed = true;
				}
			};
			let sentText = "";
			const flush = () => {
				if (latest !== sentText) {
					sentText = latest;
					send({ type: "text", text: latest });
				}
			};
			const timer = setInterval(flush, FLUSH_MS);

			const save = (entry: SideTutorEntry): SideTutorEntry => {
				try {
					stores.sideTutorStore.append(chatId, entry);
				} catch (err) {
					console.error(`[side-tutor ${chatId}] could not save the answer:`, err);
				}
				return entry;
			};

			void runSideTutor({
				engine,
				lesson: lesson.text,
				history,
				question,
				abortSignal: controller.signal,
				onText: (text) => {
					latest = text;
				},
				onUsage: (u) => {
					usage = u;
				},
				chatId,
			})
				.then((text) => {
					latest = text;
					flush();
					send({ type: "done", entry: save({ ...entryBase, answer: text, status: "done", ...(usage ? { usage } : {}) }) });
				})
				.catch((err: unknown) => {
					flush();
					if (err instanceof Error && err.name === "AbortError") {
						send({ type: "done", entry: save({ ...entryBase, answer: latest, status: "aborted", ...(usage ? { usage } : {}) }) });
						return;
					}
					const message = err instanceof Error && err.message ? err.message : "The side tutor could not answer.";
					console.error(`[side-tutor ${chatId}] failed:`, err);
					send({ type: "error", error: message, entry: save({ ...entryBase, answer: latest, status: "error", error: message }) });
				})
				.finally(() => {
					clearInterval(timer);
					if (runs().get(chatId) === controller) runs().delete(chatId);
					if (!closed) {
						closed = true;
						try {
							sink.close();
						} catch {
							// already closed by a cancel
						}
					}
				});
		},
		cancel() {
			// The window went away (navigation, reload): stop paying for tokens.
			closed = true;
			controller.abort();
		},
	});

	return new Response(stream, {
		headers: {
			"content-type": "application/x-ndjson; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}
