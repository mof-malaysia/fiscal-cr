import type { ReviewConfig } from "../config/schema.js";

/** Cap for models known to sustain large structured output (Kimi coding models). */
const KIMI_MAX_OUTPUT_TOKENS = 65_536;

/** Conservative cap for any other/unknown model. */
const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;

/** True when the review runs against a Kimi model, by provider or model name. */
function isKimiModel(config: ReviewConfig): boolean {
  return (
    config.provider === "kimi" || config.model.toLowerCase().startsWith("kimi")
  );
}

/**
 * Resolve the output-token cap for a review call: an explicit
 * `pipeline.maxOutputTokens` wins; Kimi models get a larger cap since they
 * reliably emit long structured output (and short caps truncate mid-JSON);
 * everything else uses a conservative default that unknown endpoints accept.
 */
export function reviewMaxOutputTokens(config: ReviewConfig): number {
  if (config.pipeline.maxOutputTokens !== undefined)
    return config.pipeline.maxOutputTokens;
  if (isKimiModel(config)) return KIMI_MAX_OUTPUT_TOKENS;
  return DEFAULT_MAX_OUTPUT_TOKENS;
}
