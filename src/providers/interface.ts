import type { ChatMessage } from '../types/review.js';

/** Prompt-cache writes for one call, priced by the provider that made them. */
export interface CacheWriteUsage {
  /** Tokens written to the cache (already counted in `input`). */
  tokens: number;
  /** Extra cost over base input, as a fraction of the input rate (0.25 = 1.25x). */
  premium: number;
}

export interface LLMTokenUsage {
  input: number;
  output: number;
  cached: number;
  cacheWrite?: CacheWriteUsage;
}

export interface LLMCompletionResponse {
  content: string;
  usage: LLMTokenUsage;
  /**
   * Why the model stopped generating. `'length'` means the response was
   * truncated at the token cap — the content is very likely incomplete
   * (e.g. cut-off JSON). Undefined when the endpoint omits it.
   */
  finishReason?: string;
}

export interface ChatCompletionParams {
  messages: ChatMessage[];
  /**
   * Model to use for this call. Omitted → the provider's constructor model.
   */
  model?: string;
  responseFormat?: { type: 'json_object' | 'text' };
  /** Cap on completion tokens. Omitted → provider/server default. */
  maxTokens?: number;
  /** Sampling temperature override for this call. */
  temperature?: number;
  /** Per-call timeout override in milliseconds. */
  timeoutMs?: number;
}

export interface LLMProvider {
  chatCompletion(params: ChatCompletionParams): Promise<LLMCompletionResponse>;
}

/** User-Agent sent when no custom one is configured. */
export const DEFAULT_USER_AGENT = 'fiscalcr/1.0';
