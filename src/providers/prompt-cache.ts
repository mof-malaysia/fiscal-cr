import type { ReviewConfig } from '../config/schema.js';
import type { ChatMessage } from '../types/review.js';
import { isClaudeModel, supportsOpenAIExplicitCache } from '../utils/model-ids.js';
import type { CacheWriteUsage } from './interface.js';

/**
 * Prompt caching for the system prompt.
 *
 * The system prompt depends only on repo config, so it is identical across
 * calls, stages, and PRs. It is the one part of a review request worth
 * caching. This module decides what each provider is sent and what its cache
 * writes cost; the adapters only call it.
 */

export type PromptCacheSetting = NonNullable<ReviewConfig['promptCache']>;

/**
 * How a Chat Completions endpoint is told to cache the system prompt:
 * - `cache-control`: Anthropic-style `cache_control` on the system block.
 *   OpenRouter forwards it to Anthropic, Gemini, and Qwen models.
 * - `openai`: GPT-5.6+ explicit mode (`prompt_cache_options.mode: explicit`)
 *   with a `prompt_cache_breakpoint` on the system block. Without it, OpenAI
 *   caches the whole per-PR prompt at 1.25x on every call. OpenAI's lifetime
 *   is a fixed 30m, so `5m` and `1h` both just turn it on; `off` keeps
 *   explicit mode with no breakpoint, so nothing is written.
 * - `kimi`: `prompt_cache_options: { mode: implicit, ttl }`.
 */
export type PromptCacheStyle = 'cache-control' | 'openai' | 'kimi';

/** The lifetime to request, or undefined when caching is off or unset. */
function ttlOf(setting: PromptCacheSetting | undefined): '5m' | '1h' | undefined {
  return setting === 'off' ? undefined : setting;
}

function cacheControl(ttl: '5m' | '1h') {
  return ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
}

// ---------------------------------------------------------------------------
// Anthropic Messages API

/** The `system` field: a cache-marked text block, or plain text when off. */
export function anthropicSystem(text: string, setting: PromptCacheSetting | undefined) {
  const ttl = ttlOf(setting);
  return ttl ? [{ type: 'text', text, cache_control: cacheControl(ttl) }] : text;
}

/** Anthropic bills 5m writes at 1.25x input and 1h writes at 2x. */
export function anthropicCacheWrite(
  fiveMinuteTokens: number,
  oneHourTokens: number,
): CacheWriteUsage | undefined {
  const tokens = fiveMinuteTokens + oneHourTokens;
  if (tokens === 0) return undefined;
  return { tokens, priceMultiplier: (fiveMinuteTokens * 1.25 + oneHourTokens * 2) / tokens };
}

// ---------------------------------------------------------------------------
// Chat Completions (OpenAI, OpenRouter, Kimi, compatible endpoints)

function markSystemPrompt(messages: ChatMessage[], marker: object): unknown[] {
  return messages.map((message) =>
    message.role === 'system' && message.content.length > 0
      ? { role: 'system', content: [{ type: 'text', text: message.content, ...marker }] }
      : message,
  );
}

/** The request's cache fields (sent before `modelParams`) and its messages. */
export function chatCacheRequest(
  style: PromptCacheStyle,
  setting: PromptCacheSetting | undefined,
  model: string,
  messages: ChatMessage[],
): { fields: object; messages: unknown[] } {
  const ttl = ttlOf(setting);

  if (style === 'cache-control' && ttl) {
    return { fields: {}, messages: markSystemPrompt(messages, { cache_control: cacheControl(ttl) }) };
  }
  if (style === 'kimi' && ttl) {
    return { fields: { prompt_cache_options: { mode: 'implicit', ttl } }, messages };
  }
  if (style === 'openai' && setting && supportsOpenAIExplicitCache(model)) {
    const breakpoint = { prompt_cache_breakpoint: { mode: 'explicit' } };
    return {
      fields: { prompt_cache_options: { mode: 'explicit' } },
      messages: ttl ? markSystemPrompt(messages, breakpoint) : messages,
    };
  }
  return { fields: {}, messages };
}

/**
 * Price reported cache writes. Behind `cache-control` (OpenRouter), only
 * Claude writes follow the TTL we asked for; other models cache on their own
 * terms. Gemini's storage charge is not modeled.
 */
export function chatCacheWrite(
  style: PromptCacheStyle,
  setting: PromptCacheSetting | undefined,
  model: string,
  tokens: number,
): CacheWriteUsage | undefined {
  if (tokens === 0) return undefined;
  const oneHour = ttlOf(setting) === '1h';

  let priceMultiplier: number;
  if (style === 'kimi') {
    priceMultiplier = oneHour ? 2 : 1; // Kimi 5m writes cost plain input
  } else if (style === 'cache-control' && isClaudeModel(model)) {
    priceMultiplier = oneHour ? 2 : 1.25;
  } else {
    priceMultiplier = supportsOpenAIExplicitCache(model) ? 1.25 : 1;
  }
  return { tokens, priceMultiplier };
}
