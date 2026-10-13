/**
 * Model-ID parsing shared by per-model request decisions (temperature, output
 * caps, prompt caching). Every helper accepts first-party IDs and
 * OpenRouter-style vendor-prefixed IDs (`anthropic/claude-…`, `openai/gpt-…`).
 */
/** Drop an OpenRouter-style vendor prefix (`anthropic/claude-…` → `claude-…`). */
export declare function bareModelId(model: string): string;
/** Any Claude model, including `anthropic.`-prefixed (Bedrock) IDs. */
export declare function isClaudeModel(model: string): boolean;
/**
 * OpenAI reasoning models (o1/o3/o4-mini…, gpt-5 and later families). They
 * reject any temperature other than the server default.
 */
export declare function isOpenAIReasoningModel(model: string): boolean;
/**
 * Claude models that reject sampling parameters (`temperature` returns a 400):
 * every 5.x+ model (Opus, Sonnet, Fable, Mythos) and Opus 4.7+. Older models
 * (Opus/Sonnet 4.6, Haiku 4.5, …) still accept them. Matches dotted
 * (`claude-sonnet-4.5`) and dashed (`claude-sonnet-4-5`) versions.
 */
export declare function claudeRejectsSamplingParams(model: string): boolean;
/**
 * GPT-5.6 and later: accept `prompt_cache_options` / `prompt_cache_breakpoint`
 * and bill cache writes at 1.25x input.
 */
export declare function supportsOpenAIExplicitCache(model: string): boolean;
//# sourceMappingURL=model-ids.d.ts.map