import type { LLMProvider } from '../src/providers/interface.js';
import type { ReviewConfig } from '../src/config/schema.js';
import type { PullRequestContext, ReviewResult } from '../src/types/review.js';
import type { RunReviewOptions } from '../src/pipeline/run-review.js';
import { UsageTracker } from '../src/pipeline/usage.js';
import { type Attempt, type PromptMetadata } from './benchmark.js';
import type { BenchmarkCase } from './cases.js';
import { type EvalPlan } from './plan.js';
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
export declare const DEFAULT_CALL_TIMEOUT_MS = 120000;
export declare const DEFAULT_RETRIES = 0;
export declare const HEARTBEAT_MS = 15000;
/** Scrubs API-key-shaped strings and URL userinfo from text (case-insensitive). */
export declare function redactSecrets(text: string): string;
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
export declare function resolveEvalEnv(env: NodeJS.ProcessEnv): EvalEnvConfig;
/** Live mode requires a key; dry-run never calls this. */
export declare function requireApiKey(cfg: EvalEnvConfig): string;
/** Build the ReviewConfig used for one eval run (baseline or experimental). */
export declare function evalReviewConfig(cfg: EvalEnvConfig, experimental: boolean): ReviewConfig;
export interface PromptReport {
    experimental: boolean;
    systemChars: number;
    userChars: number;
    totalChars: number;
    estimatedTokens: number;
    hasConcisionRules: boolean;
}
/** Build the real fast-path system+user prompts and measure them (no network). */
export declare function buildPromptReport(config: ReviewConfig, ctx: PullRequestContext): PromptReport;
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
export declare function formatDuration(ms: number): string;
/** Compact experimental-vs-baseline delta line block. */
export declare function formatDelta(base: RunStats, experimental: RunStats): string;
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
export declare function gitRepoMetadata(cwd?: string): RepoMetadata;
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
export declare function buildSuitePromptMetadata(cases: readonly BenchmarkCase[], cfg: EvalEnvConfig, experimental: boolean): SuitePromptMetadata;
export type PipelineRunner = (llm: LLMProvider, ctx: PullRequestContext, config: ReviewConfig, usage: UsageTracker, options?: RunReviewOptions) => Promise<ReviewResult>;
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
export declare function executePlan(plan: EvalPlan, cases: readonly BenchmarkCase[], cfg: EvalEnvConfig, options: ExecutePlanOptions): Promise<ExecutePlanResult>;
export type { Attempt, PromptMetadata };
//# sourceMappingURL=runtime.d.ts.map