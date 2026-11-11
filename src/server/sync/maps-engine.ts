/**
 * Cloud sync (Phase 5): the item-by-item files as this copy runs them.
 * Kept apart from engine.ts, which the proxy loads.
 *
 *   mapsAuthority()   the server's side;   mapsDesktop()   a desktop's side
 */

import path from "node:path";
import { readCloudPairing } from "../../store/sync/pairing.ts";
import { stateFile } from "../../store/sync/state-file.ts";
import { desktopVaultFolders, rememberVaultFolders } from "../../store/sync/vault-folders.ts";
import { obsidianSync } from "../obsidian-sync.ts";
import { serverModeEnabled } from "../server-auth.ts";
import { measuredClockOffsetMs, syncRequest } from "./client.ts";
import { syncStateDir } from "./engine.ts";
import { mapFiles } from "./map-views.ts";
import { createMapsAuthority, createMapsDesktop, isAuthorityMapsState, isDesktopMapsState, type MapsAuthority, type MapsDesktop } from "./maps-sync.ts";

interface MapsEngine { authority?: MapsAuthority; desktop?: MapsDesktop }
const globals = globalThis as typeof globalThis & { __lhMapsSync?: MapsEngine };
const engine = (): MapsEngine => (globals.__lhMapsSync ??= {});

export function mapsAuthority(): MapsAuthority {
	return (engine().authority ??= createMapsAuthority({
		files: mapFiles,
		state: stateFile(path.join(/* turbopackIgnore: true */ syncStateDir(), "maps.json"), isAuthorityMapsState),
		now: Date.now,
		onVaultFolders(names) {
			// Remembered for the next start of Obsidian sync; if it is running now
			// and a name is new, it restarts once to leave the folder out.
			if (rememberVaultFolders(syncStateDir(), names) && serverModeEnabled()) obsidianSync().foldersAnnounced();
		},
	}));
}

export function mapsDesktop(): MapsDesktop {
	return (engine().desktop ??= createMapsDesktop({
		files: mapFiles,
		state: stateFile(path.join(/* turbopackIgnore: true */ syncStateDir(), "maps-desktop.json"), isDesktopMapsState),
		identity: () => {
			const pairing = readCloudPairing();
			return pairing ? { server: pairing.server, deviceId: pairing.deviceId } : null;
		},
		request: (pathname, init) => syncRequest(pathname, init),
		now: Date.now,
		clockOffset: measuredClockOffsetMs,
		vaultFolders: desktopVaultFolders,
	}));
}
