import type { ChangedFile, PullRequestContext, ReviewAnnotation, ReviewResult, Severity } from '../types/review.js';
import type { ReviewConfig } from '../config/schema.js';
import type { LLMProvider } from '../providers/interface.js';
import { type IntentResult } from './schemas.js';
import type { GroupReviewOutcome } from './pass2-review.js';
import type { UsageTracker } from './usage.js';
export declare function deterministicScore(stats: Record<Severity, number>): number;
export declare function countBySeverity(annotations: ReviewAnnotation[]): Record<Severity, number>;
/**
 * Deterministic quality gate applied to all findings regardless of path:
 * 1. drop findings whose lines don't exist in the PR diff (hallucinated lines)
 * 2. drop low-confidence findings (criticals get a lower floor, flagged)
 * 3. dedupe overlapping same-category findings on the same file
 * 4. severity floor + rank by severity/confidence + cap
 */
export declare function validateAndRankFindings(findings: ReviewAnnotation[], changedFiles: ChangedFile[], config: ReviewConfig): ReviewAnnotation[];
export interface SynthesisInput {
    ctx: PullRequestContext;
    intent: IntentResult | null;
    outcomes: GroupReviewOutcome[];
    /** Findings that already passed validateAndRankFindings. */
    findings: ReviewAnnotation[];
}
/**
 * Pass 3: assemble the final ReviewResult. Uses one LLM call to write the
 * summary and prune near-duplicates/false positives; skipped for single-group
 * runs, and every LLM decision has a deterministic fallback.
 */
export declare function synthesize(llm: LLMProvider, input: SynthesisInput, config: ReviewConfig, usage: UsageTracker): Promise<ReviewResult>;
//# sourceMappingURL=pass3-synthesis.d.ts.map