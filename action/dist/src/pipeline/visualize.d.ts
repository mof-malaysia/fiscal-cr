import type { LLMProvider } from '../providers/interface.js';
import type { PullRequestContext } from '../types/review.js';
import type { ReviewConfig } from '../config/schema.js';
import type { VisualArtifact, VisualMode } from '../types/visual.js';
import type { UsageTracker } from './usage.js';
/** Hard estimated-token budget for the entire visualize call (template + envelope + evidence). */
export declare const VISUALIZE_MAX_INPUT_TOKENS = 12000;
/**
 * Select one code-owned visual mode from changed-file metadata. The selector is
 * deliberately lexical and deterministic: the model never decides whether a
 * patch is a concept or implementation visualization.
 */
export declare function selectVisualMode(ctx: PullRequestContext, requested: ReviewConfig['review']['visualize']['mode']): VisualMode | undefined;
/**
 * Keep visualization generation for changes where a visual can add signal: at least
 * the configured number of reviewable files and enough churn to imply a
 * non-trivial relationship. This gate runs before evidence selection and the
 * provider call.
 */
export declare function shouldGenerateVisual(ctx: PullRequestContext, thresholds: Pick<ReviewConfig['review']['visualize'], 'minChangedFiles' | 'minChangedLines'>): boolean;
/**
 * Optionally generate a bounded visualization for a review.
 *
 * Disabled config or unusable input returns `undefined` without any model
 * call. On success the artifact is built from the parsed visual with
 * code-owned `headSha`/`scope` and an evidence mapping that never carries raw
 * patches. Every optional step — evidence selection, model resolution, the
 * provider call, and parsing — is wrapped locally so a failure can never
 * affect the ordinary review result. Exactly one provider call is made; the
 * provider's own retry abstraction is reused. Spend is recorded for every
 * completed call, even when the visualization is later rejected.
 */
export declare function generateVisual(llm: LLMProvider, ctx: PullRequestContext, config: ReviewConfig, usage: UsageTracker, options: {
    scope: 'full' | 'delta';
    reviewedPaths: readonly string[];
}): Promise<VisualArtifact | undefined>;
//# sourceMappingURL=visualize.d.ts.map