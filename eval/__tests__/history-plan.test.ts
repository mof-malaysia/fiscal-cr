import { describe, expect, it, vi } from 'vitest';
import type { BenchmarkCase } from '../quality.js';

// The loader reads the gitignored cache; stand in small fast-path contexts so
// the plan can be checked without fetching anything.
vi.mock('../history/loader.js', () => ({
  loadHistoryCases: (ids: string[]): BenchmarkCase[] =>
    ids.map((id) => ({
      id,
      version: 1,
      label: id,
      tags: ['history'],
      expectedIssues: [],
      context: {
        owner: 'o',
        repo: 'r',
        pullNumber: 1,
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        title: 't',
        body: '',
        diff: '',
        changedFiles: [{ filename: 'a.ts', status: 'added', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+x' }],
        fileContents: new Map([['a.ts', 'x\n']]),
      },
    })),
}));

const { buildEvalPlan, checkCallBudget, resolveEvalSelection, DEFAULT_MAX_CALLS } = await import('../plan.js');
const { readManifest } = await import('../history/manifest.js');

const env = (o: Record<string, string>): NodeJS.ProcessEnv => o as NodeJS.ProcessEnv;

describe('EVAL_SUITE=history', () => {
  const ids = readManifest().cases.map((c) => c.id);

  it('selects every manifest case and plans one provider call per fast-path attempt', () => {
    const selection = resolveEvalSelection(env({ EVAL_SUITE: 'history' }));
    expect(selection.suite).toBe('history');
    expect(selection.caseIds).toEqual(ids);
    const plan = buildEvalPlan(selection);
    expect(plan.plannedAttempts).toBe(ids.length * 2);
    expect(plan.entries.every((e) => e.route === 'fast-path' && e.maxProviderCalls === 1)).toBe(true);
    expect(plan.plannedProviderCallsUpperBound).toBe(ids.length * 2);
  });

  it('keeps the default call guard, so a live run needs an explicit EVAL_MAX_CALLS', () => {
    const plan = buildEvalPlan(resolveEvalSelection(env({ EVAL_SUITE: 'history' })));
    expect(plan.config.maxCalls).toBe(DEFAULT_MAX_CALLS);
    expect(checkCallBudget(plan).exceeded).toBe(ids.length * 2 > DEFAULT_MAX_CALLS);
  });

  it('lets EVAL_CASES pick history ids and rejects synthetic or unknown ones', () => {
    const selection = resolveEvalSelection(env({ EVAL_SUITE: 'history', EVAL_CASES: `${ids[1]}, ${ids[0]}` }));
    expect(selection.caseIds).toEqual([ids[1], ids[0]]);
    expect(selection.explicit).toBe(true);
    expect(() => resolveEvalSelection(env({ EVAL_SUITE: 'history', EVAL_CASES: 'clean-01' }))).toThrow(/Unknown eval case/);
  });

  it('leaves the synthetic suites untouched', () => {
    expect(resolveEvalSelection(env({})).caseIds).toEqual(['clean-01', 'local-01', 'security-01']);
    expect(() => resolveEvalSelection(env({ EVAL_CASES: ids[0] }))).toThrow(/Unknown eval case/);
  });
});
