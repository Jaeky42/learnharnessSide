/**
 * Cloud sync Phase 2 (side-tutor fork; docs/cloud-sync.md): signing in to
 * ChatGPT and Claude from the server's Settings.
 *
 *  - ChatGPT paste step: only the pending sign-in's own 127.0.0.1 callback
 *    is accepted, and forwarding it completes a real (offline) sign-in.
 *  - Claude: `claude auth login` is driven through pipes against a stand-in
 *    CLI that prints what the real one printed on a headless VPS.
 *  - Routes answer 404 outside server mode; the sign-in link is one-use.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { after, describe, it } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { checkPastedCallback, forwardPastedCallback } from "../src/server/chatgpt-paste.ts";
import { createClaudeLogin, type ClaudeLoginDeps } from "../src/server/claude-login.ts";
import { claudeLoginControlResponse, claudeLoginOpenResponse, claudeLoginStatusResponse } from "../src/server/claude-login-http.ts";

const require = createRequire(import.meta.url);
const { createChatGPT, SCOPES } = require("../electron/chatgpt.cjs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-server-sign-in-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 5000) {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out waiting");
		await sleep(20);
	}
}

describe("ChatGPT paste step", () => {
	const origin = "http://127.0.0.1:45809";
	const good = `${origin}/auth/callback?state=abc&code=xyz&client_id=c`;

	it("accepts only the pending listener's callback address", () => {
		assert.deepEqual(checkPastedCallback(`  ${good}  `, origin), { ok: true, url: good });
		const refused = [
			[good, null, /No ChatGPT sign-in is waiting/],
			["", origin, /Paste the full address/],
			["not a url", origin, /isn't a web address/],
			[`https://127.0.0.1:45809/auth/callback?state=a&code=b`, origin, /not the sign-in address/],
			[`http://localhost:45809/auth/callback?state=a&code=b`, origin, /not the sign-in address/],
			[`http://127.0.0.1:45809/admin?state=a&code=b`, origin, /not the sign-in address/],
			[`http://user:pw@127.0.0.1:45809/auth/callback?state=a&code=b`, origin, /not the sign-in address/],
			[`http://127.0.0.1:9999/auth/callback?state=a&code=b`, origin, /older sign-in attempt/],
			[`${origin}/auth/callback?code=b`, origin, /missing its sign-in code/],
			[`${origin}/auth/callback?state=a`, origin, /missing its sign-in code/],
			[`${origin}/auth/callback?state=${"a".repeat(9000)}`, origin, /too long/],
		] as const;
		for (const [pasted, pending, message] of refused) {
			const result = checkPastedCallback(pasted, pending);
			assert.equal(result.ok, false, pasted);
			assert.match((result as { error: string }).error, message);
		}
	});

	it("forwarding the pasted address finishes a real ChatGPT sign-in", async () => {
		const { privateKey, publicKey } = await generateKeyPair("RS256");
		const jwk = { ...await exportJWK(publicKey), kid: "k", alg: "RS256", use: "sig" };
		let saved: unknown = { version: 1, hostId: "urn:uuid:00000000-0000-4000-8000-000000000001", activeId: null, registrations: [] };
		let authorize!: URL;
		let done!: () => void;
		const finished = new Promise<void>((r) => { done = r; });
		const service = createChatGPT({
			store: { async read() { return structuredClone(saved); }, async write(next: unknown) { saved = structuredClone(next); } },
			openExternal: async (value: string) => { authorize = new URL(value); },
			timeoutMs: 5000,
			onChange: (push: { status: { pending: boolean; activeId: string | null } }) => { if (!push.status.pending && push.status.activeId) done(); },
			fetch: async (target: string, init: RequestInit = {}) => {
				if (target.endsWith("jwks.json")) return Response.json({ keys: [jwk] });
				if (target.endsWith("/oauth/token")) {
					const form = init.body as URLSearchParams;
					const idToken = await new SignJWT({ nonce: authorize.searchParams.get("nonce"), email: "learner@example.invalid" })
						.setProtectedHeader({ alg: "RS256", kid: "k" }).setIssuer("https://auth.openai.com").setSubject("learner")
						.setAudience(form.get("client_id")!).setIssuedAt().setExpirationTime("1h").sign(privateKey);
					return Response.json({ access_token: "t", refresh_token: "r", id_token: idToken, token_type: "Bearer", expires_in: 3600, scope: SCOPES.join(" ") });
				}
				if (target.endsWith("/models")) return Response.json({ models: [] });
				throw new Error(`unexpected request ${target}`);
			},
		});
		assert.equal(service.pendingCallbackOrigin(), null, "nothing pending yet");
		await service.login();
		const pending = service.pendingCallbackOrigin();
		const redirect = new URL(authorize.searchParams.get("redirect_uri")!);
		assert.equal(pending, redirect.origin, "the paste step targets exactly this attempt's listener");
		// What the phone's address bar shows after signing in at OpenAI:
		const landed = new URL(redirect);
		landed.search = new URLSearchParams({ state: authorize.searchParams.get("state")!, code: "code", client_id: "oaiapp_client" }).toString();
		const checked = checkPastedCallback(landed.href, pending);
		assert.ok(checked.ok);
		assert.equal(await forwardPastedCallback(checked.url), true);
		await finished;
		const status = await service.status();
		assert.equal(status.pending, false);
		assert.equal(status.accounts.length, 1);
		assert.equal(status.accounts[0].connected, true);
		assert.equal(service.pendingCallbackOrigin(), null, "the listener is gone after use");
		service.close();
	});
});

// A stand-in for `claude` that prints exactly what the real CLI printed on the VPS.
const FAKE_CLAUDE = path.join(TMP, "fake-claude.mjs");
fs.writeFileSync(FAKE_CLAUDE, `
const args = process.argv.slice(2).join(" ");
if (args === "auth status --json") { console.log(JSON.stringify({ loggedIn: process.env.FAKE_SIGNED_IN === "1" })); process.exit(0); }
if (args === "auth logout") { console.log("Successfully logged out"); process.exit(0); }
if (args === "auth login --claudeai") {
	if (process.env.FAKE_MODE === "silent") { setTimeout(() => {}, 60000); }
	else {
		process.stdout.write("Opening browser to sign in…\\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=s1\\nPaste code here if prompted > ");
		process.stdin.setEncoding("utf8");
		let buffer = "";
		process.stdin.on("data", (chunk) => {
			buffer += chunk;
			if (!buffer.includes("\\n")) return;
			if (buffer.trim() === "good-code#state") { process.stdout.write("Login successful.\\n"); process.exit(0); }
			process.stdout.write("Invalid code. Please make sure the full code was copied.\\n");
		});
	}
} else { process.exit(2); }
`);

function deps(env: Record<string, string> = {}, now = () => Date.now()): ClaudeLoginDeps & { runs: string[][] } {
	const runs: string[][] = [];
	return {
		runs,
		binary: () => FAKE_CLAUDE,
		spawn: (binary, args) => spawn(process.execPath, [binary, ...args], { env: { ...process.env, ...env }, stdio: "pipe" }),
		run: (binary, args) => new Promise((resolve) => {
			runs.push(args);
			const child = spawn(process.execPath, [binary, ...args], { env: { ...process.env, ...env } });
			let stdout = "";
			child.stdout.on("data", (c) => { stdout += c; });
			child.on("exit", (code) => resolve({ code, stdout }));
		}),
		now,
	};
}

describe("Claude sign-in (claude auth login through pipes)", () => {
	it("shows a one-use link, takes the code, and finishes on 'Login successful.'", async () => {
		const login = createClaudeLogin(deps());
		const started = login.start();
		assert.equal(started.phase, "starting");
		await until(() => login.view().phase === "waiting");
		const waiting = login.view();
		assert.ok(waiting.expiresAt && waiting.expiresAt - Date.now() > 9 * 60 * 1000, "10-minute limit");
		assert.match(waiting.openPath ?? "", /^\/api\/claude-code\/login\/open\?id=[0-9a-f-]{36}$/);
		const token = new URL(waiting.openPath!, "http://x").searchParams.get("id")!;
		assert.equal(login.takeLink(token), "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=s1");
		assert.equal(login.takeLink(token), null, "the link opens once");
		assert.equal(login.view().openPath, null);
		assert.ok("error" in login.submitCode("wrong-attempt", "good-code#state"));
		assert.ok("error" in login.submitCode(waiting.attemptId, "two\nlines"));
		const verifying = login.submitCode(waiting.attemptId, "  good-code#state  ");
		assert.equal((verifying as { phase: string }).phase, "verifying");
		await until(() => login.view().phase === "done");
		assert.equal(login.view().error, null);
	});

	it("a rejected code ends the attempt with a clear message", async () => {
		const login = createClaudeLogin(deps());
		login.start();
		await until(() => login.view().phase === "waiting");
		login.submitCode(login.view().attemptId, "bad-code");
		await until(() => login.view().phase === "failed");
		assert.match(login.view().error ?? "", /didn't accept that code/);
	});

	it("cancel stops the CLI; a missing CLI says so", async () => {
		const login = createClaudeLogin(deps());
		login.start();
		await until(() => login.view().phase === "waiting");
		assert.equal(login.cancel().phase, "idle");
		const missing = createClaudeLogin({ ...deps(), binary: () => null });
		assert.match(missing.start().error ?? "", /isn't installed on this server yet/);
		assert.equal(await missing.signedIn(), null);
	});

	it("signed-in status and Disconnect use the CLI's own commands", async () => {
		const out = deps({ FAKE_SIGNED_IN: "0" });
		assert.equal(await createClaudeLogin(out).signedIn(), false);
		const inn = deps({ FAKE_SIGNED_IN: "1" });
		const login = createClaudeLogin(inn);
		assert.equal(await login.signedIn(), true);
		assert.equal(await login.logout(), true);
		assert.deepEqual(inn.runs, [["auth", "status", "--json"], ["auth", "logout"]]);
	});
});

describe("Claude sign-in routes", () => {
	const app = { "x-learnharness-claude-code": "1" };

	it("answer 404 outside server mode", async () => {
		delete process.env.LH_SERVER_MODE;
		assert.equal((await claudeLoginStatusResponse(new Request("http://x/api/claude-code/login", { headers: app }))).status, 404);
		assert.equal((await claudeLoginControlResponse(new Request("http://x/api/claude-code/login", { method: "POST", headers: { ...app, "content-type": "application/json" }, body: "{\"op\":\"start\"}" }))).status, 404);
		assert.equal(claudeLoginOpenResponse(new Request("http://x/api/claude-code/login/open?id=00000000-0000-4000-8000-000000000000")).status, 404);
	});

	it("in server mode: need the app header; unknown links are refused", async () => {
		process.env.LH_SERVER_MODE = "1";
		try {
			assert.equal((await claudeLoginControlResponse(new Request("http://x/api/claude-code/login", { method: "POST", headers: { "content-type": "application/json" }, body: "{\"op\":\"start\"}" }))).status, 403);
			assert.equal((await claudeLoginControlResponse(new Request("http://x/api/claude-code/login", { method: "POST", headers: { ...app, "content-type": "application/json" }, body: "{\"op\":\"nope\"}" }))).status, 400);
			assert.equal(claudeLoginOpenResponse(new Request("http://x/api/claude-code/login/open?id=00000000-0000-4000-8000-000000000000")).status, 410);
			assert.equal(claudeLoginOpenResponse(new Request("http://x/api/claude-code/login/open?id=../../etc")).status, 410);
		} finally {
			delete process.env.LH_SERVER_MODE;
		}
	});
});

describe("server marker cookie", () => {
	it("the cloud server marks pages with lh_server=1; the desktop never does", async () => {
		const { proxy } = await import("../proxy.ts");
		const { NextRequest } = await import("next/server");
		const { isServerMode } = await import("../components/settings/server-mode.ts");
		delete process.env.LH_SERVER_MODE;
		assert.doesNotMatch(proxy(new NextRequest("http://127.0.0.1:3000/login")).headers.get("set-cookie") ?? "", /lh_server/);
		process.env.LH_SERVER_MODE = "1";
		try {
			const marked = proxy(new NextRequest("https://learn.example.com/login", { headers: { host: "learn.example.com" } }));
			assert.match(marked.headers.get("set-cookie") ?? "", /lh_server=1/);
		} finally {
			delete process.env.LH_SERVER_MODE;
		}
		assert.equal(isServerMode("a=1; lh_server=1"), true);
		assert.equal(isServerMode("lh_server=0"), false);
		assert.equal(isServerMode(undefined), false);
	});
});
