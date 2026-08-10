import { createHash } from 'node:crypto';
import type {
  ChatCompletionParams,
  LLMCompletionResponse,
  LLMProvider,
  LLMTokenUsage,
} from '../src/providers/interface.js';
import type { ReviewAnnotation, ReviewResult, WalkthroughEntry } from '../src/types/review.js';
import type { ReviewRoute } from '../src/pipeline/run-review.js';
import type { TelemetryStage } from '../src/pipeline/usage.js';
import { parseFastPathResponse } from '../src/pipeline/schemas.js';
import { extractJson } from '../src/utils/json.js';
import { estimateTokens } from '../src/utils/tokens.js';

/**
 * Pure data model + math for the headless A/B eval benchmark. No network, no
 * fs, no secrets — unit-testable in isolation.
 *
 * Route-aware: every run knows whether the production runner took the fast
 * path (single call) or the multi-pass pipeline, and the per-call capture
 * records request prompt metadata (hashes/counts only) before awaiting and
 * success/rejection metadata afterward. Raw prompts and raw responses are
 * never stored.
 */

export type VariantLabel = 'baseline' | 'experimental';

export type { ReviewRoute } from '../src/pipeline/run-review.js';

/** Safe prompt fingerprint for one LLM call (never the prompt itself). */
export interface PromptMessageMetadata {
  role: string;
  /** Exact character count of the message content. */
  chars: number;
  /** sha256 of the message content. */
  sha256: string;
}

export interface PromptCallMetadata {
  messageCount: number;
  /** Total character count across all messages. */
  chars: number;
  /** Estimated prompt tokens across all messages. */
  estimatedTokens: number;
  messages: PromptMessageMetadata[];
}

/** Hash + measure the messages of a call (deterministic, keyless). */
export function promptCallMetadata(messages: readonly { role: string; content: string }[]): PromptCallMetadata {
  const per = messages.map((m) => ({
    role: m.role,
    chars: m.content.length,
    sha256: createHash('sha256').update(m.content, 'utf8').digest('hex'),
  }));
  return {
    messageCount: per.length,
    chars: per.reduce((s, m) => s + m.chars, 0),
    estimatedTokens: messages.reduce((s, m) => s + estimateTokens(m.content), 0),
    messages: per,
  };
}

/** Stage outcomes are reported by UsageTracker stage events (stage truth). */
export interface StageOutcome {
  stage: 'intent' | 'group-review' | 'synthesis' | 'fast-path';
  status: 'success' | 'failed';
  groupIndex?: number;
}

/** Sanitized provider failure (code + redacted message only). */
export interface CaptureError {
  code: string;
  message: string;
}

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
// Per-call capture

/**
 * Transparent LLMProvider wrapper used by the eval harness. Captures the
 * request's prompt metadata (hashes/counts only) BEFORE awaiting, then the
 * response metadata (duration, usage, finish reason, content length, parse
 * result) on success or a sanitized error on rejection — all via onCall
 * without modifying production provider code. The raw prompt and raw response
 * content are never persisted or printed by the harness.
 */
export interface CaptureInfo {
  /** 1-based call order within the run. */
  order: number;
  durationMs: number;
  /** Prompt metadata captured before the request was sent. */
  request: PromptCallMetadata;
  /** Present on success; absent on rejection. */
  response?: LLMCompletionResponse;
  /** Present on rejection; never persisted raw (sanitize before storing). */
  error?: unknown;
}

export interface CapturedCall {
  /** 1-based call order within the run. */
  order: number;
  durationMs: number;
  /**
   * Pipeline stage for this call (UsageTracker llm_call stage truth). Present
   * when the pipeline reported the call; undefined for provider-level failures
   * (no llm_call is emitted for a rejected call). Multi-pass generated
   * findings are only ever counted from group-review captures.
   */
  stage?: TelemetryStage;
  /** Prompt metadata (hashes/counts) — never the prompt itself. */
  request?: PromptCallMetadata;
  /** False on success, true when the provider call rejected. */
  failed: boolean;
  /** Sanitized failure; present only when failed. */
  error?: CaptureError;
  /** Raw response character count — content itself is never stored. 0 when failed. */
  rawChars: number;
  usage: LLMTokenUsage;
  finishReason?: string;
  /** Real parseFastPathResponse success (fast-path contract). */
  parseSuccess: boolean;
  /** Top-level keys present in the raw JSON object (extractJson). */
  topLevelKeys: string[];
  generatedFindings: number;
  score: number | null;
  intent: string;
  summary: string;
  walkthrough: WalkthroughEntry[];
  findings: ReviewAnnotation[];
}

export function wrapCapturingProvider(
  inner: LLMProvider,
  onCall: (info: CaptureInfo) => void,
): LLMProvider {
  let order = 0;
  return {
    async chatCompletion(params: ChatCompletionParams): Promise<LLMCompletionResponse> {
      // Snapshot the call order BEFORE awaiting: concurrent invocations each
      // capture an immutable unique order, so completion/rejection callbacks
      // report their own invocation even when they settle out of order
      // (reading the shared counter after the await could observe a later
      // call's increment and report a duplicate order).
      const callOrder = ++order;
      const startedAt = Date.now();
      const request = promptCallMetadata(params.messages);
      let response: LLMCompletionResponse;
      try {
        response = await inner.chatCompletion(params);
      } catch (err) {
        onCall({ order: callOrder, durationMs: Date.now() - startedAt, request, error: err });
        throw err;
      }
      onCall({ order: callOrder, durationMs: Date.now() - startedAt, request, response });
      return response;
    },
  };
}

/** Derive capture metadata from a raw response without persisting its content. */
export function captureFromResponse(
  response: LLMCompletionResponse,
  order: number,
  durationMs: number,
  request?: PromptCallMetadata,
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
    ...(request === undefined ? {} : { request }),
    failed: false,
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

/**
 * Capture metadata for a rejected provider call. `error` must already be
 * sanitized + redacted by the caller (code + message only) — the raw error is
 * never stored.
 */
export function captureFromError(
  error: CaptureError,
  order: number,
  durationMs: number,
  request?: PromptCallMetadata,
): CapturedCall {
  return {
    order,
    durationMs,
    ...(request === undefined ? {} : { request }),
    failed: true,
    error,
    rawChars: 0,
    usage: { input: 0, output: 0, cached: 0 },
    finishReason: undefined,
    parseSuccess: false,
    topLevelKeys: [],
    generatedFindings: 0,
    score: null,
    intent: '',
    summary: '',
    walkthrough: [],
    findings: [],
  };
}

// ---------------------------------------------------------------------------
// Call-stage association (UsageTracker stage truth)

/** Pipeline stage a provider call belonged to (llm_call event, fire order). */
export interface CallStage {
  stage: TelemetryStage;
  groupIndex?: number;
}

/**
 * Associate captured provider calls with the stages the pipeline reported for
 * them. The pipeline emits one `llm_call` event per SUCCESSFUL call (via
 * usage.add), in the same fire order as the capture for that call; a call that
 * rejected emits no llm_call event. So each successful capture consumes the
 * next unconsumed stage, and failed captures keep no stage. Returns a new
 * array — input captures are not mutated.
 */
export function associateCallStages(
  captures: readonly CapturedCall[],
  callStages: readonly CallStage[],
): CapturedCall[] {
  let stageIndex = 0;
  return captures.map((capture) => {
    if (capture.failed) return capture;
    const stage = callStages[stageIndex++];
    if (stage === undefined) return capture;
    return { ...capture, stage: stage.stage };
  });
}

// ---------------------------------------------------------------------------
// Per-run metrics

export interface RunMetrics {
  pairIndex: number;
  /** 0/1 within the pair. */
  runIndex: number;
  experimental: boolean;
  variant: VariantLabel;
  /** Route the production runner took (routeReview decision). */
  route: ReviewRoute;
  durationMs: number;
  /** Actual provider LLM calls issued by the pipeline (usage.calls()). */
  providerCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  /** Stage outcomes from UsageTracker stage events — never inferred from JSON. */
  stageOutcomes: StageOutcome[];
  /** True when any pipeline stage failed but the run still produced a review. */
  degraded: boolean;
  /** Per-call capture metadata (prompt hashes/counts, size, usage, timing). */
  captures: CapturedCall[];
  /**
   * Fast-path concision/contract metrics are only meaningful on the fast path
   * (they describe the single response's contract compliance). On the
   * multi-pass route they are null — never false evidence.
   */
  finishReason?: string;
  parseSuccess: boolean | null;
  /** All five top-level contract keys present in the raw JSON. */
  contractComplete: boolean | null;
  topLevelKeys: string[] | null;
  rawChars: number;
  /** Generated findings: fast-path from the single response, multi-pass from group responses. */
  generatedFindings: number;
  retainedFindings: number;
  /** 0..1; 0 when nothing was generated. */
  retentionRate: number;
  /**
   * Fast-path only: distinguish a genuine empty review from fallbacks.
   * null on the multi-pass route.
   */
  zeroFindingsKind: 'genuine' | 'parser-fallback' | 'contract-incomplete' | null;
  score: number;
  intentWords: number | null;
  summaryWords: number | null;
  maxWalkthroughSummaryWords: number | null;
  maxFindingBodyWords: number | null;
  limitsMet: boolean | null;
  conciseCompliant: boolean | null;
  intentPresent: boolean | null;
  summaryPresent: boolean | null;
  walkthroughCoverage: number | null;
  intent: string | null;
  summary: string | null;
  walkthrough: WalkthroughEntry[] | null;
  /** Generated findings (pre-gate) — fast-path response or flattened group responses. */
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
  providerCalls: number;
  captures: CapturedCall[];
  result: ReviewResult;
  route: ReviewRoute;
  stageOutcomes: StageOutcome[];
  /** Actual changed file paths the walkthrough must cover. */
  changedFilePaths: string[];
}

export function buildRunMetrics(input: BuildRunMetricsInput): RunMetrics {
  const successCaptures = input.captures.filter((c) => !c.failed);
  const capture = successCaptures[0]; // fast-path: a single LLM call per run
  const isFast = input.route === 'fast-path';
  const retained = input.result.annotations.length;
  // Generated findings: fast-path = the single response; multi-pass = ONLY the
  // group-review responses (stage truth). Intent/synthesis responses are never
  // counted even if they happen to contain findings-shaped output.
  const findings = isFast
    ? (capture?.findings ?? [])
    : successCaptures
        .filter((c) => c.stage === 'group-review')
        .flatMap((c) => c.findings);
  const generated = findings.length;

  const intent = isFast ? (capture?.intent ?? '') : (input.result.intent ?? null);
  const summary = isFast ? (capture?.summary ?? '') : input.result.summary;
  const walkthrough = isFast
    ? (capture?.walkthrough ?? [])
    : (input.result.walkthrough ?? null);

  const parseSuccess = isFast ? (capture?.parseSuccess ?? false) : null;
  const contractComplete = isFast
    ? capture
      ? REQUIRED_CONTRACT_KEYS.every((k) => capture.topLevelKeys.includes(k))
      : false
    : null;
  const intentPresent = isFast ? (intent as string).length > 0 : null;
  const summaryPresent = isFast ? (summary as string).length > 0 : null;
  const coveredPaths = new Set((walkthrough ?? []).map((w) => w.path));
  const walkthroughCoverage = isFast
    ? input.changedFilePaths.length > 0
      ? input.changedFilePaths.filter((p) => coveredPaths.has(p)).length /
        input.changedFilePaths.length
      : 0
    : null;
  const completeContract =
    isFast &&
    parseSuccess === true &&
    contractComplete === true &&
    intentPresent === true &&
    summaryPresent === true &&
    walkthroughCoverage === 1;

  const intentWords = isFast ? wordCount(intent as string) : null;
  const summaryWords = isFast ? wordCount(summary as string) : null;
  const maxWalkthroughSummaryWords = isFast
    ? maxWordCount((walkthrough as WalkthroughEntry[]).map((w) => w.summary))
    : null;
  const maxFindingBodyWords = isFast ? maxWordCount(findings.map((f) => f.body)) : null;
  const limitsMet = isFast
    ? (intentWords as number) <= CONCISE_LIMITS.intent &&
      (summaryWords as number) <= CONCISE_LIMITS.summary &&
      (maxWalkthroughSummaryWords as number) <= CONCISE_LIMITS.walkthroughSummary &&
      (maxFindingBodyWords as number) <= CONCISE_LIMITS.findingBody
    : null;

  const zeroFindingsKind: RunMetrics['zeroFindingsKind'] = !isFast
    ? null
    : generated === 0
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
    route: input.route,
    durationMs: input.durationMs,
    providerCalls: input.providerCalls,
    inputTokens: input.tokens.input,
    outputTokens: input.tokens.output,
    cachedTokens: input.tokens.cached,
    // Input tokens already include the cached subset — total is input+output.
    totalTokens: input.tokens.input + input.tokens.output,
    stageOutcomes: [...input.stageOutcomes],
    degraded: input.stageOutcomes.some((o) => o.status === 'failed'),
    captures: input.captures,
    finishReason: isFast ? capture?.finishReason : undefined,
    rawChars: successCaptures.reduce((s, c) => s + c.rawChars, 0),
    parseSuccess,
    contractComplete,
    topLevelKeys: isFast ? (capture?.topLevelKeys ?? []) : null,
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
    conciseCompliant: isFast ? completeContract && (limitsMet as boolean) : null,
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
    // Fast-path contract metrics: null (multi-pass) counts as not met.
    successRate: rate((r) => r.parseSuccess === true && r.contractComplete === true),
    parseRate: rate((r) => r.parseSuccess === true),
    contractRate: rate((r) => r.contractComplete === true),
    conciseComplianceRate: rate((r) => r.conciseCompliant === true),
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
