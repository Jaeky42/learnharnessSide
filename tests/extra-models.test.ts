import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { piModels } from "../src/agent/models.ts";
import { EXTRA_MODEL_IDS } from "../src/agent/extra-models.ts";
import { refreshChatGPTModels, chatGPTModels } from "../src/agent/chatgpt-bridge.ts";

const ASTRA = "gpt-6.2-astra", SOL = "gpt-6.2-sol", BASE = "gpt-6.1-sol";
const GUARD = "the library knows gpt-6.2 now: remove src/agent/extra-models.ts (and the FORK (GPT-6.2 models) lines in src/agent/models.ts)";
const openai = () => piModels().getModels("openai");
const base = () => openai().find((m) => m.id === BASE && m.api === "openai-responses")!;
const rest = (model: object) => { const { id, name, cost, ...others } = model as Record<string, unknown>; return others; };

test("guard: the installed library does not know the two models yet", () => {
	const data = readFileSync(join(import.meta.dirname, "../node_modules/@earendil-works/pi-ai/dist/providers/data/openai.json"), "utf8");
	for (const id of [ASTRA, SOL]) assert.ok(!data.includes(`"${id}"`), GUARD);
});

test("both models are in the openai catalog, copied from GPT-6.1 Sol", () => {
	assert.deepEqual([...EXTRA_MODEL_IDS], [ASTRA, SOL]);
	const sol61 = base();
	assert.ok(sol61, "the base model exists");
	for (const [id, name] of [[ASTRA, "GPT-6.2 Astra"], [SOL, "GPT-6.2 Sol"]] as [string, string][]) {
		const entries = openai().filter((m) => m.id === id);
		assert.equal(entries.length, 1, `${id} appears once`);
		const model = entries[0]!;
		assert.equal(model.api, "openai-responses");
		assert.equal(model.provider, "openai");
		assert.equal(model.name, name);
		assert.deepEqual(rest(model), rest(sol61));
		assert.equal(piModels().getModel("openai", id)?.name, name);
	}
});

test("costs", () => {
	assert.deepEqual(piModels().getModel("openai", ASTRA)!.cost, { input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10 });
	assert.deepEqual(piModels().getModel("openai", SOL)!.cost, base().cost);
	assert.notEqual(piModels().getModel("openai", SOL)!.cost, base().cost, "a copy, not the library's object");
});

test("the library's own entries are unchanged and not duplicated", () => {
	const ids = openai().map((m) => m.id);
	assert.equal(new Set(ids).size, ids.length);
	const sol61 = base();
	assert.equal(sol61.name, "GPT-6.1 Sol");
	assert.deepEqual(sol61.cost, { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, tiers: [{ inputTokensAbove: 272000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }] });
	assert.ok(piModels().getAllModels("openai").some((m) => m.id === ASTRA), "also in the all-models list");
	assert.equal(piModels().getAllModels("openai").filter((m) => m.id === SOL).length, 1);
	// Nothing was added to other providers.
	assert.equal(piModels().getModel("openrouter", ASTRA), undefined);
});

test("thinking levels are the same as GPT-6.1 Sol's", () => {
	const expected = getSupportedThinkingLevels(base());
	assert.ok(expected.length > 1);
	for (const id of [ASTRA, SOL]) assert.deepEqual(getSupportedThinkingLevels(piModels().getModel("openai", id)!), expected);
});

test("a built-in id the library already has is never replaced, and no base means no extras", async () => {
	const { extraModelsFor } = await import("../src/agent/extra-models.ts");
	const models = openai();
	assert.deepEqual(extraModelsFor(models), [], "both already present");
	assert.deepEqual(extraModelsFor(models.filter((m) => m.id !== BASE && !EXTRA_MODEL_IDS.includes(m.id))), [], "base missing");
	const before = structuredClone(models.find((m) => m.id === BASE));
	extraModelsFor(models.filter((m) => !EXTRA_MODEL_IDS.includes(m.id)));
	assert.deepEqual(models.find((m) => m.id === BASE), before, "the library's object is not touched");
});

// --- through the ChatGPT bridge -------------------------------------------------
const send = Object.getOwnPropertyDescriptor(process, "send"), connected = Object.getOwnPropertyDescriptor(process, "connected");
const desktopMarker = process.env.LH_DESKTOP_SERVER, desktopSecret = process.env.LH_DESKTOP_API_SECRET;
const pending: any[] = [];
const ipc = (m: unknown) => (process.emit as (name: string, value: unknown) => boolean)("message", m);
const status = (account: string) => ({ available: true, pending: false, allowBackgroundUse: true, activeId: account, accounts: [{ id: account, connected: true, background: false, planEnabled: true }], error: null });
let revision = 0, epoch = 100;
const offer = async (models: { id: string; name: string }[]) => {
	const supported = openai().filter((m) => m.api === "openai-responses");
	const refresh = refreshChatGPTModels(supported as never);
	const request = pending.at(-1);
	ipc({ channel: "lh:chatgpt", id: request.id, op: request.op, ok: true, value: { epoch, authorityRevision: 1, revision: ++revision, status: status("A"), accountId: "A", models } });
	await refresh;
};
before(() => {
	process.env.LH_DESKTOP_SERVER = "1"; process.env.LH_DESKTOP_API_SECRET = "d".repeat(64);
	Object.defineProperty(process, "connected", { configurable: true, value: true });
	Object.defineProperty(process, "send", { configurable: true, value: (m: unknown, cb?: () => void) => { pending.push(m); cb?.(); return true; } });
});
after(() => {
	if (desktopMarker === undefined) delete process.env.LH_DESKTOP_SERVER; else process.env.LH_DESKTOP_SERVER = desktopMarker;
	if (desktopSecret === undefined) delete process.env.LH_DESKTOP_API_SECRET; else process.env.LH_DESKTOP_API_SECRET = desktopSecret;
	if (send) Object.defineProperty(process, "send", send); else delete process.send;
	if (connected) Object.defineProperty(process, "connected", connected); else delete (process as { connected?: boolean }).connected;
});

test("the ChatGPT list shows them when the account offers them, at zero cost", async () => {
	await offer([{ id: BASE, name: "GPT-6.1 Sol" }, { id: ASTRA, name: "GPT-6.2 Astra" }, { id: SOL, name: "GPT-6.2 Sol" }]);
	const list = chatGPTModels();
	assert.deepEqual(list.map((m) => m.id), [BASE, ASTRA, SOL]);
	for (const id of [ASTRA, SOL]) {
		const m = list.find((x) => x.id === id)!;
		assert.equal(m.provider, "chatgpt");
		assert.equal(m.api, "openai-responses");
		assert.deepEqual(m.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	}
});

test("an account that does not offer them does not get them", async () => {
	epoch++;
	await offer([{ id: BASE, name: "GPT-6.1 Sol" }]);
	assert.deepEqual(chatGPTModels().map((m) => m.id), [BASE]);
});

// --- through refreshConnectionCatalog, and the remote overlay --------------------
test("refreshConnectionCatalog hands the bridge the bundled list plus the two extras, once each, and no overlay-only id", async () => {
	const { setModelCatalogOverlay } = await import("../src/agent/models.ts");
	const { refreshConnectionCatalog } = await import("../src/server/model-catalog.ts");
	const overlayOnly = "gpt-9-overlay-only";
	const sol61 = base();
	setModelCatalogOverlay(new Map([["openai", [
		{ ...structuredClone(sol61), id: overlayOnly, name: "Overlay only" },
		{ ...structuredClone(sol61), id: ASTRA, name: "Overlay Astra" },
	]]]));
	try {
		epoch++;
		const refresh = refreshConnectionCatalog("chatgpt");
		await new Promise((r) => setImmediate(r));
		const request = pending.at(-1);
		const models = [BASE, ASTRA, SOL, overlayOnly].map((id) => ({ id, name: id }));
		ipc({ channel: "lh:chatgpt", id: request.id, op: request.op, ok: true, value: { epoch, authorityRevision: 1, revision: ++revision, status: status("A"), accountId: "A", models } });
		await refresh;
		const ids = chatGPTModels().map((m) => m.id);
		assert.deepEqual(ids, [BASE, ASTRA, SOL]);
	} finally {
		setModelCatalogOverlay(new Map());
	}
});

test("an overlay row with a GPT-6.2 id yields that id once under an API key", async () => {
	const { setModelCatalogOverlay } = await import("../src/agent/models.ts");
	const sol61 = base();
	setModelCatalogOverlay(new Map([["openai", [{ ...structuredClone(sol61), id: ASTRA, name: "Overlay Astra" }]]]));
	try {
		for (const list of [piModels().getModels("openai"), piModels().getAllModels("openai")]) {
			assert.equal(list.filter((m) => m.id === ASTRA).length, 1);
			assert.equal(list.filter((m) => m.id === SOL).length, 1);
		}
		const ids = piModels().getModels("openai").map((m) => m.id);
		assert.equal(new Set(ids).size, ids.length);
		assert.equal(piModels().getModels("openai").find((m) => m.id === ASTRA)!.name, "Overlay Astra");
	} finally {
		setModelCatalogOverlay(new Map());
	}
});
