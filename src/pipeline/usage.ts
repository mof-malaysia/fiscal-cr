import {
  calculateCostBreakdownWithPricing,
  calculateCostWithPricing,
  resolvePricing,
  type PricingContext,
  type TokenCostBreakdown,
  type PricingResolution,
  type PricingSource,
} from '../utils/pricing.js';
import type { LLMTokenUsage } from '../providers/interface.js';
import type { ChatMessage, ModelCostBreakdown } from '../types/review.js';
import { estimateTokens } from '../utils/tokens.js';
export type TelemetryStage = 'intent' | 'group-review' | 'synthesis' | 'fast-path' | 'diagram';
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
  /** Effective model used for this stage; staged reviews may vary by call. */
  model?: string;
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
  model?: string;
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
/** Aggregates token usage and provider-specific cost across all pipeline LLM calls. */
export class UsageTracker {
  private totals: LLMTokenUsage = { input: 0, output: 0, cached: 0 };
  private callCount = 0;
  private totalCostUsd = 0;
  private readonly costBreakdownUsd: Omit<TokenCostBreakdown, 'totalUsd'> = {
    inputUsd: 0,
    outputUsd: 0,
    cachedUsd: 0,
  };
  private readonly costsByModel = new Map<string, ModelCostBreakdown>();
  private readonly pricing: PricingResolution;
  private readonly pricingContext: PricingContext;
  private readonly pricingByModel: Map<string, PricingResolution>;

  constructor(
    private readonly telemetry?: TelemetrySink,
    pricingContext: PricingContext = {},
    pricingResolutions?: ReadonlyMap<string, PricingResolution>,
  ) {
    this.pricingContext = pricingContext;
    this.pricing = resolvePricing(pricingContext);
    this.pricingByModel = new Map(pricingResolutions);
    if (this.pricing.model && !this.pricingByModel.has(this.pricing.model)) {
      this.pricingByModel.set(this.pricing.model, this.pricing);
    }
  }

  private pricingForModel(model?: string): PricingResolution {
    if (!model) return this.pricing;
    const cached = this.pricingByModel.get(model);
    if (cached) return cached;
    const resolved = resolvePricing({ ...this.pricingContext, model });
    this.pricingByModel.set(model, resolved);
    return resolved;
  }

  private modelIdentity(pricing: PricingResolution, call?: LLMCallTelemetry): string | undefined {
    const model = call?.model ?? pricing.model;
    if (!model) return undefined;
    const provider = pricing.provider ?? this.pricingContext.provider;
    return provider ? `${provider}/${model}` : model;
  }

  startCall(): void {
    this.callCount++;
  }

  add(usage: LLMTokenUsage, call?: LLMCallTelemetry): void {
    this.totals.input += usage.input;
    this.totals.output += usage.output;
    this.totals.cached += usage.cached;
    const pricing = this.pricingForModel(call?.model);
    const breakdown = calculateCostBreakdownWithPricing(usage, pricing.pricing);
    this.totalCostUsd += breakdown.totalUsd;
    this.costBreakdownUsd.inputUsd += breakdown.inputUsd;
    this.costBreakdownUsd.outputUsd += breakdown.outputUsd;
    this.costBreakdownUsd.cachedUsd += breakdown.cachedUsd;

    const model = this.modelIdentity(pricing, call);
    if (model) {
      const current = this.costsByModel.get(model) ?? {
        model,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        inputUsd: 0,
        outputUsd: 0,
        cachedUsd: 0,
        usd: 0,
      };
      current.calls++;
      current.inputTokens += usage.input;
      current.outputTokens += usage.output;
      current.cachedTokens += usage.cached;
      current.inputUsd += breakdown.inputUsd;
      current.outputUsd += breakdown.outputUsd;
      current.cachedUsd += breakdown.cachedUsd;
      current.usd += breakdown.totalUsd;
      this.costsByModel.set(model, current);
    }
    if (call && this.telemetry) {
      const finishReason = safeFinishReason(call.finishReason);
      this.emit({
        type: 'llm_call',
        stage: call.stage,
        ...(call.model === undefined ? {} : { model: call.model }),
        ...(call.groupIndex === undefined ? {} : { groupIndex: call.groupIndex }),
        ...(call.fileCount === undefined ? {} : { fileCount: call.fileCount }),
        estimatedInputTokens: call.messages.reduce(
          (total, message) => total + estimateTokens(message.content),
          0,
        ),
        inputTokens: usage.input,
        outputTokens: usage.output,
        cachedTokens: usage.cached,
        estimatedCostUsd: calculateCostWithPricing(usage, pricing.pricing),
        pricingSource: pricing.source,
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


  costBreakdown(): Omit<TokenCostBreakdown, 'totalUsd'> {
    return { ...this.costBreakdownUsd };
  }
  calls(): number {
    return this.callCount;
  }

  cost(): number {
    return this.totalCostUsd;
  }

  modelCosts(): ModelCostBreakdown[] {
    return [...this.costsByModel.values()]
      .map((summary) => ({ ...summary }))
      .sort((a, b) => b.usd - a.usd || a.model.localeCompare(b.model));
  }

  pricingInfo(): PricingResolution {
    return this.pricing;
  }
}

function safeFinishReason(value: string | undefined): TelemetryFinishReason | undefined {
  if (value === undefined) return undefined;
  return SAFE_FINISH_REASONS.has(value as TelemetryFinishReason)
    ? (value as TelemetryFinishReason)
    : 'other';
}
