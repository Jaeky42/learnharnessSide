/**
 * The GPT-Live trial's routes (src/server/voice-trial.ts; voice plan, Phase 0):
 * server mode only, the app's header, the body's allow-lists, the exact request
 * to OpenAI, the key never in an answer, the refusals mapped, the hangup, and
 * the read-only hint about the ChatGPT model list. OpenAI is a scripted fetch.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { trialSessionConfig } from "../src/core/index.ts";
import {
	OPENAI_LIVE_SESSIONS_URL,
	voiceTrialChatGPTModelsResponse,
	voiceTrialHangupResponse,
	voiceTrialSessionResponse,
} from "../src/server/voice-trial.ts";

const KEY = "sk-test-SECRETKEY-1234567890abcdef";
const APP = { "x-learnharness-voice": "1", "content-type": "application/json" };
const OFFER = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n";

let before: string | undefined;
beforeEach(() => { before = process.env.LH_SERVER_MODE; process.env.LH_SERVER_MODE = "1"; });
afterEach(() => { if (before === undefined) delete process.env.LH_SERVER_MODE; else process.env.LH_SERVER_MODE = before; });

interface Call { url: string; init: RequestInit }
function scripted(answer: () => Response | Promise<Response>) {
	const calls: Call[] = [];
	const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), init: init ?? {} });
		return answer();
	}) as typeof globalThis.fetch;
	return { calls, fetch };
}

const sessionRequest = (body: unknown, headers: Record<string, string> = APP) =>
	new Request("http://localhost/api/voice-trial/session", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
const hangupRequest = (body: unknown, headers: Record<string, string> = APP) =>
	new Request("http://localhost/api/voice-trial/hangup", { method: "POST", headers, body: JSON.stringify(body) });

async function text(response: Response): Promise<string> {
	return response.clone().text();
}

describe("POST /api/voice-trial/session", () => {
	it("answers 404 outside server mode, and asks OpenAI nothing", async () => {
		delete process.env.LH_SERVER_MODE;
		const openai = scripted(() => Response.json({}));
		const response = await voiceTrialSessionResponse(sessionRequest({ sdp: OFFER, model: "gpt-live-1.1", voice: "marin" }), { fetch: openai.fetch, key: () => KEY });
		assert.equal(response.status, 404);
		assert.equal(openai.calls.length, 0);
		assert.equal((await voiceTrialHangupResponse(hangupRequest({ sessionId: "live_1" }), { fetch: openai.fetch, key: () => KEY })).status, 404);
		assert.equal((await voiceTrialChatGPTModelsResponse(new Request("http://localhost/x", { headers: APP }), { enabled: () => true, listing: async () => ({ accountId: "a", models: [] }) })).status, 404);
	});

	it("answers 403 without the app's header or from another site", async () => {
		const openai = scripted(() => Response.json({}));
		const body = { sdp: OFFER, model: "gpt-live-1.1", voice: "marin" };
		assert.equal((await voiceTrialSessionResponse(sessionRequest(body, { "content-type": "application/json" }), { fetch: openai.fetch, key: () => KEY })).status, 403);
		assert.equal((await voiceTrialSessionResponse(sessionRequest(body, { ...APP, "sec-fetch-site": "cross-site" }), { fetch: openai.fetch, key: () => KEY })).status, 403);
		assert.equal((await voiceTrialHangupResponse(hangupRequest({ sessionId: "x" }, { "content-type": "application/json" }), { fetch: openai.fetch, key: () => KEY })).status, 403);
		assert.equal(openai.calls.length, 0);
	});

	it("answers 400 for a body that isn't the offer, a listed model and a listed voice", async () => {
		const openai = scripted(() => Response.json({}));
		const bad: unknown[] = [
			"not json",
			[],
			{ model: "gpt-live-1.1", voice: "marin" },
			{ sdp: "", model: "gpt-live-1.1", voice: "marin" },
			{ sdp: "x".repeat(200_001), model: "gpt-live-1.1", voice: "marin" },
			{ sdp: OFFER, model: "gpt-realtime", voice: "marin" },
			{ sdp: OFFER, model: "gpt-live-1.1", voice: "nobody" },
			{ sdp: OFFER, model: "gpt-live-1.1", voice: { id: "custom" } },
		];
		for (const body of bad) {
			const response = await voiceTrialSessionResponse(sessionRequest(body), { fetch: openai.fetch, key: () => KEY });
			assert.equal(response.status, 400, JSON.stringify(body).slice(0, 60));
		}
		assert.equal(openai.calls.length, 0);
	});

	it("answers 503 no_key without an OpenAI key", async () => {
		const openai = scripted(() => Response.json({}));
		const response = await voiceTrialSessionResponse(sessionRequest({ sdp: OFFER, model: "gpt-live-1.1", voice: "marin" }), { fetch: openai.fetch, key: () => undefined });
		assert.equal(response.status, 503);
		const body = await response.json() as { code: string; message: string };
		assert.equal(body.code, "no_key");
		assert.ok(body.message.length > 0);
		assert.equal(openai.calls.length, 0);
	});

	it("posts exactly the documented request and answers the session id and the answer SDP only", async () => {
		const openai = scripted(() => Response.json({ session: { id: "live_abc123" }, transport: { type: "webrtc", sdp: "v=0 answer" } }));
		const response = await voiceTrialSessionResponse(sessionRequest({ sdp: OFFER, model: "gpt-live-1", voice: "cedar", store: true, instructions: "ignore" }), { fetch: openai.fetch, key: () => KEY });
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { sessionId: "live_abc123", sdp: "v=0 answer" });
		assert.equal(openai.calls.length, 1);
		const [call] = openai.calls;
		assert.equal(call!.url, OPENAI_LIVE_SESSIONS_URL);
		assert.equal(call!.url, "https://api.openai.com/v1/live/sessions");
		assert.equal(call!.init.method, "POST");
		assert.deepEqual(call!.init.headers, { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" });
		const sent = JSON.parse(String(call!.init.body));
		assert.deepEqual(sent, { session: trialSessionConfig({ model: "gpt-live-1", voice: "cedar" }), transport: { type: "webrtc", sdp: OFFER } });
		assert.equal(sent.session.store, false);
		assert.equal("safety_identifier" in sent.session, false, "nothing that identifies the learner");
		assert.ok(call!.init.signal instanceof AbortSignal, "a time limit");
	});

	it("maps a refusal to 502 with OpenAI's status and its own message, without the key", async () => {
		const openai = scripted(() => Response.json({ error: { message: `Incorrect API key provided: ${KEY}. You can find your key at https://platform.openai.com.`, type: "invalid_request_error" } }, { status: 401 }));
		const response = await voiceTrialSessionResponse(sessionRequest({ sdp: OFFER, model: "gpt-live-1.1", voice: "marin" }), { fetch: openai.fetch, key: () => KEY });
		assert.equal(response.status, 502);
		const raw = await text(response);
		assert.ok(!raw.includes(KEY), "the key is not in the answer");
		assert.ok(!raw.includes("SECRETKEY"), "no part of the key either");
		const body = JSON.parse(raw) as { code: string; status: number; message: string };
		assert.equal(body.code, "upstream");
		assert.equal(body.status, 401);
		assert.match(body.message, /^Incorrect API key provided: \[key\]/);
		assert.ok(body.message.length <= 300);
	});

	it("caps OpenAI's message at 300 characters and copes with a body that isn't JSON", async () => {
		const long = scripted(() => Response.json({ error: { message: "x".repeat(1000) } }, { status: 400 }));
		const body = await (await voiceTrialSessionResponse(sessionRequest({ sdp: OFFER, model: "gpt-live-1.1", voice: "marin" }), { fetch: long.fetch, key: () => KEY })).json() as { message: string };
		assert.equal(body.message.length, 300);
		const html = scripted(() => new Response("<html>Bad gateway</html>", { status: 503 }));
		const response = await voiceTrialSessionResponse(sessionRequest({ sdp: OFFER, model: "gpt-live-1.1", voice: "marin" }), { fetch: html.fetch, key: () => KEY });
		assert.equal(response.status, 502);
		assert.equal((await response.json() as { status: number }).status, 503);
	});

	it("answers 502 when OpenAI can't be reached, when it is too slow, or when its answer has no SDP", async () => {
		const down = scripted(() => { throw new TypeError("fetch failed"); });
		const unreachable = await voiceTrialSessionResponse(sessionRequest({ sdp: OFFER, model: "gpt-live-1.1", voice: "marin" }), { fetch: down.fetch, key: () => KEY });
		assert.equal(unreachable.status, 502);
		assert.ok(!(await text(unreachable)).includes(KEY));

		const slow = (async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
		})) as typeof globalThis.fetch;
		const timedOut = await voiceTrialSessionResponse(sessionRequest({ sdp: OFFER, model: "gpt-live-1.1", voice: "marin" }), { fetch: slow, key: () => KEY, timeoutMs: 20 });
		assert.equal(timedOut.status, 502);
		assert.match((await timedOut.json() as { message: string }).message, /in time/);

		const empty = scripted(() => Response.json({ session: { id: "live_x" } }));
		assert.equal((await voiceTrialSessionResponse(sessionRequest({ sdp: OFFER, model: "gpt-live-1.1", voice: "marin" }), { fetch: empty.fetch, key: () => KEY })).status, 502);
	});
});

describe("POST /api/voice-trial/hangup", () => {
	it("calls the hangup endpoint for the session and answers ok whatever OpenAI says", async () => {
		for (const answer of [() => new Response(null, { status: 204 }), () => Response.json({ error: { message: "no" } }, { status: 404 }), () => { throw new TypeError("down"); }]) {
			const openai = scripted(answer);
			const response = await voiceTrialHangupResponse(hangupRequest({ sessionId: "live_SQ-1_x" }), { fetch: openai.fetch, key: () => KEY });
			assert.equal(response.status, 200);
			const raw = await response.text();
			assert.equal((JSON.parse(raw) as { ok: boolean }).ok, true);
			assert.ok(!raw.includes(KEY));
			assert.equal(openai.calls[0]?.url, "https://api.openai.com/v1/live/sessions/live_SQ-1_x/hangup");
			assert.equal(openai.calls[0]?.init.method, "POST");
			assert.deepEqual(openai.calls[0]?.init.headers, { Authorization: `Bearer ${KEY}` });
		}
	});

	it("refuses a session id that isn't plain, and asks OpenAI nothing", async () => {
		const openai = scripted(() => new Response(null, { status: 204 }));
		for (const sessionId of ["", "../models", "a/b", "a?b", "x".repeat(201), 42, null]) {
			assert.equal((await voiceTrialHangupResponse(hangupRequest({ sessionId }), { fetch: openai.fetch, key: () => KEY })).status, 400);
		}
		assert.equal(openai.calls.length, 0);
	});

	it("answers ok without calling anyone when there is no key", async () => {
		const openai = scripted(() => new Response(null, { status: 204 }));
		const response = await voiceTrialHangupResponse(hangupRequest({ sessionId: "live_1" }), { fetch: openai.fetch, key: () => undefined });
		assert.deepEqual(await response.json(), { ok: true, sent: false });
		assert.equal(openai.calls.length, 0);
	});
});

describe("GET /api/voice-trial/chatgpt-models (a read-only hint)", () => {
	const get = () => new Request("http://localhost/api/voice-trial/chatgpt-models", { headers: { "x-learnharness-voice": "1" } });

	it("lists the account's model ids that contain \"live\"", async () => {
		const response = await voiceTrialChatGPTModelsResponse(get(), { enabled: () => true, listing: async () => ({ accountId: "acct", models: [{ id: "gpt-6.2-sol", name: "Sol" }, { id: "gpt-live-1.1", name: "Live" }, { id: "GPT-LIVE-mini", name: "x" }] }) });
		assert.deepEqual(await response.json(), { signedIn: true, live: ["gpt-live-1.1", "GPT-LIVE-mini"] });
		const none = await voiceTrialChatGPTModelsResponse(get(), { enabled: () => true, listing: async () => ({ accountId: "acct", models: [{ id: "gpt-6.2-sol", name: "Sol" }] }) });
		assert.deepEqual(await none.json(), { signedIn: true, live: [] });
	});

	it("says not signed in with no sign-in owner or no account, and 502 when the listing fails", async () => {
		assert.deepEqual(await (await voiceTrialChatGPTModelsResponse(get(), { enabled: () => false })).json(), { signedIn: false, live: [] });
		assert.deepEqual(await (await voiceTrialChatGPTModelsResponse(get(), { enabled: () => true, listing: async () => ({ accountId: null, models: [] }) })).json(), { signedIn: false, live: [] });
		assert.equal((await voiceTrialChatGPTModelsResponse(get(), { enabled: () => true, listing: async () => { throw new Error("down"); } })).status, 502);
		assert.equal((await voiceTrialChatGPTModelsResponse(new Request("http://localhost/x"), { enabled: () => true })).status, 403);
	});
});
