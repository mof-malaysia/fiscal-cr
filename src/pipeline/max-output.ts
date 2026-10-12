import type { ReviewConfig } from "../config/schema.js";
import { usesHiddenReasoning } from "./temperature.js";

/** Cap for models known to sustain large structured output (Kimi coding models). */
const KIMI_MAX_OUTPUT_TOKENS = 65_536;

/** Conservative cap for any other/unknown model. */
const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;

/** True when the review runs against a Kimi model, by provider or model name. */
function isKimiModel(config: ReviewConfig, model: string): boolean {
  return (
    config.provider === "kimi" || model.toLowerCase().startsWith("kimi")
  );
}

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
export function reviewMaxOutputTokens(
  config: ReviewConfig,
  model: string = config.model,
): number {
  if (config.pipeline.maxOutputTokens !== undefined)
    return config.pipeline.maxOutputTokens;
  if (isKimiModel(config, model)) return KIMI_MAX_OUTPUT_TOKENS;
  return DEFAULT_MAX_OUTPUT_TOKENS;
}

/**
 * Output cap for a call whose answer is short (intent, synthesis). Reasoning
 * tokens count toward the cap, so reasoning models get the full review cap;
 * the short cap would truncate them before they answer.
 */
export function shortCallMaxTokens(
  config: ReviewConfig,
  model: string,
  answerTokens: number,
): number {
  if (!usesHiddenReasoning(model)) return answerTokens;
  return Math.max(answerTokens, reviewMaxOutputTokens(config, model));
}

/** Timeout for reasoning models, which routinely need minutes on large prompts. */
const REASONING_CALL_TIMEOUT_MS = 300_000;

/** Timeout for other models' review calls. */
const DEFAULT_CALL_TIMEOUT_MS = 120_000;

/**
 * Timeout for a review call: an explicit `pipeline.callTimeoutMs` wins;
 * reasoning models get 5 minutes, everything else `fallbackMs`.
 */
export function reviewCallTimeoutMs(
  config: ReviewConfig,
  model: string,
  fallbackMs: number = DEFAULT_CALL_TIMEOUT_MS,
): number {
  if (config.pipeline.callTimeoutMs !== undefined) return config.pipeline.callTimeoutMs;
  return usesHiddenReasoning(model) ? REASONING_CALL_TIMEOUT_MS : fallbackMs;
}
