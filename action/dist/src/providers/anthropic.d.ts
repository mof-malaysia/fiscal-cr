import type { ChatCompletionParams, LLMCompletionResponse, LLMProvider } from './interface.js';
export interface AnthropicProviderConfig {
    apiKey: string;
    model: string;
    baseUrl?: string;
    /** Custom User-Agent header for provider allowlists and observability. */
    userAgent?: string;
    /** Provider-native request fields merged into each Messages request. */
    modelParams?: Record<string, unknown>;
}
/** Native adapter for Anthropic's Messages API. */
export declare class AnthropicProvider implements LLMProvider {
    private readonly apiKey;
    private readonly model;
    private readonly baseUrl;
    private readonly userAgent?;
    private readonly modelParams;
    constructor(config: AnthropicProviderConfig);
    chatCompletion(params: ChatCompletionParams): Promise<LLMCompletionResponse>;
    private performCompletionRequest;
}
//# sourceMappingURL=anthropic.d.ts.map