import type { ReviewResult } from '../types/review.js';
/** Render user-facing token usage and cost details. */
export interface TelemetrySummaryOptions {
    /** Replace the current-run cost with cumulative sticky-review spend. */
    cumulativeCostUsd?: number;
}
export declare function renderTelemetrySummary(result: ReviewResult, heading?: string, options?: TelemetrySummaryOptions): string[];
//# sourceMappingURL=telemetry-summary.d.ts.map