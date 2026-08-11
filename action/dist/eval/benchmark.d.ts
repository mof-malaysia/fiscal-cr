import type { CapturedCall, ReviewRoute, RunMetrics, StageOutcome, VariantLabel } from './metrics.js';
import type { AggregateQualitySummary, AggregateRateMetric, BenchmarkCase, IssueCategory, IssueSeverity, LineRange, RunQualityReport } from './quality.js';
import type { EvalPlan, PlanEntry } from './plan.js';
/**
 * Pure benchmark result/artifact model for the headless A/B eval.
 *
 * Stage 2a: composes the existing lanes (plan, metrics, quality) into a
 * v2 artifact. No network, no fs, no git, no secrets — fully unit-testable.
 * The only non-pure import is node:crypto for the optional prompt-sha helper.
 *
 * Secret discipline:
 *  - Failed attempts store a sanitized {code, message} ONLY. Raw Error,
 *    stack, api keys, base URLs, headers and raw response bodies are never
 *    accepted or persisted anywhere in this module.
 *  - `assertArtifactSafe` recursively proves an artifact is free of
 *    forbidden keys/substrings.
 */
export type { RunMetrics, VariantLabel } from './metrics.js';
export type { AggregateQualitySummary, BenchmarkCase, ExpectedIssue, RunQualityReport, QualitySummary, } from './quality.js';
export type { EvalPlan, PlanEntry } from './plan.js';
/** Safe plan identity shared by both variants of one case+round. */
export interface PlanIdentity {
    /** 0-based round index (0..runs-1). */
    roundIndex: number;
    /** 0-based position of the case within the round's ordered case list. */
    caseIndex: number;
    caseId: string;
    /** Stable id shared by both variants of the same case+round. */
    pairId: string;
    /** 0-based global position in the whole plan (execution order). */
    globalCallIndex: number;
    variant: VariantLabel;
    experimental: boolean;
    /** Route the production runner took for this attempt. */
    route: ReviewRoute;
}
/** Case taxonomy carried by every attempt (id/version/tags; never code). */
export interface CaseIdentity {
    caseId: string;
    version: number;
    label: string;
    tags: string[];
}
/** Sanitized failure: code + message only, no stack/secret/raw payload. */
export interface SanitizedError {
    code: string;
    message: string;
}
/** Derives a PlanIdentity from a plan entry (deterministic). */
export declare function planIdentityOf(entry: PlanEntry): PlanIdentity;
/** Derives a CaseIdentity from a benchmark case (deterministic; no context). */
export declare function caseIdentityOf(c: BenchmarkCase): CaseIdentity;
/**
 * Reduces an unknown failure to a safe {code, message}. Never touches the
 * stack; never stores the raw object. Callers may pass a string, an Error,
 * or an already-sanitized {code, message}.
 */
export declare function sanitizeError(raw: unknown): SanitizedError;
export interface CompletedAttempt {
    status: 'completed';
    identity: PlanIdentity;
    case: CaseIdentity;
    requestTimestamp: string;
    metrics: RunMetrics;
    quality: RunQualityReport;
    /** True when a pipeline stage failed but a review was still produced. */
    degraded: boolean;
}
export interface FailedAttempt {
    status: 'failed';
    identity: PlanIdentity;
    case: CaseIdentity;
    requestTimestamp: string;
    durationMs: number;
    /** Actual provider LLM calls issued before the failure. */
    providerCalls: number;
    /**
     * Safe per-call capture metadata for every provider call attempted before
     * the failure: prompt hashes/counts (never the prompt), success/rejection
     * metadata, sanitized errors. Raw content is never stored.
     */
    captures: CapturedCall[];
    /** Stage outcomes from UsageTracker stage events (stage truth). */
    stageOutcomes: StageOutcome[];
    /** Sanitized {code, message} only. */
    error: SanitizedError;
}
export type Attempt = CompletedAttempt | FailedAttempt;
export interface CompletedAttemptInput {
    identity: PlanIdentity;
    case: CaseIdentity;
    requestTimestamp: string;
    metrics: RunMetrics;
    quality: RunQualityReport;
}
/** Validated constructor for a completed attempt. */
export declare function completedAttempt(input: CompletedAttemptInput): CompletedAttempt;
export interface FailedAttemptInput {
    identity: PlanIdentity;
    case: CaseIdentity;
    requestTimestamp: string;
    durationMs: number;
    /** Actual provider LLM calls issued before the failure. */
    providerCalls: number;
    /** Safe per-call capture metadata (see FailedAttempt). */
    captures: CapturedCall[];
    /** Stage outcomes from UsageTracker stage events (stage truth). */
    stageOutcomes: StageOutcome[];
    /** Raw failure; only sanitized {code, message} is stored. */
    error: unknown;
}
/** Validated constructor for a failed attempt (error sanitized on entry). */
export declare function failedAttempt(input: FailedAttemptInput): FailedAttempt;
export interface ExecutionCounts {
    planned: number;
    completed: number;
    failed: number;
    /** Completed attempts that degraded (a stage failed but a review was produced). */
    degraded: number;
    /** completed / planned; 0 when nothing was planned. */
    completionRate: number;
}
export interface ExecutionAggregate {
    planned: number;
    completed: number;
    failed: number;
    degraded: number;
    completionRate: number;
    /** Total provider LLM calls actually issued (failed attempts included). */
    actualProviderCalls: number;
    byVariant: Record<VariantLabel, ExecutionCounts>;
}
export interface VariantReliabilityAggregate {
    variant: VariantLabel;
    /** Completed runs — the denominator for every rate below. */
    completed: number;
    /** Completed fast-path runs (parse/contract/format metrics are fast-path-only). */
    fastPath: number;
    /** Completed multi-pass runs. */
    multiPass: number;
    /** Completed runs where a pipeline stage failed but a review was produced. */
    degraded: number;
    /** degraded / completed; 0 when nothing was completed. */
    degradedRate: number;
    /** Fast-path runs that parsed (fast-path denominator). */
    parsed: number;
    /** Fast-path runs with a complete contract (fast-path denominator). */
    contractComplete: number;
    /** Fast-path runs that parsed AND have a complete contract (fast-path denominator). */
    usable: number;
    /** Labeled alias of RunMetrics.conciseCompliant — NOT a quality signal. */
    formatLengthCompliant: number;
    parseRate: number;
    contractRate: number;
    successRate: number;
    formatLengthComplianceRate: number;
    /** zeroFindingsKind distribution over fast-path runs (null → 'unknown'). */
    zeroFindingsKinds: Record<string, number>;
    /** finishReason distribution over fast-path runs (undefined → 'unknown'). */
    finishReasons: Record<string, number>;
}
export interface VariantPerformanceAggregate {
    variant: VariantLabel;
    /** Completed runs — the denominator for every mean/median. */
    runs: number;
    meanDurationMs: number;
    medianDurationMs: number;
    meanInputTokens: number;
    medianInputTokens: number;
    meanOutputTokens: number;
    medianOutputTokens: number;
    meanTotalTokens: number;
    medianTotalTokens: number;
    meanRawChars: number;
    medianRawChars: number;
    /** Retained findings. */
    meanFindings: number;
    medianFindings: number;
    meanScore: number;
    medianScore: number;
}
export interface QualityAggregate {
    preGate: Record<VariantLabel, AggregateQualitySummary | null>;
    postGate: Record<VariantLabel, AggregateQualitySummary | null>;
}
export interface PairedDelta {
    pairId: string;
    caseId: string;
    roundIndex: number;
    baseline: PlanIdentity;
    experimental: PlanIdentity;
    /** experimental − baseline. */
    durationDeltaMs: number;
    inputDeltaTokens: number;
    outputDeltaTokens: number;
    totalDeltaTokens: number;
    rawCharsDelta: number;
    /** Retained-findings delta (diagnostic). */
    retainedFindingsDelta: number;
    /**
     * Percent savings, POSITIVE when experimental uses fewer output tokens
     * than baseline: (baseline − experimental) / baseline × 100.
     * null when the baseline emitted zero output tokens.
     */
    outputSavingsPct: number | null;
    /** Raw-character savings, same sign convention; null on zero baseline. */
    rawCharsSavingsPct: number | null;
    /** Post-gate (retained) quality deltas, experimental − baseline. */
    postGate: {
        tpDelta: number;
        fpDelta: number;
        fnDelta: number;
        f1Delta: number;
        /** TP per 1000 output tokens; null when either side had zero output. */
        tpPer1000TokensDelta: number | null;
    };
}
export interface PairDeltaSummary {
    mean: number;
    median: number;
}
export interface PairDeltaNullableSummary {
    mean: number | null;
    median: number | null;
}
export interface PairDeltaAggregate {
    /** Number of complete pairs aggregated. */
    completePairs: number;
    durationDeltaMs: PairDeltaSummary;
    inputDeltaTokens: PairDeltaSummary;
    outputDeltaTokens: PairDeltaSummary;
    totalDeltaTokens: PairDeltaSummary;
    rawCharsDelta: PairDeltaSummary;
    retainedFindingsDelta: PairDeltaSummary;
    outputSavingsPct: PairDeltaNullableSummary;
    rawCharsSavingsPct: PairDeltaNullableSummary;
    postGateTpDelta: PairDeltaSummary;
    postGateFpDelta: PairDeltaSummary;
    postGateFnDelta: PairDeltaSummary;
    postGateF1Delta: PairDeltaSummary;
    postGateTpPer1000TokensDelta: PairDeltaNullableSummary;
}
export interface PairsSummary {
    /** Planned pairs with BOTH a completed baseline and experimental attempt. */
    completePairs: number;
    /** Planned pairs missing at least one completed side. */
    incompletePairs: number;
    /** Per-pair deltas for complete pairs, in plan order. */
    deltas: PairedDelta[];
    /** Means/medians over complete pairs only; null when none complete. */
    aggregate: PairDeltaAggregate | null;
}
export interface RegressionReport {
    status: 'insufficient-data' | 'detected' | 'none';
    metric: AggregateRateMetric;
    /** Configured runs (EVAL_RUNS), not executed runs. */
    runs: number;
    /** Post-gate detection rate (micro recall) values; null when insufficient. */
    baseline: number | null;
    experimental: number | null;
    baselineThreshold: number;
    experimentalThreshold: number;
}
export interface BenchmarkRegressionOptions {
    /** Rate metric compared. Default 'microRecall' (gold-issue detection). */
    metric?: AggregateRateMetric;
    /** Baseline must be >= this to count as a prior good state. Default 0.75. */
    baselineThreshold?: number;
    /** Experimental must be <= this to count as a regression. Default 0.25. */
    experimentalThreshold?: number;
    /** Minimum configured runs before a verdict is possible. Default 4. */
    minRuns?: number;
}
export interface BenchmarkResult {
    execution: ExecutionAggregate;
    reliability: Record<VariantLabel, VariantReliabilityAggregate | null>;
    performance: Record<VariantLabel, VariantPerformanceAggregate | null>;
    quality: QualityAggregate;
    pairs: PairsSummary;
    regressions: RegressionReport[];
}
export interface BuildBenchmarkResultInput {
    plan: EvalPlan;
    /** Selected benchmark cases (full objects; used for quality aggregation). */
    cases: BenchmarkCase[];
    attempts: Attempt[];
    regression?: BenchmarkRegressionOptions;
}
export declare function buildBenchmarkResult(input: BuildBenchmarkResultInput): BenchmarkResult;
export interface PromptMetadata {
    sha256: string;
    chars: number;
}
/** Optional sha256 helper (the module's only non-pure import). */
export declare function sha256Hex(text: string): string;
/** Prompt fingerprint metadata from its full text (deterministic). */
export declare function promptMetadata(text: string): PromptMetadata;
/** Plan entry whitelist for the artifact — deliberate field allow-list. */
export interface SanitizedPlanEntry {
    globalCallIndex: number;
    roundIndex: number;
    caseIndex: number;
    caseId: string;
    pairId: string;
    variant: VariantLabel;
    experimental: boolean;
    route: ReviewRoute;
    maxProviderCalls: number;
}
export declare function sanitizePlanEntry(entry: PlanEntry): SanitizedPlanEntry;
/** Case taxonomy + gold issues. Context code/diffs are deliberately excluded. */
export interface FixtureManifestIssue {
    issueId: string;
    acceptedPaths: string[];
    acceptedLineRanges: LineRange[];
    acceptedCategories: IssueCategory[];
    minSeverity: IssueSeverity;
    maxSeverity: IssueSeverity;
    expectedSeverity?: IssueSeverity;
    rationale: string;
    evidence?: string;
}
export interface FixtureManifest {
    caseId: string;
    version: number;
    label: string;
    tags: string[];
    expectedIssues: FixtureManifestIssue[];
    knownDistractors?: string[];
}
export declare function fixtureManifestOf(c: BenchmarkCase): FixtureManifest;
export interface BenchmarkArtifactV3 {
    schema: 'fiscalcr-eval-v3';
    timestamp: string;
    benchmark: {
        suiteId: string;
        suiteVersion: number;
        selectedCaseIds: string[];
        seed: string;
    };
    repository: {
        commit: string | null;
        dirty: boolean | null;
    };
    provider: string;
    model: string;
    prompt: {
        baseline: PromptMetadata;
        experimental: PromptMetadata;
        /**
         * Case ids routed multi-pass — excluded from the static prompt preview
         * (their stage prompts are generated during live execution and
         * fingerprinted per call in the attempt captures).
         */
        dynamicMultiPassCaseIds: string[];
        /** Number of multi-pass cases excluded from the static prompt preview. */
        dynamicMultiPassCount: number;
    };
    config: {
        runs: number;
        /** Planned review attempts: cases * runs * 2. */
        plannedAttempts: number;
        /** Sum of per-attempt provider-call upper bounds (EVAL_MAX_CALLS guard). */
        plannedProviderCallsUpperBound: number;
        completedAttempts: number;
        failedAttempts: number;
        /** Completed attempts where a pipeline stage failed but a review was produced. */
        degradedAttempts: number;
        /** Actual provider LLM calls issued across all attempts. */
        actualProviderCalls: number;
        retries: number;
        /**
         * Per-CALL timeout for the fast-path and group-review provider calls.
         * NOT an attempt-level deadline: intent/synthesis use fixed internal
         * timeouts (60s / 90s) and in-flight calls are not cancellable.
         */
        callTimeoutMs: number;
        maxCalls: number;
    };
    /** Sanitized plan entries (whitelisted fields only). */
    plan: SanitizedPlanEntry[];
    /** Case taxonomy + expectedIssues (no context code/diffs). */
    fixtures: FixtureManifest[];
    attempts: Attempt[];
    aggregates: {
        execution: ExecutionAggregate;
        reliability: Record<VariantLabel, VariantReliabilityAggregate | null>;
        performance: Record<VariantLabel, VariantPerformanceAggregate | null>;
        quality: QualityAggregate;
    };
    pairs: PairsSummary;
    regressions: RegressionReport[];
}
export interface BuildBenchmarkArtifactInput {
    timestamp: string;
    benchmark: {
        suiteId: string;
        suiteVersion: number;
    };
    repository: {
        commit: string | null;
        dirty: boolean | null;
    };
    provider: string;
    model: string;
    prompt: {
        baseline: PromptMetadata;
        experimental: PromptMetadata;
        /** Multi-pass cases excluded from the static preview (see BenchmarkArtifactV3). */
        dynamicMultiPassCaseIds?: string[];
        dynamicMultiPassCount?: number;
    };
    retries: number;
    /** Per-call timeout for fast-path + group-review provider calls. */
    callTimeoutMs: number;
    plan: EvalPlan;
    cases: BenchmarkCase[];
    attempts: Attempt[];
    regression?: BenchmarkRegressionOptions;
}
export declare function buildBenchmarkArtifact(input: BuildBenchmarkArtifactInput): BenchmarkArtifactV3;
export interface ArtifactSafetyViolation {
    /** Dot path into the artifact, e.g. `attempts[0].metrics.review.body`. */
    path: string;
    kind: 'key' | 'substring';
    /** The matched key name or substring. */
    match: string;
}
export interface ArtifactSafetyReport {
    safe: boolean;
    violations: ArtifactSafetyViolation[];
}
export interface ArtifactSafetyOptions {
    /** Keys treated as forbidden (normalized, case/underscore-insensitive). */
    forbiddenKeys?: readonly string[];
    /**
     * Substrings treated as forbidden inside any string value
     * (case-insensitive). Defaults to the key names; pass `secret` to also
     * scan for a concrete secret. Note: substring matches can false-positive
     * on ordinary words ('stack', 'authorization') — override when needed.
     */
    forbiddenSubstrings?: readonly string[];
    /** Concrete secret to scan for inside string values (case-insensitive). */
    secret?: string;
}
export declare function checkArtifactSafety(value: unknown, options?: ArtifactSafetyOptions): ArtifactSafetyReport;
/** Throws with every violation when the artifact contains forbidden content. */
export declare function assertArtifactSafe(value: unknown, options?: ArtifactSafetyOptions): void;
//# sourceMappingURL=benchmark.d.ts.map