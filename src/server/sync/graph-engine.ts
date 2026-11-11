/**
 * Cloud sync (Phase 5): the graph log as this copy runs it. Kept apart from
 * engine.ts, which the proxy loads: this module pulls in the graph rules.
 *
 *   loggedGraph        the graph store the app uses (wired in stores.ts)
 *   recordGraphAction  wrap a named deletion so it is logged as what it is
 *   graphAuthority()   the server's side;  graphDesktop()  a desktop's side
 */

import path from "node:path";
import { emit } from "../../core/events.ts";
import type { GraphChange } from "../../core/sync/graph-log.ts";
import { graphStore } from "../../store/graph.ts";
import { desktopGraphJournal, serverGraphLog } from "../../store/sync/graph-journal.ts";
import { serverModeEnabled } from "../server-auth.ts";
import { syncRequest } from "./client.ts";
import { onSessionDiscarded, syncStateDir } from "./engine.ts";
import { createGraphAuthority, createGraphDesktop, loggedGraphStore, type GraphAuthority, type GraphDesktop, type GraphRecorder } from "./graph-sync.ts";

/** The home view and the activity dock refetch the graph on this. */
const announce = (): void => emit("activity-changed", {});

interface GraphEngine { authority?: GraphAuthority; desktop?: GraphDesktop }
const globals = globalThis as typeof globalThis & { __lhGraphSync?: GraphEngine };
const engine = (): GraphEngine => (globals.__lhGraphSync ??= {});

export function graphAuthority(): GraphAuthority {
	return (engine().authority ??= createGraphAuthority({ store: graphStore, log: serverGraphLog(syncStateDir()), announce }));
}

export function graphDesktop(): GraphDesktop {
	return (engine().desktop ??= createGraphDesktop({
		store: graphStore,
		journal: desktopGraphJournal(path.join(/* turbopackIgnore: true */ syncStateDir())),
		request: (pathname, init) => syncRequest(pathname, init),
		announce,
	}));
}

const recorder = (): GraphRecorder => (serverModeEnabled() ? graphAuthority().recorder : graphDesktop().recorder);

const logged = loggedGraphStore(graphStore, recorder);

/** The graph store the app writes through: every ledger change is logged first. */
export const loggedGraph = logged.store;

/** Run a deletion that has a name ("delete these sources", "delete this node"). */
export function recordGraphAction<T>(change: GraphChange, run: () => T): T {
	return logged.action(change, run);
}

// A session lost to a take-over takes its unsent graph knowledge with it.
onSessionDiscarded((chatId) => {
	if (!serverModeEnabled()) graphDesktop().discardSession(chatId);
});
