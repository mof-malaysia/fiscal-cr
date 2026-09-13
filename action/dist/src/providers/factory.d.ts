import { type ResilientProviderOptions } from "./resilient.js";
import type { LLMProvider } from "./interface.js";
export declare const SUPPORTED_PROVIDERS: readonly ["openai-compatible", "kimi", "openai", "anthropic"];
export declare function createLLMProvider(config: {
    apiKey: string;
    model: string;
    baseUrl?: string;
    provider: string;
    /** Custom User-Agent for endpoints that whitelist clients. */
    userAgent?: string;
    /** Provider-native request fields merged into every call. */
    modelParams?: Record<string, unknown>;
    retry?: ResilientProviderOptions;
}): LLMProvider;
//# sourceMappingURL=factory.d.ts.map