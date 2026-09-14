import type { ReviewResult } from '../types/review.js';
/**
 * Build a markdown summary for the Check Run output.
 *
 * The check surface follows the reviewer reading order: summary, optional map,
 * walkthrough, findings, then score and accounting metadata. Intent remains
 * synthesis context and is not rendered as a second summary.
 */
export declare function buildSummary(result: ReviewResult): string;
//# sourceMappingURL=summary-builder.d.ts.map