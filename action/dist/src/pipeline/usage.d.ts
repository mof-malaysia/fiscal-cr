import type { PricingContext, PricingResolution, PricingSource } from '../utils/pricing.js';
import type { LLMTokenUsage } from '../providers/interface.js';
import type { ChatMessage } from '../types/review.js';
export type TelemetryStage = 'intent' | 'group-review' | 'synthesis' | 'fast-path';
export type TelemetryFinishReason = 'stop' | 'length' | 'content_filter' | 'tool_calls' | 'function_call' | 'other';
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
export type TelemetryEvent = LLMCallTelemetryEvent | StageResultTelemetryEvent | ReviewCompletedTelemetryEvent;
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
/** Aggregates token usage and provider-specific cost across all pipeline LLM calls. */
export declare class UsageTracker {
    private readonly telemetry?;
    private totals;
    private callCount;
    private totalCostUsd;
    private readonly pricing;
    private readonly pricingContext;
    private readonly pricingByModel;
    constructor(telemetry?: TelemetrySink | undefined, pricingContext?: PricingContext, pricingResolutions?: ReadonlyMap<string, PricingResolution>);
    private pricingForModel;
    startCall(): void;
    add(usage: LLMTokenUsage, call?: LLMCallTelemetry): void;
    emit(event: TelemetryEvent): void;
    total(): LLMTokenUsage;
    calls(): number;
    cost(): number;
    pricingInfo(): PricingResolution;
}
//# sourceMappingURL=usage.d.ts.map