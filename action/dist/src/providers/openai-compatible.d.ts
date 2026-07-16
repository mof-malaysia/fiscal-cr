import type { ChatCompletionParams, LLMCompletionResponse, LLMProvider } from './interface.js';
export interface OpenAICompatibleProviderConfig {
    apiKey: string;
    model: string;
    baseUrl?: string;
    temperature?: number;
    timeout?: number;
    /**
     * Override the User-Agent header. Some endpoints (e.g. Kimi for Coding)
     * whitelist clients by User-Agent and reject unknown ones. When set, the
     * X-Client-Name header is omitted so the request carries one identity.
     */
    userAgent?: string;
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
    private readonly userAgent?;
    constructor(config: OpenAICompatibleProviderConfig);
    chatCompletion(params: ChatCompletionParams): Promise<LLMCompletionResponse>;
    private performCompletionRequest;
}
//# sourceMappingURL=openai-compatible.d.ts.map