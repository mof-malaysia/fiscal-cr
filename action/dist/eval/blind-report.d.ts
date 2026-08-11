/**
 * Blind Markdown pack + answer-key generator for the FiscalCR eval harness.
 *
 * Pure: no network, no fs, no secrets, no side effects — fully unit-testable.
 * The pack renders complete A/B pairs with deterministic randomized side
 * assignment so human reviewers can score without knowing which variant is
 * baseline or experimental.
 *
 * Secret discipline: the pack and key never contain the API key, base URL,
 * prompt metadata, token counts, timing, gold issue manifests, or quality
 * metrics. Only retained review annotations are rendered.
 */
import type { PullRequestContext, ReviewResult } from '../src/types/review.js';
import type { BenchmarkCase } from './quality.js';
import type { CompletedAttempt } from './benchmark.js';
export interface BlindPair {
    blindPairId: string;
    pairId: string;
    caseId: string;
    roundIndex: number;
    caseLabel: string;
    context: PullRequestContext;
    reviewA: ReviewResult;
    reviewB: ReviewResult;
    assignment: {
        a: 'baseline' | 'experimental';
        b: 'baseline' | 'experimental';
    };
}
export interface BlindKeyEntry {
    blindPairId: string;
    pairId: string;
    caseId: string;
    roundIndex: number;
    reviewA: 'baseline' | 'experimental';
    reviewB: 'baseline' | 'experimental';
}
export interface BlindKey {
    schema: 'fiscalcr-blind-key-v1';
    seed: string;
    generatedAt: string;
    pairs: BlindKeyEntry[];
}
export interface BuildBlindReportInput {
    seed: string;
    pairs: BlindPair[];
    excludedPairIds: string[];
}
/**
 * Deterministic randomized side assignment for one pair.
 * Returns which variant is Review A and which is Review B.
 * The decision is a 50/50 coin flip based on `seed + ":" + pairId`.
 */
export declare function deterministicAssignment(seed: string, pairId: string): {
    a: 'baseline' | 'experimental';
    b: 'baseline' | 'experimental';
};
/** Choose a backtick fence that does not appear inside `content`. */
export declare function chooseFence(content: string): string;
/** Render one review (summary + walkthrough + findings) for the pack. */
export declare function renderReview(review: ReviewResult, label: 'A' | 'B'): string;
/** Render PR context (title, description, changed files) for the pack. */
export declare function renderCaseContext(ctx: PullRequestContext, label: string): string;
export interface BuildBlindPairInput {
    pairId: string;
    caseId: string;
    roundIndex: number;
    baselineAttempt: CompletedAttempt;
    experimentalAttempt: CompletedAttempt;
    case: BenchmarkCase;
    seed: string;
}
export declare function buildBlindPair(input: BuildBlindPairInput): BlindPair;
export declare function buildBlindReport(input: BuildBlindReportInput): string;
export declare function buildBlindKey(pairs: readonly BlindPair[], seed: string, generatedAt: string): BlindKey;
export interface BuildBlindPairsFromAttemptsInput {
    seed: string;
    attempts: readonly CompletedAttempt[];
    casesById: Map<string, BenchmarkCase>;
}
/**
 * Group completed attempts into complete baseline+experimental pairs and
 * build blind pairs with deterministic side assignment.
 * Returns { pairs, excludedPairIds }.
 */
export declare function buildBlindPairsFromAttempts(input: BuildBlindPairsFromAttemptsInput): {
    pairs: BlindPair[];
    excludedPairIds: string[];
};
//# sourceMappingURL=blind-report.d.ts.map