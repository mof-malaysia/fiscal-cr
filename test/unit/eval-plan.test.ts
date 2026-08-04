import { describe, expect, it } from 'vitest';
import {
  DECISION_RUN_CALLS,
  DEFAULT_EVAL_SEED,
  DEFAULT_MAX_CALLS,
  assertCallBudget,
  buildEvalPlan,
  buildEvalPlanFromEnv,
  checkCallBudget,
  groupPlanPairs,
  pairIdOf,
  resolveEvalSelection,
  rotateCases,
  roundRotationOffset,
  variantOrderForCaseRound,
  type EvalPlan,
} from '../../scripts/eval-plan.js';
import { getFullCaseIds, getSmokeCaseIds } from '../../scripts/eval-cases.js';

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

/** Per-round entry list as a stable string, for cross-seed comparison. */
function roundOrdersKey(plan: EvalPlan): string[] {
  const rounds = new Map<number, string[]>();
  for (const e of plan.entries) {
    const list = rounds.get(e.roundIndex) ?? [];
    list.push(`${e.caseId}:${e.variant}`);
    rounds.set(e.roundIndex, list);
  }
  return [...rounds.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, list]) => list.join(','));
}

/** Variant sequence per round for one case (execution order). */
function variantsOfCase(plan: EvalPlan, caseId: string): string[][] {
  const byRound = new Map<number, string[]>();
  for (const e of plan.entries) {
    if (e.caseId !== caseId) continue;
    const list = byRound.get(e.roundIndex) ?? [];
    list.push(e.variant);
    byRound.set(e.roundIndex, list);
  }
  return [...byRound.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, list]) => list);
}

// ---------------------------------------------------------------------------

describe('resolveEvalSelection env semantics', () => {
  it('defaults to smoke: 3 cases, runs 1, stable seed, max calls 20', () => {
    const sel = resolveEvalSelection(env());
    expect(sel.suite).toBe('smoke');
    expect(sel.explicit).toBe(false);
    expect(sel.caseIds).toEqual(getSmokeCaseIds());
    expect(sel.caseIds).toHaveLength(3);
    expect(sel.runs).toBe(1);
    expect(sel.seed).toBe(DEFAULT_EVAL_SEED);
    expect(sel.maxCalls).toBe(DEFAULT_MAX_CALLS);
    expect(sel.cases.map((c) => c.id)).toEqual(sel.caseIds);
  });

  it('resolves full suite to all 10 cases', () => {
    const sel = resolveEvalSelection(env({ EVAL_SUITE: 'full' }));
    expect(sel.suite).toBe('full');
    expect(sel.caseIds).toEqual(getFullCaseIds());
    expect(sel.caseIds).toHaveLength(10);
  });

  it('explicit EVAL_CASES overrides the suite (whitespace-tolerant)', () => {
    const sel = resolveEvalSelection(
      env({ EVAL_SUITE: 'full', EVAL_CASES: ' clean-01, security-01 ' }),
    );
    expect(sel.explicit).toBe(true);
    expect(sel.caseIds).toEqual(['clean-01', 'security-01']);
    expect(sel.suite).toBe('full'); // suite still reported, but unused
  });

  it('rejects an invalid suite', () => {
    expect(() => resolveEvalSelection(env({ EVAL_SUITE: 'banana' }))).toThrow(
      /invalid eval_suite/i,
    );
    // Suite is validated even when EVAL_CASES would override it.
    expect(() =>
      resolveEvalSelection(env({ EVAL_SUITE: 'banana', EVAL_CASES: 'clean-01' })),
    ).toThrow(/invalid eval_suite/i);
  });

  it('rejects unknown, empty, and duplicate explicit case ids', () => {
    expect(() => resolveEvalSelection(env({ EVAL_CASES: 'nope-99' }))).toThrow(/nope-99/);
    expect(() =>
      resolveEvalSelection(env({ EVAL_CASES: 'clean-01, nope-99' })),
    ).toThrow(/unknown eval case id\(s\): nope-99/i);
    expect(() => resolveEvalSelection(env({ EVAL_CASES: '' }))).toThrow(/no eval case ids/i);
    expect(() => resolveEvalSelection(env({ EVAL_CASES: '   ' }))).toThrow(/no eval case ids/i);
    expect(() =>
      resolveEvalSelection(env({ EVAL_CASES: 'clean-01, clean-01' })),
    ).toThrow(/duplicate eval case id\(s\)/i);
    expect(() =>
      resolveEvalSelection(env({ EVAL_CASES: 'clean-01, clean-01, security-01' })),
    ).toThrow(/duplicate eval case id\(s\)/i);
  });

  it('rejects invalid EVAL_RUNS / EVAL_MAX_CALLS numbers', () => {
    for (const value of ['0', '-1', 'abc', '1.5']) {
      expect(() => resolveEvalSelection(env({ EVAL_RUNS: value }))).toThrow(
        /invalid eval_runs/i,
      );
      expect(() => resolveEvalSelection(env({ EVAL_MAX_CALLS: value }))).toThrow(
        /invalid eval_max_calls/i,
      );
    }
    // Blank numeric vars are treated as unset (defaults), matching the legacy
    // harness behavior for EVAL_RUNS.
    expect(resolveEvalSelection(env({ EVAL_RUNS: '  ' })).runs).toBe(1);
    expect(resolveEvalSelection(env({ EVAL_MAX_CALLS: '  ' })).maxCalls).toBe(
      DEFAULT_MAX_CALLS,
    );
    expect(resolveEvalSelection(env({ EVAL_RUNS: '4' })).runs).toBe(4);
    expect(resolveEvalSelection(env({ EVAL_MAX_CALLS: '80' })).maxCalls).toBe(80);
  });

  it('rejects an empty EVAL_SEED but accepts a custom one', () => {
    expect(() => resolveEvalSelection(env({ EVAL_SEED: '' }))).toThrow(/eval_seed/i);
    expect(() => resolveEvalSelection(env({ EVAL_SEED: '   ' }))).toThrow(/eval_seed/i);
    expect(resolveEvalSelection(env({ EVAL_SEED: 'my-seed' })).seed).toBe('my-seed');
  });
});

// ---------------------------------------------------------------------------

describe('buildEvalPlan schedule', () => {
  it('smoke default: 3 cases, 6 planned calls, valid entry bookkeeping', () => {
    const plan = buildEvalPlanFromEnv(env());
    expect(plan.plannedCalls).toBe(6);
    expect(plan.entries).toHaveLength(6);
    expect(plan.config.caseIds).toEqual(getSmokeCaseIds());
    expect(plan.config.runs).toBe(1);
    expect(plan.config.seed).toBe(DEFAULT_EVAL_SEED);
    for (let i = 0; i < plan.entries.length; i++) {
      expect(plan.entries[i].globalCallIndex).toBe(i);
    }
    // Each case appears exactly twice (baseline + experimental) in round 0.
    for (const id of getSmokeCaseIds()) {
      const entries = plan.entries.filter((e) => e.caseId === id);
      expect(entries).toHaveLength(2);
      expect(new Set(entries.map((e) => e.variant))).toEqual(
        new Set(['baseline', 'experimental']),
      );
      expect(entries.map((e) => e.pairId)).toEqual([`${id}@r0`, `${id}@r0`]);
    }
  });

  it('full suite: 10 cases, 20 planned calls', () => {
    const plan = buildEvalPlanFromEnv(env({ EVAL_SUITE: 'full' }));
    expect(plan.plannedCalls).toBe(20);
    expect(plan.entries).toHaveLength(20);
    expect(plan.config.suite).toBe('full');
  });

  it('planned calls scale with runs (cases * runs * 2)', () => {
    expect(buildEvalPlanFromEnv(env({ EVAL_RUNS: '3' })).plannedCalls).toBe(18);
    expect(buildEvalPlanFromEnv(env({ EVAL_RUNS: '4' })).plannedCalls).toBe(24);
    expect(buildEvalPlanFromEnv(env({ EVAL_SUITE: 'full', EVAL_RUNS: '4' })).plannedCalls).toBe(
      80,
    );
    expect(buildEvalPlanFromEnv(env({ EVAL_SUITE: 'full', EVAL_RUNS: '1' })).plannedCalls).toBe(
      20,
    );
    expect(
      buildEvalPlanFromEnv(env({ EVAL_CASES: 'clean-01, mixed-01', EVAL_RUNS: '4' }))
        .plannedCalls,
    ).toBe(16);
  });

  it('round-interleaves cases: every case once per round, rounds in call order', () => {
    const plan = buildEvalPlanFromEnv(env({ EVAL_SUITE: 'full', EVAL_RUNS: '3' }));
    const full = new Set(getFullCaseIds());
    let cursor = 0;
    for (let roundIndex = 0; roundIndex < 3; roundIndex++) {
      const roundEntries = plan.entries.filter((e) => e.roundIndex === roundIndex);
      expect(roundEntries).toHaveLength(20);
      expect(new Set(roundEntries.map((e) => e.caseId))).toEqual(full);
      // Variants are adjacent: call pairs [2*c, 2*c+1] share a case+pairId.
      for (let i = 0; i < roundEntries.length; i += 2) {
        expect(roundEntries[i].pairId).toBe(roundEntries[i + 1].pairId);
        expect(roundEntries[i].caseId).toBe(roundEntries[i + 1].caseId);
        expect(roundEntries[i].variant).not.toBe(roundEntries[i + 1].variant);
      }
      // Global call order is round-major.
      for (const e of roundEntries) {
        expect(e.globalCallIndex).toBe(cursor);
        cursor += 1;
      }
    }
    expect(cursor).toBe(plan.plannedCalls);
  });

  it('follows AB/BA/BA/AB per case across rounds', () => {
    expect(variantOrderForCaseRound(0)).toEqual(['baseline', 'experimental']);
    expect(variantOrderForCaseRound(1)).toEqual(['experimental', 'baseline']);
    expect(variantOrderForCaseRound(2)).toEqual(['experimental', 'baseline']);
    expect(variantOrderForCaseRound(3)).toEqual(['baseline', 'experimental']);
    expect(variantOrderForCaseRound(4)).toEqual(['baseline', 'experimental']);
    expect(variantOrderForCaseRound(5)).toEqual(['experimental', 'baseline']);

    const plan = buildEvalPlanFromEnv(env({ EVAL_RUNS: '8' }));
    for (const id of getSmokeCaseIds()) {
      expect(variantsOfCase(plan, id)).toEqual([
        ['baseline', 'experimental'],
        ['experimental', 'baseline'],
        ['experimental', 'baseline'],
        ['baseline', 'experimental'],
        ['baseline', 'experimental'],
        ['experimental', 'baseline'],
        ['experimental', 'baseline'],
        ['baseline', 'experimental'],
      ]);
    }
  });

  it('preserves per-case balance: runs baseline + runs experimental each', () => {
    const plan = buildEvalPlanFromEnv(env({ EVAL_SUITE: 'full', EVAL_RUNS: '4' }));
    for (const id of getFullCaseIds()) {
      const entries = plan.entries.filter((e) => e.caseId === id);
      expect(entries).toHaveLength(8);
      expect(entries.filter((e) => e.variant === 'baseline')).toHaveLength(4);
      expect(entries.filter((e) => e.variant === 'experimental')).toHaveLength(4);
      // Pair ids are unique per (case, round).
      expect(new Set(entries.map((e) => e.pairId))).toHaveLength(4);
    }
  });

  it('is deterministic: same env => identical plan', () => {
    const a = buildEvalPlanFromEnv(env({ EVAL_SUITE: 'full', EVAL_RUNS: '3', EVAL_SEED: 'x' }));
    const b = buildEvalPlanFromEnv(env({ EVAL_SUITE: 'full', EVAL_RUNS: '3', EVAL_SEED: 'x' }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('different seeds vary case order while keeping balance', () => {
    const base = buildEvalPlanFromEnv(env({ EVAL_SUITE: 'full', EVAL_RUNS: '3', EVAL_SEED: 'alpha' }));
    const other = buildEvalPlanFromEnv(env({ EVAL_SUITE: 'full', EVAL_RUNS: '3', EVAL_SEED: 'bravo' }));
    // Same call count and same per-case variant balance either way.
    expect(base.plannedCalls).toBe(other.plannedCalls);
    expect(base.config.caseIds).toEqual(other.config.caseIds);
    expect(roundOrdersKey(base)).not.toEqual(roundOrdersKey(other));
    // Per-case balance preserved under the second seed.
    for (const id of getFullCaseIds()) {
      const entries = other.entries.filter((e) => e.caseId === id);
      expect(entries.filter((e) => e.variant === 'baseline')).toHaveLength(3);
      expect(entries.filter((e) => e.variant === 'experimental')).toHaveLength(3);
    }
  });

  it('rotation: round orders are cyclic rotations of the base order', () => {
    const base = getFullCaseIds();
    expect(rotateCases(base, 0)).toEqual(base);
    expect(rotateCases(base, 1)).toEqual([...base.slice(1), base[0]]);
    expect(rotateCases(base, 10)).toEqual(base); // full cycle
    expect(rotateCases(['only'], 3)).toEqual(['only']);

    const plan = buildEvalPlanFromEnv(env({ EVAL_SUITE: 'full', EVAL_RUNS: '2', EVAL_SEED: 'alpha' }));
    for (let r = 0; r < 2; r++) {
      const offset = roundRotationOffset('alpha', r, base.length);
      const expected = rotateCases(base, offset);
      const actual = plan.entries
        .filter((e) => e.roundIndex === r && !e.experimental)
        .map((e) => e.caseId);
      expect(actual).toEqual(expected);
    }
    // Deterministic offsets per (seed, round).
    expect(roundRotationOffset('alpha', 0, 10)).toBe(roundRotationOffset('alpha', 0, 10));
  });

  it('groupPlanPairs yields complete A/B pairs with stable pair ids', () => {
    const plan = buildEvalPlanFromEnv(env({ EVAL_SUITE: 'full', EVAL_RUNS: '2' }));
    const pairs = groupPlanPairs(plan);
    expect(pairs).toHaveLength(20); // 10 cases x 2 rounds
    for (const pair of pairs) {
      expect(pair.complete).toBe(true);
      expect(pair.baseline).toBeDefined();
      expect(pair.experimental).toBeDefined();
      expect(pair.order).toEqual(variantOrderForCaseRound(pair.roundIndex));
      expect(pair.pairId).toBe(pairIdOf(pair.caseId, pair.roundIndex));
      expect(pair.baseline!.variant).toBe('baseline');
      expect(pair.experimental!.variant).toBe('experimental');
    }
    const ids = new Set(pairs.map((p) => p.pairId));
    expect(ids.size).toBe(20);
  });
});

// ---------------------------------------------------------------------------

describe('call-budget guard', () => {
  it('reports exceeded without throwing (dry-mode path)', () => {
    const plan = buildEvalPlanFromEnv(env({ EVAL_RUNS: '10' })); // smoke: 60 calls
    expect(plan.plannedCalls).toBe(60);
    const check = checkCallBudget(plan);
    expect(check.exceeded).toBe(true);
    expect(check.planned).toBe(60);
    expect(check.max).toBe(DEFAULT_MAX_CALLS);
  });

  it('throws before network when exceeded (live-mode path)', () => {
    const plan = buildEvalPlanFromEnv(env({ EVAL_RUNS: '10' }));
    expect(() => assertCallBudget(plan)).toThrow(/evAL_max_calls=20/i);
    expect(() => assertCallBudget(plan)).toThrow(/EVAL_MAX_CALLS=60/);
    expect(() => assertCallBudget(plan)).toThrow(/10-case x 4-run decision run/i);
  });

  it('passes when within budget; explicit raise unlocks the 80-call decision run', () => {
    expect(() => assertCallBudget(buildEvalPlanFromEnv(env()))).not.toThrow(); // 6 <= 20
    expect(
      () => assertCallBudget(buildEvalPlanFromEnv(env({ EVAL_SUITE: 'full' }))), // 20 <= 20
    ).not.toThrow();
    const decision = buildEvalPlanFromEnv(
      env({ EVAL_SUITE: 'full', EVAL_RUNS: '4', EVAL_MAX_CALLS: '80' }),
    );
    expect(decision.plannedCalls).toBe(DECISION_RUN_CALLS);
    expect(() => assertCallBudget(decision)).not.toThrow();
    // Same plan under the default guard is blocked.
    expect(() => buildEvalPlanFromEnv(env({ EVAL_SUITE: 'full', EVAL_RUNS: '4' }))).toBeDefined();
    expect(() =>
      assertCallBudget(buildEvalPlanFromEnv(env({ EVAL_SUITE: 'full', EVAL_RUNS: '4' }))),
    ).toThrow(/EVAL_MAX_CALLS=20/);
  });

  it('explicit maxCalls override wins over the env default', () => {
    const plan = buildEvalPlanFromEnv(env({ EVAL_RUNS: '10', EVAL_MAX_CALLS: '100' }));
    expect(plan.config.maxCalls).toBe(100);
    expect(checkCallBudget(plan).exceeded).toBe(false);
    expect(() => assertCallBudget(plan)).not.toThrow();
  });
});
