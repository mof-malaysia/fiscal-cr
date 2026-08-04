import { describe, expect, it } from 'vitest';
import type { LLMCompletionResponse } from '../../src/providers/interface.js';
import type { ReviewAnnotation, ReviewResult } from '../../src/types/review.js';
import { getCaseById, type BenchmarkCase } from '../../scripts/eval-cases.js';
import {
  REQUIRED_CONTRACT_KEYS,
  buildRunMetrics,
  captureFromResponse,
  type CapturedCall,
  type RunMetrics,
} from '../../scripts/eval-metrics.js';
import { evaluateRunQuality, type RunQualityReport } from '../../scripts/eval-quality.js';
import {
  buildEvalPlanFromEnv,
  type EvalPlan,
  type PlanEntry,
} from '../../scripts/eval-plan.js';
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
} from '../../scripts/eval-benchmark.js';

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
    expect(sanitizeError({ name: 'HTTPError', message: '502' })).toEqual({
      code: 'HTTPError',
      message: '502',
    });
    expect(sanitizeError(null)).toEqual({ code: 'unknown', message: 'Unknown error' });
    expect(sanitizeError(42)).toEqual({ code: 'error', message: '42' });
  });
});

describe('completedAttempt validation', () => {
  const plan = makePlan('clean-01', '1');
  const entry = plan.entries[0];
  const c = getCaseById(entry.caseId);

  it('builds a completed attempt with status/identity/case/metrics/quality', () => {
    const attempt = makeCompleted(entry, c);
    expect(attempt.status).toBe('completed');
    expect(attempt.identity).toEqual(planIdentityOf(entry));
    expect(attempt.case.caseId).toBe('clean-01');
    expect(attempt.metrics.totalTokens).toBe(150);
    expect(attempt.quality.postGate).toBeDefined();
    expect(attempt.requestTimestamp).toBe(TIMESTAMP);
  });

  it('rejects a variant/experimental identity mismatch', () => {
    expect(() =>
      completedAttempt({
        identity: { ...planIdentityOf(entry), experimental: !entry.experimental },
        case: caseIdentityOf(c),
        requestTimestamp: TIMESTAMP,
        metrics: makeCompleted(entry, c).metrics,
        quality: makeCompleted(entry, c).quality,
      }),
    ).toThrow(/identity mismatch/);
  });

  it('rejects an identity caseId that differs from the case identity', () => {
    expect(() =>
      completedAttempt({
        identity: { ...planIdentityOf(entry), caseId: 'other-01' },
        case: caseIdentityOf(c),
        requestTimestamp: TIMESTAMP,
        metrics: makeCompleted(entry, c).metrics,
        quality: makeCompleted(entry, c).quality,
      }),
    ).toThrow(/case mismatch/);
  });

  it('rejects metrics whose variant disagrees with the identity', () => {
    const other = makeCompleted(plan.entries[1] ?? entry, c); // opposite variant when available
    expect(() =>
      completedAttempt({
        identity: planIdentityOf(entry),
        case: caseIdentityOf(c),
        requestTimestamp: TIMESTAMP,
        metrics: other.metrics,
        quality: other.quality,
      }),
    ).toThrow(/variant mismatch/);
  });
});

describe('failedAttempt', () => {
  const plan = makePlan('clean-01', '1');
  const entry = plan.entries[0];
  const c = getCaseById(entry.caseId);

  it('stores only sanitized {code, message} — never the raw Error or stack', () => {
    const raw = new Error('connection reset');
    raw.name = 'ECONNRESET';
    (raw as Error & { stack?: string }).stack = 'Error: connection reset\n    at socket.on (net.js:1:1)';
    const attempt = makeFailed(entry, c, raw);
    expect(attempt.status).toBe('failed');
    expect(attempt.error).toEqual({ code: 'ECONNRESET', message: 'connection reset' });
    expect(JSON.stringify(attempt.error)).not.toContain('net.js');
    expect(Object.keys(attempt.error)).toEqual(['code', 'message']);
    expect(attempt.durationMs).toBe(500);
  });

  it('rejects a negative or NaN durationMs', () => {
    expect(() =>
      failedAttempt({
        identity: planIdentityOf(entry),
        case: caseIdentityOf(c),
        requestTimestamp: TIMESTAMP,
        durationMs: -1,
        error: 'nope',
      }),
    ).toThrow(/durationMs/);
    expect(() =>
      failedAttempt({
        identity: planIdentityOf(entry),
        case: caseIdentityOf(c),
        requestTimestamp: TIMESTAMP,
        durationMs: Number.NaN,
        error: 'nope',
      }),
    ).toThrow(/durationMs/);
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
    expect(result.execution.byVariant.experimental.planned).toBe(4);
    expect(result.execution.byVariant.experimental.completed).toBe(2);
    expect(result.execution.byVariant.experimental.failed).toBe(2);
    expect(result.execution.byVariant.experimental.completionRate).toBeCloseTo(0.5, 10);
  });

  it('zero completed variant: reliability/performance/quality aggregates are null, no divide/throw', () => {
    const plan = makePlan('clean-01, local-01', '2');
    const c1 = getCaseById('clean-01');
    const c2 = getCaseById('local-01');
    const attempts: Attempt[] = [];
    for (const entry of plan.entries) {
      const c = getCaseById(entry.caseId);
      attempts.push(
        entry.experimental ? makeFailed(entry, c, 'boom') : makeCompleted(entry, c),
      );
    }
    const result = buildBenchmarkResult({ plan, cases: [c1, c2], attempts });

    expect(result.execution.byVariant.experimental.completed).toBe(0);
    expect(result.reliability.experimental).toBeNull();
    expect(result.performance.experimental).toBeNull();
    expect(result.quality.preGate.experimental).toBeNull();
    expect(result.quality.postGate.experimental).toBeNull();
    // Baseline side unaffected.
    expect(result.reliability.baseline).not.toBeNull();
    expect(result.reliability.baseline!.completed).toBe(4);
    expect(result.quality.postGate.baseline).not.toBeNull();
    expect(result.regressions[0].status).toBe('insufficient-data');
  });

  it('rejects attempts that do not match the supplied plan', () => {
    const planA = makePlan('clean-01', '1');
    const planB = makePlan('local-01', '1');
    const attempts = allCompleted(planB);
    expect(() =>
      buildBenchmarkResult({ plan: planA, cases: [getCaseById('clean-01')], attempts }),
    ).toThrow(/does not match plan entry/);
  });
});

describe('reliability and performance aggregates', () => {
  it('exposes numerators with the completed denominator, plus format-length label (not quality)', () => {
    const plan = makePlan('clean-01', '2');
    const c = getCaseById('clean-01');
    const attempts = allCompleted(plan, {});
    const result = buildBenchmarkResult({ plan, cases: [c], attempts });

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
    let completedPairs = 0;
    for (const entry of plan.entries) {
      const c = getCaseById(entry.caseId);
      // Fail every experimental attempt of round 1 → round-1 pairs incomplete.
      if (entry.roundIndex === 1 && entry.experimental) {
        attempts.push(makeFailed(entry, c, 'boom'));
      } else {
        attempts.push(makeCompleted(entry, c));
        if (!entry.experimental) completedPairs += 1;
      }
    }
    const result = buildBenchmarkResult({ plan, cases: [c1, c2], attempts });

    expect(result.pairs.completePairs).toBe(2); // round 0 only
    expect(result.pairs.incompletePairs).toBe(2); // round 1 pairs
    expect(result.pairs.deltas).toHaveLength(2);
    expect(result.pairs.aggregate).not.toBeNull();
    expect(result.pairs.aggregate!.completePairs).toBe(2);

    for (const delta of result.pairs.deltas) {
      expect(delta.roundIndex).toBe(0);
      expect(delta.baseline.variant).toBe('baseline');
      expect(delta.experimental.variant).toBe('experimental');
      // Pair identity is exact: pairId/caseId/round shared by both sides.
      expect(delta.experimental.pairId).toBe(delta.baseline.pairId);
      expect(delta.experimental.caseId).toBe(delta.baseline.caseId);
      expect(delta.experimental.roundIndex).toBe(delta.baseline.roundIndex);
      expect(delta.pairId).toBe(delta.baseline.pairId);
      // globalCallIndex matches the plan entries.
      const planEntry = plan.entries.find((e) => e.globalCallIndex === delta.baseline.globalCallIndex)!;
      expect(planEntry.pairId).toBe(delta.pairId);
    }
  });

  it('aggregate means/medians use complete pairs only — never unmatched attempts', () => {
    const plan = makePlan('clean-01, local-01', '2');
    const c1 = getCaseById('clean-01');
    const c2 = getCaseById('local-01');
    const attempts: Attempt[] = [];
    for (const entry of plan.entries) {
      const c = getCaseById(entry.caseId);
      if (entry.roundIndex === 0) {
        // Round 0 complete with distinct durations.
        attempts.push(
          makeCompleted(entry, c, { durationMs: entry.experimental ? 2000 : 1000 }),
        );
      } else {
        // Round 1: baseline completed, experimental failed → incomplete.
        attempts.push(
          entry.experimental
            ? makeFailed(entry, c, 'boom')
            : makeCompleted(entry, c, { durationMs: 9000 }),
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
  });

  it('no complete pairs → deltas empty and aggregate null', () => {
    const plan = makePlan('clean-01, local-01', '1');
    const attempts: Attempt[] = [];
    for (const entry of plan.entries) {
      const c = getCaseById(entry.caseId);
      attempts.push(
        entry.experimental ? makeFailed(entry, c, 'boom') : makeCompleted(entry, c),
      );
    }
    const result = buildBenchmarkResult({
      plan,
      cases: [getCaseById('clean-01'), getCaseById('local-01')],
      attempts,
    });
    expect(result.pairs.completePairs).toBe(0);
    expect(result.pairs.incompletePairs).toBe(2);
    expect(result.pairs.deltas).toEqual([]);
    expect(result.pairs.aggregate).toBeNull();
  });
});

describe('savings percentages', () => {
  it('output and rawChars savings are positive when experimental is lower, and distinct', () => {
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
    expect(delta.rawCharsDelta).toBe(-100);
    expect(result.pairs.aggregate!.outputSavingsPct.mean).toBeCloseTo(20, 10);
    expect(result.pairs.aggregate!.rawCharsSavingsPct.mean).toBeCloseTo(10, 10);
  });

  it('experimental higher → negative savings; zero baseline → null', () => {
    const plan = makePlan('clean-01, local-01', '1');
    const c1 = getCaseById('clean-01');
    const c2 = getCaseById('local-01');
    const attempts: Attempt[] = [];
    for (const entry of plan.entries) {
      const c = getCaseById(entry.caseId);
      const isClean = entry.caseId === 'clean-01';
      if (isClean) {
        // clean-01: baseline output 0 → savings null.
        attempts.push(
          makeCompleted(entry, c, {
            outputTokens: entry.experimental ? 100 : 0,
            rawChars: entry.experimental ? 200 : 0,
          }),
        );
      } else {
        // local-01: experimental higher → negative savings.
        attempts.push(
          makeCompleted(entry, c, {
            outputTokens: entry.experimental ? 700 : 500,
            rawChars: entry.experimental ? 1200 : 1000,
          }),
        );
      }
    }
    const result = buildBenchmarkResult({
      plan,
      cases: [c1, c2],
      attempts,
    });
    const clean = result.pairs.deltas.find((d) => d.caseId === 'clean-01')!;
    const local = result.pairs.deltas.find((d) => d.caseId === 'local-01')!;

    expect(clean.outputSavingsPct).toBeNull();
    expect(clean.rawCharsSavingsPct).toBeNull();
    expect(local.outputSavingsPct).toBeCloseTo(-40, 10); // (500-700)/500
    expect(local.rawCharsSavingsPct).toBeCloseTo(-20, 10); // (1000-1200)/1000

    // Aggregate: null savings skipped; only the negative pair remains.
    expect(result.pairs.aggregate!.outputSavingsPct.mean).toBeCloseTo(-40, 10);
    expect(result.pairs.aggregate!.outputSavingsPct.median).toBeCloseTo(-40, 10);
  });

  it('zero completed pairs → aggregate savings null', () => {
    const plan = makePlan('clean-01', '1');
    const c = getCaseById('clean-01');
    const attempts: Attempt[] = plan.entries.map((entry) =>
      makeFailed(entry, c, 'boom'),
    );
    const result = buildBenchmarkResult({ plan, cases: [c], attempts });
    expect(result.pairs.aggregate).toBeNull();
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
        attempts.push(
          makeCompleted(entry, c, {
            generated: [WRONG_PATH_FINDING],
            retained: [],
          }),
        );
      } else {
        // local-01: both gold issues detected and retained.
        attempts.push(
          makeCompleted(entry, c, {
            generated: [TOTALS_FINDING, TAKE_N_FINDING],
            retained: [TOTALS_FINDING, TAKE_N_FINDING],
          }),
        );
      }
    }
    const result = buildBenchmarkResult({ plan, cases: [c1, c2], attempts });

    const pre = result.quality.preGate.baseline!;
    const post = result.quality.postGate.baseline!;

    // Pre-gate: clean-01 run contributes 1 FP, local-01 run contributes 2 TP.
    expect(pre.totalTp).toBe(2);
    expect(pre.totalFp).toBe(1);
    expect(pre.micro.precision).toBeCloseTo(2 / 3, 10);
    // Post-gate: the FP was dropped.
    expect(post.totalFp).toBe(0);
    expect(post.cleanRate).toBe(1);
    expect(post.micro.precision).toBe(1);
    expect(post.micro.recall).toBe(1);

    // Per-case summaries preserved.
    const perCase = new Map(post.perCase.map((p) => [p.caseId, p]));
    expect(perCase.get('clean-01')).toMatchObject({ runs: 1, tp: 0, fp: 0, clean: true });
    expect(perCase.get('local-01')).toMatchObject({ runs: 1, tp: 2, fp: 0, clean: true });

    // Per-issue detection preserved.
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
      if (!entry.experimental) {
        return makeCompleted(entry, c, {
          generated: [TOTALS_FINDING, TAKE_N_FINDING],
          retained: [TOTALS_FINDING, TAKE_N_FINDING],
        });
      }
      return experimentalDetects
        ? makeCompleted(entry, c, {
            generated: [TOTALS_FINDING, TAKE_N_FINDING],
            retained: [TOTALS_FINDING, TAKE_N_FINDING],
          })
        : makeCompleted(entry, c, { generated: [], retained: [] });
    });
  }

  it('is insufficient-data below the configured minimum runs (4)', () => {
    const plan = makePlan('local-01', '3'); // 3 < 4
    const c = getCaseById('local-01');
    const result = buildBenchmarkResult({
      plan,
      cases: [c],
      attempts: regressionAttempts(plan, false),
    });
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0].status).toBe('insufficient-data');
    expect(result.regressions[0].baseline).toBeNull();
    expect(result.regressions[0].experimental).toBeNull();
    expect(result.regressions[0].runs).toBe(3);
  });

  it('detects a large regression at 4 runs when baseline detection is high and experimental collapses', () => {
    const plan = makePlan('local-01', '4');
    const c = getCaseById('local-01');
    const result = buildBenchmarkResult({
      plan,
      cases: [c],
      attempts: regressionAttempts(plan, false),
    });
    const regression = result.regressions[0];
    expect(regression.status).toBe('detected');
    expect(regression.metric).toBe('microRecall');
    expect(regression.baseline).toBe(1); // 8 TP / 8 gold
    expect(regression.experimental).toBe(0); // 0 TP / 8 gold
    expect(regression.baselineThreshold).toBe(0.75);
    expect(regression.experimentalThreshold).toBe(0.25);
  });

  it('reports none when experimental stays within thresholds', () => {
    const plan = makePlan('local-01', '4');
    const c = getCaseById('local-01');
    const result = buildBenchmarkResult({
      plan,
      cases: [c],
      attempts: regressionAttempts(plan, true),
    });
    expect(result.regressions[0].status).toBe('none');
    expect(result.regressions[0].experimental).toBe(1);
  });

  it('respects custom minRuns and thresholds', () => {
    const plan = makePlan('local-01', '2');
    const c = getCaseById('local-01');
    const result = buildBenchmarkResult({
      plan,
      cases: [c],
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
    expect(artifact.provider).toBe('kimi');
    expect(artifact.model).toBe('kimi-for-coding');
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
    expect(local.expectedIssues[0].acceptedPaths).toEqual(['src/invoice/totals.ts']);
    expect(local.expectedIssues[0].rationale.length).toBeGreaterThan(0);

    const json = JSON.stringify(artifact);
    expect(json).not.toContain('fileContents');
    expect(json).not.toContain('"diff"');
    expect(json).not.toContain('"patch"');
  });

  it('keeps completed review text for the later blind human report', () => {
    const artifact = buildArtifact();
    const json = JSON.stringify(artifact);
    expect(json).toContain(SUMMARY);
    expect(json).toContain(INTENT);
    const completed = artifact.attempts[0];
    expect(completed.status).toBe('completed');
    if (completed.status === 'completed') {
      expect(completed.metrics.review.summary).toBe(SUMMARY);
    }
  });

  it('never persists a raw provider body sentinel', () => {
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
    // captureFromResponse never stores content — only rawChars.
    expect(JSON.stringify(capture)).not.toContain(RAW_MARKER);
    const result: ReviewResult = {
      summary: SUMMARY, score: 82, annotations: [],
      stats: { critical: 0, warning: 0, suggestion: 0, nitpick: 0 },
      tokensUsed: { input: 100, output: 50, cached: 0 },
      walkthrough: WALKTHROUGH, intent: INTENT, callCount: 1,
    };
    const metrics = buildRunMetrics({
      experimental: entry.experimental, pairIndex: entry.roundIndex, runIndex: entry.caseIndex,
      durationMs: 1000, tokens: { input: 100, output: 50, cached: 0 }, calls: 1,
      captures: [capture], result, changedFilePaths: CHANGED_PATHS,
    });
    const attempt = completedAttempt({
      identity: planIdentityOf(entry), case: caseIdentityOf(c),
      requestTimestamp: TIMESTAMP, metrics,
      quality: evaluateRunQuality({
        case: c, generatedFindings: [], retainedFindings: [], outputTokens: 50,
      }),
    });
    const artifact = buildBenchmarkArtifact({
      timestamp: TIMESTAMP,
      benchmark: { suiteId: 's', suiteVersion: 1 },
      repository: { commit: null, dirty: null },
      provider: 'p', model: 'm',
      prompt: { baseline: promptMetadata('x'), experimental: promptMetadata('y') },
      retries: 0, timeoutMs: 1000,
      plan, cases: [c], attempts: [attempt],
    });
    expect(JSON.stringify(artifact)).not.toContain(RAW_MARKER);
  });

  it('fails closed when a completed attempt references an unknown case', () => {
    const plan = makePlan('clean-01', '1');
    const attempts = allCompleted(plan);
    expect(() =>
      buildBenchmarkResult({ plan, cases: [], attempts }),
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

  it('passes on a clean artifact (no forbidden keys/substrings)', () => {
    const artifact = cleanArtifact();
    expect(checkArtifactSafety(artifact).safe).toBe(true);
    expect(() => assertArtifactSafe(artifact)).not.toThrow();
    expect(() => assertArtifactSafe(artifact, { secret: 'sk-test-abcdef' })).not.toThrow();
  });

  it('recursively catches a planted secret deep in review text', () => {
    const artifact = cleanArtifact();
    const attempt = artifact.attempts[0] as CompletedAttempt;
    (attempt.metrics.review.annotations as ReviewAnnotation[]).push({
      path: 'src/x.ts', startLine: 1, endLine: 1,
      severity: 'warning', category: 'bug',
      title: 'leak', body: 'the token is sk-test-abcdef',
    });

    const report = checkArtifactSafety(artifact, { secret: 'sk-test-abcdef' });
    expect(report.safe).toBe(false);
    expect(report.violations.length).toBeGreaterThan(0);
    expect(report.violations[0].kind).toBe('substring');
    expect(report.violations[0].match).toBe('sk-test-abcdef');
    expect(report.violations[0].path).toContain('attempts');
    expect(() => assertArtifactSafe(artifact, { secret: 'sk-test-abcdef' })).toThrow(
      /sk-test-abcdef/,
    );
  });

  it('catches forbidden keys at any depth (key-based, case-insensitive)', () => {
    const artifact = cleanArtifact();
    (artifact.aggregates as unknown as Record<string, unknown>).apiKey = 'sk-test-xyz';
    (artifact.pairs as unknown as Record<string, unknown>).RAW_RESPONSE = 'nope';
    (artifact.config as unknown as Record<string, unknown>)['baseUrl'] = 'https://x';

    const report = checkArtifactSafety(artifact);
    expect(report.safe).toBe(false);
    const keys = report.violations.filter((v) => v.kind === 'key').map((v) => v.path);
    expect(keys).toEqual(
      expect.arrayContaining(['aggregates.apiKey', 'pairs.RAW_RESPONSE', 'config.baseUrl']),
    );
  });

  it('reports an empty string secret as absent (never matches everything)', () => {
    const artifact = cleanArtifact();
    expect(checkArtifactSafety(artifact, { secret: '' }).safe).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Determinism / numeric hygiene

describe('determinism and numeric hygiene', () => {
  it('serializes identically for identical inputs', () => {
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
  });

  it('contains no NaN or Infinity anywhere', () => {
    const plan = makePlan('clean-01, local-01', '2');
    const cases = plan.config.caseIds.map((id) => getCaseById(id));
    const attempts: Attempt[] = [];
    for (const entry of plan.entries) {
      const c = getCaseById(entry.caseId);
      attempts.push(
        entry.experimental && entry.roundIndex === 1
          ? makeFailed(entry, c, 'boom')
          : makeCompleted(entry, c, {
              outputTokens: entry.experimental ? 0 : 0, // zero-output edge
              rawChars: 0,
            }),
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
    // Zero-output edges yield null savings, never a division blowup.
    const json = JSON.stringify(artifact);
    expect(json).not.toContain('NaN');
    expect(json).not.toContain('Infinity');
  });

  it('sha256Hex is deterministic and 64 hex chars', () => {
    expect(sha256Hex('hello')).toBe(sha256Hex('hello'));
    expect(sha256Hex('hello')).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex('hello')).not.toBe(sha256Hex('world'));
  });
});
