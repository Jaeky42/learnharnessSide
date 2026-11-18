import type { Api, Model, Provider } from "@earendil-works/pi-ai";

/**
 * FORK: models the installed pi-ai catalog does not know yet.
 *
 * OpenAI released GPT-6.2 Astra and GPT-6.2 Sol on 17 Nov 2026 (API ids
 * `gpt-6.2-astra` and `gpt-6.2-sol`), after the newest published
 * `@earendil-works/pi-ai` (pinned 1.4.0, whose data stops at `gpt-6.1-sol`).
 * Until the library knows them, they are added here to the `openai` provider
 * so the OpenAI API-key list and the ChatGPT subscription list (which shows an
 * account's model only when the `openai` catalog has the same id with
 * `api: "openai-responses"`) offer them.
 *
 * Every field except id, name and cost is copied at run time from the
 * catalog's own `gpt-6.1-sol` entry, so nothing is retyped.
 *
 * Prices are per 1M tokens. For Astra, input (8) and output (40) are from press
 * reports; its two cache prices (0.4 and 10) only keep GPT-6.1 Sol's
 * proportions to input and are NOT confirmed. Sol's cost is GPT-6.1 Sol's,
 * unchanged.
 *
 * REMOVE THIS FILE (and the one line in `models.ts` that uses it) once the
 * library knows both models. `tests/extra-models.test.ts` fails then.
 */

const BASE_ID = "gpt-6.1-sol";

interface ExtraModel {
	id: string;
	name: string;
	/** The extra's cost, from the base entry's cost. */
	cost: (base: Model<Api>["cost"]) => Model<Api>["cost"];
}

const EXTRA_MODELS: readonly ExtraModel[] = [
	{
		id: "gpt-6.2-astra",
		name: "GPT-6.2 Astra",
		// Tiers are left out: their thresholds belong to GPT-6.1 Sol's limits.
		cost: () => ({ input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10 }),
	},
	{
		id: "gpt-6.2-sol",
		name: "GPT-6.2 Sol",
		cost: (base) => structuredClone(base),
	},
];

/** Ids of the extras, for tests. */
export const EXTRA_MODEL_IDS: readonly string[] = EXTRA_MODELS.map((extra) => extra.id);

function isChat(model: Model<Api>): boolean {
	return (model as { type?: string }).type === undefined || (model as { type?: string }).type === "chat";
}

/** The extras missing from `models`, built from its `gpt-6.1-sol` entry. New objects only. */
export function extraModelsFor<T extends Model<Api>>(models: readonly T[]): T[] {
	const base = models.find((model) => model.id === BASE_ID && model.api === "openai-responses" && isChat(model));
	if (!base) return [];
	const extras: T[] = [];
	for (const extra of EXTRA_MODELS) {
		// An id the library already has is never added or replaced.
		if (models.some((model) => model.id === extra.id && isChat(model))) continue;
		extras.push({ ...structuredClone(base), id: extra.id, name: extra.name, cost: extra.cost(base.cost) });
	}
	return extras;
}

/** The `openai` provider with the extras added to its catalog. Everything else (auth, streaming) is the provider's own. */
export function withExtraOpenAIModels<TApi extends Api>(provider: Provider<TApi>): Provider<TApi> {
	return {
		...provider,
		getModels: () => {
			const models = provider.getModels();
			return [...models, ...extraModelsFor(models)];
		},
		getAllModels: () => {
			const models = provider.getAllModels?.() ?? provider.getModels();
			return [...models, ...extraModelsFor(models as readonly Model<Api>[] as readonly Model<TApi>[])];
		},
	};
}
