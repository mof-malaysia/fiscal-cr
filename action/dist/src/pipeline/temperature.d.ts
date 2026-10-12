import type { ReviewConfig } from "../config/schema.js";
/**
 * Resolve the temperature for a review call: an explicit config value wins;
 * models that pin their own temperature get none at all (the server default
 * applies); everything else uses the pipeline's preferred low temperature.
 *
 * `model` is the model actually used for this call (a stage model when the
 * caller resolved one); it defaults to the legacy single `config.model` so
 * callers that predate stage routing keep their behavior.
 */
export declare function reviewTemperature(config: ReviewConfig, preferred?: number, model?: string): number | undefined;
//# sourceMappingURL=temperature.d.ts.map