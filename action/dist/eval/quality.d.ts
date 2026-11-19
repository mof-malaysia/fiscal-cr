import type { AnnotationCategory, PullRequestContext, Severity } from '../src/types/review.js';
/**
 * Deterministic gold-issue matching and quality metrics for the FiscalCR
 * local eval harness.
 *
 * Pure data model + math: no network, no fs, no secrets, no side effects —
 * fully unit-testable in isolation. This module is the stable type contract
 * for the eval case lane (`eval/cases.ts`); its exported types are
 * intentionally small and structural so cases stay decoupled from production
 * code.
 *
 * Matching rules:
 *  - A generated finding is a CANDIDATE for a gold issue when ALL of: exact
 *    path match, overlapping accepted line range, accepted category.
 *    Severity is deliberately NOT part of detection — it is scored separately
 *    as agreement (exact / in-range / out-of-range).
 *  - Candidates are resolved with one-to-one maximum-cardinality bipartite
 *    matching (augmenting path / Kuhn's algorithm) so a greedy first-fit can
 *    never reduce the TP count. Findings are processed in input order and
 *    candidate issues in issue order, so the result is fully deterministic.
 *
 * Zero-denominator conventions (vacuous truth):
 *  - no predictions  (TP=0, FP=0)  => precision 1
 *  - no gold issues  (TP=0, FN=0)  => recall 1
 *  - both empty      (TP=0,FP=0,FN=0) => F1 1
 *  - issue-case silence (gold exists, no predictions) => recall 0, F1 0
 */
/** Severity of a finding. Compatible with the production `Severity` union. */
export type IssueSeverity = Severity;
/** Finding category. Compatible with the production `AnnotationCategory` union. */
export type IssueCategory = AnnotationCategory;
/** A PR-shaped context a benchmark case runs against. */
export type ReviewContext = PullRequestContext;
export declare const SEVERITY_ORDER: readonly IssueSeverity[];
export declare const ISSUE_CATEGORIES: readonly IssueCategory[];
export interface LineRange {
    startLine: number;
    endLine: number;
}
/** A hand-authored gold issue a good reviewer should surface. */
export interface ExpectedIssue {
    issueId: string;
    /** Exact paths where the issue can be reported (any one suffices). */
    acceptedPaths: string[];
    /** Line ranges the finding must overlap to count as this issue. */
    acceptedLineRanges: LineRange[];
    /** Finding categories accepted for this issue. */
    acceptedCategories: IssueCategory[];
    /**
     * Inclusive severity bounds (severity order: critical > warning >
     * suggestion > nitpick). A finding counts when
     * rank(maxSeverity) <= rank(finding) <= rank(minSeverity).
     */
    minSeverity: IssueSeverity;
    maxSeverity: IssueSeverity;
    /**
     * Exact severity used for the 'exact' agreement grade. When omitted,
     * 'exact' requires the bounds to collapse (minSeverity === maxSeverity)
     * and the finding to match that single bound.
     */
    expectedSeverity?: IssueSeverity;
    /** Why this is a real issue (used by humans, never by the matcher). */
    rationale: string;
    /** Optional concrete evidence: line excerpt, commit, symptom. */
    evidence?: string;
}
/** One benchmark case: a PR context plus the gold issues planted in it. */
export interface BenchmarkCase {
    id: string;
    version: number;
    label: string;
    tags: string[];
    context: ReviewContext;
    expectedIssues: ExpectedIssue[];
    /**
     * Known non-issues (paths, titles, or free-form keys) a reviewer should
     * NOT report. Informational only — not used by matching or metrics yet.
     */
    knownDistractors?: string[];
}
/** Minimal finding shape accepted everywhere; parsed findings and retained
 * annotations are structurally compatible with it. */
export interface FindingLike {
    path: string;
    startLine: number;
    endLine: number;
    severity: string;
    category: string;
    title: string;
    body?: string;
}
/** Normalized projection used by the matcher. */
export interface FindingProjection {
    path: string;
    startLine: number;
    endLine: number;
    severity: IssueSeverity;
    category: IssueCategory;
    title: string;
    body: string;
}
/**
 * Normalize a raw finding into a projection: clamps lines to positive
 * integers (endLine >= startLine), maps unknown categories to 'other'
 * (matching the pipeline's zod `.catch('other')`), and unknown severities
 * to 'warning' (defensive; the real pipeline rejects them at parse time).
 */
export declare function projectFinding(f: FindingLike): FindingProjection;
export declare function projectFindings(findings: readonly FindingLike[]): FindingProjection[];
/** 0..3 in SEVERITY_ORDER; lower rank = more severe. */
export declare function severityRank(severity: IssueSeverity): number;
/** Inclusive bounds check on the severity scale, order-agnostic (reversed
 * min/max bounds still define the same interval). */
export declare function severityInRange(severity: IssueSeverity, minSeverity: IssueSeverity, maxSeverity: IssueSeverity): boolean;
export declare function rangesOverlap(a: LineRange, b: LineRange): boolean;
/**
 * Candidate edge predicate. All three must hold: exact path, overlapping
 * accepted line range, accepted category. Severity never gates detection.
 */
export declare function isCandidate(f: FindingProjection, issue: ExpectedIssue): boolean;
export interface MatchingResult {
    /** One entry per input finding, in input order. */
    findings: FindingResult[];
    /** One entry per expected issue, in input order. */
    issues: IssueResult[];
    /** Winning pairs, in finding order. */
    matchedPairs: Array<{
        findingIndex: number;
        issueId: string;
    }>;
}
export type SeverityAgreement = 'exact' | 'in-range' | 'out-of-range';
export interface FindingResult {
    /** Index into the input findings array (stable identity). */
    findingIndex: number;
    /** Gold issue this finding was matched to, or null when unmatched. */
    matchedIssueId: string | null;
    truePositive: boolean;
    /** Unmatched finding that was a candidate for an already-matched gold issue. */
    duplicate: boolean;
    /** Severity grade vs the matched issue; null when unmatched. */
    severityAgreement: SeverityAgreement | null;
}
export interface IssueResult {
    issueId: string;
    detected: boolean;
    /** Index of the finding that detected this issue, or null. */
    matchedFindingIndex: number | null;
}
export declare function matchFindingsToIssues(rawFindings: readonly FindingLike[], issues: readonly ExpectedIssue[]): MatchingResult;
export interface QualitySummary {
    goldIssues: number;
    predictions: number;
    tp: number;
    fp: number;
    fn: number;
    duplicates: number;
    /** False positives with severity critical or warning. */
    severeFalsePositives: number;
    precision: number;
    recall: number;
    f1: number;
    /** True when zero false positives (vacuous for empty predictions). */
    clean: boolean;
    findings: FindingResult[];
    issues: IssueResult[];
    matchedPairs: Array<{
        findingIndex: number;
        issueId: string;
    }>;
}
/** Vacuous-truth helpers; export individually for reuse. */
export declare function precision(tp: number, fp: number): number;
export declare function recall(tp: number, fn: number): number;
export declare function f1(tp: number, fp: number, fn: number): number;
export declare function computeQualitySummary(rawFindings: readonly FindingLike[], issues: readonly ExpectedIssue[]): QualitySummary;
export interface RunQualityInput {
    case: BenchmarkCase;
    generatedFindings: readonly FindingLike[];
    retainedFindings: readonly FindingLike[];
    outputTokens: number;
}
export interface RunQualityDiagnostics {
    generatedCount: number;
    retainedCount: number;
    /**
     * generated − retained. Labeled ONLY as the arithmetic difference — the
     * current pipeline does not expose why findings were dropped, so no gate
     * rejection reasons are claimed here.
     */
    gatedCount: number;
    tpPer1000TokensPre: number | null;
    tpPer1000TokensPost: number | null;
    outputTokensPerTpPre: number | null;
    outputTokensPerTpPost: number | null;
    nonemptyTitleRatePre: number;
    nonemptyTitleRatePost: number;
    nonemptyBodyRatePre: number;
    nonemptyBodyRatePost: number;
}
export interface RunQualityReport {
    preGate: QualitySummary;
    postGate: QualitySummary;
    diagnostics: RunQualityDiagnostics;
}
export declare function evaluateRunQuality(input: RunQualityInput): RunQualityReport;
export interface QualityAggregateEntry {
    case: BenchmarkCase;
    /** Typically the post-gate (retained) summary; the function is gate-agnostic. */
    summary: QualitySummary;
    outputTokens: number;
}
export interface CaseQualityAggregate {
    caseId: string;
    label: string;
    version: number;
    runs: number;
    tp: number;
    fp: number;
    fn: number;
    duplicates: number;
    severeFalsePositives: number;
    precision: number;
    recall: number;
    f1: number;
    clean: boolean;
}
export interface IssueDetectionAggregate {
    issueId: string;
    /** Number of case occurrences this issue appeared in. */
    occurrences: number;
    detected: number;
    rate: number;
}
export interface AggregateQualitySummary {
    cases: number;
    runs: number;
    totalTp: number;
    totalFp: number;
    totalFn: number;
    duplicates: number;
    severeFalsePositives: number;
    micro: {
        precision: number;
        recall: number;
        f1: number;
    };
    /** Mean of per-run rates (equal weight per run). */
    macro: {
        precision: number;
        recall: number;
        f1: number;
    };
    /** Fraction of runs with zero false positives (1 when no runs). */
    cleanRate: number;
    tpPer1000Tokens: number | null;
    outputTokensPerTp: number | null;
    perCase: CaseQualityAggregate[];
    perIssueDetection: IssueDetectionAggregate[];
}
export declare function aggregateQuality(entries: readonly QualityAggregateEntry[]): AggregateQualitySummary;
export type AggregateRateMetric = 'cleanRate' | 'microPrecision' | 'microRecall' | 'microF1' | 'macroPrecision' | 'macroRecall' | 'macroF1';
export interface RegressionOptions {
    metric?: AggregateRateMetric;
    /** Baseline must be >= this to count as a prior good state. Default 0.75. */
    baselineThreshold?: number;
    /** Experimental must be <= this to count as a regression. Default 0.25. */
    experimentalThreshold?: number;
}
export interface RegressionResult {
    regressed: boolean;
    metric: AggregateRateMetric;
    baseline: number;
    experimental: number;
    baselineThreshold: number;
    experimentalThreshold: number;
}
export declare function detectLargeRegression(baseline: number | AggregateQualitySummary, experimental: number | AggregateQualitySummary, options?: RegressionOptions): RegressionResult;
export type VariantWinner = 'baseline' | 'experimental' | 'tie';
export interface VariantComparison {
    winner: VariantWinner;
    /** experimental − baseline. */
    delta: number;
}
/**
 * Direction-aware comparison of one metric across the two variants.
 * `higherIsBetter=true` for rates/F1/clean-rate/TP-per-1k; false for FP
 * counts, tokens, chars, duration. Returns null when either side is missing
 * or non-finite (never a fake tie). `delta` is always experimental −
 * baseline, so with `higherIsBetter=false` a negative delta means
 * experimental is better.
 */
export declare function compareVariants(baseline: number | null | undefined, experimental: number | null | undefined, higherIsBetter: boolean): VariantComparison | null;
//# sourceMappingURL=quality.d.ts.map