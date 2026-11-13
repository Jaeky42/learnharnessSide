import { notFound } from "next/navigation";
import { Chat } from "@/components/chat";
import { slotsConfigured, withoutThinkingSignatures } from "@/src/core";
import { compactionInFlight, readBrowserState, isTurnRunning, readSettingsRecord, turnFailure } from "@/src/server";

export const dynamic = "force-dynamic";

export default async function ChatPage({
	params,
	searchParams,
}: {
	params: Promise<{ id: string }>;
	searchParams: Promise<{ prompt?: string }>;
}) {
	const [{ id }, { prompt }] = await Promise.all([params, searchParams]);
	// Perf round: the same composite stamp as the full GET and ?only=stamp (one shared
	// function). Its file part is taken BEFORE the read, so a write in between gives an
	// older stamp with newer content (the client then re-reads once).
	const state = await readBrowserState(id);
	if (!state) notFound();
	const { chat, stamp } = state;
	// The persistent setup CTA's seed (BYOK, owner 2026-09-22): slotsConfigured
	// over the settings record, server-read — the same gate home/new read. The
	// server's 503 stays the truth; this only decides whether the pill rides.
	const record = readSettingsRecord();
	return (
		<Chat
			key={chat.id}
			chatId={chat.id}
			title={chat.title}
			kind={chat.kind ?? "teach"}
			// Wave D: the record IS native agent history — the client view is
				// derived app-side (core/view.ts projectView; GET serves the same
				// native messages).
				// Perf round: without the reasoning blocks' thinkingSignature (no browser code reads it).
				initialMessages={withoutThinkingSignatures(chat.messages)}
				// null while a plugin question or problem is pending: the client then reads in full.
				initialStamp={stamp}
			initialError={turnFailure(chat.id)}
			initialConfigured={slotsConfigured(record?.models)}
			initialPrompt={prompt}
			// A teacher turn that outlived its client: the remounted view must
			// attach (busy shimmer + poll), never resurrect the stale record.
			initiallyInFlight={isTurnRunning(chat.id)}
			initiallyCompacting={compactionInFlight(chat.id)}
		/>
	);
}
