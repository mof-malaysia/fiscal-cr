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
    annotations: number;
}
export type TelemetryEvent = LLMCallTelemetryEvent | StageResultTelemetryEvent | ReviewCompletedTelemetryEvent;
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
/** Aggregates token usage and call counts across all pipeline LLM calls. */
export declare class UsageTracker {
    private readonly telemetry?;
    private totals;
    private callCount;
    constructor(telemetry?: TelemetrySink | undefined);
    startCall(): void;
    add(usage: LLMTokenUsage, call?: LLMCallTelemetry): void;
    emit(event: TelemetryEvent): void;
    total(): LLMTokenUsage;
    calls(): number;
}
//# sourceMappingURL=usage.d.ts.map