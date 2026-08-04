import { describe, expect, it } from 'vitest';
import { getCaseById } from '../cases.js';
import {
  aggregateQuality,
  computeQualitySummary,
  detectLargeRegression,
  evaluateRunQuality,
  f1,
  isCandidate,
  matchFindingsToIssues,
  precision,
  projectFinding,
  recall,
  severityInRange,
  severityRank,
  type BenchmarkCase,
  type ExpectedIssue,
  type FindingLike,
  type QualityAggregateEntry,
} from '../quality.js';

// ---------------------------------------------------------------------------
// Helpers

const CONTEXT = getCaseById('clean-01').context;

function issue(partial: Partial<ExpectedIssue> & { issueId: string }): ExpectedIssue {
  return {
    acceptedPaths: ['src/a.ts'],
    acceptedLineRanges: [{ startLine: 1, endLine: 10 }],
    acceptedCategories: ['bug'],
    minSeverity: 'critical',
    maxSeverity: 'nitpick',
    rationale: 'gold issue',
    ...partial,
  };
}

function finding(partial: Partial<FindingLike> & { path: string }): FindingLike {
  return {
    startLine: 1,
    endLine: 10,
    severity: 'warning',
    category: 'bug',
    title: 'title',
    body: 'body',
    ...partial,
  };
}

function makeCase(
  issues: ExpectedIssue[],
  partial: Partial<BenchmarkCase> = {},
): BenchmarkCase {
  return {
    id: 'case-1',
    version: 1,
    label: 'case-1',
    tags: [],
    context: CONTEXT,
    expectedIssues: issues,
    ...partial,
  };
}

// ---------------------------------------------------------------------------

describe('severity helpers', () => {
  it('ranks severities and checks inclusive bounds', () => {
    expect(severityRank('critical')).toBe(0);
    expect(severityRank('warning')).toBe(1);
    expect(severityRank('suggestion')).toBe(2);
    expect(severityRank('nitpick')).toBe(3);

    expect(severityInRange('warning', 'warning', 'suggestion')).toBe(true);
    expect(severityInRange('suggestion', 'warning', 'suggestion')).toBe(true);
    expect(severityInRange('critical', 'warning', 'suggestion')).toBe(false); // too severe
    expect(severityInRange('nitpick', 'warning', 'suggestion')).toBe(false); // too minor
    expect(severityInRange('critical', 'critical', 'critical')).toBe(true); // collapsed bounds
    expect(severityInRange('nitpick', 'critical', 'nitpick')).toBe(true); // full range
  });
});

describe('projectFinding normalization', () => {
  it('clamps lines, defaults body, and coerces unknown severity/category; endLine >= startLine', () => {
    const p = projectFinding({
      path: 'x.ts',
      startLine: -5,
      endLine: 2,
      severity: 'CRITICAL!!',
      category: 'not-a-category',
      title: 't',
    });
    expect(p.startLine).toBe(1);
    expect(p.endLine).toBe(2);
    expect(p.severity).toBe('warning'); // defensive default
    expect(p.category).toBe('other'); // matches pipeline zod .catch('other')
    expect(p.body).toBe('');

    const flipped = projectFinding({ path: 'x.ts', startLine: 10, endLine: 3, severity: 'warning', category: 'bug', title: 't' });
    expect(flipped.endLine).toBe(10);
  });
});

describe('isCandidate: path / line / category requirements', () => {
  const gold = issue({ issueId: 'i1', acceptedCategories: ['bug', 'security'] });

  it('requires an exact path match', () => {
    expect(isCandidate(projectFinding(finding({ path: 'src/a.ts' })), gold)).toBe(true);
    expect(isCandidate(projectFinding(finding({ path: 'src/other.ts' })), gold)).toBe(false);
  });

  it('requires an accepted category', () => {
    expect(isCandidate(projectFinding(finding({ path: 'src/a.ts', category: 'security' })), gold)).toBe(true);
    expect(isCandidate(projectFinding(finding({ path: 'src/a.ts', category: 'style' })), gold)).toBe(false);
  });

  it('requires overlapping line ranges; partial, containment, and touching count', () => {
    expect(isCandidate(projectFinding(finding({ path: 'src/a.ts', startLine: 5, endLine: 6 })), gold)).toBe(true);
    expect(isCandidate(projectFinding(finding({ path: 'src/a.ts', startLine: 1, endLine: 100 })), gold)).toBe(true);
    expect(isCandidate(projectFinding(finding({ path: 'src/a.ts', startLine: 20, endLine: 30 })), gold)).toBe(false);
    expect(isCandidate(projectFinding(finding({ path: 'src/a.ts', startLine: 10, endLine: 15 })), gold)).toBe(true);
  });

  it('accepts any of multiple accepted ranges; never matches when ranges or paths are empty', () => {
    const multi = issue({ issueId: 'i1', acceptedLineRanges: [{ startLine: 1, endLine: 5 }, { startLine: 40, endLine: 45 }] });
    expect(isCandidate(projectFinding(finding({ path: 'src/a.ts', startLine: 42, endLine: 43 })), multi)).toBe(true);
    expect(isCandidate(projectFinding(finding({ path: 'src/a.ts', startLine: 20, endLine: 30 })), multi)).toBe(false);

    expect(isCandidate(projectFinding(finding({ path: 'src/a.ts' })), issue({ issueId: 'i1', acceptedLineRanges: [] }))).toBe(false);
    expect(isCandidate(projectFinding(finding({ path: 'src/a.ts' })), issue({ issueId: 'i1', acceptedPaths: [] }))).toBe(false);
  });
});

describe('matching: deterministic one-to-one maximum matching over naive greedy', () => {
  it('matches one-to-one when every finding is a candidate for every issue', () => {
    const issues = [issue({ issueId: 'i1' }), issue({ issueId: 'i2' })];
    const findings = [finding({ path: 'src/a.ts' }), finding({ path: 'src/a.ts' })];
    const result = matchFindingsToIssues(findings, issues);
    expect(result.matchedPairs).toHaveLength(2);
    expect(result.findings.every((f) => f.truePositive)).toBe(true);
  });

  it('beats greedy: shared issue is re-assigned so both findings match', () => {
    // F0 candidates {i1, i2}; F1 candidates {i1} only.
    // Greedy (F0 first-fit) would pin F0->i1 and leave F1 unmatched (1 TP).
    // Maximum matching reassigns F0->i2, F1->i1 (2 TP).
    const issues = [
      issue({ issueId: 'i1', acceptedPaths: ['src/a.ts', 'src/b.ts'] }),
      issue({ issueId: 'i2', acceptedPaths: ['src/a.ts'] }),
    ];
    const findings = [
      finding({ path: 'src/a.ts', startLine: 1, endLine: 5 }),
      finding({ path: 'src/b.ts', startLine: 1, endLine: 5 }),
    ];
    const result = matchFindingsToIssues(findings, issues);
    expect(result.matchedPairs).toEqual([
      { findingIndex: 0, issueId: 'i2' },
      { findingIndex: 1, issueId: 'i1' },
    ]);
    expect(result.findings.map((f) => f.truePositive)).toEqual([true, true]);
  });

  it('maximizes cardinality in a 3-finding ambiguous graph (greedy gets 2, max 3)', () => {
    // F0 candidates {i1,i2,i3}; F1 {i1}; F2 {i2}.
    // Greedy first-fit: F0->i1, F1 blocked, F2->i2 => 2 TP.
    // Maximum matching: F1->i1, F2->i2, F0->i3 => 3 TP.
    const issues = [
      issue({ issueId: 'i1', acceptedPaths: ['src/a.ts', 'src/b.ts', 'src/c.ts'] }),
      issue({ issueId: 'i2', acceptedPaths: ['src/a.ts', 'src/b.ts'] }),
      issue({ issueId: 'i3', acceptedPaths: ['src/a.ts'] }),
    ];
    const findings = [
      finding({ path: 'src/a.ts', startLine: 1, endLine: 2 }),
      finding({ path: 'src/b.ts', startLine: 1, endLine: 2 }),
      finding({ path: 'src/c.ts', startLine: 1, endLine: 2 }),
    ];
    const result = matchFindingsToIssues(findings, issues);
    expect(result.matchedPairs).toHaveLength(3);
    expect(result.findings.every((f) => f.truePositive)).toBe(true);
    expect(result.issues.every((i) => i.detected)).toBe(true);
  });

  it('is deterministic and never matches one issue to two findings (one-to-one invariant)', () => {
    const issues = [issue({ issueId: 'i1' }), issue({ issueId: 'i2' })];
    const findings = [finding({ path: 'src/a.ts' }), finding({ path: 'src/a.ts' })];
    expect(matchFindingsToIssues(findings, issues)).toEqual(matchFindingsToIssues(findings, issues));

    const single = [issue({ issueId: 'i1' })];
    const three = [
      finding({ path: 'src/a.ts' }),
      finding({ path: 'src/a.ts' }),
      finding({ path: 'src/a.ts' }),
    ];
    const result = matchFindingsToIssues(three, single);
    expect(result.findings.filter((f) => f.truePositive)).toHaveLength(1);
    expect(result.issues[0].detected).toBe(true);
  });
});

describe('duplicate classification', () => {
  it('marks an unmatched candidate for an already-matched issue as duplicate; plain FPs are not', () => {
    const issues = [issue({ issueId: 'i1' })];
    const summary = computeQualitySummary(
      [
        finding({ path: 'src/a.ts', startLine: 1, endLine: 2 }), // wins i1 (TP)
        finding({ path: 'src/a.ts', startLine: 8, endLine: 9 }), // candidate for matched i1, loses
        finding({ path: 'src/other.ts' }), // candidate for nothing
      ],
      issues,
    );
    expect(summary.findings[0].truePositive).toBe(true);
    expect(summary.findings[1].duplicate).toBe(true);
    expect(summary.findings[2].duplicate).toBe(false);
    expect(summary.duplicates).toBe(1);
    expect(summary.fp).toBe(2);
  });

  it('counts several duplicates of one gold issue; matched findings never flagged', () => {
    const issues = [issue({ issueId: 'i1' })];
    const summary = computeQualitySummary(
      [
        finding({ path: 'src/a.ts', startLine: 1, endLine: 2 }),
        finding({ path: 'src/a.ts', startLine: 4, endLine: 5 }),
        finding({ path: 'src/a.ts', startLine: 7, endLine: 8 }),
      ],
      issues,
    );
    expect(summary.tp).toBe(1);
    expect(summary.duplicates).toBe(2);

    // Two issues, two findings: all matched, none duplicate.
    const two = computeQualitySummary(
      [
        finding({ path: 'src/a.ts', startLine: 1, endLine: 2 }),
        finding({ path: 'src/a.ts', startLine: 5, endLine: 6 }),
      ],
      [issue({ issueId: 'i1', acceptedPaths: ['src/a.ts'] }), issue({ issueId: 'i2', acceptedPaths: ['src/a.ts'] })],
    );
    expect(two.tp).toBe(2);
    expect(two.findings.every((f) => f.duplicate === false)).toBe(true);
  });
});

describe('severity agreement', () => {
  it('grades exact / in-range / out-of-range / null for unmatched', () => {
    const bounds = issue({ issueId: 'i1', minSeverity: 'warning', maxSeverity: 'nitpick', expectedSeverity: 'warning' });
    expect(computeQualitySummary([finding({ path: 'src/a.ts', severity: 'warning' })], [bounds]).findings[0].severityAgreement).toBe('exact');
    expect(computeQualitySummary([finding({ path: 'src/a.ts', severity: 'nitpick' })], [bounds]).findings[0].severityAgreement).toBe('in-range');

    const tighter = issue({ issueId: 'i1', minSeverity: 'warning', maxSeverity: 'suggestion' });
    expect(computeQualitySummary([finding({ path: 'src/a.ts', severity: 'critical' })], [tighter]).findings[0].severityAgreement).toBe('out-of-range');
    expect(computeQualitySummary([finding({ path: 'src/a.ts', severity: 'nitpick' })], [tighter]).findings[0].severityAgreement).toBe('out-of-range');

    // Collapsed bounds with no expectedSeverity: exact by construction.
    const collapsed = issue({ issueId: 'i1', minSeverity: 'critical', maxSeverity: 'critical' });
    expect(computeQualitySummary([finding({ path: 'src/a.ts', severity: 'critical' })], [collapsed]).findings[0].severityAgreement).toBe('exact');

    expect(computeQualitySummary([finding({ path: 'src/other.ts' })], [bounds]).findings[0].severityAgreement).toBeNull();
  });
});

describe('zero-denominator and mixed P/R/F1', () => {
  it('applies vacuous precision/recall/f1 rules', () => {
    const withGold = computeQualitySummary([], makeCase([issue({ issueId: 'i1' })]).expectedIssues);
    expect(withGold.precision).toBe(1);
    expect(withGold.recall).toBe(0);
    expect(withGold.f1).toBe(0);
    expect(withGold.clean).toBe(true); // vacuous: no FP

    const noGold = computeQualitySummary([finding({ path: 'src/a.ts' })], []);
    expect(noGold.fp).toBe(1);
    expect(noGold.precision).toBe(0);
    expect(noGold.recall).toBe(1);
    expect(noGold.f1).toBe(0);

    const bothEmpty = computeQualitySummary([], []);
    expect(bothEmpty.precision).toBe(1);
    expect(bothEmpty.recall).toBe(1);
    expect(bothEmpty.f1).toBe(1);

    expect(precision(0, 0)).toBe(1);
    expect(recall(0, 0)).toBe(1);
    expect(f1(0, 0, 0)).toBe(1);
    expect(f1(0, 0, 5)).toBe(0);
    expect(f1(0, 5, 0)).toBe(0);
  });

  it('computes standard precision/recall/f1 on mixed counts and counts severe FPs', () => {
    const c = makeCase([
      issue({ issueId: 'i1', acceptedPaths: ['src/a.ts'] }),
      issue({ issueId: 'i2', acceptedPaths: ['src/b.ts'] }),
    ]);
    const s = computeQualitySummary(
      [
        finding({ path: 'src/a.ts' }), // TP -> i1
        finding({ path: 'src/a.ts', startLine: 8, endLine: 9 }), // duplicate FP (overlaps i1 range)
        finding({ path: 'src/other.ts' }), // plain FP
      ],
      c.expectedIssues,
    );
    expect(s.tp).toBe(1);
    expect(s.fp).toBe(2);
    expect(s.fn).toBe(1);
    expect(s.precision).toBeCloseTo(1 / 3, 5);
    expect(s.recall).toBeCloseTo(1 / 2, 5);
    expect(s.f1).toBeCloseTo(2 / 5, 5);
    expect(s.duplicates).toBe(1);
    expect(s.clean).toBe(false);

    const sev = computeQualitySummary(
      [
        finding({ path: 'src/x.ts', severity: 'critical' }),
        finding({ path: 'src/y.ts', severity: 'warning' }),
        finding({ path: 'src/z.ts', severity: 'nitpick' }),
      ],
      makeCase([issue({ issueId: 'i1', acceptedPaths: ['src/a.ts'] })]).expectedIssues,
    );
    expect(sev.fp).toBe(3);
    expect(sev.severeFalsePositives).toBe(2);
  });
});

describe('evaluateRunQuality: pre/post gates and diagnostics', () => {
  const goldCase = makeCase([issue({ issueId: 'i1' })]);

  it('reports pre/post divergence when the gate drops a false positive', () => {
    const generated = [
      finding({ path: 'src/a.ts', startLine: 1, endLine: 2 }), // TP
      finding({ path: 'src/other.ts' }), // FP, dropped by gate
    ];
    const retained = [generated[0]];
    const report = evaluateRunQuality({ case: goldCase, generatedFindings: generated, retainedFindings: retained, outputTokens: 1000 });

    expect(report.preGate.tp).toBe(1);
    expect(report.preGate.fp).toBe(1);
    expect(report.preGate.precision).toBeCloseTo(0.5, 5);
    expect(report.postGate.tp).toBe(1);
    expect(report.postGate.fp).toBe(0);
    expect(report.postGate.precision).toBe(1);
    expect(report.postGate.clean).toBe(true);
    expect(report.diagnostics.generatedCount).toBe(2);
    expect(report.diagnostics.retainedCount).toBe(1);
    expect(report.diagnostics.gatedCount).toBe(1);
  });

  it('computes TP density and tokens per TP with nulls on zero output/tokens', () => {
    const twoIssueCase = makeCase([issue({ issueId: 'i1' }), issue({ issueId: 'i2' })]);
    const generated = [
      finding({ path: 'src/a.ts', startLine: 1, endLine: 2 }),
      finding({ path: 'src/a.ts', startLine: 5, endLine: 6 }),
    ];
    const report = evaluateRunQuality({ case: twoIssueCase, generatedFindings: generated, retainedFindings: generated, outputTokens: 1000 });
    expect(report.preGate.tp).toBe(2);
    expect(report.diagnostics.tpPer1000TokensPre).toBe(2); // 2 TP / 1000 tokens * 1000
    expect(report.diagnostics.outputTokensPerTpPre).toBe(500);

    const zeroTokens = evaluateRunQuality({
      case: goldCase,
      generatedFindings: [finding({ path: 'src/a.ts' })],
      retainedFindings: [finding({ path: 'src/a.ts' })],
      outputTokens: 0,
    });
    expect(zeroTokens.diagnostics.tpPer1000TokensPre).toBeNull();

    const zeroTp = evaluateRunQuality({
      case: makeCase([issue({ issueId: 'i1', acceptedPaths: ['src/a.ts'] })]),
      generatedFindings: [finding({ path: 'src/other.ts' })],
      retainedFindings: [finding({ path: 'src/other.ts' })],
      outputTokens: 500,
    });
    expect(zeroTp.preGate.tp).toBe(0);
    expect(zeroTp.diagnostics.outputTokensPerTpPre).toBeNull();
    expect(zeroTp.diagnostics.tpPer1000TokensPre).toBe(0);
  });

  it('reports nonempty title/body rates, vacuous 1 when no findings', () => {
    const empty = evaluateRunQuality({ case: goldCase, generatedFindings: [], retainedFindings: [], outputTokens: 10 });
    expect(empty.diagnostics.nonemptyTitleRatePre).toBe(1);
    expect(empty.diagnostics.nonemptyBodyRatePre).toBe(1);

    const withBlank = evaluateRunQuality({
      case: goldCase,
      generatedFindings: [
        finding({ path: 'src/a.ts', title: 'has title', body: 'has body' }),
        finding({ path: 'src/a.ts', title: '', body: '   ' }),
      ],
      retainedFindings: [finding({ path: 'src/a.ts', title: 't', body: 'b' })],
      outputTokens: 10,
    });
    expect(withBlank.diagnostics.nonemptyTitleRatePre).toBeCloseTo(0.5, 5);
    expect(withBlank.diagnostics.nonemptyBodyRatePre).toBeCloseTo(0.5, 5);
    expect(withBlank.diagnostics.nonemptyTitleRatePost).toBe(1);
  });
});

describe('aggregateQuality: micro vs macro and totals', () => {
  function entry(c: BenchmarkCase, summary: ReturnType<typeof computeQualitySummary>, tokens = 100): QualityAggregateEntry {
    return { case: c, summary, outputTokens: tokens };
  }

  it('micro differs from macro when case sizes are uneven; totals and cleanRate', () => {
    const c1 = makeCase([issue({ issueId: 'i1' })], { id: 'c1', label: 'c1' });
    const c2 = makeCase([issue({ issueId: 'i1' }), issue({ issueId: 'i2' })], { id: 'c2', label: 'c2' });

    const good = finding({ path: 'src/a.ts', startLine: 1, endLine: 2 });
    const s1 = computeQualitySummary([good, finding({ path: 'src/other.ts' })], c1.expectedIssues);
    const s2 = computeQualitySummary(
      Array.from({ length: 9 }, (_, i) => finding({ path: 'src/a.ts', startLine: i + 1, endLine: i + 2 })),
      c2.expectedIssues,
    );
    const agg = aggregateQuality([entry(c1, s1), entry(c2, s2)]);

    expect(agg.micro.precision).toBeCloseTo((1 + 2) / (1 + 2 + 1 + 7), 5); // 3/11
    expect(agg.macro.precision).toBeCloseTo((0.5 + 2 / 9) / 2, 5);
    expect(agg.micro.precision).not.toBeCloseTo(agg.macro.precision, 5);
  });

  it('aggregates totals, per-case grouping across runs, and cleanRate', () => {
    const c = makeCase([issue({ issueId: 'i1' })], { id: 'shared', label: 'shared-label', version: 3 });
    const hit = [finding({ path: 'src/a.ts' })];
    const miss: FindingLike[] = [];
    const agg = aggregateQuality([
      entry(c, computeQualitySummary(hit, c.expectedIssues)),
      entry(c, computeQualitySummary(miss, c.expectedIssues)),
      entry(c, computeQualitySummary(hit, c.expectedIssues)),
    ]);

    expect(agg.cases).toBe(1);
    expect(agg.runs).toBe(3);
    expect(agg.totalTp).toBe(2);
    expect(agg.totalFn).toBe(1);
    expect(agg.micro.precision).toBe(1);
    expect(agg.micro.recall).toBeCloseTo(2 / 3, 5);
    expect(agg.micro.f1).toBeCloseTo(0.8, 5); // 2*1*(2/3) / (1 + 2/3)
    const pc = agg.perCase[0];
    expect(pc.caseId).toBe('shared');
    expect(pc.label).toBe('shared-label');
    expect(pc.runs).toBe(3);
    expect(pc.clean).toBe(true);

    // cleanRate counts runs with zero FP; severe FPs and duplicates sum.
    const dirty = computeQualitySummary(
      [
        finding({ path: 'src/a.ts', startLine: 1, endLine: 2 }),
        finding({ path: 'src/a.ts', startLine: 4, endLine: 5, severity: 'critical' }),
        finding({ path: 'src/a.ts', startLine: 7, endLine: 8, severity: 'critical' }),
      ],
      c.expectedIssues,
    );
    const cleanAgg = aggregateQuality([entry(c, dirty), entry(c, computeQualitySummary(hit, c.expectedIssues))]);
    expect(cleanAgg.cleanRate).toBeCloseTo(0.5, 5);
    expect(cleanAgg.severeFalsePositives).toBe(2);
    expect(cleanAgg.duplicates).toBe(2);
  });

  it('computes per-issue detection rates and token density; empty aggregate is vacuous', () => {
    const common = issue({ issueId: 'common' });
    const extra = issue({ issueId: 'extra' });
    const c1 = makeCase([common], { id: 'c1' });
    const c2 = makeCase([common, extra], { id: 'c2' });
    const s1 = computeQualitySummary([finding({ path: 'src/a.ts' })], c1.expectedIssues);
    const s2 = computeQualitySummary([finding({ path: 'src/a.ts' })], c2.expectedIssues);
    const agg = aggregateQuality([
      entry(c1, s1, 250),
      entry(c2, s2, 750),
    ]);
    const byId = new Map(agg.perIssueDetection.map((d) => [d.issueId, d]));
    expect(byId.get('common')).toMatchObject({ occurrences: 2, detected: 2, rate: 1 });
    expect(byId.get('extra')).toMatchObject({ occurrences: 1, detected: 0, rate: 0 });
    expect(agg.tpPer1000Tokens).toBe(2); // 2 TP / 1000 tokens * 1000
    expect(agg.outputTokensPerTp).toBe(500);

    const empty = aggregateQuality([]);
    expect(empty.cases).toBe(0);
    expect(empty.micro).toEqual({ precision: 1, recall: 1, f1: 1 });
    expect(empty.cleanRate).toBe(1);
    expect(empty.tpPer1000Tokens).toBeNull();
    expect(empty.perCase).toEqual([]);
  });
});

describe('detectLargeRegression', () => {
  function aggWith(cleanRate: number) {
    const c = makeCase([issue({ issueId: 'i1' })], { id: 'c1' });
    const clean = () => computeQualitySummary([finding({ path: 'src/a.ts' })], c.expectedIssues); // fp 0
    const dirty = () => computeQualitySummary([finding({ path: 'src/x.ts' })], c.expectedIssues); // fp 1
    if (cleanRate === 1) {
      return aggregateQuality([{ case: c, summary: clean(), outputTokens: 10 }]);
    }
    if (cleanRate === 0) {
      return aggregateQuality([{ case: c, summary: dirty(), outputTokens: 10 }]);
    }
    return aggregateQuality([
      { case: c, summary: clean(), outputTokens: 10 },
      { case: c, summary: dirty(), outputTokens: 10 },
    ]);
  }

  it('flags a large regression with default thresholds (0.75 / 0.25), boundaries count', () => {
    const baseline = aggWith(1); // cleanRate 1
    const experimental = aggWith(0); // cleanRate 0
    const result = detectLargeRegression(baseline, experimental);
    expect(result.regressed).toBe(true);
    expect(result.metric).toBe('cleanRate');
    expect(result.baseline).toBe(1);
    expect(result.experimental).toBe(0);
    expect(result.baselineThreshold).toBe(0.75);
    expect(result.experimentalThreshold).toBe(0.25);

    expect(detectLargeRegression(0.75, 0.25).regressed).toBe(true); // boundary values
  });

  it('does not flag when baseline or experimental is outside thresholds; accepts numbers', () => {
    expect(detectLargeRegression(0.7, 0.2).regressed).toBe(false); // baseline below 0.75
    expect(detectLargeRegression(0.9, 0.4).regressed).toBe(false); // experimental above 0.25
    expect(detectLargeRegression(0.9, 0.9).regressed).toBe(false);
    expect(detectLargeRegression(0.8, 0.1).regressed).toBe(true); // generic numeric
  });

  it('respects custom thresholds and a selected metric', () => {
    const baseline = aggWith(1);
    const experimental = aggWith(0.5);
    const strict = detectLargeRegression(baseline, experimental, { baselineThreshold: 1, experimentalThreshold: 0.5 });
    expect(strict.regressed).toBe(true);

    const metric = detectLargeRegression(baseline, experimental, { metric: 'macroRecall' });
    expect(metric.metric).toBe('macroRecall');
    expect(metric.baseline).toBe(baseline.macro.recall);
    expect(metric.experimental).toBe(experimental.macro.recall);
  });
});

describe('end-to-end run quality flow', () => {
  it('matches gold, classifies duplicates, and aggregates across two runs', () => {
    const gold = [
      issue({ issueId: 'bug-a', acceptedPaths: ['src/a.ts'], acceptedLineRanges: [{ startLine: 1, endLine: 10 }], acceptedCategories: ['bug'] }),
      issue({ issueId: 'sec-b', acceptedPaths: ['src/b.ts'], acceptedLineRanges: [{ startLine: 20, endLine: 30 }], acceptedCategories: ['security'] }),
    ];
    const c = makeCase(gold);

    const run1Generated = [
      finding({ path: 'src/a.ts', startLine: 2, endLine: 4, severity: 'warning', category: 'bug' }), // TP bug-a
      finding({ path: 'src/a.ts', startLine: 8, endLine: 9, severity: 'suggestion', category: 'bug' }), // duplicate
      finding({ path: 'src/b.ts', startLine: 25, endLine: 26, severity: 'critical', category: 'security' }), // TP sec-b
      finding({ path: 'src/c.ts', startLine: 1, endLine: 2, severity: 'critical', category: 'bug' }), // severe FP
    ];
    const report1 = evaluateRunQuality({ case: c, generatedFindings: run1Generated, retainedFindings: run1Generated, outputTokens: 2000 });

    expect(report1.preGate.tp).toBe(2);
    expect(report1.preGate.fp).toBe(2);
    expect(report1.preGate.fn).toBe(0);
    expect(report1.preGate.duplicates).toBe(1);
    expect(report1.preGate.severeFalsePositives).toBe(1);
    expect(report1.preGate.precision).toBeCloseTo(0.5, 5);
    expect(report1.preGate.recall).toBe(1);
    expect(report1.preGate.f1).toBeCloseTo(2 / 3, 5);
    expect(report1.diagnostics.tpPer1000TokensPre).toBe(1); // 2 TP / 2000 * 1000
    expect(report1.diagnostics.outputTokensPerTpPre).toBe(1000);

    // Run 2: gate drops the duplicate and the severe FP.
    const run2Retained = run1Generated.filter((_, i) => i === 0 || i === 2);
    const report2 = evaluateRunQuality({ case: c, generatedFindings: run1Generated, retainedFindings: run2Retained, outputTokens: 1000 });
    expect(report2.postGate.fp).toBe(0);
    expect(report2.postGate.clean).toBe(true);
    expect(report2.diagnostics.gatedCount).toBe(2);

    const agg = aggregateQuality([
      { case: c, summary: report1.postGate, outputTokens: 2000 },
      { case: c, summary: report2.postGate, outputTokens: 1000 },
    ]);
    expect(agg.totalTp).toBe(4);
    expect(agg.totalFp).toBe(2);
    expect(agg.totalFn).toBe(0);
    expect(agg.duplicates).toBe(1);
    expect(agg.severeFalsePositives).toBe(1);
    expect(agg.micro.precision).toBeCloseTo(4 / 6, 5);
    expect(agg.micro.recall).toBe(1);
    expect(agg.tpPer1000Tokens).toBeCloseTo((4 / 3000) * 1000, 5);
    expect(agg.outputTokensPerTp).toBe(750);
    expect(agg.perIssueDetection.find((d) => d.issueId === 'bug-a')).toMatchObject({ occurrences: 2, detected: 2 });
    expect(agg.perIssueDetection.find((d) => d.issueId === 'sec-b')).toMatchObject({ occurrences: 2, detected: 2 });
  });
});
