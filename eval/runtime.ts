import { execFileSync } from 'node:child_process';
import type { LLMProvider } from '../src/providers/interface.js';
import type { ReviewConfig } from '../src/config/schema.js';
import type { PullRequestContext, ReviewResult } from '../src/types/review.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { createLLMProvider, SUPPORTED_PROVIDERS } from '../src/providers/factory.js';
import { runFastPath } from '../src/pipeline/fast-path.js';
import { UsageTracker } from '../src/pipeline/usage.js';
import {
  buildFastPathSystemPrompt,
  buildFastPathUserPrompt,
} from '../src/pipeline/prompts.js';
import { estimateTokens } from '../src/utils/tokens.js';
import { wrapCapturingProvider, type CapturedCall } from './metrics.js';
import { buildRunMetrics, captureFromResponse } from './metrics.js';
import { evaluateRunQuality } from './quality.js';
import {
  caseIdentityOf,
  completedAttempt,
  failedAttempt,
  planIdentityOf,
  promptMetadata,
  sanitizeError,
  sha256Hex,
  type Attempt,
  type PromptMetadata,
} from './benchmark.js';
import type { BenchmarkCase } from './cases.js';
import { variantOrderForCaseRound, type EvalPlan, type PlanEntry } from './plan.js';

/**
 * Injectable execution runtime for the live eval harness.
 *
 * Owns the per-call execution loop (provider creation, capture wrapping,
 * heartbeat, failure tolerance), prompt metadata, and repository metadata.
 * Network only ever happens inside the injected provider — tests inject fake
 * providers and verify continuation, pairing, redaction and timer cleanup
 * without any live call.
 *
 * Secret discipline: every failure is reduced via `sanitizeError` and the
 * message is scrubbed with `redactSecrets` before it is stored in a
 * `FailedAttempt` or printed. Stacks, raw errors, base URLs, headers and API
 * keys never reach the artifact.
 */

export const DEFAULT_CALL_TIMEOUT_MS = 120_000;
export const DEFAULT_RETRIES = 0;
export const HEARTBEAT_MS = 15_000;

// ---------------------------------------------------------------------------
// Key / credential redaction (shared by runtime and console output)

const API_KEY_RE = /\bsk-[A-Za-z0-9*_.-]+/gi;
const URL_USERINFO_RE = /(https?:\/\/)[^@\s/]+@/gi;

/** Scrubs API-key-shaped strings and URL userinfo from text (case-insensitive). */
export function redactSecrets(text: string): string {
  return text
    .replace(API_KEY_RE, '[REDACTED_API_KEY]')
    .replace(URL_USERINFO_RE, '$1[REDACTED]@');
}

// ---------------------------------------------------------------------------
// Env / harness config (pure, keyless, unit-testable)

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

// ---------------------------------------------------------------------------
// Repository metadata (safe best-effort, fixed args, no shell)

export interface RepoMetadata {
  commit: string | null;
  dirty: boolean | null;
}

/**
 * Best-effort git commit + dirty flag via `execFileSync` with fixed args —
 * no shell interpolation, no path/env ever recorded. Any failure (not a git
 * repo, git missing, ENOENT cwd) yields nulls; a dirty working tree is
 * expected and reported as `dirty: true`.
 */
export function gitRepoMetadata(cwd?: string): RepoMetadata {
  try {
    const commit = execFileSync(
      'git',
      ['rev-parse', 'HEAD'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    const status = execFileSync(
      'git',
      ['status', '--porcelain'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return { commit: commit.length > 0 ? commit : null, dirty: status.trim().length > 0 };
  } catch {
    return { commit: null, dirty: null };
  }
}

// ---------------------------------------------------------------------------
// Suite-level prompt metadata (deterministic, per variant)

export interface SuitePromptStats {
  cases: number;
  minChars: number;
  maxChars: number;
  totalChars: number;
  totalEstimatedTokens: number;
}

export interface SuitePromptMetadata {
  metadata: PromptMetadata;
  stats: SuitePromptStats;
}

/**
 * Deterministic suite-level prompt fingerprint for one variant. The hash
 * input concatenates each selected case's `id:version` plus the exact
 * system+user prompt, in the selected (stable) case order; `chars` is the
 * total exact prompt character count across all selected cases. The per-case
 * min/max/total stats feed the dry report (never a single fixture).
 */
export function buildSuitePromptMetadata(
  cases: readonly BenchmarkCase[],
  cfg: EvalEnvConfig,
  experimental: boolean,
): SuitePromptMetadata {
  const parts: string[] = [];
  let totalChars = 0;
  let totalTokens = 0;
  let minChars = Number.POSITIVE_INFINITY;
  let maxChars = 0;
  for (const c of cases) {
    const config = evalReviewConfig(cfg, experimental);
    const system = buildFastPathSystemPrompt(config);
    const user = buildFastPathUserPrompt(c.context, c.context.changedFiles);
    const chars = system.length + user.length;
    parts.push(`${c.id}:${c.version}\n${system}\n${user}\n`);
    totalChars += chars;
    totalTokens += estimateTokens(system) + estimateTokens(user);
    if (chars < minChars) minChars = chars;
    if (chars > maxChars) maxChars = chars;
  }
  return {
    metadata: { sha256: sha256Hex(parts.join('')), chars: totalChars },
    stats: {
      cases: cases.length,
      minChars: cases.length === 0 ? 0 : minChars,
      maxChars,
      totalChars,
      totalEstimatedTokens: totalTokens,
    },
  };
}

// ---------------------------------------------------------------------------
// Per-call execution

export type PipelineRunner = (
  llm: LLMProvider,
  ctx: PullRequestContext,
  config: ReviewConfig,
  usage: UsageTracker,
) => Promise<ReviewResult>;

export interface PairProgressInfo {
  /** 1-based pair number in execution order. */
  pairNumber: number;
  totalPairs: number;
  pairId: string;
  caseId: string;
  roundIndex: number;
  /** Actual variant order for this round (AB / BA pattern). */
  order: readonly string[];
  completed: number;
  failed: number;
  /** True when both variants of the pair completed. */
  complete: boolean;
}

export interface ExecutePlanOptions {
  apiKey: string;
  /** Injectable provider factory (tests use fakes; default hits the network). */
  providerFactory?: (config: ReviewConfig) => LLMProvider;
  /** Injectable pipeline runner; defaults to the real runFastPath. */
  pipeline?: PipelineRunner;
  /** Per-call timeout in ms (default 120s). */
  timeoutMs?: number;
  /** Provider retries (default 0 — failures surface immediately). */
  retries?: number;
  /** Heartbeat interval (default 15s). */
  heartbeatMs?: number;
  onProgress?: (line: string) => void;
  /** Called after every attempt with its full outcome (for console output). */
  onAttempt?: (attempt: Attempt, callNumber: number, totalCalls: number) => void;
  /** Called once a pair's second entry completes (complete/partial). */
  onPairProgress?: (info: PairProgressInfo) => void;
}

export interface ExecutePlanResult {
  attempts: Attempt[];
}

function defaultProviderFactory(apiKey: string): (config: ReviewConfig) => LLMProvider {
  return (config) =>
    createLLMProvider({
      apiKey,
      model: config.model,
      baseUrl: config.baseUrl,
      provider: config.provider,
      userAgent: config.userAgent,
      retry: { maxRetries: 0 },
    });
}

/** 0/1 position of an entry within its pair's variant order. */
function pairRunIndex(entry: PlanEntry): number {
  return variantOrderForCaseRound(entry.roundIndex).indexOf(entry.variant);
}

/**
 * Executes every plan entry in planner order, tolerating per-call failures.
 * Each entry uses its matching case context and the real baseline/experimental
 * prompt config. Heartbeats and the per-call timer are always cleaned up in a
 * `finally`. A failed call is recorded as a sanitized `FailedAttempt` and the
 * plan continues; the caller decides what counts as fatal.
 */
export async function executePlan(
  plan: EvalPlan,
  cases: readonly BenchmarkCase[],
  cfg: EvalEnvConfig,
  options: ExecutePlanOptions,
): Promise<ExecutePlanResult> {
  const providerFactory = options.providerFactory ?? defaultProviderFactory(options.apiKey);
  const pipeline = options.pipeline ?? runFastPath;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;

  const caseById = new Map(cases.map((c) => [c.id, c]));
  const attempts: Attempt[] = [];
  const total = plan.plannedCalls;
  const totalPairs = Math.ceil(total / 2);

  for (const entry of plan.entries) {
    const c = caseById.get(entry.caseId);
    if (!c) {
      throw new Error(`Plan references unknown case "${entry.caseId}"`);
    }

    // Real baseline/experimental prompt config for this entry, with the
    // harness's fixed timeout/retry overrides.
    const config = evalReviewConfig(cfg, entry.experimental);
    config.pipeline.callTimeoutMs = timeoutMs;
    config.pipeline.maxRetries = retries;

    const captures: CapturedCall[] = [];
    const provider = wrapCapturingProvider(providerFactory(config), (info) => {
      captures.push(captureFromResponse(info.response, info.order, info.durationMs));
    });
    const usage = new UsageTracker();

    const callNumber = entry.globalCallIndex + 1;
    const tag = `[call ${callNumber}/${total}][${entry.caseId} r${entry.roundIndex}] ${entry.variant}`;
    const requestTimestamp = new Date().toISOString();
    const startedAt = Date.now();
    const progress = (line: string): void => options.onProgress?.(line);

    progress(`${tag}  start  (timeout ${formatDuration(timeoutMs)}, retries ${retries})`);

    const heartbeat = setInterval(() => {
      progress(`${tag}  wait   ${formatDuration(Date.now() - startedAt)}`);
    }, heartbeatMs);

    let pairSlotResult: 'completed' | 'failed';
    try {
      const result = await pipeline(provider, c.context, config, usage);
      const durationMs = Date.now() - startedAt;
      const metrics = buildRunMetrics({
        experimental: entry.experimental,
        pairIndex: entry.roundIndex,
        runIndex: pairRunIndex(entry),
        durationMs,
        tokens: usage.total(),
        calls: usage.calls(),
        captures,
        result,
        changedFilePaths: c.context.changedFiles.map((f) => f.filename),
      });
      const quality = evaluateRunQuality({
        case: c,
        generatedFindings: metrics.findings,
        retainedFindings: result.annotations,
        outputTokens: metrics.outputTokens,
      });
      const attempt = completedAttempt({
        identity: planIdentityOf(entry),
        case: caseIdentityOf(c),
        requestTimestamp,
        metrics,
        quality,
      });
      attempts.push(attempt);
      pairSlotResult = 'completed';
      progress(`${tag}  done   ${formatDuration(durationMs)}`);
      options.onAttempt?.(attempt, callNumber, total);
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const sanitized = sanitizeError(err);
      sanitized.message = redactSecrets(sanitized.message);
      const attempt = failedAttempt({
        identity: planIdentityOf(entry),
        case: caseIdentityOf(c),
        requestTimestamp,
        durationMs,
        error: sanitized,
      });
      attempts.push(attempt);
      pairSlotResult = 'failed';
      progress(`${tag}  FAIL   (${attempt.error.code}) ${attempt.error.message}  [${formatDuration(durationMs)}]`);
      options.onAttempt?.(attempt, callNumber, total);
    } finally {
      clearInterval(heartbeat);
    }

    // Pair progress fires after the second entry of a pair (entries are
    // ordered baseline+experimental per case within a round).
    if (entry.globalCallIndex % 2 === 1) {
      const pairNumber = Math.floor(entry.globalCallIndex / 2) + 1;
      const completed = attempts.filter(
        (a) => a.identity.pairId === entry.pairId && a.status === 'completed',
      ).length;
      const failed = attempts.filter(
        (a) => a.identity.pairId === entry.pairId && a.status === 'failed',
      ).length;
      options.onPairProgress?.({
        pairNumber,
        totalPairs,
        pairId: entry.pairId,
        caseId: entry.caseId,
        roundIndex: entry.roundIndex,
        order: variantOrderForCaseRound(entry.roundIndex),
        completed,
        failed,
        complete: completed === 2,
      });
    }
  }

  return { attempts };
}

export type { Attempt, PromptMetadata };
