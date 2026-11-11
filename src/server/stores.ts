/**
 * THE COMPOSITION ROOT for storage — the single place concrete store
 * adapters are wired. Everything else (core, services, agents) codes against
 * the port types in core/ports.ts and receives instances through this
 * module. Swapping the fs adapter for SQLite later changes exactly this
 * file (and the adapter implementations in src/store/).
 */

import { chatStore } from "../store/chats.ts";
import { graphStore } from "../store/graph.ts";
import { sourceOrganizationStore } from "../store/source-organization.ts";
import { jobStore } from "../store/jobs.ts";
import { settingsStore } from "../store/settings.ts";
import { sideTutorStore } from "../store/side-tutor.ts";
import { resolveSettings, type EffectiveSettings } from "../core/settings-resolution.ts";
import { syncCustomProvider } from "./custom-provider.ts";
import { holdsSession } from "./sync/engine.ts";
import { guardChatStore, guardJobStore, guardSideTutorStore } from "./sync/guarded-stores.ts";
/** The wired adapters. Satisfies core/graph.ts's GraphDeps structurally.
 *
 * Side-tutor fork (cloud sync Phase 5): the session stores are wrapped so a
 * session another device holds can't be changed here (sync/guarded-stores.ts).
 * Until a desktop has synced, the wrappers pass everything through. */
export const stores = {
	chatStore: guardChatStore(chatStore, holdsSession),
	graphStore,
	sourceOrganizationStore,
	jobStore: guardJobStore(jobStore, holdsSession),
	settingsStore,
	sideTutorStore: guardSideTutorStore(sideTutorStore, holdsSession),
};

export type Stores = typeof stores;

/**
 * The resolved view of the settings record (core/settings-resolution.ts):
 * every knob concrete over its factory default — EXCEPT MODELS (BYOK all
 * the way down, owner 2026-09-22): no factory pins exist, so unset model
 * slots resolve to null and per-need refusal gates fire downstream. Read
 * fresh on every call — the record is a small file and turns are rare, so
 * no caching layer (stale toggles after a settings PUT would be worse).
 */
export function effectiveSettings(): EffectiveSettings {
	return resolveSettings(settingsStore.readSettings());
}

// Boot: register the custom endpoint (when configured) into piModels(); the
// POST /api/custom-provider route re-syncs after every connect.
syncCustomProvider();
