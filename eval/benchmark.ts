import { createHash } from 'node:crypto';
import { mean, median } from './metrics.js';
import type { RunMetrics, VariantLabel } from './metrics.js';
import { aggregateQuality, detectLargeRegression } from './quality.js';
import type {
  AggregateQualitySummary,
  AggregateRateMetric,
  BenchmarkCase,
  ExpectedIssue,
  IssueCategory,
  IssueSeverity,
  LineRange,
  RunQualityReport,
} from './quality.js';
import { groupPlanPairs } from './plan.js';
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
export type {
  AggregateQualitySummary,
  BenchmarkCase,
  ExpectedIssue,
  RunQualityReport,
  QualitySummary,
} from './quality.js';
export type { EvalPlan, PlanEntry } from './plan.js';

// ---------------------------------------------------------------------------
// Identities

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
export function planIdentityOf(entry: PlanEntry): PlanIdentity {
  return {
    roundIndex: entry.roundIndex,
    caseIndex: entry.caseIndex,
    caseId: entry.caseId,
    pairId: entry.pairId,
    globalCallIndex: entry.globalCallIndex,
    variant: entry.variant,
    experimental: entry.experimental,
  };
}

/** Derives a CaseIdentity from a benchmark case (deterministic; no context). */
export function caseIdentityOf(c: BenchmarkCase): CaseIdentity {
  return {
    caseId: c.id,
    version: c.version,
    label: c.label,
    tags: [...c.tags],
  };
}

function validateIdentity(identity: PlanIdentity): void {
  if ((identity.variant === 'experimental') !== identity.experimental) {
    throw new Error(
      `Attempt identity mismatch: variant "${identity.variant}" does not match ` +
        `experimental=${identity.experimental}`,
    );
  }
  for (const [name, value] of [
    ['roundIndex', identity.roundIndex],
    ['caseIndex', identity.caseIndex],
    ['globalCallIndex', identity.globalCallIndex],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`Attempt identity ${name} must be a non-negative integer`);
    }
  }
}

/**
 * Reduces an unknown failure to a safe {code, message}. Never touches the
 * stack; never stores the raw object. Callers may pass a string, an Error,
 * or an already-sanitized {code, message}.
 */
export function sanitizeError(raw: unknown): SanitizedError {
  if (typeof raw === 'string') return { code: 'error', message: raw };
  if (raw instanceof Error) {
    return { code: raw.name.length > 0 ? raw.name : 'error', message: raw.message };
  }
  if (raw !== null && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (typeof o.code === 'string' && typeof o.message === 'string') {
      return { code: o.code, message: o.message };
    }
    return {
      code: typeof o.name === 'string' && o.name.length > 0 ? o.name : 'error',
      message: typeof o.message === 'string' ? o.message : '[object Object]',
    };
  }
  if (raw === undefined || raw === null) return { code: 'unknown', message: 'Unknown error' };
  return { code: 'error', message: String(raw) };
}

// ---------------------------------------------------------------------------
// Attempt union

export interface CompletedAttempt {
  status: 'completed';
  identity: PlanIdentity;
  case: CaseIdentity;
  requestTimestamp: string;
  metrics: RunMetrics;
  quality: RunQualityReport;
}

export interface FailedAttempt {
  status: 'failed';
  identity: PlanIdentity;
  case: CaseIdentity;
  requestTimestamp: string;
  durationMs: number;
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
export function completedAttempt(input: CompletedAttemptInput): CompletedAttempt {
  validateIdentity(input.identity);
  if (input.identity.caseId !== input.case.caseId) {
    throw new Error(
      `Attempt case mismatch: identity.caseId "${input.identity.caseId}" !== ` +
        `case.caseId "${input.case.caseId}"`,
    );
  }
  if (input.metrics.variant !== input.identity.variant) {
    throw new Error(
      `Attempt variant mismatch: metrics.variant "${input.metrics.variant}" !== ` +
        `identity.variant "${input.identity.variant}"`,
    );
  }
  if (input.metrics.experimental !== input.identity.experimental) {
    throw new Error('Attempt experimental flag mismatch between metrics and identity');
  }
  if (typeof input.requestTimestamp !== 'string' || input.requestTimestamp.length === 0) {
    throw new Error('Attempt requestTimestamp must be a non-empty string');
  }
  return { status: 'completed', ...input };
}

export interface FailedAttemptInput {
  identity: PlanIdentity;
  case: CaseIdentity;
  requestTimestamp: string;
  durationMs: number;
  /** Raw failure; only sanitized {code, message} is stored. */
  error: unknown;
}

/** Validated constructor for a failed attempt (error sanitized on entry). */
export function failedAttempt(input: FailedAttemptInput): FailedAttempt {
  validateIdentity(input.identity);
  if (input.identity.caseId !== input.case.caseId) {
    throw new Error(
      `Attempt case mismatch: identity.caseId "${input.identity.caseId}" !== ` +
        `case.caseId "${input.case.caseId}"`,
    );
  }
  if (!Number.isFinite(input.durationMs) || input.durationMs < 0) {
    throw new Error('Attempt durationMs must be a finite non-negative number');
  }
  if (typeof input.requestTimestamp !== 'string' || input.requestTimestamp.length === 0) {
    throw new Error('Attempt requestTimestamp must be a non-empty string');
  }
  return {
    status: 'failed',
    identity: input.identity,
    case: input.case,
    requestTimestamp: input.requestTimestamp,
    durationMs: input.durationMs,
    error: sanitizeError(input.error),
  };
}

// ---------------------------------------------------------------------------
// Execution accounting

export interface ExecutionCounts {
  planned: number;
  completed: number;
  failed: number;
  /** completed / planned; 0 when nothing was planned. */
  completionRate: number;
}

export interface ExecutionAggregate {
  planned: number;
  completed: number;
  failed: number;
  completionRate: number;
  byVariant: Record<VariantLabel, ExecutionCounts>;
}

function buildExecution(plan: EvalPlan, attempts: Attempt[]): ExecutionAggregate {
  const variantCounts = (v: VariantLabel): ExecutionCounts => {
    const planned = plan.entries.filter((e) => e.variant === v).length;
    const completed = attempts.filter(
      (a) => a.identity.variant === v && a.status === 'completed',
    ).length;
    const failed = attempts.filter(
      (a) => a.identity.variant === v && a.status === 'failed',
    ).length;
    return {
      planned,
      completed,
      failed,
      completionRate: planned > 0 ? completed / planned : 0,
    };
  };
  const completed = attempts.filter((a) => a.status === 'completed').length;
  const failed = attempts.filter((a) => a.status === 'failed').length;
  return {
    planned: plan.plannedCalls,
    completed,
    failed,
    completionRate: plan.plannedCalls > 0 ? completed / plan.plannedCalls : 0,
    byVariant: {
      baseline: variantCounts('baseline'),
      experimental: variantCounts('experimental'),
    },
  };
}

// ---------------------------------------------------------------------------
// Reliability (completion/compliance, NOT quality) and performance

export interface VariantReliabilityAggregate {
  variant: VariantLabel;
  /** Completed runs — the denominator for every rate below. */
  completed: number;
  parsed: number;
  contractComplete: number;
  /** parseSuccess && contractComplete (strict usable review). */
  usable: number;
  /** Labeled alias of RunMetrics.conciseCompliant — NOT a quality signal. */
  formatLengthCompliant: number;
  parseRate: number;
  contractRate: number;
  successRate: number;
  formatLengthComplianceRate: number;
  /** zeroFindingsKind distribution (null → 'unknown'), sorted keys. */
  zeroFindingsKinds: Record<string, number>;
  /** finishReason distribution (undefined → 'unknown'), sorted keys. */
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

/** Null when the variant has zero completed attempts (no divide/throw). */
function buildReliability(
  variant: VariantLabel,
  runs: CompletedAttempt[],
): VariantReliabilityAggregate | null {
  if (runs.length === 0) return null;
  const n = runs.length;
  const count = (pred: (r: CompletedAttempt) => boolean): number => runs.filter(pred).length;
  return {
    variant,
    completed: n,
    parsed: count((r) => r.metrics.parseSuccess),
    contractComplete: count((r) => r.metrics.contractComplete),
    usable: count((r) => r.metrics.parseSuccess && r.metrics.contractComplete),
    formatLengthCompliant: count((r) => r.metrics.conciseCompliant),
    parseRate: count((r) => r.metrics.parseSuccess) / n,
    contractRate: count((r) => r.metrics.contractComplete) / n,
    successRate: count((r) => r.metrics.parseSuccess && r.metrics.contractComplete) / n,
    formatLengthComplianceRate: count((r) => r.metrics.conciseCompliant) / n,
    zeroFindingsKinds: distribution(runs.map((r) => r.metrics.zeroFindingsKind)),
    finishReasons: distribution(runs.map((r) => r.metrics.finishReason)),
  };
}

/** Null when the variant has zero completed attempts. */
function buildPerformance(
  variant: VariantLabel,
  runs: CompletedAttempt[],
): VariantPerformanceAggregate | null {
  if (runs.length === 0) return null;
  const nums = (pick: (m: RunMetrics) => number): number[] => runs.map((r) => pick(r.metrics));
  return {
    variant,
    runs: runs.length,
    meanDurationMs: mean(nums((m) => m.durationMs)),
    medianDurationMs: median(nums((m) => m.durationMs)),
    meanInputTokens: mean(nums((m) => m.inputTokens)),
    medianInputTokens: median(nums((m) => m.inputTokens)),
    meanOutputTokens: mean(nums((m) => m.outputTokens)),
    medianOutputTokens: median(nums((m) => m.outputTokens)),
    meanTotalTokens: mean(nums((m) => m.totalTokens)),
    medianTotalTokens: median(nums((m) => m.totalTokens)),
    meanRawChars: mean(nums((m) => m.rawChars)),
    medianRawChars: median(nums((m) => m.rawChars)),
    meanFindings: mean(nums((m) => m.retainedFindings)),
    medianFindings: median(nums((m) => m.retainedFindings)),
    meanScore: mean(nums((m) => m.score)),
    medianScore: median(nums((m) => m.score)),
  };
}

function distribution(values: Array<string | null | undefined>): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = value ?? 'unknown';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

// ---------------------------------------------------------------------------
// Quality (pre-gate vs post-gate via aggregateQuality)

export interface QualityAggregate {
  preGate: Record<VariantLabel, AggregateQualitySummary | null>;
  postGate: Record<VariantLabel, AggregateQualitySummary | null>;
}

function aggregateQualityFor(
  runs: CompletedAttempt[],
  gate: 'preGate' | 'postGate',
  casesById: Map<string, BenchmarkCase>,
): AggregateQualitySummary | null {
  if (runs.length === 0) return null;
  return aggregateQuality(
    runs.map((a) => ({
      case: casesById.get(a.case.caseId) as BenchmarkCase,
      summary: a.quality[gate],
      outputTokens: a.metrics.outputTokens,
    })),
  );
}

// ---------------------------------------------------------------------------
// Paired deltas (complete pairs only; never compare unmatched attempts)

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

function completedForEntry(
  attempts: Attempt[],
  entry: PlanEntry | undefined,
): CompletedAttempt | undefined {
  if (!entry) return undefined;
  return attempts.find(
    (a): a is CompletedAttempt =>
      a.status === 'completed' &&
      a.identity.globalCallIndex === entry.globalCallIndex &&
      a.identity.pairId === entry.pairId &&
      a.identity.caseId === entry.caseId &&
      a.identity.roundIndex === entry.roundIndex,
  );
}

function computePairedDelta(
  pair: { pairId: string; caseId: string; roundIndex: number },
  baseline: CompletedAttempt,
  experimental: CompletedAttempt,
): PairedDelta {
  const b = baseline.metrics;
  const e = experimental.metrics;
  const bGate = baseline.quality.postGate;
  const eGate = experimental.quality.postGate;
  const bTp1k = baseline.quality.diagnostics.tpPer1000TokensPost;
  const eTp1k = experimental.quality.diagnostics.tpPer1000TokensPost;
  return {
    pairId: pair.pairId,
    caseId: pair.caseId,
    roundIndex: pair.roundIndex,
    baseline: baseline.identity,
    experimental: experimental.identity,
    durationDeltaMs: e.durationMs - b.durationMs,
    inputDeltaTokens: e.inputTokens - b.inputTokens,
    outputDeltaTokens: e.outputTokens - b.outputTokens,
    totalDeltaTokens: e.totalTokens - b.totalTokens,
    rawCharsDelta: e.rawChars - b.rawChars,
    retainedFindingsDelta: e.retainedFindings - b.retainedFindings,
    outputSavingsPct:
      b.outputTokens > 0 ? ((b.outputTokens - e.outputTokens) / b.outputTokens) * 100 : null,
    rawCharsSavingsPct: b.rawChars > 0 ? ((b.rawChars - e.rawChars) / b.rawChars) * 100 : null,
    postGate: {
      tpDelta: eGate.tp - bGate.tp,
      fpDelta: eGate.fp - bGate.fp,
      fnDelta: eGate.fn - bGate.fn,
      f1Delta: eGate.f1 - bGate.f1,
      tpPer1000TokensDelta: bTp1k !== null && eTp1k !== null ? eTp1k - bTp1k : null,
    },
  };
}

function meanMedianFinite(values: number[]): PairDeltaSummary {
  return { mean: mean(values), median: median(values) };
}

function meanMedianNullable(values: Array<number | null>): PairDeltaNullableSummary {
  const nonNull = values.filter((v): v is number => v !== null);
  if (nonNull.length === 0) return { mean: null, median: null };
  return { mean: mean(nonNull), median: median(nonNull) };
}

function computePairDeltaAggregate(deltas: PairedDelta[]): PairDeltaAggregate {
  return {
    completePairs: deltas.length,
    durationDeltaMs: meanMedianFinite(deltas.map((d) => d.durationDeltaMs)),
    inputDeltaTokens: meanMedianFinite(deltas.map((d) => d.inputDeltaTokens)),
    outputDeltaTokens: meanMedianFinite(deltas.map((d) => d.outputDeltaTokens)),
    totalDeltaTokens: meanMedianFinite(deltas.map((d) => d.totalDeltaTokens)),
    rawCharsDelta: meanMedianFinite(deltas.map((d) => d.rawCharsDelta)),
    retainedFindingsDelta: meanMedianFinite(deltas.map((d) => d.retainedFindingsDelta)),
    outputSavingsPct: meanMedianNullable(deltas.map((d) => d.outputSavingsPct)),
    rawCharsSavingsPct: meanMedianNullable(deltas.map((d) => d.rawCharsSavingsPct)),
    postGateTpDelta: meanMedianFinite(deltas.map((d) => d.postGate.tpDelta)),
    postGateFpDelta: meanMedianFinite(deltas.map((d) => d.postGate.fpDelta)),
    postGateFnDelta: meanMedianFinite(deltas.map((d) => d.postGate.fnDelta)),
    postGateF1Delta: meanMedianFinite(deltas.map((d) => d.postGate.f1Delta)),
    postGateTpPer1000TokensDelta: meanMedianNullable(
      deltas.map((d) => d.postGate.tpPer1000TokensDelta),
    ),
  };
}

function buildPairs(plan: EvalPlan, attempts: Attempt[]): PairsSummary {
  const deltas: PairedDelta[] = [];
  let incomplete = 0;
  for (const pair of groupPlanPairs(plan)) {
    const baseline = completedForEntry(attempts, pair.baseline);
    const experimental = completedForEntry(attempts, pair.experimental);
    if (baseline !== undefined && experimental !== undefined) {
      deltas.push(computePairedDelta(pair, baseline, experimental));
    } else {
      incomplete += 1;
    }
  }
  return {
    completePairs: deltas.length,
    incompletePairs: incomplete,
    deltas,
    aggregate: deltas.length > 0 ? computePairDeltaAggregate(deltas) : null,
  };
}

// ---------------------------------------------------------------------------
// Large-regression detection

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

function detectRegressions(
  quality: QualityAggregate,
  runs: number,
  options: BenchmarkRegressionOptions = {},
): RegressionReport[] {
  const metric = options.metric ?? 'microRecall';
  const baselineThreshold = options.baselineThreshold ?? 0.75;
  const experimentalThreshold = options.experimentalThreshold ?? 0.25;
  const minRuns = options.minRuns ?? 4;

  const baseline = quality.postGate.baseline;
  const experimental = quality.postGate.experimental;

  if (runs < minRuns || baseline === null || experimental === null) {
    return [
      {
        status: 'insufficient-data',
        metric,
        runs,
        baseline: null,
        experimental: null,
        baselineThreshold,
        experimentalThreshold,
      },
    ];
  }
  const result = detectLargeRegression(baseline, experimental, {
    metric,
    baselineThreshold,
    experimentalThreshold,
  });
  return [
    {
      status: result.regressed ? 'detected' : 'none',
      metric,
      runs,
      baseline: result.baseline,
      experimental: result.experimental,
      baselineThreshold: result.baselineThreshold,
      experimentalThreshold: result.experimentalThreshold,
    },
  ];
}

// ---------------------------------------------------------------------------
// Aggregate result

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

function validateAttemptsAgainstPlan(plan: EvalPlan, attempts: Attempt[]): void {
  const entries = new Map(plan.entries.map((e) => [e.globalCallIndex, e]));
  for (const attempt of attempts) {
    const entry = entries.get(attempt.identity.globalCallIndex);
    if (
      entry === undefined ||
      entry.variant !== attempt.identity.variant ||
      entry.experimental !== attempt.identity.experimental ||
      entry.caseId !== attempt.identity.caseId ||
      entry.roundIndex !== attempt.identity.roundIndex ||
      entry.pairId !== attempt.identity.pairId
    ) {
      throw new Error(
        `Attempt identity does not match plan entry at globalCallIndex ` +
          `${attempt.identity.globalCallIndex} (pairId "${attempt.identity.pairId}", ` +
          `variant "${attempt.identity.variant}")`,
      );
    }
  }
}

export function buildBenchmarkResult(input: BuildBenchmarkResultInput): BenchmarkResult {
  const { plan, attempts } = input;
  const casesById = new Map(input.cases.map((c) => [c.id, c]));
  validateAttemptsAgainstPlan(plan, attempts);
  for (const attempt of attempts) {
    if (attempt.status === 'completed' && !casesById.has(attempt.case.caseId)) {
      throw new Error(
        `Completed attempt references unknown case "${attempt.case.caseId}"`,
      );
    }
  }

  const completed = attempts.filter((a): a is CompletedAttempt => a.status === 'completed');
  const byVariant = (v: VariantLabel): CompletedAttempt[] =>
    completed.filter((a) => a.identity.variant === v);

  const reliability: Record<VariantLabel, VariantReliabilityAggregate | null> = {
    baseline: buildReliability('baseline', byVariant('baseline')),
    experimental: buildReliability('experimental', byVariant('experimental')),
  };
  const performance: Record<VariantLabel, VariantPerformanceAggregate | null> = {
    baseline: buildPerformance('baseline', byVariant('baseline')),
    experimental: buildPerformance('experimental', byVariant('experimental')),
  };
  const quality: QualityAggregate = {
    preGate: {
      baseline: aggregateQualityFor(byVariant('baseline'), 'preGate', casesById),
      experimental: aggregateQualityFor(byVariant('experimental'), 'preGate', casesById),
    },
    postGate: {
      baseline: aggregateQualityFor(byVariant('baseline'), 'postGate', casesById),
      experimental: aggregateQualityFor(byVariant('experimental'), 'postGate', casesById),
    },
  };

  return {
    execution: buildExecution(plan, attempts),
    reliability,
    performance,
    quality,
    pairs: buildPairs(plan, attempts),
    regressions: detectRegressions(quality, plan.config.runs, input.regression),
  };
}

// ---------------------------------------------------------------------------
// Artifact v2

export interface PromptMetadata {
  sha256: string;
  chars: number;
}

/** Optional sha256 helper (the module's only non-pure import). */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Prompt fingerprint metadata from its full text (deterministic). */
export function promptMetadata(text: string): PromptMetadata {
  return { sha256: sha256Hex(text), chars: text.length };
}

/** Plan entry whitelist for the artifact — deliberate field allow-list. */
export interface SanitizedPlanEntry {
  globalCallIndex: number;
  roundIndex: number;
  caseIndex: number;
  caseId: string;
  pairId: string;
  variant: VariantLabel;
  experimental: boolean;
}

export function sanitizePlanEntry(entry: PlanEntry): SanitizedPlanEntry {
  return {
    globalCallIndex: entry.globalCallIndex,
    roundIndex: entry.roundIndex,
    caseIndex: entry.caseIndex,
    caseId: entry.caseId,
    pairId: entry.pairId,
    variant: entry.variant,
    experimental: entry.experimental,
  };
}

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

export function fixtureManifestOf(c: BenchmarkCase): FixtureManifest {
  return {
    caseId: c.id,
    version: c.version,
    label: c.label,
    tags: [...c.tags],
    expectedIssues: c.expectedIssues.map((i) => ({
      issueId: i.issueId,
      acceptedPaths: [...i.acceptedPaths],
      acceptedLineRanges: i.acceptedLineRanges.map((r) => ({ ...r })),
      acceptedCategories: [...i.acceptedCategories],
      minSeverity: i.minSeverity,
      maxSeverity: i.maxSeverity,
      ...(i.expectedSeverity !== undefined ? { expectedSeverity: i.expectedSeverity } : {}),
      rationale: i.rationale,
      ...(i.evidence !== undefined ? { evidence: i.evidence } : {}),
    })),
    ...(c.knownDistractors !== undefined
      ? { knownDistractors: [...c.knownDistractors] }
      : {}),
  };
}

export interface BenchmarkArtifactV2 {
  schema: 'fiscalcr-eval-v2';
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
  };
  config: {
    runs: number;
    plannedCalls: number;
    completedCalls: number;
    failedCalls: number;
    retries: number;
    timeoutMs: number;
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
  benchmark: { suiteId: string; suiteVersion: number };
  repository: { commit: string | null; dirty: boolean | null };
  provider: string;
  model: string;
  prompt: { baseline: PromptMetadata; experimental: PromptMetadata };
  retries: number;
  timeoutMs: number;
  plan: EvalPlan;
  cases: BenchmarkCase[];
  attempts: Attempt[];
  regression?: BenchmarkRegressionOptions;
}

export function buildBenchmarkArtifact(input: BuildBenchmarkArtifactInput): BenchmarkArtifactV2 {
  const result = buildBenchmarkResult({
    plan: input.plan,
    cases: input.cases,
    attempts: input.attempts,
    regression: input.regression,
  });
  const completed = input.attempts.filter((a) => a.status === 'completed').length;
  const failed = input.attempts.filter((a) => a.status === 'failed').length;
  return {
    schema: 'fiscalcr-eval-v2',
    timestamp: input.timestamp,
    benchmark: {
      suiteId: input.benchmark.suiteId,
      suiteVersion: input.benchmark.suiteVersion,
      selectedCaseIds: [...input.plan.config.caseIds],
      seed: input.plan.config.seed,
    },
    repository: { commit: input.repository.commit, dirty: input.repository.dirty },
    provider: input.provider,
    model: input.model,
    prompt: {
      baseline: { ...input.prompt.baseline },
      experimental: { ...input.prompt.experimental },
    },
    config: {
      runs: input.plan.config.runs,
      plannedCalls: input.plan.plannedCalls,
      completedCalls: completed,
      failedCalls: failed,
      retries: input.retries,
      timeoutMs: input.timeoutMs,
      maxCalls: input.plan.config.maxCalls,
    },
    plan: input.plan.entries.map(sanitizePlanEntry),
    fixtures: input.cases.map(fixtureManifestOf),
    attempts: input.attempts,
    aggregates: {
      execution: result.execution,
      reliability: result.reliability,
      performance: result.performance,
      quality: result.quality,
    },
    pairs: result.pairs,
    regressions: result.regressions,
  };
}

// ---------------------------------------------------------------------------
// Recursive secret-safety assertion

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

const DEFAULT_FORBIDDEN_KEYS = [
  'apiKey',
  'baseUrl',
  'authorization',
  'headers',
  'rawResponse',
  'stack',
] as const;

function normalizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

export function checkArtifactSafety(
  value: unknown,
  options: ArtifactSafetyOptions = {},
): ArtifactSafetyReport {
  const forbiddenKeys = (options.forbiddenKeys ?? DEFAULT_FORBIDDEN_KEYS).map(normalizeKey);
  const forbiddenSubstrings = [
    ...(options.forbiddenSubstrings ?? DEFAULT_FORBIDDEN_KEYS),
    ...(options.secret !== undefined ? [options.secret] : []),
  ]
    .filter((s) => s.length > 0)
    .map((s) => s.toLowerCase());
  const violations: ArtifactSafetyViolation[] = [];

  const checkSubstrings = (text: string, path: string): void => {
    const lower = text.toLowerCase();
    for (const sub of forbiddenSubstrings) {
      if (lower.includes(sub)) {
        violations.push({ path, kind: 'substring', match: sub });
        return;
      }
    }
  };

  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        const keyPath = path.length > 0 ? `${path}.${key}` : key;
        if (forbiddenKeys.includes(normalizeKey(key))) {
          violations.push({ path: keyPath, kind: 'key', match: key });
        }
        if (typeof child === 'string') checkSubstrings(child, keyPath);
        walk(child, keyPath);
      }
      return;
    }
    if (typeof node === 'string') checkSubstrings(node, path);
  };

  walk(value, '');
  return { safe: violations.length === 0, violations };
}

/** Throws with every violation when the artifact contains forbidden content. */
export function assertArtifactSafe(value: unknown, options: ArtifactSafetyOptions = {}): void {
  const report = checkArtifactSafety(value, options);
  if (!report.safe) {
    const detail = report.violations
      .map((v) => `${v.path} (${v.kind}: "${v.match}")`)
      .join('; ');
    throw new Error(`Artifact safety check failed: ${detail}`);
  }
}
