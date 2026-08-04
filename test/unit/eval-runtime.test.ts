import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LLMCompletionResponse, LLMProvider } from '../../src/providers/interface.js';
import {
  buildEvalPlanFromEnv,
  type EvalPlan,
} from '../../scripts/eval-plan.js';
import { getCaseById, type BenchmarkCase } from '../../scripts/eval-cases.js';
import {
  buildBenchmarkArtifact,
  assertArtifactSafe,
  buildBenchmarkResult,
  type Attempt,
  type CompletedAttempt,
} from '../../scripts/eval-benchmark.js';
import {
  buildSuitePromptMetadata,
  executePlan,
  gitRepoMetadata,
  redactSecrets,
} from '../../scripts/eval-runtime.js';

// ---------------------------------------------------------------------------
// Helpers

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

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// redactSecrets

describe('redactSecrets', () => {
  it('scrubs API-key-shaped strings and URL userinfo', () => {
    expect(redactSecrets('key sk-live-ABCDEF1234567890 here')).toBe(
      'key [REDACTED_API_KEY] here',
    );
    expect(redactSecrets('https://user:pass@api.example.com/v1')).toBe(
      'https://[REDACTED]@api.example.com/v1',
    );
    expect(redactSecrets('sk-abc')).toBe('[REDACTED_API_KEY]');
  });

  it('leaves ordinary text untouched', () => {
    expect(redactSecrets('plain connection error')).toBe('plain connection error');
  });
});

// ---------------------------------------------------------------------------
// gitRepoMetadata

describe('gitRepoMetadata', () => {
  it('returns a commit and a dirty flag in a git repo', () => {
    const meta = gitRepoMetadata(process.cwd());
    expect(meta.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof meta.dirty).toBe('boolean');
  });

  it('returns nulls on failure (no shell interpolation, no crash)', () => {
    expect(gitRepoMetadata('/definitely/not/a/real/dir')).toEqual({
      commit: null,
      dirty: null,
    });
  });
});

// ---------------------------------------------------------------------------
// buildSuitePromptMetadata

describe('buildSuitePromptMetadata', () => {
  const cases = ['clean-01', 'local-01'].map((id) => getCaseById(id));

  it('is deterministic and differs between variants', () => {
    const a1 = buildSuitePromptMetadata(cases, CFG, false);
    const a2 = buildSuitePromptMetadata(cases, CFG, false);
    const b = buildSuitePromptMetadata(cases, CFG, true);
    expect(a1).toEqual(a2);
    expect(a1.metadata.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(b.metadata.sha256).not.toBe(a1.metadata.sha256);
  });

  it('aggregates exact chars/tokens across all selected cases in order', () => {
    const info = buildSuitePromptMetadata(cases, CFG, false);
    expect(info.stats.cases).toBe(2);
    expect(info.stats.totalChars).toBeGreaterThan(0);
    expect(info.stats.minChars).toBeGreaterThan(0);
    expect(info.stats.minChars).toBeLessThanOrEqual(info.stats.maxChars);
    expect(info.stats.maxChars).toBeLessThanOrEqual(info.stats.totalChars);
    expect(info.stats.totalEstimatedTokens).toBeGreaterThan(0);
    expect(info.metadata.chars).toBe(info.stats.totalChars);
  });

  it('handles an empty selection without dividing by zero', () => {
    const info = buildSuitePromptMetadata([], CFG, false);
    expect(info.stats).toEqual({
      cases: 0,
      minChars: 0,
      maxChars: 0,
      totalChars: 0,
      totalEstimatedTokens: 0,
    });
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

  it('all-failed plan still yields a valid benchmark result with unavailable aggregates', async () => {
    const plan = buildEvalPlanFromEnv(env({ EVAL_CASES: 'clean-01' }));
    const { attempts, cases } = await run(plan, { providerFactory: failingFactory('provider timeout') });
    const result = buildBenchmarkResult({ plan, cases, attempts });

    expect(result.execution.completed).toBe(0);
    expect(result.execution.failed).toBe(2);
    expect(result.reliability.baseline).toBeNull();
    expect(result.quality.postGate.baseline).toBeNull();
    expect(result.pairs.aggregate).toBeNull();
    expect(result.regressions[0].status).toBe('insufficient-data');
  });

  it('does not mutate the plan or leak attempts across calls', async () => {
    const plan = buildEvalPlanFromEnv(env({ EVAL_CASES: 'clean-01' }));
    const a = await run(plan, { providerFactory: successFactory(plan) });
    const b = await run(plan, { providerFactory: successFactory(plan) });
    expect(a.attempts).toHaveLength(2);
    expect(b.attempts).toHaveLength(2);
    expect(plan.entries).toHaveLength(2);
  });
});
