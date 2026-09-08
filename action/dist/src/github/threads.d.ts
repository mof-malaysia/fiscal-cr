import type { Octokit } from '@octokit/rest';
import type { ReviewedRange, Severity } from '../types/review.js';
export interface FiscalcrThread {
    id: string;
    isResolved: boolean;
    path: string;
    line?: number | null;
    fingerprint: string;
    severity: Severity | null;
}
/**
 * List review threads on the PR that FiscalCR created, identified by the
 * hidden fingerprint marker in the thread's first comment.
 */
export declare function listFiscalcrThreads(octokit: Octokit, params: {
    owner: string;
    repo: string;
    pullNumber: number;
}, options?: {
    includeOutdated?: boolean;
}): Promise<FiscalcrThread[]>;
/**
 * Resolve unresolved FiscalCR threads whose file changed in this run but whose
 * finding did not recur. This path intentionally includes outdated threads;
 * manual webhook handling uses the default current-thread view. Returns the
 * threads actually resolved so the caller can mark them fixed. All failures
 * (403 on default tokens, merged PRs, …) degrade to logging — never fail the
 * review over cleanup.
 */
export declare function resolveOutdatedThreads(octokit: Octokit, params: {
    owner: string;
    repo: string;
    pullNumber: number;
    /** Paths reviewed in this run — only their threads can be judged outdated. */
    changedPaths: Set<string>;
    /** Delta line manifest, when paths alone are too broad. */
    reviewedRanges?: ReviewedRange[];
    /** Fingerprints of findings that still exist after this run. */
    currentFingerprints: Set<string>;
    headSha: string;
}): Promise<FiscalcrThread[]>;
//# sourceMappingURL=threads.d.ts.map