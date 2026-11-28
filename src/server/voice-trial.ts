/**
 * VOICE (fork, Phase 0 of docs/fork/plans/voice-session-plan.md): the two
 * routes behind the GPT-Live trial page. Server mode only (404 otherwise).
 * The login gate (proxy.ts) already requires a signed-in session and a
 * same-site Origin for writes; these also require the app's own header.
 *
 *   POST /api/voice-trial/session {sdp, model, voice} → {sessionId, sdp}
 *   POST /api/voice-trial/hangup  {sessionId}         → {ok: true}
 *   GET  /api/voice-trial/chatgpt-models               → {signedIn, live}
 *
 * GPT-Live has no client secret: this server posts the browser's WebRTC
 * offer to OpenAI with the API key and hands back only the answer SDP and
 * the session's id. The session's config is built here from the trial's
 * fixed config (the browser picks only the model and the voice, each from
 * an allow-list). The key never appears in an answer, an error or a log
 * line, and nothing that identifies the learner is sent to OpenAI.
 */

import { isLiveModel, isLiveVoice, trialSessionConfig, VOICE_TRIAL_MAX_MS } from "../core/voice/live.ts";
import { chatGPTRequest } from "../agent/chatgpt-bridge.ts";
import { webSubscriptionsEnabled } from "../agent/subscription-runtime.ts";
import { keyValue } from "./keys.ts";
// Loaded for its side effect: it gives the ChatGPT bridge this server's own sign-in owner.
import "./web-subscriptions.ts";
import { serverModeEnabled } from "./server-auth.ts";

export const OPENAI_LIVE_SESSIONS_URL = "https://api.openai.com/v1/live/sessions";
const SESSION_TIMEOUT_MS = 20_000;
const HANGUP_TIMEOUT_MS = 10_000;
const MAX_BODY_CHARS = 256_000;
const MAX_SDP_CHARS = 200_000;
const MAX_UPSTREAM_MESSAGE = 300;
const SESSION_ID = /^[A-Za-z0-9_-]{1,200}$/;
const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" } as const;

export const VOICE_TRIAL_NO_KEY_MESSAGE = "This server has no OpenAI API key. Add one in Settings → Providers, then try again.";

export interface VoiceTrialDeps {
	fetch?: typeof fetch;
	/** The OpenAI key; the server's key store by default. */
	key?: () => string | undefined;
	timeoutMs?: number;
	/** The server-side limit's timers (real, unref'd timers by default). */
	timers?: VoiceTrialTimers;
}

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: HEADERS });
}

export function voiceTrialAvailable(): boolean {
	return serverModeEnabled();
}

function appRequest(request: Request): boolean {
	return request.headers.get("x-learnharness-voice") === "1" && request.headers.get("sec-fetch-site") !== "cross-site";
}

/** The gates both routes share; null when the request may go on. */
function gate(request: Request): Response | null {
	if (!serverModeEnabled()) return json({ error: "Not found." }, 404);
	if (!appRequest(request)) return json({ error: "This needs a LearnHarness request." }, 403);
	return null;
}

async function readBody(request: Request): Promise<Record<string, unknown> | Response> {
	const declared = Number(request.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_BODY_CHARS) return json({ error: "Request too large." }, 413);
	const text = await request.text().catch(() => "");
	if (text.length > MAX_BODY_CHARS) return json({ error: "Request too large." }, 413);
	try {
		const parsed = JSON.parse(text) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
		return parsed as Record<string, unknown>;
	} catch {
		return json({ error: "Expected JSON." }, 400);
	}
}

/** Whatever OpenAI said, with the key (and anything shaped like a key) taken out. */
function scrub(message: string, key: string): string {
	let out = key ? message.split(key).join("[key]") : message;
	out = out.replace(/\bsk-[A-Za-z0-9_*-]{6,}/g, "[key]");
	return out.slice(0, MAX_UPSTREAM_MESSAGE);
}

async function upstreamMessage(response: Response, key: string, signal: AbortSignal): Promise<string> {
	const text = await within(response.text(), signal).catch(() => "");
	let message = "";
	try {
		const body = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
		if (typeof body.error === "string") message = body.error;
		else if (body.error && typeof body.error.message === "string") message = body.error.message;
		else if (typeof body.message === "string") message = body.message;
	} catch {
		message = text;
	}
	return scrub(message.trim() || `OpenAI answered ${response.status}.`, key);
}

/** A body read that gives up when the signal does, whether or not the stream itself is tied to it. */
function within<T>(read: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(new Error("timeout"));
	return new Promise<T>((resolve, reject) => {
		const stop = () => reject(new Error("timeout"));
		signal.addEventListener("abort", stop, { once: true });
		read.then(
			(value) => { signal.removeEventListener("abort", stop); resolve(value); },
			(error: unknown) => { signal.removeEventListener("abort", stop); reject(error); },
		);
	});
}

function withTimeout(ms: number): { signal: AbortSignal; done: () => void } {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ms);
	return { signal: controller.signal, done: () => clearTimeout(timer) };
}

// ─── The server's own cost limit ─────────────────────────────────────────────

/**
 * The page ends a call after VOICE_TRIAL_MAX_MS, but its timers can be held
 * while iOS has the page in the background, and a closed tab says nothing.
 * So this process remembers each session it opened and hangs it up itself a
 * minute after the page's limit, unless the page's own hangup came first.
 * In memory only (a restart forgets them); the timers never keep the process
 * alive. At most VOICE_TRIAL_MAX_TRACKED at once: a new session is refused
 * rather than opened unguarded.
 */
export const VOICE_TRIAL_SERVER_LIMIT_MS = VOICE_TRIAL_MAX_MS + 60_000;
export const VOICE_TRIAL_MAX_TRACKED = 8;

export interface VoiceTrialTimers {
	set(run: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

const realTimers: VoiceTrialTimers = {
	set: (run, ms) => {
		const handle = setTimeout(run, ms);
		(handle as { unref?: () => void }).unref?.();
		return handle;
	},
	clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface Tracked { handle: unknown; timers: VoiceTrialTimers }
const TRACKED_KEY = Symbol.for("lh.voiceTrial.sessions");

function tracked(): Map<string, Tracked> {
	const global = globalThis as typeof globalThis & { [TRACKED_KEY]?: Map<string, Tracked> };
	return (global[TRACKED_KEY] ??= new Map());
}

function untrack(sessionId: string): void {
	const entry = tracked().get(sessionId);
	if (!entry) return;
	entry.timers.clear(entry.handle);
	tracked().delete(sessionId);
}

/** How many sessions this process is watching (tests). */
export function voiceTrialTrackedSessions(): string[] {
	return [...tracked().keys()];
}

/** Forget every watched session and its timer (tests). */
export function resetVoiceTrialTracking(): void {
	for (const id of voiceTrialTrackedSessions()) untrack(id);
}

/** POST …/hangup with the key. True when OpenAI answered at all. */
async function hangupAtOpenAI(sessionId: string, key: string, doFetch: typeof fetch, timeoutMs: number): Promise<boolean> {
	const timer = withTimeout(timeoutMs);
	try {
		const response = await doFetch(`${OPENAI_LIVE_SESSIONS_URL}/${encodeURIComponent(sessionId)}/hangup`, {
			method: "POST",
			headers: { Authorization: `Bearer ${key}` },
			signal: timer.signal,
		});
		await response.body?.cancel().catch(() => undefined);
		return true;
	} catch {
		return false;
	} finally {
		timer.done();
	}
}

const keyOf = (deps: VoiceTrialDeps) => (deps.key ?? (() => keyValue("OPENAI_API_KEY")))();

function track(sessionId: string, deps: VoiceTrialDeps): void {
	const timers = deps.timers ?? realTimers;
	untrack(sessionId);
	const handle = timers.set(() => {
		tracked().delete(sessionId);
		const key = keyOf(deps);
		if (key) void hangupAtOpenAI(sessionId, key, deps.fetch ?? fetch, HANGUP_TIMEOUT_MS);
	}, VOICE_TRIAL_SERVER_LIMIT_MS);
	tracked().set(sessionId, { handle, timers });
}

// ─── The routes ──────────────────────────────────────────────────────────────

export async function voiceTrialSessionResponse(request: Request, deps: VoiceTrialDeps = {}): Promise<Response> {
	const refused = gate(request);
	if (refused) return refused;
	const body = await readBody(request);
	if (body instanceof Response) return body;
	const { sdp, model, voice } = body;
	if (typeof sdp !== "string" || sdp.length === 0 || sdp.length > MAX_SDP_CHARS) return json({ error: "The offer is missing or too long." }, 400);
	if (!isLiveModel(model)) return json({ error: "Unknown model." }, 400);
	if (!isLiveVoice(voice)) return json({ error: "Unknown voice." }, 400);
	const key = keyOf(deps);
	if (!key) return json({ code: "no_key", message: VOICE_TRIAL_NO_KEY_MESSAGE }, 503);
	if (tracked().size >= VOICE_TRIAL_MAX_TRACKED) {
		return json({ code: "too_many", message: "Too many voice trial calls are open on this server. End one, or wait a few minutes." }, 429);
	}

	const doFetch = deps.fetch ?? fetch;
	// One limit for the whole exchange: the request and the reading of OpenAI's answer.
	const timer = withTimeout(deps.timeoutMs ?? SESSION_TIMEOUT_MS);
	let status = 0;
	let answer: { session?: { id?: unknown }; transport?: { sdp?: unknown } } | null;
	try {
		const response = await doFetch(OPENAI_LIVE_SESSIONS_URL, {
			method: "POST",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify({ session: trialSessionConfig({ model, voice }), transport: { type: "webrtc", sdp } }),
			signal: timer.signal,
		});
		status = response.status;
		if (!response.ok) {
			const message = await upstreamMessage(response, key, timer.signal);
			if (timer.signal.aborted) throw new Error("timeout");
			return json({ code: "upstream", status, message }, 502);
		}
		const text = await within(response.text(), timer.signal);
		try { answer = JSON.parse(text) as typeof answer; } catch { answer = null; }
	} catch {
		const timedOut = timer.signal.aborted;
		return json({ code: "unreachable", message: timedOut ? "OpenAI didn't answer in time." : "OpenAI couldn't be reached." }, 502);
	} finally {
		timer.done();
	}
	const sessionId = typeof answer?.session?.id === "string" && SESSION_ID.test(answer.session.id) ? answer.session.id : null;
	const answerSdp = answer?.transport?.sdp;
	if (typeof answerSdp !== "string" || answerSdp.length === 0) {
		// A session was opened that the browser can never join: close it at once.
		if (sessionId) await hangupAtOpenAI(sessionId, key, doFetch, HANGUP_TIMEOUT_MS);
		return json({ code: "upstream", status, message: "OpenAI's answer had no SDP." }, 502);
	}
	if (sessionId) track(sessionId, deps);
	return json({ sessionId, sdp: answerSdp });
}

export async function voiceTrialHangupResponse(request: Request, deps: VoiceTrialDeps = {}): Promise<Response> {
	const refused = gate(request);
	if (refused) return refused;
	const body = await readBody(request);
	if (body instanceof Response) return body;
	const { sessionId } = body;
	if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return json({ error: "Unknown session." }, 400);
	untrack(sessionId);
	const key = keyOf(deps);
	if (!key) return json({ ok: true, sent: false });
	// OpenAI's answer changes nothing here: the browser has already closed its side.
	const sent = await hangupAtOpenAI(sessionId, key, deps.fetch ?? fetch, deps.timeoutMs ?? HANGUP_TIMEOUT_MS);
	return json({ ok: true, sent });
}

// ─── A hint for the readout: does the ChatGPT plan list a GPT-Live model? ────

/** The account's model listing as the app's model menu gets it (the sign-in owner's own `models`). */
export type ChatGPTListing = () => Promise<{ accountId: string | null; models: Array<{ id: string; name: string }> }>;

const defaultListing: ChatGPTListing = () => chatGPTRequest("models");

/**
 * Read-only: the ids in the signed-in ChatGPT account's model list that
 * contain "live". It goes through the same listing the model menu uses (the
 * owner's `models`, which calls OpenAI's /models with the plan's sign-in on
 * the server's side); no token or credential is read here or answered.
 */
export async function voiceTrialChatGPTModelsResponse(request: Request, deps: { listing?: ChatGPTListing; enabled?: () => boolean } = {}): Promise<Response> {
	const refused = gate(request);
	if (refused) return refused;
	if (!(deps.enabled ?? webSubscriptionsEnabled)()) return json({ signedIn: false, live: [] });
	try {
		const value = await (deps.listing ?? defaultListing)();
		if (!value || value.accountId === null) return json({ signedIn: false, live: [] });
		const live = (Array.isArray(value.models) ? value.models : [])
			.map((model) => (typeof model?.id === "string" ? model.id : ""))
			.filter((id) => id.toLowerCase().includes("live"))
			.slice(0, 20);
		return json({ signedIn: true, live });
	} catch {
		return json({ error: "The ChatGPT model list couldn't be read." }, 502);
	}
}
