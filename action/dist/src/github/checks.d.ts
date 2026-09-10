import type { Octokit } from '@octokit/rest';
import type { ReviewAnnotation } from '../types/review.js';
export declare function createCheckRun(octokit: Octokit, params: {
    owner: string;
    repo: string;
    headSha: string;
    name?: string;
}): Promise<number>;
export declare function completeCheckRun(octokit: Octokit, params: {
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