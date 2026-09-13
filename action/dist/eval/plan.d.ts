import { type BenchmarkCase } from './cases.js';
import { type ReviewRoute } from '../src/pipeline/run-review.js';
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
 *   EVAL_MAX_CALLS positive integer budget guard. Default 20 for smoke and
 *                  focused (explicit EVAL_CASES) plans; the full suite
 *                  (EVAL_SUITE=full, no EVAL_CASES override) defaults to 40.
 *                  An explicit EVAL_MAX_CALLS from the shell or .env always
 *                  wins over either default. Live mode must fail before any
 *                  network call when the planned provider-call UPPER BOUND
 *                  exceeds max; dry mode may report the overflow without
 *                  failing.
 *
 * Planned attempts = selectedCases * runs * 2 (one baseline + one experimental
 * attempt per case per round). Each attempt runs the production review
 * pipeline (src/pipeline/run-review.ts), so an attempt may issue more than one
 * provider LLM call: fast-path attempts cost at most 1; multi-pass attempts
 * cost at most 1 (intent) + maxGroups (group reviews) + 1 (synthesis when more
 * than one group) using the sound config bound pipeline.maxGroups.
 * plannedProviderCallsUpperBound is the sum of those per-attempt bounds and is
 * what EVAL_MAX_CALLS guards against before any provider is created.
 *
 * Schedule: cases are interleaved by round. Within a round, the case order is
 * a deterministic seeded rotation of the selected ids. For every case, the
 * variant order across its rounds follows AB / BA / BA / AB repeating
 * (period 4), so pair-internal order bias cancels per case, not just globally.
 */
export type EvalSuite = 'smoke' | 'full';
export type EvalVariant = 'baseline' | 'experimental';
export declare const DEFAULT_EVAL_SEED = "fiscalcr-eval-v2";
/**
 * Default EVAL_MAX_CALLS guard for smoke and focused (explicit EVAL_CASES)
 * plans. The full suite defaults to FULL_SUITE_MAX_CALLS instead — see
 * resolveEvalSelection. An explicitly-set EVAL_MAX_CALLS (shell export or
 * .env, both arrive as ordinary env vars) always wins over either default.
 */
export declare const DEFAULT_MAX_CALLS = 20;
/**
 * Suite-aware default for the full suite (11 cases) at EVAL_RUNS=1: the
 * provider-call upper bound is 40 (10 fast-path cases × 1 + pipeline-01 × 10),
 * so the guard defaults to 40 when EVAL_MAX_CALLS is absent. Only applies when
 * EVAL_SUITE=full WITHOUT an explicit EVAL_CASES override (focused runs keep
 * DEFAULT_MAX_CALLS).
 */
export declare const FULL_SUITE_MAX_CALLS = 40;
/**
 * Recommended provider-call budget for the 11-case x 4-run decision run.
 * 10 fast-path cases × 8 attempts × 1 + pipeline-01 × 8 attempts × 10
 * (1 + maxGroups 8 + synthesis 1) = 80 + 80 = 160.
 */
export declare const DECISION_RUN_CALLS = 160;
/** Upper bound of provider LLM calls for one review attempt on a route. */
export declare function maxProviderCallsForRoute(route: ReviewRoute, maxGroups: number): number;
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
    /** Route the production runner will take for this attempt (deterministic). */
    route: ReviewRoute;
    /** Upper bound of provider LLM calls for this attempt (route-based). */
    maxProviderCalls: number;
}
export interface EvalPlan {
    config: EvalPlanConfig;
    entries: PlanEntry[];
    /** Equal to selectedCases * runs * 2. */
    plannedAttempts: number;
    /**
     * Sum of per-attempt provider-call upper bounds. This is the number
     * EVAL_MAX_CALLS guards against (not plannedAttempts — multi-pass attempts
     * can issue several provider calls each).
     */
    plannedProviderCallsUpperBound: number;
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
    /** plannedProviderCallsUpperBound — the number EVAL_MAX_CALLS guards. */
    plannedProviderCalls: number;
    max: number;
    exceeded: boolean;
}
export declare function hashSeed(seed: string): number;
export declare function mulberry32(seed: number): () => number;
/** Rotates a list left by `offset` positions (cyclic; negative-safe). */
export declare function rotateCases(ids: readonly string[], offset: number): string[];
/**
 * Deterministic per-round rotation offset for the seeded schedule.
 * Round 0 of the default seed has offset 0, so the base order stays stable.
 */
export declare function roundRotationOffset(seed: string, roundIndex: number, caseCount: number): number;
/**
 * Variant order for one case in one round: AB / BA / BA / AB repeating.
 * Round 0 -> baseline then experimental; round 1 -> reversed, etc.
 */
export declare const VARIANT_ORDER_PATTERN: readonly [EvalVariant, EvalVariant][];
export declare function variantOrderForCaseRound(roundIndex: number): readonly [EvalVariant, EvalVariant];
/** Stable pair key shared by the baseline and experimental entries of one case+round. */
export declare function pairIdOf(caseId: string, roundIndex: number): string;
export declare function resolveEvalSelection(env: NodeJS.ProcessEnv): EvalSelection;
export declare function buildEvalPlan(selection: EvalSelection): EvalPlan;
export declare function buildEvalPlanFromEnv(env: NodeJS.ProcessEnv): EvalPlan;
/** Groups plan entries into A/B pairs by pairId, in execution order. */
export declare function groupPlanPairs(plan: EvalPlan): PlanPair[];
export declare function checkCallBudget(plan: EvalPlan, maxCalls?: number): BudgetCheck;
/**
 * Live-mode guard: throws BEFORE any network call when the plan's provider-call
 * upper bound exceeds the budget, with the exact override instruction. Dry mode
 * should use `checkCallBudget` instead so it can still show the plan.
 */
export declare function assertCallBudget(plan: EvalPlan, maxCalls?: number): void;
//# sourceMappingURL=plan.d.ts.map