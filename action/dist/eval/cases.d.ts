import type { PullRequestContext } from '../src/types/review.js';
import { type BenchmarkCase, type IssueSeverity } from './quality.js';
/**
 * Deterministic gold benchmark suite for the local fast-path eval.
 *
 * 10 synthetic PRs, each small enough to stay on the fast path
 * (`DEFAULT_CONFIG.pipeline.fastPathThreshold`), with 20 independently
 * identifiable gold issues across 8 defective cases and 2 closed-world clean
 * cases. No network, no filesystem, no real secrets.
 *
 * Manifest types (BenchmarkCase, ExpectedIssue, IssueSeverity, IssueCategory,
 * LineRange) are the canonical contract exported by `eval/quality.ts`
 * (the matcher lane). They are re-exported here, so this file holds only
 * fixture data and never duplicates type declarations. The matcher accepts
 * these cases directly (canonical `id`/`label`/`context`/`minSeverity`/
 * `maxSeverity`/`startLine` fields).
 */
export type { BenchmarkCase, ExpectedIssue, IssueCategory, IssueSeverity, LineRange } from './quality.js';
/** Severity constants — canonical order from the matcher lane. */
export declare const ISSUE_SEVERITIES: readonly IssueSeverity[];
export { ISSUE_CATEGORIES } from './quality.js';
export declare const SUITE_ID = "fiscalcr-eval-v3-pipeline";
export declare const SUITE_VERSION = 1;
/** Per-case manifest version (bump when a case's gold issues change). */
export declare const CASE_VERSION = 1;
/** The 3 smoke cases: one clean, one local correctness, one security. */
export declare const SMOKE_CASE_IDS: string[];
/** True when the case is expected to have zero gold issues (closed world). */
export declare function isCleanCase(c: BenchmarkCase): boolean;
export declare const EVAL_CASES: BenchmarkCase[];
/** Exactly the 3 smoke cases (subset of EVAL_CASES). */
export declare function getSmokeCaseIds(): string[];
/** All 10 case ids. */
export declare function getFullCaseIds(): string[];
export declare function getCaseById(caseId: string): BenchmarkCase;
export declare function getCases(ids: string[]): BenchmarkCase[];
/** Resolves an exact comma-separated selection, e.g. "clean-01, local-01". */
export declare function getCaseIds(csv: string): string[];
/**
 * Mirrors ReviewOrchestrator's fast-path token accounting
 * (sum of patch tokens + file content tokens).
 */
export declare function estimateContextTokens(ctx: PullRequestContext): number;
//# sourceMappingURL=cases.d.ts.map