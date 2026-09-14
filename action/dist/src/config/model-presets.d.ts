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
export declare const BUILTIN_MODEL_PRESET_NAMES: readonly ["provider-default", "kimi", "openai", "anthropic"];
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
export declare const MODEL_PRESETS: Record<ConcreteBuiltinModelPreset, ModelStageMap>;
/**
 * Concrete preset name for a provider. `openai-compatible` and unknown
 * providers have no preset and return `undefined`, so the top-level `model`
 * fallback applies.
 */
export declare function presetForProvider(provider: string): ConcreteBuiltinModelPreset | undefined;
/**
 * Selected preset name for a config: an explicit `modelPreset` wins;
 * `provider-default` resolves to the provider-matched preset. An absent
 * `modelPreset` means no preset (legacy behavior), and `openai-compatible`
 * under `provider-default` has no preset — both return `undefined` so
 * `modelForRole` falls back to the top-level `model`.
 */
export declare function resolvePresetName(config: {
    modelPreset?: string;
    provider: string;
}): string | undefined;
/**
 * Merged stage map for a preset name: the built-in map (when the name matches
 * one) overlaid with the user's `modelPresets` entry for that name. A preset
 * with neither a built-in nor a user entry resolves to `undefined`; a
 * user-only preset contributes just its own stages, the rest falling back to
 * the top-level `model`.
 */
export declare function resolveStageMapFor(name: string, userPresets?: Record<string, PartialModelStageMap>): PartialModelStageMap | undefined;
//# sourceMappingURL=model-presets.d.ts.map