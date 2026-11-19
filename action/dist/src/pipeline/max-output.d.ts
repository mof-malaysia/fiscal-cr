import { type ReviewConfig } from "../config/schema.js";
/**
 * Resolve the output-token cap for a review call: an explicit
 * `pipeline.maxOutputTokens` wins; Kimi models get a larger cap since they
 * reliably emit long structured output (and short caps truncate mid-JSON);
 * everything else uses a conservative default that unknown endpoints accept.
 *
 * `model` is the model actually used for this call (a stage model when the
 * caller resolved one); it defaults to the resolved `groupReview` model.
 */
export declare function reviewMaxOutputTokens(config: ReviewConfig, model?: string): number;
/**
 * Output cap for a call whose answer is short (intent, synthesis). Reasoning
 * tokens count toward the cap, so reasoning models get the full review cap;
 * the short cap would truncate them before they answer.
 */
export declare function shortCallMaxTokens(config: ReviewConfig, model: string, answerTokens: number): number;
/**
 * Timeout for a review call: an explicit `pipeline.callTimeoutMs` wins;
 * reasoning models get 5 minutes, everything else `fallbackMs`.
 */
export declare function reviewCallTimeoutMs(config: ReviewConfig, model: string, fallbackMs?: number): number;
//# sourceMappingURL=max-output.d.ts.map