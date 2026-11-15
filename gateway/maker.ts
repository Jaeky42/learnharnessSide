/**
 * The maker (multi-account plan, slice 3a; docs/multi-account-plan.md "The
 * pieces", docs/multi-account-build.md "The maker's API"). The only program
 * with the Docker socket. It builds every account's container from ONE fixed
 * template: a caller can name a tag and nothing else; no image, mount,
 * command, environment or name from a request ever reaches Docker.
 *
 * Calls (Bearer LH_MAKER_TOKEN; internal network only):
 *   POST   /copies {tag, start?} network + volume + container, Caddy joined, started
 *                               (unless `start` is literally false)
 *   POST   /copies/<tag>/stop   pause
 *   POST   /copies/<tag>/start  resume
 *   DELETE /copies/<tag>        container and network go; the volume stays
 *   DELETE /volumes/<tag>       the final deletion (409 while a container uses it)
 *   GET    /copies              [{tag, state, image, upToDate}]
 *   POST   /reconcile           every copy onto the current image; Caddy on every network
 *
 * A copy is moved onto a new container (a new image, or a new secret) by a
 * swap that can be cut off at any instant and finished later: the old
 * container is renamed `lh-acct-<tag>-old-running` / `-old-stopped` (its state
 * in its name), stopped, the successor is created on the same volume, started
 * when it should run, and only then is the old one removed. Every pass, and
 * every call for a tag, first finishes such a leftover (`settle`).
 *
 * Imports nothing from src/: it is bundled on its own (scripts/build-gateway.mjs).
 * This file never starts itself; `maker-main.ts` is the program's entry.
 */
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import os from "node:os";
import { DockerClient, DockerError, type ContainerInspect } from "./docker.ts";

// ─── Limits on a copy (first values the owner approved; tune on the real server) ─

/** Memory ceiling per copy: 1 GiB. */
export const COPY_MEMORY_BYTES = 1024 * 1024 * 1024;
/** Memory plus swap in total: as much again in swap (2 GiB). */
export const COPY_MEMORY_SWAP_BYTES = 2 * COPY_MEMORY_BYTES;
/** CPU by share, equal for every copy (Docker's default weight). */
export const COPY_CPU_SHARES = 1024;
export const COPY_PIDS_LIMIT = 512;
/** "helpers at once" seeded into a new volume (the entrypoint reads it). */
export const SEED_WORKER_CONCURRENCY = "3";
/** Where the image keeps its data (Dockerfile: VOLUME /data). */
export const COPY_DATA_PATH = "/data";
export const COPY_PORT = 3000;
/** The image's own user (Dockerfile: USER node); pinned so a copy never runs as root. */
export const COPY_USER = "node";

export const MAKER_PORT = 9100;
export const MAX_BODY_BYTES = 512;
export const MIN_TOKEN_LENGTH = 32;
export const DEFAULT_DOCKER_SOCKET = "/var/run/docker.sock";
/** After SIGTERM the maker waits this long for work in progress (compose gives it 120 s). */
export const SHUTDOWN_WAIT_MS = 100_000;
/** A copy's logs: at most 3 files of 10 MB. */
export const COPY_LOG_CONFIG = { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } };

/** The setup code's alphabet (src/core/server-auth.ts CODE_ALPHABET; a test keeps them equal). */
export const TAG_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TAG_RE = new RegExp(`^[${TAG_ALPHABET}]{3}$`);
const COPY_NAME_RE = new RegExp(`^/?lh-acct-([${TAG_ALPHABET}]{3})$`);
const OLD_NAME_RE = new RegExp(`^/?lh-acct-([${TAG_ALPHABET}]{3})-old-(running|stopped)$`);
const NETWORK_NAME_RE = new RegExp(`^lh-acct-([${TAG_ALPHABET}]{3})-net$`);
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
const TIME_ZONE_RE = /^[A-Za-z0-9_+\-/:]{1,64}$/;
const MANAGED_LABEL = "lh.managed";
const TAG_LABEL = "lh.account.tag";

export function isTag(value: unknown): value is string {
	return typeof value === "string" && TAG_RE.test(value);
}

export const containerName = (tag: string) => `lh-acct-${tag}`;
export const networkName = (tag: string) => `lh-acct-${tag}-net`;
export const volumeName = (tag: string) => `lh-acct-${tag}-data`;
export const upstreamOf = (tag: string) => `${containerName(tag)}:${COPY_PORT}`;
/** The name a container carries while it is being replaced, with its state before the swap. */
export const oldName = (tag: string, wasRunning: boolean) => `lh-acct-${tag}-old-${wasRunning ? "running" : "stopped"}`;

/** The tag of a copy's own container name; null for anything else (an `-old-*` one included). */
export function copyTagOf(name: string): string | null {
	return COPY_NAME_RE.exec(name)?.[1] ?? null;
}

/** The tag and earlier state of a container left by a swap; null for anything else. */
export function oldTagOf(name: string): { tag: string; wasRunning: boolean } | null {
	const match = OLD_NAME_RE.exec(name);
	return match?.[1] ? { tag: match[1], wasRunning: match[2] === "running" } : null;
}

/** 32 random bytes as base64url (43 characters): the copy's LH_GATE_SECRET. */
export function newGateSecret(): string {
	return randomBytes(32).toString("base64url");
}

function labels(tag: string): Record<string, string> {
	return { [TAG_LABEL]: tag, [MANAGED_LABEL]: "1" };
}

export interface TemplateInput {
	tag: string;
	image: string;
	gateSecret: string;
	timeZone: string | null;
}

/** The ONE container template. Everything in it is fixed or derived from a checked tag. */
export function copyTemplate({ tag, image, gateSecret, timeZone }: TemplateInput): Record<string, unknown> {
	if (!isTag(tag)) throw new Error("bad tag");
	if (!SECRET_RE.test(gateSecret)) throw new Error("bad secret");
	const network = networkName(tag);
	const env = [
		`LH_GATE_SECRET=${gateSecret}`,
		`LH_ACCOUNT_TAG=${tag}`,
		`LH_SEED_WORKER_CONCURRENCY=${SEED_WORKER_CONCURRENCY}`,
		"LH_TRUST_PROXY=1",
	];
	if (timeZone) env.push(`TZ=${timeZone}`);
	return {
		Image: image,
		User: COPY_USER,
		Env: env,
		Labels: labels(tag),
		HostConfig: {
			Mounts: [{ Type: "volume", Source: volumeName(tag), Target: COPY_DATA_PATH }],
			Memory: COPY_MEMORY_BYTES,
			MemorySwap: COPY_MEMORY_SWAP_BYTES,
			CpuShares: COPY_CPU_SHARES,
			PidsLimit: COPY_PIDS_LIMIT,
			CapDrop: ["ALL"],
			SecurityOpt: ["no-new-privileges"],
			RestartPolicy: { Name: "unless-stopped" },
			Privileged: false,
			PublishAllPorts: false,
			Init: true,
			LogConfig: COPY_LOG_CONFIG,
			NetworkMode: network,
		},
		NetworkingConfig: { EndpointsConfig: { [network]: {} } },
	};
}

// ─── Configuration ───────────────────────────────────────────────────────────

export interface MakerConfig {
	token: string;
	/** LH_IMAGE, or null: the maker's own container's image (found by `selfId`). */
	image: string | null;
	/** The maker's own container (Docker sets the hostname to the short container id). */
	selfId: string;
	caddyContainer: string;
	timeZone: string | null;
}

/** The config, or the reason the maker refuses to start (never naming a value). */
export function readMakerConfig(env: Record<string, string | undefined>, hostname = os.hostname()): MakerConfig | { error: string } {
	const token = env.LH_MAKER_TOKEN ?? "";
	if (token.length < MIN_TOKEN_LENGTH) return { error: `LH_MAKER_TOKEN is missing or shorter than ${MIN_TOKEN_LENGTH} characters` };
	const caddyContainer = (env.LH_CADDY_CONTAINER ?? "").trim();
	if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(caddyContainer)) return { error: "LH_CADDY_CONTAINER is missing or not a container name" };
	const image = (env.LH_IMAGE ?? "").trim() || null;
	const tz = (env.TZ ?? "").trim();
	return { token, image, selfId: hostname, caddyContainer, timeZone: TIME_ZONE_RE.test(tz) ? tz : null };
}

// ─── Errors and logging ──────────────────────────────────────────────────────

/** A failure of the maker's own with a short code (answered as 502). */
export class MakerFailure extends Error {
	constructor(readonly code: string) {
		super(code);
	}
}

/** Long tokens (secrets, the maker token, ids) never reach a log line. */
export function redact(text: string): string {
	return text.replace(/[A-Za-z0-9_+/=-]{32,}/g, "[redacted]").replace(/\s+/g, " ").slice(0, 200);
}

function describe(error: unknown): string {
	if (error instanceof DockerError) {
		const detail = error.detail ? `: ${redact(error.detail)}` : "";
		return `${error.code}${error.status === null ? "" : ` ${error.status}`}${detail}`;
	}
	if (error instanceof MakerFailure) return error.code;
	return "internal error";
}

export type Log = (line: string) => void;

// ─── The maker ───────────────────────────────────────────────────────────────

export interface MakerAnswer {
	status: number;
	body: unknown;
	headers?: Record<string, string>;
}

export interface CopySummary {
	tag: string;
	state: string;
	image: string;
	upToDate: boolean;
}

export interface ReconcileResult {
	/** Copies whose interrupted swap was finished. */
	recovered: string[];
	updated: string[];
	failed: string[];
	unchanged: number;
}

const json = (status: number, body: unknown, headers?: Record<string, string>): MakerAnswer => ({ status, body, headers });
const code = (status: number, c: string, headers?: Record<string, string>) => json(status, { code: c }, headers);

function envValue(env: string[] | null | undefined, key: string): string | null {
	for (const entry of env ?? []) if (entry.startsWith(`${key}=`)) return entry.slice(key.length + 1);
	return null;
}

function isRunning(container: ContainerInspect): boolean {
	return container.State.Running || container.State.Restarting === true || container.State.Status === "running" || container.State.Status === "restarting";
}


export class Maker {
	private readonly chains = new Map<string, Promise<unknown>>();
	private reconciling: Promise<ReconcileResult> | null = null;
	private closing = false;

	constructor(
		readonly config: MakerConfig,
		private readonly docker: DockerClient,
		private readonly log: Log = (line) => console.log(line),
	) {}

	private say(action: string, tag: string | null, outcome: string) {
		this.log(`[LearnHarness] maker: ${action}${tag ? ` ${tag}` : ""}: ${outcome}`);
	}

	/** Constant-time check of `Authorization: Bearer <token>`. */
	authorized(header: string | string[] | undefined): boolean {
		if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
		const given = createHash("sha256").update(header.slice(7), "utf8").digest();
		const wanted = createHash("sha256").update(this.config.token, "utf8").digest();
		return timingSafeEqual(given, wanted);
	}

	/** Calls for one tag run one after another; none starts once shutdown has begun. */
	private serial<T>(tag: string, work: () => Promise<T>): Promise<T> {
		const guarded = () => (this.closing ? Promise.reject(new MakerFailure("shutting_down")) : work());
		const previous = this.chains.get(tag) ?? Promise.resolve();
		const run = previous.then(guarded, guarded);
		const tail = run.then(
			() => undefined,
			() => undefined,
		);
		this.chains.set(tag, tail);
		void tail.then(() => {
			if (this.chains.get(tag) === tail) this.chains.delete(tag);
		});
		return run;
	}

	/** Refuse new work, then wait for the running pass and every tag's work to end. */
	async shutdown(): Promise<void> {
		this.closing = true;
		while (this.reconciling || this.chains.size > 0) {
			await Promise.allSettled([this.reconciling, ...this.chains.values()]);
		}
	}

	/** The image id every copy should run. */
	async currentImage(): Promise<string> {
		if (this.config.image) {
			const image = await this.docker.inspectImage(this.config.image);
			if (!image?.Id) throw new MakerFailure("no_image");
			return image.Id;
		}
		const self = await this.docker.inspectContainer(this.config.selfId);
		if (!self?.Image) throw new MakerFailure("no_image");
		return self.Image;
	}

	private async ensureNetwork(tag: string) {
		const name = networkName(tag);
		const found = await this.docker.inspectNetwork(name);
		if (found) {
			if (found.Name !== name) throw new MakerFailure("name_clash");
			return;
		}
		await this.docker.createNetwork({ Name: name, Driver: "bridge", Internal: false, Attachable: false, EnableIPv6: false, Labels: labels(tag) });
	}

	private async ensureVolume(tag: string) {
		const name = volumeName(tag);
		const found = await this.docker.inspectVolume(name);
		if (found) {
			if (found.Name !== name) throw new MakerFailure("name_clash");
			return;
		}
		await this.docker.createVolume({ Name: name, Driver: "local", Labels: labels(tag) });
	}

	/** The container of this exact name, or null; never another that a lookup by prefix might find. */
	private async findNamed(name: string): Promise<ContainerInspect | null> {
		const found = await this.docker.inspectContainer(name);
		if (!found) return null;
		if (found.Name !== `/${name}`) throw new MakerFailure("name_clash");
		return found;
	}

	private findCopy(tag: string) {
		return this.findNamed(containerName(tag));
	}

	/** Containers an interrupted swap left for this tag. */
	private async findOld(tag: string): Promise<Array<{ container: ContainerInspect; wasRunning: boolean }>> {
		const left: Array<{ container: ContainerInspect; wasRunning: boolean }> = [];
		for (const wasRunning of [true, false]) {
			const container = await this.findNamed(oldName(tag, wasRunning));
			if (container) left.push({ container, wasRunning });
		}
		return left;
	}

	/** Caddy on the account's network (it loses extra networks when it is re-created). */
	private async ensureCaddy(network: string) {
		const caddy = await this.docker.inspectContainer(this.config.caddyContainer);
		if (!caddy) throw new MakerFailure("no_caddy");
		if (caddy.NetworkSettings?.Networks?.[network]) return false;
		try {
			await this.docker.connectNetwork(network, this.config.caddyContainer);
		} catch (error) {
			const again = await this.docker.inspectContainer(this.config.caddyContainer);
			if (again?.NetworkSettings?.Networks?.[network]) return false;
			throw error;
		}
		return true;
	}

	/** Caddy off the network, only when it is on it (Docker refuses a disconnect that isn't). */
	private async detachCaddy(network: string) {
		const caddy = await this.docker.inspectContainer(this.config.caddyContainer);
		if (!caddy?.NetworkSettings?.Networks?.[network]) return;
		await this.docker.disconnectNetwork(network, this.config.caddyContainer);
	}

	/** A graceful stop first, then removal (the named volume is never removed with it). */
	private async dropContainer(found: ContainerInspect) {
		await this.docker.stopContainer(found.Id);
		await this.docker.removeContainer(found.Id);
	}

	/** The successor from the template, Caddy joined, started when it should run. */
	private async build(tag: string, image: string, gateSecret: string, start: boolean) {
		await this.docker.createContainer(containerName(tag), copyTemplate({ tag, image, gateSecret, timeZone: this.config.timeZone }));
		await this.ensureCaddy(networkName(tag));
		if (start) await this.docker.startContainer(containerName(tag));
	}

	/**
	 * Finish a swap that was cut off. With a successor: stop the old one, start
	 * the successor if the old one had been running, remove the old one. Without:
	 * stop the old one, build the successor with the old one's secret (on the
	 * current image), start it if the old one had been running, remove the old one.
	 */
	private async settle(tag: string): Promise<boolean> {
		const left = await this.findOld(tag);
		for (const { container: old, wasRunning } of left) {
			const successor = await this.findCopy(tag);
			await this.docker.stopContainer(old.Id);
			if (successor) {
				if (wasRunning && !isRunning(successor)) {
					await this.ensureCaddy(networkName(tag));
					await this.docker.startContainer(successor.Id);
				}
			} else {
				if (old.Config.Labels?.[TAG_LABEL] !== tag) throw new MakerFailure("bad_label");
				const gateSecret = envValue(old.Config.Env, "LH_GATE_SECRET");
				if (!gateSecret || !SECRET_RE.test(gateSecret)) throw new MakerFailure("no_secret");
				const image = await this.currentImage();
				await this.ensureNetwork(tag);
				await this.ensureVolume(tag);
				await this.build(tag, image, gateSecret, wasRunning);
			}
			await this.docker.removeContainer(old.Id);
			this.say("recover", tag, `interrupted swap finished, ${wasRunning ? "running" : "kept stopped"}`);
		}
		return left.length > 0;
	}

	/** Put the old container back after a failed swap; logs, never throws. */
	private async rollback(tag: string, oldId: string, wasRunning: boolean) {
		try {
			const successor = await this.findCopy(tag);
			if (successor) await this.dropContainer(successor);
			await this.docker.renameContainer(oldId, containerName(tag));
			if (wasRunning) {
				await this.ensureCaddy(networkName(tag)).catch(() => false);
				await this.docker.startContainer(oldId);
			}
			this.say("rollback", tag, wasRunning ? "old container back, running" : "old container back, stopped");
		} catch (error) {
			this.say("rollback", tag, `failed, finished at the next call or start (${describe(error)})`);
		}
	}

	/** Replace `found` by a successor from the template on the same volume. */
	private async swap(tag: string, found: ContainerInspect, image: string, gateSecret: string, start: boolean) {
		const wasRunning = isRunning(found);
		await this.docker.renameContainer(found.Id, oldName(tag, wasRunning));
		try {
			await this.docker.stopContainer(found.Id);
			await this.build(tag, image, gateSecret, start);
		} catch (error) {
			await this.rollback(tag, found.Id, wasRunning);
			throw error;
		}
		try {
			await this.docker.removeContainer(found.Id);
		} catch (error) {
			this.say("swap", tag, `old container not removed yet, finished later (${describe(error)})`);
		}
	}

	/** POST /copies: a new copy, or the same volume under a new container and a new secret. */
	createCopy(tag: string, start = true): Promise<{ upstream: string; gateSecret: string }> {
		return this.serial(tag, async () => {
			await this.settle(tag);
			const image = await this.currentImage();
			await this.ensureNetwork(tag);
			await this.ensureVolume(tag);
			const old = await this.findCopy(tag);
			const gateSecret = newGateSecret();
			if (old) await this.swap(tag, old, image, gateSecret, start);
			else await this.build(tag, image, gateSecret, start);
			this.say("create", tag, `${old ? "re-created on its volume" : "created"}, ${start ? "started" : "left stopped"}`);
			return { upstream: upstreamOf(tag), gateSecret };
		});
	}

	/** Null: no such copy. */
	stopCopy(tag: string): Promise<boolean | null> {
		return this.serial(tag, async () => {
			await this.settle(tag);
			const found = await this.findCopy(tag);
			if (!found) return null;
			await this.docker.stopContainer(found.Id);
			this.say("stop", tag, "stopped");
			return true;
		});
	}

	/** Null: no such copy (the gateway then asks for POST /copies). */
	startCopy(tag: string): Promise<boolean | null> {
		return this.serial(tag, async () => {
			await this.settle(tag);
			const found = await this.findCopy(tag);
			if (!found) return null;
			if (await this.docker.inspectNetwork(networkName(tag))) await this.ensureCaddy(networkName(tag));
			await this.docker.startContainer(found.Id);
			this.say("start", tag, "started");
			return true;
		});
	}

	/** Containers (a swap's leftovers too) and the network go; the volume stays. Fine from any partial state. */
	removeCopy(tag: string): Promise<void> {
		return this.serial(tag, async () => {
			const containers = [...(await this.findOld(tag)).map((o) => o.container)];
			const found = await this.findCopy(tag);
			if (found) containers.push(found);
			for (const container of containers) await this.dropContainer(container);
			const network = await this.docker.inspectNetwork(networkName(tag));
			if (network) {
				if (network.Name !== networkName(tag)) throw new MakerFailure("name_clash");
				await this.detachCaddy(network.Name);
				await this.docker.removeNetwork(network.Name);
			}
			this.say("remove", tag, containers.length ? "container and network removed, volume kept" : "nothing left to remove, volume kept");
		});
	}

	/** The final deletion. "in-use" while any container still uses the volume. */
	removeVolume(tag: string): Promise<"removed" | "missing" | "in-use"> {
		return this.serial(tag, async () => {
			const name = volumeName(tag);
			const users = await this.docker.listContainers({ volume: [name] });
			if ((await this.findCopy(tag)) || users.length > 0) {
				this.say("delete volume", tag, "refused, a container still uses it");
				return "in-use";
			}
			const outcome = await this.docker.removeVolume(name);
			this.say("delete volume", tag, outcome === "in-use" ? "refused by Docker, in use" : outcome);
			return outcome;
		});
	}

	private async managed() {
		const list = await this.docker.listContainers({ label: [`${MANAGED_LABEL}=1`] });
		const copies: Array<{ tag: string; summary: (typeof list)[number] }> = [];
		const leftovers = new Set<string>();
		for (const summary of list) {
			for (const name of summary.Names) {
				const tag = copyTagOf(name);
				if (tag && summary.Labels?.[TAG_LABEL] === tag) copies.push({ tag, summary });
				const old = oldTagOf(name);
				if (old && summary.Labels?.[TAG_LABEL] === old.tag) leftovers.add(old.tag);
			}
		}
		return { copies, leftovers: [...leftovers].sort() };
	}

	/** Every copy's own container; a swap's leftover is not a copy. */
	async listCopies(): Promise<CopySummary[]> {
		let current: string | null = null;
		try {
			current = await this.currentImage();
		} catch {
			current = null;
		}
		const { copies } = await this.managed();
		return copies
			.map(({ tag, summary }) => ({ tag, state: summary.State, image: summary.ImageID, upToDate: current !== null && summary.ImageID === current }))
			.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
	}

	/** One copy onto `image`: same volume, same secret, same running or stopped state. */
	private recreateOnImage(tag: string, image: string): Promise<"updated" | "current" | "gone"> {
		return this.serial(tag, async () => {
			await this.settle(tag);
			const found = await this.findCopy(tag);
			if (!found) return "gone";
			if (found.Image === image) return "current";
			if (found.Config.Labels?.[TAG_LABEL] !== tag) throw new MakerFailure("bad_label");
			const gateSecret = envValue(found.Config.Env, "LH_GATE_SECRET");
			if (!gateSecret || !SECRET_RE.test(gateSecret)) throw new MakerFailure("no_secret");
			const wasRunning = isRunning(found);
			await this.ensureNetwork(tag);
			await this.ensureVolume(tag);
			await this.swap(tag, found, image, gateSecret, wasRunning);
			this.say("update", tag, wasRunning ? "on the current image, started" : "on the current image, kept stopped");
			return "updated";
		});
	}

	/** Leftovers finished, Caddy on every account network, then every copy onto the current image, one at a time. */
	reconcile(): Promise<ReconcileResult> {
		if (this.closing) return Promise.reject(new MakerFailure("shutting_down"));
		if (!this.reconciling) {
			this.reconciling = this.reconcilePass().finally(() => {
				this.reconciling = null;
			});
		}
		return this.reconciling;
	}

	private async reconcilePass(): Promise<ReconcileResult> {
		const result: ReconcileResult = { recovered: [], updated: [], failed: [], unchanged: 0 };
		for (const tag of (await this.managed()).leftovers) {
			if (this.closing) return result;
			try {
				if (await this.serial(tag, () => this.settle(tag))) result.recovered.push(tag);
			} catch (error) {
				result.failed.push(tag);
				this.say("recover", tag, `failed (${describe(error)})`);
			}
		}
		const networks = await this.docker.listNetworks({ label: [`${MANAGED_LABEL}=1`] });
		for (const network of networks) {
			const tag = NETWORK_NAME_RE.exec(network.Name)?.[1];
			if (!tag || this.closing) continue;
			try {
				if (await this.serial(tag, () => this.ensureCaddy(network.Name))) this.say("reconcile", tag, "Caddy joined to the network again");
			} catch (error) {
				this.say("reconcile", tag, `Caddy not joined (${describe(error)})`);
			}
		}
		const image = await this.currentImage();
		for (const { tag, summary } of (await this.managed()).copies) {
			if (this.closing) break;
			if (summary.ImageID === image) {
				result.unchanged += 1;
				continue;
			}
			try {
				const outcome = await this.recreateOnImage(tag, image);
				if (outcome === "updated") result.updated.push(tag);
				else result.unchanged += 1;
			} catch (error) {
				if (!result.failed.includes(tag)) result.failed.push(tag);
				this.say("update", tag, `failed (${describe(error)})`);
			}
		}
		this.say(
			"reconcile",
			null,
			`${result.recovered.length} recovered, ${result.updated.length} updated, ${result.failed.length} failed, ${result.unchanged} unchanged${this.closing ? ", stopped early for shutdown" : ""}`,
		);
		return result;
	}

	// ─── Routing ─────────────────────────────────────────────────────────────

	/** One call, after the token check. `rawPath` is the request target as sent (never decoded). */
	async handle(method: string, rawPath: string, body: string): Promise<MakerAnswer> {
		const path = rawPath.split("?")[0] ?? "";
		const allow = (methods: string) => code(405, "method_not_allowed", { Allow: methods });
		try {
			if (path === "/copies") {
				if (method === "GET") return json(200, await this.listCopies());
				if (method !== "POST") return allow("GET, POST");
				const wanted = createRequest(body);
				if (!wanted) return code(400, "bad_tag");
				return json(200, await this.createCopy(wanted.tag, wanted.start));
			}
			if (path === "/reconcile") {
				if (method !== "POST") return allow("POST");
				return json(200, await this.reconcile());
			}
			let match = /^\/copies\/([^/]*)\/(stop|start)$/.exec(path);
			if (match) {
				if (method !== "POST") return allow("POST");
				const tag = match[1];
				if (!isTag(tag)) return code(400, "bad_tag");
				const done = match[2] === "stop" ? await this.stopCopy(tag) : await this.startCopy(tag);
				return done === null ? code(404, "no_copy") : json(200, { tag, state: match[2] === "stop" ? "stopped" : "running" });
			}
			match = /^\/copies\/([^/]*)$/.exec(path);
			if (match) {
				if (method !== "DELETE") return allow("DELETE");
				const tag = match[1];
				if (!isTag(tag)) return code(400, "bad_tag");
				await this.removeCopy(tag);
				return json(200, { tag, removed: true });
			}
			match = /^\/volumes\/([^/]*)$/.exec(path);
			if (match) {
				if (method !== "DELETE") return allow("DELETE");
				const tag = match[1];
				if (!isTag(tag)) return code(400, "bad_tag");
				const outcome = await this.removeVolume(tag);
				return outcome === "in-use" ? code(409, "volume_in_use") : json(200, { tag, removed: outcome === "removed" });
			}
			return code(404, "not_found");
		} catch (error) {
			const route = path.startsWith("/volumes") ? "/volumes" : path.startsWith("/copies") ? "/copies" : "/reconcile";
			const tag = /^\/(?:copies|volumes)\/([^/]*)/.exec(path)?.[1] ?? (path === "/copies" ? createRequest(body)?.tag : null);
			this.say(`${method} ${route}`, isTag(tag) ? tag : null, `failed (${describe(error)})`);
			if (error instanceof MakerFailure && error.code === "shutting_down") return code(503, error.code);
			if (error instanceof DockerError) return code(502, error.code);
			if (error instanceof MakerFailure) return code(502, error.code);
			return code(500, "internal");
		}
	}
}

/** Only `tag` and `start` are read from a body; `start` is off only when it is literally false. */
export function createRequest(body: string): { tag: string; start: boolean } | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const { tag, start } = parsed as { tag?: unknown; start?: unknown };
	return isTag(tag) ? { tag, start: start !== false } : null;
}

// ─── The listener ────────────────────────────────────────────────────────────

function refuseLarge(req: http.IncomingMessage, res: http.ServerResponse) {
	res.setHeader("Connection", "close");
	res.on("finish", () => req.destroy());
	send(res, code(413, "too_large"));
}

function send(res: http.ServerResponse, answer: MakerAnswer) {
	const text = JSON.stringify(answer.body);
	res.writeHead(answer.status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(text),
		"Cache-Control": "no-store",
		...answer.headers,
	});
	res.end(text);
}

/** The HTTP server: the token first (no body read without it), then a small body, then the route. */
export function makerServer(maker: Maker): http.Server {
	const server = http.createServer((req, res) => {
		if (!maker.authorized(req.headers.authorization)) {
			send(res, code(401, "unauthorized"));
			req.resume();
			return;
		}
		const declared = Number(req.headers["content-length"] ?? 0);
		if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
			refuseLarge(req, res);
			return;
		}
		const chunks: Buffer[] = [];
		let size = 0;
		let refused = false;
		req.on("data", (chunk: Buffer) => {
			if (refused) return;
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				refused = true;
				refuseLarge(req, res);
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (refused) return;
			void maker.handle(req.method ?? "GET", req.url ?? "/", Buffer.concat(chunks).toString("utf8")).then((answer) => send(res, answer));
		});
		req.on("error", () => undefined);
	});
	server.requestTimeout = 120_000;
	server.headersTimeout = 10_000;
	return server;
}

/**
 * Stop taking calls, then wait (at most `waitMs`) for the running pass and every
 * tag's work. True when everything finished in time.
 */
export async function shutdownMaker(server: http.Server, maker: Maker, waitMs = SHUTDOWN_WAIT_MS): Promise<boolean> {
	server.close();
	server.closeIdleConnections();
	let timer: NodeJS.Timeout | undefined;
	const timedOut = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), waitMs);
	});
	const finished = await Promise.race([maker.shutdown().then(() => true as const), timedOut]);
	clearTimeout(timer);
	return finished;
}

/** The program: refuse to start without a token, listen, then one pass (leftovers first). */
export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
	const config = readMakerConfig(env);
	if ("error" in config) {
		console.error(`[LearnHarness] maker: not starting: ${config.error}.`);
		process.exit(1);
	}
	const docker = DockerClient.overSocket(env.DOCKER_SOCKET || DEFAULT_DOCKER_SOCKET);
	const maker = new Maker(config, docker);
	const port = Number(env.PORT) > 0 ? Number(env.PORT) : MAKER_PORT;
	const server = makerServer(maker);
	await new Promise<void>((resolve) => server.listen(port, "0.0.0.0", resolve));
	console.log(`[LearnHarness] maker: listening on ${port}.`);
	maker.reconcile().catch((error: unknown) => console.log(`[LearnHarness] maker: reconcile: failed (${describe(error)})`));
	let stopping = false;
	const stop = () => {
		if (stopping) return;
		stopping = true;
		console.log("[LearnHarness] maker: stopping: no new calls, waiting for work in progress.");
		void shutdownMaker(server, maker).then((finished) => {
			console.log(`[LearnHarness] maker: stopped${finished ? "" : " (work still running after the wait)"}.`);
			process.exit(0);
		});
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
}
