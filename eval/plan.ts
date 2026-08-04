import {
  SMOKE_CASE_IDS,
  getCaseIds,
  getCases,
  getFullCaseIds,
  type BenchmarkCase,
} from './cases.js';

/**
 * Pure benchmark planning and config for the FiscalCR eval harness.
 *
 * No network, no fs, no secrets, no side effects — fully unit-testable in
 * isolation. This module owns ALL eval env semantics:
 *
 *   EVAL_SUITE     'smoke' (default) | 'full' — which case set to run.
 *   EVAL_CASES     exact comma-separated override, e.g. "clean-01, security-01".
 *                  Precedence: EVAL_CASES beats EVAL_SUITE when both are set.
 *                  Unknown, empty, or duplicate ids are rejected.
 *   EVAL_RUNS      positive integer, A/B pairs PER CASE, default 1.
 *   EVAL_SEED      stable non-empty string; default "fiscalcr-eval-v2".
 *                  Same seed => same schedule; different seed varies case
 *                  order while preserving per-case/round balance.
 *   EVAL_MAX_CALLS positive integer budget guard, default 20. Live mode must
 *                  fail before any network call when planned > max; dry mode
 *                  may report the overflow without failing.
 *
 * Planned calls = selectedCases * runs * 2 (one baseline + one experimental
 * call per case per round).
 *
 * Schedule: cases are interleaved by round. Within a round, the case order is
 * a deterministic seeded rotation of the selected ids. For every case, the
 * variant order across its rounds follows AB / BA / BA / AB repeating
 * (period 4), so pair-internal order bias cancels per case, not just globally.
 */

export type EvalSuite = 'smoke' | 'full';
export type EvalVariant = 'baseline' | 'experimental';

export const DEFAULT_EVAL_SEED = 'fiscalcr-eval-v2';
export const DEFAULT_MAX_CALLS = 20;
/** Recommended call budget for the 10-case x 4-run decision run. */
export const DECISION_RUN_CALLS = 80;

// ---------------------------------------------------------------------------
// Types

export interface EvalSelection {
  suite: EvalSuite;
  /** Resolved case ids in base (non-rotated) order. */
  caseIds: string[];
  cases: BenchmarkCase[];
  /** True when EVAL_CASES explicitly overrode the suite. */
  explicit: boolean;
  runs: number;
  seed: string;
  maxCalls: number;
}

export interface EvalPlanConfig {
  suite: EvalSuite;
  caseIds: string[];
  runs: number;
  seed: string;
  maxCalls: number;
  explicit: boolean;
}

export interface PlanEntry {
  /** 0-based round index (0..runs-1). */
  roundIndex: number;
  /** 0-based position of the case within the round's ordered case list. */
  caseIndex: number;
  caseId: string;
  /** Stable id shared by both variants of the same case+round. */
  pairId: string;
  variant: EvalVariant;
  experimental: boolean;
  /** 0-based global position in the whole plan (execution order). */
  globalCallIndex: number;
}

export interface EvalPlan {
  config: EvalPlanConfig;
  entries: PlanEntry[];
  /** Equal to selectedCases * runs * 2. */
  plannedCalls: number;
}

export interface PlanPair {
  pairId: string;
  roundIndex: number;
  caseId: string;
  order: readonly [EvalVariant, EvalVariant];
  baseline?: PlanEntry;
  experimental?: PlanEntry;
  /** True when both variants are present (always true inside a built plan). */
  complete: boolean;
}

export interface BudgetCheck {
  planned: number;
  max: number;
  exceeded: boolean;
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (FNV-1a seed hash + mulberry32)

export function hashSeed(seed: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Schedule helpers (deterministic seeded rotation)

/** Rotates a list left by `offset` positions (cyclic; negative-safe). */
export function rotateCases(ids: readonly string[], offset: number): string[] {
  const n = ids.length;
  if (n === 0) return [];
  const k = ((offset % n) + n) % n;
  return [...ids.slice(k), ...ids.slice(0, k)];
}

/**
 * Deterministic per-round rotation offset for the seeded schedule.
 * Round 0 of the default seed has offset 0, so the base order stays stable.
 */
export function roundRotationOffset(
  seed: string,
  roundIndex: number,
  caseCount: number,
): number {
  if (caseCount <= 1) return 0;
  const rand = mulberry32(hashSeed(`${seed}:round:${roundIndex}`));
  return Math.floor(rand() * caseCount);
}

/**
 * Variant order for one case in one round: AB / BA / BA / AB repeating.
 * Round 0 -> baseline then experimental; round 1 -> reversed, etc.
 */
export const VARIANT_ORDER_PATTERN: readonly [EvalVariant, EvalVariant][] = [
  ['baseline', 'experimental'],
  ['experimental', 'baseline'],
  ['experimental', 'baseline'],
  ['baseline', 'experimental'],
];

export function variantOrderForCaseRound(
  roundIndex: number,
): readonly [EvalVariant, EvalVariant] {
  return VARIANT_ORDER_PATTERN[((roundIndex % 4) + 4) % 4];
}

/** Stable pair key shared by the baseline and experimental entries of one case+round. */
export function pairIdOf(caseId: string, roundIndex: number): string {
  return `${caseId}@r${roundIndex}`;
}

// ---------------------------------------------------------------------------
// Env resolution

function resolvePositiveInt(
  raw: string | undefined,
  name: string,
  defaultValue: number,
): number {
  if (raw === undefined || raw.trim() === '') return defaultValue;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid ${name} "${raw}": expected a positive integer`);
  }
  const n = Number(trimmed);
  if (n < 1) {
    throw new Error(`Invalid ${name} ${n}: must be at least 1`);
  }
  return n;
}

export function resolveEvalSelection(env: NodeJS.ProcessEnv): EvalSelection {
  // EVAL_SUITE is validated whenever present, even when EVAL_CASES overrides.
  const rawSuite = env.EVAL_SUITE;
  let suite: EvalSuite = 'smoke';
  if (rawSuite !== undefined && rawSuite.trim() !== '') {
    const trimmed = rawSuite.trim();
    if (trimmed !== 'smoke' && trimmed !== 'full') {
      throw new Error(
        `Invalid EVAL_SUITE "${trimmed}": expected "smoke" or "full"`,
      );
    }
    suite = trimmed;
  }

  const rawCases = env.EVAL_CASES;
  let explicit = false;
  let caseIds: string[];
  if (rawCases !== undefined) {
    // Any explicitly-set EVAL_CASES is parsed; empty/whitespace selections
    // are rejected as "no ids" (never silently falls back to the suite).
    const ids = getCaseIds(rawCases);
    const seen = new Set<string>();
    const duplicates = ids.filter((id) => {
      if (seen.has(id)) return true;
      seen.add(id);
      return false;
    });
    if (duplicates.length > 0) {
      throw new Error(
        `Duplicate eval case id(s) in EVAL_CASES: ${[...new Set(duplicates)].join(', ')}`,
      );
    }
    caseIds = ids;
    explicit = true;
  } else {
    caseIds = suite === 'smoke' ? [...SMOKE_CASE_IDS] : getFullCaseIds();
  }

  const runs = resolvePositiveInt(env.EVAL_RUNS, 'EVAL_RUNS', 1);

  const rawSeed = env.EVAL_SEED;
  let seed = DEFAULT_EVAL_SEED;
  if (rawSeed !== undefined && rawSeed.trim() !== '') {
    seed = rawSeed.trim();
  } else if (rawSeed !== undefined) {
    throw new Error('Invalid EVAL_SEED: expected a non-empty seed string');
  }

  const maxCalls = resolvePositiveInt(
    env.EVAL_MAX_CALLS,
    'EVAL_MAX_CALLS',
    DEFAULT_MAX_CALLS,
  );

  return { suite, caseIds, cases: getCases(caseIds), explicit, runs, seed, maxCalls };
}

// ---------------------------------------------------------------------------
// Plan construction

export function buildEvalPlan(selection: EvalSelection): EvalPlan {
  const { caseIds, runs, seed } = selection;
  const entries: PlanEntry[] = [];
  let globalCallIndex = 0;

  for (let roundIndex = 0; roundIndex < runs; roundIndex++) {
    const offset = roundRotationOffset(seed, roundIndex, caseIds.length);
    const roundOrder = rotateCases(caseIds, offset);
    for (let caseIndex = 0; caseIndex < roundOrder.length; caseIndex++) {
      const caseId = roundOrder[caseIndex];
      const pairId = pairIdOf(caseId, roundIndex);
      for (const variant of variantOrderForCaseRound(roundIndex)) {
        entries.push({
          roundIndex,
          caseIndex,
          caseId,
          pairId,
          variant,
          experimental: variant === 'experimental',
          globalCallIndex,
        });
        globalCallIndex += 1;
      }
    }
  }

  return {
    config: {
      suite: selection.suite,
      caseIds: [...caseIds],
      runs,
      seed,
      maxCalls: selection.maxCalls,
      explicit: selection.explicit,
    },
    entries,
    plannedCalls: globalCallIndex,
  };
}

export function buildEvalPlanFromEnv(env: NodeJS.ProcessEnv): EvalPlan {
  return buildEvalPlan(resolveEvalSelection(env));
}

/** Groups plan entries into A/B pairs by pairId, in execution order. */
export function groupPlanPairs(plan: EvalPlan): PlanPair[] {
  const byPair = new Map<string, PlanEntry[]>();
  for (const entry of plan.entries) {
    const list = byPair.get(entry.pairId) ?? [];
    list.push(entry);
    byPair.set(entry.pairId, list);
  }
  const pairs: PlanPair[] = [];
  for (const entries of byPair.values()) {
    const baseline = entries.find((e) => e.variant === 'baseline');
    const experimental = entries.find((e) => e.variant === 'experimental');
    const first = entries[0];
    pairs.push({
      pairId: first.pairId,
      roundIndex: first.roundIndex,
      caseId: first.caseId,
      order: variantOrderForCaseRound(first.roundIndex),
      baseline,
      experimental,
      complete: baseline !== undefined && experimental !== undefined,
    });
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Call-budget guard

export function checkCallBudget(
  plan: EvalPlan,
  maxCalls: number = plan.config.maxCalls,
): BudgetCheck {
  return {
    planned: plan.plannedCalls,
    max: maxCalls,
    exceeded: plan.plannedCalls > maxCalls,
  };
}

/**
 * Live-mode guard: throws BEFORE any network call when the plan exceeds the
 * budget, with the exact override instruction. Dry mode should use
 * `checkCallBudget` instead so it can still show the plan.
 */
export function assertCallBudget(
  plan: EvalPlan,
  maxCalls: number = plan.config.maxCalls,
): void {
  const check = checkCallBudget(plan, maxCalls);
  if (check.exceeded) {
    throw new Error(
      `Planned ${check.planned} LLM calls exceeds EVAL_MAX_CALLS=${check.max}. ` +
        `Raise the guard for this plan, e.g. EVAL_MAX_CALLS=${check.planned} ` +
        `(recommended ${DECISION_RUN_CALLS} for the 10-case x 4-run decision run).`,
    );
  }
}
