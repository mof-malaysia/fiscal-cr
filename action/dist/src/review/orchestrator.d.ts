import type { Octokit } from '@octokit/rest';
import type { ReviewConfig } from '../config/schema.js';
import type { ReviewResult } from '../types/review.js';
import type { LLMProvider } from '../providers/interface.js';
interface ReviewParams {
    owner: string;
    repo: string;
    pullNumber: number;
    headSha: string;
    /** Review the whole PR even when a delta would suffice (@fiscalcr review). */
    forceFull?: boolean;
}
export interface OrchestratorOptions {
    /** Local checkout root (Action mode). Enables disk reads instead of API fetches. */
    workspaceRoot?: string;
}
export declare class ReviewOrchestrator {
    private octokit;
    private llm;
    private config;
    private options;
    constructor(octokit: Octokit, llm: LLMProvider, config: ReviewConfig, options?: OrchestratorOptions);
    reviewPullRequest(params: ReviewParams): Promise<ReviewResult>;
    /** Nothing to review — carry the previous conclusion so the check stays honest. */
    private completeSkippedRun;
    /** Pre-sticky behavior: full review stacked on the PR every run. */
    private publishLegacy;
    /**
     * Sticky lifecycle: dedupe vs posted fingerprints → resolve outdated threads
     * → manage the blocking review → post incremental review → update the sticky
     * summary comment (which persists the state — always saved last).
     */
    private publishSticky;
    private buildIncrementalBody;
    private runReview;
}
export {};
//# sourceMappingURL=orchestrator.d.ts.map