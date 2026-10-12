import type { ReviewAnnotation, WalkthroughEntry } from '../types/review.js';
/** Confidence assumed when a model omits the field entirely. */
export declare const DEFAULT_CONFIDENCE = 0.7;
export interface IntentResult {
    intent: string;
    walkthrough: WalkthroughEntry[];
    groups: Array<{
        label: string;
        files: string[];
    }>;
    riskHotspots: Array<{
        path: string;
        reason: string;
    }>;
}
export declare function parseIntentResponse(raw: string): IntentResult | null;
export interface GroupReviewResult {
    groupSummary: string;
    findings: ReviewAnnotation[];
}
export declare function parseGroupResponse(raw: string): GroupReviewResult | null;
export interface SynthesisResult {
    summary: string;
    score: number | null;
    walkthrough: WalkthroughEntry[];
    nearDuplicates: string[][];
    likelyFalsePositives: string[];
}
export declare function parseSynthesisResponse(raw: string): SynthesisResult | null;
export interface FastPathResult {
    intent: string;
    summary: string;
    score: number | null;
    walkthrough: WalkthroughEntry[];
    findings: ReviewAnnotation[];
}
export declare function parseFastPathResponse(raw: string): FastPathResult | null;
//# sourceMappingURL=schemas.d.ts.map