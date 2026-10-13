import type { ReviewConfig } from '../config/schema.js';
import type { ChatMessage } from '../types/review.js';
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
/** The `system` field: a cache-marked text block, or plain text when off. */
export declare function anthropicSystem(text: string, setting: PromptCacheSetting | undefined): string | {
    type: string;
    text: string;
    cache_control: {
        type: string;
        ttl: string;
    } | {
        type: string;
        ttl?: undefined;
    };
}[];
/** Anthropic bills 5m writes at 1.25x input and 1h writes at 2x. */
export declare function anthropicCacheWrite(fiveMinuteTokens: number, oneHourTokens: number): CacheWriteUsage | undefined;
/** The request's cache fields (sent before `modelParams`) and its messages. */
export declare function chatCacheRequest(style: PromptCacheStyle, setting: PromptCacheSetting | undefined, model: string, messages: ChatMessage[]): {
    fields: object;
    messages: unknown[];
};
/**
 * Price reported cache writes. Behind `cache-control` (OpenRouter), only
 * Claude writes follow the TTL we asked for; other models cache on their own
 * terms. Gemini's storage charge is not modeled.
 */
export declare function chatCacheWrite(style: PromptCacheStyle, setting: PromptCacheSetting | undefined, model: string, tokens: number): CacheWriteUsage | undefined;
//# sourceMappingURL=prompt-cache.d.ts.map