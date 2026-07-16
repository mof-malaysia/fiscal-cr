import type { ReviewConfig } from '../config/schema.js';
/**
 * Resolve the temperature for a review call: an explicit config value wins;
 * models that pin their own temperature get none at all (the server default
 * applies); everything else uses the pipeline's preferred low temperature.
 */
export declare function reviewTemperature(config: ReviewConfig, preferred?: number): number | undefined;
//# sourceMappingURL=temperature.d.ts.map