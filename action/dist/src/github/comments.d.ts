import type { Octokit } from '@octokit/rest';
import type { ChangedFile, ReviewAnnotation, ReviewResult } from '../types/review.js';
export interface PlacementPartition {
    placeable: ReviewAnnotation[];
    demoted: ReviewAnnotation[];
}
/**
 * Split annotations into those whose end line can host an inline review
 * comment on the PR diff, and those that must be demoted to check-run
 * annotations + a sticky-comment section.
 */
export declare function partitionPlaceable(annotations: ReviewAnnotation[], changedFiles: ChangedFile[]): PlacementPartition;
export interface IncrementalReviewOutcome {
    /** Review id when a review was posted, else null. */
    reviewId: number | null;
    /** Annotations actually posted inline. */
    posted: ReviewAnnotation[];
    /** Annotations demoted out of the inline review (unplaceable or 422 fallback). */
    demoted: ReviewAnnotation[];
}
/**
 * Post one small review containing only this run's new findings. Zero
 * placeable findings and a non-blocking event → nothing is posted at all.
 * A 422 on the inline comments retries once body-only (last resort).
 */
export declare function createIncrementalReview(octokit: Octokit, params: {
    owner: string;
    repo: string;
    pullNumber: number;
    commitSha: string;
    annotations: ReviewAnnotation[];
    changedFiles: ChangedFile[];
    event: 'COMMENT' | 'REQUEST_CHANGES';
    body: string;
}): Promise<IncrementalReviewOutcome>;
/**
 * Dismiss the live blocking review (REQUEST_CHANGES). Failures degrade to a
 * log line — a stale blocking review is annoying, not fatal.
 */
export declare function dismissBlockingReview(octokit: Octokit, params: {
    owner: string;
    repo: string;
    pullNumber: number;
    reviewId: number;
    message: string;
}): Promise<boolean>;
/**
 * Legacy posting mode (`review.comments.mode: 'legacy'`): one full review per
 * run, stacked on top of previous runs. Kept as an opt-out from sticky mode.
 */
export declare function createPRReview(octokit: Octokit, params: {
    owner: string;
    repo: string;
    pullNumber: number;
    commitSha: string;
    result: ReviewResult;
    failOn: 'critical' | 'warning' | 'never';
}): Promise<void>;
//# sourceMappingURL=comments.d.ts.map