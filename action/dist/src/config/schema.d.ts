import { z } from "zod";
export declare const reviewConfigSchema: z.ZodObject<{
    language: z.ZodDefault<z.ZodEnum<["en", "zh-TW", "zh-CN", "ja", "ko"]>>;
    provider: z.ZodDefault<z.ZodEnum<["openai-compatible", "kimi"]>>;
    model: z.ZodDefault<z.ZodString>;
    baseUrl: z.ZodOptional<z.ZodString>;
    /** Custom User-Agent for endpoints that whitelist clients. */
    userAgent: z.ZodOptional<z.ZodString>;
    /** Sampling temperature override. Unset → 0.3, except models that pin their own. */
    temperature: z.ZodOptional<z.ZodNumber>;
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
        fastPathThreshold: z.ZodDefault<z.ZodNumber>;
        minConfidence: z.ZodDefault<z.ZodNumber>;
        maxRetries: z.ZodDefault<z.ZodNumber>;
        callTimeoutMs: z.ZodDefault<z.ZodNumber>;
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
        callTimeoutMs: number;
        maxOutputTokens?: number | undefined;
    }, {
        enabled?: boolean | undefined;
        concurrency?: number | undefined;
        groupTokenBudget?: number | undefined;
        relatedContextBudget?: number | undefined;
        maxGroups?: number | undefined;
        fastPathThreshold?: number | undefined;
        minConfidence?: number | undefined;
        maxRetries?: number | undefined;
        callTimeoutMs?: number | undefined;
        maxOutputTokens?: number | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    provider: "openai-compatible" | "kimi";
    model: string;
    language: "en" | "zh-TW" | "zh-CN" | "ja" | "ko";
    review: {
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
        callTimeoutMs: number;
        maxOutputTokens?: number | undefined;
    };
    baseUrl?: string | undefined;
    userAgent?: string | undefined;
    temperature?: number | undefined;
}, {
    provider?: "openai-compatible" | "kimi" | undefined;
    model?: string | undefined;
    language?: "en" | "zh-TW" | "zh-CN" | "ja" | "ko" | undefined;
    baseUrl?: string | undefined;
    userAgent?: string | undefined;
    temperature?: number | undefined;
    review?: {
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
        concurrency?: number | undefined;
        groupTokenBudget?: number | undefined;
        relatedContextBudget?: number | undefined;
        maxGroups?: number | undefined;
        fastPathThreshold?: number | undefined;
        minConfidence?: number | undefined;
        maxRetries?: number | undefined;
        callTimeoutMs?: number | undefined;
        maxOutputTokens?: number | undefined;
    } | undefined;
}>;
export type ReviewConfig = z.infer<typeof reviewConfigSchema>;
//# sourceMappingURL=schema.d.ts.map