/**
 * Model-ID parsing shared by per-model request decisions (temperature, output
 * caps, prompt caching). Every helper accepts first-party IDs and
 * OpenRouter-style vendor-prefixed IDs (`anthropic/claude-…`, `openai/gpt-…`).
 */

/** Drop an OpenRouter-style vendor prefix (`anthropic/claude-…` → `claude-…`). */
export function bareModelId(model: string): string {
  return model.replace(/^[^/]+\//, "");
}

/** Any Claude model, including `anthropic.`-prefixed (Bedrock) IDs. */
export function isClaudeModel(model: string): boolean {
  return /^(?:anthropic\.)?claude-/i.test(bareModelId(model));
}

/**
 * OpenAI reasoning models (o1/o3/o4-mini…, gpt-5 and later families). They
 * reject any temperature other than the server default.
 */
export function isOpenAIReasoningModel(model: string): boolean {
  return /^(o[1-9]|gpt-[5-9](?!\d))/i.test(bareModelId(model));
}

/**
 * Claude models that reject sampling parameters (`temperature` returns a 400):
 * every 5.x+ model (Opus, Sonnet, Fable, Mythos) and Opus 4.7+. Older models
 * (Opus/Sonnet 4.6, Haiku 4.5, …) still accept them. Matches dotted
 * (`claude-sonnet-4.5`) and dashed (`claude-sonnet-4-5`) versions.
 */
export function claudeRejectsSamplingParams(model: string): boolean {
  const match = /^(?:anthropic\.)?claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:[-.](\d+))?/i.exec(
    bareModelId(model),
  );
  if (!match) return false;
  const [, family, major, minor = "0"] = match;
  if (Number(major) >= 5) return true;
  return family.toLowerCase() === "opus" && Number(major) === 4 && Number(minor) >= 7;
}

/**
 * GPT-5.6 and later: accept `prompt_cache_options` / `prompt_cache_breakpoint`
 * and bill cache writes at 1.25x input.
 */
export function supportsOpenAIExplicitCache(model: string): boolean {
  const match = /^gpt-(\d+)(?:\.(\d+))?/i.exec(bareModelId(model));
  if (!match) return false;
  const major = Number(match[1]);
  return major > 5 || (major === 5 && Number(match[2] ?? 0) >= 6);
}
