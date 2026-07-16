import type { PullRequestContext, ReviewResult } from '../types/review.js';
import type { ReviewConfig } from '../config/schema.js';
import type { LLMProvider } from '../providers/interface.js';
import type { UsageTracker } from './usage.js';
/**
 * Fast path: one combined call for small PRs (and the `pipeline.enabled: false`
 * kill-switch). Same output contract and code-side validation as the pipeline.
 */
export declare function runFastPath(llm: LLMProvider, ctx: PullRequestContext, config: ReviewConfig, usage: UsageTracker, deltaHint?: string): Promise<ReviewResult>;
//# sourceMappingURL=fast-path.d.ts.map