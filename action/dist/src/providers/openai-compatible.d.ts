import type { ChatCompletionParams, LLMCompletionResponse, LLMProvider } from './interface.js';
export interface OpenAICompatibleProviderConfig {
    apiKey: string;
    model: string;
    baseUrl?: string;
    temperature?: number;
    timeout?: number;
}
/**
 * Generic provider for OpenAI-compatible chat completion APIs.
 * Works with any OpenAI-compatible endpoint (FiscalCR, OpenAI, Groq, self-hosted, etc.).
 */
export declare class OpenAICompatibleProvider implements LLMProvider {
    private readonly apiKey;
    private readonly model;
    private readonly baseUrl;
    private readonly temperature?;
    private readonly timeout;
    constructor(config: OpenAICompatibleProviderConfig);
    chatCompletion(params: ChatCompletionParams): Promise<LLMCompletionResponse>;
    private performCompletionRequest;
}
//# sourceMappingURL=openai-compatible.d.ts.map