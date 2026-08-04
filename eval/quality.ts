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

// ---------------------------------------------------------------------------
// Stable type contract (shared with the eval-cases lane)

/** Severity of a finding. Compatible with the production `Severity` union. */
export type IssueSeverity = Severity;

/** Finding category. Compatible with the production `AnnotationCategory` union. */
export type IssueCategory = AnnotationCategory;

/** A PR-shaped context a benchmark case runs against. */
export type ReviewContext = PullRequestContext;

export const SEVERITY_ORDER: readonly IssueSeverity[] = [
  'critical',
  'warning',
  'suggestion',
  'nitpick',
] as const;

export const ISSUE_CATEGORIES: readonly IssueCategory[] = [
  'bug',
  'security',
  'performance',
  'style',
  'best-practice',
  'documentation',
  'testing',
  'other',
] as const;

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

// ---------------------------------------------------------------------------
// Finding projection (structural subset of ReviewAnnotation)

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
export function projectFinding(f: FindingLike): FindingProjection {
  const rawStart = Number.isFinite(f.startLine) ? Math.floor(f.startLine) : 1;
  const startLine = Math.max(1, rawStart);
  const rawEnd = Number.isFinite(f.endLine) ? Math.floor(f.endLine) : startLine;
  const endLine = Math.max(startLine, rawEnd);
  const severity = (SEVERITY_ORDER as readonly string[]).includes(f.severity)
    ? (f.severity as IssueSeverity)
    : 'warning';
  const category = (ISSUE_CATEGORIES as readonly string[]).includes(f.category)
    ? (f.category as IssueCategory)
    : 'other';
  return {
    path: f.path,
    startLine,
    endLine,
    severity,
    category,
    title: f.title ?? '',
    body: f.body ?? '',
  };
}

export function projectFindings(findings: readonly FindingLike[]): FindingProjection[] {
  return findings.map(projectFinding);
}

// ---------------------------------------------------------------------------
// Severity + geometry helpers

/** 0..3 in SEVERITY_ORDER; lower rank = more severe. */
export function severityRank(severity: IssueSeverity): number {
  return SEVERITY_ORDER.indexOf(severity);
}

/** Inclusive bounds check on the severity scale, order-agnostic (reversed
 * min/max bounds still define the same interval). */
export function severityInRange(
  severity: IssueSeverity,
  minSeverity: IssueSeverity,
  maxSeverity: IssueSeverity,
): boolean {
  const rank = severityRank(severity);
  const lo = Math.min(severityRank(minSeverity), severityRank(maxSeverity));
  const hi = Math.max(severityRank(minSeverity), severityRank(maxSeverity));
  return rank >= lo && rank <= hi;
}

export function rangesOverlap(a: LineRange, b: LineRange): boolean {
  return a.startLine <= b.endLine && b.startLine <= a.endLine;
}

/**
 * Candidate edge predicate. All three must hold: exact path, overlapping
 * accepted line range, accepted category. Severity never gates detection.
 */
export function isCandidate(f: FindingProjection, issue: ExpectedIssue): boolean {
  if (!issue.acceptedPaths.includes(f.path)) return false;
  if (!issue.acceptedCategories.includes(f.category)) return false;
  return issue.acceptedLineRanges.some((r) =>
    rangesOverlap({ startLine: f.startLine, endLine: f.endLine }, r),
  );
}

// ---------------------------------------------------------------------------
// Maximum-cardinality bipartite matching

export interface MatchingResult {
  /** One entry per input finding, in input order. */
  findings: FindingResult[];
  /** One entry per expected issue, in input order. */
  issues: IssueResult[];
  /** Winning pairs, in finding order. */
  matchedPairs: Array<{ findingIndex: number; issueId: string }>;
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

function severityAgreementFor(
  finding: FindingProjection,
  issue: ExpectedIssue,
): SeverityAgreement {
  const minSeverity = issue.minSeverity;
  const maxSeverity = issue.maxSeverity;
  const inBounds = severityInRange(finding.severity, minSeverity, maxSeverity);
  if (!inBounds) return 'out-of-range';
  const exact =
    issue.expectedSeverity !== undefined
      ? finding.severity === issue.expectedSeverity
      : minSeverity === maxSeverity && finding.severity === minSeverity;
  return exact ? 'exact' : 'in-range';
}

export function matchFindingsToIssues(
  rawFindings: readonly FindingLike[],
  issues: readonly ExpectedIssue[],
): MatchingResult {
  const findings = projectFindings(rawFindings);
  // Candidate edges, ascending issue index per finding (deterministic).
  const candidates: number[][] = findings.map((f) => {
    const list: number[] = [];
    for (let i = 0; i < issues.length; i++) {
      if (isCandidate(f, issues[i])) list.push(i);
    }
    return list;
  });

  // Kuhn's augmenting-path algorithm. matchIssue[i] = finding index or -1.
  const matchIssue = new Array<number>(issues.length).fill(-1);

  const tryKuhn = (findingIndex: number, visited: boolean[]): boolean => {
    for (const issueIndex of candidates[findingIndex]) {
      if (visited[issueIndex]) continue;
      visited[issueIndex] = true;
      const owner = matchIssue[issueIndex];
      if (owner === -1 || tryKuhn(owner, visited)) {
        matchIssue[issueIndex] = findingIndex;
        return true;
      }
    }
    return false;
  };

  for (let f = 0; f < findings.length; f++) {
    tryKuhn(f, new Array<boolean>(issues.length).fill(false));
  }

  const findingToIssue = new Array<number>(findings.length).fill(-1);
  const issueResults: IssueResult[] = [];
  for (let i = 0; i < issues.length; i++) {
    const owner = matchIssue[i];
    const detected = owner !== -1;
    if (detected) findingToIssue[owner] = i;
    issueResults.push({
      issueId: issues[i].issueId,
      detected,
      matchedFindingIndex: detected ? owner : null,
    });
  }

  // Per-finding results: matched => TP; unmatched candidate for a matched
  // issue => duplicate; otherwise a plain FP.
  const findingResults: FindingResult[] = findings.map((f, idx) => {
    const issueIndex = findingToIssue[idx];
    if (issueIndex === -1) {
      const duplicate = candidates[idx].some(
        (i) => matchIssue[i] !== -1 && matchIssue[i] !== idx,
      );
      return {
        findingIndex: idx,
        matchedIssueId: null,
        truePositive: false,
        duplicate,
        severityAgreement: null,
      };
    }
    const issue = issues[issueIndex];
    return {
      findingIndex: idx,
      matchedIssueId: issue.issueId,
      truePositive: true,
      duplicate: false,
      severityAgreement: severityAgreementFor(f, issue),
    };
  });

  const matchedPairs: Array<{ findingIndex: number; issueId: string }> = [];
  for (let f = 0; f < findings.length; f++) {
    const i = findingToIssue[f];
    if (i !== -1) matchedPairs.push({ findingIndex: f, issueId: issues[i].issueId });
  }

  return { findings: findingResults, issues: issueResults, matchedPairs };
}

// ---------------------------------------------------------------------------
// Quality summary

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
  matchedPairs: Array<{ findingIndex: number; issueId: string }>;
}

/** Vacuous-truth helpers; export individually for reuse. */
export function precision(tp: number, fp: number): number {
  return tp + fp === 0 ? 1 : tp / (tp + fp);
}

export function recall(tp: number, fn: number): number {
  return tp + fn === 0 ? 1 : tp / (tp + fn);
}

export function f1(tp: number, fp: number, fn: number): number {
  if (tp === 0 && fp === 0 && fn === 0) return 1;
  return (2 * tp) / (2 * tp + fp + fn);
}

export function computeQualitySummary(
  rawFindings: readonly FindingLike[],
  issues: readonly ExpectedIssue[],
): QualitySummary {
  const matching = matchFindingsToIssues(rawFindings, issues);
  const tp = matching.matchedPairs.length;
  const predictions = rawFindings.length;
  const fp = predictions - tp;
  const fn = issues.length - tp;
  const duplicates = matching.findings.filter((f) => f.duplicate).length;

  // Severe FPs: false positives whose projected severity is critical/warning.
  const projections = projectFindings(rawFindings);
  let severeFp = 0;
  for (let i = 0; i < projections.length; i++) {
    if (!matching.findings[i].truePositive) {
      const s = projections[i].severity;
      if (s === 'critical' || s === 'warning') severeFp++;
    }
  }

  return {
    goldIssues: issues.length,
    predictions,
    tp,
    fp,
    fn,
    duplicates,
    severeFalsePositives: severeFp,
    precision: precision(tp, fp),
    recall: recall(tp, fn),
    f1: f1(tp, fp, fn),
    clean: fp === 0,
    findings: matching.findings,
    issues: matching.issues,
    matchedPairs: matching.matchedPairs,
  };
}

// ---------------------------------------------------------------------------
// Per-run evaluation (pre-gate vs post-gate)

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

function nonemptyRate(findings: readonly FindingProjection[], key: 'title' | 'body'): number {
  if (findings.length === 0) return 1; // vacuous: no finding violated the rule
  return findings.filter((f) => f[key].trim().length > 0).length / findings.length;
}

function tpPer1000Tokens(tp: number, tokens: number): number | null {
  if (tokens === 0) return null;
  return (tp / tokens) * 1000;
}

function tokensPerTp(tokens: number, tp: number): number | null {
  if (tp === 0) return null;
  return tokens / tp;
}

export function evaluateRunQuality(input: RunQualityInput): RunQualityReport {
  const preGate = computeQualitySummary(input.generatedFindings, input.case.expectedIssues);
  const postGate = computeQualitySummary(input.retainedFindings, input.case.expectedIssues);
  const projectedPre = projectFindings(input.generatedFindings);
  const projectedPost = projectFindings(input.retainedFindings);

  return {
    preGate,
    postGate,
    diagnostics: {
      generatedCount: input.generatedFindings.length,
      retainedCount: input.retainedFindings.length,
      gatedCount: input.generatedFindings.length - input.retainedFindings.length,
      tpPer1000TokensPre: tpPer1000Tokens(preGate.tp, input.outputTokens),
      tpPer1000TokensPost: tpPer1000Tokens(postGate.tp, input.outputTokens),
      outputTokensPerTpPre: tokensPerTp(input.outputTokens, preGate.tp),
      outputTokensPerTpPost: tokensPerTp(input.outputTokens, postGate.tp),
      nonemptyTitleRatePre: nonemptyRate(projectedPre, 'title'),
      nonemptyTitleRatePost: nonemptyRate(projectedPost, 'title'),
      nonemptyBodyRatePre: nonemptyRate(projectedPre, 'body'),
      nonemptyBodyRatePost: nonemptyRate(projectedPost, 'body'),
    },
  };
}

// ---------------------------------------------------------------------------
// Aggregation across runs/cases

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
  micro: { precision: number; recall: number; f1: number };
  /** Mean of per-run rates (equal weight per run). */
  macro: { precision: number; recall: number; f1: number };
  /** Fraction of runs with zero false positives (1 when no runs). */
  cleanRate: number;
  tpPer1000Tokens: number | null;
  outputTokensPerTp: number | null;
  perCase: CaseQualityAggregate[];
  perIssueDetection: IssueDetectionAggregate[];
}

function mean(nums: number[]): number {
  return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function aggregateQuality(
  entries: readonly QualityAggregateEntry[],
): AggregateQualitySummary {
  const totalTp = entries.reduce((s, e) => s + e.summary.tp, 0);
  const totalFp = entries.reduce((s, e) => s + e.summary.fp, 0);
  const totalFn = entries.reduce((s, e) => s + e.summary.fn, 0);
  const totalTokens = entries.reduce((s, e) => s + e.outputTokens, 0);

  const perCaseMap = new Map<string, CaseQualityAggregate>();
  for (const entry of entries) {
    const c = entry.case;
    const existing = perCaseMap.get(c.id);
    if (existing) {
      existing.runs += 1;
      existing.tp += entry.summary.tp;
      existing.fp += entry.summary.fp;
      existing.fn += entry.summary.fn;
      existing.duplicates += entry.summary.duplicates;
      existing.severeFalsePositives += entry.summary.severeFalsePositives;
      existing.precision = precision(existing.tp, existing.fp);
      existing.recall = recall(existing.tp, existing.fn);
      existing.f1 = f1(existing.tp, existing.fp, existing.fn);
      existing.clean = existing.fp === 0;
    } else {
      perCaseMap.set(c.id, {
        caseId: c.id,
        label: c.label,
        version: c.version,
        runs: 1,
        tp: entry.summary.tp,
        fp: entry.summary.fp,
        fn: entry.summary.fn,
        duplicates: entry.summary.duplicates,
        severeFalsePositives: entry.summary.severeFalsePositives,
        precision: precision(entry.summary.tp, entry.summary.fp),
        recall: recall(entry.summary.tp, entry.summary.fn),
        f1: f1(entry.summary.tp, entry.summary.fp, entry.summary.fn),
        clean: entry.summary.fp === 0,
      });
    }
  }
  const perCase: CaseQualityAggregate[] = [...perCaseMap.values()];

  // Per-issue detection across every (case, issue) occurrence.
  const issueMap = new Map<string, { occurrences: number; detected: number }>();
  for (const entry of entries) {
    const resultById = new Map(entry.summary.issues.map((r) => [r.issueId, r]));
    for (const issue of entry.case.expectedIssues) {
      const bucket = issueMap.get(issue.issueId) ?? { occurrences: 0, detected: 0 };
      bucket.occurrences += 1;
      if (resultById.get(issue.issueId)?.detected) bucket.detected += 1;
      issueMap.set(issue.issueId, bucket);
    }
  }
  const perIssueDetection: IssueDetectionAggregate[] = [...issueMap.entries()].map(
    ([issueId, b]) => ({
      issueId,
      occurrences: b.occurrences,
      detected: b.detected,
      rate: b.occurrences > 0 ? b.detected / b.occurrences : 1,
    }),
  );

  const empty = entries.length === 0;
  const micro = {
    precision: empty ? 1 : precision(totalTp, totalFp),
    recall: empty ? 1 : recall(totalTp, totalFn),
    f1: empty ? 1 : f1(totalTp, totalFp, totalFn),
  };
  const macro = empty
    ? { precision: 1, recall: 1, f1: 1 }
    : {
        precision: mean(entries.map((e) => e.summary.precision)),
        recall: mean(entries.map((e) => e.summary.recall)),
        f1: mean(entries.map((e) => e.summary.f1)),
      };

  return {
    cases: perCase.length,
    runs: entries.length,
    totalTp,
    totalFp,
    totalFn,
    duplicates: entries.reduce((s, e) => s + e.summary.duplicates, 0),
    severeFalsePositives: entries.reduce((s, e) => s + e.summary.severeFalsePositives, 0),
    micro,
    macro,
    cleanRate: empty ? 1 : entries.filter((e) => e.summary.fp === 0).length / entries.length,
    tpPer1000Tokens: totalTokens === 0 ? null : (totalTp / totalTokens) * 1000,
    outputTokensPerTp: totalTp === 0 ? null : totalTokens / totalTp,
    perCase,
    perIssueDetection,
  };
}

// ---------------------------------------------------------------------------
// Large-regression helper (generic baseline vs experimental inputs)

export type AggregateRateMetric =
  | 'cleanRate'
  | 'microPrecision'
  | 'microRecall'
  | 'microF1'
  | 'macroPrecision'
  | 'macroRecall'
  | 'macroF1';

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

function rateOf(agg: AggregateQualitySummary, metric: AggregateRateMetric): number {
  switch (metric) {
    case 'cleanRate':
      return agg.cleanRate;
    case 'microPrecision':
      return agg.micro.precision;
    case 'microRecall':
      return agg.micro.recall;
    case 'microF1':
      return agg.micro.f1;
    case 'macroPrecision':
      return agg.macro.precision;
    case 'macroRecall':
      return agg.macro.recall;
    case 'macroF1':
      return agg.macro.f1;
  }
}

export function detectLargeRegression(
  baseline: number | AggregateQualitySummary,
  experimental: number | AggregateQualitySummary,
  options: RegressionOptions = {},
): RegressionResult {
  const metric: AggregateRateMetric = options.metric ?? 'cleanRate';
  const baselineThreshold = options.baselineThreshold ?? 0.75;
  const experimentalThreshold = options.experimentalThreshold ?? 0.25;
  const baselineRate = typeof baseline === 'number' ? baseline : rateOf(baseline, metric);
  const experimentalRate =
    typeof experimental === 'number' ? experimental : rateOf(experimental, metric);

  return {
    regressed: baselineRate >= baselineThreshold && experimentalRate <= experimentalThreshold,
    metric,
    baseline: baselineRate,
    experimental: experimentalRate,
    baselineThreshold,
    experimentalThreshold,
  };
}
