/**
 * A minimal Docker Engine API client over the unix socket (multi-account
 * plan, slice 3a). Plain node:http with `socketPath`, no dependency. Only the
 * calls the maker needs. Every call has a timeout; an answer body is capped.
 * Docker's own error text is kept on the error for the maker to redact and
 * log; it is never sent back to the maker's caller.
 */
import http from "node:http";

/** Docker 25+ (Jan 2024). Docker 29 refuses versions below 1.44 by default. */
export const DOCKER_API_VERSION = "v1.44";
export const DOCKER_TIMEOUT_MS = 15_000;
/** Stop waits up to STOP_GRACE_S for the copy, then Docker kills it. */
export const STOP_GRACE_S = 10;
const STOP_TIMEOUT_MS = (STOP_GRACE_S + 20) * 1000;
const MAX_ANSWER_BYTES = 8 * 1024 * 1024;

export type DockerErrorCode = "docker_timeout" | "docker_unreachable" | "docker_error";

export class DockerError extends Error {
	readonly code: DockerErrorCode;
	readonly status: number | null;
	/** Docker's own message (unredacted); log only through the maker's redaction. */
	readonly detail: string;
	constructor(code: DockerErrorCode, status: number | null, detail: string) {
		super(`${code}${status === null ? "" : ` ${status}`}`);
		this.code = code;
		this.status = status;
		this.detail = detail;
	}
}

export interface DockerAnswer {
	status: number;
	data: unknown;
}

export interface DockerRequestOptions {
	body?: unknown;
	query?: Record<string, string>;
	timeoutMs?: number;
}

export type DockerRequest = (method: string, path: string, options?: DockerRequestOptions) => Promise<DockerAnswer>;

/** The raw transport: one request, any status answered (errors only for no answer). */
export function dockerTransport(socketPath: string): DockerRequest {
	return (method, path, options = {}) =>
		new Promise<DockerAnswer>((resolve, reject) => {
			const query = options.query ? `?${new URLSearchParams(options.query).toString()}` : "";
			const payload = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body), "utf8");
			const headers: Record<string, string | number> = { Host: "docker" };
			if (payload) {
				headers["Content-Type"] = "application/json";
				headers["Content-Length"] = payload.length;
			}
			let settled = false;
			const finish = (error: DockerError | null, answer?: DockerAnswer) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (error) reject(error);
				else resolve(answer as DockerAnswer);
			};
			const req = http.request(
				{ socketPath, method, path: `/${DOCKER_API_VERSION}${path}${query}`, headers },
				(res) => {
					const chunks: Buffer[] = [];
					let size = 0;
					res.on("data", (chunk: Buffer) => {
						size += chunk.length;
						if (size > MAX_ANSWER_BYTES) {
							res.destroy();
							finish(new DockerError("docker_error", res.statusCode ?? null, "answer too large"));
							return;
						}
						chunks.push(chunk);
					});
					res.on("error", () => finish(new DockerError("docker_unreachable", null, "answer cut off")));
					res.on("end", () => {
						const text = Buffer.concat(chunks).toString("utf8");
						let data: unknown = null;
						if (text.length > 0) {
							try {
								data = JSON.parse(text);
							} catch {
								data = text;
							}
						}
						finish(null, { status: res.statusCode ?? 0, data });
					});
				},
			);
			const timer = setTimeout(() => {
				req.destroy();
				finish(new DockerError("docker_timeout", null, `${method} ${path}`));
			}, options.timeoutMs ?? DOCKER_TIMEOUT_MS);
			req.on("error", (error) => finish(new DockerError("docker_unreachable", null, error.message)));
			if (payload) req.write(payload);
			req.end();
		});
}

function messageOf(data: unknown): string {
	if (data && typeof data === "object" && "message" in data && typeof (data as { message: unknown }).message === "string") {
		return (data as { message: string }).message;
	}
	return typeof data === "string" ? data : "";
}

function fail(answer: DockerAnswer): never {
	throw new DockerError("docker_error", answer.status, messageOf(answer.data));
}

function ok(answer: DockerAnswer, ...accepted: number[]): void {
	if (!accepted.includes(answer.status)) fail(answer);
}

// ─── The shapes the maker reads (only the fields it uses) ─────────────────────

export interface ContainerInspect {
	Id: string;
	Name: string;
	Image: string;
	Config: { Image?: string; Env?: string[] | null; Labels?: Record<string, string> | null };
	State: { Status: string; Running: boolean; Restarting?: boolean };
	NetworkSettings?: { Networks?: Record<string, unknown> | null };
}

export interface ContainerSummary {
	Id: string;
	Names: string[];
	Image: string;
	ImageID: string;
	State: string;
	Labels?: Record<string, string> | null;
	Mounts?: Array<{ Type?: string; Name?: string }> | null;
}

export interface NetworkInspect {
	Id: string;
	Name: string;
	Containers?: Record<string, unknown> | null;
	Labels?: Record<string, string> | null;
}

export interface VolumeInspect {
	Name: string;
	Labels?: Record<string, string> | null;
}

export interface ImageInspect {
	Id: string;
}

/**
 * An image reference in a path: its slashes stay as they are (as the Docker CLI
 * sends them; the daemon's route takes the rest of the path as the name), every
 * other character is percent-encoded (`ghcr.io/owner/name%3Adev`). Checked on
 * Docker 29: raw slashes, encoded slashes and an encoded colon all resolve.
 */
export function imageRefPath(ref: string): string {
	return ref.split("/").map(encodeURIComponent).join("/");
}

/** The calls the maker makes. Names and ids go into the path encoded. */
export class DockerClient {
	constructor(private readonly send: DockerRequest) {}

	static overSocket(socketPath: string): DockerClient {
		return new DockerClient(dockerTransport(socketPath));
	}

	async inspectImage(ref: string): Promise<ImageInspect | null> {
		const answer = await this.send("GET", `/images/${imageRefPath(ref)}/json`);
		if (answer.status === 404) return null;
		ok(answer, 200);
		return answer.data as ImageInspect;
	}

	async inspectContainer(nameOrId: string): Promise<ContainerInspect | null> {
		const answer = await this.send("GET", `/containers/${encodeURIComponent(nameOrId)}/json`);
		if (answer.status === 404) return null;
		ok(answer, 200);
		return answer.data as ContainerInspect;
	}

	async listContainers(filters: Record<string, string[]>): Promise<ContainerSummary[]> {
		const answer = await this.send("GET", "/containers/json", { query: { all: "1", filters: JSON.stringify(filters) } });
		ok(answer, 200);
		return Array.isArray(answer.data) ? (answer.data as ContainerSummary[]) : [];
	}

	async createContainer(name: string, body: unknown): Promise<string> {
		const answer = await this.send("POST", "/containers/create", { query: { name }, body, timeoutMs: 30_000 });
		ok(answer, 201);
		return (answer.data as { Id: string }).Id;
	}

	/** True when it was started now; false when it was already running. Null: no such container. */
	async startContainer(nameOrId: string): Promise<boolean | null> {
		const answer = await this.send("POST", `/containers/${encodeURIComponent(nameOrId)}/start`, { timeoutMs: 30_000 });
		if (answer.status === 404) return null;
		ok(answer, 204, 304);
		return answer.status === 204;
	}

	/** Null: no such container. */
	async stopContainer(nameOrId: string): Promise<boolean | null> {
		const answer = await this.send("POST", `/containers/${encodeURIComponent(nameOrId)}/stop`, {
			query: { t: String(STOP_GRACE_S) },
			timeoutMs: STOP_TIMEOUT_MS,
		});
		if (answer.status === 404) return null;
		ok(answer, 204, 304);
		return answer.status === 204;
	}

	/** False: no such container. Docker answers 409 when the new name is taken. */
	async renameContainer(nameOrId: string, name: string): Promise<boolean> {
		const answer = await this.send("POST", `/containers/${encodeURIComponent(nameOrId)}/rename`, { query: { name } });
		if (answer.status === 404) return false;
		ok(answer, 204);
		return true;
	}

	/** Removes the container only: `v` stays off, and named volumes are never removed with it anyway. */
	async removeContainer(nameOrId: string): Promise<boolean> {
		const answer = await this.send("DELETE", `/containers/${encodeURIComponent(nameOrId)}`, {
			query: { force: "1" },
			timeoutMs: STOP_TIMEOUT_MS,
		});
		if (answer.status === 404) return false;
		ok(answer, 204);
		return true;
	}

	async inspectNetwork(name: string): Promise<NetworkInspect | null> {
		const answer = await this.send("GET", `/networks/${encodeURIComponent(name)}`);
		if (answer.status === 404) return null;
		ok(answer, 200);
		return answer.data as NetworkInspect;
	}

	async listNetworks(filters: Record<string, string[]>): Promise<NetworkInspect[]> {
		const answer = await this.send("GET", "/networks", { query: { filters: JSON.stringify(filters) } });
		ok(answer, 200);
		return Array.isArray(answer.data) ? (answer.data as NetworkInspect[]) : [];
	}

	async createNetwork(body: unknown): Promise<void> {
		const answer = await this.send("POST", "/networks/create", { body });
		ok(answer, 201);
	}

	async connectNetwork(network: string, container: string): Promise<void> {
		const answer = await this.send("POST", `/networks/${encodeURIComponent(network)}/connect`, { body: { Container: container } });
		ok(answer, 200);
	}

	/**
	 * False when either side is missing. Docker 29 answers 500 ("is not connected
	 * to the network") for a container that isn't attached: callers look first.
	 */
	async disconnectNetwork(network: string, container: string): Promise<boolean> {
		const answer = await this.send("POST", `/networks/${encodeURIComponent(network)}/disconnect`, {
			body: { Container: container, Force: true },
		});
		if (answer.status === 404) return false;
		ok(answer, 200);
		return true;
	}

	async removeNetwork(name: string): Promise<boolean> {
		const answer = await this.send("DELETE", `/networks/${encodeURIComponent(name)}`);
		if (answer.status === 404) return false;
		ok(answer, 204);
		return true;
	}

	async inspectVolume(name: string): Promise<VolumeInspect | null> {
		const answer = await this.send("GET", `/volumes/${encodeURIComponent(name)}`);
		if (answer.status === 404) return null;
		ok(answer, 200);
		return answer.data as VolumeInspect;
	}

	/** Volumes whose name contains `nameContains` (Docker's name filter is a substring match). */
	async listVolumes(nameContains: string): Promise<VolumeInspect[]> {
		const answer = await this.send("GET", "/volumes", { query: { filters: JSON.stringify({ name: [nameContains] }) } });
		ok(answer, 200);
		const volumes = (answer.data as { Volumes?: VolumeInspect[] | null } | null)?.Volumes;
		return Array.isArray(volumes) ? volumes : [];
	}

	/** Docker's create is idempotent and returns an existing volume silently: inspect first. */
	async createVolume(body: unknown): Promise<void> {
		const answer = await this.send("POST", "/volumes/create", { body });
		ok(answer, 201);
	}

	/** "missing", "removed", or "in-use" (Docker's 409). */
	async removeVolume(name: string): Promise<"missing" | "removed" | "in-use"> {
		const answer = await this.send("DELETE", `/volumes/${encodeURIComponent(name)}`);
		if (answer.status === 404) return "missing";
		if (answer.status === 409) return "in-use";
		ok(answer, 204);
		return "removed";
	}
}
