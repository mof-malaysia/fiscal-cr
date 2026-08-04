import { describe, expect, it } from 'vitest';
import type { LLMCompletionResponse } from '../../src/providers/interface.js';
import type { ReviewResult } from '../../src/types/review.js';
import {
  aggregateRuns,
  buildArtifact,
  buildRunMetrics,
  captureFromResponse,
  computeDelta,
  mean,
  median,
  pairRunOrder,
  resolveEvalRuns,
  wordCount,
  type RunMetrics,
} from '../../scripts/eval-metrics.js';

const emptyEnv: NodeJS.ProcessEnv = {};

const CHANGED_PATHS = ['src/utils/retry.ts', 'src/utils/cache.ts'];

function response(content: string, usage?: Partial<LLMCompletionResponse['usage']>): LLMCompletionResponse {
  return {
    content,
    usage: { input: 100, output: 50, cached: 0, ...usage },
    finishReason: 'stop',
  };
}

// Full contract JSON: all five top-level keys, walkthrough covering BOTH
// changed files, one finding.
const FULL_JSON = JSON.stringify({
  intent: 'Adds a Redis cache and retry backoff to the review pipeline.',
  summary: 'Good change overall.',
  score: 82,
  walkthrough: [
    { path: 'src/utils/retry.ts', summary: 'adds backoff' },
    { path: 'src/utils/cache.ts', summary: 'adds a cache' },
  ],
  findings: [
    {
      path: 'src/utils/retry.ts',
      startLine: 13,
      endLine: 13,
      severity: 'warning',
      category: 'bug',
      title: 'sleep is not defined',
      body: 'sleep is not imported or defined anywhere.',
    },
  ],
});

const GOOD_RESULT: ReviewResult = {
  summary: 'Good change overall.',
  score: 82,
  annotations: [
    {
      path: 'src/utils/retry.ts',
      startLine: 13,
      endLine: 13,
      severity: 'warning',
      category: 'bug',
      title: 'sleep is not defined',
      body: 'sleep is not imported or defined anywhere.',
    },
  ],
  stats: { critical: 0, warning: 1, suggestion: 0, nitpick: 0 },
  tokensUsed: { input: 100, output: 50, cached: 0 },
  walkthrough: [
    { path: 'src/utils/retry.ts', summary: 'adds backoff' },
    { path: 'src/utils/cache.ts', summary: 'adds a cache' },
  ],
  intent: 'Adds a Redis cache and retry backoff to the review pipeline.',
  callCount: 1,
};

// Parsed, contract-complete, empty findings: a genuine zero-finding review.
const ZERO_JSON = JSON.stringify({
  intent: 'Adds a Redis cache and retry backoff.',
  summary: 'No issues found.',
  score: 90,
  walkthrough: [
    { path: 'src/utils/retry.ts', summary: 'adds backoff' },
    { path: 'src/utils/cache.ts', summary: 'adds a cache' },
  ],
  findings: [],
});

const RAW_MARKER = 'RAW-CONTENT-SENTINEL-9876';

// Valid contract JSON with an extra unknown key that zod strips on parse —
// a sentinel proving raw response content is never persisted.
const MARKED_JSON = FULL_JSON.replace(
  '{',
  `{"zzzRawMarker":"${RAW_MARKER}",`,
);

function build(
  experimental: boolean,
  input: {
    response?: string;
    durationMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    retainedFindings?: number;
    score?: number;
  } = {},
): RunMetrics {
  const capture = captureFromResponse(response(input.response ?? FULL_JSON), 1, 1000);
  const retained = input.retainedFindings ?? GOOD_RESULT.annotations.length;
  const annotations =
    retained === 0
      ? []
      : Array.from({ length: retained }, (_, i) => ({
          ...GOOD_RESULT.annotations[0],
          startLine: i + 1,
        }));
  return buildRunMetrics({
    experimental,
    pairIndex: 0,
    runIndex: experimental ? 1 : 0,
    durationMs: input.durationMs ?? 1000,
    tokens: {
      input: input.inputTokens ?? 100,
      output: input.outputTokens ?? 50,
      cached: 0,
    },
    calls: 1,
    captures: [capture],
    result: { ...GOOD_RESULT, annotations, score: input.score ?? GOOD_RESULT.score },
    changedFilePaths: CHANGED_PATHS,
  });
}

describe('resolveEvalRuns', () => {
  it('defaults to 1 when unset or empty', () => {
    expect(resolveEvalRuns(emptyEnv)).toBe(1);
    expect(resolveEvalRuns({ EVAL_RUNS: '' })).toBe(1);
    expect(resolveEvalRuns({ EVAL_RUNS: '   ' })).toBe(1);
  });

  it('parses integers in range 1..10', () => {
    expect(resolveEvalRuns({ EVAL_RUNS: '3' })).toBe(3);
    expect(resolveEvalRuns({ EVAL_RUNS: ' 5 ' })).toBe(5);
    expect(resolveEvalRuns({ EVAL_RUNS: '10' })).toBe(10);
  });

  it('rejects non-integers and out-of-range values', () => {
    expect(() => resolveEvalRuns({ EVAL_RUNS: 'abc' })).toThrow(/EVAL_RUNS/);
    expect(() => resolveEvalRuns({ EVAL_RUNS: '1.5' })).toThrow(/EVAL_RUNS/);
    expect(() => resolveEvalRuns({ EVAL_RUNS: '0' })).toThrow(/between 1 and 10/);
    expect(() => resolveEvalRuns({ EVAL_RUNS: '11' })).toThrow(/between 1 and 10/);
  });
});

describe('pairRunOrder alternation', () => {
  it('alternates baseline→experimental with experimental→baseline', () => {
    expect(pairRunOrder(0)).toEqual([false, true]);
    expect(pairRunOrder(1)).toEqual([true, false]);
    expect(pairRunOrder(2)).toEqual([false, true]);
    expect(pairRunOrder(3)).toEqual([true, false]);
  });
});

describe('word / numeric helpers', () => {
  it('counts words', () => {
    expect(wordCount('')).toBe(0);
    expect(wordCount('   ')).toBe(0);
    expect(wordCount('a b c')).toBe(3);
    expect(wordCount('  a  b\tc\n d  ')).toBe(4);
  });

  it('computes mean and median', () => {
    expect(mean([])).toBe(0);
    expect(mean([1, 2, 3])).toBe(2);
    expect(median([])).toBe(0);
    expect(median([5])).toBe(5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe('captureFromResponse', () => {
  it('extracts metadata without storing raw content', () => {
    const capture = captureFromResponse(response(MARKED_JSON), 1, 250);
    expect(capture.parseSuccess).toBe(true);
    expect(capture.rawChars).toBe(MARKED_JSON.length);
    expect(capture.generatedFindings).toBe(1);
    expect(capture.topLevelKeys).toEqual(
      expect.arrayContaining(['intent', 'summary', 'score', 'walkthrough', 'findings']),
    );
    expect(capture.finishReason).toBe('stop');
    // The raw content sentinel only exists in the response string — the
    // capture stores parsed metadata, never the raw content.
    expect(JSON.stringify(capture)).not.toContain(RAW_MARKER);
  });

  it('reports parse failure on garbage', () => {
    const capture = captureFromResponse(response('not json at all', { input: 1, output: 0 }), 1, 5);
    expect(capture.parseSuccess).toBe(false);
    expect(capture.topLevelKeys).toEqual([]);
    expect(capture.generatedFindings).toBe(0);
  });
});

describe('buildRunMetrics', () => {
  it('records token totals, retention and contract completeness', () => {
    const m = build(false);
    expect(m.variant).toBe('baseline');
    expect(m.totalTokens).toBe(150);
    expect(m.calls).toBe(1);
    expect(m.generatedFindings).toBe(1);
    expect(m.retainedFindings).toBe(1);
    expect(m.retentionRate).toBe(1);
    expect(m.contractComplete).toBe(true);
    expect(m.walkthroughCoverage).toBe(1); // both changed files covered
    expect(m.score).toBe(82);
  });

  it('regression: total tokens = input + output (input already includes the cached subset)', () => {
    const m = buildRunMetrics({
      experimental: false, pairIndex: 0, runIndex: 0, durationMs: 200,
      tokens: { input: 100, output: 50, cached: 20 },
      calls: 1,
      captures: [captureFromResponse(response(FULL_JSON, { cached: 20 }), 1, 100)],
      result: GOOD_RESULT, changedFilePaths: CHANGED_PATHS,
    });
    expect(m.inputTokens).toBe(100);
    expect(m.cachedTokens).toBe(20);
    // Cached is a subset of input — never added again.
    expect(m.totalTokens).toBe(150);
    expect(m.totalTokens).not.toBe(170);
  });

  it('measures walkthrough coverage by unique paths matching changed files', () => {
    const dupUnknown = JSON.stringify({
      intent: 'x',
      summary: 'y',
      score: 80,
      walkthrough: [
        { path: 'src/utils/retry.ts', summary: 'a' },
        { path: 'src/utils/retry.ts', summary: 'duplicate' },
        { path: 'src/utils/nope.ts', summary: 'not changed' },
      ],
      findings: [],
    });
    const m = build(false, { response: dupUnknown });
    // Only retry.ts is a real changed file; duplicates/unknown paths don't help.
    expect(m.walkthroughCoverage).toBe(0.5);
    expect(m.generatedFindings).toBe(0);
    expect(m.zeroFindingsKind).toBe('contract-incomplete'); // walkthrough incomplete
  });

  it('classifies zero findings: genuine only when parsed + contract + completeness hold', () => {
    // Genuine: parsed, contract complete, narrative + walkthrough complete.
    const genuine = build(false, { response: ZERO_JSON });
    expect(genuine.generatedFindings).toBe(0);
    expect(genuine.zeroFindingsKind).toBe('genuine');
    expect(genuine.conciseCompliant).toBe(true);
    expect(genuine.limitsMet).toBe(true);

    // Parser fallback: response did not parse.
    const fallback = build(false, { response: 'garbage' });
    expect(fallback.zeroFindingsKind).toBe('parser-fallback');

    // Contract-incomplete: parsed but missing required top-level keys
    // (baseline-like partial JSON: summary present, rest of contract absent).
    const partial = build(false, { response: JSON.stringify({ summary: 'partial review', findings: [] }) });
    expect(partial.parseSuccess).toBe(true);
    expect(partial.contractComplete).toBe(false);
    expect(partial.zeroFindingsKind).toBe('contract-incomplete');

    // Contract keys all present but narrative incomplete (empty intent).
    const emptyIntent = build(false, {
      response: JSON.stringify({
        intent: '',
        summary: 'ok',
        score: 80,
        walkthrough: [
          { path: 'src/utils/retry.ts', summary: 'a' },
          { path: 'src/utils/cache.ts', summary: 'b' },
        ],
        findings: [],
      }),
    });
    expect(emptyIntent.contractComplete).toBe(true);
    expect(emptyIntent.intentPresent).toBe(false);
    expect(emptyIntent.zeroFindingsKind).toBe('contract-incomplete');
  });

  it('computes word counts and strict concise compliance with separate limitsMet', () => {
    const compliant = build(false);
    expect(compliant.intentWords).toBeLessThanOrEqual(40);
    expect(compliant.limitsMet).toBe(true);
    expect(compliant.conciseCompliant).toBe(true);

    // Over the word limits → limitsMet false and not compliant.
    const verbose = JSON.stringify({
      intent: 'word '.repeat(41).trim(),
      summary: 'word '.repeat(90).trim(),
      score: 80,
      walkthrough: [
        { path: 'src/utils/retry.ts', summary: 'word '.repeat(25).trim() },
        { path: 'src/utils/cache.ts', summary: 'word '.repeat(25).trim() },
      ],
      findings: [
        {
          path: 'src/utils/retry.ts', startLine: 1, endLine: 1, severity: 'warning',
          category: 'bug', title: 't', body: 'word '.repeat(85).trim(),
        },
      ],
    });
    const over = build(true, { response: verbose });
    expect(over.limitsMet).toBe(false);
    expect(over.conciseCompliant).toBe(false);

    // Within limits but incomplete (walkthrough covers 1 of 2 changed files):
    // limitsMet true, yet NOT compliant.
    const incomplete = JSON.stringify({
      intent: 'Adds a cache.',
      summary: 'Fine.',
      score: 80,
      walkthrough: [{ path: 'src/utils/retry.ts', summary: 'ok' }],
      findings: [],
    });
    const shortButIncomplete = build(false, { response: incomplete });
    expect(shortButIncomplete.limitsMet).toBe(true);
    expect(shortButIncomplete.walkthroughCoverage).toBe(0.5);
    expect(shortButIncomplete.conciseCompliant).toBe(false);
  });
});

describe('aggregation and deltas', () => {
  it('aggregates rates and mean/median per variant', () => {
    const baseline = [
      build(false, { durationMs: 8000, outputTokens: 500, retainedFindings: 3, score: 70 }),
      build(false, { durationMs: 12000, outputTokens: 700, retainedFindings: 5, score: 74 }),
    ];
    const experimental = [build(true, { durationMs: 6000, outputTokens: 400, retainedFindings: 3, score: 78 })];

    const agg = aggregateRuns([...baseline, ...experimental]);
    expect(agg.baseline.runs).toBe(2);
    expect(agg.baseline.parseRate).toBe(1);
    expect(agg.baseline.contractRate).toBe(1);
    expect(agg.baseline.successRate).toBe(1);
    expect(agg.baseline.meanDurationMs).toBe(10000);
    expect(agg.baseline.medianDurationMs).toBe(10000);
    expect(agg.baseline.meanOutputTokens).toBe(600);
    expect(agg.baseline.medianFindings).toBe(4);
    expect(agg.experimental.runs).toBe(1);
    expect(agg.experimental.meanScore).toBe(78);
  });

  it('successRate reflects strict usable success on a mixed valid/incomplete set', () => {
    // One complete run, one parsed-but-contract-incomplete run.
    const incomplete = build(false, { response: JSON.stringify({ summary: 'partial', findings: [] }) });
    expect(incomplete.contractComplete).toBe(false);

    const agg = aggregateRuns([build(false), incomplete]);
    expect(agg.baseline.runs).toBe(2);
    expect(agg.baseline.parseRate).toBe(1); // both parsed
    expect(agg.baseline.contractRate).toBe(0.5); // one contract-complete
    expect(agg.baseline.successRate).toBe(0.5); // parse && contract
  });

  it('output savings is positive when experimental uses fewer output tokens', () => {
    const base = aggregateRuns([build(false, { outputTokens: 500 })]).baseline;
    const exp = aggregateRuns([build(true, { outputTokens: 400 })]).experimental;
    const delta = computeDelta(base, exp);
    expect(delta.outputSavingsPct).toBeCloseTo(20, 5); // (500-400)/500
    expect(delta.outputDeltaTokens).toBe(-100);
    expect(delta.scoreDelta).toBe(0);

    // Experimental using MORE output tokens → negative savings.
    const wasteful = aggregateRuns([build(true, { outputTokens: 600 })]).experimental;
    expect(computeDelta(base, wasteful).outputSavingsPct).toBeCloseTo(-20, 5);

    const zeroBase = aggregateRuns([build(false, { outputTokens: 0 })]).baseline;
    expect(computeDelta(zeroBase, exp).outputSavingsPct).toBeNull();
  });
});

describe('buildArtifact secret-safe shape', () => {
  it('contains metrics/aggregates/deltas but never secrets or raw content', () => {
    const metrics = [build(false), build(true)];
    const artifact = buildArtifact({
      timestamp: '2026-08-04T12:00:00.000Z',
      provider: 'kimi',
      model: 'kimi-for-coding',
      fixtureName: 'synthetic-review-pr',
      fixtureVersion: 1,
      changedFileCount: CHANGED_PATHS.length,
      runs: 1,
      retries: 0,
      pairOrders: [[false, true]],
      runMetrics: metrics,
    });

    expect(artifact.schema).toBe('fiscalcr-eval-v1');
    expect(artifact.config.callsPlanned).toBe(2);
    expect(artifact.runs).toHaveLength(2);
    expect(artifact.runs[0].limitsMet).toBe(true);
    expect(artifact.aggregates.baseline.runs).toBe(1);
    expect(artifact.deltas.outputSavingsPct).not.toBeUndefined();

    const json = JSON.stringify(artifact);
    expect(json).not.toMatch(/apiKey|API_KEY|baseUrl|BASE_URL/i);
    expect(json).not.toContain('sk-test');
    expect(json).not.toContain(RAW_MARKER); // raw response content
    expect(json).not.toContain('NODE_ENV');
  });
});
