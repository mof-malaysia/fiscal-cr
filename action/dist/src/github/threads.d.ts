import type { FiscalcrOctokit } from './client.js';
import type { ReviewedRange, Severity } from '../types/review.js';
export interface FiscalcrThread {
    id: string;
    isResolved: boolean;
    isOutdated: boolean;
    path: string;
    line?: number | null;
    originalLine?: number | null;
    fingerprint: string;
    severity: Severity | null;
}
/** Return whether the host supplied the optional GraphQL capability. */
export declare function hasGraphql(octokit: FiscalcrOctokit): octokit is FiscalcrOctokit & {
    graphql: NonNullable<FiscalcrOctokit['graphql']>;
};
/**
 * List review threads on the PR that FiscalCR created, identified by the
 * hidden fingerprint marker in the thread's first comment.
 */
export declare function listFiscalcrThreads(octokit: FiscalcrOctokit, params: {
    owner: string;
    repo: string;
    pullNumber: number;
}, options?: {
    includeOutdated?: boolean;
}): Promise<FiscalcrThread[]>;
export interface ThreadResolutionResult {
    attempted: number;
    resolved: FiscalcrThread[];
    failed: number;
    unavailable?: boolean;
}
/**
 * Resolve unresolved FiscalCR threads whose file changed in this run but whose
 * finding did not recur. This path intentionally includes outdated threads;
 * manual webhook handling uses the default current-thread view. All failures
 * degrade to logging — never fail the review over cleanup.
 */
export declare function resolveOutdatedThreads(octokit: FiscalcrOctokit, params: {
    owner: string;
    repo: string;
    pullNumber: number;
    /** Paths reviewed in this run — only their threads can be judged outdated. */
    changedPaths: Set<string>;
    /** Delta line manifest, when paths alone are too broad. */
    reviewedRanges?: ReviewedRange[];
    /** Fingerprints of findings that still exist after this run. */
    currentFingerprints: Set<string>;
    /**
     * Fixed fingerprints from successful reconciliation. When provided, this
     * authoritative set replaces the fallback path/range scope checks.
     */
    fixedFingerprints?: Set<string>;
    headSha: string;
}): Promise<ThreadResolutionResult>;
//# sourceMappingURL=threads.d.ts.map