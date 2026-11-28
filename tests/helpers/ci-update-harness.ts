import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A stand-in server for deploy/ci-update.sh: a bare "origin", a checkout in a
// folder whose name has a space, a stub update.sh and a stub curl, and a HOME
// of its own. The script is run for real (sh), detached work and all.

const root = path.join(import.meta.dirname, "..", "..");
export const realScript = fs.readFileSync(path.join(root, "deploy", "ci-update.sh"), "utf8");

export const haveGit = spawnSync("git", ["--version"]).status === 0;

const gitEnv = {
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.invalid",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.invalid",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
};
export const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: { ...process.env, ...gitEnv }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const stubUpdate = `#!/bin/sh
mkdir -p "$HOME/stub"
echo run >> "$HOME/stub/update-calls"
: > "$HOME/stub/update-started"
if [ -f "$HOME/stub/update-sleep" ]; then sleep "$(cat "$HOME/stub/update-sleep")"; fi
: > "$HOME/stub/update-done"
if [ -f "$HOME/stub/update-fail" ]; then exit 1; fi
exit 0
`;

// Answers the status code in $HOME/stub/curl-code (default 200) and records
// what it was asked.
const stubCurl = `#!/bin/sh
mkdir -p "$HOME/stub"
echo "$*" >> "$HOME/stub/curl-calls"
if [ -f "$HOME/stub/curl-code" ]; then printf '%s' "$(cat "$HOME/stub/curl-code")"; else printf 200; fi
exit 0
`;

export type Sandbox = ReturnType<typeof makeSandbox>;

export function makeSandbox(options: { script?: string; domain?: string | null } = {}) {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ci-update-"));
	const home = path.join(base, "home");
	const bin = path.join(base, "bin");
	const origin = path.join(base, "origin.git");
	const pusher = path.join(base, "pusher");
	const checkout = path.join(base, "my checkout"); // a space on purpose
	for (const dir of [home, bin]) fs.mkdirSync(dir);
	fs.writeFileSync(path.join(bin, "curl"), stubCurl, { mode: 0o755 });

	git(base, "init", "--bare", "-b", "main", origin);
	git(base, "clone", "-q", origin, pusher);
	git(pusher, "checkout", "-q", "-b", "main");
	fs.mkdirSync(path.join(pusher, "deploy"));
	fs.writeFileSync(path.join(pusher, "deploy", "ci-update.sh"), options.script ?? realScript, { mode: 0o755 });
	fs.writeFileSync(path.join(pusher, "deploy", "update.sh"), stubUpdate, { mode: 0o755 });
	fs.writeFileSync(path.join(pusher, "README"), "one\n");
	git(pusher, "add", "-A");
	git(pusher, "commit", "-q", "-m", "first");
	git(pusher, "push", "-q", "origin", "main");
	git(base, "clone", "-q", "-b", "main", origin, checkout);
	if (options.domain !== null) fs.writeFileSync(path.join(checkout, "deploy", ".env"), `LH_SECRET=do-not-print\nLH_DOMAIN=${options.domain ?? "learn.example.invalid"}\n`);

	const scriptPath = path.join(checkout, "deploy", "ci-update.sh");
	const env = (extra: Record<string, string> = {}) =>
		({
			PATH: `${bin}:${process.env.PATH}`,
			HOME: home,
			LH_CI_POLL: "0.1",
			LH_CI_SITE_WAIT_SECONDS: "2",
			LH_CI_SITE_INTERVAL: "1",
			LH_CI_LOCK_WAIT_SECONDS: "20",
			LH_CI_WAIT_SECONDS: "60",
			...extra,
		}) as unknown as NodeJS.ProcessEnv;
	const stub = (name: string) => path.join(home, "stub", name);
	const setStub = (name: string, content: string) => {
		fs.mkdirSync(path.join(home, "stub"), { recursive: true });
		fs.writeFileSync(stub(name), content);
	};
	const calls = (name: string) => (fs.existsSync(stub(name)) ? fs.readFileSync(stub(name), "utf8").split("\n").filter(Boolean) : []);
	const run = (extra: Record<string, string> = {}) => {
		const r = spawnSync("sh", [scriptPath, "ignored", "arguments"], { cwd: base, env: env(extra), encoding: "utf8", timeout: 90_000 });
		return { status: r.status, stdout: r.stdout, stderr: r.stderr, lines: r.stdout.split("\n").filter(Boolean) };
	};
	/** Starts a run without waiting; resolves when the front has exited. */
	const start = (extra: Record<string, string> = {}) => {
		const child = spawn("sh", [scriptPath], { cwd: base, env: env(extra), stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		child.stdout!.on("data", (d) => (stdout += d));
		const done = new Promise<{ status: number | null; stdout: string; lines: string[] }>((resolve) => child.on("close", (status) => resolve({ status, stdout, lines: stdout.split("\n").filter(Boolean) })));
		return { child: child as ChildProcess, done };
	};
	/** A commit on origin, made through the other clone. */
	const push = (files: Record<string, string>, message = "next") => {
		git(pusher, "pull", "-q", "--ff-only", "origin", "main");
		for (const [file, content] of Object.entries(files)) {
			fs.mkdirSync(path.dirname(path.join(pusher, file)), { recursive: true });
			fs.writeFileSync(path.join(pusher, file), content, { mode: file.endsWith(".sh") ? 0o755 : 0o644 });
		}
		git(pusher, "add", "-A");
		git(pusher, "commit", "-q", "-m", message);
		git(pusher, "push", "-q", "origin", "main");
	};
	const lockDir = path.join(home, ".lh-ci-update.lock");
	/** Another run's lock, taken `ageSeconds` ago. */
	const holdLock = (ageSeconds: number) => {
		fs.mkdirSync(lockDir);
		fs.writeFileSync(path.join(lockDir, "owner"), "999999\n");
		fs.writeFileSync(path.join(lockDir, "since"), `${Math.floor(Date.now() / 1000) - ageSeconds}\n`);
	};
	const cleanup = () => fs.rmSync(base, { recursive: true, force: true });
	return { base, home, checkout, scriptPath, lockDir, stub, setStub, calls, run, start, push, holdLock, git: (...a: string[]) => git(checkout, ...a), cleanup };
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until(condition: () => boolean, ms = 10_000) {
	const end = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > end) throw new Error("timed out waiting");
		await sleep(50);
	}
}
