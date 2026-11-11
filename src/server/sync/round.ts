/**
 * Cloud sync (Phase 5): one whole round of a desktop with its server:
 * sessions first (leases decide who may write what), then the graph log,
 * then the small files that sync item by item (they point at sessions and
 * concepts, so those are in place first).
 */

import { serverModeEnabled } from "../server-auth.ts";
import type { TickResult } from "./desktop-sync.ts";
import { desktopSync } from "./engine.ts";
import { graphDesktop } from "./graph-engine.ts";
import type { GraphRound } from "./graph-sync.ts";
import { mapsDesktop } from "./maps-engine.ts";
import type { MapsRound } from "./maps-sync.ts";

export interface SyncRound {
	sessions: TickResult;
	graph: GraphRound | null;
	/** Settings and the other files that sync one item at a time. */
	maps: MapsRound | null;
}

export async function runSyncRound(): Promise<SyncRound> {
	if (serverModeEnabled()) return { sessions: { ok: false, reason: "not-paired" }, graph: null, maps: null };
	const sessions = await desktopSync().tick();
	// Without the server there is no point asking again for the rest. What
	// changed in the small files is still noted, with the time it changed.
	if (!sessions.ok) {
		mapsDesktop().detect();
		return { sessions, graph: null, maps: null };
	}
	const graph = await graphDesktop().round();
	return { sessions, graph, maps: await mapsDesktop().round() };
}
