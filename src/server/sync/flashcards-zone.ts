/**
 * Flashcards sync, decision S2 (docs/phone-plugins-plan.md): THE SERVER
 * FOLLOWS THE PC's TIME ZONE. Flashcards works out study days, due dates and
 * daily limits in the local time of the process it runs in (its scheduler
 * uses Date's local getters; its review tickets check the Intl zone). The
 * Windows app sends its zone with the Flashcards exchange when it changes;
 * the server keeps it and runs its whole program in it, at once and at
 * every start, before the plugin works anything out (instrumentation.ts).
 * With two PCs in different zones, the most recently changed one counts.
 *
 *   <data>/sync/time-zone.json   { version: 1, zone, from: <device id>, at }
 *
 * Nothing here runs on a server nobody paired with: the file only appears
 * when a paired desktop sends its zone. Setting `process.env.TZ` in Node
 * changes Date's local getters and Intl's default zone in the running
 * process (tests/sync-flashcards-zone.test.ts checks both).
 */

import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../../config.ts";
import { writeFileAtomicSync } from "../../store/atomic-write.ts";

export interface TimeZoneRecord { version: 1; zone: string; from: string; at: number }

const defaultSyncDir = (): string => path.join(/* turbopackIgnore: true */ PATHS.data, "sync");
const zoneFile = (syncDir: string): string => path.join(/* turbopackIgnore: true */ syncDir, "time-zone.json");

/** An IANA zone name this Node knows ("Europe/Stockholm", "UTC"). */
export function isTimeZoneName(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(value)) return false;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value });
		return true;
	} catch {
		return false;
	}
}

/** This process's own zone, as a desktop sends it. */
export function localTimeZone(): string | null {
	try {
		const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		return isTimeZoneName(zone) ? zone : null;
	} catch {
		return null;
	}
}

export function storedTimeZone(syncDir = defaultSyncDir()): TimeZoneRecord | null {
	try {
		const value = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ zoneFile(syncDir), "utf-8")) as TimeZoneRecord;
		return value && value.version === 1 && isTimeZoneName(value.zone) ? value : null;
	} catch {
		return null;
	}
}

/** Run this process in `zone` from now on. True when it changed. */
export function applyTimeZone(zone: string): boolean {
	if (!isTimeZoneName(zone) || process.env.TZ === zone) return false;
	process.env.TZ = zone;
	console.log(`[LearnHarness] Flashcards sync: this server now keeps time in ${zone}, the paired desktop app's time zone.`);
	return true;
}

/** The server's side: a paired desktop said its zone. Kept, and used at once. */
export function takeTimeZone(deviceId: string, zone: string, options: { syncDir?: string; now?: number } = {}): void {
	if (!isTimeZoneName(zone)) return;
	const syncDir = options.syncDir ?? defaultSyncDir();
	if (storedTimeZone(syncDir)?.zone !== zone) {
		fs.mkdirSync(/* turbopackIgnore: true */ syncDir, { recursive: true });
		writeFileAtomicSync(zoneFile(syncDir), `${JSON.stringify({ version: 1, zone, from: deviceId, at: options.now ?? Date.now() } satisfies TimeZoneRecord)}\n`);
	}
	applyTimeZone(zone);
}

/** At start, before the plugins: the zone a paired desktop gave, if one ever did. */
export function applyStoredTimeZone(syncDir = defaultSyncDir()): void {
	const record = storedTimeZone(syncDir);
	if (record) applyTimeZone(record.zone);
}
