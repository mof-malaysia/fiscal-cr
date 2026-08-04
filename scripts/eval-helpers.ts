import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import type { ReviewConfig } from '../src/config/schema.js';
import { buildFastPathSystemPrompt, buildFastPathUserPrompt } from '../src/pipeline/prompts.js';
import { estimateTokens } from '../src/utils/tokens.js';
import { SUPPORTED_PROVIDERS } from '../src/providers/factory.js';
import type { PullRequestContext } from '../src/types/review.js';

/**
 * Pure helpers for the local LLM eval harness (scripts/eval-llm.ts).
 * Kept free of network/side effects so they are unit-testable.
 */

export interface EvalEnvConfig {
  /** Resolved from env but never printed or logged. */
  apiKey?: string;
  provider: string;
  model: string;
  baseUrl?: string;
  userAgent?: string;
}

/**
 * Resolve harness settings from the environment.
 *
 * - API_KEY, falling back to FISCALCR_API_KEY, then KIMI_API_KEY
 * - MODEL_PROVIDER, falling back to DEFAULT_CONFIG.provider
 * - MODEL, falling back to KIMI_MODEL, then DEFAULT_CONFIG.model
 * - BASE_URL, falling back to FISCALCR_BASE_URL (optional)
 * - LLM_USER_AGENT (optional)
 *
 * Empty-string env values are treated as unset. No secret files are ever
 * loaded or parsed — environment only (a Makefile-loaded .env arrives here as
 * ordinary env vars, indistinguishable from shell exports).
 */
export function resolveEvalEnv(env: NodeJS.ProcessEnv): EvalEnvConfig {
  const provider = env.MODEL_PROVIDER || DEFAULT_CONFIG.provider;
  if (!(SUPPORTED_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(
      `Invalid MODEL_PROVIDER "${provider}". Supported: ${SUPPORTED_PROVIDERS.join(', ')}`,
    );
  }
  return {
    apiKey: env.API_KEY || env.FISCALCR_API_KEY || env.KIMI_API_KEY,
    provider,
    model: env.MODEL || env.KIMI_MODEL || DEFAULT_CONFIG.model,
    baseUrl: env.BASE_URL || env.FISCALCR_BASE_URL || undefined,
    userAgent: env.LLM_USER_AGENT || undefined,
  };
}

/** Live mode requires a key; dry-run never calls this. */
export function requireApiKey(cfg: EvalEnvConfig): string {
  if (!cfg.apiKey) {
    throw new Error(
      'Live LLM eval requires an API key. Export API_KEY (or FISCALCR_API_KEY / ' +
        'KIMI_API_KEY) in your shell — never paste it into chat or commit it. ' +
        'Use `make eval-llm-dry` for a keyless, network-free run.',
    );
  }
  return cfg.apiKey;
}

/** Build the ReviewConfig used for one eval run (baseline or experimental). */
export function evalReviewConfig(cfg: EvalEnvConfig, experimental: boolean): ReviewConfig {
  return {
    ...DEFAULT_CONFIG,
    provider: cfg.provider as ReviewConfig['provider'],
    model: cfg.model,
    ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
    ...(cfg.userAgent ? { userAgent: cfg.userAgent } : {}),
    experimental,
  };
}

export interface PromptReport {
  experimental: boolean;
  systemChars: number;
  userChars: number;
  totalChars: number;
  estimatedTokens: number;
  hasConcisionRules: boolean;
}

/** Build the real fast-path system+user prompts and measure them (no network). */
export function buildPromptReport(
  config: ReviewConfig,
  ctx: PullRequestContext,
): PromptReport {
  const system = buildFastPathSystemPrompt(config);
  const user = buildFastPathUserPrompt(ctx, ctx.changedFiles);
  return {
    experimental: config.experimental,
    systemChars: system.length,
    userChars: user.length,
    totalChars: system.length + user.length,
    estimatedTokens: estimateTokens(system) + estimateTokens(user),
    hasConcisionRules: system.includes('Concision Rules'),
  };
}

export interface RunStats {
  experimental: boolean;
  durationMs: number;
  input: number;
  output: number;
  cached: number;
  calls: number;
  score: number;
  findings: number;
}

export function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function signedDuration(ms: number): string {
  const sign = ms > 0 ? '+' : ms < 0 ? '-' : '';
  return `${sign}${formatDuration(Math.abs(ms))}`;
}

function signedNumber(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

/** Compact experimental-vs-baseline delta line block. */
export function formatDelta(base: RunStats, experimental: RunStats): string {
  return [
    'Delta (experimental − baseline):',
    `  duration   ${signedDuration(experimental.durationMs - base.durationMs)}`,
    `  input      ${signedNumber(experimental.input - base.input)} tokens`,
    `  output     ${signedNumber(experimental.output - base.output)} tokens`,
    `  cached     ${signedNumber(experimental.cached - base.cached)} tokens`,
    `  calls      ${signedNumber(experimental.calls - base.calls)}`,
    `  score      ${signedNumber(experimental.score - base.score)}`,
    `  findings   ${signedNumber(experimental.findings - base.findings)}`,
  ].join('\n');
}
