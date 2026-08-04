import type { LLMCompletionResponse, LLMTokenUsage } from '../src/providers/interface.js';
import type { ReviewAnnotation, ReviewResult, WalkthroughEntry } from '../src/types/review.js';
import { parseFastPathResponse } from '../src/pipeline/schemas.js';
import { extractJson } from '../src/utils/json.js';
import type { CapturedCall } from './eval-capture.js';

/**
 * Pure data model + math for the headless A/B eval benchmark. No network, no
 * fs, no secrets — unit-testable in isolation.
 */

export type { CapturedCall } from './eval-capture.js';

export type VariantLabel = 'baseline' | 'experimental';

/** Top-level keys the fast-path contract requires. */
export const REQUIRED_CONTRACT_KEYS = ['intent', 'summary', 'score', 'walkthrough', 'findings'] as const;

// Concise Rules limits (experimental prompt): intent 40 / summary 80 /
// walkthrough summary 20 / finding body 80 words.
export const CONCISE_LIMITS = { intent: 40, summary: 80, walkthroughSummary: 20, findingBody: 80 } as const;

// ---------------------------------------------------------------------------
// Word / numeric helpers

export function wordCount(text: string): number {
  return (text.trim().match(/\S+/g) ?? []).length;
}

function maxWordCount(texts: string[]): number {
  return texts.length === 0 ? 0 : Math.max(...texts.map(wordCount));
}

export function mean(nums: number[]): number {
  return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ---------------------------------------------------------------------------
// Env / run planning

/** EVAL_RUNS: integer 1..10, default 1. */
export function resolveEvalRuns(env: NodeJS.ProcessEnv): number {
  const raw = env.EVAL_RUNS;
  if (raw === undefined || raw.trim() === '') return 1;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid EVAL_RUNS "${raw}": expected an integer between 1 and 10`);
  }
  const n = Number(trimmed);
  if (n < 1 || n > 10) {
    throw new Error(`Invalid EVAL_RUNS ${n}: must be between 1 and 10`);
  }
  return n;
}

/**
 * A/B order for one pair. Pair 0 (and every even pair) runs baseline →
 * experimental; odd pairs run experimental → baseline, cancelling order bias.
 */
export function pairRunOrder(pairIndex: number): boolean[] {
  return pairIndex % 2 === 0 ? [false, true] : [true, false];
}

// ---------------------------------------------------------------------------
// Per-call capture

/** Derive capture metadata from a raw response without persisting its content. */
export function captureFromResponse(
  response: LLMCompletionResponse,
  order: number,
  durationMs: number,
): CapturedCall {
  const parsed = parseFastPathResponse(response.content);
  const json = extractJson(response.content);
  const topLevelKeys =
    json !== null && typeof json === 'object' && !Array.isArray(json)
      ? Object.keys(json as Record<string, unknown>)
      : [];
  return {
    order,
    durationMs,
    finishReason: response.finishReason,
    rawChars: response.content.length,
    usage: { ...response.usage },
    parseSuccess: parsed !== null,
    topLevelKeys,
    generatedFindings: parsed?.findings.length ?? 0,
    score: parsed?.score ?? null,
    intent: parsed?.intent ?? '',
    summary: parsed?.summary ?? '',
    walkthrough: parsed?.walkthrough ?? [],
    findings: parsed?.findings ?? [],
  };
}

// ---------------------------------------------------------------------------
// Per-run metrics

export interface RunMetrics {
  pairIndex: number;
  /** 0/1 within the pair. */
  runIndex: number;
  experimental: boolean;
  variant: VariantLabel;
  durationMs: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  finishReason?: string;
  rawChars: number;
  parseSuccess: boolean;
  /** All five top-level contract keys present in the raw JSON. */
  contractComplete: boolean;
  topLevelKeys: string[];
  generatedFindings: number;
  retainedFindings: number;
  /** 0..1; 0 when nothing was generated. */
  retentionRate: number;
  /**
   * Distinguish a genuine empty review from fallbacks.
   * 'genuine' only when parsed, contract complete, and required
   * narrative/walkthrough completeness holds; 'parser-fallback' when the
   * response did not parse; 'contract-incomplete' when it parsed but the
   * contract or required narrative is missing.
   */
  zeroFindingsKind: 'genuine' | 'parser-fallback' | 'contract-incomplete' | null;
  score: number;
  intentWords: number;
  summaryWords: number;
  maxWalkthroughSummaryWords: number;
  maxFindingBodyWords: number;
  /** Word-count limits only (40/80/20/80) — independent of contract/completeness. */
  limitsMet: boolean;
  /**
   * Strict compliance: parseSuccess + contractComplete + nonempty intent and
   * summary + full walkthrough coverage + limitsMet.
   */
  conciseCompliant: boolean;
  intentPresent: boolean;
  summaryPresent: boolean;
  /** Unique walkthrough paths matching changed file paths (0..1). */
  walkthroughCoverage: number;
  intent: string;
  summary: string;
  walkthrough: WalkthroughEntry[];
  findings: ReviewAnnotation[];
  /** Final structured ReviewResult for the artifact. */
  review: ReviewResult;
}

export interface BuildRunMetricsInput {
  experimental: boolean;
  pairIndex: number;
  runIndex: number;
  durationMs: number;
  tokens: LLMTokenUsage;
  calls: number;
  captures: CapturedCall[];
  result: ReviewResult;
  /** Actual changed file paths the walkthrough must cover. */
  changedFilePaths: string[];
}

export function buildRunMetrics(input: BuildRunMetricsInput): RunMetrics {
  const capture = input.captures[0]; // fast-path: a single LLM call per run
  const generated = capture?.generatedFindings ?? 0;
  const retained = input.result.annotations.length;
  const intent = capture?.intent ?? '';
  const summary = capture?.summary ?? '';
  const walkthrough = capture?.walkthrough ?? [];
  const findings = capture?.findings ?? [];
  const intentWords = wordCount(intent);
  const summaryWords = wordCount(summary);
  const maxWalkthroughSummaryWords = maxWordCount(walkthrough.map((w) => w.summary));
  const maxFindingBodyWords = maxWordCount(findings.map((f) => f.body));

  const parseSuccess = capture?.parseSuccess ?? false;
  const contractComplete = capture
    ? REQUIRED_CONTRACT_KEYS.every((k) => capture.topLevelKeys.includes(k))
    : false;
  const intentPresent = intent.length > 0;
  const summaryPresent = summary.length > 0;
  // Unique walkthrough paths that match actual changed file paths. Duplicate
  // or unknown paths never inflate coverage.
  const coveredPaths = new Set(walkthrough.map((w) => w.path));
  const walkthroughCoverage =
    input.changedFilePaths.length > 0
      ? input.changedFilePaths.filter((p) => coveredPaths.has(p)).length /
        input.changedFilePaths.length
      : 0;
  // Required narrative/walkthrough completeness (independent of word limits).
  const completeContract =
    parseSuccess && contractComplete && intentPresent && summaryPresent &&
    walkthroughCoverage === 1;

  const limitsMet =
    intentWords <= CONCISE_LIMITS.intent &&
    summaryWords <= CONCISE_LIMITS.summary &&
    maxWalkthroughSummaryWords <= CONCISE_LIMITS.walkthroughSummary &&
    maxFindingBodyWords <= CONCISE_LIMITS.findingBody;

  const zeroFindingsKind: RunMetrics['zeroFindingsKind'] =
    generated === 0
      ? !parseSuccess
        ? 'parser-fallback'
        : completeContract
          ? 'genuine'
          : 'contract-incomplete'
      : null;

  return {
    pairIndex: input.pairIndex,
    runIndex: input.runIndex,
    experimental: input.experimental,
    variant: input.experimental ? 'experimental' : 'baseline',
    durationMs: input.durationMs,
    calls: input.calls,
    inputTokens: input.tokens.input,
    outputTokens: input.tokens.output,
    cachedTokens: input.tokens.cached,
    // Input tokens already include the cached subset — total is input+output.
    totalTokens: input.tokens.input + input.tokens.output,
    finishReason: capture?.finishReason,
    rawChars: capture?.rawChars ?? 0,
    parseSuccess,
    contractComplete,
    topLevelKeys: capture?.topLevelKeys ?? [],
    generatedFindings: generated,
    retainedFindings: retained,
    retentionRate: generated > 0 ? retained / generated : 0,
    zeroFindingsKind,
    score: input.result.score,
    intentWords,
    summaryWords,
    maxWalkthroughSummaryWords,
    maxFindingBodyWords,
    limitsMet,
    conciseCompliant: completeContract && limitsMet,
    intentPresent,
    summaryPresent,
    walkthroughCoverage,
    intent,
    summary,
    walkthrough,
    findings,
    review: input.result,
  };
}

// ---------------------------------------------------------------------------
// Aggregation + deltas

export interface VariantAggregate {
  variant: VariantLabel;
  runs: number;
  /**
   * Strict usable success: parseSuccess && contractComplete. Runs that parsed
   * but are missing contract keys do not count as usable reviews.
   */
  successRate: number;
  parseRate: number;
  contractRate: number;
  conciseComplianceRate: number;
  meanDurationMs: number;
  medianDurationMs: number;
  meanInputTokens: number;
  medianInputTokens: number;
  meanOutputTokens: number;
  medianOutputTokens: number;
  meanTotalTokens: number;
  medianTotalTokens: number;
  meanFindings: number;
  medianFindings: number;
  meanScore: number;
  medianScore: number;
}

export interface BenchmarkDelta {
  /**
   * Output-token savings in percent, POSITIVE when experimental uses fewer
   * output tokens than baseline: (baseline − experimental) / baseline × 100.
   * null when the baseline emitted zero output tokens.
   */
  outputSavingsPct: number | null;
  durationDeltaMs: number;
  inputDeltaTokens: number;
  outputDeltaTokens: number;
  totalDeltaTokens: number;
  findingsDelta: number;
  scoreDelta: number;
  /** percentage points (experimental − baseline). */
  conciseComplianceDeltaPp: number;
}

function aggregateVariant(runs: RunMetrics[], variant: VariantLabel): VariantAggregate {
  const rs = runs.filter((r) => r.variant === variant);
  const n = rs.length;
  const rate = (pred: (r: RunMetrics) => boolean): number =>
    n > 0 ? rs.filter(pred).length / n : 0;

  return {
    variant,
    runs: n,
    successRate: rate((r) => r.parseSuccess && r.contractComplete),
    parseRate: rate((r) => r.parseSuccess),
    contractRate: rate((r) => r.contractComplete),
    conciseComplianceRate: rate((r) => r.conciseCompliant),
    meanDurationMs: mean(rs.map((r) => r.durationMs)),
    medianDurationMs: median(rs.map((r) => r.durationMs)),
    meanInputTokens: mean(rs.map((r) => r.inputTokens)),
    medianInputTokens: median(rs.map((r) => r.inputTokens)),
    meanOutputTokens: mean(rs.map((r) => r.outputTokens)),
    medianOutputTokens: median(rs.map((r) => r.outputTokens)),
    meanTotalTokens: mean(rs.map((r) => r.totalTokens)),
    medianTotalTokens: median(rs.map((r) => r.totalTokens)),
    meanFindings: mean(rs.map((r) => r.retainedFindings)),
    medianFindings: median(rs.map((r) => r.retainedFindings)),
    meanScore: mean(rs.map((r) => r.score)),
    medianScore: median(rs.map((r) => r.score)),
  };
}

export function aggregateRuns(runs: RunMetrics[]): Record<VariantLabel, VariantAggregate> {
  return {
    baseline: aggregateVariant(runs, 'baseline'),
    experimental: aggregateVariant(runs, 'experimental'),
  };
}

export function computeDelta(
  baseline: VariantAggregate,
  experimental: VariantAggregate,
): BenchmarkDelta {
  return {
    outputSavingsPct:
      baseline.meanOutputTokens > 0
        ? ((baseline.meanOutputTokens - experimental.meanOutputTokens) / baseline.meanOutputTokens) * 100
        : null,
    durationDeltaMs: experimental.meanDurationMs - baseline.meanDurationMs,
    inputDeltaTokens: experimental.meanInputTokens - baseline.meanInputTokens,
    outputDeltaTokens: experimental.meanOutputTokens - baseline.meanOutputTokens,
    totalDeltaTokens: experimental.meanTotalTokens - baseline.meanTotalTokens,
    findingsDelta: experimental.meanFindings - baseline.meanFindings,
    scoreDelta: experimental.meanScore - baseline.meanScore,
    conciseComplianceDeltaPp:
      (experimental.conciseComplianceRate - baseline.conciseComplianceRate) * 100,
  };
}

// ---------------------------------------------------------------------------
// Artifact (secret-safe: provider/model/fixture/config/metrics only)

export interface BenchmarkArtifact {
  schema: 'fiscalcr-eval-v1';
  timestamp: string;
  provider: string;
  model: string;
  fixture: { name: string; version: number; changedFiles: number };
  config: {
    runs: number;
    callsPlanned: number;
    pairOrders: boolean[][];
    retries: number;
  };
  runs: RunMetrics[];
  aggregates: Record<VariantLabel, VariantAggregate>;
  deltas: BenchmarkDelta;
}

export interface BuildArtifactInput {
  timestamp: string;
  provider: string;
  model: string;
  fixtureName: string;
  fixtureVersion: number;
  changedFileCount: number;
  runs: number;
  retries: number;
  pairOrders: boolean[][];
  runMetrics: RunMetrics[];
}

export function buildArtifact(input: BuildArtifactInput): BenchmarkArtifact {
  const aggregates = aggregateRuns(input.runMetrics);
  return {
    schema: 'fiscalcr-eval-v1',
    timestamp: input.timestamp,
    provider: input.provider,
    model: input.model,
    fixture: {
      name: input.fixtureName,
      version: input.fixtureVersion,
      changedFiles: input.changedFileCount,
    },
    config: {
      runs: input.runs,
      callsPlanned: input.runs * 2,
      pairOrders: input.pairOrders,
      retries: input.retries,
    },
    runs: input.runMetrics,
    aggregates,
    deltas: computeDelta(aggregates.baseline, aggregates.experimental),
  };
}
