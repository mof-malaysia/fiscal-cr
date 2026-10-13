import type { FiscalcrOctokit } from './client.js';
import type { ReviewAnnotation } from '../types/review.js';
export declare function createCheckRun(octokit: FiscalcrOctokit, params: {
    owner: string;
    repo: string;
    headSha: string;
    name?: string;
}): Promise<number>;
export declare function completeCheckRun(octokit: FiscalcrOctokit, params: {
    owner: string;
    repo: string;
    checkRunId: number;
    conclusion: 'success' | 'failure' | 'neutral';
    summary: string;
    annotations: ReviewAnnotation[];
    /** Debug metadata only (review scope, call counts) — never parsed back. */
    externalId?: string;
}): Promise<void>;
//# sourceMappingURL=checks.d.ts.map