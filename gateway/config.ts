/**
 * The gateway's settings, from the environment (docs/fork/plans/multi-account-build.md
 * "Environment variables"). Refuses to start without the ones it can't work
 * without; a refusal names the variable, never its value.
 */

export const GATE_SECRET_MIN_LENGTH = 32;
export const DEFAULT_PORT = 9000;
export const DEFAULT_MAX_ACCOUNTS = 4;

export interface GatewayConfig {
	port: number;
	/** The state file (LH_GATEWAY_FILE). */
	stateFile: string;
	/** The cap, the owner's account included (at least 1). */
	maxAccounts: number;
	/** The owner's copy ("lh:3000") and its gate secret. */
	ownerUpstream: string;
	ownerGateSecret: string;
	/** Caddy's internal relay to a copy, and its token. */
	relayUrl: string;
	relayToken: string;
	/** The maker (LH_MAKER_URL, LH_MAKER_TOKEN); without them no copy can be made (invites answer 503). */
	makerUrl: string | null;
	makerToken: string | null;
	/** LH_TRUST_PROXY=1: the client's address is the last X-Forwarded-For entry. */
	trustProxy: boolean;
}

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

const UPSTREAM = /^[A-Za-z0-9.-]+:\d{1,5}$/;

function required(env: Env, name: string): string {
	const value = env[name];
	if (typeof value !== "string" || value.trim() === "") throw new ConfigError(`${name} is not set.`);
	return value.trim();
}

function optional(env: Env, name: string): string | null {
	const value = env[name];
	return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function httpUrl(name: string, value: string): string {
	let url: URL;
	try { url = new URL(value); } catch { throw new ConfigError(`${name} is not a valid address.`); }
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new ConfigError(`${name} is not a valid address.`);
	return url.origin;
}

export function loadConfig(env: Env = process.env): GatewayConfig {
	const portText = optional(env, "PORT");
	const port = portText === null ? DEFAULT_PORT : Number(portText);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError("PORT is not a valid port.");
	const capText = optional(env, "LH_MAX_ACCOUNTS");
	const maxAccounts = capText === null ? DEFAULT_MAX_ACCOUNTS : Number(capText);
	if (!Number.isInteger(maxAccounts) || maxAccounts < 1) throw new ConfigError("LH_MAX_ACCOUNTS must be a whole number of at least 1.");
	const stateFile = required(env, "LH_GATEWAY_FILE");
	const ownerUpstream = required(env, "LH_OWNER_UPSTREAM");
	if (!UPSTREAM.test(ownerUpstream)) throw new ConfigError("LH_OWNER_UPSTREAM must be host:port.");
	const ownerGateSecret = required(env, "LH_OWNER_GATE_SECRET");
	if (ownerGateSecret.length < GATE_SECRET_MIN_LENGTH) throw new ConfigError(`LH_OWNER_GATE_SECRET must be at least ${GATE_SECRET_MIN_LENGTH} characters.`);
	const relayUrl = httpUrl("LH_RELAY_URL", required(env, "LH_RELAY_URL"));
	const relayToken = required(env, "LH_RELAY_TOKEN");
	if (relayToken.length < GATE_SECRET_MIN_LENGTH) throw new ConfigError(`LH_RELAY_TOKEN must be at least ${GATE_SECRET_MIN_LENGTH} characters.`);
	const makerUrlText = optional(env, "LH_MAKER_URL");
	return {
		port, stateFile, maxAccounts, ownerUpstream, ownerGateSecret, relayUrl, relayToken,
		makerUrl: makerUrlText === null ? null : httpUrl("LH_MAKER_URL", makerUrlText),
		makerToken: optional(env, "LH_MAKER_TOKEN"),
		trustProxy: env.LH_TRUST_PROXY === "1",
	};
}
