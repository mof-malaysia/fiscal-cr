import type { PricingContext, PricingResolution, PricingSource } from '../utils/pricing.js';
import { calculateCostWithPricing, resolvePricing } from '../utils/pricing.js';
import type { LLMTokenUsage } from '../providers/interface.js';
import type { ChatMessage } from '../types/review.js';
import { estimateTokens } from '../utils/tokens.js';
export type TelemetryStage = 'intent' | 'group-review' | 'synthesis' | 'fast-path';
export type TelemetryFinishReason =
  | 'stop'
  | 'length'
  | 'content_filter'
  | 'tool_calls'
  | 'function_call'
  | 'other';
export interface LLMCallTelemetryEvent {
  type: 'llm_call';
  stage: TelemetryStage;
  groupIndex?: number;
  fileCount?: number;
  estimatedInputTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  estimatedCostUsd: number;
  pricingSource: PricingSource;
  maxOutputTokens: number;
  durationMs: number;
  finishReason?: TelemetryFinishReason;
}

export interface StageResultTelemetryEvent {
  type: 'stage_result';
  stage: TelemetryStage;
  status: 'success' | 'failed';
  groupIndex?: number;
  findingsGenerated?: number;
  findingsRetained?: number;
  groups?: number;
  hotspots?: number;
}
export interface ReviewCompletedTelemetryEvent {
  type: 'review_completed';
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  estimatedCostUsd: number;
  pricingSource: PricingSource;
  annotations: number;
}

export type TelemetryEvent =
  | LLMCallTelemetryEvent
  | StageResultTelemetryEvent
  | ReviewCompletedTelemetryEvent;

export type TelemetrySink = (event: TelemetryEvent) => void | PromiseLike<void>;

export interface LLMCallTelemetry {
  stage: TelemetryStage;
  messages: ChatMessage[];
  maxOutputTokens: number;
  durationMs: number;
  groupIndex?: number;
  fileCount?: number;
  finishReason?: string;
}

const SAFE_FINISH_REASONS = new Set<TelemetryFinishReason>([
  'stop',
  'length',
  'content_filter',
  'tool_calls',
  'function_call',
]);

function safeFinishReason(value: string | undefined): TelemetryFinishReason | undefined {
  if (value === undefined) return undefined;
  return SAFE_FINISH_REASONS.has(value as TelemetryFinishReason)
    ? (value as TelemetryFinishReason)
    : 'other';
}

/** Aggregates token usage and provider-specific cost across all pipeline LLM calls. */
export class UsageTracker {
  private totals: LLMTokenUsage = { input: 0, output: 0, cached: 0 };
  private callCount = 0;
  private readonly pricing: PricingResolution;

  constructor(
    private readonly telemetry?: TelemetrySink,
    pricingContext: PricingContext = {},
  ) {
    this.pricing = resolvePricing(pricingContext);
  }

  startCall(): void {
    this.callCount++;
  }

  add(usage: LLMTokenUsage, call?: LLMCallTelemetry): void {
    this.totals.input += usage.input;
    this.totals.output += usage.output;
    this.totals.cached += usage.cached;
    if (call && this.telemetry) {
      const finishReason = safeFinishReason(call.finishReason);
      this.emit({
        type: 'llm_call',
        stage: call.stage,
        ...(call.groupIndex === undefined ? {} : { groupIndex: call.groupIndex }),
        ...(call.fileCount === undefined ? {} : { fileCount: call.fileCount }),
        estimatedInputTokens: call.messages.reduce(
          (total, message) => total + estimateTokens(message.content),
          0,
        ),
        inputTokens: usage.input,
        outputTokens: usage.output,
        cachedTokens: usage.cached,
        estimatedCostUsd: calculateCostWithPricing(usage, this.pricing.pricing),
        pricingSource: this.pricing.source,
        maxOutputTokens: call.maxOutputTokens,
        durationMs: Math.max(0, call.durationMs),
        ...(finishReason === undefined ? {} : { finishReason }),
      });
    }
  }

  emit(event: TelemetryEvent): void {
    try {
      const result = this.telemetry?.(event);
      if (result) void Promise.resolve(result).catch(() => {});
    } catch {
      // Observability must never affect review behavior.
    }
  }

  total(): LLMTokenUsage {
    return { ...this.totals };
  }

  calls(): number {
    return this.callCount;
  }

  cost(): number {
    return calculateCostWithPricing(this.totals, this.pricing.pricing);
  }

  pricingInfo(): PricingResolution {
    return this.pricing;
  }
}
