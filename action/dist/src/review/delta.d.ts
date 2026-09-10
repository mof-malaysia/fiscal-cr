import type { Octokit } from '@octokit/rest';
import type { ReviewConfig } from '../config/schema.js';
import type { ReviewState } from '../github/review-state.js';
export interface ScopeDecision {
    mode: 'full' | 'delta' | 'skip';
    /** Delta only: paths changed since the last reviewed commit. */
    paths?: string[];
    /** Delta only: the commit the delta is measured from. */
    sinceSha?: string;
    reason: string;
}
/**
 * Decide whether this run reviews the whole PR, only what changed since the
 * last reviewed commit, or nothing at all. Every uncertain case falls back to
 * a full review — a wasted full review is cheap, a missed finding is not.
 */
export declare function decideScope(octokit: Octokit, params: {
    owner: string;
    repo: string;
    headSha: string;
    baseSha: string;
    state: ReviewState | null;
    forceFull?: boolean;
    config: ReviewConfig;
}): Promise<ScopeDecision>;
//# sourceMappingURL=delta.d.ts.map