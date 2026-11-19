import { type RequestAuth } from './auth.js';
import { type PromptCacheSetting } from './prompt-cache.js';
import { type ChatCompletionParams, type LLMCompletionResponse, type LLMProvider } from './interface.js';
/** Anthropic's static API key scheme. */
export declare function anthropicApiKeyAuth(apiKey: string): RequestAuth;
export interface AnthropicProviderConfig {
    /** Request auth: a static API key or workload identity federation. */
    auth: RequestAuth;
    model: string;
    baseUrl?: string;
    /** Custom User-Agent header for provider allowlists and observability. */
    userAgent?: string;
    /** Provider-native request fields merged into each Messages request. */
    modelParams?: Record<string, unknown>;
    /** System-prompt cache lifetime. Omitted → no cache breakpoint. */
    promptCache?: PromptCacheSetting;
}
/** Native adapter for Anthropic's Messages API. */
export declare class AnthropicProvider implements LLMProvider {
    private readonly auth;
    private readonly model;
    private readonly baseUrl;
    private readonly userAgent?;
    private readonly modelParams;
    private readonly promptCache?;
    constructor(config: AnthropicProviderConfig);
    chatCompletion(params: ChatCompletionParams): Promise<LLMCompletionResponse>;
    private performCompletionRequest;
}
//# sourceMappingURL=anthropic.d.ts.map