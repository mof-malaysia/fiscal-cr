import { describe, expect, it } from 'vitest';
import {
  DECISION_RUN_CALLS,
  DEFAULT_EVAL_SEED,
  DEFAULT_MAX_CALLS,
  FULL_SUITE_MAX_CALLS,
  assertCallBudget,
  buildEvalPlanFromEnv,
  checkCallBudget,
  groupPlanPairs,
  pairIdOf,
  resolveEvalSelection,
  rotateCases,
  roundRotationOffset,
  variantOrderForCaseRound,
  type EvalPlan,
} from '../plan.js';
import { getFullCaseIds, getSmokeCaseIds } from '../cases.js';

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

  it('resolves full suite to all 11 cases; explicit EVAL_CASES overrides it', () => {
    const full = resolveEvalSelection(env({ EVAL_SUITE: 'full' }));
    expect(full.suite).toBe('full');
    expect(full.caseIds).toEqual(getFullCaseIds());
    expect(full.caseIds).toHaveLength(11);
    // Full suite (no EVAL_CASES override) defaults the guard to 40.
    expect(full.maxCalls).toBe(FULL_SUITE_MAX_CALLS);

    const explicit = resolveEvalSelection(
      env({ EVAL_SUITE: 'full', EVAL_CASES: ' clean-01, security-01 ' }),
    );
    expect(explicit.explicit).toBe(true);
    expect(explicit.caseIds).toEqual(['clean-01', 'security-01']);
    expect(explicit.suite).toBe('full'); // suite still reported, but unused
    // Focused (explicit EVAL_CASES) keeps the 20 default even under full.
    expect(explicit.maxCalls).toBe(DEFAULT_MAX_CALLS);
  });

  it('rejects invalid suite, case ids, runs, max calls, and seed', () => {
    expect(() => resolveEvalSelection(env({ EVAL_SUITE: 'banana' }))).toThrow(/invalid eval_suite/i);
    // Suite is validated even when EVAL_CASES would override it.
    expect(() =>
      resolveEvalSelection(env({ EVAL_SUITE: 'banana', EVAL_CASES: 'clean-01' })),
    ).toThrow(/invalid eval_suite/i);

    expect(() => resolveEvalSelection(env({ EVAL_CASES: 'nope-99' }))).toThrow(/nope-99/);
    expect(() => resolveEvalSelection(env({ EVAL_CASES: 'clean-01, nope-99' }))).toThrow(
      /unknown eval case id\(s\): nope-99/i,
    );
    expect(() => resolveEvalSelection(env({ EVAL_CASES: '' }))).toThrow(/no eval case ids/i);
    expect(() => resolveEvalSelection(env({ EVAL_CASES: 'clean-01, clean-01' }))).toThrow(
      /duplicate eval case id\(s\)/i,
    );

    for (const value of ['0', '-1', 'abc', '1.5']) {
      expect(() => resolveEvalSelection(env({ EVAL_RUNS: value }))).toThrow(/invalid eval_runs/i);
      expect(() => resolveEvalSelection(env({ EVAL_MAX_CALLS: value }))).toThrow(
        /invalid eval_max_calls/i,
      );
    }
    // Blank numeric vars are treated as unset (defaults).
    expect(resolveEvalSelection(env({ EVAL_RUNS: '  ' })).runs).toBe(1);
    expect(resolveEvalSelection(env({ EVAL_MAX_CALLS: '  ' })).maxCalls).toBe(DEFAULT_MAX_CALLS);
    expect(resolveEvalSelection(env({ EVAL_RUNS: '4' })).runs).toBe(4);
    expect(resolveEvalSelection(env({ EVAL_MAX_CALLS: '80' })).maxCalls).toBe(80);

    expect(() => resolveEvalSelection(env({ EVAL_SEED: '' }))).toThrow(/eval_seed/i);
    expect(resolveEvalSelection(env({ EVAL_SEED: 'my-seed' })).seed).toBe('my-seed');
  });
});

// ---------------------------------------------------------------------------

describe('buildEvalPlan schedule', () => {
  it('smoke default: 3 cases, 6 planned attempts; attempts scale with suite and runs', () => {
    const plan = buildEvalPlanFromEnv(env());
    expect(plan.plannedAttempts).toBe(6);
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

    // Planned attempts = cases * runs * 2.
    expect(buildEvalPlanFromEnv(env({ EVAL_SUITE: 'full' })).plannedAttempts).toBe(22);
    expect(buildEvalPlanFromEnv(env({ EVAL_SUITE: 'full' })).config.suite).toBe('full');
    expect(buildEvalPlanFromEnv(env({ EVAL_RUNS: '3' })).plannedAttempts).toBe(18);
    expect(buildEvalPlanFromEnv(env({ EVAL_SUITE: 'full', EVAL_RUNS: '4' })).plannedAttempts).toBe(88);
    expect(
      buildEvalPlanFromEnv(env({ EVAL_CASES: 'clean-01, mixed-01', EVAL_RUNS: '4' })).plannedAttempts,
    ).toBe(16);
  });

  it('routes each attempt and sums the provider-call upper bound', () => {
    // Smoke cases are all small → fast-path (1 provider call each).
    const smoke = buildEvalPlanFromEnv(env());
    expect(smoke.entries.every((e) => e.route === 'fast-path')).toBe(true);
    expect(smoke.entries.every((e) => e.maxProviderCalls === 1)).toBe(true);
    expect(smoke.plannedProviderCallsUpperBound).toBe(6);

    // Full suite: pipeline-01 is multi-pass (1 + maxGroups 8 + synthesis 1 = 10).
    const full = buildEvalPlanFromEnv(env({ EVAL_SUITE: 'full' }));
    const multi = full.entries.filter((e) => e.route === 'multi-pass');
    expect(multi).toHaveLength(2); // 2 variants of pipeline-01
    expect(multi.every((e) => e.maxProviderCalls === 10)).toBe(true);
    // 10 fast-path cases × 2 × 1 + pipeline-01 × 2 × 10 = 20 + 20 = 40.
    expect(full.plannedProviderCallsUpperBound).toBe(40);
  });

  it('round-interleaves cases: every case once per round, rounds in call order', () => {
    const plan = buildEvalPlanFromEnv(env({ EVAL_SUITE: 'full', EVAL_RUNS: '3' }));
    const full = new Set(getFullCaseIds());
    let cursor = 0;
    for (let roundIndex = 0; roundIndex < 3; roundIndex++) {
      const roundEntries = plan.entries.filter((e) => e.roundIndex === roundIndex);
      expect(roundEntries).toHaveLength(22);
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
    expect(cursor).toBe(plan.plannedAttempts);
  });

  it('follows deterministic balanced AB/BA pattern and preserves per-case balance', () => {
    expect(variantOrderForCaseRound(0)).toEqual(['baseline', 'experimental']);
    expect(variantOrderForCaseRound(1)).toEqual(['experimental', 'baseline']);
    expect(variantOrderForCaseRound(2)).toEqual(['experimental', 'baseline']);
    expect(variantOrderForCaseRound(3)).toEqual(['baseline', 'experimental']);

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
    // Per-case balance: runs baseline + runs experimental each.
    const full = buildEvalPlanFromEnv(env({ EVAL_SUITE: 'full', EVAL_RUNS: '4' }));
    for (const id of getFullCaseIds()) {
      const entries = full.entries.filter((e) => e.caseId === id);
      expect(entries).toHaveLength(8);
      expect(entries.filter((e) => e.variant === 'baseline')).toHaveLength(4);
      expect(entries.filter((e) => e.variant === 'experimental')).toHaveLength(4);
      expect(new Set(entries.map((e) => e.pairId))).toHaveLength(4);
    }
  });

  it('is deterministic: same env => identical plan; different seeds vary case order', () => {
    const a = buildEvalPlanFromEnv(env({ EVAL_SUITE: 'full', EVAL_RUNS: '3', EVAL_SEED: 'x' }));
    const b = buildEvalPlanFromEnv(env({ EVAL_SUITE: 'full', EVAL_RUNS: '3', EVAL_SEED: 'x' }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));

    const base = buildEvalPlanFromEnv(env({ EVAL_SUITE: 'full', EVAL_RUNS: '3', EVAL_SEED: 'alpha' }));
    const other = buildEvalPlanFromEnv(env({ EVAL_SUITE: 'full', EVAL_RUNS: '3', EVAL_SEED: 'bravo' }));
    expect(base.plannedAttempts).toBe(other.plannedAttempts);
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
    expect(rotateCases(base, 11)).toEqual(base); // full cycle
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
    expect(roundRotationOffset('alpha', 0, 11)).toBe(roundRotationOffset('alpha', 0, 11));
  });

  it('groupPlanPairs yields complete A/B pairs with stable pair ids', () => {
    const plan = buildEvalPlanFromEnv(env({ EVAL_SUITE: 'full', EVAL_RUNS: '2' }));
    const pairs = groupPlanPairs(plan);
    expect(pairs).toHaveLength(22); // 11 cases x 2 rounds
    for (const pair of pairs) {
      expect(pair.complete).toBe(true);
      expect(pair.baseline).toBeDefined();
      expect(pair.experimental).toBeDefined();
      expect(pair.order).toEqual(variantOrderForCaseRound(pair.roundIndex));
      expect(pair.pairId).toBe(pairIdOf(pair.caseId, pair.roundIndex));
      expect(pair.baseline!.variant).toBe('baseline');
      expect(pair.experimental!.variant).toBe('experimental');
    }
    expect(new Set(pairs.map((p) => p.pairId)).size).toBe(22);
  });
});

// ---------------------------------------------------------------------------

describe('call-budget guard', () => {
  it('reports exceeded without throwing (dry-mode path) and throws live when exceeded', () => {
    const plan = buildEvalPlanFromEnv(env({ EVAL_RUNS: '10' })); // smoke: 60 attempts (all fast)
    expect(plan.plannedAttempts).toBe(60);
    const check = checkCallBudget(plan);
    expect(check.exceeded).toBe(true);
    expect(check.plannedProviderCalls).toBe(60);
    expect(check.max).toBe(DEFAULT_MAX_CALLS);

    expect(() => assertCallBudget(plan)).toThrow(/evAL_max_calls=20/i);
    expect(() => assertCallBudget(plan)).toThrow(/EVAL_MAX_CALLS=60/);
    expect(() => assertCallBudget(plan)).toThrow(/11-case x 4-run decision run/i);
  });

  it('passes within budget; explicit raise unlocks the 160-provider-call decision run', () => {
    expect(() => assertCallBudget(buildEvalPlanFromEnv(env()))).not.toThrow(); // 6 <= 20
    // Full suite is now multi-pass-aware: 40 provider calls upper bound.
    expect(() => assertCallBudget(buildEvalPlanFromEnv(env({ EVAL_SUITE: 'full', EVAL_MAX_CALLS: '40' })))).not.toThrow();

    const decision = buildEvalPlanFromEnv(
      env({ EVAL_SUITE: 'full', EVAL_RUNS: '4', EVAL_MAX_CALLS: '160' }),
    );
    expect(decision.plannedAttempts).toBe(88); // 11 cases x 4 runs x 2
    expect(decision.plannedProviderCallsUpperBound).toBe(DECISION_RUN_CALLS);
    expect(() => assertCallBudget(decision)).not.toThrow();
    // Same plan under the default guard is blocked (full-suite default is 40).
    expect(() => assertCallBudget(buildEvalPlanFromEnv(env({ EVAL_SUITE: 'full', EVAL_RUNS: '4' })))).toThrow(
      /EVAL_MAX_CALLS=40/,
    );

    // Explicit maxCalls override wins over the env default.
    const raised = buildEvalPlanFromEnv(env({ EVAL_RUNS: '10', EVAL_MAX_CALLS: '100' }));
    expect(raised.config.maxCalls).toBe(100);
    expect(checkCallBudget(raised).exceeded).toBe(false);
    expect(() => assertCallBudget(raised)).not.toThrow();
  });
});
