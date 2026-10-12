import type { ReviewConfig } from "../config/schema.js";
/**
 * Resolve the output-token cap for a review call: an explicit
 * `pipeline.maxOutputTokens` wins; Kimi models get a larger cap since they
 * reliably emit long structured output (and short caps truncate mid-JSON);
 * everything else uses a conservative default that unknown endpoints accept.
 *
 * `model` is the model actually used for this call (a stage model when the
 * caller resolved one); it defaults to the legacy single `config.model` so
 * callers that predate stage routing keep their behavior.
 */
export declare function reviewMaxOutputTokens(config: ReviewConfig, model?: string): number;
//# sourceMappingURL=max-output.d.ts.map