import { type ReviewConfig } from "../config/schema.js";
import { type FederationConfig } from "./federation.js";
import type { PromptCacheSetting } from "./prompt-cache.js";
import { type ResilientProviderOptions } from "./resilient.js";
import type { LLMProvider } from "./interface.js";
/**
 * Provider options that come straight from repo config. Every entry point
 * spreads this into `createLLMProvider`, so a new config knob is wired once
 * here; callers add only what they override (provider, baseUrl, userAgent,
 * credentials).
 */
export declare function providerOptionsFromConfig(config: ReviewConfig): {
    model: string;
    modelParams?: Record<string, unknown>;
    promptCache?: PromptCacheSetting;
};
export declare function createLLMProvider(config: {
    /** Static provider API key. Exactly one of `apiKey` or `federation`. */
    apiKey?: string;
    /** Keyless auth via workload identity federation. */
    federation?: FederationConfig;
    model: string;
    baseUrl?: string;
    provider: string;
    /** Custom User-Agent for endpoints that whitelist clients. */
    userAgent?: string;
    /** Provider-native request fields merged into every call. */
    modelParams?: Record<string, unknown>;
    /** System-prompt cache lifetime. Omitted → the provider default. */
    promptCache?: PromptCacheSetting;
    retry?: ResilientProviderOptions;
}): LLMProvider;
//# sourceMappingURL=factory.d.ts.map