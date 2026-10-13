import type { ReviewConfig } from '../config/schema.js';
import type { ChatMessage } from '../types/review.js';
import { isClaudeModel, supportsOpenAIExplicitCache } from '../utils/model-ids.js';
import type { CacheWriteUsage } from './interface.js';

/**
 * Prompt caching for the system prompt, per provider wire format.
 *
 * The system prompt depends only on repo config, so it is byte-identical
 * across calls, stages, and PRs; it is the only part of a review request worth
 * a cache write. Every rule about what to send and what writes cost lives
 * here, so adding a provider means adding a style, not editing adapters.
 */

export type PromptCacheSetting = NonNullable<ReviewConfig['promptCache']>;

/**
 * How a Chat Completions endpoint is told to cache the system prompt:
 * - `cache-control`: Anthropic-style `cache_control` on the system content
 *   block. OpenRouter forwards it to Anthropic/Gemini/Qwen models.
 * - `openai`: GPT-5.6+ explicit mode — `prompt_cache_options.mode: explicit`
 *   plus a `prompt_cache_breakpoint` on the system block. Implicit mode would
 *   write the whole (per-PR) prompt at 1.25x on every call. The lifetime is
 *   OpenAI's fixed 30m, so `5m`/`1h` both enable it; `off` sends explicit
 *   mode with no breakpoint (no writes). Older models get nothing.
 * - `kimi`: Kimi's `prompt_cache_options: { mode: implicit, ttl }`.
 */
export type PromptCacheStyle = 'cache-control' | 'openai' | 'kimi';

/** Extra cost of a cache write over base input, as a fraction of the input rate. */
const WRITE_PREMIUM = {
  /** Anthropic 5m and OpenAI GPT-5.6+ writes: 1.25x. */
  standard: 0.25,
  /** Anthropic and Kimi 1h writes: 2x. */
  oneHour: 1,
  /** Writes billed at the plain input rate (Kimi 5m, most automatic caches). */
  none: 0,
} as const;

/** The requested lifetime when caching is on; undefined for `off` or unset. */
function cacheTtl(setting: PromptCacheSetting | undefined): '5m' | '1h' | undefined {
  return setting === '1h' || setting === '5m' ? setting : undefined;
}

/** Anthropic-style `cache_control` marker for a lifetime. */
function cacheControl(ttl: '5m' | '1h'): Record<string, string> {
  return ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
}

function ttlPremium(ttl: '5m' | '1h' | undefined): number {
  return ttl === '1h' ? WRITE_PREMIUM.oneHour : WRITE_PREMIUM.standard;
}

// ---------------------------------------------------------------------------
// Anthropic Messages API

/** The Messages `system` field: a cached text block, or a plain string when off. */
export function anthropicSystem(
  systemText: string,
  setting: PromptCacheSetting | undefined,
): string | Array<Record<string, unknown>> {
  const ttl = cacheTtl(setting);
  return ttl ? [{ type: 'text', text: systemText, cache_control: cacheControl(ttl) }] : systemText;
}

/**
 * Cache writes from Messages API usage. Anthropic splits writes by TTL; older
 * responses omit the split, so their writes count as 5m.
 */
export function anthropicCacheWrite(usage: {
  cache_creation_input_tokens?: number | null;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  } | null;
} | undefined): CacheWriteUsage | undefined {
  const oneHour = usage?.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const fiveMinute = usage?.cache_creation
    ? usage.cache_creation.ephemeral_5m_input_tokens ?? 0
    : usage?.cache_creation_input_tokens ?? 0;
  const tokens = oneHour + fiveMinute;
  if (tokens <= 0) return undefined;
  const premium =
    (fiveMinute * WRITE_PREMIUM.standard + oneHour * WRITE_PREMIUM.oneHour) / tokens;
  return { tokens, premium };
}

// ---------------------------------------------------------------------------
// Chat Completions (OpenAI, OpenRouter, Kimi, compatible endpoints)

/** Wrap the system prompt in a text block carrying `marker`. */
function markSystemPrompt(
  messages: ChatMessage[],
  marker: Record<string, unknown>,
): unknown[] {
  return messages.map((message) =>
    message.role === 'system' && message.content.length > 0
      ? { role: 'system', content: [{ type: 'text', text: message.content, ...marker }] }
      : message,
  );
}

/** Request fields and messages carrying this endpoint's cache hint. */
export function chatCacheRequest(
  style: PromptCacheStyle,
  setting: PromptCacheSetting | undefined,
  model: string,
  messages: ChatMessage[],
): { fields: Record<string, unknown>; messages: unknown[] } {
  const ttl = cacheTtl(setting);
  const none = { fields: {}, messages };
  switch (style) {
    case 'cache-control':
      if (!ttl) return none;
      return { fields: {}, messages: markSystemPrompt(messages, { cache_control: cacheControl(ttl) }) };
    case 'openai':
      if (setting === undefined || !supportsOpenAIExplicitCache(model)) return none;
      return {
        fields: { prompt_cache_options: { mode: 'explicit' } },
        messages: ttl
          ? markSystemPrompt(messages, { prompt_cache_breakpoint: { mode: 'explicit' } })
          : messages,
      };
    case 'kimi':
      if (!ttl) return none;
      return { fields: { prompt_cache_options: { mode: 'implicit', ttl } }, messages };
  }
}

/**
 * Price reported cache writes (`prompt_tokens_details.cache_write_tokens`).
 * The premium depends on who actually wrote the cache: behind `cache-control`
 * (OpenRouter), Claude writes follow the requested TTL while automatic caches
 * (OpenAI GPT-5.6+ at 1.25x, most others at the input rate) bill their own
 * way. Gemini's storage charge is not modeled.
 */
export function chatCacheWrite(
  style: PromptCacheStyle,
  setting: PromptCacheSetting | undefined,
  model: string,
  tokens: number,
): CacheWriteUsage | undefined {
  if (tokens <= 0) return undefined;
  const automaticPremium = supportsOpenAIExplicitCache(model)
    ? WRITE_PREMIUM.standard
    : WRITE_PREMIUM.none;
  switch (style) {
    case 'cache-control':
      return {
        tokens,
        premium: isClaudeModel(model) ? ttlPremium(cacheTtl(setting)) : automaticPremium,
      };
    case 'openai':
      return { tokens, premium: automaticPremium };
    case 'kimi':
      return {
        tokens,
        premium: cacheTtl(setting) === '1h' ? WRITE_PREMIUM.oneHour : WRITE_PREMIUM.none,
      };
  }
}
