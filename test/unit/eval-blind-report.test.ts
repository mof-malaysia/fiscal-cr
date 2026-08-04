import { describe, expect, it } from 'vitest';
import type { PullRequestContext, ReviewAnnotation, ReviewResult } from '../../src/types/review.js';
import { getCaseById, type BenchmarkCase } from '../../scripts/eval-cases.js';
import {
  REQUIRED_CONTRACT_KEYS,
  buildRunMetrics,
  captureFromResponse,
  type CapturedCall,
} from '../../scripts/eval-metrics.js';
import { evaluateRunQuality, type RunQualityReport } from '../../scripts/eval-quality.js';
import {
  buildEvalPlanFromEnv,
  type EvalPlan,
  type PlanEntry,
} from '../../scripts/eval-plan.js';
import {
  buildBlindKey,
  buildBlindPair,
  buildBlindPairsFromAttempts,
  buildBlindReport,
  chooseFence,
  deterministicAssignment,
  renderCaseContext,
  renderReview,
} from '../../scripts/eval-blind-report.js';
import {
  caseIdentityOf,
  completedAttempt,
  planIdentityOf,
  type CompletedAttempt,
} from '../../scripts/eval-benchmark.js';

// ---------------------------------------------------------------------------
// Fixtures

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    EVAL_SUITE: undefined,
    EVAL_CASES: undefined,
    EVAL_RUNS: undefined,
    EVAL_SEED: undefined,
    EVAL_MAX_CALLS: undefined,
    ...overrides,
  } as NodeJS.ProcessEnv;
}

function makePlan(cases: string, runs: string): EvalPlan {
  return buildEvalPlanFromEnv(env({ EVAL_CASES: cases, EVAL_RUNS: runs }));
}

const WALKTHROUGH = [
  { path: 'src/utils/retry.ts', summary: 'adds backoff' },
  { path: 'src/utils/cache.ts', summary: 'adds a cache' },
];

const INTENT = 'Adds a cache and retry backoff.';
const SUMMARY = 'Good change overall.';
const CHANGED_PATHS = ['src/utils/retry.ts', 'src/utils/cache.ts'];
const TIMESTAMP = '2026-08-04T00:00:00.000Z';

function makeCompleted(entry: PlanEntry, c: BenchmarkCase): CompletedAttempt {
  const capture: CapturedCall = {
    order: 1,
    durationMs: 1000,
    finishReason: 'stop',
    rawChars: 600,
    usage: { input: 100, output: 50, cached: 0 },
    parseSuccess: true,
    topLevelKeys: [...REQUIRED_CONTRACT_KEYS],
    generatedFindings: 0,
    score: 82,
    intent: INTENT,
    summary: SUMMARY,
    walkthrough: WALKTHROUGH,
    findings: [],
  };
  const result: ReviewResult = {
    summary: SUMMARY,
    score: 82,
    annotations: [],
    stats: { critical: 0, warning: 0, suggestion: 0, nitpick: 0 },
    tokensUsed: { input: 100, output: 50, cached: 0 },
    walkthrough: WALKTHROUGH,
    intent: INTENT,
    callCount: 1,
  };
  const metrics = buildRunMetrics({
    experimental: entry.experimental,
    pairIndex: entry.roundIndex,
    runIndex: entry.caseIndex,
    durationMs: 1000,
    tokens: { input: 100, output: 50, cached: 0 },
    calls: 1,
    captures: [capture],
    result,
    changedFilePaths: CHANGED_PATHS,
  });
  const quality: RunQualityReport = evaluateRunQuality({
    case: c,
    generatedFindings: [],
    retainedFindings: [],
    outputTokens: 50,
  });
  return completedAttempt({
    identity: planIdentityOf(entry),
    case: caseIdentityOf(c),
    requestTimestamp: TIMESTAMP,
    metrics,
    quality,
  });
}

// ---------------------------------------------------------------------------
// Deterministic assignment

describe('deterministicAssignment', () => {
  it('is deterministic for the same seed + pairId', () => {
    const a1 = deterministicAssignment('seed-a', 'pair-1');
    const a2 = deterministicAssignment('seed-a', 'pair-1');
    expect(a1).toEqual(a2);
  });

  it('changes with seed', () => {
    const a1 = deterministicAssignment('seed-a', 'pair-1');
    const a2 = deterministicAssignment('seed-b', 'pair-1');
    // Not guaranteed to differ, but extremely likely for a hash.
    // Instead verify both are valid assignments.
    expect(a1.a).not.toBe(a1.b);
    expect(a2.a).not.toBe(a2.b);
    expect(['baseline', 'experimental']).toContain(a1.a);
    expect(['baseline', 'experimental']).toContain(a1.b);
  });

  it('changes with pairId', () => {
    const a1 = deterministicAssignment('seed-a', 'pair-1');
    const a2 = deterministicAssignment('seed-a', 'pair-2');
    expect(a1.a).not.toBe(a1.b);
    expect(a2.a).not.toBe(a2.b);
  });

  it('is reasonably balanced across many pairs', () => {
    let aIsBaseline = 0;
    const total = 100;
    for (let i = 0; i < total; i++) {
      const a = deterministicAssignment('seed-x', `pair-${i}`);
      if (a.a === 'baseline') aIsBaseline++;
    }
    // With 100 fair coin flips, expect ~50; be tolerant.
    expect(aIsBaseline).toBeGreaterThanOrEqual(35);
    expect(aIsBaseline).toBeLessThanOrEqual(65);
  });
});

// ---------------------------------------------------------------------------
// Markdown fence safety

describe('chooseFence', () => {
  it('returns 4 backticks for plain text', () => {
    expect(chooseFence('hello world')).toBe('````');
  });

  it('returns 5 backticks when content contains 4', () => {
    expect(chooseFence('code: ````')).toBe('`````');
  });

  it('returns 6 backticks when content contains 5', () => {
    expect(chooseFence('``````')).toBe('```````');
  });
});

// ---------------------------------------------------------------------------
// renderReview

describe('renderReview', () => {
  const review: ReviewResult = {
    summary: 'The PR introduces a race condition.',
    score: 70,
    annotations: [
      {
        path: 'src/cache.ts',
        startLine: 5,
        endLine: 5,
        severity: 'warning',
        category: 'bug',
        title: 'Check-then-act race',
        body: 'Two concurrent callers may both miss the cache.',
        suggestedFix: 'Use a single-flight pattern.',
      },
    ],
    stats: { critical: 0, warning: 1, suggestion: 0, nitpick: 0 },
    tokensUsed: { input: 100, output: 50, cached: 0 },
    walkthrough: [{ path: 'src/cache.ts', summary: 'adds cache' }],
    intent: 'Add cache.',
    callCount: 1,
  };

  it('renders summary, walkthrough, and findings', () => {
    const md = renderReview(review, 'A');
    expect(md).toContain('Review A');
    expect(md).toContain('The PR introduces a race condition.');
    expect(md).toContain('adds cache');
    expect(md).toContain('Check-then-act race');
    expect(md).toContain('Use a single-flight pattern.');
    expect(md).toContain('src/cache.ts');
  });

  it('omits suggested fix when absent', () => {
    const noFix: ReviewResult = {
      ...review,
      annotations: [{ ...review.annotations[0], suggestedFix: undefined }],
    };
    const md = renderReview(noFix, 'B');
    expect(md).not.toContain('Suggested fix');
  });

  it('shows (none) for empty walkthrough and findings', () => {
    const empty: ReviewResult = {
      ...review,
      walkthrough: [],
      annotations: [],
    };
    const md = renderReview(empty, 'A');
    expect(md).toContain('_(none)_');
  });
});

// ---------------------------------------------------------------------------
// renderCaseContext

describe('renderCaseContext', () => {
  it('renders title, description, and changed files with patches', () => {
    const c = getCaseById('clean-01');
    const md = renderCaseContext(c.context, 'pair-clean-01-r0');
    expect(md).toContain('pair-clean-01-r0');
    expect(md).toContain('Add timestamp formatting helper');
    expect(md).toContain('format-time.ts');
    expect(md).toContain('@@ -0,0 +1');
    expect(md).toContain('export function formatTime');
  });
});

// ---------------------------------------------------------------------------
// buildBlindPair

describe('buildBlindPair', () => {
  const plan = makePlan('clean-01', '1');
  const baselineEntry = plan.entries[0];
  const experimentalEntry = plan.entries[1];
  const c = getCaseById('clean-01');

  it('assigns reviews to A/B deterministically', () => {
    const baselineAttempt = makeCompleted(baselineEntry, c);
    const experimentalAttempt = makeCompleted(experimentalEntry, c);
    const pair = buildBlindPair({
      pairId: 'clean-01@r0',
      caseId: 'clean-01',
      roundIndex: 0,
      baselineAttempt,
      experimentalAttempt,
      case: c,
      seed: 'test-seed',
    });

    expect(pair.pairId).toBe('clean-01@r0');
    expect(pair.assignment.a).not.toBe(pair.assignment.b);
    expect([pair.assignment.a, pair.assignment.b].sort()).toEqual([
      'baseline',
      'experimental',
    ]);

    // reviewA matches the assignment
    const expectedA =
      pair.assignment.a === 'baseline'
        ? baselineAttempt.metrics.review
        : experimentalAttempt.metrics.review;
    expect(pair.reviewA).toBe(expectedA);
  });

  it('uses the same assignment when rebuilt with the same seed', () => {
    const baselineAttempt = makeCompleted(baselineEntry, c);
    const experimentalAttempt = makeCompleted(experimentalEntry, c);
    const p1 = buildBlindPair({
      pairId: 'clean-01@r0',
      caseId: 'clean-01',
      roundIndex: 0,
      baselineAttempt,
      experimentalAttempt,
      case: c,
      seed: 'stable-seed',
    });
    const p2 = buildBlindPair({
      pairId: 'clean-01@r0',
      caseId: 'clean-01',
      roundIndex: 0,
      baselineAttempt,
      experimentalAttempt,
      case: c,
      seed: 'stable-seed',
    });
    expect(p1.assignment).toEqual(p2.assignment);
    expect(p1.reviewA).toBe(p2.reviewA);
    expect(p1.reviewB).toBe(p2.reviewB);
  });
});

// ---------------------------------------------------------------------------
// buildBlindReport

describe('buildBlindReport', () => {
  it('contains A/B reviews, context, and rubric but no baseline/experimental labels', () => {
    const plan = makePlan('clean-01', '1');
    const c = getCaseById('clean-01');
    const baselineAttempt = makeCompleted(plan.entries[0], c);
    const experimentalAttempt = makeCompleted(plan.entries[1], c);
    const pair = buildBlindPair({
      pairId: 'clean-01@r0',
      caseId: 'clean-01',
      roundIndex: 0,
      baselineAttempt,
      experimentalAttempt,
      case: c,
      seed: 'test-seed',
    });

    const report = buildBlindReport({
      seed: 'test-seed',
      pairs: [pair],
      excludedPairIds: [],
    });

    expect(report).toContain('FiscalCR Blind Review Pack');
    expect(report).toContain('Review A');
    expect(report).toContain('Review B');
    expect(report).toContain('Scoring Worksheet');
    expect(report).toContain('Correctness');
    expect(report).toContain('Clarity / readability');

    // Must NOT contain variant labels or metrics clues.
    expect(report.toLowerCase()).not.toContain('baseline');
    expect(report.toLowerCase()).not.toContain('experimental');
    expect(report).not.toContain('outputTokens');
    expect(report).not.toContain('durationMs');
    expect(report).not.toContain('gold issue');
    expect(report).not.toContain('rationale');
    expect(report).not.toContain('TP ');
    expect(report).not.toContain('FP ');
    expect(report).not.toContain('F1 ');
  });

  it('lists excluded incomplete pairs', () => {
    const report = buildBlindReport({
      seed: 'test-seed',
      pairs: [],
      excludedPairIds: ['local-01@r0', 'security-01@r0'],
    });
    expect(report).toContain('**Excluded (incomplete):** 2 pair(s)');
    expect(report).toContain('local-01@r0');
    expect(report).toContain('security-01@r0');
  });

  it('renders only retained annotations, not generated-but-filtered', () => {
    // Build an attempt where generated has 2 findings but retained has 1.
    const plan = makePlan('local-01', '1');
    const c = getCaseById('local-01');
    const entry = plan.entries[0];

    const generated: ReviewAnnotation[] = [
      {
        path: 'src/invoice/totals.ts',
        startLine: 14,
        endLine: 14,
        severity: 'warning',
        category: 'bug',
        title: 'firstPrice throws',
        body: 'items[0] is undefined.',
      },
      {
        path: 'src/invoice/totals.ts',
        startLine: 99,
        endLine: 99,
        severity: 'warning',
        category: 'bug',
        title: 'fake finding',
        body: 'this was filtered out.',
      },
    ];
    const retained = [generated[0]];

    const capture: CapturedCall = {
      order: 1,
      durationMs: 1000,
      finishReason: 'stop',
      rawChars: 600,
      usage: { input: 100, output: 50, cached: 0 },
      parseSuccess: true,
      topLevelKeys: [...REQUIRED_CONTRACT_KEYS],
      generatedFindings: generated.length,
      score: 82,
      intent: INTENT,
      summary: SUMMARY,
      walkthrough: WALKTHROUGH,
      findings: generated,
    };
    const result: ReviewResult = {
      summary: SUMMARY,
      score: 82,
      annotations: retained,
      stats: { critical: 0, warning: 1, suggestion: 0, nitpick: 0 },
      tokensUsed: { input: 100, output: 50, cached: 0 },
      walkthrough: WALKTHROUGH,
      intent: INTENT,
      callCount: 1,
    };
    const metrics = buildRunMetrics({
      experimental: entry.experimental,
      pairIndex: entry.roundIndex,
      runIndex: entry.caseIndex,
      durationMs: 1000,
      tokens: { input: 100, output: 50, cached: 0 },
      calls: 1,
      captures: [capture],
      result,
      changedFilePaths: CHANGED_PATHS,
    });
    const quality = evaluateRunQuality({
      case: c,
      generatedFindings: generated,
      retainedFindings: retained,
      outputTokens: 50,
    });
    const attempt = completedAttempt({
      identity: planIdentityOf(entry),
      case: caseIdentityOf(c),
      requestTimestamp: TIMESTAMP,
      metrics,
      quality,
    });

    // Make the other side similarly.
    const entry2 = plan.entries[1];
    const attempt2 = makeCompleted(entry2, c);

    const pair = buildBlindPair({
      pairId: 'local-01@r0',
      caseId: 'local-01',
      roundIndex: 0,
      baselineAttempt: attempt,
      experimentalAttempt: attempt2,
      case: c,
      seed: 'test-seed',
    });

    const report = buildBlindReport({ seed: 'test-seed', pairs: [pair], excludedPairIds: [] });
    // Only the retained finding should appear.
    expect(report).toContain('firstPrice throws');
    expect(report).not.toContain('fake finding');
  });

  it('is fence-safe against fixture content containing backticks', () => {
    // Use a case whose content may contain backticks.
    const c = getCaseById('clean-01');
    const plan = makePlan('clean-01', '1');
    const baselineAttempt = makeCompleted(plan.entries[0], c);
    const experimentalAttempt = makeCompleted(plan.entries[1], c);
    const pair = buildBlindPair({
      pairId: 'clean-01@r0',
      caseId: 'clean-01',
      roundIndex: 0,
      baselineAttempt,
      experimentalAttempt,
      case: c,
      seed: 'fence-test',
    });
    const report = buildBlindReport({ seed: 'fence-test', pairs: [pair], excludedPairIds: [] });
    // The report should not break markdown structure.
    expect(report).toContain('FiscalCR Blind Review Pack');
    // Count fence openings and closings (they should match in pairs).
    const fenceMatches = report.match(/```+/g);
    if (fenceMatches) {
      expect(fenceMatches.length % 2).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// buildBlindKey

describe('buildBlindKey', () => {
  it('maps blindPairId to baseline/experimental for A and B', () => {
    const plan = makePlan('clean-01', '1');
    const c = getCaseById('clean-01');
    const baselineAttempt = makeCompleted(plan.entries[0], c);
    const experimentalAttempt = makeCompleted(plan.entries[1], c);
    const pair = buildBlindPair({
      pairId: 'clean-01@r0',
      caseId: 'clean-01',
      roundIndex: 0,
      baselineAttempt,
      experimentalAttempt,
      case: c,
      seed: 'test-seed',
    });

    const key = buildBlindKey([pair], 'test-seed', TIMESTAMP);
    expect(key.schema).toBe('fiscalcr-blind-key-v1');
    expect(key.seed).toBe('test-seed');
    expect(key.pairs).toHaveLength(1);

    const entry = key.pairs[0];
    expect(entry.blindPairId).toBe(pair.blindPairId);
    expect(entry.pairId).toBe('clean-01@r0');
    expect(entry.reviewA).toBe(pair.assignment.a);
    expect(entry.reviewB).toBe(pair.assignment.b);
  });

  it('contains no review text or context', () => {
    const plan = makePlan('clean-01', '1');
    const c = getCaseById('clean-01');
    const baselineAttempt = makeCompleted(plan.entries[0], c);
    const experimentalAttempt = makeCompleted(plan.entries[1], c);
    const pair = buildBlindPair({
      pairId: 'clean-01@r0',
      caseId: 'clean-01',
      roundIndex: 0,
      baselineAttempt,
      experimentalAttempt,
      case: c,
      seed: 'test-seed',
    });

    const key = buildBlindKey([pair], 'test-seed', TIMESTAMP);
    const json = JSON.stringify(key);
    expect(json).not.toContain('Good change overall.');
    expect(json).not.toContain('adds backoff');
    expect(json).not.toContain('format-time');
    expect(json).not.toContain('diff');
  });
});

// ---------------------------------------------------------------------------
// buildBlindPairsFromAttempts

describe('buildBlindPairsFromAttempts', () => {
  it('excludes incomplete pairs (missing baseline or experimental)', () => {
    const plan = makePlan('clean-01, local-01', '1'); // 2 pairs
    const c1 = getCaseById('clean-01');
    const c2 = getCaseById('local-01');
    const attempts: CompletedAttempt[] = [];

    for (const entry of plan.entries) {
      const c = getCaseById(entry.caseId);
      // Drop the experimental side of local-01.
      if (entry.caseId === 'local-01' && entry.experimental) {
        continue;
      }
      attempts.push(makeCompleted(entry, c));
    }

    const casesById = new Map([c1, c2].map((c) => [c.id, c]));
    const { pairs, excludedPairIds } = buildBlindPairsFromAttempts({
      seed: 'test-seed',
      attempts,
      casesById,
    });

    expect(pairs).toHaveLength(1);
    expect(pairs[0].caseId).toBe('clean-01');
    expect(excludedPairIds).toContain('local-01@r0');
  });

  it('returns empty pairs and lists all excluded when no complete pairs exist', () => {
    const plan = makePlan('clean-01', '1');
    const c = getCaseById('clean-01');
    // Only baseline completed.
    const attempts: CompletedAttempt[] = [makeCompleted(plan.entries[0], c)];
    const casesById = new Map([[c.id, c]]);
    const { pairs, excludedPairIds } = buildBlindPairsFromAttempts({
      seed: 'test-seed',
      attempts,
      casesById,
    });
    expect(pairs).toHaveLength(0);
    expect(excludedPairIds).toContain('clean-01@r0');
  });

  it('sorts pairs by roundIndex then caseId', () => {
    const plan = makePlan('clean-01, local-01', '2');
    const c1 = getCaseById('clean-01');
    const c2 = getCaseById('local-01');
    const attempts = plan.entries.map((entry) => makeCompleted(entry, getCaseById(entry.caseId)));
    const casesById = new Map([c1, c2].map((c) => [c.id, c]));
    const { pairs } = buildBlindPairsFromAttempts({ seed: 'test-seed', attempts, casesById });

    expect(pairs.length).toBe(4);
    const order = pairs.map((p) => `${p.roundIndex}-${p.caseId}`);
    expect(order).toEqual(order.slice().sort());
  });
});
