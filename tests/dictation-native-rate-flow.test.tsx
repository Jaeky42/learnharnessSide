/**
 * FORK (Firefox sample rate): the capture graph falls back to a native-rate
 * AudioContext when the 16 kHz one throws NotSupportedError (Firefox), and
 * stays exactly as before everywhere else.
 */
import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { parseHTML } from "linkedom";
import { DictationBar, __resetAudioGraphForTests, useDictation, type Dictation } from "../components/dictation.tsx";

class Socket extends EventTarget {
	static CONNECTING = 0;
	static OPEN = 1;
	static all: Socket[] = [];
	readyState = Socket.CONNECTING;
	sent: unknown[] = [];
	constructor(readonly url: string, readonly protocols: string[]) { super(); Socket.all.push(this); }
	send(data: unknown) { this.sent.push(data); }
	close() { this.readyState = 3; }
	open() { this.readyState = Socket.OPEN; this.dispatchEvent(new Event("open")); }
}

type Behavior = "firefox" | "always" | "never" | "other-error";
const rig = { moduleGate: null as Promise<void> | null, behavior: "never" as Behavior, contexts: [] as FakeContext[], nodes: [] as FakeWorklet[], sources: [] as { disconnected: boolean }[], stops: 0 };

class FakeContext {
	state = "running";
	destination = {};
	closed = false;
	audioWorklet = { modules: [] as string[], addModule: async (url: string) => { this.audioWorklet.modules.push(url); if (!this.fixed16k && rig.moduleGate) await rig.moduleGate; } };
	constructor(readonly options?: { sampleRate?: number }) { rig.contexts.push(this); }
	get fixed16k() { return this.options?.sampleRate === 16000; }
	createMediaStreamSource() {
		const fails =
			rig.behavior === "always" || (rig.behavior === "firefox" && this.fixed16k);
		if (fails) throw new DOMException("Connecting AudioNodes from AudioContexts with different sample-rate is currently not supported.", "NotSupportedError");
		if (rig.behavior === "other-error") throw new Error("boom");
		const source = { disconnected: false, connect() {}, disconnect() { this.disconnected = true; } };
		rig.sources.push(source);
		return source;
	}
	async close() { this.closed = true; }
}
class FakeWorklet {
	port: { onmessage?: (e: { data: unknown }) => void } = {};
	disconnected = false;
	constructor(readonly ctx: FakeContext, readonly name: string, readonly options?: unknown) { rig.nodes.push(this); }
	connect() {}
	disconnect() { this.disconnected = true; }
}

let restore: (() => void) | undefined;
let dispose: (() => Promise<void>) | undefined;

async function fixture() {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({
		React, window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent,
		ResizeObserver: class { observe() {} disconnect() {} },
		navigator: { userAgent: "", platform: "", mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() { rig.stops++; } }] }) } },
		WebSocket: Socket, AudioContext: FakeContext, AudioWorkletNode: FakeWorklet,
		IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async (url: string) => {
			if (url === "/api/stt/token") return Response.json({ token: "test-token" });
			return Response.json({ settings: { version: 1, dictation: { language: "en" } } });
		},
	})) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	restore = () => {
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete (globalThis as Record<string, unknown>)[key];
		}
	};
	const { createRoot } = await import("react-dom/client");
	let latest!: Dictation;
	function Harness() {
		latest = useDictation({ append: () => {} });
		return <DictationBar dictation={latest} />;
	}
	const root = createRoot(document.getElementById("root")!);
	await act(async () => { root.render(<Harness />); });
	dispose = async () => { await act(async () => { root.unmount(); }); };
	return { get dictation() { return latest; } };
}

async function settle() {
	await act(async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); });
}

async function startRun(f: Awaited<ReturnType<typeof fixture>>) {
	await act(async () => { f.dictation.toggle(); });
	await settle();
}

beforeEach(() => {
	__resetAudioGraphForTests();
	rig.behavior = "never";
	rig.moduleGate = null;
	rig.contexts = [];
	rig.nodes = [];
	rig.sources = [];
	rig.stops = 0;
	Socket.all = [];
});
afterEach(async () => {
	await dispose?.();
	restore?.();
	dispose = undefined;
	restore = undefined;
	__resetAudioGraphForTests();
});

const toggleButton = () => document.querySelector('[data-testid="dictation-toggle"]');

test("a browser where 16 kHz works keeps today's graph: one 16 kHz context, a plain worklet node", async () => {
	const f = await fixture();
	await startRun(f);
	assert.equal(rig.contexts.length, 1);
	assert.deepEqual(rig.contexts[0]!.options, { sampleRate: 16000 });
	assert.equal(rig.nodes.length, 1);
	assert.equal(rig.nodes[0]!.options, undefined);
	assert.equal(rig.contexts[0]!.closed, false);
	await act(async () => { Socket.all[0]!.open(); });
	assert.equal(f.dictation.phase, "recording");
	assert.equal(f.dictation.error, null);
});

test("NotSupportedError from the 16 kHz graph retries once natively and records", async () => {
	rig.behavior = "firefox";
	const f = await fixture();
	await startRun(f);
	assert.equal(rig.contexts.length, 2);
	const [first, second] = rig.contexts as [FakeContext, FakeContext];
	assert.deepEqual(first.options, { sampleRate: 16000 });
	assert.equal(second.options, undefined, "the retry uses the default (native) rate");
	assert.equal(first.closed, true);
	assert.equal(second.closed, false);
	assert.equal(rig.nodes.length, 2);
	assert.equal(rig.nodes[0]!.disconnected, true, "the failed attempt's worklet node is disconnected");
	assert.deepEqual(rig.nodes[1]!.options, { processorOptions: { targetRate: 16000 } });
	assert.equal(rig.nodes[1]!.ctx, second);
	assert.deepEqual(second.audioWorklet.modules, ["/worklets/pcm-capture.js"], "the module is loaded on the new context");
	assert.equal(f.dictation.error, null);
	await act(async () => { Socket.all[0]!.open(); });
	assert.equal(f.dictation.phase, "recording");
});

test("a second run after the fallback builds no 16 kHz context", async () => {
	rig.behavior = "firefox";
	const f = await fixture();
	await startRun(f);
	await act(async () => { Socket.all[0]!.open(); });
	await act(async () => { f.dictation.cancel(); });
	await settle();
	assert.equal(f.dictation.phase, "idle");
	const contextsBefore = rig.contexts.length;
	await startRun(f);
	assert.equal(rig.contexts.length, contextsBefore, "the native context is reused");
	assert.equal(rig.contexts.filter((c) => c.fixed16k).length, 1, "only the first run ever built a 16 kHz context");
	assert.equal(rig.nodes.at(-1)!.ctx, rig.contexts.at(-1));
	assert.deepEqual(rig.nodes.at(-1)!.options, { processorOptions: { targetRate: 16000 } });
	await act(async () => { Socket.all.at(-1)!.open(); });
	assert.equal(f.dictation.phase, "recording");
});

test("when the native graph fails too, the run ends idle with the error and the stream is stopped", async () => {
	rig.behavior = "always";
	const f = await fixture();
	assert.equal(toggleButton()!.hasAttribute("data-dictation-error"), false);
	await startRun(f);
	assert.equal(rig.contexts.length, 2, "exactly one retry");
	assert.equal(f.dictation.phase, "idle");
	assert.match(f.dictation.error ?? "", /sample-rate/);
	assert.ok(rig.stops >= 1, "the microphone is released");
	assert.equal(Socket.all.length, 0);
	assert.equal(toggleButton()!.hasAttribute("data-dictation-error"), true);
	assert.equal(toggleButton()!.getAttribute("data-dictation-error"), "");
	// Clearing the error removes the attribute again.
	await act(async () => { f.dictation.clearError(); });
	assert.equal(toggleButton()!.hasAttribute("data-dictation-error"), false);
});

test("a failure that is not NotSupportedError does not trigger the retry", async () => {
	rig.behavior = "other-error";
	const f = await fixture();
	await startRun(f);
	assert.equal(rig.contexts.length, 1);
	assert.equal(rig.contexts[0]!.closed, false);
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.dictation.error, "boom");
});

test("a run cancelled while the retry loads its module leaves nothing recording", async () => {
	rig.behavior = "firefox";
	let release!: () => void;
	rig.moduleGate = new Promise<void>((resolve) => { release = resolve; });
	const f = await fixture();
	await act(async () => { f.dictation.toggle(); });
	await settle();
	assert.equal(rig.contexts.length, 2, "the retry is waiting on its module");
	assert.equal(f.dictation.phase, "connecting");
	await act(async () => { f.dictation.cancel(); });
	await act(async () => { release(); });
	await settle();
	assert.equal(f.dictation.phase, "idle");
	assert.equal(rig.nodes.length, 1, "no worklet node is built for the stale run");
	assert.equal(Socket.all.length, 0);
	assert.equal(f.dictation.error, null);
	assert.ok(rig.stops >= 1, "the microphone is released");
});
