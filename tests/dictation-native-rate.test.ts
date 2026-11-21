/**
 * FORK (Firefox sample rate): the pcm-capture worklet's rate conversion
 * (processorOptions.targetRate), run in Node with the AudioWorklet globals
 * stubbed. The unchanged path is compared sample for sample against the
 * worklet as it was before the fork edit, kept as a fixture
 * (tests/fixtures/pcm-capture-before-native-rate.js), and against a
 * reference implementation of the same loop.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

type Msg = { type: "level"; rms: number } | { type: "audio"; buffer: Int16Array };
interface Processor {
	port: { messages: Msg[] };
	process(inputs: Float32Array[][]): boolean;
}

const root = join(import.meta.dirname, "..");

function load(source: string, sampleRate: number): new (options?: unknown) => Processor {
	let registered: (new (options?: unknown) => Processor) | undefined;
	class AudioWorkletProcessor {
		port = {
			messages: [] as Msg[],
			postMessage(message: Msg) {
				this.messages.push(message);
			},
		};
	}
	new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", source)(
		AudioWorkletProcessor,
		(_name: string, ctor: new (options?: unknown) => Processor) => {
			registered = ctor;
		},
		sampleRate,
	);
	assert.ok(registered);
	return registered;
}

const current = readFileSync(join(root, "public/worklets/pcm-capture.js"), "utf8");
const original = readFileSync(join(root, "tests/fixtures/pcm-capture-before-native-rate.js"), "utf8");

function run(Ctor: new (options?: unknown) => Processor, signal: Float32Array, quantum = 128) {
	const p = new Ctor({ processorOptions: undefined });
	return feed(p, signal, quantum);
}

function feed(p: Processor, signal: Float32Array, quantum = 128) {
	for (let at = 0; at + quantum <= signal.length; at += quantum) p.process([[signal.subarray(at, at + quantum)]]);
	const audio: number[] = [];
	const levels: number[] = [];
	const frameLengths: number[] = [];
	for (const m of p.port.messages) {
		if (m.type === "audio") {
			frameLengths.push(m.buffer.length);
			audio.push(...m.buffer);
		} else levels.push(m.rms);
	}
	return { audio, levels, frameLengths };
}

function sine(freq: number, rate: number, seconds: number, amp = 0.5) {
	const out = new Float32Array(Math.round(rate * seconds));
	for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
	return out;
}

function reference(signal: Float32Array) {
	const out: number[] = [];
	for (const v of signal) {
		const s = Math.max(-1, Math.min(1, v));
		out.push(s < 0 ? s * 0x8000 : s * 0x7fff);
	}
	return out.map((v) => Math.trunc(v)); // Int16Array stores truncate toward zero
}

function noise(n: number) {
	const out = new Float32Array(n);
	let seed = 12345;
	for (let i = 0; i < n; i++) {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		out[i] = (seed / 0x7fffffff) * 3 - 1.5; // exceeds ±1 to exercise the clamp
	}
	return out;
}

/** Amplitude and frequency by correlation with a probe sinusoid at `rate`. */
function amplitudeAt(samples: number[], freq: number, rate: number) {
	let re = 0;
	let im = 0;
	for (let i = 0; i < samples.length; i++) {
		const a = (2 * Math.PI * freq * i) / rate;
		re += (samples[i]! / 0x7fff) * Math.cos(a);
		im += (samples[i]! / 0x7fff) * Math.sin(a);
	}
	return (2 * Math.hypot(re, im)) / samples.length;
}

describe("pcm-capture at the native 16 kHz path", () => {
	it("matches a straightforward Float32 to Int16 reference", () => {
		const Ctor = load(current, 16000);
		const signal = noise(128 * 200);
		const { audio, frameLengths } = run(Ctor, signal);
		const expected = reference(signal);
		const whole = Math.floor(expected.length / 2048) * 2048;
		assert.deepEqual(audio, expected.slice(0, whole));
		assert.ok(frameLengths.every((n) => n === 2048));
	});

	it("is identical to the worklet before the change, sample for sample", () => {
		const signal = noise(128 * 300);
		const before = run(load(original, 16000), signal);
		const after = run(load(current, 16000), signal);
		assert.deepEqual(after.audio, before.audio);
		assert.deepEqual(after.levels, before.levels);
		// An explicit targetRate equal to the context's rate is the same path.
		const same = feed(new (load(current, 16000))({ processorOptions: { targetRate: 16000 } }), signal);
		assert.deepEqual(same.audio, before.audio);
	});

	it("posts the quantum RMS as a level message", () => {
		const Ctor = load(current, 16000);
		const p = new Ctor();
		p.process([[new Float32Array(128).fill(0.5)]]);
		assert.deepEqual(p.port.messages[0], { type: "level", rms: 0.5 });
		assert.equal(p.process([[]]), true);
		assert.equal(p.process([]), true);
	});
});

describe("pcm-capture converting to 16 kHz", () => {
	for (const rate of [48000, 44100, 96000]) {
		it(`${rate} Hz to 16 kHz: count, framing and a 440 Hz tone`, () => {
			const Ctor = load(current, rate);
			const seconds = 1;
			const signal = sine(440, rate, seconds, 0.5);
			const { audio, frameLengths } = feed(new Ctor({ processorOptions: { targetRate: 16000 } }), signal);
			assert.ok(frameLengths.every((n) => n === 2048));
			assert.ok(audio.length <= 16000 && audio.length > 16000 - 2048, `got ${audio.length}`);
			const body = audio.slice(64); // skip the filter's first samples
			const amp = amplitudeAt(body, 440, 16000);
			assert.ok(Math.abs(amp - 0.5) < 0.05, `amplitude ${amp}`);
			for (const other of [330, 550, 1000]) assert.ok(amplitudeAt(body, other, 16000) < 0.08, `leak at ${other}`);
		});
	}

	it("keeps DC steady across quantum edges (no gaps or clicks)", () => {
		for (const rate of [48000, 44100]) {
			const Ctor = load(current, rate);
			const signal = new Float32Array(128 * 400).fill(0.25);
			const { audio } = feed(new Ctor({ processorOptions: { targetRate: 16000 } }), signal);
			assert.ok(audio.length > 16000);
			const expected = 0.25 * 0x7fff;
			for (const v of audio) assert.ok(Math.abs(v - expected) <= 2, `${rate}: ${v} vs ${expected}`);
		}
	});

	it("does not drift: output count follows input count at the exact ratio", () => {
		const Ctor = load(current, 44100);
		const p = new Ctor({ processorOptions: { targetRate: 16000 } });
		const quanta = 3445 * 4; // 4 s of input
		const total = quanta * 128;
		feed(p, new Float32Array(total).fill(0.1));
		let emitted = 0;
		for (const m of p.port.messages) if (m.type === "audio") emitted += m.buffer.length;
		const expected = (total * 16000) / 44100;
		assert.ok(expected - emitted < 2048 + 1 && emitted <= expected, `${emitted} vs ${expected}`);
	});

	it("8 kHz up to 16 kHz: count, continuity and the tone", () => {
		const Ctor = load(current, 8000);
		const signal = sine(440, 8000, 1, 0.5);
		const { audio, frameLengths } = feed(new Ctor({ processorOptions: { targetRate: 16000 } }), signal);
		assert.ok(frameLengths.every((n) => n === 2048));
		assert.ok(audio.length <= 16000 && audio.length > 16000 - 2048, `got ${audio.length}`);
		const amp = amplitudeAt(audio.slice(64), 440, 16000);
		assert.ok(Math.abs(amp - 0.5) < 0.05, `amplitude ${amp}`);
		const dc = feed(new Ctor({ processorOptions: { targetRate: 16000 } }), new Float32Array(128 * 200).fill(0.25));
		for (const v of dc.audio) assert.ok(Math.abs(v - 0.25 * 0x7fff) <= 2);
		// Continuity: consecutive outputs of a slow tone never jump.
		let maxStep = 0;
		for (let i = 1; i < audio.length; i++) maxStep = Math.max(maxStep, Math.abs(audio[i]! - audio[i - 1]!));
		assert.ok(maxStep < 0.5 * 0x7fff * 2 * Math.PI * 440 / 16000 * 1.5, `step ${maxStep}`);
	});

	it("level messages are the input quantum's RMS in every mode", () => {
		const signal = sine(440, 48000, 0.2, 0.5);
		const levels = (rate: number, options?: unknown) => {
			const p = new (load(current, rate))(options);
			return feed(p, rate === 48000 ? signal : sine(440, rate, 0.2, 0.5)).levels;
		};
		const direct = levels(48000);
		const down = levels(48000, { processorOptions: { targetRate: 16000 } });
		assert.deepEqual(down, direct);
		const up = levels(8000, { processorOptions: { targetRate: 16000 } });
		assert.ok(up.every((v) => Math.abs(v - 0.5 / Math.SQRT2) < 0.02));
		assert.equal(direct.length, Math.floor(signal.length / 128));
	});

	it("clamps hot input like the direct path", () => {
		const Ctor = load(current, 48000);
		const { audio } = feed(new Ctor({ processorOptions: { targetRate: 16000 } }), new Float32Array(128 * 400).fill(3));
		assert.ok(audio.length > 0 && audio.every((v) => v === 0x7fff));
	});
});
