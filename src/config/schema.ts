import { z } from "zod";
import {
  BUILTIN_MODEL_PRESET_NAMES,
  resolvePresetName,
  resolveStageMapFor,
} from "./model-presets.js";

/**
 * Files excluded from review by default: dependency dirs, build output, and
 * lockfiles/generated manifests. These are machine-generated, often huge, and
 * carry no review value while consuming a large share of the token budget.
 * Shared by the schema default and DEFAULT_CONFIG so the two never drift.
 */
export const DEFAULT_EXCLUDE_PATTERNS = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  // Minified bundles.
  "**/*.min.*",
  // Lockfiles / generated dependency manifests, across ecosystems.
  "**/*.lock", // Cargo.lock, composer.lock, Gemfile.lock, poetry.lock, Podfile.lock, flake.lock, …
  "**/*.lockb", // bun.lockb
  "**/package-lock.json",
  "**/npm-shrinkwrap.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/bun.lockb",
  "**/go.sum",
  "**/go.work.sum",
  "**/packages.lock.json", // NuGet
] as const;
/** Shared strict shape for explicit stage overrides and custom preset stages. */
export const modelStageSchema = z
  .object({
    intent: z.string().min(1).optional(),
    fastPath: z.string().min(1).optional(),
    groupReview: z.string().min(1).optional(),
    synthesis: z.string().min(1).optional(),
  })
  .strict();

export type ModelRole = keyof z.infer<typeof modelStageSchema>;


export const reviewConfigSchema = z.object({
  language: z.enum(["en", "zh-TW", "zh-CN", "ja", "ko"]).default("en"),
  provider: z.enum(["openai-compatible", "kimi", "openai", "anthropic"]).default("kimi"),
  model: z.string().default("k3"),
  /**
   * Per-stage model overrides. `intent` drives the Pass 1 intent call,
   * `fastPath` the fast-path combined call, `groupReview` the per-group file
   * reviews, and `synthesis` the final synthesis call. An unset stage falls
   * back to the selected `modelPreset` stage model, then to the legacy
   * top-level `model`, so configs that only set `model` keep working. Unknown
   * keys are rejected (`.strict()`), so the old `big`/`small` roles fail
   * loudly instead of silently disappearing.
   */
  models: modelStageSchema.default({}),

  /**
   * Selected model preset (see `src/config/model-presets.ts`). Accepts the
   * built-in names `provider-default`, `kimi`, `openai`, `anthropic`, or any
   * name defined under `modelPresets`. `provider-default` resolves the preset
   * from `provider` (`kimi`/`openai`/`anthropic`); `openai-compatible` has no
   * preset and falls through to the top-level `model`. Omitted → no preset
   * (legacy behavior). Explicit `models.*` stages always win. Unknown preset
   * names fail validation.
   */
  modelPreset: z.string().min(1).optional(),
  /**
   * User-defined model presets: preset name → partial per-stage model object.
   * Entries merge over the built-in preset of the same name (user stages win);
   * new names are selectable via `modelPreset`. Unknown stage keys are
   * rejected (`.strict()`); unset stages fall back to the top-level `model`.
   */
  modelPresets: z.record(z.string().min(1), modelStageSchema).optional(),

  baseUrl: z.string().url().optional(),
  /** Custom User-Agent for endpoints that whitelist clients. */
  userAgent: z.string().max(200).optional(),
  /** Sampling temperature override. Unset → 0.3, except models that pin their own. */
  temperature: z.number().min(0).max(2).optional(),
  /**
   * Provider-native request fields merged into every LLM call. Typed fields are
   * validated; all other keys pass through verbatim (future-proof). Pipeline-
   * managed keys are stripped by the selected provider adapter.
   */
  modelParams: z
    .object({
      reasoning_effort: z.enum(["minimal", "low", "medium", "high"]).optional(),
      verbosity: z.enum(["low", "medium", "high"]).optional(),
    })
    .passthrough()
    .optional(),
  /** Enables opt-in prompt optimizations that may change between releases. */
  experimental: z.boolean().default(false),

  review: z
    .object({
      auto: z
        .object({
          enabled: z.boolean().default(true),
          onOpen: z.boolean().default(true),
          onPush: z.boolean().default(true),
          onReviewRequest: z.boolean().default(true),
          drafts: z.boolean().default(false),
        })
        .default({}),

      aspects: z
        .object({
          bugs: z.boolean().default(true),
          security: z.boolean().default(true),
          performance: z.boolean().default(true),
          style: z.boolean().default(true),
          bestPractices: z.boolean().default(true),
          documentation: z.boolean().default(false),
          testing: z.boolean().default(false),
        })
        .default({}),

      minSeverity: z
        .enum(["critical", "warning", "suggestion", "nitpick"])
        .default("suggestion"),

      maxAnnotations: z.number().min(1).max(100).default(30),

      failOn: z.enum(["critical", "warning", "never"]).default("critical"),

      incremental: z
        .object({
          enabled: z.boolean().default(true),
          /** Deltas touching more files than this fall back to a full review. */
          maxDeltaFiles: z.number().min(1).max(299).default(150),
        })
        .default({}),

      comments: z
        .object({
          /** 'sticky': one updated summary + incremental reviews. 'legacy': stack a full review per run. */
          mode: z.enum(["sticky", "legacy"]).default("sticky"),
          dedupe: z.boolean().default(true),
          resolveOutdated: z.boolean().default(true),
          /** Cumulative inline-comment cap; overflow demotes to check-run annotations. */
          maxOpenComments: z.number().min(1).default(100),
        })
        .default({}),
    })
    .default({}),

  files: z
    .object({
      include: z.array(z.string()).default(["**/*"]),
      exclude: z.array(z.string()).default([...DEFAULT_EXCLUDE_PATTERNS]),
      maxFileSize: z.number().default(100_000),
    })
    .default({}),

  rules: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        filePattern: z.string().optional(),
        severity: z
          .enum(["critical", "warning", "suggestion"])
          .default("warning"),
      }),
    )
    .default([]),

  prompt: z
    .object({
      systemAppend: z.string().max(2000).optional(),
      reviewFocus: z.string().max(500).optional(),
    })
    .default({}),

  pipeline: z
    .object({
      /** false → single-call review regardless of PR size (legacy behavior). */
      enabled: z.boolean().default(true),
      concurrency: z.number().min(1).max(8).default(3),
      groupTokenBudget: z.number().min(8_000).default(40_000),
      relatedContextBudget: z.number().min(0).default(15_000),
      maxGroups: z.number().min(1).max(20).default(8),
      fastPathThreshold: z.number().default(25_000),
      minConfidence: z.number().min(0).max(1).default(0.6),
      maxRetries: z.number().min(0).max(5).default(3),
      callTimeoutMs: z.number().default(120_000),
      // Unset → resolved per model (Kimi gets a larger cap). See reviewMaxOutputTokens.
      maxOutputTokens: z.number().optional(),
    })
    .default({}),
})
  // A selected preset must be a built-in name or defined under `modelPresets`;
  // anything else is a stale/typo'd selector and fails fast like other
  // invalid config.
  .superRefine((config, ctx) => {
    if (config.modelPreset === undefined) return;
    const knownPresets = [
      ...BUILTIN_MODEL_PRESET_NAMES,
      ...Object.keys(config.modelPresets ?? {}),
    ];
    if (!knownPresets.includes(config.modelPreset)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["modelPreset"],
        message: `Unknown model preset "${config.modelPreset}"; use a built-in (${BUILTIN_MODEL_PRESET_NAMES.join(", ")}) or define it under modelPresets`,
      });
    }
  });

export type ReviewConfig = z.infer<typeof reviewConfigSchema>;


/**
 * Resolve the model for a pipeline stage. Precedence: explicit per-stage
 * override from `config.models` > the selected `modelPreset` stage model
 * (built-in or user-defined, merged) > the legacy top-level `model`. With no
 * preset selected this reduces to `config.models[role] ?? config.model`, so
 * old configs keep their single-model behavior.
 */
export function modelForRole(config: ReviewConfig, role: ModelRole): string {
  const explicit = config.models[role];
  if (explicit !== undefined) return explicit;
  const presetName = resolvePresetName(config);
  const presetStage =
    presetName === undefined
      ? undefined
      : resolveStageMapFor(presetName, config.modelPresets)?.[role];
  return presetStage ?? config.model;
}
