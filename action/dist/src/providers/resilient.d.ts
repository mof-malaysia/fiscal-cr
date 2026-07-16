import type { ChatCompletionParams, LLMCompletionResponse, LLMProvider } from './interface.js';
export interface ResilientProviderOptions {
    /** Retry attempts after the initial call. Default 3. */
    maxRetries?: number;
    /** Ceiling for a single backoff wait. Default 30s. */
    maxBackoffMs?: number;
}
/**
 * Decorator that adds retry-with-backoff to any LLMProvider.
 * Retries 429/5xx/timeout/network errors with exponential backoff and full
 * jitter, honoring Retry-After when the API supplies it. Other 4xx errors
 * (auth, bad request) are never retried.
 */
export declare class ResilientProvider implements LLMProvider {
    private readonly inner;
    private readonly maxRetries;
    private readonly maxBackoffMs;
    constructor(inner: LLMProvider, options?: ResilientProviderOptions);
    chatCompletion(params: ChatCompletionParams): Promise<LLMCompletionResponse>;
    private backoffDelay;
}
//# sourceMappingURL=resilient.d.ts.map