/**
 * VOICE (fork, Phase 0 of docs/fork/plans/voice-session-plan.md): the two
 * routes behind the GPT-Live trial page. Server mode only (404 otherwise).
 * The login gate (proxy.ts) already requires a signed-in session and a
 * same-site Origin for writes; these also require the app's own header.
 *
 *   POST /api/voice-trial/session {sdp, model, voice} → {sessionId, sdp}
 *   POST /api/voice-trial/hangup  {sessionId}         → {ok: true}
 *
 * GPT-Live has no client secret: this server posts the browser's WebRTC
 * offer to OpenAI with the API key and hands back only the answer SDP and
 * the session's id. The session's config is built here from the trial's
 * fixed config (the browser picks only the model and the voice, each from
 * an allow-list). The key never appears in an answer, an error or a log
 * line, and nothing that identifies the learner is sent to OpenAI.
 */

import { isLiveModel, isLiveVoice, trialSessionConfig } from "../core/voice/live.ts";
import { keyValue } from "./keys.ts";
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

async function upstreamMessage(response: Response, key: string): Promise<string> {
	const text = await response.text().catch(() => "");
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

function withTimeout(ms: number): { signal: AbortSignal; done: () => void } {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ms);
	return { signal: controller.signal, done: () => clearTimeout(timer) };
}

export async function voiceTrialSessionResponse(request: Request, deps: VoiceTrialDeps = {}): Promise<Response> {
	const refused = gate(request);
	if (refused) return refused;
	const body = await readBody(request);
	if (body instanceof Response) return body;
	const { sdp, model, voice } = body;
	if (typeof sdp !== "string" || sdp.length === 0 || sdp.length > MAX_SDP_CHARS) return json({ error: "The offer is missing or too long." }, 400);
	if (!isLiveModel(model)) return json({ error: "Unknown model." }, 400);
	if (!isLiveVoice(voice)) return json({ error: "Unknown voice." }, 400);
	const key = (deps.key ?? (() => keyValue("OPENAI_API_KEY")))();
	if (!key) return json({ code: "no_key", message: VOICE_TRIAL_NO_KEY_MESSAGE }, 503);

	const doFetch = deps.fetch ?? fetch;
	const timer = withTimeout(deps.timeoutMs ?? SESSION_TIMEOUT_MS);
	let response: Response;
	try {
		response = await doFetch(OPENAI_LIVE_SESSIONS_URL, {
			method: "POST",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify({ session: trialSessionConfig({ model, voice }), transport: { type: "webrtc", sdp } }),
			signal: timer.signal,
		});
	} catch {
		timer.done();
		const timedOut = timer.signal.aborted;
		return json({ code: "unreachable", message: timedOut ? "OpenAI didn't answer in time." : "OpenAI couldn't be reached." }, 502);
	}
	timer.done();
	if (!response.ok) {
		return json({ code: "upstream", status: response.status, message: await upstreamMessage(response, key) }, 502);
	}
	const answer = (await response.json().catch(() => null)) as { session?: { id?: unknown }; transport?: { sdp?: unknown } } | null;
	const sessionId = answer?.session?.id;
	const answerSdp = answer?.transport?.sdp;
	if (typeof answerSdp !== "string" || answerSdp.length === 0) {
		return json({ code: "upstream", status: response.status, message: "OpenAI's answer had no SDP." }, 502);
	}
	return json({ sessionId: typeof sessionId === "string" ? sessionId : null, sdp: answerSdp });
}

export async function voiceTrialHangupResponse(request: Request, deps: VoiceTrialDeps = {}): Promise<Response> {
	const refused = gate(request);
	if (refused) return refused;
	const body = await readBody(request);
	if (body instanceof Response) return body;
	const { sessionId } = body;
	if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return json({ error: "Unknown session." }, 400);
	const key = (deps.key ?? (() => keyValue("OPENAI_API_KEY")))();
	if (!key) return json({ ok: true, sent: false });
	const doFetch = deps.fetch ?? fetch;
	const timer = withTimeout(deps.timeoutMs ?? HANGUP_TIMEOUT_MS);
	let sent = false;
	try {
		const response = await doFetch(`${OPENAI_LIVE_SESSIONS_URL}/${encodeURIComponent(sessionId)}/hangup`, {
			method: "POST",
			headers: { Authorization: `Bearer ${key}` },
			signal: timer.signal,
		});
		sent = true;
		await response.body?.cancel().catch(() => undefined);
	} catch {
		// OpenAI's answer changes nothing here: the browser has already closed its side.
	} finally {
		timer.done();
	}
	return json({ ok: true, sent });
}
