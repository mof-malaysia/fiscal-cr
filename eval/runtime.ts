import { execFileSync } from 'node:child_process';
import type { LLMProvider } from '../src/providers/interface.js';
import type { ReviewConfig } from '../src/config/schema.js';
import type { PullRequestContext, ReviewResult } from '../src/types/review.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { createLLMProvider, SUPPORTED_PROVIDERS } from '../src/providers/factory.js';
import { runReviewPipeline, routeReview } from '../src/pipeline/run-review.js';
import type { RunReviewOptions } from '../src/pipeline/run-review.js';
import { UsageTracker } from '../src/pipeline/usage.js';
import type { TelemetryEvent } from '../src/pipeline/usage.js';
import {
  buildFastPathSystemPrompt,
  buildFastPathUserPrompt,
} from '../src/pipeline/prompts.js';
import { estimateTokens } from '../src/utils/tokens.js';
import {
  wrapCapturingProvider,
  captureFromResponse,
  captureFromError,
  associateCallStages,
  type CapturedCall,
  type CallStage,
  type StageOutcome,
} from './metrics.js';
import { buildRunMetrics } from './metrics.js';
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
 * - API_KEY, falling back to FISCALCR_API_KEY, ANTHROPIC_API_KEY, then KIMI_API_KEY
 * - MODEL_PROVIDER, falling back to DEFAULT_CONFIG.provider
 * - MODEL, falling back to ANTHROPIC_MODEL, KIMI_MODEL, then DEFAULT_CONFIG.model
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
    apiKey: env.API_KEY || env.FISCALCR_API_KEY || env.ANTHROPIC_API_KEY || env.KIMI_API_KEY,
    provider,
    model: env.MODEL || env.ANTHROPIC_MODEL || env.KIMI_MODEL || DEFAULT_CONFIG.model,
    baseUrl: env.BASE_URL || env.FISCALCR_BASE_URL || undefined,
    userAgent: env.LLM_USER_AGENT || undefined,
  };
}

/** Live mode requires a key; dry-run never calls this. */
export function requireApiKey(cfg: EvalEnvConfig): string {
  if (!cfg.apiKey) {
    throw new Error(
      'Live LLM eval requires an API key. Export API_KEY (or FISCALCR_API_KEY / ' +
        'ANTHROPIC_API_KEY / KIMI_API_KEY) in your shell — never paste it into chat or commit it. ' +
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
  /** Actual provider LLM calls per attempt. */
  providerCalls: number;
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
    `  provider calls ${signedNumber(experimental.providerCalls - base.providerCalls)}`,
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
  /** Number of statically buildable fast-path cases included in the preview. */
  cases: number;
  minChars: number;
  maxChars: number;
  totalChars: number;
  totalEstimatedTokens: number;
}

export interface SuitePromptMetadata {
  /**
   * Deterministic suite-level prompt fingerprint for one variant. Only covers
   * statically buildable FAST-PATH prompts (the ones actually sent on that
   * route). Multi-pass cases are excluded — their stage prompts are generated
   * during live execution and fingerprinted per call in the attempt captures.
   */
  metadata: PromptMetadata;
  /** Fast-path-only stats (multi-pass cases are excluded). */
  stats: SuitePromptStats;
  /** Case ids routed multi-pass — no static prompt preview (hashes captured live). */
  dynamicMultiPassCaseIds: string[];
  /** Number of multi-pass cases excluded from the static preview. */
  dynamicMultiPassCount: number;
}

/**
 * Deterministic suite-level prompt fingerprint for one variant, route-aware.
 *
 * For each selected case the production `routeReview` decision (with the eval
 * config) picks the route. Fast-path cases contribute their exact system+user
 * prompt to the hash and stats. Multi-pass cases contribute NO prompt — their
 * stage prompts are built during live execution and fingerprinted per call in
 * the attempt captures (the source of truth for live multi-pass). A
 * pipeline-only selection therefore hashes only the case id:version plus a
 * "no static prompt preview" marker — never a fabricated fast-path prompt —
 * and reports zero fast-path stats.
 */
export function buildSuitePromptMetadata(
  cases: readonly BenchmarkCase[],
  cfg: EvalEnvConfig,
  experimental: boolean,
): SuitePromptMetadata {
  const config = evalReviewConfig(cfg, experimental);
  const parts: string[] = [];
  let totalChars = 0;
  let totalTokens = 0;
  let minChars = Number.POSITIVE_INFINITY;
  let maxChars = 0;
  let fastPathCases = 0;
  const dynamicMultiPassCaseIds: string[] = [];
  for (const c of cases) {
    const route = routeReview(c.context, config).route;
    if (route !== 'fast-path') {
      // No statically buildable prompt: record the case identity with an
      // explicit "no static prompt preview" marker instead of a fabricated
      // fast-path prompt.
      dynamicMultiPassCaseIds.push(c.id);
      parts.push(`${c.id}:${c.version}\n<no-static-prompt-preview:multi-pass>\n`);
      continue;
    }
    const system = buildFastPathSystemPrompt(config);
    const user = buildFastPathUserPrompt(c.context, c.context.changedFiles);
    const chars = system.length + user.length;
    parts.push(`${c.id}:${c.version}\n${system}\n${user}\n`);
    totalChars += chars;
    totalTokens += estimateTokens(system) + estimateTokens(user);
    if (chars < minChars) minChars = chars;
    if (chars > maxChars) maxChars = chars;
    fastPathCases += 1;
  }
  return {
    metadata: { sha256: sha256Hex(parts.join('')), chars: totalChars },
    stats: {
      cases: fastPathCases,
      minChars: fastPathCases === 0 ? 0 : minChars,
      maxChars,
      totalChars,
      totalEstimatedTokens: totalTokens,
    },
    dynamicMultiPassCaseIds,
    dynamicMultiPassCount: dynamicMultiPassCaseIds.length,
  };
}

// ---------------------------------------------------------------------------
// Per-call execution

export type PipelineRunner = (
  llm: LLMProvider,
  ctx: PullRequestContext,
  config: ReviewConfig,
  usage: UsageTracker,
  options?: RunReviewOptions,
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
  /** Injectable pipeline runner; defaults to the real runReviewPipeline. */
  pipeline?: PipelineRunner;
  /**
   * Per-CALL timeout in ms (default 120s) applied to the fast-path and
   * group-review provider calls (they read config.pipeline.callTimeoutMs).
   * It is NOT an attempt-level deadline: the intent and synthesis stages use
   * fixed internal timeouts (60s / 90s) that are not configurable from the
   * harness, and in-flight provider calls are not cancellable.
   */
  callTimeoutMs?: number;
  /** Provider retries (default 0 — failures surface immediately). */
  retries?: number;
  /** Heartbeat interval (default 15s). */
  heartbeatMs?: number;
  onProgress?: (line: string) => void;
  /** Called after every attempt with its full outcome (for console output). */
  onAttempt?: (attempt: Attempt, attemptNumber: number, totalAttempts: number) => void;
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
 * Executes every plan entry in planner order, tolerating per-attempt failures.
 * Each entry runs the PRODUCTION review pipeline (runReviewPipeline) — the
 * pipeline itself decides fast-path vs multi-pass via routeReview — with the
 * matching case context and the real baseline/experimental prompt config.
 * Heartbeats and the per-attempt timer are always cleaned up in a `finally`.
 * A failed attempt is recorded as a sanitized `FailedAttempt` (with the actual
 * provider call count) and the plan continues; the caller decides what counts
 * as fatal.
 */
export async function executePlan(
  plan: EvalPlan,
  cases: readonly BenchmarkCase[],
  cfg: EvalEnvConfig,
  options: ExecutePlanOptions,
): Promise<ExecutePlanResult> {
  const providerFactory = options.providerFactory ?? defaultProviderFactory(options.apiKey);
  const pipeline = options.pipeline ?? runReviewPipeline;
  const callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;

  const caseById = new Map(cases.map((c) => [c.id, c]));
  const attempts: Attempt[] = [];
  const total = plan.plannedAttempts;
  const totalPairs = Math.ceil(total / 2);

  for (const entry of plan.entries) {
    const c = caseById.get(entry.caseId);
    if (!c) {
      throw new Error(`Plan references unknown case "${entry.caseId}"`);
    }

    // Real baseline/experimental prompt config for this entry, with the
    // harness's fixed per-call timeout/retry overrides.
    const config = evalReviewConfig(cfg, entry.experimental);
    config.pipeline.callTimeoutMs = callTimeoutMs;
    config.pipeline.maxRetries = retries;

    // Stage outcomes come from UsageTracker stage events (stage truth), never
    // inferred from response JSON. llm_call events give each call its stage.
    const stageOutcomes: StageOutcome[] = [];
    const callStages: CallStage[] = [];
    const usage = new UsageTracker((event: TelemetryEvent) => {
      if (event.type === 'stage_result') {
        stageOutcomes.push({
          stage: event.stage,
          status: event.status,
          ...(event.groupIndex === undefined ? {} : { groupIndex: event.groupIndex }),
        });
      } else if (event.type === 'llm_call') {
        callStages.push({
          stage: event.stage,
          ...(event.groupIndex === undefined ? {} : { groupIndex: event.groupIndex }),
        });
      }
    });

    const captures: CapturedCall[] = [];
    const provider = wrapCapturingProvider(providerFactory(config), (info) => {
      if (info.error !== undefined) {
        // Sanitize + redact before the failure metadata is ever stored.
        const sanitized = sanitizeError(info.error);
        sanitized.message = redactSecrets(sanitized.message);
        captures.push(captureFromError(sanitized, info.order, info.durationMs, info.request));
      } else {
        captures.push(captureFromResponse(info.response!, info.order, info.durationMs, info.request));
      }
    });

    const attemptNumber = entry.globalCallIndex + 1;
    const tag = `[attempt ${attemptNumber}/${total}][${entry.caseId} r${entry.roundIndex}] ${entry.variant}`;
    const requestTimestamp = new Date().toISOString();
    const startedAt = Date.now();
    const progress = (line: string): void => options.onProgress?.(line);

    progress(`${tag}  start  (${entry.route}, call timeout ${formatDuration(callTimeoutMs)}, retries ${retries})`);

    const heartbeat = setInterval(() => {
      progress(`${tag}  wait   ${formatDuration(Date.now() - startedAt)}`);
    }, heartbeatMs);

    let pairSlotResult: 'completed' | 'failed';
    try {
      const result = await pipeline(provider, c.context, config, usage, {});
      const durationMs = Date.now() - startedAt;
      // Associate each capture with its pipeline stage (llm_call stage truth)
      // so multi-pass generated findings only ever come from group reviews.
      const stageCaptures = associateCallStages(captures, callStages);
      const metrics = buildRunMetrics({
        experimental: entry.experimental,
        pairIndex: entry.roundIndex,
        runIndex: pairRunIndex(entry),
        durationMs,
        tokens: usage.total(),
        providerCalls: usage.calls(),
        captures: stageCaptures,
        result,
        route: entry.route,
        stageOutcomes,
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
      progress(`${tag}  done   ${formatDuration(durationMs)} (${metrics.providerCalls} provider call(s))`);
      options.onAttempt?.(attempt, attemptNumber, total);
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const sanitized = sanitizeError(err);
      sanitized.message = redactSecrets(sanitized.message);
      const attempt = failedAttempt({
        identity: planIdentityOf(entry),
        case: caseIdentityOf(c),
        requestTimestamp,
        durationMs,
        providerCalls: usage.calls(),
        captures: associateCallStages(captures, callStages),
        stageOutcomes,
        error: sanitized,
      });
      attempts.push(attempt);
      pairSlotResult = 'failed';
      progress(`${tag}  FAIL   (${attempt.error.code}) ${attempt.error.message}  [${formatDuration(durationMs)}]`);
      options.onAttempt?.(attempt, attemptNumber, total);
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
