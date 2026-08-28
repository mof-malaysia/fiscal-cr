import type { Octokit } from '@octokit/rest';
import type { ReviewResult, Severity, WalkthroughEntry } from '../types/review.js';
export interface RunRecord {
    sha: string;
    at: string;
    scope: 'full' | 'delta';
    newFindings: number;
    cost: string;
}
export interface ReviewState {
    v: 1;
    lastReviewedSha: string;
    baseSha: string;
    /** Review id of the live REQUEST_CHANGES review, if any. */
    blockingReviewId: number | null;
    /** Fingerprints of every inline finding ever posted (FIFO-capped). */
    postedFingerprints: string[];
    /** Cumulative open finding counts across the whole PR. */
    openCounts: Record<Severity, number>;
    runs: RunRecord[];
}
export declare const EMPTY_COUNTS: Record<Severity, number>;
/** Parse the hidden state marker out of a comment body. Corrupt/unknown → null. */
export declare function parseStateMarker(body: string): ReviewState | null;
export declare function renderStateMarker(state: ReviewState): string;
/** FIFO-append keeping the newest entries under the cap. */
export declare function appendFingerprints(existing: string[], added: string[]): string[];
export declare function appendRun(runs: RunRecord[], run: RunRecord): RunRecord[];
export interface StickyComment {
    commentId: number;
    state: ReviewState | null;
}
/**
 * Find the sticky FiscalCR comment on a PR by its hidden marker (never by
 * author — works for both github-actions[bot] and App bot users).
 */
export declare function loadReviewState(octokit: Octokit, params: {
    owner: string;
    repo: string;
    pullNumber: number;
}): Promise<StickyComment | null>;
/**
 * Create or update the sticky comment. Re-checks for a concurrently created
 * sticky comment before creating a new one.
 */
export declare function saveStickyComment(octokit: Octokit, params: {
    owner: string;
    repo: string;
    pullNumber: number;
    commentId: number | null;
    body: string;
}): Promise<number>;
export interface StickyCommentInput {
    result: ReviewResult;
    state: ReviewState;
    /** Findings that could not be placed inline (out of diff / over the cap). */
    demoted: Array<{
        path: string;
        startLine: number;
        severity: Severity;
        title: string;
    }>;
    walkthrough?: WalkthroughEntry[];
}
/** Render the full sticky comment body, hidden state marker included. */
export declare function renderStickyComment(input: StickyCommentInput): string;
//# sourceMappingURL=review-state.d.ts.map