/**
 * Cloud sync (Phase 5): one whole round of a desktop with its server:
 * sessions first (leases decide who may write what), then the graph log.
 */

import { serverModeEnabled } from "../server-auth.ts";
import type { TickResult } from "./desktop-sync.ts";
import { desktopSync } from "./engine.ts";
import { graphDesktop } from "./graph-engine.ts";
import type { GraphRound } from "./graph-sync.ts";

export interface SyncRound {
	sessions: TickResult;
	graph: GraphRound | null;
}

export async function runSyncRound(): Promise<SyncRound> {
	if (serverModeEnabled()) return { sessions: { ok: false, reason: "not-paired" }, graph: null };
	const sessions = await desktopSync().tick();
	// Without the server there is no point asking again for the graph.
	if (!sessions.ok) return { sessions, graph: null };
	return { sessions, graph: await graphDesktop().round() };
}
