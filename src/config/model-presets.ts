import type { ModelRole } from "./schema.js";

/**
 * Opt-in opinionated model presets. A preset pins pipeline stages to
 * provider-tuned models. Built-ins ship for the native providers; users may
 * add their own under `config.modelPresets` and select any preset by name via
 * `config.modelPreset`.
 *
 * `provider-default` is a selector, not a map: it picks the preset matching
 * `config.provider` (`kimi`, `openai`, or `anthropic`). `openai-compatible`
 * has no built-in preset (any model works over the compatible endpoint), so it
 * resolves to `undefined` and callers fall back to the top-level `model`.
 */

/** Built-in preset names accepted by the `modelPreset` selector. */
export const BUILTIN_MODEL_PRESET_NAMES = [
  "provider-default",
  "kimi",
  "openai",
  "anthropic",
] as const;

export type BuiltinModelPreset = (typeof BUILTIN_MODEL_PRESET_NAMES)[number];

/** Concrete built-in preset names that carry a stage map (not a selector). */
export type ConcreteBuiltinModelPreset = Exclude<BuiltinModelPreset, "provider-default">;

/** Stage model assignment for one preset; keys mirror `ModelRole`. */
export type ModelStageMap = Record<ModelRole, string>;

/** Partial stage assignment; unset stages fall back to the top-level `model`. */
export type PartialModelStageMap = Partial<ModelStageMap>;

/**
 * Exact per-stage model assignments for each built-in preset. User entries in
 * `config.modelPresets` merge over these by name (see `resolveStageMapFor`).
 */
export const MODEL_PRESETS: Record<ConcreteBuiltinModelPreset, ModelStageMap> = {
  kimi: {
    intent: "kimi-for-coding-highspeed",
    fastPath: "kimi-for-coding",
    groupReview: "kimi-for-coding",
    synthesis: "kimi-for-coding",
  },
  openai: {
    intent: "gpt-5-mini",
    fastPath: "gpt-5-mini",
    groupReview: "gpt-5",
    synthesis: "gpt-5",
  },
  anthropic: {
    intent: "claude-haiku-4.5",
    fastPath: "claude-haiku-4.5",
    groupReview: "claude-sonnet-4.5",
    synthesis: "claude-sonnet-4.5",
  },
};

/**
 * Concrete preset name for a provider. `openai-compatible` and unknown
 * providers have no preset and return `undefined`, so the top-level `model`
 * fallback applies.
 */
export function presetForProvider(
  provider: string,
): ConcreteBuiltinModelPreset | undefined {
  switch (provider) {
    case "kimi":
      return "kimi";
    case "openai":
      return "openai";
    case "anthropic":
      return "anthropic";
    default:
      return undefined;
  }
}

/**
 * Selected preset name for a config: an explicit `modelPreset` wins;
 * `provider-default` resolves to the provider-matched preset. An absent
 * `modelPreset` means no preset (legacy behavior), and `openai-compatible`
 * under `provider-default` has no preset — both return `undefined` so
 * `modelForRole` falls back to the top-level `model`.
 */
export function resolvePresetName(config: {
  modelPreset?: string;
  provider: string;
}): string | undefined {
  if (config.modelPreset === undefined) return undefined;
  if (config.modelPreset === "provider-default") {
    return presetForProvider(config.provider);
  }
  return config.modelPreset;
}

/**
 * Merged stage map for a preset name: the built-in map (when the name matches
 * one) overlaid with the user's `modelPresets` entry for that name. A preset
 * with neither a built-in nor a user entry resolves to `undefined`; a
 * user-only preset contributes just its own stages, the rest falling back to
 * the top-level `model`.
 */
export function resolveStageMapFor(
  name: string,
  userPresets?: Record<string, PartialModelStageMap>,
): PartialModelStageMap | undefined {
  const builtin = MODEL_PRESETS[name as ConcreteBuiltinModelPreset];
  const user = userPresets?.[name];
  if (builtin === undefined && user === undefined) return undefined;
  return { ...builtin, ...user };
}
