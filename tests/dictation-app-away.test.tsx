/**
 * FORK (dictation after the app was away): a kept audio engine that won't run
 * after the page was suspended is replaced once per run, a silent engine is
 * caught by a net that doesn't block the start, and a microphone taken away
 * mid-run ends the run as Stop does (words kept, no error).
 */
import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { parseHTML } from "linkedom";
import { createRoot } from "react-dom/client";
import { __resetAudioGraphForTests, useDictation, type Dictation } from "../components/dictation.tsx";
import {
	DICTATION_MIC_DEAD,
	ENGINE_LAST_CHANCE_MS,
	ENGINE_RESUME_CAP_MS,
	ENGINE_SILENT_CHECK_MS,
	LOSS_GRACE_MS,
	SHOWN_RECENTLY_MS,
	captureErrorMessage,
	captureEvidence,
	captureLost,
	engineRunning,
	engineSilent,
	lossAction,
	resumeWithin,
} from "../components/dictation-capture.ts";

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
	final(text: string) {
		const data = JSON.stringify({ type: "Results", is_final: true, channel: { alternatives: [{ transcript: text }] } });
		this.dispatchEvent(Object.assign(new Event("message"), { data }));
	}
	drop(code: number) { this.readyState = 3; this.dispatchEvent(Object.assign(new Event("close"), { code })); }
	get closeStreamSent() { return this.sent.some((d) => typeof d === "string" && d.includes("CloseStream")); }
}

type ResumeMode = "resolve" | "reject" | "hang";
const rig = {
	contexts: [] as Ctx[],
	nodes: [] as Node[],
	tracks: [] as Track[],
	appends: [] as string[],
	firefox: false,
	setup: (_ctx: Ctx, _index: number) => {},
};

class Ctx extends EventTarget {
	state = "running";
	currentTime = 0;
	destination = {};
	closed = false;
	resumeMode: ResumeMode = "resolve";
	resumes = 0;
	audioWorklet = { addModule: async () => {} };
	constructor(readonly options?: { sampleRate?: number }) { super(); rig.contexts.push(this); rig.setup(this, rig.contexts.length - 1); }
	get fixed16k() { return this.options?.sampleRate === 16000; }
	resume() {
		this.resumes++;
		if (this.resumeMode === "hang") return new Promise<void>(() => {});
		if (this.resumeMode === "reject") return Promise.reject(new DOMException("can't", "InvalidStateError"));
		this.set("running");
		return Promise.resolve();
	}
	set(state: string) { this.state = state; this.dispatchEvent(new Event("statechange")); }
	createMediaStreamSource() {
		if (rig.firefox && this.fixed16k) throw new DOMException("different sample-rate", "NotSupportedError");
		return { connect() {}, disconnect() {} };
	}
	close() { this.closed = true; this.state = "closed"; return Promise.resolve(); }
}
class Node {
	port: { onmessage?: (e: { data: unknown }) => void } = {};
	disconnected = false;
	constructor(readonly ctx: Ctx, readonly name: string, readonly options?: unknown) { rig.nodes.push(this); }
	connect() {}
	disconnect() { this.disconnected = true; }
	say() { this.port.onmessage?.({ data: { type: "level", rms: 0.2 } }); }
}
class Track extends EventTarget {
	readyState = "live";
	muted = false;
	stopped = false;
	constructor() { super(); rig.tracks.push(this); }
	stop() { this.stopped = true; this.readyState = "ended"; } // a real stop() fires no "ended"
	end() { this.readyState = "ended"; this.dispatchEvent(new Event("ended")); }
	mute() { this.muted = true; this.dispatchEvent(new Event("mute")); }
	unmute() { this.muted = false; this.dispatchEvent(new Event("unmute")); }
}

let visibility: "visible" | "hidden" = "visible";
let restore: (() => void) | undefined;
let dispose: (() => Promise<void>) | undefined;
/** Timers the recorder left set (setTimeout wrapped over the mocked clock). */
const pending = new Set<unknown>();
let unwrapTimers: (() => void) | undefined;

async function fixture() {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	Object.defineProperty(dom.document, "visibilityState", { configurable: true, get: () => visibility });
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries({
		React, window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent,
		navigator: { userAgent: "", platform: "", mediaDevices: { getUserMedia: async () => { const track = new Track(); return { getTracks: () => [track] }; } } },
		WebSocket: Socket, AudioContext: Ctx, AudioWorkletNode: Node,
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
	let latest!: Dictation;
	function Harness() {
		latest = useDictation({ append: (text) => { rig.appends.push(text); } });
		return null;
	}
	const root = createRoot(document.getElementById("root")!);
	await act(async () => { root.render(<Harness />); });
	dispose = async () => { await act(async () => { root.unmount(); }); };
	return {
		get dictation() { return latest; },
		setVisibility(next: "visible" | "hidden") {
			visibility = next;
			dom.document.dispatchEvent(new dom.window.Event("visibilitychange"));
		},
	};
}

async function settle() {
	await act(async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); });
}
async function tick(ms: number) {
	await act(async () => { mock.timers.tick(ms); });
	await settle();
}
async function begin(f: Awaited<ReturnType<typeof fixture>>) {
	await act(async () => { f.dictation.toggle(); });
	await settle();
}
/** Start, open the socket, and keep the engine visibly alive. */
async function record(f: Awaited<ReturnType<typeof fixture>>) {
	await begin(f);
	await act(async () => { Socket.all.at(-1)!.open(); });
	rig.nodes.at(-1)!.say();
	assert.equal(f.dictation.phase, "recording");
}
async function closeNormally() {
	await act(async () => { Socket.all.at(-1)!.drop(1000); });
	await settle();
}

beforeEach(() => {
	__resetAudioGraphForTests();
	rig.contexts = [];
	rig.nodes = [];
	rig.tracks = [];
	rig.appends = [];
	rig.firefox = false;
	rig.setup = () => {};
	visibility = "visible";
	Socket.all = [];
	mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
	const set = globalThis.setTimeout;
	const clear = globalThis.clearTimeout;
	pending.clear();
	globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
		const id = set(() => { pending.delete(id); fn(...args); }, ms);
		pending.add(id);
		return id;
	}) as typeof setTimeout;
	globalThis.clearTimeout = ((id: unknown) => { pending.delete(id); clear(id as ReturnType<typeof setTimeout>); }) as typeof clearTimeout;
	unwrapTimers = () => { globalThis.setTimeout = set; globalThis.clearTimeout = clear; };
});
afterEach(async () => {
	await dispose?.();
	restore?.();
	dispose = undefined;
	restore = undefined;
	unwrapTimers?.();
	mock.timers.reset();
	__resetAudioGraphForTests();
});

// 1–4: starting when the kept engine is dead

test("a kept engine reading 'interrupted' whose resume hangs is replaced after the cap; the run records", async () => {
	const f = await fixture();
	await record(f);
	await act(async () => { f.dictation.cancel(); });
	await settle();
	const kept = rig.contexts[0]!;
	kept.state = "interrupted";
	kept.resumeMode = "hang";
	await begin(f);
	assert.equal(kept.resumes, 1);
	assert.equal(rig.contexts.length, 1, "nothing replaced before the cap");
	await tick(ENGINE_RESUME_CAP_MS);
	assert.equal(rig.contexts.length, 2, "a fresh engine");
	assert.equal(kept.closed, true, "the dead one is closed");
	assert.equal(rig.nodes.at(-1)!.ctx, rig.contexts[1]);
	await act(async () => { Socket.all.at(-1)!.open(); });
	assert.equal(f.dictation.phase, "recording");
	assert.equal(f.dictation.error, null);
});

test("a 'suspended' engine whose resume resolves is resumed once and kept (today's calls)", async () => {
	rig.setup = (ctx) => { ctx.state = "suspended"; };
	const f = await fixture();
	await begin(f);
	assert.equal(rig.contexts.length, 1);
	assert.equal(rig.contexts[0]!.resumes, 1);
	assert.equal(rig.contexts[0]!.closed, false);
	await act(async () => { Socket.all[0]!.open(); });
	assert.equal(f.dictation.phase, "recording");
});

test("a resume that rejects counts as 'look again', and the engine is replaced", async () => {
	rig.setup = (ctx, index) => { if (index === 0) { ctx.state = "suspended"; ctx.resumeMode = "reject"; } };
	const f = await fixture();
	await begin(f);
	assert.equal(rig.contexts.length, 2);
	await act(async () => { Socket.all[0]!.open(); });
	assert.equal(f.dictation.phase, "recording");
	assert.equal(f.dictation.error, null);
});

test("a healthy running engine: no resume, no second engine, no timers left after the run", async () => {
	const f = await fixture();
	await record(f);
	assert.equal(rig.contexts.length, 1);
	assert.equal(rig.contexts[0]!.resumes, 0);
	await act(async () => { Socket.all[0]!.final("all good"); });
	await act(async () => { f.dictation.stop(); });
	await closeNormally();
	assert.equal(f.dictation.phase, "idle");
	assert.deepEqual(rig.appends, ["all good"]);
	assert.equal(pending.size, 0, "every timer the recorder set is gone");
	await tick(10_000);
	assert.equal(rig.contexts.length, 1);
	assert.equal(f.dictation.error, null);
});

test("when the fresh engine won't run either, the run ends with DICTATION_MIC_DEAD", async () => {
	const f = await fixture();
	await record(f);
	await act(async () => { f.dictation.cancel(); });
	await settle();
	rig.contexts[0]!.state = "interrupted";
	rig.contexts[0]!.resumeMode = "hang";
	rig.setup = (ctx) => { ctx.state = "interrupted"; ctx.resumeMode = "hang"; };
	Socket.all = [];
	await begin(f);
	await tick(ENGINE_RESUME_CAP_MS);
	assert.equal(rig.contexts.length, 2, "the kept engine gets the short wait");
	assert.equal(f.dictation.phase, "connecting");
	await tick(ENGINE_RESUME_CAP_MS);
	assert.equal(f.dictation.error, null, "the fresh engine is waited for longer");
	assert.equal(f.dictation.phase, "connecting");
	await tick(ENGINE_LAST_CHANCE_MS - ENGINE_RESUME_CAP_MS);
	assert.equal(rig.contexts.length, 2, "one replacement per run");
	assert.equal(f.dictation.error, DICTATION_MIC_DEAD);
	assert.equal(f.dictation.error, "Microphone didn't start. Try again.");
	assert.equal(f.dictation.phase, "idle");
	assert.ok(rig.tracks.every((t) => t.stopped), "the microphone is released");
	assert.equal(Socket.all.length, 0);
	assert.equal(pending.size, 0);
});

test("an engine that is only slow to start is waited for: the page's first engine, and a replacement", async () => {
	const slow = (ctx: Ctx) => {
		ctx.state = "suspended";
		ctx.resume = () => { ctx.resumes++; return new Promise<void>((resolve) => { setTimeout(() => { ctx.set("running"); resolve(); }, 2000); }); };
	};
	rig.setup = slow;
	const f = await fixture();
	await begin(f);
	await tick(ENGINE_RESUME_CAP_MS * 2);
	assert.equal(rig.contexts.length, 1, "not replaced at the short wait");
	assert.equal(f.dictation.error, null);
	await tick(2000 - ENGINE_RESUME_CAP_MS * 2);
	assert.equal(rig.contexts.length, 1);
	await act(async () => { Socket.all[0]!.open(); });
	rig.nodes.at(-1)!.say();
	assert.equal(f.dictation.phase, "recording");
	await act(async () => { f.dictation.cancel(); });
	await settle();
	// the kept engine is now stuck; its replacement is slow, not dead
	rig.contexts[0]!.state = "interrupted";
	rig.contexts[0]!.resume = () => new Promise<void>(() => {});
	await begin(f);
	await tick(ENGINE_RESUME_CAP_MS);
	assert.equal(rig.contexts.length, 2);
	await tick(2000);
	assert.equal(rig.contexts.length, 2);
	assert.equal(f.dictation.error, null);
	await act(async () => { Socket.all.at(-1)!.open(); });
	assert.equal(f.dictation.phase, "recording");
});

// 5–6: the silent-engine net

test("a 'running' engine that is silent is replaced once; silent again ends the run with DICTATION_MIC_DEAD", async () => {
	const f = await fixture();
	await begin(f);
	await act(async () => { Socket.all[0]!.open(); });
	assert.equal(f.dictation.phase, "recording");
	await tick(ENGINE_SILENT_CHECK_MS - 1);
	assert.equal(rig.contexts.length, 1, "nothing before the check");
	await tick(1);
	assert.equal(rig.contexts.length, 2, "replaced");
	assert.equal(rig.contexts[0]!.closed, true);
	assert.equal(rig.nodes[0]!.disconnected, true);
	assert.equal(rig.nodes.at(-1)!.ctx, rig.contexts[1]);
	assert.equal(Socket.all.length, 1, "the socket is left alone");
	assert.equal(f.dictation.phase, "recording");
	assert.equal(f.dictation.error, null);
	assert.equal(rig.tracks[0]!.stopped, false, "same stream");
	await tick(ENGINE_SILENT_CHECK_MS);
	assert.equal(f.dictation.error, null, "the check that would end the run is patient");
	assert.equal(f.dictation.phase, "recording");
	await tick(ENGINE_LAST_CHANCE_MS - ENGINE_SILENT_CHECK_MS);
	assert.equal(f.dictation.error, DICTATION_MIC_DEAD);
	assert.equal(f.dictation.phase, "idle");
	assert.equal(rig.contexts.length, 2);
	assert.equal(pending.size, 0);
});

test("a worklet message, or a clock that moved, keeps the engine", async () => {
	const f = await fixture();
	await begin(f);
	rig.nodes[0]!.say();
	await tick(ENGINE_SILENT_CHECK_MS * 3);
	assert.equal(rig.contexts.length, 1);
	await act(async () => { f.dictation.cancel(); });
	await settle();
	await begin(f);
	rig.contexts[0]!.currentTime = 0.5;
	await tick(ENGINE_SILENT_CHECK_MS * 3);
	assert.equal(rig.contexts.length, 1);
	assert.equal(f.dictation.error, null);
	assert.equal(f.dictation.phase, "connecting");
});

test("a second run after a replacement uses the replacement engine", async () => {
	const f = await fixture();
	await begin(f);
	await act(async () => { Socket.all[0]!.open(); });
	await tick(ENGINE_SILENT_CHECK_MS);
	assert.equal(rig.contexts.length, 2);
	rig.nodes.at(-1)!.say();
	await act(async () => { f.dictation.cancel(); });
	await settle();
	await begin(f);
	assert.equal(rig.contexts.length, 2);
	assert.equal(rig.nodes.at(-1)!.ctx, rig.contexts[1]);
	rig.nodes.at(-1)!.say();
	await act(async () => { Socket.all.at(-1)!.open(); });
	assert.equal(f.dictation.phase, "recording");
});

test("a tap on Stop while the engine is being replaced: nothing is wired afterwards, the words land, no error", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	rig.setup = (ctx, index) => { if (index === 1) ctx.audioWorklet.addModule = () => gate; };
	const f = await fixture();
	await begin(f);
	await act(async () => { Socket.all[0]!.open(); Socket.all[0]!.final("kept words"); });
	await tick(ENGINE_SILENT_CHECK_MS);
	assert.equal(rig.contexts.length, 2, "the replacement is under way");
	const nodes = rig.nodes.length;
	await act(async () => { f.dictation.stop(); });
	assert.equal(f.dictation.phase, "stopping");
	await act(async () => { release(); });
	await settle();
	assert.equal(rig.nodes.length, nodes, "no recorder wired into a run that is ending");
	await closeNormally();
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.dictation.error, null);
	assert.deepEqual(rig.appends, ["kept words"]);
	assert.equal(pending.size, 0);
});

test("a tap on Stop while the replacement engine won't run: the stop ends the run, not DICTATION_MIC_DEAD", async () => {
	rig.setup = (ctx, index) => { if (index === 1) { ctx.state = "suspended"; ctx.resumeMode = "hang"; } };
	const f = await fixture();
	await begin(f);
	await act(async () => { Socket.all[0]!.open(); Socket.all[0]!.final("kept words"); });
	await tick(ENGINE_SILENT_CHECK_MS);
	assert.equal(rig.contexts.length, 2);
	await act(async () => { f.dictation.stop(); });
	await tick(ENGINE_RESUME_CAP_MS);
	assert.equal(f.dictation.error, null);
	assert.equal(f.dictation.phase, "stopping");
	await closeNormally();
	await tick(ENGINE_LAST_CHANCE_MS);
	assert.equal(f.dictation.phase, "idle");
	assert.equal(f.dictation.error, null);
	assert.deepEqual(rig.appends, ["kept words"]);
	assert.equal(pending.size, 0);
});

// 7–11: the microphone taken away during a run

test("a track that ends mid-run stops the run; the finals land once; no error", async () => {
	const f = await fixture();
	await record(f);
	await act(async () => { Socket.all[0]!.final("first part"); });
	await act(async () => { rig.tracks[0]!.end(); });
	assert.equal(f.dictation.phase, "stopping");
	assert.equal(Socket.all[0]!.closeStreamSent, true, "stopped as Stop does");
	await act(async () => { Socket.all[0]!.final("tail"); });
	await closeNormally();
	await tick(5000);
	assert.deepEqual(rig.appends, ["first part tail"]);
	assert.equal(f.dictation.error, null);
	assert.equal(f.dictation.phase, "idle");
});

test("a mute while the page is hidden stops at once", async () => {
	const f = await fixture();
	await record(f);
	await act(async () => { f.setVisibility("hidden"); });
	assert.equal(f.dictation.phase, "recording");
	await act(async () => { Socket.all[0]!.final("kept words"); });
	await act(async () => { rig.tracks[0]!.mute(); });
	assert.equal(f.dictation.phase, "stopping");
	await closeNormally();
	assert.deepEqual(rig.appends, ["kept words"]);
	assert.equal(f.dictation.error, null);
});

test("a mute right after the page is shown again stops at once", async () => {
	const f = await fixture();
	await record(f);
	await act(async () => { f.setVisibility("hidden"); });
	await act(async () => { f.setVisibility("visible"); });
	await act(async () => { rig.tracks[0]!.mute(); });
	assert.equal(f.dictation.phase, "stopping");
});

test("a mute with the page in front waits the grace; unmuted in time the run goes on, still muted it stops", async () => {
	const f = await fixture();
	await record(f);
	await act(async () => { rig.tracks[0]!.mute(); });
	assert.equal(f.dictation.phase, "recording");
	await act(async () => { rig.tracks[0]!.unmute(); });
	rig.contexts[0]!.currentTime = 10;
	await tick(LOSS_GRACE_MS);
	assert.equal(f.dictation.phase, "recording");
	await act(async () => { Socket.all[0]!.final("still here"); });
	await act(async () => { rig.tracks[0]!.mute(); });
	await tick(LOSS_GRACE_MS - 1);
	assert.equal(f.dictation.phase, "recording");
	await tick(1);
	assert.equal(f.dictation.phase, "stopping");
	await closeNormally();
	assert.deepEqual(rig.appends, ["still here"]);
	assert.equal(f.dictation.error, null);
});

test("the engine going 'interrupted' while hidden stops the run, words kept", async () => {
	const f = await fixture();
	await record(f);
	await act(async () => { Socket.all[0]!.final("before"); });
	await act(async () => { f.setVisibility("hidden"); });
	await act(async () => { rig.contexts[0]!.set("interrupted"); });
	assert.equal(f.dictation.phase, "stopping");
	await closeNormally();
	assert.deepEqual(rig.appends, ["before"]);
	assert.equal(f.dictation.error, null);
});

test("the page going hidden with a live capture changes nothing (the computer case)", async () => {
	const f = await fixture();
	await record(f);
	await act(async () => { f.setVisibility("hidden"); });
	rig.contexts[0]!.currentTime = 3;
	await tick(LOSS_GRACE_MS * 2);
	assert.equal(f.dictation.phase, "recording");
	assert.equal(rig.contexts.length, 1);
	assert.equal(f.dictation.error, null);
});

test("an abnormal close with the capture lost ends the run keeping the words, without a reconnect", async () => {
	const f = await fixture();
	await record(f);
	await act(async () => { Socket.all[0]!.final("said so far"); });
	rig.contexts[0]!.state = "interrupted"; // no event reached the page before the close
	await act(async () => { Socket.all[0]!.drop(1006); });
	await settle();
	assert.equal(Socket.all.length, 1, "no reconnect");
	assert.deepEqual(rig.appends, ["said so far"]);
	assert.equal(f.dictation.error, null);
	assert.equal(f.dictation.phase, "idle");
});

test("an abnormal close with the capture alive reconnects as today", async () => {
	const f = await fixture();
	await record(f);
	await act(async () => { Socket.all[0]!.drop(1006); });
	await settle();
	assert.equal(Socket.all.length, 2, "one reconnect");
	await act(async () => { Socket.all[1]!.open(); });
	assert.equal(f.dictation.phase, "recording");
	assert.equal(f.dictation.error, null);
	await act(async () => { Socket.all[1]!.drop(1006); });
	await settle();
	assert.equal(f.dictation.error, "Deepgram connection lost (1006)");
});

// 12: together with the Firefox fallback

test("the Firefox fallback still works, and the dead-engine replacement is a budget of its own", async () => {
	rig.firefox = true;
	rig.setup = (ctx, index) => { if (index === 0) { ctx.state = "interrupted"; ctx.resumeMode = "hang"; } };
	const f = await fixture();
	await begin(f);
	await tick(ENGINE_RESUME_CAP_MS);
	assert.equal(rig.contexts.length, 1, "an engine made in this run gets the patient wait");
	await tick(ENGINE_LAST_CHANCE_MS - ENGINE_RESUME_CAP_MS);
	assert.equal(rig.contexts.length, 3, "dead engine → fresh 16 kHz engine → native engine");
	assert.deepEqual(rig.contexts[1]!.options, { sampleRate: 16000 });
	assert.equal(rig.contexts[2]!.options, undefined);
	assert.deepEqual(rig.nodes.at(-1)!.options, { processorOptions: { targetRate: 16000 } });
	await act(async () => { Socket.all[0]!.open(); });
	assert.equal(f.dictation.phase, "recording");
	assert.equal(f.dictation.error, null);
});

test("after the Firefox fallback the silent-engine net watches the native engine", async () => {
	rig.firefox = true;
	const f = await fixture();
	await begin(f);
	assert.equal(rig.contexts.length, 2);
	await act(async () => { Socket.all[0]!.open(); });
	await tick(ENGINE_SILENT_CHECK_MS);
	assert.equal(rig.contexts.length, 3, "the native engine is replaced by a native engine");
	assert.equal(rig.contexts[2]!.options, undefined);
	assert.deepEqual(rig.nodes.at(-1)!.options, { processorOptions: { targetRate: 16000 } });
	assert.equal(f.dictation.error, null);
	assert.equal(f.dictation.phase, "recording");
});

// 13: the pure rules

test("captureEvidence and captureLost need positive evidence", () => {
	assert.equal(captureEvidence([{}], {}), null, "stand-ins with no properties aren't lost");
	assert.equal(captureEvidence([], undefined), null);
	assert.equal(captureEvidence([{ readyState: "live", muted: false }], { state: "running" }), null);
	assert.equal(captureEvidence([{ readyState: "ended" }], { state: "running" }), "ended");
	assert.equal(captureEvidence([{ readyState: "ended", muted: true }], { state: "interrupted" }), "ended");
	assert.equal(captureEvidence([{ muted: true }], { state: "running" }), "soft");
	assert.equal(captureEvidence([{}], { state: "interrupted" }), "soft");
	assert.equal(captureEvidence([{}], { state: "suspended" }), "soft");
	assert.equal(captureEvidence([{}], { state: 3 }), null, "a non-string state is no evidence");
	assert.equal(captureLost([{ muted: true }], null), true);
	assert.equal(captureLost([{ muted: "yes" }], null), false);
});

test("lossAction: ended, hidden or just shown stop now; otherwise look again after the grace", () => {
	const now = 50_000;
	assert.equal(lossAction(null, { hidden: true, shownAt: now, now }), "none");
	assert.equal(lossAction("ended", { hidden: false, shownAt: null, now }), "stop");
	assert.equal(lossAction("soft", { hidden: true, shownAt: null, now }), "stop");
	assert.equal(lossAction("soft", { hidden: false, shownAt: now - SHOWN_RECENTLY_MS + 1, now }), "stop");
	assert.equal(lossAction("soft", { hidden: false, shownAt: now - SHOWN_RECENTLY_MS, now }), "recheck");
	assert.equal(lossAction("soft", { hidden: false, shownAt: null, now }), "recheck");
});

test("engineRunning, engineSilent and the constants", () => {
	assert.equal(engineRunning({ state: "running" }), true);
	assert.equal(engineRunning({}), true, "no state: as before, no resume");
	assert.equal(engineRunning({ state: "suspended" }), false);
	assert.equal(engineRunning({ state: "interrupted" }), false);
	assert.equal(engineSilent(true, 1, 1), false);
	assert.equal(engineSilent(false, 1, 1.01), false);
	assert.equal(engineSilent(false, 1, 1), true);
	assert.equal(engineSilent(false, 1, undefined), true);
	assert.equal(DICTATION_MIC_DEAD, "Microphone didn't start. Try again.");
	assert.equal(ENGINE_RESUME_CAP_MS, 500);
	assert.equal(ENGINE_SILENT_CHECK_MS, 700);
	assert.equal(ENGINE_LAST_CHANCE_MS, 4000);
	assert.equal(SHOWN_RECENTLY_MS, 2000);
	assert.equal(LOSS_GRACE_MS, 1500);
	assert.equal(captureErrorMessage(new DOMException("x", "NotAllowedError")), "Microphone permission denied");
	assert.equal(captureErrorMessage(new Error("boom")), "boom");
	assert.equal(captureErrorMessage("?"), "mic unavailable");
});

test("resumeWithin settles on resolve, on reject, on a throw and at the cap", async () => {
	let resolved = 0;
	await resumeWithin({ resume: async () => { resolved++; } }, 500);
	await resumeWithin({ resume: () => Promise.reject(new Error("no")) }, 500);
	await resumeWithin({ resume: () => { throw new Error("sync"); } }, 500);
	assert.equal(resolved, 1);
	let done = false;
	const hanging = resumeWithin({ resume: () => new Promise<void>(() => {}) }, 500).then(() => { done = true; });
	mock.timers.tick(499);
	await Promise.resolve();
	assert.equal(done, false);
	mock.timers.tick(1);
	await hanging;
	assert.equal(done, true);
	assert.equal(pending.size, 0);
});
