import type { ModelRole } from "./schema.js";
/**
 * Release-pinned stage models per native provider. These maps ARE the model
 * choice for a given FiscalCR release: consumers pick a `provider` and get the
 * models this version's prompts and harness were tuned against. Upgrading
 * models means editing this map and cutting a minor release.
 *
 * `openai-compatible` has no entry (any model works over the compatible
 * endpoint), so it must set `model` explicitly.
 */
/** Stage model assignment for one provider; keys mirror `ModelRole`. */
export type ModelStageMap = Record<ModelRole, string>;
/** Providers that ship release-pinned default models. */
export type ProviderWithDefaults = "kimi" | "openai" | "anthropic";
export declare const PROVIDER_DEFAULT_MODELS: Record<ProviderWithDefaults, ModelStageMap>;
/**
 * Release-tuned request params per model, sent with every call to that model.
 * Operator `modelParams` merge over these, so an explicit config value wins.
 */
export declare const RELEASE_MODEL_PARAMS: Record<string, Record<string, unknown>>;
/** Release-tuned request params for a model; empty when it has none. */
export declare function releaseParamsForModel(model: string): Record<string, unknown>;
/**
 * Release-pinned stage map for a provider. `openai-compatible` and unknown
 * providers return `undefined`.
 */
export declare function defaultModelsForProvider(provider: string): ModelStageMap | undefined;
//# sourceMappingURL=provider-models.d.ts.map