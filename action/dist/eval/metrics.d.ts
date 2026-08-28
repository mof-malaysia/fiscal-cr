import type { LLMCompletionResponse, LLMProvider, LLMTokenUsage } from '../src/providers/interface.js';
import type { ReviewAnnotation, ReviewResult, WalkthroughEntry } from '../src/types/review.js';
import type { ReviewRoute } from '../src/pipeline/run-review.js';
import type { TelemetryStage } from '../src/pipeline/usage.js';
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
export declare function promptCallMetadata(messages: readonly {
    role: string;
    content: string;
}[]): PromptCallMetadata;
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
export declare const REQUIRED_CONTRACT_KEYS: readonly ["intent", "summary", "score", "walkthrough", "findings"];
export declare const CONCISE_LIMITS: {
    readonly intent: 40;
    readonly summary: 80;
    readonly walkthroughSummary: 20;
    readonly findingBody: 80;
};
export declare function wordCount(text: string): number;
export declare function mean(nums: number[]): number;
export declare function median(nums: number[]): number;
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
export declare function wrapCapturingProvider(inner: LLMProvider, onCall: (info: CaptureInfo) => void): LLMProvider;
/** Derive capture metadata from a raw response without persisting its content. */
export declare function captureFromResponse(response: LLMCompletionResponse, order: number, durationMs: number, request?: PromptCallMetadata): CapturedCall;
/**
 * Capture metadata for a rejected provider call. `error` must already be
 * sanitized + redacted by the caller (code + message only) — the raw error is
 * never stored.
 */
export declare function captureFromError(error: CaptureError, order: number, durationMs: number, request?: PromptCallMetadata): CapturedCall;
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
export declare function associateCallStages(captures: readonly CapturedCall[], callStages: readonly CallStage[]): CapturedCall[];
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
export declare function buildRunMetrics(input: BuildRunMetricsInput): RunMetrics;
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
export declare function aggregateRuns(runs: RunMetrics[]): Record<VariantLabel, VariantAggregate>;
export declare function computeDelta(baseline: VariantAggregate, experimental: VariantAggregate): BenchmarkDelta;
//# sourceMappingURL=metrics.d.ts.map