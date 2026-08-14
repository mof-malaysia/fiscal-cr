import type { ChangedFile, PullRequestContext, ReviewAnnotation, ReviewResult, Severity } from '../types/review.js';
import type { ReviewConfig } from '../config/schema.js';
import type { LLMProvider } from '../providers/interface.js';
import { type IntentResult } from './schemas.js';
import type { GroupReviewOutcome } from './pass2-review.js';
import type { UsageTracker } from './usage.js';
export declare function deterministicScore(stats: Record<Severity, number>): number;
export declare function countBySeverity(annotations: ReviewAnnotation[]): Record<Severity, number>;
/**
 * Apply safe, deterministic readability improvements to model-generated
 * summary prose. Ambiguous rewrites remain untouched.
 */
export declare function simplifySummaryProse(text: string): string;
/** Apply the same safe plain-English cleanup to inline finding comments. */
export declare function simplifyFindingBody(body: string): string;
/**
 * Put each sentence on a visible Markdown list line when the model returns
 * several sentences as one paragraph.
 */
export declare function formatSummaryLines(text: string): string;
/**
 * Simplify summary prose, then put each sentence on a visible Markdown line.
 */
export declare function formatSummaryProse(text: string): string;
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