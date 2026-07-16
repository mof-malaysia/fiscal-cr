import type { Octokit } from '@octokit/rest';
import type { ReviewConfig } from '../config/schema.js';
import type { ReviewResult } from '../types/review.js';
import type { LLMProvider } from '../providers/interface.js';
interface ReviewParams {
    owner: string;
    repo: string;
    pullNumber: number;
    headSha: string;
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
    private runReview;
}
export {};
//# sourceMappingURL=orchestrator.d.ts.map