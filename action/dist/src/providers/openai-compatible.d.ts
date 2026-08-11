import type { ChatCompletionParams, LLMCompletionResponse, LLMProvider } from './interface.js';
export interface OpenAICompatibleProviderConfig {
    apiKey: string;
    model: string;
    baseUrl?: string;
    temperature?: number;
    timeout?: number;
    /**
     * Override the User-Agent header. Some endpoints whitelist clients by
     * User-Agent and reject unknown ones. When set, the X-Client-Name header
     * is omitted so the request carries one identity.
     */
    userAgent?: string;
    /**
     * Field name for the completion-token cap. OpenAI models require
     * "max_completion_tokens"; legacy/compatible endpoints use "max_tokens".
     * Defaults to "max_tokens".
     */
    completionTokenParam?: 'max_tokens' | 'max_completion_tokens';
    /**
     * Operator-supplied passthrough fields (reasoning_effort, verbosity, top_p,
     * seed, …) merged into every request body. Pipeline-managed keys are stripped
     * (see RESERVED_MODEL_PARAM_KEYS) so they cannot override the pipeline.
     */
    modelParams?: Record<string, unknown>;
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
    private readonly completionTokenParam;
    private readonly modelParams;
    constructor(config: OpenAICompatibleProviderConfig);
    chatCompletion(params: ChatCompletionParams): Promise<LLMCompletionResponse>;
    private performCompletionRequest;
}
//# sourceMappingURL=openai-compatible.d.ts.map