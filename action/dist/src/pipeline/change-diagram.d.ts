import type { LLMProvider } from '../providers/interface.js';
import type { PullRequestContext } from '../types/review.js';
import type { ReviewConfig } from '../config/schema.js';
import type { DiagramArtifact } from '../types/diagram.js';
import type { UsageTracker } from './usage.js';
/** Hard estimated-token budget for the entire diagram call (template + envelope + evidence). */
export declare const DIAGRAM_MAX_INPUT_TOKENS = 12000;
/**
 * Keep diagram generation for changes where a graph can add signal: at least
 * the configured number of reviewable files and enough churn to imply a
 * non-trivial relationship. This gate runs before evidence selection and the
 * provider call.
 */
export declare function shouldGenerateChangeDiagram(ctx: PullRequestContext, thresholds: Pick<ReviewConfig['review']['diagram'], 'minChangedFiles' | 'minChangedLines'>): boolean;
/**
 * Optionally generate a bounded change diagram for a review.
 *
 * Disabled config or unusable input returns `undefined` without any model
 * call. On success the artifact is built from the model's parsed graph with
 * code-owned `headSha`/`scope` and an evidence mapping that never carries raw
 * patches. Every optional step — evidence selection, model resolution, the
 * provider call, and parsing — is wrapped locally so a failure can never
 * affect the ordinary review result. Exactly one provider call is made; the
 * provider's own retry abstraction is reused. Spend is recorded for every
 * completed call, even when the diagram is later rejected.
 */
export declare function generateChangeDiagram(llm: LLMProvider, ctx: PullRequestContext, config: ReviewConfig, usage: UsageTracker, options: {
    scope: 'full' | 'delta';
    reviewedPaths: readonly string[];
}): Promise<DiagramArtifact | undefined>;
//# sourceMappingURL=change-diagram.d.ts.map