/**
 * Claude sign-in from Settings on the cloud server (side-tutor fork, cloud
 * sync Phase 2; docs/cloud-sync.md). Server mode only; the desktop app keeps
 * "authenticate Claude Code in your terminal".
 *
 * The official CLI owns the login: LearnHarness runs `claude auth login`
 * with plain pipes (verified on a headless VPS: it prints
 * "If the browser didn't open, visit: <link>", then reads one line at
 * "Paste code here if prompted >", then prints "Login successful."), relays
 * the link through a one-use redirect, and writes the learner's code to it.
 * It never stores the code or any token; the CLI keeps its own credentials
 * (in the container: /data/home/.claude, which the agents' file tools refuse).
 *
 * One attempt at a time, 10-minute limit. Disconnect = `claude auth logout`.
 * State lives on globalThis so every route bundle shares one attempt.
 */

import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { externalCliEnv } from "../core/auth-env.ts";
import { getClaudeBinary } from "../agent/claude-code/binary.ts";

export const CLAUDE_LOGIN_LIMIT_MS = 10 * 60 * 1000;
const LINK_WAIT_MS = 60 * 1000;
const VERIFY_WAIT_MS = 60 * 1000;
const MAX_OUTPUT = 64 * 1024;
const LINK = /https:\/\/[^\s"'<>]+\/oauth\/authorize\?[^\s"'<>]+/;
const SUCCESS = /Login successful/i;
const INVALID = /Invalid code/i;

export type ClaudeLoginPhase = "idle" | "starting" | "waiting" | "verifying" | "done" | "failed";

export interface ClaudeLoginView {
	phase: ClaudeLoginPhase;
	attemptId: string | null;
	expiresAt: number | null;
	/** One-use same-origin redirect to Claude's sign-in page, while waiting and unused. */
	openPath: string | null;
	error: string | null;
}

interface Attempt {
	id: string;
	child: ChildProcessWithoutNullStreams;
	phase: ClaudeLoginPhase;
	link: string | null;
	linkToken: string | null;
	expiresAt: number;
	output: string;
	error: string | null;
	timers: ReturnType<typeof setTimeout>[];
}

export interface ClaudeLoginDeps {
	binary: () => string | null;
	spawn: (binary: string, args: string[]) => ChildProcessWithoutNullStreams;
	run: (binary: string, args: string[]) => Promise<{ code: number | null; stdout: string }>;
	now: () => number;
}

const defaultDeps: ClaudeLoginDeps = {
	binary: getClaudeBinary,
	spawn: (binary, args) => spawn(binary, args, {
		cwd: tmpdir(),
		// No browser on a server: the CLI falls back to printing the link.
		env: { ...externalCliEnv(), BROWSER: "/bin/false" },
		stdio: "pipe",
		windowsHide: true,
	}),
	run: (binary, args) => new Promise((resolve) => {
		execFile(binary, args, { cwd: tmpdir(), env: externalCliEnv(), timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true },
			(error, stdout) => resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout) }));
	}),
	now: Date.now,
};

export function createClaudeLogin(deps: ClaudeLoginDeps = defaultDeps) {
	let attempt: Attempt | null = null;
	let last: { phase: ClaudeLoginPhase; error: string | null } = { phase: "idle", error: null };

	function end(a: Attempt, phase: "done" | "failed" | "idle", error: string | null = null) {
		if (attempt !== a) return;
		a.timers.forEach(clearTimeout);
		a.phase = phase;
		a.error = error;
		last = { phase, error };
		attempt = null;
		if (a.child.exitCode === null && !a.child.killed) a.child.kill();
	}

	function view(): ClaudeLoginView {
		const a = attempt;
		if (!a) return { phase: last.phase, attemptId: null, expiresAt: null, openPath: null, error: last.error };
		return {
			phase: a.phase,
			attemptId: a.id,
			expiresAt: a.expiresAt,
			openPath: a.phase === "waiting" && a.linkToken ? `/api/claude-code/login/open?id=${a.linkToken}` : null,
			error: a.error,
		};
	}

	function start(): ClaudeLoginView {
		if (attempt) end(attempt, "idle");
		const binary = deps.binary();
		if (!binary) {
			last = { phase: "failed", error: "Claude Code isn't installed on this server yet. It installs itself when the server starts; try again in a minute." };
			return view();
		}
		let child: ChildProcessWithoutNullStreams;
		try {
			child = deps.spawn(binary, ["auth", "login", "--claudeai"]);
		} catch {
			last = { phase: "failed", error: "Claude Code couldn't be started on this server." };
			return view();
		}
		const a: Attempt = { id: randomUUID(), child, phase: "starting", link: null, linkToken: null, expiresAt: deps.now() + CLAUDE_LOGIN_LIMIT_MS, output: "", error: null, timers: [] };
		attempt = a;
		const onData = (chunk: Buffer) => {
			if (attempt !== a) return;
			a.output = (a.output + chunk.toString("utf8")).slice(-MAX_OUTPUT);
			if (a.phase === "starting") {
				const match = LINK.exec(a.output);
				if (match) { a.link = match[0]; a.linkToken = randomUUID(); a.phase = "waiting"; }
			}
			if (a.phase === "verifying") {
				if (SUCCESS.test(a.output)) end(a, "done");
				else if (INVALID.test(a.output)) end(a, "failed", "Claude didn't accept that code. Press Sign in to Claude and try again, copying the whole code.");
			}
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		child.on("error", () => end(a, "failed", "Claude Code couldn't be started on this server."));
		child.on("exit", (code) => {
			if (attempt !== a) return;
			if (code === 0 && (a.phase === "verifying" || SUCCESS.test(a.output))) end(a, "done");
			else end(a, "failed", a.phase === "starting"
				? "Claude Code stopped before showing a sign-in link. Try again; if it keeps happening, check the server log."
				: "The sign-in didn't finish. Press Sign in to Claude and try again.");
		});
		a.timers.push(setTimeout(() => { if (a.phase === "starting") end(a, "failed", "Claude Code didn't show a sign-in link. Try again in a minute."); }, LINK_WAIT_MS));
		a.timers.push(setTimeout(() => end(a, "failed", "The sign-in timed out after 10 minutes. Press Sign in to Claude to start again."), CLAUDE_LOGIN_LIMIT_MS));
		return view();
	}

	/** The redirect target for a one-use link token, or null. */
	function takeLink(token: string): string | null {
		const a = attempt;
		if (!a || a.phase !== "waiting" || !a.linkToken || a.linkToken !== token || !a.link) return null;
		a.linkToken = null;
		return a.link;
	}

	function submitCode(attemptId: unknown, code: unknown): ClaudeLoginView | { error: string } {
		const a = attempt;
		if (!a || a.id !== attemptId) return { error: "This sign-in attempt has ended. Press Sign in to Claude to start again." };
		if (a.phase !== "waiting") return { error: "Open the Claude sign-in link first." };
		const value = typeof code === "string" ? code.trim() : "";
		if (!value || value.length > 4096 || /[\r\n\0]/.test(value)) return { error: "Paste the code Claude showed you after you authorized the connection." };
		a.phase = "verifying";
		a.output = ""; // judge only what the CLI says after the code
		a.child.stdin.write(`${value}\n`);
		a.timers.push(setTimeout(() => { if (a.phase === "verifying") end(a, "failed", "Claude Code didn't confirm the sign-in. Press Sign in to Claude and try again."); }, VERIFY_WAIT_MS));
		return view();
	}

	function cancel(): ClaudeLoginView {
		if (attempt) end(attempt, "idle");
		last = { phase: "idle", error: null };
		return view();
	}

	/** Whether the server's Claude Code is signed in (`claude auth status --json`). */
	async function signedIn(): Promise<boolean | null> {
		const binary = deps.binary();
		if (!binary) return null;
		const { code, stdout } = await deps.run(binary, ["auth", "status", "--json"]);
		try {
			const parsed = JSON.parse(stdout) as { loggedIn?: unknown };
			return parsed.loggedIn === true;
		} catch {
			return code === 0 ? null : false;
		}
	}

	async function logout(): Promise<boolean> {
		if (attempt) end(attempt, "idle");
		last = { phase: "idle", error: null };
		const binary = deps.binary();
		if (!binary) return false;
		const { code } = await deps.run(binary, ["auth", "logout"]);
		return code === 0;
	}

	return { start, view, takeLink, submitCode, cancel, signedIn, logout };
}

const KEY = Symbol.for("lh.claudeLogin");
export function claudeLogin(): ReturnType<typeof createClaudeLogin> {
	const g = globalThis as typeof globalThis & { [KEY]?: ReturnType<typeof createClaudeLogin> };
	return g[KEY] ??= createClaudeLogin();
}
