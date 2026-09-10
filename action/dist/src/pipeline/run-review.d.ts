import type { PullRequestContext, ReviewResult } from '../types/review.js';
import type { ReviewConfig } from '../config/schema.js';
import type { LLMProvider } from '../providers/interface.js';
import type { UsageTracker } from './usage.js';
export type ReviewRoute = 'fast-path' | 'multi-pass';
export interface RunReviewOptions {
    /** Local checkout root (Action mode). Enables disk reads for related context. */
    workspaceRoot?: string;
    /** Extra prompt hint for delta reviews ("focus on lines changed since …"). */
    deltaHint?: string;
}
export interface RouteDecision {
    route: ReviewRoute;
    estimatedTokens: number;
}
/** Estimate the prompt tokens a review of this PR would consume (patches + full contents). */
export declare function estimateReviewTokens(ctx: PullRequestContext): number;
/**
 * Decide fast-path vs multi-pass without running anything. The fast path wins
 * when the pipeline is disabled or the PR is small enough to fit one call.
 */
export declare function routeReview(ctx: PullRequestContext, config: ReviewConfig): RouteDecision;
/**
 * Run the full review: fast path (single call) or the multi-pass pipeline
 * (intent → grouped review → deterministic validation/ranking → synthesis).
 * Pure computation — no GitHub extraction or publishing happens here.
 */
export declare function runReviewPipeline(llm: LLMProvider, ctx: PullRequestContext, config: ReviewConfig, usage: UsageTracker, options?: RunReviewOptions): Promise<ReviewResult>;
//# sourceMappingURL=run-review.d.ts.map