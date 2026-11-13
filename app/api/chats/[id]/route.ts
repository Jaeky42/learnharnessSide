import { browserState, chatStamp, compactionInFlight, deleteChatSession, getChat, isTurnRunning, readBrowserState, sessionCoverage, sessionCost, stores, type ChatDeleteMode, reconcilePluginQuestionCompatibility } from "@/src/server";
import { withoutThinkingSignatures } from "@/src/core";

/** GET ?only=…: one small field of the session, so a client that needs one
 *  thing doesn't download and parse the whole record (perf round). Read-only:
 *  never reconciles plugin questions and never writes. */
const ONLY_VALUES = ["stamp", "coverage", "settings", "turns"] as const;

async function onlyResponse(id: string, only: string): Promise<Response> {
	if (!(ONLY_VALUES as readonly string[]).includes(only)) {
		return Response.json({ error: 'only must be "stamp", "coverage", "settings" or "turns"', code: "bad_only" }, { status: 400 });
	}
	// The stamp covers what the full GET adds to the file (turnError, plugin
	// availability, pricing), so it reads the record once: no reconcile, no write.
	if (only === "stamp") {
		const state = await readBrowserState(id);
		return state === null ? Response.json({ error: "Not found" }, { status: 404 }) : Response.json({ stamp: state.stamp });
	}
	if (only === "coverage") {
		const coverage = sessionCoverage(id);
		return coverage === null ? Response.json({ error: "Not found" }, { status: 404 }) : Response.json({ coverage });
	}
	const chat = getChat(id);
	if (!chat) return Response.json({ error: "Not found" }, { status: 404 });
	return only === "settings"
		? Response.json({ settings: chat.settings })
		: Response.json({ turns: chat.turns, pricing: sessionCost(chat) });
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const only = new URL(req.url).searchParams.get("only");
	if (only !== null) return await onlyResponse(id, only);
	// Perf round: the record is read once and handed to the helpers below. Each
	// read takes the file's stamp first, so a write landing in between yields an
	// older stamp with newer content (the client then re-reads once).
	let stamp = chatStamp(id);
	let chat = getChat(id);
	if (!chat) return Response.json({ error: "Not found" }, { status: 404 });
	// reconcile reads the record once at its start: serve it the one just read
	// (its later reads, after awaits, go to the store), and note if it wrote.
	let reconciled = false;
	let firstRead: typeof chat | null = chat;
	await reconcilePluginQuestionCompatibility({
		...stores.chatStore,
		getChat: (chatId) => {
			if (firstRead && chatId === id) { const known = firstRead; firstRead = null; return known; }
			return stores.chatStore.getChat(chatId);
		},
		saveMessages: (chatId, messages) => { reconciled = true; stores.chatStore.saveMessages(chatId, messages); },
	}, id);
	if (reconciled) {
		stamp = chatStamp(id);
		chat = getChat(id);
		if (!chat) return Response.json({ error: "Not found" }, { status: 404 });
	}
	// The resolvers, the re-reads after their awaits, the availability, pricing
	// and turnError values and the stamp: one shared function with ?only=stamp
	// and the lesson page (src/server/browser-stamp.ts).
	const state = await browserState(id, { chat, fileStamp: stamp });
	if (!state) return Response.json({ error: "Not found" }, { status: 404 });
	chat = state.chat;
	// turnInFlight lets a returning client re-attach to a running turn
	// (chat-handler write-ahead + registry — see src/server/turn-liveness.ts).
	// coverage (extraction-UX redesign, 2026-09-24): the chat view's ring
	// meter + sidebar block — THE coverage surface (the all-sessions GET
	// route died with the redesign; the Extract POST stays). getChat
	// already 404'd, so the block exists.
	// Wave D (owner-approved 2026-09-26): the record's messages are native
	// agent history, served VERBATIM — the client derives its view
	// (core/view.ts projectView). turnInFlight lets a returning client
	// re-attach to a running turn; coverage is the chat view's ring meter.
	// Perf round (owner's decision): "verbatim" except the reasoning blocks'
	// thinkingSignature, which no browser code reads (a quarter of a long
	// session's bytes); the stored record keeps it.
	// Snapshot bytes have a session-scoped endpoint; do not resend the whole image pool on every poll.
	const { imageSnapshots: _imageSnapshots, ...record } = chat;
	return Response.json({
		...record,
		messages: withoutThinkingSignatures(chat.messages),
		stamp: state.stamp,
		pluginQuestionAvailability: state.pluginQuestionAvailability,
		pluginProblemAvailability: state.pluginProblemAvailability,
		pricing: state.pricing,
		turnInFlight: isTurnRunning(id),
		// Also reaches idle views that missed the failing turn's stream.
		turnError: state.turnError,
		compacting: compactionInFlight(id),
		coverage: sessionCoverage(id, chat),
	});
}

/**
 * Rename (2026-09-17): the header's click-to-edit title commits here.
 * Validation is a single rule — a non-empty string after trim (the store's
 * "Untitled session" floor is never reached from this route). updatedAt is
 * deliberately NOT bumped: a rename must not reorder the sidebar (same
 * rule as the settings PUT).
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getChat(id)) return Response.json({ error: "Not found" }, { status: 404 });
	const body = (await req.json().catch(() => null)) as { title?: unknown } | null;
	if (typeof body?.title !== "string" || body.title.trim() === "") {
		return Response.json({ error: "title must be a non-empty string" }, { status: 400 });
	}
	const title = body.title.trim();
	const record = stores.chatStore.renameChat(id, title);
	return Response.json({ title: record.title });
}

/**
 * DELETE /api/chats/[id]?mode=preserve-graph|delete-nodes — session deletion
 * (wave 6, owner rulings 2026-09-22/23). The mode is REQUIRED and explicit:
 * no default, because the two differ in destructiveness —
 *
 *   preserve-graph  the session record, its jobs, and its extraction
 *                   bookkeeping (coverage/checkpoint rows) die; the graph
 *                   keeps every contribution the session merged.
 *   delete-nodes    "this session never happened": every ledger trace of
 *                   the session goes too — provenance, link lines,
 *                   events, mappings — and orphaned nodes die entirely
 *                   (shared nodes survive automatically, their other
 *                   sessions' content intact).
 *
 * Gates are the server orchestration's (server/chats.ts deleteChatSession):
 * 409 while a turn or background job is running, 503 while the session's
 * extraction is winding down after its abort — both retryable. The
 * response carries what was removed plus the new graphRevision (the
 * version stamp the UI polls to refetch clusters/layout).
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const mode = new URL(req.url).searchParams.get("mode");
	if (mode !== "preserve-graph" && mode !== "delete-nodes") {
		return Response.json(
			{
				error: 'mode is required and must be "preserve-graph" or "delete-nodes"',
				code: "bad_mode",
			},
			{ status: 400 },
		);
	}
	const outcome = await deleteChatSession(id, mode as ChatDeleteMode);
	if (!outcome.ok) {
		return Response.json(
			{
				error: outcome.error,
				code: outcome.code,
				...("jobIds" in outcome ? { jobIds: outcome.jobIds } : {}),
		},
			{ status: outcome.status },
		);
	}
	return Response.json({
		ok: true,
		mode: outcome.mode,
		stats: outcome.stats,
		jobsRemoved: outcome.jobsRemoved,
		graphRevision: outcome.graphRevision,
	});
}

