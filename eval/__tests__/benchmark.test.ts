import { describe, expect, it } from 'vitest';
import type { LLMCompletionResponse } from '../../src/providers/interface.js';
import type { ReviewAnnotation, ReviewResult } from '../../src/types/review.js';
import { getCaseById, type BenchmarkCase } from '../cases.js';
import {
  REQUIRED_CONTRACT_KEYS,
  buildRunMetrics,
  captureFromResponse,
  type CapturedCall,
  type RunMetrics,
} from '../metrics.js';
import { evaluateRunQuality, type RunQualityReport } from '../quality.js';
import {
  buildEvalPlanFromEnv,
  type EvalPlan,
  type PlanEntry,
} from '../plan.js';
import {
  assertArtifactSafe,
  buildBenchmarkArtifact,
  buildBenchmarkResult,
  caseIdentityOf,
  checkArtifactSafety,
  completedAttempt,
  failedAttempt,
  planIdentityOf,
  promptMetadata,
  sanitizeError,
  sha256Hex,
  type Attempt,
  type BenchmarkArtifactV2,
  type CompletedAttempt,
  type FailedAttempt,
} from '../benchmark.js';
import {
  buildBlindKey,
  buildBlindPair,
  buildBlindPairsFromAttempts,
  buildBlindReport,
  chooseFence,
  deterministicAssignment,
  renderCaseContext,
  renderReview,
} from '../blind-report.js';

// ---------------------------------------------------------------------------
// Fixtures / helpers

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

// local-01 gold: local-01-01 at src/invoice/totals.ts:14 (warning), local-01-02 at :20 (suggestion).
const TOTALS_FINDING: ReviewAnnotation = {
  path: 'src/invoice/totals.ts', startLine: 14, endLine: 14,
  severity: 'warning', category: 'bug', title: 'firstPrice throws', body: 'items[0] is undefined for an empty array.',
};
const TAKE_N_FINDING: ReviewAnnotation = {
  path: 'src/invoice/totals.ts', startLine: 20, endLine: 20,
  severity: 'suggestion', category: 'bug', title: 'off-by-one', body: 'i <= n reads items[n] past the array end.',
};
const WRONG_PATH_FINDING: ReviewAnnotation = {
  path: 'src/other.ts', startLine: 1, endLine: 1,
  severity: 'warning', category: 'bug', title: 'not real', body: 'points at an unrelated file.',
};

interface AttemptOpts {
  generated?: ReviewAnnotation[];
  retained?: ReviewAnnotation[];
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  rawChars?: number;
  score?: number;
}

/** Completed attempt with fully controlled metrics/quality (deterministic). */
function makeCompleted(entry: PlanEntry, c: BenchmarkCase, opts: AttemptOpts = {}): CompletedAttempt {
  const generated = opts.generated ?? [];
  const retained = opts.retained ?? generated;
  const inputTokens = opts.inputTokens ?? 100;
  const outputTokens = opts.outputTokens ?? 50;
  const cached = opts.cachedTokens ?? 0;
  const durationMs = opts.durationMs ?? 1000;
  const score = opts.score ?? 82;

  const capture: CapturedCall = {
    order: 1,
    durationMs,
    finishReason: 'stop',
    rawChars: opts.rawChars ?? 600,
    usage: { input: inputTokens, output: outputTokens, cached },
    parseSuccess: true,
    topLevelKeys: [...REQUIRED_CONTRACT_KEYS],
    generatedFindings: generated.length,
    score,
    intent: INTENT,
    summary: SUMMARY,
    walkthrough: WALKTHROUGH,
    findings: generated,
  };
  const result: ReviewResult = {
    summary: SUMMARY,
    score,
    annotations: retained,
    stats: { critical: 0, warning: 0, suggestion: 0, nitpick: 0 },
    tokensUsed: { input: inputTokens, output: outputTokens, cached },
    walkthrough: WALKTHROUGH,
    intent: INTENT,
    callCount: 1,
  };
  const metrics: RunMetrics = buildRunMetrics({
    experimental: entry.experimental,
    pairIndex: entry.roundIndex,
    runIndex: entry.caseIndex,
    durationMs,
    tokens: { input: inputTokens, output: outputTokens, cached },
    calls: 1,
    captures: [capture],
    result,
    changedFilePaths: CHANGED_PATHS,
  });
  const quality: RunQualityReport = evaluateRunQuality({
    case: c,
    generatedFindings: generated,
    retainedFindings: retained,
    outputTokens,
  });
  return completedAttempt({
    identity: planIdentityOf(entry),
    case: caseIdentityOf(c),
    requestTimestamp: TIMESTAMP,
    metrics,
    quality,
  });
}

function makeFailed(entry: PlanEntry, c: BenchmarkCase, error: unknown, durationMs = 500): FailedAttempt {
  return failedAttempt({
    identity: planIdentityOf(entry),
    case: caseIdentityOf(c),
    requestTimestamp: TIMESTAMP,
    durationMs,
    error,
  });
}

/** All plan entries as completed attempts with the given per-entry options. */
function allCompleted(plan: EvalPlan, opts: AttemptOpts = {}): Attempt[] {
  return plan.entries.map((entry) => makeCompleted(entry, getCaseById(entry.caseId), opts));
}

function allFailed(plan: EvalPlan, error: unknown): Attempt[] {
  return plan.entries.map((entry) => makeFailed(entry, getCaseById(entry.caseId), error));
}

/** Build one completed blind pair from the first two entries of a 1-run plan. */
function blindPairOf(plan: EvalPlan, seed: string, opts: AttemptOpts = {}) {
  const c = getCaseById(plan.config.caseIds[0]);
  const baseline = makeCompleted(plan.entries[0], c, opts);
  const experimental = makeCompleted(plan.entries[1], c, opts);
  return {
    c,
    baseline,
    experimental,
    pair: buildBlindPair({
      pairId: `${c.id}@r0`,
      caseId: c.id,
      roundIndex: 0,
      baselineAttempt: baseline,
      experimentalAttempt: experimental,
      case: c,
      seed,
    }),
  };
}

function assertFiniteNumbers(value: unknown, path = '$'): void {
  if (typeof value === 'number') {
    expect(Number.isFinite(value), `${path} must be finite`).toBe(true);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => assertFiniteNumbers(v, `${path}[${i}]`));
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertFiniteNumbers(v, `${path}.${k}`);
  }
}

// ---------------------------------------------------------------------------
// Attempt constructors

describe('sanitizeError', () => {
  it('reduces strings, Errors and plain objects to {code, message} only', () => {
    expect(sanitizeError('boom')).toEqual({ code: 'error', message: 'boom' });

    const err = new Error('rate limited');
    err.name = 'RateLimitError';
    const sanitized = sanitizeError(err);
    expect(sanitized).toEqual({ code: 'RateLimitError', message: 'rate limited' });
    // Never leaks the stack.
    expect(Object.keys(sanitized)).toEqual(['code', 'message']);
    expect(JSON.stringify(sanitized)).not.toContain('at ');

    expect(sanitizeError({ code: 'timeout', message: 'call exceeded 60s' })).toEqual({
      code: 'timeout',
      message: 'call exceeded 60s',
    });
    expect(sanitizeError(null)).toEqual({ code: 'unknown', message: 'Unknown error' });
  });
});

describe('completedAttempt validation', () => {
  const plan = makePlan('clean-01', '1');
  const entry = plan.entries[0];
  const c = getCaseById(entry.caseId);

  it('builds a completed attempt and rejects identity/case/variant mismatches', () => {
    const attempt = makeCompleted(entry, c);
    expect(attempt.status).toBe('completed');
    expect(attempt.identity).toEqual(planIdentityOf(entry));
    expect(attempt.case.caseId).toBe('clean-01');
    expect(attempt.metrics.totalTokens).toBe(150);
    expect(attempt.quality.postGate).toBeDefined();
    expect(attempt.requestTimestamp).toBe(TIMESTAMP);

    const base = {
      case: caseIdentityOf(c),
      requestTimestamp: TIMESTAMP,
      metrics: makeCompleted(entry, c).metrics,
      quality: makeCompleted(entry, c).quality,
    };
    expect(() =>
      completedAttempt({ ...base, identity: { ...planIdentityOf(entry), experimental: !entry.experimental } }),
    ).toThrow(/identity mismatch/);
    expect(() =>
      completedAttempt({ ...base, identity: { ...planIdentityOf(entry), caseId: 'other-01' } }),
    ).toThrow(/case mismatch/);
    const other = makeCompleted(plan.entries[1] ?? entry, c); // opposite variant when available
    expect(() => completedAttempt({ ...base, identity: planIdentityOf(entry), metrics: other.metrics })).toThrow(
      /variant mismatch/,
    );
  });
});

describe('failedAttempt', () => {
  const plan = makePlan('clean-01', '1');
  const entry = plan.entries[0];
  const c = getCaseById(entry.caseId);

  it('stores only sanitized {code, message} and rejects bad durations', () => {
    const raw = new Error('connection reset');
    raw.name = 'ECONNRESET';
    (raw as Error & { stack?: string }).stack = 'Error: connection reset\n    at socket.on (net.js:1:1)';
    const attempt = makeFailed(entry, c, raw);
    expect(attempt.status).toBe('failed');
    expect(attempt.error).toEqual({ code: 'ECONNRESET', message: 'connection reset' });
    expect(JSON.stringify(attempt.error)).not.toContain('net.js');
    expect(Object.keys(attempt.error)).toEqual(['code', 'message']);
    expect(attempt.durationMs).toBe(500);

    const base = { identity: planIdentityOf(entry), case: caseIdentityOf(c), requestTimestamp: TIMESTAMP };
    expect(() => failedAttempt({ ...base, durationMs: -1, error: 'nope' })).toThrow(/durationMs/);
    expect(() => failedAttempt({ ...base, durationMs: Number.NaN, error: 'nope' })).toThrow(/durationMs/);
  });
});

// ---------------------------------------------------------------------------
// Execution accounting

describe('execution accounting', () => {
  it('counts planned/completed/failed and completionRate overall + by variant', () => {
    const plan = makePlan('clean-01, local-01', '2'); // 8 entries, 4 pairs
    const c1 = getCaseById('clean-01');
    const c2 = getCaseById('local-01');
    const attempts: Attempt[] = [];
    for (const entry of plan.entries) {
      const c = getCaseById(entry.caseId);
      if (entry.roundIndex === 0 && entry.experimental) {
        attempts.push(makeFailed(entry, c, 'provider timeout', 250));
      } else {
        attempts.push(makeCompleted(entry, c));
      }
    }
    const result = buildBenchmarkResult({ plan, cases: [c1, c2], attempts });

    expect(result.execution.planned).toBe(8);
    expect(result.execution.completed).toBe(6);
    expect(result.execution.failed).toBe(2);
    expect(result.execution.completionRate).toBeCloseTo(0.75, 10);

    expect(result.execution.byVariant.baseline).toEqual({
      planned: 4, completed: 4, failed: 0, completionRate: 1,
    });
    expect(result.execution.byVariant.experimental.completed).toBe(2);
    expect(result.execution.byVariant.experimental.completionRate).toBeCloseTo(0.5, 10);
  });

  it('zero completed variant: reliability/performance/quality aggregates are null; rejects mismatched plans', () => {
    const plan = makePlan('clean-01, local-01', '2');
    const c1 = getCaseById('clean-01');
    const c2 = getCaseById('local-01');
    const attempts: Attempt[] = [];
    for (const entry of plan.entries) {
      const c = getCaseById(entry.caseId);
      attempts.push(entry.experimental ? makeFailed(entry, c, 'boom') : makeCompleted(entry, c));
    }
    const result = buildBenchmarkResult({ plan, cases: [c1, c2], attempts });

    expect(result.execution.byVariant.experimental.completed).toBe(0);
    expect(result.reliability.experimental).toBeNull();
    expect(result.performance.experimental).toBeNull();
    expect(result.quality.preGate.experimental).toBeNull();
    expect(result.quality.postGate.experimental).toBeNull();
    expect(result.reliability.baseline!.completed).toBe(4);
    expect(result.quality.postGate.baseline).not.toBeNull();
    expect(result.regressions[0].status).toBe('insufficient-data');

    // Attempts that do not match the supplied plan are rejected.
    const other = makePlan('local-01', '1');
    expect(() =>
      buildBenchmarkResult({ plan, cases: [c1, c2], attempts: allCompleted(other) }),
    ).toThrow(/does not match plan entry/);
  });
});

describe('reliability and performance aggregates', () => {
  it('exposes numerators with the completed denominator, plus format-length label', () => {
    const plan = makePlan('clean-01', '2');
    const c = getCaseById('clean-01');
    const result = buildBenchmarkResult({ plan, cases: [c], attempts: allCompleted(plan) });

    for (const variant of ['baseline', 'experimental'] as const) {
      const rel = result.reliability[variant]!;
      expect(rel.completed).toBe(2);
      expect(rel.parsed).toBe(2);
      expect(rel.usable).toBe(2);
      expect(rel.formatLengthCompliant).toBe(2);
      expect(rel.parseRate).toBe(1);
      expect(rel.successRate).toBe(1);
      expect(rel.formatLengthComplianceRate).toBe(1);
      expect(rel.zeroFindingsKinds).toEqual({ genuine: 2 });
      expect(rel.finishReasons).toEqual({ stop: 2 });

      const perf = result.performance[variant]!;
      expect(perf.runs).toBe(2);
      expect(perf.meanDurationMs).toBe(1000);
      expect(perf.medianDurationMs).toBe(1000);
      expect(perf.meanOutputTokens).toBe(50);
      expect(perf.meanRawChars).toBe(600);
    }
  });
});

// ---------------------------------------------------------------------------
// Pairing

describe('paired deltas', () => {
  it('pairs only completed baseline+experimental sharing pairId/caseId/round; incomplete ignored', () => {
    const plan = makePlan('clean-01, local-01', '2'); // 4 pairs
    const c1 = getCaseById('clean-01');
    const c2 = getCaseById('local-01');
    const attempts: Attempt[] = [];
    for (const entry of plan.entries) {
      const c = getCaseById(entry.caseId);
      // Fail every experimental attempt of round 1 → round-1 pairs incomplete.
      if (entry.roundIndex === 1 && entry.experimental) {
        attempts.push(makeFailed(entry, c, 'boom'));
      } else {
        attempts.push(makeCompleted(entry, c));
      }
    }
    const result = buildBenchmarkResult({ plan, cases: [c1, c2], attempts });

    expect(result.pairs.completePairs).toBe(2); // round 0 only
    expect(result.pairs.incompletePairs).toBe(2); // round 1 pairs
    expect(result.pairs.deltas).toHaveLength(2);
    expect(result.pairs.aggregate!.completePairs).toBe(2);

    for (const delta of result.pairs.deltas) {
      expect(delta.roundIndex).toBe(0);
      // Pair identity is exact: pairId/caseId/round shared by both sides.
      expect(delta.experimental.pairId).toBe(delta.baseline.pairId);
      expect(delta.experimental.caseId).toBe(delta.baseline.caseId);
      expect(delta.experimental.roundIndex).toBe(delta.baseline.roundIndex);
      expect(delta.pairId).toBe(delta.baseline.pairId);
    }
  });

  it('aggregate means/medians use complete pairs only; no complete pairs → null', () => {
    const plan = makePlan('clean-01, local-01', '2');
    const c1 = getCaseById('clean-01');
    const c2 = getCaseById('local-01');
    const attempts: Attempt[] = [];
    for (const entry of plan.entries) {
      const c = getCaseById(entry.caseId);
      if (entry.roundIndex === 0) {
        attempts.push(makeCompleted(entry, c, { durationMs: entry.experimental ? 2000 : 1000 }));
      } else {
        attempts.push(
          entry.experimental ? makeFailed(entry, c, 'boom') : makeCompleted(entry, c, { durationMs: 9000 }),
        );
      }
    }
    const result = buildBenchmarkResult({ plan, cases: [c1, c2], attempts });
    const agg = result.pairs.aggregate!;
    // 2 complete pairs, duration deltas 1000 and 1000 → mean/median 1000.
    // The 9000ms unmatched baseline must NOT leak into the mean.
    expect(agg.durationDeltaMs.mean).toBe(1000);
    expect(agg.durationDeltaMs.median).toBe(1000);
    expect(agg.outputDeltaTokens.mean).toBe(0);

    const nonePlan = makePlan('clean-01, local-01', '1');
    const noneAttempts: Attempt[] = [];
    for (const entry of nonePlan.entries) {
      const c = getCaseById(entry.caseId);
      noneAttempts.push(entry.experimental ? makeFailed(entry, c, 'boom') : makeCompleted(entry, c));
    }
    const none = buildBenchmarkResult({
      plan: nonePlan,
      cases: [getCaseById('clean-01'), getCaseById('local-01')],
      attempts: noneAttempts,
    });
    expect(none.pairs.completePairs).toBe(0);
    expect(none.pairs.incompletePairs).toBe(2);
    expect(none.pairs.deltas).toEqual([]);
    expect(none.pairs.aggregate).toBeNull();
  });

  it('savings percentages: positive when lower, negative when higher, null on zero baseline', () => {
    const plan = makePlan('clean-01', '1');
    const c = getCaseById('clean-01');
    const attempts = plan.entries.map((entry) =>
      makeCompleted(entry, c, {
        outputTokens: entry.experimental ? 400 : 500,
        rawChars: entry.experimental ? 900 : 1000,
      }),
    );
    const result = buildBenchmarkResult({ plan, cases: [c], attempts });
    const delta = result.pairs.deltas[0];

    expect(delta.outputSavingsPct).toBeCloseTo(20, 10); // (500-400)/500
    expect(delta.rawCharsSavingsPct).toBeCloseTo(10, 10); // (1000-900)/1000
    expect(delta.rawCharsSavingsPct).not.toBe(delta.outputSavingsPct);
    expect(delta.outputDeltaTokens).toBe(-100);
    expect(result.pairs.aggregate!.outputSavingsPct.mean).toBeCloseTo(20, 10);

    const both = makePlan('clean-01, local-01', '1');
    const c1 = getCaseById('clean-01');
    const c2 = getCaseById('local-01');
    const mixed: Attempt[] = [];
    for (const entry of both.entries) {
      const cc = getCaseById(entry.caseId);
      if (cc.id === 'clean-01') {
        // clean-01: baseline output 0 → savings null.
        mixed.push(
          makeCompleted(entry, cc, {
            outputTokens: entry.experimental ? 100 : 0,
            rawChars: entry.experimental ? 200 : 0,
          }),
        );
      } else {
        // local-01: experimental higher → negative savings.
        mixed.push(
          makeCompleted(entry, cc, {
            outputTokens: entry.experimental ? 700 : 500,
            rawChars: entry.experimental ? 1200 : 1000,
          }),
        );
      }
    }
    const mixedResult = buildBenchmarkResult({ plan: both, cases: [c1, c2], attempts: mixed });
    const clean = mixedResult.pairs.deltas.find((d) => d.caseId === 'clean-01')!;
    const local = mixedResult.pairs.deltas.find((d) => d.caseId === 'local-01')!;
    expect(clean.outputSavingsPct).toBeNull();
    expect(clean.rawCharsSavingsPct).toBeNull();
    expect(local.outputSavingsPct).toBeCloseTo(-40, 10); // (500-700)/500
    expect(mixedResult.pairs.aggregate!.outputSavingsPct.mean).toBeCloseTo(-40, 10);

    const zero = buildBenchmarkResult({
      plan: makePlan('clean-01', '1'),
      cases: [getCaseById('clean-01')],
      attempts: allFailed(makePlan('clean-01', '1'), 'boom'),
    });
    expect(zero.pairs.aggregate).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Quality pre/post

describe('quality pre-gate vs post-gate', () => {
  it('aggregates pre/post by variant and preserves per-case + per-issue detail', () => {
    const plan = makePlan('clean-01, local-01', '1');
    const c1 = getCaseById('clean-01');
    const c2 = getCaseById('local-01');
    const attempts: Attempt[] = [];
    for (const entry of plan.entries) {
      const c = getCaseById(entry.caseId);
      if (c.id === 'clean-01') {
        // clean-01 has zero gold issues: one generated finding is an FP that
        // the gate drops → preGate fp 1, postGate clean.
        attempts.push(makeCompleted(entry, c, { generated: [WRONG_PATH_FINDING], retained: [] }));
      } else {
        // local-01: both gold issues detected and retained.
        attempts.push(
          makeCompleted(entry, c, { generated: [TOTALS_FINDING, TAKE_N_FINDING], retained: [TOTALS_FINDING, TAKE_N_FINDING] }),
        );
      }
    }
    const result = buildBenchmarkResult({ plan, cases: [c1, c2], attempts });

    const pre = result.quality.preGate.baseline!;
    const post = result.quality.postGate.baseline!;
    expect(pre.totalTp).toBe(2);
    expect(pre.totalFp).toBe(1);
    expect(pre.micro.precision).toBeCloseTo(2 / 3, 10);
    // Post-gate: the FP was dropped.
    expect(post.totalFp).toBe(0);
    expect(post.cleanRate).toBe(1);
    expect(post.micro.precision).toBe(1);
    expect(post.micro.recall).toBe(1);

    const perCase = new Map(post.perCase.map((p) => [p.caseId, p]));
    expect(perCase.get('clean-01')).toMatchObject({ runs: 1, tp: 0, fp: 0, clean: true });
    expect(perCase.get('local-01')).toMatchObject({ runs: 1, tp: 2, fp: 0, clean: true });

    const byIssue = new Map(post.perIssueDetection.map((d) => [d.issueId, d]));
    expect(byIssue.get('local-01-01')).toMatchObject({ occurrences: 1, detected: 1 });
    expect(byIssue.get('local-01-02')).toMatchObject({ occurrences: 1, detected: 1 });
  });
});

// ---------------------------------------------------------------------------
// Regressions

describe('large regression detection', () => {
  function regressionAttempts(plan: EvalPlan, experimentalDetects: boolean): Attempt[] {
    return plan.entries.map((entry) => {
      const c = getCaseById(entry.caseId);
      if (!entry.experimental || experimentalDetects) {
        return makeCompleted(entry, c, { generated: [TOTALS_FINDING, TAKE_N_FINDING], retained: [TOTALS_FINDING, TAKE_N_FINDING] });
      }
      return makeCompleted(entry, c, { generated: [], retained: [] });
    });
  }

  it('is insufficient-data below min runs, detects a large regression at 4, reports none otherwise', () => {
    const low = buildBenchmarkResult({
      plan: makePlan('local-01', '3'),
      cases: [getCaseById('local-01')],
      attempts: regressionAttempts(makePlan('local-01', '3'), false),
    });
    expect(low.regressions[0].status).toBe('insufficient-data');
    expect(low.regressions[0].runs).toBe(3);
    expect(low.regressions[0].baseline).toBeNull();

    const hit = buildBenchmarkResult({
      plan: makePlan('local-01', '4'),
      cases: [getCaseById('local-01')],
      attempts: regressionAttempts(makePlan('local-01', '4'), false),
    });
    const regression = hit.regressions[0];
    expect(regression.status).toBe('detected');
    expect(regression.metric).toBe('microRecall');
    expect(regression.baseline).toBe(1); // 8 TP / 8 gold
    expect(regression.experimental).toBe(0); // 0 TP / 8 gold
    expect(regression.baselineThreshold).toBe(0.75);
    expect(regression.experimentalThreshold).toBe(0.25);

    const none = buildBenchmarkResult({
      plan: makePlan('local-01', '4'),
      cases: [getCaseById('local-01')],
      attempts: regressionAttempts(makePlan('local-01', '4'), true),
    });
    expect(none.regressions[0].status).toBe('none');
    expect(none.regressions[0].experimental).toBe(1);
  });

  it('respects custom minRuns and thresholds', () => {
    const plan = makePlan('local-01', '2');
    const result = buildBenchmarkResult({
      plan,
      cases: [getCaseById('local-01')],
      attempts: regressionAttempts(plan, false),
      regression: { minRuns: 2, baselineThreshold: 0.5, experimentalThreshold: 0.5 },
    });
    expect(result.regressions[0].status).toBe('detected');
    expect(result.regressions[0].baselineThreshold).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// Artifact v2

describe('artifact v2 shape', () => {
  function buildArtifact(opts: {
    runs?: string;
    cases?: string;
    attempts?: (plan: EvalPlan) => Attempt[];
  } = {}): BenchmarkArtifactV2 {
    const plan = makePlan(opts.cases ?? 'clean-01, local-01', opts.runs ?? '2');
    const cases = plan.config.caseIds.map((id) => getCaseById(id));
    const attempts = (opts.attempts ?? allCompleted)(plan);
    return buildBenchmarkArtifact({
      timestamp: '2026-08-04T12:00:00.000Z',
      benchmark: { suiteId: 'fiscalcr-local-fast-path', suiteVersion: 1 },
      repository: { commit: 'deadbeef', dirty: false },
      provider: 'kimi',
      model: 'kimi-for-coding',
      prompt: {
        baseline: promptMetadata('system A + user A'),
        experimental: promptMetadata('system B + user B'),
      },
      retries: 1,
      timeoutMs: 60_000,
      plan,
      cases,
      attempts,
    });
  }

  it('exposes v2 metadata, config, plan, fixtures, attempts and aggregates', () => {
    const artifact = buildArtifact();

    expect(artifact.schema).toBe('fiscalcr-eval-v2');
    expect(artifact.benchmark).toEqual({
      suiteId: 'fiscalcr-local-fast-path',
      suiteVersion: 1,
      selectedCaseIds: ['clean-01', 'local-01'],
      seed: 'fiscalcr-eval-v2',
    });
    expect(artifact.repository).toEqual({ commit: 'deadbeef', dirty: false });
    expect(artifact.prompt.baseline.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(artifact.prompt.baseline.chars).toBe('system A + user A'.length);
    expect(artifact.prompt.experimental.sha256).not.toBe(artifact.prompt.baseline.sha256);

    expect(artifact.config).toEqual({
      runs: 2,
      plannedCalls: 8,
      completedCalls: 8,
      failedCalls: 0,
      retries: 1,
      timeoutMs: 60_000,
      maxCalls: 20,
    });
    expect(artifact.plan).toHaveLength(8);
    expect(artifact.plan[0]).toEqual({
      globalCallIndex: 0, roundIndex: 0, caseIndex: 0,
      caseId: 'clean-01', pairId: 'clean-01@r0',
      variant: 'baseline', experimental: false,
    });
    expect(artifact.attempts).toHaveLength(8);
    expect(artifact.aggregates.execution.completed).toBe(8);
    expect(artifact.pairs.completePairs).toBe(4);
    expect(artifact.regressions).toHaveLength(1);
  });

  it('fixtures carry taxonomy + expectedIssues but never context code/diffs', () => {
    const artifact = buildArtifact();
    const local = artifact.fixtures.find((f) => f.caseId === 'local-01')!;
    expect(local.version).toBe(1);
    expect(local.label).toBe('Add invoice totals helpers');
    expect(local.tags).toContain('local-correctness');
    expect(local.expectedIssues.map((i) => i.issueId)).toEqual(['local-01-01', 'local-01-02']);
    expect(local.expectedIssues[0].rationale.length).toBeGreaterThan(0);

    const json = JSON.stringify(artifact);
    expect(json).not.toContain('fileContents');
    expect(json).not.toContain('"diff"');
    expect(json).not.toContain('"patch"');
  });

  it('keeps completed review text but never persists a raw provider body sentinel', () => {
    const artifact = buildArtifact();
    const json = JSON.stringify(artifact);
    expect(json).toContain(SUMMARY);
    expect(json).toContain(INTENT);
    const completed = artifact.attempts[0];
    expect(completed.status).toBe('completed');
    if (completed.status === 'completed') {
      expect(completed.metrics.review.summary).toBe(SUMMARY);
    }

    const RAW_MARKER = 'RAW-CONTENT-SENTINEL-2468';
    const plan = makePlan('clean-01', '1');
    const c = getCaseById('clean-01');
    const entry = plan.entries[0];
    const marked = JSON.stringify({
      intent: INTENT, summary: SUMMARY, score: 82,
      walkthrough: WALKTHROUGH,
      findings: [],
      zzzRawMarker: RAW_MARKER,
    });
    const capture = captureFromResponse(
      { content: marked, usage: { input: 100, output: 50, cached: 0 }, finishReason: 'stop' } as LLMCompletionResponse,
      1,
      1000,
    );
    expect(JSON.stringify(capture)).not.toContain(RAW_MARKER);
    const attempt = completedAttempt({
      identity: planIdentityOf(entry), case: caseIdentityOf(c),
      requestTimestamp: TIMESTAMP, metrics: makeCompleted(entry, c).metrics,
      quality: evaluateRunQuality({ case: c, generatedFindings: [], retainedFindings: [], outputTokens: 50 }),
    });
    const markedArtifact = buildBenchmarkArtifact({
      timestamp: TIMESTAMP,
      benchmark: { suiteId: 's', suiteVersion: 1 },
      repository: { commit: null, dirty: null },
      provider: 'p', model: 'm',
      prompt: { baseline: promptMetadata('x'), experimental: promptMetadata('y') },
      retries: 0, timeoutMs: 1000,
      plan, cases: [c], attempts: [attempt],
    });
    expect(JSON.stringify(markedArtifact)).not.toContain(RAW_MARKER);
  });

  it('fails closed when a completed attempt references an unknown case', () => {
    const plan = makePlan('clean-01', '1');
    expect(() =>
      buildBenchmarkResult({ plan, cases: [], attempts: allCompleted(plan) }),
    ).toThrow(/unknown case/);
  });
});

// ---------------------------------------------------------------------------
// Secret safety

describe('assertArtifactSafe', () => {
  function cleanArtifact(): BenchmarkArtifactV2 {
    const plan = makePlan('clean-01', '1');
    const cases = [getCaseById('clean-01')];
    return buildBenchmarkArtifact({
      timestamp: TIMESTAMP,
      benchmark: { suiteId: 's', suiteVersion: 1 },
      repository: { commit: null, dirty: null },
      provider: 'p', model: 'm',
      prompt: { baseline: promptMetadata('x'), experimental: promptMetadata('y') },
      retries: 0, timeoutMs: 1000,
      plan, cases, attempts: allCompleted(plan),
    });
  }

  it('passes clean artifacts; catches planted secrets, forbidden keys, and empty-string absences', () => {
    const artifact = cleanArtifact();
    expect(checkArtifactSafety(artifact).safe).toBe(true);
    expect(() => assertArtifactSafe(artifact)).not.toThrow();
    expect(() => assertArtifactSafe(artifact, { secret: 'sk-test-abcdef' })).not.toThrow();

    // Planted secret deep in review text is caught recursively.
    const leak = cleanArtifact();
    const attempt = leak.attempts[0] as CompletedAttempt;
    (attempt.metrics.review.annotations as ReviewAnnotation[]).push({
      path: 'src/x.ts', startLine: 1, endLine: 1,
      severity: 'warning', category: 'bug',
      title: 'leak', body: 'the token is sk-test-abcdef',
    });
    const report = checkArtifactSafety(leak, { secret: 'sk-test-abcdef' });
    expect(report.safe).toBe(false);
    expect(report.violations[0].kind).toBe('substring');
    expect(report.violations[0].match).toBe('sk-test-abcdef');
    expect(report.violations[0].path).toContain('attempts');
    expect(() => assertArtifactSafe(leak, { secret: 'sk-test-abcdef' })).toThrow(/sk-test-abcdef/);

    // Forbidden keys at any depth (key-based, case-insensitive).
    const keys = cleanArtifact();
    (keys.aggregates as unknown as Record<string, unknown>).apiKey = 'sk-test-xyz';
    (keys.pairs as unknown as Record<string, unknown>).RAW_RESPONSE = 'nope';
    (keys.config as unknown as Record<string, unknown>)['baseUrl'] = 'https://x';
    const keyReport = checkArtifactSafety(keys);
    expect(keyReport.safe).toBe(false);
    const keyPaths = keyReport.violations.filter((v) => v.kind === 'key').map((v) => v.path);
    expect(keyPaths).toEqual(
      expect.arrayContaining(['aggregates.apiKey', 'pairs.RAW_RESPONSE', 'config.baseUrl']),
    );

    // Empty-string secret is reported absent (never matches everything).
    expect(checkArtifactSafety(cleanArtifact(), { secret: '' }).safe).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Determinism / numeric hygiene

describe('determinism and numeric hygiene', () => {
  it('serializes identically for identical inputs and contains no NaN or Infinity', () => {
    const plan = makePlan('clean-01, local-01', '2');
    const cases = plan.config.caseIds.map((id) => getCaseById(id));
    const build = () =>
      buildBenchmarkArtifact({
        timestamp: TIMESTAMP,
        benchmark: { suiteId: 's', suiteVersion: 2 },
        repository: { commit: 'abc', dirty: true },
        provider: 'kimi', model: 'kimi-for-coding',
        prompt: { baseline: promptMetadata('a'), experimental: promptMetadata('b') },
        retries: 0, timeoutMs: 30_000,
        plan, cases, attempts: allCompleted(plan),
      });
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));

    // Zero-output edges + a failed experimental round-1 attempt.
    const attempts: Attempt[] = [];
    for (const entry of plan.entries) {
      const c = getCaseById(entry.caseId);
      attempts.push(
        entry.experimental && entry.roundIndex === 1
          ? makeFailed(entry, c, 'boom')
          : makeCompleted(entry, c, { outputTokens: 0, rawChars: 0 }),
      );
    }
    const artifact = buildBenchmarkArtifact({
      timestamp: TIMESTAMP,
      benchmark: { suiteId: 's', suiteVersion: 1 },
      repository: { commit: null, dirty: null },
      provider: 'p', model: 'm',
      prompt: { baseline: promptMetadata(''), experimental: promptMetadata('') },
      retries: 0, timeoutMs: 1000,
      plan, cases, attempts,
    });
    assertFiniteNumbers(artifact);
    const json = JSON.stringify(artifact);
    expect(json).not.toContain('NaN');
    expect(json).not.toContain('Infinity');

    // sha256Hex is deterministic and 64 hex chars.
    expect(sha256Hex('hello')).toBe(sha256Hex('hello'));
    expect(sha256Hex('hello')).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex('hello')).not.toBe(sha256Hex('world'));
  });
});

// ---------------------------------------------------------------------------
// Blind report: deterministic assignment / fence / rendering

describe('deterministicAssignment', () => {
  it('is deterministic for the same seed + pairId and balanced across many pairs', () => {
    const a1 = deterministicAssignment('seed-a', 'pair-1');
    expect(a1).toEqual(deterministicAssignment('seed-a', 'pair-1'));
    expect(a1.a).not.toBe(a1.b);
    expect(['baseline', 'experimental']).toContain(a1.a);

    let aIsBaseline = 0;
    const total = 100;
    for (let i = 0; i < total; i++) {
      const a = deterministicAssignment('seed-x', `pair-${i}`);
      expect(a.a).not.toBe(a.b);
      if (a.a === 'baseline') aIsBaseline++;
    }
    // With 100 fair coin flips, expect ~50; be tolerant.
    expect(aIsBaseline).toBeGreaterThanOrEqual(35);
    expect(aIsBaseline).toBeLessThanOrEqual(65);
  });
});

describe('chooseFence', () => {
  it('picks a backtick fence that does not appear inside the content', () => {
    expect(chooseFence('hello world')).toBe('````');
    expect(chooseFence('code: ````')).toBe('`````');
    expect(chooseFence('``````')).toBe('```````');
  });
});

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

  it('renders summary, walkthrough, and findings; omits fix and empties gracefully', () => {
    const md = renderReview(review, 'A');
    expect(md).toContain('Review A');
    expect(md).toContain('The PR introduces a race condition.');
    expect(md).toContain('adds cache');
    expect(md).toContain('Check-then-act race');
    expect(md).toContain('Use a single-flight pattern.');

    const noFix: ReviewResult = { ...review, annotations: [{ ...review.annotations[0], suggestedFix: undefined }] };
    expect(renderReview(noFix, 'B')).not.toContain('Suggested fix');

    const empty: ReviewResult = { ...review, walkthrough: [], annotations: [] };
    expect(renderReview(empty, 'A')).toContain('_(none)_');
  });
});

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
// Blind report: pairs / report / key

describe('buildBlindPair', () => {
  it('assigns reviews to A/B deterministically and is stable for the same seed', () => {
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
    expect(pair.pairId).toBe('clean-01@r0');
    expect([pair.assignment.a, pair.assignment.b].sort()).toEqual(['baseline', 'experimental']);
    const expectedA =
      pair.assignment.a === 'baseline'
        ? baselineAttempt.metrics.review
        : experimentalAttempt.metrics.review;
    expect(pair.reviewA).toBe(expectedA);

    // Rebuilt with the same seed → identical assignment and reviews.
    const rebuilt = buildBlindPair({
      pairId: 'clean-01@r0',
      caseId: 'clean-01',
      roundIndex: 0,
      baselineAttempt,
      experimentalAttempt,
      case: c,
      seed: 'test-seed',
    });
    expect(rebuilt.assignment).toEqual(pair.assignment);
    expect(rebuilt.reviewA).toBe(pair.reviewA);
    expect(rebuilt.reviewB).toBe(pair.reviewB);
  });
});

describe('buildBlindReport', () => {
  it('contains A/B reviews, context, and rubric but no variant labels or metrics clues', () => {
    const plan = makePlan('clean-01', '1');
    const pair = blindPairOf(plan, 'test-seed').pair;

    const report = buildBlindReport({ seed: 'test-seed', pairs: [pair], excludedPairIds: [] });

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

  it('lists excluded incomplete pairs and renders only retained annotations', () => {
    const excluded = buildBlindReport({ seed: 'test-seed', pairs: [], excludedPairIds: ['local-01@r0', 'security-01@r0'] });
    expect(excluded).toContain('**Excluded (incomplete):** 2 pair(s)');
    expect(excluded).toContain('local-01@r0');
    expect(excluded).toContain('security-01@r0');

    // Generated has 2 findings but only 1 retained → the filtered one is hidden.
    const plan = makePlan('local-01', '1');
    const c = getCaseById('local-01');
    const generated: ReviewAnnotation[] = [
      {
        path: 'src/invoice/totals.ts', startLine: 14, endLine: 14,
        severity: 'warning', category: 'bug', title: 'firstPrice throws', body: 'items[0] is undefined.',
      },
      {
        path: 'src/invoice/totals.ts', startLine: 99, endLine: 99,
        severity: 'warning', category: 'bug', title: 'fake finding', body: 'this was filtered out.',
      },
    ];
    const retained = [generated[0]];
    const baseline = makeCompleted(plan.entries[0], c, { generated, retained });
    const experimental = makeCompleted(plan.entries[1], c);
    const pair = buildBlindPair({
      pairId: 'local-01@r0',
      caseId: 'local-01',
      roundIndex: 0,
      baselineAttempt: baseline,
      experimentalAttempt: experimental,
      case: c,
      seed: 'test-seed',
    });
    const report = buildBlindReport({ seed: 'test-seed', pairs: [pair], excludedPairIds: [] });
    expect(report).toContain('firstPrice throws');
    expect(report).not.toContain('fake finding');
  });

  it('is fence-safe against fixture content containing backticks', () => {
    const plan = makePlan('clean-01', '1');
    const pair = blindPairOf(plan, 'fence-test').pair;
    const report = buildBlindReport({ seed: 'fence-test', pairs: [pair], excludedPairIds: [] });
    expect(report).toContain('FiscalCR Blind Review Pack');
    // Fence openings and closings match in pairs.
    const fenceMatches = report.match(/```+/g);
    if (fenceMatches) {
      expect(fenceMatches.length % 2).toBe(0);
    }
  });
});

describe('buildBlindKey', () => {
  it('maps blindPairId to baseline/experimental with no review text or context', () => {
    const plan = makePlan('clean-01', '1');
    const { pair } = blindPairOf(plan, 'test-seed');

    const key = buildBlindKey([pair], 'test-seed', TIMESTAMP);
    expect(key.schema).toBe('fiscalcr-blind-key-v1');
    expect(key.seed).toBe('test-seed');
    expect(key.pairs).toHaveLength(1);

    const entry = key.pairs[0];
    expect(entry.blindPairId).toBe(pair.blindPairId);
    expect(entry.pairId).toBe('clean-01@r0');
    expect(entry.reviewA).toBe(pair.assignment.a);
    expect(entry.reviewB).toBe(pair.assignment.b);

    const json = JSON.stringify(key);
    expect(json).not.toContain('Good change overall.');
    expect(json).not.toContain('adds backoff');
    expect(json).not.toContain('format-time');
    expect(json).not.toContain('diff');
  });
});

describe('buildBlindPairsFromAttempts', () => {
  it('excludes incomplete pairs, returns none when no complete pairs, and sorts by round then case', () => {
    // 2 pairs, drop the experimental side of local-01.
    const plan = makePlan('clean-01, local-01', '1');
    const c1 = getCaseById('clean-01');
    const c2 = getCaseById('local-01');
    const attempts: CompletedAttempt[] = [];
    for (const entry of plan.entries) {
      const c = getCaseById(entry.caseId);
      if (entry.caseId === 'local-01' && entry.experimental) continue;
      attempts.push(makeCompleted(entry, c));
    }
    const { pairs, excludedPairIds } = buildBlindPairsFromAttempts({
      seed: 'test-seed',
      attempts,
      casesById: new Map([c1, c2].map((c) => [c.id, c])),
    });
    expect(pairs).toHaveLength(1);
    expect(pairs[0].caseId).toBe('clean-01');
    expect(excludedPairIds).toContain('local-01@r0');

    // Only baseline completed → nothing to pair.
    const none = buildBlindPairsFromAttempts({
      seed: 'test-seed',
      attempts: [makeCompleted(plan.entries[0], c1)],
      casesById: new Map([[c1.id, c1]]),
    });
    expect(none.pairs).toHaveLength(0);
    expect(none.excludedPairIds).toContain('clean-01@r0');

    // 2 cases × 2 rounds → 4 pairs sorted by roundIndex then caseId.
    const full = makePlan('clean-01, local-01', '2');
    const fullAttempts = full.entries.map((entry) => makeCompleted(entry, getCaseById(entry.caseId)));
    const sorted = buildBlindPairsFromAttempts({
      seed: 'test-seed',
      attempts: fullAttempts,
      casesById: new Map([c1, c2].map((c) => [c.id, c])),
    });
    expect(sorted.pairs).toHaveLength(4);
    const order = sorted.pairs.map((p) => `${p.roundIndex}-${p.caseId}`);
    expect(order).toEqual(order.slice().sort());
  });
});
