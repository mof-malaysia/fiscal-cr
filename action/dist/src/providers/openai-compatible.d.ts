import type { ChatMessage } from '../types/review.js';
import type { LLMCompletionResponse, LLMProvider } from './interface.js';
export interface OpenAICompatibleProviderConfig {
    apiKey: string;
    model: string;
    baseUrl?: string;
    maxTokens?: number;
    temperature?: number;
    timeout?: number;
}
/**
 * Generic provider for OpenAI-compatible chat completion APIs.
 * Works with Kimi, OpenAI, Groq, and self-hosted compatible endpoints.
 */
export declare class OpenAICompatibleProvider implements LLMProvider {
    private readonly apiKey;
    private readonly model;
    private readonly baseUrl;
    private readonly maxTokens;
    private readonly temperature;
    private readonly timeout;
    constructor(config: OpenAICompatibleProviderConfig);
    chatCompletion(params: {
        messages: ChatMessage[];
        responseFormat?: {
            type: 'json_object' | 'text';
        };
    }): Promise<LLMCompletionResponse>;
    private performCompletionRequest;
}
//# sourceMappingURL=openai-compatible.d.ts.map