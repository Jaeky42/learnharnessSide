/**
 * A small streaming .zip writer (multi-account slice 5c, "Download my data").
 * No dependency: local headers with data descriptors, deflate through
 * node:zlib, a central directory at the end. Nothing is held whole in
 * memory: each file is read in 64 KiB pieces, deflated, and handed on only
 * as fast as the reader takes it (back-pressure end to end).
 *
 * Sizes and CRC come from the bytes actually read, so a file that grows,
 * shrinks or vanishes while the archive is written still gives a valid
 * archive. A file that is gone before it is opened is left out.
 *
 * No Zip64: an archive must stay under 4 GiB with fewer than 65,535 files.
 * The caller checks that BEFORE streaming (`ZIP_LIMITS`); if a file grew past
 * the limit anyway, the stream fails (a cut-off download, never a bad archive).
 */

import fs from "node:fs";
import { pipeline, Transform } from "node:stream";
import zlib from "node:zlib";

export interface ZipSource {
	/** The name inside the archive: forward slashes, no leading slash. */
	name: string;
	/** The file on disk. */
	path: string;
}

/** What a plain (non-Zip64) archive can hold, with a margin for headers and growth. */
export const ZIP_LIMITS = {
	maxFiles: 65_000,
	/** Sum of the files' sizes at the time of the check. Deflate can add a little to incompressible data. */
	maxBytes: 3.5 * 1024 ** 3,
} as const;

/** The hard limits of the format; passing one while streaming ends the stream with this error. */
const HARD_BYTES = 0xffff_ffff - 1024 * 1024;
const HARD_FILES = 0xffff;

export class ZipLimitError extends Error {
	constructor() {
		super("The archive grew past what a plain .zip can hold.");
		this.name = "ZipLimitError";
	}
}

// ─── CRC-32 ──────────────────────────────────────────────────────────────────

const TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function tableCrc32(data: Uint8Array, previous: number): number {
	let c = ~previous >>> 0;
	for (let i = 0; i < data.length; i++) c = TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
	return ~c >>> 0;
}

/** zlib.crc32 (Node 22.2+); the table version otherwise. Both continue from `previous`. */
export const crc32: (data: Uint8Array, previous: number) => number =
	typeof (zlib as { crc32?: unknown }).crc32 === "function"
		? (data, previous) => (zlib as unknown as { crc32: (d: Uint8Array, v: number) => number }).crc32(data, previous)
		: tableCrc32;

// ─── Records ─────────────────────────────────────────────────────────────────

/** MS-DOS time and date, from the local clock (what zip tools expect). */
function dosTime(date: Date): { time: number; date: number } {
	const year = date.getFullYear();
	if (year < 1980) return { time: 0, date: (1 << 5) | 1 }; // 1980-01-01
	return {
		time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
		date: ((Math.min(year, 2107) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
	};
}

const FLAGS = 0x0808; // bit 3: sizes follow the data; bit 11: names are UTF-8
const VERSION = 20;

function localHeader(name: Buffer, stamp: { time: number; date: number }): Buffer {
	const b = Buffer.alloc(30 + name.length);
	b.writeUInt32LE(0x04034b50, 0);
	b.writeUInt16LE(VERSION, 4);
	b.writeUInt16LE(FLAGS, 6);
	b.writeUInt16LE(8, 8); // deflate
	b.writeUInt16LE(stamp.time, 10);
	b.writeUInt16LE(stamp.date, 12);
	// crc and both sizes stay 0: they follow in the data descriptor
	b.writeUInt16LE(name.length, 26);
	name.copy(b, 30);
	return b;
}

function dataDescriptor(crc: number, compressed: number, size: number): Buffer {
	const b = Buffer.alloc(16);
	b.writeUInt32LE(0x08074b50, 0);
	b.writeUInt32LE(crc, 4);
	b.writeUInt32LE(compressed, 8);
	b.writeUInt32LE(size, 12);
	return b;
}

interface Finished { name: Buffer; stamp: { time: number; date: number }; crc: number; compressed: number; size: number; offset: number }

function centralHeader(f: Finished): Buffer {
	const b = Buffer.alloc(46 + f.name.length);
	b.writeUInt32LE(0x02014b50, 0);
	b.writeUInt16LE((3 << 8) | VERSION, 4); // made by: Unix
	b.writeUInt16LE(VERSION, 6);
	b.writeUInt16LE(FLAGS, 8);
	b.writeUInt16LE(8, 10);
	b.writeUInt16LE(f.stamp.time, 12);
	b.writeUInt16LE(f.stamp.date, 14);
	b.writeUInt32LE(f.crc, 16);
	b.writeUInt32LE(f.compressed, 20);
	b.writeUInt32LE(f.size, 24);
	b.writeUInt16LE(f.name.length, 28);
	b.writeUInt32LE(((0o100644 << 16) >>> 0), 38); // a regular file, rw-r--r--
	b.writeUInt32LE(f.offset, 42);
	f.name.copy(b, 46);
	return b;
}

function endRecord(count: number, size: number, offset: number): Buffer {
	const b = Buffer.alloc(22);
	b.writeUInt32LE(0x06054b50, 0);
	b.writeUInt16LE(count, 8);
	b.writeUInt16LE(count, 10);
	b.writeUInt32LE(size, 12);
	b.writeUInt32LE(offset, 16);
	return b;
}

// ─── The stream ──────────────────────────────────────────────────────────────

/** Open for reading without following a symlink at the last step; null when gone or not a regular file. */
async function openRegular(file: string): Promise<{ handle: fs.promises.FileHandle; mtime: Date } | null> {
	let handle: fs.promises.FileHandle | undefined;
	try {
		handle = await fs.promises.open(/* turbopackIgnore: true */ file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
		const info = await handle.stat();
		if (!info.isFile()) { await handle.close(); return null; }
		return { handle, mtime: info.mtime };
	} catch {
		await handle?.close().catch(() => {});
		return null;
	}
}

/** The archive, piece by piece. Closing the generator early stops all reading. */
export async function* zipChunks(sources: ZipSource[]): AsyncGenerator<Uint8Array> {
	const done: Finished[] = [];
	let offset = 0;
	for (const source of sources) {
		const opened = await openRegular(source.path);
		if (!opened) continue; // vanished (or swapped for a link) since it was listed
		if (done.length >= HARD_FILES) { await opened.handle.close().catch(() => {}); throw new ZipLimitError(); }
		const name = Buffer.from(source.name, "utf8");
		const stamp = dosTime(opened.mtime);
		const start = offset;
		const head = localHeader(name, stamp);
		offset += head.length;
		yield head;

		let crc = 0;
		let size = 0;
		let compressed = 0;
		const counter = new Transform({
			transform(chunk: Buffer, _encoding, callback) {
				crc = crc32(chunk, crc);
				size += chunk.length;
				callback(size > HARD_BYTES ? new ZipLimitError() : null, chunk);
			},
		});
		const deflate = zlib.createDeflateRaw({ level: 6 });
		const read = opened.handle.createReadStream({ highWaterMark: 64 * 1024 });
		pipeline(read, counter, deflate, () => { /* the error, if any, reaches the loop below through deflate */ });
		try {
			for await (const piece of deflate as AsyncIterable<Buffer>) {
				compressed += piece.length;
				offset += piece.length;
				if (offset > HARD_BYTES) throw new ZipLimitError();
				yield piece;
			}
		} finally {
			deflate.destroy();
			read.destroy();
			await opened.handle.close().catch(() => {});
		}
		const descriptor = dataDescriptor(crc, compressed, size);
		offset += descriptor.length;
		yield descriptor;
		done.push({ name, stamp, crc, compressed, size, offset: start });
	}

	const directoryStart = offset;
	for (const entry of done) {
		const record = centralHeader(entry);
		offset += record.length;
		yield record;
	}
	const end = endRecord(done.length, offset - directoryStart, directoryStart);
	yield end;
}

/** The same, as a web ReadableStream a route can return. `onEnd` runs once, whichever way it ends. */
export function zipStream(sources: ZipSource[], onEnd?: () => void): ReadableStream<Uint8Array> {
	const iterator = zipChunks(sources);
	let ended = false;
	const finish = () => { if (!ended) { ended = true; onEnd?.(); } };
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const next = await iterator.next();
				if (next.done) { finish(); controller.close(); } else controller.enqueue(next.value);
			} catch (error) {
				finish();
				controller.error(error);
			}
		},
		async cancel() {
			try { await iterator.return(undefined); } finally { finish(); }
		},
	}, { highWaterMark: 0 });
}
