import { modelForRole, type ReviewConfig } from "../config/schema.js";

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
 * Matched by name (o1/o3/o4-mini…, gpt-5 and later families) so the guard also protects an
 * `openai-compatible` endpoint that happens to serve a reasoning model.
 */
function isReasoningModel(model: string): boolean {
  return /^(o[1-9]|gpt-[5-9](?!\d))/i.test(model);
}

/**
 * Claude models that reject sampling parameters (`temperature` returns a 400):
 * every 5.x+ model (Opus, Sonnet, Fable, Mythos) and Opus 4.7+. Older models
 * (Opus/Sonnet 4.6, Haiku 4.5, …) still accept them. Matches first-party,
 * dotted (`claude-sonnet-4.5`), and `anthropic.`-prefixed IDs.
 */
function rejectsSamplingParams(model: string): boolean {
  const match = /^(?:anthropic\.)?claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:[-.](\d+))?/i.exec(
    model,
  );
  if (!match) return false;
  const [, family, major, minor = "0"] = match;
  if (Number(major) >= 5) return true;
  return family.toLowerCase() === "opus" && Number(major) === 4 && Number(minor) >= 7;
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
  if (FIXED_TEMPERATURE_MODELS.has(model)) return undefined;
  if (isReasoningModel(model)) return undefined;
  if (rejectsSamplingParams(model)) return undefined;
  return preferred;
}
