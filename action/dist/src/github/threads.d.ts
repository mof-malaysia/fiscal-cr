import type { Octokit } from '@octokit/rest';
import type { Severity } from '../types/review.js';
export interface FiscalcrThread {
    id: string;
    isResolved: boolean;
    path: string;
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
}): Promise<FiscalcrThread[]>;
/**
 * Resolve unresolved FiscalCR threads whose file changed in this run but whose
 * finding did not recur. Returns the threads actually resolved so the caller
 * can adjust its open-finding counts. All failures (403 on default tokens,
 * merged PRs, …) degrade to logging — never fail the review over cleanup.
 */
export declare function resolveOutdatedThreads(octokit: Octokit, params: {
    owner: string;
    repo: string;
    pullNumber: number;
    /** Paths reviewed in this run — only their threads can be judged outdated. */
    changedPaths: Set<string>;
    /** Fingerprints of findings that still exist after this run. */
    currentFingerprints: Set<string>;
    headSha: string;
}): Promise<FiscalcrThread[]>;
//# sourceMappingURL=threads.d.ts.map