import { type RequestAuth } from './auth.js';
import { type PromptCacheSetting, type PromptCacheStyle } from './prompt-cache.js';
import { type ChatCompletionParams, type LLMCompletionResponse, type LLMProvider } from './interface.js';
export interface OpenAICompatibleProviderConfig {
    /** Request auth: a bearer API key or workload identity federation. */
    auth: RequestAuth;
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
    /**
     * How this endpoint is told to cache the system prompt. See
     * `PromptCacheStyle`. Defaults to `cache-control`.
     */
    cacheStyle?: PromptCacheStyle;
    /** System-prompt cache lifetime. Omitted → nothing is sent. */
    promptCache?: PromptCacheSetting;
}
/**
 * Generic provider for OpenAI-compatible chat completion APIs.
 * Works with any OpenAI-compatible endpoint (FiscalCR, OpenAI, Groq, self-hosted, etc.).
 */
export declare class OpenAICompatibleProvider implements LLMProvider {
    private readonly auth;
    private readonly model;
    private readonly baseUrl;
    private readonly temperature?;
    private readonly timeout;
    private readonly userAgent?;
    private readonly completionTokenParam;
    private readonly modelParams;
    private readonly cacheStyle;
    private readonly promptCache?;
    constructor(config: OpenAICompatibleProviderConfig);
    chatCompletion(params: ChatCompletionParams): Promise<LLMCompletionResponse>;
    private performCompletionRequest;
}
//# sourceMappingURL=openai-compatible.d.ts.map