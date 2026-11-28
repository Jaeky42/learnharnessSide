/**
 * VOICE (fork, Phase 0 of docs/fork/plans/voice-session-plan.md): the call
 * engine of the GPT-Live trial page. Framework-free; every browser object
 * it touches (the peer connection, the microphone, fetch, timers, the clock)
 * is handed in, so tests script it.
 *
 * The call, as read from the types of OpenAI's Node library
 * (resources/live, lib/live/webrtc): the browser takes the microphone,
 * makes a peer connection with the mic track and a data channel named
 * "oai-events" (the library's own WebRTC helper creates that channel
 * before the offer), posts its offer to this server, which posts it to
 * OpenAI and hands back the answer. Events are JSON text on the channel;
 * the session sends session.started first. The engine also listens for a
 * channel the server might open itself and records which one carried events.
 *
 * The trial's script is the app's, as the real lesson's will be: an
 * explanation given as commentary, then a question shown on screen and
 * read aloud, an answer heard (spokenChoice) or tapped, graded here, and
 * the verdict given as commentary. A delegation is answered after 2 s with
 * commentary bound to its id. Nothing is saved.
 */

import {
	addCaption,
	type CaptionLine,
	formatUsd,
	type LiveModel,
	type LiveUsage,
	liveUsageCost,
	type LiveVoice,
	optionLetter,
	questionCommentary,
	spokenChoice,
	type TrialChoice,
	verdictCommentary,
	VOICE_TRIAL_ANSWER_QUIET_MS,
	VOICE_TRIAL_DELEGATION_REPLY,
	VOICE_TRIAL_DELEGATION_REPLY_MS,
	VOICE_TRIAL_EXPLANATION,
	VOICE_TRIAL_EXPLANATION_QUIET_MS,
	VOICE_TRIAL_MAX_MS,
	VOICE_TRIAL_QUESTION,
	VOICE_TRIAL_TEXT,
} from "@/src/core";

// ─── What the engine needs from the browser ──────────────────────────────────

type Listener = (event: unknown) => void;

export interface DataChannelLike {
	label: string;
	readyState: string;
	send(data: string): void;
	close(): void;
	addEventListener(type: string, listener: Listener): void;
}

export interface TrackLike {
	kind: string;
	readyState: string;
	muted: boolean;
	enabled: boolean;
	stop(): void;
	addEventListener(type: string, listener: Listener): void;
}

export interface StreamLike {
	getTracks(): TrackLike[];
	getAudioTracks(): TrackLike[];
}

export interface PeerConnectionLike {
	connectionState: string;
	iceConnectionState: string;
	signalingState: string;
	localDescription: { sdp?: string } | null;
	createDataChannel(label: string): DataChannelLike;
	addTrack(track: TrackLike, stream: StreamLike): unknown;
	createOffer(): Promise<{ type?: string; sdp?: string }>;
	setLocalDescription(description: { type?: string; sdp?: string }): Promise<void>;
	setRemoteDescription(description: { type: "answer"; sdp: string }): Promise<void>;
	close(): void;
	addEventListener(type: string, listener: Listener): void;
}

export interface FetchReply {
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
}

export interface LiveCallDeps {
	createPeerConnection(): PeerConnectionLike;
	getUserMedia(constraints: { audio: { echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean } }): Promise<StreamLike>;
	fetch(url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<FetchReply>;
	setTimeout(run: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
	now(): number;
	/** The remote audio, for the page's <audio> element. */
	onRemoteStream?(stream: unknown): void;
	/** A stream around one track, for a remote track that arrives without one (new MediaStream([track]) in the browser). */
	streamFromTrack?(track: unknown): unknown;
	standalone?: boolean;
	userAgent?: string;
}

// ─── State ───────────────────────────────────────────────────────────────────

export type CallPhase = "idle" | "starting" | "connecting" | "live" | "ending" | "ended" | "failed";
export type ScriptStep = "waiting" | "explaining" | "question" | "answered";
export type FailureKind = "no_key" | "microphone" | "call" | "dropped";

export interface CallFailure {
	kind: FailureKind;
	message: string;
	/** OpenAI's or the browser's own reason, when there is one. */
	detail: string | null;
}

export interface TrialAnswer {
	choice: TrialChoice;
	by: "voice" | "tap";
	correct: boolean;
}

export interface TimedNote {
	/** Milliseconds since the page's engine was made. */
	t: number;
	what: string;
}

export interface ChannelNote {
	label: string;
	origin: "created" | "remote";
	state: string;
	events: number;
}

export interface LiveDiagnostics {
	connectionState: string;
	iceConnectionState: string;
	signalingState: string;
	channels: ChannelNote[];
	/** "created oai-events" or "remote <label>": the first channel that carried an event. */
	eventChannel: string | null;
	mic: string;
	micNotes: TimedNote[];
	audio: string;
	audioNotes: TimedNote[];
	visibility: TimedNote[];
	counts: Record<string, number>;
	recent: Array<TimedNote & { dir: "in" | "out" }>;
	lastError: string | null;
	replyDelayMs: number | null;
	replyDelays: number[];
	usage: LiveUsage | null;
	cost: number | null;
	startedAt: number | null;
	sessionStartedAt: number | null;
	firstTutorWordsAt: number | null;
	closedReason: string | null;
	delegations: Array<{ id: string; t: number; answeredAt: number | null }>;
	infos: string[];
	standalone: boolean;
	userAgent: string;
	/** Whether the account's ChatGPT model list has an id with "live" in it: the ids, "none", "not signed in". */
	chatgptLive: string;
}

export interface LiveCallState {
	phase: CallPhase;
	step: ScriptStep;
	model: LiveModel | null;
	voice: LiveVoice | null;
	sessionId: string | null;
	failure: CallFailure | null;
	/** How a call that ended ended, in plain words. */
	endedText: string | null;
	hint: string | null;
	muted: boolean;
	muteAck: "muted" | "unmuted" | null;
	paused: boolean;
	questionShown: boolean;
	answer: TrialAnswer | null;
	captions: CaptionLine[];
	diag: LiveDiagnostics;
}

const RECENT_MAX = 30;
const NOTES_MAX = 40;
/** Live with no tutor words this long: the page suggests saying hello (a speech wake policy may wait for speech). */
export const LIVE_HELLO_HINT_MS = 8000;

function push<T>(list: readonly T[], item: T, max = NOTES_MAX): T[] {
	const next = [...list, item];
	return next.length > max ? next.slice(next.length - max) : next;
}

function errorName(error: unknown): string {
	if (error && typeof error === "object") {
		const { name, message } = error as { name?: unknown; message?: unknown };
		if (typeof name === "string" && typeof message === "string" && message) return `${name}: ${message}`;
		if (typeof name === "string") return name;
		if (typeof message === "string") return message;
	}
	return String(error);
}

function initialDiag(device: { standalone: boolean; userAgent: string }): LiveDiagnostics {
	return {
		connectionState: "none", iceConnectionState: "none", signalingState: "none",
		channels: [], eventChannel: null,
		mic: "none", micNotes: [], audio: "none", audioNotes: [], visibility: [],
		counts: {}, recent: [], lastError: null, replyDelayMs: null, replyDelays: [],
		usage: null, cost: null, startedAt: null, sessionStartedAt: null, firstTutorWordsAt: null, closedReason: null,
		delegations: [], infos: [],
		standalone: device.standalone, userAgent: device.userAgent, chatgptLive: "not checked",
	};
}

// ─── The engine ──────────────────────────────────────────────────────────────

export class LiveCall {
	private readonly deps: LiveCallDeps;
	private readonly t0: number;
	private device: { standalone: boolean; userAgent: string };
	private state: LiveCallState;
	private readonly listeners = new Set<() => void>();
	/** Bumped by every start and end: an older start's awaits see it and stop. */
	private generation = 0;
	private stream: StreamLike | null = null;
	private track: TrackLike | null = null;
	private pc: PeerConnectionLike | null = null;
	private channels: Array<{ channel: DataChannelLike; origin: "created" | "remote" }> = [];
	private eventChannel: DataChannelLike | null = null;
	private timers = new Set<unknown>();
	private limitTimer: unknown = null;
	/** The clock at Start: iOS can hold timers while the page is hidden, so the limit is checked again on return. */
	private startedWall: number | null = null;
	private helloTimer: unknown = null;
	private explanationTimer: unknown = null;
	private answerTimer: unknown = null;
	private explanationSent = false;
	private questionText = "";
	private utterance = "";
	private replyFrom: number | null = null;

	constructor(deps: LiveCallDeps) {
		this.deps = deps;
		this.t0 = deps.now();
		this.device = { standalone: deps.standalone ?? false, userAgent: deps.userAgent ?? "" };
		this.state = {
			phase: "idle", step: "waiting", model: null, voice: null, sessionId: null, failure: null, endedText: null, hint: null,
			muted: false, muteAck: null, paused: false, questionShown: false, answer: null, captions: [],
			diag: initialDiag(this.device),
		};
	}

	getState = (): LiveCallState => this.state;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	private at(): number {
		return this.deps.now() - this.t0;
	}

	private set(patch: Partial<LiveCallState>, diag?: Partial<LiveDiagnostics>): void {
		this.state = { ...this.state, ...patch, diag: diag ? { ...this.state.diag, ...diag } : this.state.diag };
		for (const listener of this.listeners) listener();
	}

	private later(run: () => void, ms: number): unknown {
		const handle = this.deps.setTimeout(() => {
			this.timers.delete(handle);
			run();
		}, ms);
		this.timers.add(handle);
		return handle;
	}

	private cancel(handle: unknown): void {
		if (handle === null || handle === undefined) return;
		this.timers.delete(handle);
		this.deps.clearTimeout(handle);
	}

	get active(): boolean {
		return this.state.phase === "starting" || this.state.phase === "connecting" || this.state.phase === "live";
	}

	// ─── Page notes, whether a call runs or not ──────────────────────────────

	noteVisibility(visibility: string): void {
		this.set({}, { visibility: push(this.state.diag.visibility, { t: this.at(), what: visibility }) });
		// Back on screen past the limit (a timer held in the background): end it now.
		if (visibility === "visible" && this.active && this.startedWall !== null && this.deps.now() - this.startedWall >= VOICE_TRIAL_MAX_MS) {
			void this.end("limit");
		}
	}

	/** What the page knows about the device, read in the browser after hydration. */
	noteDevice(device: { standalone: boolean; userAgent: string }): void {
		this.device = device;
		this.set({}, device);
	}

	/**
	 * The readout's hint: the signed-in ChatGPT account's model ids that
	 * mention "live". Only ever run from a tap: the listing refreshes the
	 * account's model catalog, which a failed listing clears, so it must not
	 * run by itself while a lesson elsewhere may be using that catalog.
	 */
	async checkChatGPTPlan(): Promise<void> {
		this.set({}, { chatgptLive: "checking…" });
		let text: string;
		try {
			const reply = await this.deps.fetch("/api/voice-trial/chatgpt-models", { method: "GET", headers: { "x-learnharness-voice": "1" } });
			const body = (await reply.json().catch(() => ({}))) as { signedIn?: unknown; live?: unknown };
			if (!reply.ok) text = "couldn't be read";
			else if (body.signedIn !== true) text = "not signed in";
			else text = Array.isArray(body.live) && body.live.length ? body.live.filter((id) => typeof id === "string").join(", ") : "none";
		} catch {
			text = "couldn't be read";
		}
		this.set({}, { chatgptLive: text });
	}

	noteAudio(what: string): void {
		this.set({}, { audio: what, audioNotes: push(this.state.diag.audioNotes, { t: this.at(), what }) });
	}

	// ─── Start ───────────────────────────────────────────────────────────────

	async start(options: { model: LiveModel; voice: LiveVoice }): Promise<void> {
		if (this.active || this.state.phase === "ending") return;
		const generation = ++this.generation;
		this.explanationSent = false;
		this.questionText = "";
		this.utterance = "";
		this.replyFrom = null;
		const diag = initialDiag(this.device);
		this.set({
			phase: "starting", step: "waiting", model: options.model, voice: options.voice, sessionId: null, failure: null, endedText: null, hint: null,
			muted: false, muteAck: null, paused: false, questionShown: false, answer: null, captions: [],
		}, { ...diag, visibility: this.state.diag.visibility, audio: this.state.diag.audio, audioNotes: this.state.diag.audioNotes, chatgptLive: this.state.diag.chatgptLive, startedAt: this.at() });
		this.startedWall = this.deps.now();
		this.limitTimer = this.later(() => { void this.end("limit"); }, VOICE_TRIAL_MAX_MS);

		let stream: StreamLike;
		try {
			stream = await this.deps.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
		} catch (error) {
			if (generation === this.generation) this.fail("microphone", VOICE_TRIAL_TEXT.micRefused, errorName(error));
			return;
		}
		if (generation !== this.generation) {
			for (const track of stream.getTracks()) track.stop();
			return;
		}
		this.stream = stream;
		const track = stream.getAudioTracks()[0] ?? null;
		this.track = track;
		if (track) this.watchTrack(track);

		let pc: PeerConnectionLike;
		let sdp: string;
		try {
			pc = this.deps.createPeerConnection();
			this.pc = pc;
			this.watchPeer(pc);
			if (track) pc.addTrack(track, stream);
			this.attachChannel(pc.createDataChannel("oai-events"), "created");
			this.set({ phase: "connecting" }, this.peerDiag());
			const offer = await pc.createOffer();
			if (generation !== this.generation) return;
			await pc.setLocalDescription(offer);
			if (generation !== this.generation) return;
			sdp = pc.localDescription?.sdp || offer.sdp || "";
			if (!sdp) throw new Error("The offer has no SDP.");
		} catch (error) {
			if (generation === this.generation) this.fail("call", VOICE_TRIAL_TEXT.callFailed, errorName(error));
			return;
		}

		let reply: FetchReply;
		try {
			reply = await this.deps.fetch("/api/voice-trial/session", {
				method: "POST",
				headers: { "content-type": "application/json", "x-learnharness-voice": "1" },
				body: JSON.stringify({ sdp, model: options.model, voice: options.voice }),
			});
		} catch {
			if (generation === this.generation) this.fail("call", VOICE_TRIAL_TEXT.callFailed, "This server couldn't be reached.");
			return;
		}
		const body = (await reply.json().catch(() => ({}))) as { code?: unknown; message?: unknown; error?: unknown; sessionId?: unknown; sdp?: unknown };
		if (generation !== this.generation) {
			// Ended, failed or left while OpenAI was opening the session: never leave it open there.
			if (reply.ok && typeof body.sessionId === "string") await this.hangup(body.sessionId);
			return;
		}
		if (!reply.ok) {
			if (reply.status === 503 && body.code === "no_key") this.fail("no_key", VOICE_TRIAL_TEXT.noKey, null);
			else {
				const said = typeof body.message === "string" ? body.message : typeof body.error === "string" ? body.error : `The server answered ${reply.status}.`;
				this.fail("call", VOICE_TRIAL_TEXT.callFailed, said);
			}
			return;
		}
		if (typeof body.sdp !== "string" || !body.sdp) {
			this.fail("call", VOICE_TRIAL_TEXT.callFailed, "The server's answer had no SDP.");
			return;
		}
		const sessionId = typeof body.sessionId === "string" ? body.sessionId : null;
		this.set({ sessionId });
		try {
			await pc.setRemoteDescription({ type: "answer", sdp: body.sdp });
		} catch (error) {
			if (generation === this.generation) this.fail("call", VOICE_TRIAL_TEXT.callFailed, errorName(error));
			return;
		}
		if (generation !== this.generation) return;
		this.set({}, this.peerDiag());
	}

	// ─── Watching the browser's objects ──────────────────────────────────────

	private peerDiag(): Partial<LiveDiagnostics> {
		const pc = this.pc;
		if (!pc) return {};
		return { connectionState: pc.connectionState, iceConnectionState: pc.iceConnectionState, signalingState: pc.signalingState };
	}

	private watchPeer(pc: PeerConnectionLike): void {
		const generation = this.generation;
		const changed = () => {
			if (generation !== this.generation) return;
			this.set({}, this.peerDiag());
			if (pc.connectionState === "failed" && (this.state.phase === "connecting" || this.state.phase === "live")) {
				this.fail("dropped", VOICE_TRIAL_TEXT.callDropped, "The connection failed.");
			}
		};
		pc.addEventListener("connectionstatechange", changed);
		pc.addEventListener("iceconnectionstatechange", changed);
		pc.addEventListener("signalingstatechange", changed);
		pc.addEventListener("track", (event) => {
			if (generation !== this.generation) return;
			const { streams, track } = (event ?? {}) as { streams?: unknown[]; track?: { kind?: string } };
			const stream = streams?.[0] ?? (track && this.deps.streamFromTrack ? this.deps.streamFromTrack(track) : null);
			this.noteAudio(`remote ${track?.kind ?? "track"} arrived${streams?.[0] ? "" : " without a stream"}`);
			if (stream) this.deps.onRemoteStream?.(stream);
		});
		pc.addEventListener("datachannel", (event) => {
			if (generation !== this.generation) return;
			const channel = (event as { channel?: DataChannelLike } | null)?.channel;
			if (channel) this.attachChannel(channel, "remote");
		});
	}

	private micText(track: TrackLike): string {
		return [track.readyState, track.muted ? "muted by the system" : null, track.enabled ? null : "off (Mute)"].filter(Boolean).join(", ");
	}

	private watchTrack(track: TrackLike): void {
		const generation = this.generation;
		const note = (what: string) => {
			if (generation !== this.generation) return;
			this.set({}, { mic: this.micText(track), micNotes: push(this.state.diag.micNotes, { t: this.at(), what }) });
		};
		track.addEventListener("mute", () => note("mute"));
		track.addEventListener("unmute", () => note("unmute"));
		track.addEventListener("ended", () => note("ended"));
		this.set({}, { mic: this.micText(track), micNotes: push(this.state.diag.micNotes, { t: this.at(), what: "started" }) });
	}

	private channelNotes(): ChannelNote[] {
		return this.channels.map(({ channel, origin }, i) => ({
			label: channel.label, origin, state: channel.readyState, events: this.state.diag.channels[i]?.events ?? 0,
		}));
	}

	private attachChannel(channel: DataChannelLike, origin: "created" | "remote"): void {
		const generation = this.generation;
		this.channels.push({ channel, origin });
		const index = this.channels.length - 1;
		const refresh = () => {
			if (generation !== this.generation) return;
			this.set({}, { channels: this.channelNotes() });
		};
		channel.addEventListener("open", refresh);
		channel.addEventListener("close", refresh);
		channel.addEventListener("error", (event) => {
			if (generation !== this.generation) return;
			const detail = (event as { error?: unknown } | null)?.error;
			this.set({}, { channels: this.channelNotes(), lastError: `data channel ${channel.label}: ${detail ? errorName(detail) : "error"}` });
		});
		channel.addEventListener("message", (event) => {
			if (generation !== this.generation) return;
			this.onMessage(channel, origin, index, (event as { data?: unknown } | null)?.data);
		});
		refresh();
	}

	// ─── Events ──────────────────────────────────────────────────────────────

	private send(event: Record<string, unknown> & { type: string }): boolean {
		const open = (channel: DataChannelLike | null) => channel !== null && channel.readyState === "open";
		const channel = open(this.eventChannel) ? this.eventChannel
			: this.channels.find((c) => c.origin === "created" && open(c.channel))?.channel
			?? this.channels.find((c) => open(c.channel))?.channel ?? null;
		if (!channel) {
			this.set({}, { lastError: `no open data channel; ${event.type} not sent` });
			return false;
		}
		try {
			channel.send(JSON.stringify(event));
		} catch (error) {
			this.set({}, { lastError: `${event.type} not sent: ${errorName(error)}` });
			return false;
		}
		this.set({}, { recent: push(this.state.diag.recent, { t: this.at(), dir: "out", what: event.type }, RECENT_MAX) });
		return true;
	}

	private commentary(content: string, delegationId: string | null = null): void {
		this.send({ type: "session.commentary.append", content, delegation_id: delegationId });
	}

	private onMessage(channel: DataChannelLike, origin: "created" | "remote", index: number, data: unknown): void {
		let event: Record<string, unknown> | null = null;
		if (typeof data === "string") {
			try {
				const parsed = JSON.parse(data) as unknown;
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) event = parsed as Record<string, unknown>;
			} catch { /* counted below as unreadable */ }
		}
		const type = event && typeof event.type === "string" ? event.type : "(unreadable)";
		const diag = this.state.diag;
		const channels = this.channelNotes().map((note, i) => (i === index ? { ...note, events: note.events + 1 } : note));
		if (!this.eventChannel) this.eventChannel = channel;
		this.set({}, {
			counts: { ...diag.counts, [type]: (diag.counts[type] ?? 0) + 1 },
			recent: push(diag.recent, { t: this.at(), dir: "in", what: type }, RECENT_MAX),
			channels,
			eventChannel: diag.eventChannel ?? `${origin} ${channel.label}`,
		});
		if (!event) return;
		switch (type) {
			case "session.started": return this.onStarted();
			case "session.input_transcript.delta": return this.onLearnerWords(event);
			case "session.output_transcript.delta": return this.onTutorWords(event);
			case "session.delegation.created": return this.onDelegation(event);
			case "session.paused": return this.set({ paused: true });
			case "session.resumed": return this.set({ paused: false });
			case "session.input_audio.muted": return this.set({ muteAck: "muted" });
			case "session.input_audio.unmuted": return this.set({ muteAck: "unmuted" });
			case "session.usage.updated": return this.onUsage(event.usage);
			case "session.closed": {
				this.onUsage(event.usage);
				const reason = typeof event.reason === "string" ? event.reason : "unknown";
				this.set({}, { closedReason: reason });
				void this.end("closed");
				return;
			}
			case "error": {
				const error = (event.error ?? {}) as { code?: unknown; message?: unknown };
				const text = [error.code, error.message].filter((part) => typeof part === "string" && part).join(": ") || "error";
				this.set({}, { lastError: text });
				return;
			}
			case "info": {
				const code = typeof event.code === "string" ? event.code : "info";
				this.set({}, { infos: push(this.state.diag.infos, code, 10) });
				return;
			}
			default: return;
		}
	}

	private onStarted(): void {
		if (!this.active) return;
		this.set({ phase: "live" }, { sessionStartedAt: this.at() });
		if (this.explanationSent) return;
		this.explanationSent = true;
		this.set({ step: "explaining" });
		this.commentary(VOICE_TRIAL_EXPLANATION);
		this.helloTimer = this.later(() => {
			if (this.state.phase === "live" && this.state.diag.firstTutorWordsAt === null) this.set({ hint: VOICE_TRIAL_TEXT.sayHello });
		}, LIVE_HELLO_HINT_MS);
	}

	private fragment(event: Record<string, unknown>): { delta: string; startMs?: number; endMs?: number } {
		const delta = typeof event.delta === "string" ? event.delta : "";
		const out: { delta: string; startMs?: number; endMs?: number } = { delta };
		if (typeof event.start_ms === "number") out.startMs = event.start_ms;
		if (typeof event.end_ms === "number") out.endMs = event.end_ms;
		return out;
	}

	private onLearnerWords(event: Record<string, unknown>): void {
		const fragment = this.fragment(event);
		if (!fragment.delta) return;
		this.replyFrom = this.deps.now();
		this.set({ captions: addCaption(this.state.captions, { speaker: "learner", ...fragment }) });
		if (this.state.questionShown && !this.state.answer) {
			this.questionText += fragment.delta;
			this.utterance += fragment.delta;
			this.cancel(this.answerTimer);
			this.answerTimer = this.later(() => this.readSpokenAnswer(), VOICE_TRIAL_ANSWER_QUIET_MS);
		}
	}

	private onTutorWords(event: Record<string, unknown>): void {
		const fragment = this.fragment(event);
		if (!fragment.delta) return;
		const diag: Partial<LiveDiagnostics> = {};
		if (this.state.diag.firstTutorWordsAt === null) diag.firstTutorWordsAt = this.at();
		if (this.replyFrom !== null) {
			const delay = this.deps.now() - this.replyFrom;
			diag.replyDelayMs = delay;
			diag.replyDelays = push(this.state.diag.replyDelays, delay, 10);
			this.replyFrom = null;
		}
		this.set({ captions: addCaption(this.state.captions, { speaker: "tutor", ...fragment }), hint: null }, diag);
		if (this.state.step === "explaining" && !this.state.questionShown) {
			this.cancel(this.explanationTimer);
			this.explanationTimer = this.later(() => this.showQuestion(), VOICE_TRIAL_EXPLANATION_QUIET_MS);
		}
	}

	private onDelegation(event: Record<string, unknown>): void {
		const delegation = (event.delegation ?? {}) as { id?: unknown };
		const id = typeof delegation.id === "string" ? delegation.id : null;
		if (!id) return;
		const t = this.at();
		this.set({}, { delegations: push(this.state.diag.delegations, { id, t, answeredAt: null }, 10) });
		this.later(() => {
			if (this.state.phase !== "live") return;
			this.commentary(VOICE_TRIAL_DELEGATION_REPLY, id);
			this.set({}, { delegations: this.state.diag.delegations.map((d) => (d.id === id && d.t === t ? { ...d, answeredAt: this.at() } : d)) });
		}, VOICE_TRIAL_DELEGATION_REPLY_MS);
	}

	private onUsage(raw: unknown): void {
		if (!raw || typeof raw !== "object") return;
		const { seconds, active_seconds, paused_seconds } = raw as Record<string, unknown>;
		if (typeof seconds !== "number") return;
		const usage: LiveUsage = { seconds };
		if (typeof active_seconds === "number") usage.active_seconds = active_seconds;
		if (typeof paused_seconds === "number") usage.paused_seconds = paused_seconds;
		this.set({}, { usage, cost: liveUsageCost(usage) });
	}

	// ─── The question ────────────────────────────────────────────────────────

	/** Shows the question and has the tutor read it (also the page's "Ask the question now"). */
	showQuestion(): void {
		if (this.state.phase !== "live" || this.state.questionShown) return;
		this.cancel(this.explanationTimer);
		this.questionText = "";
		this.utterance = "";
		this.set({ questionShown: true, step: "question" });
		this.commentary(questionCommentary(VOICE_TRIAL_QUESTION));
	}

	private readSpokenAnswer(): void {
		if (!this.state.questionShown || this.state.answer) return;
		const options = VOICE_TRIAL_QUESTION.options;
		const choice = spokenChoice(this.utterance, options) ?? spokenChoice(this.questionText, options);
		this.utterance = "";
		if (choice !== null) this.choose(choice, "voice");
	}

	/** An option tapped on screen (or "dont-know"). */
	answer(choice: TrialChoice): void {
		this.choose(choice, "tap");
	}

	private choose(choice: TrialChoice, by: "voice" | "tap"): void {
		if (this.state.phase !== "live" || !this.state.questionShown || this.state.answer) return;
		this.cancel(this.answerTimer);
		const correct = choice === VOICE_TRIAL_QUESTION.correct;
		this.set({ answer: { choice, by, correct }, step: "answered" });
		this.commentary(verdictCommentary(choice, VOICE_TRIAL_QUESTION));
	}

	// ─── Mute ────────────────────────────────────────────────────────────────

	toggleMute(): void {
		if (this.state.phase !== "live" && this.state.phase !== "connecting") return;
		const muted = !this.state.muted;
		if (this.track) this.track.enabled = !muted;
		this.set({ muted, muteAck: null }, this.track ? { mic: this.micText(this.track) } : {});
		this.send({ type: muted ? "session.input_audio.mute" : "session.input_audio.unmute" });
	}

	// ─── End ─────────────────────────────────────────────────────────────────

	private release(): void {
		for (const handle of this.timers) this.deps.clearTimeout(handle);
		this.timers.clear();
		this.limitTimer = this.helloTimer = this.explanationTimer = this.answerTimer = null;
		for (const { channel } of this.channels) {
			try { channel.close(); } catch { /* already closed */ }
		}
		try { this.pc?.close(); } catch { /* already closed */ }
		for (const track of this.stream?.getTracks() ?? []) track.stop();
		const channels = this.channelNotes();
		this.channels = [];
		this.eventChannel = null;
		this.stream = null;
		this.track = null;
		this.set({}, { ...this.peerDiag(), channels, mic: "stopped" });
		this.pc = null;
	}

	private async hangup(sessionId: string | null): Promise<void> {
		if (!sessionId) return;
		try {
			await this.deps.fetch("/api/voice-trial/hangup", {
				method: "POST",
				headers: { "content-type": "application/json", "x-learnharness-voice": "1" },
				body: JSON.stringify({ sessionId }),
			});
		} catch { /* the call is over on this side either way */ }
	}

	private fail(kind: FailureKind, message: string, detail: string | null): void {
		this.generation++;
		const sessionId = this.state.sessionId;
		this.release();
		this.set({ phase: "failed", failure: { kind, message, detail }, hint: null }, { lastError: detail ?? message });
		void this.hangup(sessionId);
	}

	/** Ends the call: session.close, then the channels, the connection, the microphone, and the hangup route. */
	async end(why: "user" | "limit" | "closed" = "user"): Promise<void> {
		if (!this.active) return;
		this.generation++;
		const sessionId = this.state.sessionId;
		this.set({ phase: "ending" });
		if (why !== "closed") this.send({ type: "session.close" });
		this.release();
		const endedText = why === "limit" ? VOICE_TRIAL_TEXT.timeLimit
			: why === "closed" ? `OpenAI ended the session (${this.state.diag.closedReason ?? "no reason given"}).`
			: "Call ended.";
		this.set({ phase: "ended", endedText, hint: null });
		await this.hangup(sessionId);
	}
}

// ─── The report ──────────────────────────────────────────────────────────────

const secs = (ms: number | null): string => (ms === null ? "–" : `${(ms / 1000).toFixed(1)}s`);

/**
 * "What the phone reports" as plain text, for Copy report: states, event
 * types and times only. Never the captions, the question's text or any
 * other spoken words.
 */
export function liveReportText(state: LiveCallState): string {
	const d = state.diag;
	const lines: string[] = [];
	lines.push("LearnHarness voice trial report");
	lines.push(`phase: ${state.phase}; step: ${state.step}; model: ${state.model ?? "–"}; voice: ${state.voice ?? "–"}`);
	if (state.failure) lines.push(`failure: ${state.failure.kind}${state.failure.detail ? ` (${state.failure.detail})` : ""}`);
	lines.push(`connection: ${d.connectionState}; ice: ${d.iceConnectionState}; signaling: ${d.signalingState}`);
	lines.push(`channels: ${d.channels.length ? d.channels.map((c) => `${c.origin} "${c.label}" ${c.state}, ${c.events} events`).join("; ") : "none"}`);
	lines.push(`events came on: ${d.eventChannel ?? "none yet"}`);
	lines.push(`mic: ${d.mic}${state.muted ? "; Mute on" : ""}${state.muteAck ? `; server says ${state.muteAck}` : ""}`);
	for (const note of d.micNotes) lines.push(`  mic ${secs(note.t)} ${note.what}`);
	lines.push(`audio element: ${d.audio}`);
	for (const note of d.audioNotes) lines.push(`  audio ${secs(note.t)} ${note.what}`);
	lines.push(`visibility changes: ${d.visibility.length ? d.visibility.map((n) => `${secs(n.t)} ${n.what}`).join(", ") : "none"}`);
	lines.push(`paused: ${state.paused ? "yes" : "no"}`);
	lines.push(`started ${secs(d.startedAt)}; session.started ${secs(d.sessionStartedAt)}; first tutor words ${secs(d.firstTutorWordsAt)}`);
	lines.push(`reply delay: last ${d.replyDelayMs === null ? "–" : `${d.replyDelayMs} ms`}; recent ${d.replyDelays.length ? d.replyDelays.join(", ") + " ms" : "–"}`);
	if (d.usage) {
		const parts = [`${d.usage.seconds}s total`];
		if (d.usage.active_seconds !== undefined) parts.push(`${d.usage.active_seconds}s active`);
		if (d.usage.paused_seconds !== undefined) parts.push(`${d.usage.paused_seconds}s paused`);
		lines.push(`usage: ${parts.join(", ")}; cost ${formatUsd(d.cost ?? 0)} at the listed prices`);
	} else lines.push("usage: none reported yet");
	lines.push(`delegations: ${d.delegations.length ? d.delegations.map((x) => `${secs(x.t)}${x.answeredAt === null ? " (not answered)" : ` answered ${secs(x.answeredAt)}`}`).join(", ") : "none"}`);
	if (state.answer) lines.push(`answer: ${state.answer.choice === "dont-know" ? "don't know" : optionLetter(state.answer.choice)} by ${state.answer.by}, ${state.answer.correct ? "correct" : "not correct"}`);
	if (d.closedReason) lines.push(`closed: ${d.closedReason}`);
	if (d.infos.length) lines.push(`info: ${d.infos.join(", ")}`);
	lines.push(`last error: ${d.lastError ?? "none"}`);
	lines.push(`event counts: ${Object.keys(d.counts).length ? Object.entries(d.counts).map(([type, n]) => `${type} ${n}`).join(", ") : "none"}`);
	lines.push("last events:");
	for (const event of d.recent) lines.push(`  ${secs(event.t)} ${event.dir === "out" ? "sent" : "got"} ${event.what}`);
	lines.push(`ChatGPT model ids with "live": ${d.chatgptLive}`);
	lines.push(`home-screen app: ${d.standalone ? "yes" : "no"}`);
	lines.push(`user agent: ${d.userAgent || "–"}`);
	return lines.join("\n");
}
