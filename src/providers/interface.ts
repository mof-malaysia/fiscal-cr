import type { ChatMessage } from '../types/review.js';

export interface LLMTokenUsage {
  input: number;
  output: number;
  cached: number;
}

export interface LLMCompletionResponse {
  content: string;
  usage: LLMTokenUsage;
}

export interface LLMProvider {
  chatCompletion(params: {
    messages: ChatMessage[];
    responseFormat?: { type: 'json_object' | 'text' };
  }): Promise<LLMCompletionResponse>;
}
