import type { ReviewConfig } from "../config/schema.js";

/** Models that reject any temperature other than their server-side default. */
const FIXED_TEMPERATURE_MODELS = new Set([
  "kimi-for-coding",
  "kimi-for-coding-highspeed",
  "kimi-k3",
  "k3",
  "k3-256k",
]);

/**
 * OpenAI reasoning models reject any temperature other than the server default.
 * Matched by name (o1/o3/o4-mini…, gpt-5 family) so the guard also protects an
 * `openai-compatible` endpoint that happens to serve a reasoning model.
 */
function isReasoningModel(model: string): boolean {
  return /^(o[1-9]|gpt-5)/i.test(model);
}

/**
 * Resolve the temperature for a review call: an explicit config value wins;
 * models that pin their own temperature get none at all (the server default
 * applies); everything else uses the pipeline's preferred low temperature.
 *
 * `model` is the model actually used for this call (a stage model when the
 * caller resolved one); it defaults to the legacy single `config.model` so
 * callers that predate stage routing keep their behavior.
 */
export function reviewTemperature(
  config: ReviewConfig,
  preferred = 0.3,
  model: string = config.model,
): number | undefined {
  if (config.temperature !== undefined) return config.temperature;
  if (FIXED_TEMPERATURE_MODELS.has(model)) return undefined;
  if (isReasoningModel(model)) return undefined;
  return preferred;
}
