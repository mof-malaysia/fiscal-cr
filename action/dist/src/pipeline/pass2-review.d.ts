import type { PullRequestContext, ReviewAnnotation } from '../types/review.js';
import type { ReviewConfig } from '../config/schema.js';
import type { LLMProvider } from '../providers/interface.js';
import { type IntentResult } from './schemas.js';
import type { FileGroup } from './grouper.js';
import type { UsageTracker } from './usage.js';
export interface GroupReviewOutcome {
    group: FileGroup;
    summary: string;
    findings: ReviewAnnotation[];
    failed: boolean;
}
export interface ReviewPassOptions {
    workspaceRoot?: string;
    /** Extra prompt hint for delta reviews ("focus on lines changed since …"). */
    deltaHint?: string;
}
/**
 * Pass 2: review each file group in a focused, parallel LLM call.
 * A single failed group degrades the review; it does not abort it.
 */
export declare function runReviewPass(llm: LLMProvider, ctx: PullRequestContext, groups: FileGroup[], intent: IntentResult | null, config: ReviewConfig, usage: UsageTracker, options?: ReviewPassOptions): Promise<GroupReviewOutcome[]>;
//# sourceMappingURL=pass2-review.d.ts.map