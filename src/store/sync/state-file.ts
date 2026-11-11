/**
 * Cloud sync (Phase 5): one JSON state file under <data>/sync/, kept in
 * memory and re-read only when the file on disk has changed. The proxy and
 * the routes may load this module separately; the file is what they share.
 *
 * These files are this device's own bookkeeping and are never synced.
 */

import fs from "node:fs";
import path from "node:path";
import { writeFileAtomicSync } from "../atomic-write.ts";

export interface StateFile<T> {
	/** The state, or null when the file doesn't exist (sync has never run here). */
	read(): T | null;
	write(next: T): void;
	exists(): boolean;
}

export function stateFile<T>(file: string, isValid: (value: unknown) => value is T): StateFile<T> {
	let cached: { stamp: string; value: T | null } | null = null;
	const stampNow = (): string => {
		try {
			const st = fs.statSync(/* turbopackIgnore: true */ file);
			return `${st.mtimeMs}:${st.size}`;
		} catch {
			return "-";
		}
	};
	return {
		read() {
			const stamp = stampNow();
			if (cached && cached.stamp === stamp) return cached.value;
			let value: T | null = null;
			if (stamp !== "-") {
				const parsed: unknown = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ file, "utf-8"));
				if (!isValid(parsed)) throw new Error(`The sync state file ${path.basename(file)} can't be read.`);
				value = parsed;
			}
			cached = { stamp, value };
			return value;
		},
		write(next) {
			fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(file), { recursive: true });
			writeFileAtomicSync(file, `${JSON.stringify(next)}\n`, { allowInPlaceFallback: true });
			cached = { stamp: stampNow(), value: next };
		},
		exists() {
			return stampNow() !== "-";
		},
	};
}
