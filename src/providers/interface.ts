import type { ChatMessage } from '../types/review.js';

export interface LLMTokenUsage {
  input: number;
  output: number;
  cached: number;
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
