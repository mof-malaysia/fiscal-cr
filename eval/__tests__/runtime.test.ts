import { readdirSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LLMCompletionResponse, LLMProvider } from '../../src/providers/interface.js';
import type { ReviewResult } from '../../src/types/review.js';
import { buildEvalPlanFromEnv, type EvalPlan } from '../plan.js';
import { getCaseById, type BenchmarkCase } from '../cases.js';
import {
  buildBenchmarkArtifact,
  assertArtifactSafe,
  buildBenchmarkResult,
  type Attempt,
  type CompletedAttempt,
} from '../benchmark.js';
import {
  buildPromptReport,
  buildSuitePromptMetadata,
  evalReviewConfig,
  executePlan,
  formatDelta,
  gitRepoMetadata,
  redactSecrets,
  requireApiKey,
  resolveEvalEnv,
  type RunStats,
} from '../runtime.js';
import {
  aggregateRuns,
  buildRunMetrics,
  captureFromResponse,
  computeDelta,
  mean,
  median,
  wordCount,
  type RunMetrics,
} from '../metrics.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';

// Prove dry mode never creates a live provider: the factory is replaced with a
// spy that throws when called. Dry main must never call it. SUPPORTED_PROVIDERS
// stays real so env resolution works.
vi.mock('../../src/providers/factory.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/providers/factory.js')>();
  return {
    ...actual,
    createLLMProvider: vi.fn(() => {
      throw new Error('createLLMProvider must not be called during a dry run');
    }),
  };
});

import { main } from '../live.js';
import { createLLMProvider } from '../../src/providers/factory.js';

const RESULT_DIR = '.eval-results';
const mockedCreate = vi.mocked(createLLMProvider);

// ---------------------------------------------------------------------------
// Shared helpers

const emptyEnv: NodeJS.ProcessEnv = {};

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

const CFG = { provider: 'kimi', model: 'kimi-for-coding' };
const CASE_CONTEXT = getCaseById('clean-01').context;

/** Valid fast-path response whose findings mirror the case's gold issues. */
function fakeResponse(c: BenchmarkCase): LLMCompletionResponse {
  const findings = c.expectedIssues.map((issue) => ({
    path: issue.acceptedPaths[0],
    startLine: issue.acceptedLineRanges[0].startLine,
    endLine: issue.acceptedLineRanges[0].endLine,
    severity: issue.minSeverity,
    category: issue.acceptedCategories[0],
    title: `detect ${issue.issueId}`,
    body: `body for ${issue.issueId}`,
  }));
  const content = JSON.stringify({
    intent: `Reviews ${c.id}.`,
    summary: `Summary for ${c.id}.`,
    score: 80,
    walkthrough: c.context.changedFiles.map((f) => ({ path: f.filename, summary: 'ok' })),
    findings,
  });
  return { content, usage: { input: 500, output: 200, cached: 0 }, finishReason: 'stop' };
}

/** Provider factory aligned to plan order: entry i -> fake response for its case. */
function successFactory(plan: EvalPlan): (config: unknown) => LLMProvider {
  const responses = plan.entries.map((entry) => fakeResponse(getCaseById(entry.caseId)));
  let i = 0;
  return () => ({ chatCompletion: async () => responses[i++] });
}

/** Provider factory that throws on call index `failAt` (0-based), else succeeds. */
function mixedFactory(plan: EvalPlan, failAt: number): (config: unknown) => LLMProvider {
  const responses = plan.entries.map((entry) => fakeResponse(getCaseById(entry.caseId)));
  let i = 0;
  return () => ({
    chatCompletion: async () => {
      const idx = i++;
      if (idx === failAt) {
        const err = new Error('connection reset');
        err.name = 'ECONNRESET';
        (err as Error & { stack?: string }).stack =
          'ECONNRESET: connection reset\n    at socket.on (net.js:1:1)';
        throw err;
      }
      return responses[idx];
    },
  });
}

function failingFactory(error: unknown): (config: unknown) => LLMProvider {
  return () => ({ chatCompletion: async () => Promise.reject(error) });
}

async function run(plan: EvalPlan, opts: { providerFactory?: (c: unknown) => LLMProvider; apiKey?: string } = {}) {
  const attempts: Attempt[] = [];
  const pairInfo: Array<Record<string, unknown>> = [];
  const onAttemptCalls: number[] = [];
  const cases = plan.config.caseIds.map((id) => getCaseById(id));
  const { attempts: result } = await executePlan(plan, cases, CFG, {
    apiKey: opts.apiKey ?? 'sk-test-none',
    providerFactory: opts.providerFactory as never,
    onAttempt: (attempt, callNumber) => {
      attempts.push(attempt);
      onAttemptCalls.push(callNumber);
    },
    onPairProgress: (info) =>
      pairInfo.push({
        pairId: info.pairId,
        complete: info.complete,
        completed: info.completed,
        failed: info.failed,
        order: [...info.order],
      }),
  });
  return { attempts: result, attemptsObserved: attempts, onAttemptCalls, pairInfo, cases };
}

// ---------------------------------------------------------------------------
// Metrics fixtures

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
const MARKED_JSON = FULL_JSON.replace('{', `{"zzzRawMarker":"${RAW_MARKER}",`);

function buildMetrics(
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

function resultFileCount(): number {
  try {
    return readdirSync(RESULT_DIR).length;
  } catch {
    return 0;
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  mockedCreate.mockClear();
});

// ---------------------------------------------------------------------------
// resolveEvalEnv / requireApiKey / evalReviewConfig

describe('resolveEvalEnv', () => {
  it('falls back to DEFAULT_CONFIG provider and model', () => {
    const cfg = resolveEvalEnv(emptyEnv);
    expect(cfg.provider).toBe(DEFAULT_CONFIG.provider);
    expect(cfg.model).toBe(DEFAULT_CONFIG.model);
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.baseUrl).toBeUndefined();
  });

  it('resolves API_KEY with FISCALCR_API_KEY / KIMI_API_KEY fallbacks; empty treated as unset', () => {
    expect(resolveEvalEnv({ API_KEY: 'a' }).apiKey).toBe('a');
    expect(resolveEvalEnv({ API_KEY: 'a', FISCALCR_API_KEY: 'f' }).apiKey).toBe('a');
    expect(resolveEvalEnv({ FISCALCR_API_KEY: 'f', KIMI_API_KEY: 'k' }).apiKey).toBe('f');
    expect(resolveEvalEnv({ KIMI_API_KEY: 'k' }).apiKey).toBe('k');
    const cfg = resolveEvalEnv({ API_KEY: '', MODEL: '', BASE_URL: '' });
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.model).toBe(DEFAULT_CONFIG.model);
    expect(cfg.baseUrl).toBeUndefined();
  });

  it('resolves MODEL/MODEL_PROVIDER/BASE_URL with fallbacks and validation', () => {
    expect(resolveEvalEnv({ MODEL: 'm1', KIMI_MODEL: 'm2' }).model).toBe('m1');
    expect(resolveEvalEnv({ KIMI_MODEL: 'm2' }).model).toBe('m2');
    expect(resolveEvalEnv({ MODEL: '', KIMI_MODEL: 'm2' }).model).toBe('m2');
    expect(resolveEvalEnv({ KIMI_MODEL: '' }).model).toBe(DEFAULT_CONFIG.model);

    expect(resolveEvalEnv({ MODEL_PROVIDER: 'openai-compatible' }).provider).toBe(
      'openai-compatible',
    );
    expect(() => resolveEvalEnv({ MODEL_PROVIDER: 'anthropic' })).toThrow(
      /Invalid MODEL_PROVIDER "anthropic"/,
    );

    expect(
      resolveEvalEnv({ BASE_URL: 'https://a.example/v1', FISCALCR_BASE_URL: 'https://b.example/v1' }).baseUrl,
    ).toBe('https://a.example/v1');
    expect(resolveEvalEnv({ FISCALCR_BASE_URL: 'https://b.example/v1' }).baseUrl).toBe(
      'https://b.example/v1',
    );
    expect(resolveEvalEnv({ LLM_USER_AGENT: 'agent/1' }).userAgent).toBe('agent/1');
  });
});

describe('requireApiKey', () => {
  it('throws a clear error when the key is missing and returns it when present', () => {
    expect(() => requireApiKey({ provider: 'kimi', model: 'm' })).toThrow(/API key/);
    expect(requireApiKey({ provider: 'kimi', model: 'm', apiKey: 'sk-test' })).toBe('sk-test');
  });
});

describe('evalReviewConfig', () => {
  const cfg = { provider: 'openai-compatible', model: 'gpt-4.1-mini', baseUrl: 'https://x/v1' };

  it('toggles experimental, overrides provider/model/baseUrl, omits baseUrl when unset', () => {
    const off = evalReviewConfig(cfg, false);
    expect(off.experimental).toBe(false);
    expect(off.provider).toBe('openai-compatible');
    expect(off.model).toBe('gpt-4.1-mini');
    expect(off.baseUrl).toBe('https://x/v1');

    const on = evalReviewConfig(cfg, true);
    expect(on.experimental).toBe(true);

    const noBase = evalReviewConfig({ provider: 'kimi', model: 'm' }, false);
    expect(noBase.baseUrl).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Prompt reports / formatting

describe('buildPromptReport', () => {
  it('is keyless, measures real prompts, and flags Concision Rules by experimental', () => {
    const baseline = buildPromptReport(evalReviewConfig({ provider: 'kimi', model: 'm' }, false), CASE_CONTEXT);
    expect(baseline.hasConcisionRules).toBe(false);
    expect(baseline.systemChars).toBeGreaterThan(0);
    expect(baseline.estimatedTokens).toBeGreaterThan(0);
    expect(baseline.totalChars).toBe(baseline.systemChars + baseline.userChars);

    const experimental = buildPromptReport(
      evalReviewConfig({ provider: 'kimi', model: 'm' }, true),
      CASE_CONTEXT,
    );
    expect(experimental.hasConcisionRules).toBe(true);
    expect(experimental.systemChars).toBeGreaterThan(baseline.systemChars);
  });
});

describe('formatDelta', () => {
  const base: RunStats = {
    experimental: false,
    durationMs: 8000,
    input: 1000,
    output: 500,
    cached: 0,
    calls: 1,
    score: 70,
    findings: 3,
  };
  const exp: RunStats = { ...base, durationMs: 9200, input: 1100, output: 455, findings: 2 };

  it('reports signed token/duration/finding deltas', () => {
    const delta = formatDelta(base, exp);
    expect(delta).toContain('duration   +1.20s');
    expect(delta).toContain('input      +100 tokens');
    expect(delta).toContain('output     -45 tokens');
    expect(delta).toContain('findings   -1');
  });
});

describe('word / numeric helpers', () => {
  it('counts words and computes mean/median with empty-list vacuous 0', () => {
    expect(wordCount('')).toBe(0);
    expect(wordCount('   ')).toBe(0);
    expect(wordCount('a b c')).toBe(3);
    expect(wordCount('  a  b\tc\n d  ')).toBe(4);
    expect(mean([])).toBe(0);
    expect(mean([1, 2, 3])).toBe(2);
    expect(median([])).toBe(0);
    expect(median([5])).toBe(5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

// ---------------------------------------------------------------------------
// redactSecrets / gitRepoMetadata / buildSuitePromptMetadata

describe('redactSecrets', () => {
  it('scrubs API-key-shaped strings and URL userinfo, leaving plain text untouched', () => {
    expect(redactSecrets('key sk-live-ABCDEF1234567890 here')).toBe(
      'key [REDACTED_API_KEY] here',
    );
    expect(redactSecrets('https://user:pass@api.example.com/v1')).toBe(
      'https://[REDACTED]@api.example.com/v1',
    );
    expect(redactSecrets('sk-abc')).toBe('[REDACTED_API_KEY]');
    expect(redactSecrets('plain connection error')).toBe('plain connection error');
  });
});

describe('gitRepoMetadata', () => {
  it('returns a commit and a dirty flag in a git repo; nulls on failure', () => {
    const meta = gitRepoMetadata(process.cwd());
    expect(meta.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof meta.dirty).toBe('boolean');
    expect(gitRepoMetadata('/definitely/not/a/real/dir')).toEqual({
      commit: null,
      dirty: null,
    });
  });
});

describe('buildSuitePromptMetadata', () => {
  const cases = ['clean-01', 'local-01'].map((id) => getCaseById(id));

  it('is deterministic, differs between variants, aggregates chars/tokens, handles empty', () => {
    const a1 = buildSuitePromptMetadata(cases, CFG, false);
    const a2 = buildSuitePromptMetadata(cases, CFG, false);
    const b = buildSuitePromptMetadata(cases, CFG, true);
    expect(a1).toEqual(a2);
    expect(a1.metadata.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(b.metadata.sha256).not.toBe(a1.metadata.sha256);

    const info = buildSuitePromptMetadata(cases, CFG, false);
    expect(info.stats.cases).toBe(2);
    expect(info.stats.totalChars).toBeGreaterThan(0);
    expect(info.stats.minChars).toBeGreaterThan(0);
    expect(info.stats.minChars).toBeLessThanOrEqual(info.stats.maxChars);
    expect(info.stats.maxChars).toBeLessThanOrEqual(info.stats.totalChars);
    expect(info.stats.totalEstimatedTokens).toBeGreaterThan(0);
    expect(info.metadata.chars).toBe(info.stats.totalChars);

    // Empty selection must not divide by zero.
    const empty = buildSuitePromptMetadata([], CFG, false);
    expect(empty.stats).toEqual({
      cases: 0,
      minChars: 0,
      maxChars: 0,
      totalChars: 0,
      totalEstimatedTokens: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// captureFromResponse / buildRunMetrics

describe('captureFromResponse', () => {
  it('extracts metadata without storing raw content; reports parse failure on garbage', () => {
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

    const garbage = captureFromResponse(response('not json at all', { input: 1, output: 0 }), 1, 5);
    expect(garbage.parseSuccess).toBe(false);
    expect(garbage.topLevelKeys).toEqual([]);
    expect(garbage.generatedFindings).toBe(0);
  });
});

describe('buildRunMetrics', () => {
  it('records token totals, retention, contract completeness; cached is never double-counted', () => {
    const m = buildMetrics(false);
    expect(m.variant).toBe('baseline');
    expect(m.totalTokens).toBe(150);
    expect(m.calls).toBe(1);
    expect(m.generatedFindings).toBe(1);
    expect(m.retainedFindings).toBe(1);
    expect(m.retentionRate).toBe(1);
    expect(m.contractComplete).toBe(true);
    expect(m.walkthroughCoverage).toBe(1); // both changed files covered
    expect(m.score).toBe(82);

    // Regression: total tokens = input + output (input already includes cached).
    const cached = buildRunMetrics({
      experimental: false, pairIndex: 0, runIndex: 0, durationMs: 200,
      tokens: { input: 100, output: 50, cached: 20 },
      calls: 1,
      captures: [captureFromResponse(response(FULL_JSON, { cached: 20 }), 1, 100)],
      result: GOOD_RESULT, changedFilePaths: CHANGED_PATHS,
    });
    expect(cached.inputTokens).toBe(100);
    expect(cached.cachedTokens).toBe(20);
    expect(cached.totalTokens).toBe(150);
    expect(cached.totalTokens).not.toBe(170);
  });

  it('measures walkthrough coverage by unique paths and classifies zero findings', () => {
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
    const m = buildMetrics(false, { response: dupUnknown });
    expect(m.walkthroughCoverage).toBe(0.5);
    expect(m.generatedFindings).toBe(0);
    expect(m.zeroFindingsKind).toBe('contract-incomplete'); // walkthrough incomplete

    // Genuine: parsed, contract complete, narrative + walkthrough complete.
    const genuine = buildMetrics(false, { response: ZERO_JSON });
    expect(genuine.zeroFindingsKind).toBe('genuine');
    expect(genuine.conciseCompliant).toBe(true);

    // Parser fallback: response did not parse.
    expect(buildMetrics(false, { response: 'garbage' }).zeroFindingsKind).toBe('parser-fallback');

    // Contract-incomplete: parsed but missing required top-level keys.
    const partial = buildMetrics(false, { response: JSON.stringify({ summary: 'partial review', findings: [] }) });
    expect(partial.parseSuccess).toBe(true);
    expect(partial.contractComplete).toBe(false);
    expect(partial.zeroFindingsKind).toBe('contract-incomplete');

    // Contract keys present but narrative incomplete (empty intent).
    const emptyIntent = buildMetrics(false, {
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
    const compliant = buildMetrics(false);
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
    const over = buildMetrics(true, { response: verbose });
    expect(over.limitsMet).toBe(false);
    expect(over.conciseCompliant).toBe(false);

    // Within limits but incomplete (walkthrough covers 1 of 2 changed files).
    const incomplete = JSON.stringify({
      intent: 'Adds a cache.',
      summary: 'Fine.',
      score: 80,
      walkthrough: [{ path: 'src/utils/retry.ts', summary: 'ok' }],
      findings: [],
    });
    const shortButIncomplete = buildMetrics(false, { response: incomplete });
    expect(shortButIncomplete.limitsMet).toBe(true);
    expect(shortButIncomplete.walkthroughCoverage).toBe(0.5);
    expect(shortButIncomplete.conciseCompliant).toBe(false);
  });
});

describe('aggregation and deltas', () => {
  it('aggregates rates and mean/median per variant; successRate is strict usable', () => {
    const baseline = [
      buildMetrics(false, { durationMs: 8000, outputTokens: 500, retainedFindings: 3, score: 70 }),
      buildMetrics(false, { durationMs: 12000, outputTokens: 700, retainedFindings: 5, score: 74 }),
    ];
    const experimental = [buildMetrics(true, { durationMs: 6000, outputTokens: 400, retainedFindings: 3, score: 78 })];

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

    // Mixed valid/incomplete set: parsed but contract-incomplete is not usable.
    const incomplete = buildMetrics(false, { response: JSON.stringify({ summary: 'partial', findings: [] }) });
    const mixed = aggregateRuns([buildMetrics(false), incomplete]);
    expect(mixed.baseline.parseRate).toBe(1);
    expect(mixed.baseline.contractRate).toBe(0.5);
    expect(mixed.baseline.successRate).toBe(0.5);
  });

  it('output savings is positive when experimental is lower, negative when higher, null on zero baseline', () => {
    const base = aggregateRuns([buildMetrics(false, { outputTokens: 500 })]).baseline;
    const exp = aggregateRuns([buildMetrics(true, { outputTokens: 400 })]).experimental;
    const delta = computeDelta(base, exp);
    expect(delta.outputSavingsPct).toBeCloseTo(20, 5); // (500-400)/500
    expect(delta.outputDeltaTokens).toBe(-100);
    expect(delta.scoreDelta).toBe(0);

    const wasteful = aggregateRuns([buildMetrics(true, { outputTokens: 600 })]).experimental;
    expect(computeDelta(base, wasteful).outputSavingsPct).toBeCloseTo(-20, 5);

    const zeroBase = aggregateRuns([buildMetrics(false, { outputTokens: 0 })]).baseline;
    expect(computeDelta(zeroBase, exp).outputSavingsPct).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// executePlan

describe('executePlan', () => {
  it('runs every plan entry in order and completes all calls (no timers left)', async () => {
    vi.useFakeTimers();
    const plan = buildEvalPlanFromEnv(env({ EVAL_CASES: 'clean-01, local-01' }));
    const { attempts, onAttemptCalls, pairInfo } = await run(plan, {
      providerFactory: successFactory(plan),
    });

    expect(attempts).toHaveLength(4);
    expect(attempts.every((a) => a.status === 'completed')).toBe(true);
    expect(onAttemptCalls).toEqual([1, 2, 3, 4]);
    // Heartbeats and any per-call timers must be cleaned up.
    expect(vi.getTimerCount()).toBe(0);

    // Planner order preserved: entries[0] is round 0, baseline.
    expect(attempts[0].identity.variant).toBe('baseline');
    expect(attempts[1].identity.variant).toBe('experimental');
    expect(attempts[0].identity.caseId).toBe('clean-01');

    // Pair progress: both pairs complete (AB order round 0).
    expect(pairInfo).toHaveLength(2);
    expect(pairInfo[0]).toMatchObject({ pairId: 'clean-01@r0', complete: true, completed: 2, failed: 0 });
    expect(pairInfo[1]).toMatchObject({ pairId: 'local-01@r0', complete: true, completed: 2, failed: 0 });
  });

  it('records real parse/contract/quality metrics against the case gold', async () => {
    const plan = buildEvalPlanFromEnv(env({ EVAL_CASES: 'clean-01, local-01' }));
    const { attempts, cases } = await run(plan, { providerFactory: successFactory(plan) });
    const result = buildBenchmarkResult({ plan, cases, attempts });

    expect(result.execution.completed).toBe(4);
    expect(result.execution.failed).toBe(0);

    const local = attempts.find((a) => a.case.caseId === 'local-01') as CompletedAttempt;
    expect(local.metrics.parseSuccess).toBe(true);
    expect(local.metrics.contractComplete).toBe(true);
    expect(local.metrics.generatedFindings).toBe(2);
    expect(local.quality.postGate.tp).toBe(2);
    expect(local.quality.postGate.fn).toBe(0);
    expect(local.quality.postGate.f1).toBe(1);

    const clean = attempts.find((a) => a.case.caseId === 'clean-01') as CompletedAttempt;
    expect(clean.quality.postGate.fp).toBe(0);
    expect(clean.quality.postGate.clean).toBe(true);

    expect(result.pairs.completePairs).toBe(2);
  });

  it('tolerates individual failures: sanitized attempts, continuation, partial pairs', async () => {
    const plan = buildEvalPlanFromEnv(env({ EVAL_CASES: 'clean-01, local-01' }));
    // Plan order: clean-01 base(0), clean-01 exp(1), local-01 base(2), local-01 exp(3).
    // Fail local-01 baseline (call 3) -> local-01 pair partial, clean-01 pair complete.
    const { attempts, pairInfo } = await run(plan, { providerFactory: mixedFactory(plan, 2) });
    const result = buildBenchmarkResult({ plan, cases: plan.config.caseIds.map((id) => getCaseById(id)), attempts });

    expect(attempts).toHaveLength(4); // plan continued past the failure
    expect(result.execution.completed).toBe(3);
    expect(result.execution.failed).toBe(1);

    const failed = attempts.find((a) => a.status === 'failed')!;
    expect(failed.status).toBe('failed');
    if (failed.status === 'failed') {
      expect(failed.error).toEqual({ code: 'ECONNRESET', message: 'connection reset' });
      // Never the raw Error object or stack.
      expect(Object.keys(failed.error)).toEqual(['code', 'message']);
      expect(JSON.stringify(failed.error)).not.toContain('net.js');
      expect(JSON.stringify(failed.error)).not.toContain('at ');
      expect(failed.identity.caseId).toBe('local-01');
      expect(failed.identity.variant).toBe('baseline');
    }

    expect(pairInfo).toHaveLength(2);
    expect(pairInfo[0]).toMatchObject({ pairId: 'clean-01@r0', complete: true });
    expect(pairInfo[1]).toMatchObject({ pairId: 'local-01@r0', complete: false, completed: 1, failed: 1 });

    expect(result.pairs.completePairs).toBe(1);
    expect(result.pairs.incompletePairs).toBe(1);
  });

  it('redacts secrets from failure messages before they reach attempts or artifacts', async () => {
    const SECRET = 'sk-live-ABCDEF1234567890';
    const plan = buildEvalPlanFromEnv(env({ EVAL_CASES: 'clean-01' }));
    const raw = new Error(`rate limited with ${SECRET}`);
    raw.name = 'RateLimitError';
    const { attempts } = await run(plan, { providerFactory: failingFactory(raw), apiKey: SECRET });
    const failed = attempts[0] as Attempt & { status: 'failed' };
    expect(failed.status).toBe('failed');
    if (failed.status === 'failed') {
      expect(failed.error.message).toBe(`rate limited with [REDACTED_API_KEY]`);
      expect(JSON.stringify(attempts)).not.toContain(SECRET);
    }

    // Full artifact (all attempts failed) must still pass the secret-safety gate.
    const cases = [getCaseById('clean-01')];
    const artifact = buildBenchmarkArtifact({
      timestamp: '2026-08-04T12:00:00.000Z',
      benchmark: { suiteId: 's', suiteVersion: 1 },
      repository: { commit: null, dirty: null },
      provider: 'kimi',
      model: 'kimi-for-coding',
      prompt: {
        baseline: buildSuitePromptMetadata(cases, CFG, false).metadata,
        experimental: buildSuitePromptMetadata(cases, CFG, true).metadata,
      },
      retries: 0,
      timeoutMs: 120_000,
      plan,
      cases,
      attempts,
    });
    expect(() => assertArtifactSafe(artifact, { secret: SECRET })).not.toThrow();
    expect(JSON.stringify(artifact)).not.toContain(SECRET);
  });

  it('all-failed plan still yields a valid benchmark result; does not mutate the plan', async () => {
    const plan = buildEvalPlanFromEnv(env({ EVAL_CASES: 'clean-01' }));
    const a = await run(plan, { providerFactory: failingFactory('provider timeout') });
    const result = buildBenchmarkResult({ plan, cases: a.cases, attempts: a.attempts });

    expect(result.execution.completed).toBe(0);
    expect(result.execution.failed).toBe(2);
    expect(result.reliability.baseline).toBeNull();
    expect(result.quality.postGate.baseline).toBeNull();
    expect(result.pairs.aggregate).toBeNull();
    expect(result.regressions[0].status).toBe('insufficient-data');

    // No attempt leakage across calls, plan untouched.
    const b = await run(plan, { providerFactory: successFactory(plan) });
    expect(a.attempts).toHaveLength(2);
    expect(b.attempts).toHaveLength(2);
    expect(plan.entries).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// eval-live main (dry run)

describe('eval-live main (dry run)', () => {
  it('prints the smoke plan with zero provider/artifact side effects', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const before = resultFileCount();

    await main(['--dry-run']); // no API key needed

    const output = log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('clean-01, local-01, security-01');
    expect(output).toContain('fiscalcr-eval-v2'); // default seed
    expect(output).toContain('6 calls (3 cases × 1 × 2 variants)');
    expect(output).toContain('Budget: 6 planned calls');
    expect(output).toContain('Prompts (baseline)');
    expect(output).toContain('Prompts (experimental)');
    expect(output).toContain('no network calls, no artifact written');

    expect(mockedCreate).not.toHaveBeenCalled();
    expect(resultFileCount()).toBe(before);
    log.mockRestore();
  });

  it('shows the exceeded budget guard without failing; rejects an invalid suite', async () => {
    vi.stubEnv('EVAL_SUITE', 'full');
    vi.stubEnv('EVAL_MAX_CALLS', '4');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const before = resultFileCount();

    await expect(main(['--dry-run'])).resolves.toBeUndefined();

    const output = log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('20 calls (10 cases × 1 × 2 variants)');
    expect(output).toContain('EXCEEDS EVAL_MAX_CALLS=4');
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(resultFileCount()).toBe(before);
    log.mockRestore();

    // Invalid suite is a config failure (nonzero path, not silent).
    vi.stubEnv('EVAL_SUITE', 'bogus');
    await expect(main(['--dry-run'])).rejects.toThrow(/Invalid EVAL_SUITE/);
    expect(mockedCreate).not.toHaveBeenCalled();
  });
});
