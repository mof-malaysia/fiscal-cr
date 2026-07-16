import { type ResilientProviderOptions } from "./resilient.js";
import type { LLMProvider } from "./interface.js";
export declare const SUPPORTED_PROVIDERS: readonly ["openai-compatible", "kimi"];
export declare function createLLMProvider(config: {
    apiKey: string;
    model: string;
    baseUrl?: string;
    provider: string;
    /** Custom User-Agent for endpoints that whitelist clients. */
    userAgent?: string;
    retry?: ResilientProviderOptions;
}): LLMProvider;
//# sourceMappingURL=factory.d.ts.map