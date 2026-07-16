import type { ReviewConfig } from '../config/schema.js';

/** Models that reject any temperature other than their server-side default. */
const FIXED_TEMPERATURE_MODELS = new Set(['kimi-for-coding']);

/**
 * Resolve the temperature for a review call: an explicit config value wins;
 * models that pin their own temperature get none at all (the server default
 * applies); everything else uses the pipeline's preferred low temperature.
 */
export function reviewTemperature(config: ReviewConfig, preferred = 0.3): number | undefined {
  if (config.temperature !== undefined) return config.temperature;
  if (FIXED_TEMPERATURE_MODELS.has(config.model)) return undefined;
  return preferred;
}
