import type { ReviewConfig } from "./schema.js";

export const DEFAULT_CONFIG: ReviewConfig = {
  language: "en",
  provider: "kimi",
  model: "kimi-for-coding",
  review: {
    auto: {
      enabled: true,
      onOpen: true,
      onPush: true,
      onReviewRequest: true,
      drafts: false,
    },
    aspects: {
      bugs: true,
      security: true,
      performance: true,
      style: true,
      bestPractices: true,
      documentation: false,
      testing: false,
    },
    minSeverity: "suggestion",
    maxAnnotations: 30,
    failOn: "critical",
    incremental: {
      enabled: true,
      maxDeltaFiles: 150,
    },
    comments: {
      mode: "sticky",
      dedupe: true,
      resolveOutdated: true,
      maxOpenComments: 100,
    },
  },
  files: {
    include: ["**/*"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/*.lock",
      "**/*.min.*",
      "**/package-lock.json",
      "**/yarn.lock",
      "**/pnpm-lock.yaml",
    ],
    maxFileSize: 100_000,
  },
  rules: [],
  prompt: {},
  pipeline: {
    enabled: true,
    concurrency: 3,
    groupTokenBudget: 40_000,
    relatedContextBudget: 15_000,
    maxGroups: 8,
    fastPathThreshold: 25_000,
    minConfidence: 0.6,
    maxRetries: 3,
    callTimeoutMs: 120_000,
    // maxOutputTokens omitted → resolved per model (see reviewMaxOutputTokens).
  },
};
