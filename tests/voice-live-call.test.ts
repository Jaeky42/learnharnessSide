/**
 * The GPT-Live trial's call engine (components/voice/live-call.ts; voice plan,
 * Phase 0), with scripted stand-ins for the microphone, the peer connection,
 * its data channel, the server's route, the timers and the clock.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LiveCall, liveReportText, type LiveCallDeps } from "../components/voice/live-call.ts";
import {
	LIVE_HELLO_HINT_MS,
} from "../components/voice/live-call.ts";
import {
	VOICE_TRIAL_ANSWER_QUIET_MS,
	VOICE_TRIAL_DELEGATION_REPLY,
	VOICE_TRIAL_DELEGATION_REPLY_MS,
	VOICE_TRIAL_EXPLANATION,
	VOICE_TRIAL_EXPLANATION_QUIET_MS,
	VOICE_TRIAL_MAX_MS,
	VOICE_TRIAL_TEXT,
} from "../src/core/index.ts";

type Listener = (event: unknown) => void;

class Emitter {
	private listeners = new Map<string, Listener[]>();
	addEventListener(type: string, listener: Listener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
	emit(type: string, event: unknown = {}) { for (const l of this.listeners.get(type) ?? []) l(event); }
}

class FakeChannel extends Emitter {
	readyState = "connecting";
	sent: Array<Record<string, unknown>> = [];
	closed = false;
	constructor(public label: string) { super(); }
	send(data: string) { this.sent.push(JSON.parse(data)); }
	close() { this.closed = true; this.readyState = "closed"; }
	open() { this.readyState = "open"; this.emit("open"); }
	deliver(event: unknown) { this.emit("message", { data: typeof event === "string" ? event : JSON.stringify(event) }); }
}

class FakeTrack extends Emitter {
	kind = "audio"; readyState = "live"; muted = false; enabled = true; stopped = false;
	stop() { this.stopped = true; this.readyState = "ended"; }
}

class FakePeer extends Emitter {
	connectionState = "new"; iceConnectionState = "new"; signalingState = "stable";
	localDescription: { sdp?: string } | null = null;
	channels: FakeChannel[] = [];
	remote: { type: string; sdp: string } | null = null;
	closed = false;
	constructor(private log: string[]) { super(); }
	createDataChannel(label: string) { this.log.push(`createDataChannel:${label}`); const c = new FakeChannel(label); this.channels.push(c); return c; }
	addTrack() { this.log.push("addTrack"); }
	async createOffer() { this.log.push("createOffer"); return { type: "offer", sdp: "v=0 offer" }; }
	async setLocalDescription(d: { sdp?: string }) { this.log.push("setLocalDescription"); this.localDescription = d; }
	async setRemoteDescription(d: { type: string; sdp: string }) { this.log.push("setRemoteDescription"); this.remote = d; }
	close() { this.closed = true; this.connectionState = "closed"; }
	state(connection: string) { this.connectionState = connection; this.emit("connectionstatechange"); }
}

interface Reply { status: number; body: unknown }

function harness(options: { reply?: Reply; micRefused?: boolean; holdSession?: boolean } = {}) {
	const log: string[] = [];
	let clock = 1000;
	let timers: Array<{ at: number; run: () => void; id: number }> = [];
	let nextId = 1;
	const track = new FakeTrack();
	const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
	let peer: FakePeer | null = null;
	const requests: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
	const remoteStreams: unknown[] = [];
	let releaseSession: (() => void) | null = null;
	const reply = options.reply ?? { status: 200, body: { sessionId: "live_1", sdp: "v=0 answer" } };
	const deps: LiveCallDeps = {
		createPeerConnection: () => { log.push("createPeerConnection"); peer = new FakePeer(log); return peer; },
		getUserMedia: async (constraints) => {
			log.push(`getUserMedia:${JSON.stringify(constraints)}`);
			if (options.micRefused) throw Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
			return stream;
		},
		fetch: async (url, init) => {
			log.push(`fetch:${url}`);
			requests.push({ url, body: JSON.parse(init.body ?? "null"), headers: init.headers });
			if (url.endsWith("/session") && options.holdSession) await new Promise<void>((resolve) => { releaseSession = resolve; });
			const r = url.endsWith("/hangup") ? { status: 200, body: { ok: true } }
				: url.endsWith("/chatgpt-models") ? { status: 200, body: { signedIn: true, live: ["gpt-live-1.1"] } }
				: reply;
			return { ok: r.status < 400, status: r.status, json: async () => r.body };
		},
		setTimeout: (run, ms) => { const id = nextId++; timers.push({ at: clock + ms, run, id }); return id; },
		clearTimeout: (id) => { timers = timers.filter((t) => t.id !== id); },
		now: () => clock,
		onRemoteStream: (stream) => { remoteStreams.push(stream); },
		streamFromTrack: (track) => ({ madeFrom: track }),
	};
	const call = new LiveCall(deps);
	const advance = (ms: number) => {
		const end = clock + ms;
		for (;;) {
			const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
			if (!due) break;
			timers = timers.filter((t) => t !== due);
			clock = due.at;
			due.run();
		}
		clock = end;
	};
	const flush = () => new Promise<void>((r) => setTimeout(r, 0));
	/** Moves the clock without running timers: what iOS does to a page in the background. */
	const skip = (ms: number) => { clock += ms; };
	return {
		call, log, track, requests, advance, flush, skip, remoteStreams,
		release: () => releaseSession?.(),
		get peer() { return peer!; },
		get channel() { return peer!.channels[0]!; },
		timers: () => timers.length,
	};
}

/** Start, answer the offer, open the channel and start the session. */
async function live(h: ReturnType<typeof harness>) {
	await h.call.start({ model: "gpt-live-1.1", voice: "marin" });
	await h.flush();
	h.channel.open();
	h.peer.state("connected");
	h.channel.deliver({ type: "session.started", event_id: "e1", session: { id: "live_1" } });
}

const sentTypes = (channel: FakeChannel) => channel.sent.map((e) => e.type);

describe("starting a call", () => {
	it("takes the microphone first, then the connection, the track, the channel, the offer, the route and the answer", async () => {
		const h = harness();
		await h.call.start({ model: "gpt-live-1", voice: "cedar" });
		await h.flush();
		assert.deepEqual(h.log, [
			`getUserMedia:${JSON.stringify({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })}`,
			"createPeerConnection",
			"addTrack",
			"createDataChannel:oai-events",
			"createOffer",
			"setLocalDescription",
			"fetch:/api/voice-trial/session",
			"setRemoteDescription",
		]);
		assert.deepEqual(h.requests[0]!.body, { sdp: "v=0 offer", model: "gpt-live-1", voice: "cedar" });
		assert.equal(h.requests[0]!.headers["x-learnharness-voice"], "1");
		assert.deepEqual(h.peer.remote, { type: "answer", sdp: "v=0 answer" });
		assert.equal(h.call.getState().phase, "connecting");
		assert.equal(h.call.getState().sessionId, "live_1");
	});

	it("goes live on session.started and gives the explanation as commentary with no delegation", async () => {
		const h = harness();
		await live(h);
		const state = h.call.getState();
		assert.equal(state.phase, "live");
		assert.equal(state.step, "explaining");
		assert.deepEqual(h.channel.sent[0], { type: "session.commentary.append", content: VOICE_TRIAL_EXPLANATION, delegation_id: null });
		assert.equal(state.diag.eventChannel, "created oai-events");
		assert.equal(state.diag.counts["session.started"], 1);
	});

	it("listens on a channel the server opens and sends on the one that carried events", async () => {
		const h = harness();
		await h.call.start({ model: "gpt-live-1.1", voice: "marin" });
		await h.flush();
		const theirs = new FakeChannel("server-events");
		h.peer.emit("datachannel", { channel: theirs });
		theirs.open();
		h.channel.open();
		theirs.deliver({ type: "session.started" });
		assert.equal(h.call.getState().diag.eventChannel, "remote server-events");
		assert.equal(theirs.sent[0]?.type, "session.commentary.append");
		assert.equal(h.channel.sent.length, 0);
		assert.deepEqual(h.call.getState().diag.channels.map((c) => [c.origin, c.label, c.events]), [["created", "oai-events", 0], ["remote", "server-events", 1]]);
	});

	it("suggests saying hello when the tutor says nothing for a while", async () => {
		const h = harness();
		await live(h);
		h.advance(LIVE_HELLO_HINT_MS);
		assert.equal(h.call.getState().hint, VOICE_TRIAL_TEXT.sayHello);
		h.channel.deliver({ type: "session.output_transcript.delta", delta: "Hi", start_ms: 0, end_ms: 100 });
		assert.equal(h.call.getState().hint, null);
	});
});

describe("failures", () => {
	it("the microphone refused", async () => {
		const h = harness({ micRefused: true });
		await h.call.start({ model: "gpt-live-1.1", voice: "marin" });
		const state = h.call.getState();
		assert.equal(state.phase, "failed");
		assert.equal(state.failure?.kind, "microphone");
		assert.equal(state.failure?.message, VOICE_TRIAL_TEXT.micRefused);
		assert.match(state.failure?.detail ?? "", /NotAllowedError/);
		assert.ok(!h.log.includes("createPeerConnection"));
		assert.equal(h.timers(), 0, "no timer left behind");
	});

	it("no key on the server (503)", async () => {
		const h = harness({ reply: { status: 503, body: { code: "no_key", message: "No key." } } });
		await h.call.start({ model: "gpt-live-1.1", voice: "marin" });
		await h.flush();
		const state = h.call.getState();
		assert.equal(state.failure?.kind, "no_key");
		assert.equal(state.failure?.message, VOICE_TRIAL_TEXT.noKey);
		assert.ok(h.track.stopped, "the microphone is let go");
		assert.ok(h.peer.closed);
	});

	it("OpenAI refused: its message is shown", async () => {
		const h = harness({ reply: { status: 502, body: { code: "upstream", status: 403, message: "Live is not enabled for this project." } } });
		await h.call.start({ model: "gpt-live-1.1", voice: "marin" });
		await h.flush();
		assert.equal(h.call.getState().failure?.kind, "call");
		assert.equal(h.call.getState().failure?.detail, "Live is not enabled for this project.");
	});

	it("the connection failing ends the call as dropped", async () => {
		const h = harness();
		await live(h);
		h.peer.state("failed");
		assert.equal(h.call.getState().phase, "failed");
		assert.equal(h.call.getState().failure?.kind, "dropped");
		assert.ok(h.requests.some((r) => r.url === "/api/voice-trial/hangup"));
	});
});

describe("during the call", () => {
	it("events update the state: captions, pause, usage and its cost, errors, a close from OpenAI", async () => {
		const h = harness();
		await live(h);
		h.channel.deliver({ type: "session.output_transcript.delta", delta: "Longer wires", start_ms: 0, end_ms: 200 });
		h.channel.deliver({ type: "session.output_transcript.delta", delta: " resist more.", start_ms: 200, end_ms: 400 });
		h.channel.deliver({ type: "session.input_transcript.delta", delta: "Why?", start_ms: 500, end_ms: 700 });
		h.channel.deliver({ type: "session.paused" });
		assert.equal(h.call.getState().paused, true);
		h.channel.deliver({ type: "session.resumed" });
		assert.equal(h.call.getState().paused, false);
		h.channel.deliver({ type: "session.usage.updated", usage: { seconds: 120, active_seconds: 60, paused_seconds: 60 } });
		h.channel.deliver({ type: "error", error: { code: "invalid_value", message: "bad commentary" } });
		h.channel.deliver("not json");
		h.channel.deliver({ type: "info", code: "data_channel_permissions", message: "x" });
		const state = h.call.getState();
		assert.deepEqual(state.captions.map((c) => [c.speaker, c.text]), [["tutor", "Longer wires resist more."], ["learner", "Why?"]]);
		assert.deepEqual(state.diag.usage, { seconds: 120, active_seconds: 60, paused_seconds: 60 });
		assert.ok(Math.abs((state.diag.cost ?? 0) - 0.07) < 1e-9);
		assert.equal(state.diag.lastError, "invalid_value: bad commentary");
		assert.equal(state.diag.counts["(unreadable)"], 1);
		assert.deepEqual(state.diag.infos, ["data_channel_permissions"]);
		h.channel.deliver({ type: "session.closed", reason: "expired", usage: { seconds: 130 } });
		await h.flush();
		assert.equal(h.call.getState().phase, "ended");
		assert.match(h.call.getState().endedText ?? "", /expired/);
		assert.ok(!sentTypes(h.channel).includes("session.close"), "no close sent after OpenAI closed it");
	});

	it("measures the reply delay from the learner's last words to the tutor's next", async () => {
		const h = harness();
		await live(h);
		h.channel.deliver({ type: "session.input_transcript.delta", delta: "Hello", end_ms: 1 });
		h.advance(300);
		h.channel.deliver({ type: "session.input_transcript.delta", delta: " there", end_ms: 2 });
		h.advance(450);
		h.channel.deliver({ type: "session.output_transcript.delta", delta: "Hi!", end_ms: 3 });
		assert.equal(h.call.getState().diag.replyDelayMs, 450);
	});

	it("mute: the track off and the mute event; unmute: both back", async () => {
		const h = harness();
		await live(h);
		h.call.toggleMute();
		assert.equal(h.track.enabled, false);
		assert.equal(h.call.getState().muted, true);
		assert.equal(sentTypes(h.channel).at(-1), "session.input_audio.mute");
		h.channel.deliver({ type: "session.input_audio.muted" });
		assert.equal(h.call.getState().muteAck, "muted");
		h.call.toggleMute();
		assert.equal(h.track.enabled, true);
		assert.equal(sentTypes(h.channel).at(-1), "session.input_audio.unmute");
		assert.equal(h.call.getState().muteAck, null);
	});

	it("End sends session.close, closes everything, lets the microphone go and calls the hangup route", async () => {
		const h = harness();
		await live(h);
		await h.call.end();
		assert.equal(sentTypes(h.channel).at(-1), "session.close");
		assert.ok(h.channel.closed && h.peer.closed && h.track.stopped);
		const hangup = h.requests.find((r) => r.url === "/api/voice-trial/hangup");
		assert.deepEqual(hangup?.body, { sessionId: "live_1" });
		assert.equal(h.call.getState().phase, "ended");
		assert.equal(h.timers(), 0);
	});

	it("stops by itself after 10 minutes", async () => {
		const h = harness();
		await live(h);
		h.advance(VOICE_TRIAL_MAX_MS - 1);
		assert.equal(h.call.getState().phase, "live");
		h.advance(1);
		await h.flush();
		assert.equal(h.call.getState().phase, "ended");
		assert.equal(h.call.getState().endedText, VOICE_TRIAL_TEXT.timeLimit);
		assert.ok(h.track.stopped);
		assert.equal(sentTypes(h.channel).at(-1), "session.close");
		assert.deepEqual(h.requests.find((r) => r.url === "/api/voice-trial/hangup")?.body, { sessionId: "live_1" });
	});

	it("ends at once on coming back past the limit when the timer was held in the background", async () => {
		const h = harness();
		await live(h);
		h.call.noteVisibility("hidden");
		h.skip(VOICE_TRIAL_MAX_MS - 1000);
		h.call.noteVisibility("visible");
		assert.equal(h.call.getState().phase, "live", "not yet past the limit");
		h.call.noteVisibility("hidden");
		h.skip(1000);
		h.call.noteVisibility("visible");
		await h.flush();
		assert.equal(h.call.getState().phase, "ended");
		assert.equal(h.call.getState().endedText, VOICE_TRIAL_TEXT.timeLimit);
		assert.equal(sentTypes(h.channel).at(-1), "session.close");
		assert.ok(h.requests.some((r) => r.url === "/api/voice-trial/hangup"));
	});

	it("hangs up a session whose id arrives after the call was ended", async () => {
		const h = harness({ holdSession: true });
		const starting = h.call.start({ model: "gpt-live-1.1", voice: "marin" });
		await h.flush();
		assert.ok(h.requests.some((r) => r.url === "/api/voice-trial/session"), "the session request is in flight");
		await h.call.end();
		assert.equal(h.call.getState().phase, "ended");
		assert.ok(!h.requests.some((r) => r.url === "/api/voice-trial/hangup"), "no id known yet");
		h.release();
		await starting;
		await h.flush();
		assert.deepEqual(h.requests.filter((r) => r.url === "/api/voice-trial/hangup").map((r) => r.body), [{ sessionId: "live_1" }]);
		assert.equal(h.peer.remote, null, "the late answer is not applied");
		assert.equal(h.call.getState().phase, "ended");
	});

	it("plays a remote track that came without a stream through a stream made around it", async () => {
		const h = harness();
		await live(h);
		const remote = { kind: "audio" };
		h.peer.emit("track", { track: remote, streams: [] });
		assert.deepEqual(h.remoteStreams, [{ madeFrom: remote }]);
		const own = { id: "theirs" };
		h.peer.emit("track", { track: remote, streams: [own] });
		assert.equal(h.remoteStreams[1], own);
	});

	it("checks the ChatGPT plan only when asked", async () => {
		const h = harness();
		await live(h);
		assert.ok(!h.requests.some((r) => r.url.includes("chatgpt-models")));
		assert.equal(h.call.getState().diag.chatgptLive, "not checked");
		await h.call.checkChatGPTPlan();
		assert.equal(h.requests.filter((r) => r.url.includes("chatgpt-models")).length, 1);
		assert.equal(h.call.getState().diag.chatgptLive, "gpt-live-1.1");
	});

	it("records visibility changes with their times, and keeps them across a new call", async () => {
		const h = harness();
		h.call.noteVisibility("hidden");
		h.advance(2500);
		h.call.noteVisibility("visible");
		await live(h);
		assert.deepEqual(h.call.getState().diag.visibility.map((n) => [n.t, n.what]), [[0, "hidden"], [2500, "visible"]]);
		assert.equal(h.call.getState().phase, "live", "the call goes on when the page is hidden");
	});
});

describe("the question", () => {
	async function explained(h: ReturnType<typeof harness>) {
		await live(h);
		h.channel.deliver({ type: "session.output_transcript.delta", delta: "A longer wire…", end_ms: 1 });
		h.advance(VOICE_TRIAL_EXPLANATION_QUIET_MS);
	}

	it("shows once the tutor has been quiet after the explanation, and asks the tutor to read it", async () => {
		const h = harness();
		await live(h);
		h.channel.deliver({ type: "session.output_transcript.delta", delta: "A longer", end_ms: 1 });
		h.advance(VOICE_TRIAL_EXPLANATION_QUIET_MS - 1);
		h.channel.deliver({ type: "session.output_transcript.delta", delta: " wire", end_ms: 2 });
		h.advance(VOICE_TRIAL_EXPLANATION_QUIET_MS - 1);
		assert.equal(h.call.getState().questionShown, false);
		h.advance(1);
		const state = h.call.getState();
		assert.equal(state.questionShown, true);
		assert.equal(state.step, "question");
		const read = h.channel.sent.at(-1)!;
		assert.equal(read.type, "session.commentary.append");
		assert.equal(read.delegation_id, null);
		assert.match(String(read.content), /Read it aloud/);
	});

	it("is answered by voice 700 ms after the learner's last words, graded, and the verdict given", async () => {
		const h = harness();
		await explained(h);
		h.channel.deliver({ type: "session.input_transcript.delta", delta: "I think it's", end_ms: 10 });
		h.advance(300);
		h.channel.deliver({ type: "session.input_transcript.delta", delta: " A, because", end_ms: 11 });
		h.advance(VOICE_TRIAL_ANSWER_QUIET_MS - 1);
		assert.equal(h.call.getState().answer, null);
		h.advance(1);
		assert.deepEqual(h.call.getState().answer, { choice: 0, by: "voice", correct: true });
		assert.match(String(h.channel.sent.at(-1)!.content), /That is correct/);
	});

	it("keeps listening while what was said isn't an answer", async () => {
		const h = harness();
		await explained(h);
		h.channel.deliver({ type: "session.input_transcript.delta", delta: "What is a wire made of?", end_ms: 10 });
		h.advance(VOICE_TRIAL_ANSWER_QUIET_MS);
		assert.equal(h.call.getState().answer, null);
		h.channel.deliver({ type: "session.input_transcript.delta", delta: " Okay, the second one.", end_ms: 20 });
		h.advance(VOICE_TRIAL_ANSWER_QUIET_MS);
		assert.deepEqual(h.call.getState().answer, { choice: 1, by: "voice", correct: false });
		assert.match(String(h.channel.sent.at(-1)!.content), /not right; the right answer is A/);
	});

	it("is answered by a tap, once", async () => {
		const h = harness();
		await live(h);
		h.call.answer(0);
		assert.equal(h.call.getState().answer, null, "no answer before the question shows");
		h.call.showQuestion();
		h.call.answer("dont-know");
		h.call.answer(0);
		assert.deepEqual(h.call.getState().answer, { choice: "dont-know", by: "tap", correct: false });
		assert.equal(h.channel.sent.filter((e) => String(e.content).includes("The learner")).length, 1);
		h.channel.deliver({ type: "session.input_transcript.delta", delta: "B", end_ms: 1 });
		h.advance(VOICE_TRIAL_ANSWER_QUIET_MS);
		assert.equal(h.call.getState().answer?.choice, "dont-know");
	});
});

describe("a delegation", () => {
	it("is shown in the readout and answered 2 s later with commentary bound to its id", async () => {
		const h = harness();
		await live(h);
		h.channel.deliver({ type: "session.delegation.created", delegation: { id: "del_42", target: "client", type: "delegation" }, offset_ms: 5000 });
		assert.deepEqual(h.call.getState().diag.delegations.map((d) => [d.id, d.answeredAt]), [["del_42", null]]);
		const before = h.channel.sent.length;
		h.advance(VOICE_TRIAL_DELEGATION_REPLY_MS - 1);
		assert.equal(h.channel.sent.length, before);
		h.advance(1);
		assert.deepEqual(h.channel.sent.at(-1), { type: "session.commentary.append", content: VOICE_TRIAL_DELEGATION_REPLY, delegation_id: "del_42" });
		assert.notEqual(h.call.getState().diag.delegations[0]!.answeredAt, null);
	});
});

describe("the report", () => {
	it("has states and event types, never the spoken words", async () => {
		const h = harness();
		h.call.noteDevice({ standalone: true, userAgent: "iPhone test" });
		await live(h);
		h.channel.deliver({ type: "session.output_transcript.delta", delta: "Zebra electrons collide", end_ms: 1 });
		h.channel.deliver({ type: "session.input_transcript.delta", delta: "my secret question", end_ms: 2 });
		h.call.showQuestion();
		const report = liveReportText(h.call.getState());
		assert.match(report, /session\.output_transcript\.delta 1/);
		assert.match(report, /events came on: created oai-events/);
		assert.match(report, /home-screen app: yes/);
		assert.match(report, /user agent: iPhone test/);
		for (const words of ["Zebra", "secret", "Why does a longer wire", "Electrons collide"]) assert.ok(!report.includes(words), words);
	});
});
