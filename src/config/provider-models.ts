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

export const PROVIDER_DEFAULT_MODELS: Record<ProviderWithDefaults, ModelStageMap> = {
  kimi: {
    intent: "k3-256k",
    fastPath: "k3-256k",
    groupReview: "k3",
    synthesis: "k3",
    visualize: "k3-256k",
  },
  openai: {
    intent: "gpt-6-luna",
    fastPath: "gpt-6-luna",
    groupReview: "gpt-6.1-sol",
    synthesis: "gpt-6.1-sol",
    visualize: "gpt-6-luna",
  },
  anthropic: {
    intent: "claude-sonnet-5-5",
    fastPath: "claude-sonnet-5-5",
    groupReview: "claude-opus-5-5",
    synthesis: "claude-opus-5-5",
    visualize: "claude-sonnet-5-5",
  },
};

/**
 * Release-pinned stage map for a provider. `openai-compatible` and unknown
 * providers return `undefined`.
 */
export function defaultModelsForProvider(provider: string): ModelStageMap | undefined {
  return Object.hasOwn(PROVIDER_DEFAULT_MODELS, provider)
    ? PROVIDER_DEFAULT_MODELS[provider as ProviderWithDefaults]
    : undefined;
}
