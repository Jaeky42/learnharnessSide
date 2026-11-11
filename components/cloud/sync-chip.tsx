"use client";
/**
 * THE SYNC CHIP at the foot of the session list, above Settings (cloud sync
 * Phase 6, docs/cloud-sync.md). Owner's choices: it shows only when
 * something is off, as an outline ring and a word or two, both amber:
 * OFFLINE, SYNC PAUSED or NOT PAIRED. A click opens Settings → Cloud.
 *
 * Never on a PC that was never paired, never after the learner's own
 * Unpair, never on the server's site or a phone: useSyncTrouble() is null
 * in all of those, and this renders nothing.
 */

import { CircleIcon } from "lucide-react";
import { SYNC_CHIP_TEXT } from "@/src/core";
import { useSyncTrouble } from "./cloud-state";

export function SyncChip({ onOpen }: { onOpen: () => void }) {
	const trouble = useSyncTrouble();
	if (!trouble) return null;
	return (
		<div className="px-3 pt-1">
			<button
				type="button"
				onClick={onOpen}
				data-testid="sync-chip"
				data-state={trouble}
				className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider text-amber-500 transition-colors hover:bg-accent"
			>
				{/* An outline ring, a thin line of the Settings gear's weight. */}
				<CircleIcon aria-hidden className="size-3" />
				{SYNC_CHIP_TEXT[trouble]}
			</button>
		</div>
	);
}
