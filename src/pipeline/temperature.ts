import { modelForRole, type ReviewConfig } from "../config/schema.js";
import {
  bareModelId,
  claudeRejectsSamplingParams,
  isOpenAIReasoningModel,
} from "../utils/model-ids.js";

/** Models that reject any temperature other than their server-side default. */
const FIXED_TEMPERATURE_MODELS = new Set([
  "kimi-for-coding",
  "kimi-for-coding-highspeed",
  "kimi-k3",
  "k3",
  "k3-256k",
]);

/**
 * Models that spend output tokens on hidden reasoning before answering
 * (OpenAI reasoning models, Claude 4.7+/5.x), so calls run longer and short
 * output caps truncate the answer.
 */
export function usesHiddenReasoning(model: string): boolean {
  return isOpenAIReasoningModel(model) || claudeRejectsSamplingParams(model);
}

/**
 * Resolve the temperature for a review call: an explicit config value wins;
 * models that pin their own temperature get none at all (the server default
 * applies); everything else uses the pipeline's preferred low temperature.
 *
 * `model` is the model actually used for this call (a stage model when the
 * caller resolved one); it defaults to the resolved `groupReview` model.
 */
export function reviewTemperature(
  config: ReviewConfig,
  preferred = 0.3,
  model: string = modelForRole(config, 'groupReview'),
): number | undefined {
  if (config.temperature !== undefined) return config.temperature;
  if (FIXED_TEMPERATURE_MODELS.has(bareModelId(model))) return undefined;
  if (isOpenAIReasoningModel(model)) return undefined;
  if (claudeRejectsSamplingParams(model)) return undefined;
  return preferred;
}
