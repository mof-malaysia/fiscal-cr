import { z } from "zod";
/**
 * Files excluded from review by default: dependency dirs, build output, and
 * lockfiles/generated manifests. These are machine-generated, often huge, and
 * carry no review value while consuming a large share of the token budget.
 * Shared by the schema default and DEFAULT_CONFIG so the two never drift.
 */
export declare const DEFAULT_EXCLUDE_PATTERNS: readonly ["**/node_modules/**", "**/dist/**", "**/build/**", "**/*.min.*", "**/*.lock", "**/*.lockb", "**/package-lock.json", "**/npm-shrinkwrap.json", "**/yarn.lock", "**/pnpm-lock.yaml", "**/bun.lockb", "**/go.sum", "**/go.work.sum", "**/packages.lock.json"];
/** Shared strict shape for explicit stage overrides and custom preset stages. */
export declare const modelStageSchema: z.ZodObject<{
    intent: z.ZodOptional<z.ZodString>;
    fastPath: z.ZodOptional<z.ZodString>;
    groupReview: z.ZodOptional<z.ZodString>;
    synthesis: z.ZodOptional<z.ZodString>;
    visualize: z.ZodOptional<z.ZodString>;
}, "strict", z.ZodTypeAny, {
    intent?: string | undefined;
    fastPath?: string | undefined;
    groupReview?: string | undefined;
    synthesis?: string | undefined;
    visualize?: string | undefined;
}, {
    intent?: string | undefined;
    fastPath?: string | undefined;
    groupReview?: string | undefined;
    synthesis?: string | undefined;
    visualize?: string | undefined;
}>;
export type ModelRole = keyof z.infer<typeof modelStageSchema>;
export declare const MODEL_ROLES: ModelRole[];
/**
 * Every provider FiscalCR can talk to. The single source for the config enum
 * and the factory's validation; per-provider behavior lives in
 * `PROVIDER_DEFAULTS` (`src/providers/factory.ts`) and release models in
 * `src/config/provider-models.ts`.
 */
export declare const PROVIDERS: readonly ["openai-compatible", "openrouter", "kimi", "openai", "anthropic"];
/** Providers with no release-pinned models, which therefore require `model`. */
export declare const PROVIDERS_REQUIRING_MODEL: ("openai-compatible" | "openrouter" | "kimi" | "openai" | "anthropic")[];
export declare const reviewConfigSchema: z.ZodObject<{
    language: z.ZodDefault<z.ZodEnum<["en", "zh-TW", "zh-CN", "ja", "ko"]>>;
    provider: z.ZodDefault<z.ZodEnum<["openai-compatible", "openrouter", "kimi", "openai", "anthropic"]>>;
    /**
     * Advanced override. Unset → the release-pinned models for `provider` (see
     * `src/config/provider-models.ts`), so upgrading FiscalCR upgrades models
     * together with the prompts tuned for them. When set, pins every stage
     * without an explicit `models.<stage>`. Required for `openai-compatible`.
     */
    model: z.ZodOptional<z.ZodString>;
    /**
     * Per-stage model overrides. `intent` drives the Pass 1 intent call,
     * `fastPath` the fast-path combined call, `groupReview` the per-group file
     * reviews, `synthesis` the final synthesis call, and `visualize` the optional
     * visualization call. An unset stage falls back to `model`, then to the
     * provider's release-pinned model.
     */
    models: z.ZodDefault<z.ZodObject<{
        intent: z.ZodOptional<z.ZodString>;
        fastPath: z.ZodOptional<z.ZodString>;
        groupReview: z.ZodOptional<z.ZodString>;
        synthesis: z.ZodOptional<z.ZodString>;
        visualize: z.ZodOptional<z.ZodString>;
    }, "strict", z.ZodTypeAny, {
        intent?: string | undefined;
        fastPath?: string | undefined;
        groupReview?: string | undefined;
        synthesis?: string | undefined;
        visualize?: string | undefined;
    }, {
        intent?: string | undefined;
        fastPath?: string | undefined;
        groupReview?: string | undefined;
        synthesis?: string | undefined;
        visualize?: string | undefined;
    }>>;
    baseUrl: z.ZodOptional<z.ZodString>;
    /** Custom User-Agent for endpoints that whitelist clients. */
    userAgent: z.ZodOptional<z.ZodString>;
    /** Sampling temperature override. Unset → 0.3, except models that pin their own. */
    temperature: z.ZodOptional<z.ZodNumber>;
    /**
     * Provider-native request fields merged into every LLM call. Typed fields are
     * validated; all other keys pass through verbatim (future-proof). Pipeline-
     * managed keys are stripped by the selected provider adapter.
     */
    modelParams: z.ZodOptional<z.ZodObject<{
        reasoning_effort: z.ZodOptional<z.ZodEnum<["none", "minimal", "low", "medium", "high", "xhigh", "max"]>>;
        verbosity: z.ZodOptional<z.ZodEnum<["low", "medium", "high"]>>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        reasoning_effort: z.ZodOptional<z.ZodEnum<["none", "minimal", "low", "medium", "high", "xhigh", "max"]>>;
        verbosity: z.ZodOptional<z.ZodEnum<["low", "medium", "high"]>>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        reasoning_effort: z.ZodOptional<z.ZodEnum<["none", "minimal", "low", "medium", "high", "xhigh", "max"]>>;
        verbosity: z.ZodOptional<z.ZodEnum<["low", "medium", "high"]>>;
    }, z.ZodTypeAny, "passthrough">>>;
    /**
     * Prompt-cache lifetime for the (config-stable) system prompt. `1h` costs
     * 2x base input per write but survives gaps between pushes; `5m` costs
     * 1.25x per write; `off` sends no cache hint. Omitted → the provider
     * default (see PROVIDER_DEFAULTS in `src/providers/factory.ts`):
     * - anthropic, openrouter: `1h`, sent as `cache_control`
     * - openai: on, sent as GPT-5.6+ explicit breakpoints (OpenAI's fixed 30m
     *   lifetime; `off` sends explicit mode with no breakpoint)
     * - kimi: none (implicit 5m caching); set it to send `prompt_cache_options`
     * - openai-compatible: none; set it to send `cache_control`
     */
    promptCache: z.ZodOptional<z.ZodEnum<["1h", "5m", "off"]>>;
    /** Enables opt-in prompt optimizations that may change between releases. */
    experimental: z.ZodDefault<z.ZodBoolean>;
    review: z.ZodDefault<z.ZodObject<{
        auto: z.ZodDefault<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            onOpen: z.ZodDefault<z.ZodBoolean>;
            onPush: z.ZodDefault<z.ZodBoolean>;
            onReviewRequest: z.ZodDefault<z.ZodBoolean>;
            drafts: z.ZodDefault<z.ZodBoolean>;
        }, "strip", z.ZodTypeAny, {
            enabled: boolean;
            onOpen: boolean;
            onPush: boolean;
            onReviewRequest: boolean;
            drafts: boolean;
        }, {
            enabled?: boolean | undefined;
            onOpen?: boolean | undefined;
            onPush?: boolean | undefined;
            onReviewRequest?: boolean | undefined;
            drafts?: boolean | undefined;
        }>>;
        aspects: z.ZodDefault<z.ZodObject<{
            bugs: z.ZodDefault<z.ZodBoolean>;
            security: z.ZodDefault<z.ZodBoolean>;
            performance: z.ZodDefault<z.ZodBoolean>;
            style: z.ZodDefault<z.ZodBoolean>;
            bestPractices: z.ZodDefault<z.ZodBoolean>;
            documentation: z.ZodDefault<z.ZodBoolean>;
            testing: z.ZodDefault<z.ZodBoolean>;
        }, "strip", z.ZodTypeAny, {
            bugs: boolean;
            security: boolean;
            performance: boolean;
            style: boolean;
            bestPractices: boolean;
            documentation: boolean;
            testing: boolean;
        }, {
            bugs?: boolean | undefined;
            security?: boolean | undefined;
            performance?: boolean | undefined;
            style?: boolean | undefined;
            bestPractices?: boolean | undefined;
            documentation?: boolean | undefined;
            testing?: boolean | undefined;
        }>>;
        visualize: z.ZodDefault<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            mode: z.ZodDefault<z.ZodEnum<["auto", "concept", "implementation"]>>;
            /** Maximum completion tokens for the visualization call. */
            maxOutputTokens: z.ZodDefault<z.ZodNumber>;
            /** Minimum reviewable changed files before visualization generation. */
            minChangedFiles: z.ZodDefault<z.ZodNumber>;
            /** Minimum additions plus deletions before visualization generation. */
            minChangedLines: z.ZodDefault<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            enabled: boolean;
            mode: "auto" | "concept" | "implementation";
            maxOutputTokens: number;
            minChangedFiles: number;
            minChangedLines: number;
        }, {
            enabled?: boolean | undefined;
            mode?: "auto" | "concept" | "implementation" | undefined;
            maxOutputTokens?: number | undefined;
            minChangedFiles?: number | undefined;
            minChangedLines?: number | undefined;
        }>>;
        minSeverity: z.ZodDefault<z.ZodEnum<["critical", "warning", "suggestion", "nitpick"]>>;
        maxAnnotations: z.ZodDefault<z.ZodNumber>;
        failOn: z.ZodDefault<z.ZodEnum<["critical", "warning", "never"]>>;
        incremental: z.ZodDefault<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            /** Deltas touching more files than this fall back to a full review. */
            maxDeltaFiles: z.ZodDefault<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            enabled: boolean;
            maxDeltaFiles: number;
        }, {
            enabled?: boolean | undefined;
            maxDeltaFiles?: number | undefined;
        }>>;
        comments: z.ZodDefault<z.ZodObject<{
            /** 'sticky': one updated summary + incremental reviews. 'legacy': stack a full review per run. */
            mode: z.ZodDefault<z.ZodEnum<["sticky", "legacy"]>>;
            dedupe: z.ZodDefault<z.ZodBoolean>;
            resolveOutdated: z.ZodDefault<z.ZodBoolean>;
            /** Cumulative inline-comment cap; overflow demotes to check-run annotations. */
            maxOpenComments: z.ZodDefault<z.ZodNumber>;
        }, "strip", z.ZodTypeAny, {
            mode: "sticky" | "legacy";
            dedupe: boolean;
            resolveOutdated: boolean;
            maxOpenComments: number;
        }, {
            mode?: "sticky" | "legacy" | undefined;
            dedupe?: boolean | undefined;
            resolveOutdated?: boolean | undefined;
            maxOpenComments?: number | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        visualize: {
            enabled: boolean;
            mode: "auto" | "concept" | "implementation";
            maxOutputTokens: number;
            minChangedFiles: number;
            minChangedLines: number;
        };
        auto: {
            enabled: boolean;
            onOpen: boolean;
            onPush: boolean;
            onReviewRequest: boolean;
            drafts: boolean;
        };
        aspects: {
            bugs: boolean;
            security: boolean;
            performance: boolean;
            style: boolean;
            bestPractices: boolean;
            documentation: boolean;
            testing: boolean;
        };
        minSeverity: "critical" | "warning" | "suggestion" | "nitpick";
        maxAnnotations: number;
        failOn: "critical" | "warning" | "never";
        incremental: {
            enabled: boolean;
            maxDeltaFiles: number;
        };
        comments: {
            mode: "sticky" | "legacy";
            dedupe: boolean;
            resolveOutdated: boolean;
            maxOpenComments: number;
        };
    }, {
        visualize?: {
            enabled?: boolean | undefined;
            mode?: "auto" | "concept" | "implementation" | undefined;
            maxOutputTokens?: number | undefined;
            minChangedFiles?: number | undefined;
            minChangedLines?: number | undefined;
        } | undefined;
        auto?: {
            enabled?: boolean | undefined;
            onOpen?: boolean | undefined;
            onPush?: boolean | undefined;
            onReviewRequest?: boolean | undefined;
            drafts?: boolean | undefined;
        } | undefined;
        aspects?: {
            bugs?: boolean | undefined;
            security?: boolean | undefined;
            performance?: boolean | undefined;
            style?: boolean | undefined;
            bestPractices?: boolean | undefined;
            documentation?: boolean | undefined;
            testing?: boolean | undefined;
        } | undefined;
        minSeverity?: "critical" | "warning" | "suggestion" | "nitpick" | undefined;
        maxAnnotations?: number | undefined;
        failOn?: "critical" | "warning" | "never" | undefined;
        incremental?: {
            enabled?: boolean | undefined;
            maxDeltaFiles?: number | undefined;
        } | undefined;
        comments?: {
            mode?: "sticky" | "legacy" | undefined;
            dedupe?: boolean | undefined;
            resolveOutdated?: boolean | undefined;
            maxOpenComments?: number | undefined;
        } | undefined;
    }>>;
    files: z.ZodDefault<z.ZodObject<{
        include: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        exclude: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        maxFileSize: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        include: string[];
        exclude: string[];
        maxFileSize: number;
    }, {
        include?: string[] | undefined;
        exclude?: string[] | undefined;
        maxFileSize?: number | undefined;
    }>>;
    rules: z.ZodDefault<z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        description: z.ZodString;
        filePattern: z.ZodOptional<z.ZodString>;
        severity: z.ZodDefault<z.ZodEnum<["critical", "warning", "suggestion"]>>;
    }, "strip", z.ZodTypeAny, {
        name: string;
        description: string;
        severity: "critical" | "warning" | "suggestion";
        filePattern?: string | undefined;
    }, {
        name: string;
        description: string;
        filePattern?: string | undefined;
        severity?: "critical" | "warning" | "suggestion" | undefined;
    }>, "many">>;
    prompt: z.ZodDefault<z.ZodObject<{
        systemAppend: z.ZodOptional<z.ZodString>;
        reviewFocus: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        systemAppend?: string | undefined;
        reviewFocus?: string | undefined;
    }, {
        systemAppend?: string | undefined;
        reviewFocus?: string | undefined;
    }>>;
    pipeline: z.ZodDefault<z.ZodObject<{
        /** false → single-call review regardless of PR size (legacy behavior). */
        enabled: z.ZodDefault<z.ZodBoolean>;
        concurrency: z.ZodDefault<z.ZodNumber>;
        groupTokenBudget: z.ZodDefault<z.ZodNumber>;
        relatedContextBudget: z.ZodDefault<z.ZodNumber>;
        maxGroups: z.ZodDefault<z.ZodNumber>;
        /**
         * PRs estimated below this use one combined call. Keep it at least
         * `groupTokenBudget`: a smaller PR would fit one group anyway, so
         * multi-pass would only add an intent call.
         */
        fastPathThreshold: z.ZodDefault<z.ZodNumber>;
        minConfidence: z.ZodDefault<z.ZodNumber>;
        maxRetries: z.ZodDefault<z.ZodNumber>;
        callTimeoutMs: z.ZodOptional<z.ZodNumber>;
        maxOutputTokens: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        enabled: boolean;
        concurrency: number;
        groupTokenBudget: number;
        relatedContextBudget: number;
        maxGroups: number;
        fastPathThreshold: number;
        minConfidence: number;
        maxRetries: number;
        maxOutputTokens?: number | undefined;
        callTimeoutMs?: number | undefined;
    }, {
        enabled?: boolean | undefined;
        maxOutputTokens?: number | undefined;
        concurrency?: number | undefined;
        groupTokenBudget?: number | undefined;
        relatedContextBudget?: number | undefined;
        maxGroups?: number | undefined;
        fastPathThreshold?: number | undefined;
        minConfidence?: number | undefined;
        maxRetries?: number | undefined;
        callTimeoutMs?: number | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    provider: "openai-compatible" | "openrouter" | "kimi" | "openai" | "anthropic";
    language: "en" | "zh-TW" | "zh-CN" | "ja" | "ko";
    models: {
        intent?: string | undefined;
        fastPath?: string | undefined;
        groupReview?: string | undefined;
        synthesis?: string | undefined;
        visualize?: string | undefined;
    };
    experimental: boolean;
    review: {
        visualize: {
            enabled: boolean;
            mode: "auto" | "concept" | "implementation";
            maxOutputTokens: number;
            minChangedFiles: number;
            minChangedLines: number;
        };
        auto: {
            enabled: boolean;
            onOpen: boolean;
            onPush: boolean;
            onReviewRequest: boolean;
            drafts: boolean;
        };
        aspects: {
            bugs: boolean;
            security: boolean;
            performance: boolean;
            style: boolean;
            bestPractices: boolean;
            documentation: boolean;
            testing: boolean;
        };
        minSeverity: "critical" | "warning" | "suggestion" | "nitpick";
        maxAnnotations: number;
        failOn: "critical" | "warning" | "never";
        incremental: {
            enabled: boolean;
            maxDeltaFiles: number;
        };
        comments: {
            mode: "sticky" | "legacy";
            dedupe: boolean;
            resolveOutdated: boolean;
            maxOpenComments: number;
        };
    };
    files: {
        include: string[];
        exclude: string[];
        maxFileSize: number;
    };
    rules: {
        name: string;
        description: string;
        severity: "critical" | "warning" | "suggestion";
        filePattern?: string | undefined;
    }[];
    prompt: {
        systemAppend?: string | undefined;
        reviewFocus?: string | undefined;
    };
    pipeline: {
        enabled: boolean;
        concurrency: number;
        groupTokenBudget: number;
        relatedContextBudget: number;
        maxGroups: number;
        fastPathThreshold: number;
        minConfidence: number;
        maxRetries: number;
        maxOutputTokens?: number | undefined;
        callTimeoutMs?: number | undefined;
    };
    model?: string | undefined;
    baseUrl?: string | undefined;
    userAgent?: string | undefined;
    temperature?: number | undefined;
    modelParams?: z.objectOutputType<{
        reasoning_effort: z.ZodOptional<z.ZodEnum<["none", "minimal", "low", "medium", "high", "xhigh", "max"]>>;
        verbosity: z.ZodOptional<z.ZodEnum<["low", "medium", "high"]>>;
    }, z.ZodTypeAny, "passthrough"> | undefined;
    promptCache?: "1h" | "5m" | "off" | undefined;
}, {
    provider?: "openai-compatible" | "openrouter" | "kimi" | "openai" | "anthropic" | undefined;
    model?: string | undefined;
    language?: "en" | "zh-TW" | "zh-CN" | "ja" | "ko" | undefined;
    models?: {
        intent?: string | undefined;
        fastPath?: string | undefined;
        groupReview?: string | undefined;
        synthesis?: string | undefined;
        visualize?: string | undefined;
    } | undefined;
    baseUrl?: string | undefined;
    userAgent?: string | undefined;
    temperature?: number | undefined;
    modelParams?: z.objectInputType<{
        reasoning_effort: z.ZodOptional<z.ZodEnum<["none", "minimal", "low", "medium", "high", "xhigh", "max"]>>;
        verbosity: z.ZodOptional<z.ZodEnum<["low", "medium", "high"]>>;
    }, z.ZodTypeAny, "passthrough"> | undefined;
    promptCache?: "1h" | "5m" | "off" | undefined;
    experimental?: boolean | undefined;
    review?: {
        visualize?: {
            enabled?: boolean | undefined;
            mode?: "auto" | "concept" | "implementation" | undefined;
            maxOutputTokens?: number | undefined;
            minChangedFiles?: number | undefined;
            minChangedLines?: number | undefined;
        } | undefined;
        auto?: {
            enabled?: boolean | undefined;
            onOpen?: boolean | undefined;
            onPush?: boolean | undefined;
            onReviewRequest?: boolean | undefined;
            drafts?: boolean | undefined;
        } | undefined;
        aspects?: {
            bugs?: boolean | undefined;
            security?: boolean | undefined;
            performance?: boolean | undefined;
            style?: boolean | undefined;
            bestPractices?: boolean | undefined;
            documentation?: boolean | undefined;
            testing?: boolean | undefined;
        } | undefined;
        minSeverity?: "critical" | "warning" | "suggestion" | "nitpick" | undefined;
        maxAnnotations?: number | undefined;
        failOn?: "critical" | "warning" | "never" | undefined;
        incremental?: {
            enabled?: boolean | undefined;
            maxDeltaFiles?: number | undefined;
        } | undefined;
        comments?: {
            mode?: "sticky" | "legacy" | undefined;
            dedupe?: boolean | undefined;
            resolveOutdated?: boolean | undefined;
            maxOpenComments?: number | undefined;
        } | undefined;
    } | undefined;
    files?: {
        include?: string[] | undefined;
        exclude?: string[] | undefined;
        maxFileSize?: number | undefined;
    } | undefined;
    rules?: {
        name: string;
        description: string;
        filePattern?: string | undefined;
        severity?: "critical" | "warning" | "suggestion" | undefined;
    }[] | undefined;
    prompt?: {
        systemAppend?: string | undefined;
        reviewFocus?: string | undefined;
    } | undefined;
    pipeline?: {
        enabled?: boolean | undefined;
        maxOutputTokens?: number | undefined;
        concurrency?: number | undefined;
        groupTokenBudget?: number | undefined;
        relatedContextBudget?: number | undefined;
        maxGroups?: number | undefined;
        fastPathThreshold?: number | undefined;
        minConfidence?: number | undefined;
        maxRetries?: number | undefined;
        callTimeoutMs?: number | undefined;
    } | undefined;
}>;
export type ReviewConfig = z.infer<typeof reviewConfigSchema>;
/**
 * Resolve the model for a pipeline stage: explicit `models.<role>`, then the
 * top-level `model` override, then the provider's release-pinned stage model.
 * With a `model` override, visualization resolves like the fast path (so an
 * explicit `models.fastPath` still wins); otherwise it falls back to the
 * resolved fast-path model when nothing else resolves. Throws
 * `ConfigError` when nothing resolves (a `PROVIDERS_REQUIRING_MODEL` provider
 * without `model`).
 */
export declare function modelForRole(config: ReviewConfig, role: ModelRole): string;
/**
 * True when `model` or any `models.<stage>` replaces the release-pinned
 * defaults. Providers without defaults (`PROVIDERS_REQUIRING_MODEL`) never
 * override.
 */
export declare function hasModelOverride(config: ReviewConfig): boolean;
//# sourceMappingURL=schema.d.ts.map