import { z } from "zod";

export const reviewConfigSchema = z.object({
  language: z.enum(["en", "zh-TW", "zh-CN", "ja", "ko"]).default("en"),
  provider: z.enum(["openai-compatible", "kimi"]).default("kimi"),
  model: z.string().default("kimi-for-coding"),
  baseUrl: z.string().url().optional(),
  /** Custom User-Agent for endpoints that whitelist clients. */
  userAgent: z.string().max(200).optional(),
  /** Sampling temperature override. Unset → 0.3, except models that pin their own. */
  temperature: z.number().min(0).max(2).optional(),

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
      exclude: z
        .array(z.string())
        .default([
          "**/node_modules/**",
          "**/dist/**",
          "**/build/**",
          "**/*.lock",
          "**/*.min.*",
          "**/package-lock.json",
          "**/yarn.lock",
          "**/pnpm-lock.yaml",
        ]),
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
      maxOutputTokens: z.number().default(16_384),
    })
    .default({}),
});

export type ReviewConfig = z.infer<typeof reviewConfigSchema>;
