/**
 * `lh-gateway reset-owner` (the image's `reset-password` where a gateway
 * runs): the owner's last way back in. Every session of the owner's account
 * ends, the lockouts are cleared, and a reset code for the owner (once, 24
 * hours) is printed to the command's own output, for the site's "Forgot your
 * password?" page. With no owner yet, a fresh setup code, as at first start.
 *
 * The state file has one writer: the running gateway. So the command asks it
 * through a control route on its own port, accepted only from loopback (the
 * command runs in the gateway's container: `docker compose exec gateway
 * reset-password`) and never with a forwarding header (Caddy always adds
 * one, and never connects from loopback). Only when nothing listens on the
 * port does the command change the file itself. The code is in the answer to
 * the command, never in the gateway's log.
 */

import { resetOwnerAccess } from "../src/core/accounts.ts";
import { DEFAULT_PORT } from "./config.ts";
import { json, type RouteDeps } from "./routes.ts";
import { createStore, StateDamagedError, type GatewayStore } from "./state.ts";

export const CONTROL_PATH = "/control/reset-owner";
/** Sent by the command; a plain cross-site form can't send it. */
export const CONTROL_HEADER = "x-lh-control";
const FORWARDING_HEADERS = ["x-forwarded-for", "forwarded", "x-real-ip", "x-forwarded-host", "x-forwarded-proto"];
const CONTROL_TIMEOUT_MS = 15_000;

export function isLoopback(address: string | undefined | null): boolean {
	if (!address) return false;
	const plain = address.startsWith("::ffff:") ? address.slice(7) : address;
	return plain === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(plain);
}

export type OwnerResetAnswer = { kind: "reset"; name: string; code: string; expiresAt: number } | { kind: "setup"; code: string };

/** The change itself, through the one store. */
export function applyOwnerReset(store: GatewayStore, now: number): OwnerResetAnswer {
	return store.update((state) => {
		const r = resetOwnerAccess(state, now);
		return { state: r.state, result: r.kind === "reset" ? { kind: "reset", name: r.name, code: r.code, expiresAt: r.expiresAt } : { kind: "setup", code: r.code } };
	});
}

/** POST /control/reset-owner on the gateway's listener. Anything else about it is a plain 404. */
export async function controlRoute(request: Request, deps: Pick<RouteDeps, "store" | "now">, remoteAddress: string | undefined): Promise<Response> {
	if (!isLoopback(remoteAddress) || FORWARDING_HEADERS.some((h) => request.headers.has(h))) return json({ error: "Not found." }, 404);
	if (request.method !== "POST" || request.headers.get(CONTROL_HEADER) !== "1") return json({ error: "Not found." }, 404);
	try {
		return json(applyOwnerReset(deps.store, deps.now()));
	} catch (error) {
		if (error instanceof StateDamagedError) return json({ code: "damaged" }, 503);
		return json({ code: "failed" }, 500);
	}
}

/** The command's lines (in the style of scripts/server-reset-password.mjs). */
export function ownerResetLines(answer: OwnerResetAnswer): string[] {
	if (answer.kind === "setup") {
		return [
			"No password is set yet.",
			`Setup code: ${answer.code}`,
			"Open the site, enter this code and choose a password.",
		];
	}
	return [
		`Every device of ${answer.name} signed out.`,
		`Reset code: ${answer.code}`,
		`Open the site's "Forgot your password?" page and enter ${answer.name}, this code and a new password. The code works once, for 24 hours.`,
	];
}

const refused = (error: unknown): boolean => {
	const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
	return cause?.code === "ECONNREFUSED";
};

export interface CommandIo {
	env?: Record<string, string | undefined>;
	out?: (line: string) => void;
	err?: (line: string) => void;
	fetchImpl?: typeof fetch;
	now?: () => number;
}

export async function resetOwnerCommand(io: CommandIo = {}): Promise<number> {
	const env = io.env ?? process.env;
	const out = io.out ?? ((line: string) => console.log(line));
	const err = io.err ?? ((line: string) => console.error(line));
	const fetchImpl = io.fetchImpl ?? fetch;
	const now = io.now ?? Date.now;
	const file = env.LH_GATEWAY_FILE?.trim();
	if (!file) {
		err("lh-gateway reset-owner: LH_GATEWAY_FILE is not set.");
		return 1;
	}
	const portText = env.PORT?.trim();
	const port = portText ? Number(portText) : DEFAULT_PORT;
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		err("lh-gateway reset-owner: PORT is not a valid port.");
		return 1;
	}

	let answer: OwnerResetAnswer;
	try {
		const response = await fetchImpl(`http://127.0.0.1:${port}${CONTROL_PATH}`, {
			method: "POST",
			headers: { [CONTROL_HEADER]: "1", "content-type": "application/json" },
			body: "{}",
			redirect: "manual",
			signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
		});
		if (!response.ok) {
			const body = await response.json().catch(() => null) as { code?: unknown } | null;
			err(body?.code === "damaged" ? "The gateway's state file is damaged. Nothing was changed." : "The running gateway couldn't make the change. Nothing was changed.");
			return 1;
		}
		answer = await response.json() as OwnerResetAnswer;
	} catch (error) {
		if (!refused(error)) {
			err("The running gateway didn't answer. Nothing was changed.");
			return 1;
		}
		// Nothing listens: the gateway is stopped, so this process is the only writer.
		try {
			answer = applyOwnerReset(createStore(file), now());
		} catch (fileError) {
			err(fileError instanceof StateDamagedError ? "The gateway's state file is damaged. Nothing was changed." : "The gateway's state file couldn't be written. Nothing was changed.");
			return 1;
		}
	}
	for (const line of ownerResetLines(answer)) out(line);
	return 0;
}
