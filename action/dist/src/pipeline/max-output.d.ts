import type { ReviewConfig } from "../config/schema.js";
/**
 * Resolve the output-token cap for a review call: an explicit
 * `pipeline.maxOutputTokens` wins; Kimi models get a larger cap since they
 * reliably emit long structured output (and short caps truncate mid-JSON);
 * everything else uses a conservative default that unknown endpoints accept.
 */
export declare function reviewMaxOutputTokens(config: ReviewConfig): number;
//# sourceMappingURL=max-output.d.ts.map