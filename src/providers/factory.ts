import { modelForRole, PROVIDERS, type ReviewConfig } from "../config/schema.js";
import { AnthropicProvider, anthropicApiKeyAuth } from "./anthropic.js";
import { bearerAuth, type RequestAuth } from "./auth.js";
import {
  ANTHROPIC_API_BASE_URL,
  KIMI_API_BASE_URL,
  OPENAI_API_BASE_URL,
  OPENROUTER_API_BASE_URL,
} from "./endpoints.js";
import { createFederatedAuth, type FederationConfig } from "./federation.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import type { PromptCacheSetting, PromptCacheStyle } from "./prompt-cache.js";
import {
  ResilientProvider,
  type ResilientProviderOptions,
} from "./resilient.js";
import type { LLMProvider } from "./interface.js";
import { ConfigError } from "../utils/errors.js";

/**
 * Per-provider construction defaults. OpenAI-compatible, OpenRouter, OpenAI,
 * and Kimi use the shared Chat Completions adapter; Anthropic uses its native
 * Messages API. `promptCache` is the cache lifetime when the config sets none.
 */
const PROVIDER_DEFAULTS: Record<
  ReviewConfig["provider"],
  {
    baseUrl?: string;
    completionTokenParam?: "max_completion_tokens";
    /** How a static API key is sent; defaults to `Authorization: Bearer`. */
    apiKeyAuth?: (apiKey: string) => RequestAuth;
    /** System-prompt cache lifetime when `promptCache` is not configured. */
    promptCache?: PromptCacheSetting;
    /** How a Chat Completions endpoint is told to cache; see `PromptCacheStyle`. */
    cacheStyle?: PromptCacheStyle;
  }
> = {
  // Unknown endpoint: cache_control is only sent when promptCache is set.
  "openai-compatible": { cacheStyle: "cache-control" },
  // Anthropic/Gemini/Qwen models behind OpenRouter only cache with an
  // explicit breakpoint; automatic-cache models ignore it.
  openrouter: {
    baseUrl: OPENROUTER_API_BASE_URL,
    cacheStyle: "cache-control",
    promptCache: "1h",
  },
  // GPT-5.6+ explicit mode: only the system prompt is written (lifetime is
  // OpenAI's fixed 30m), instead of the whole per-PR prompt.
  openai: {
    baseUrl: OPENAI_API_BASE_URL,
    completionTokenParam: "max_completion_tokens",
    cacheStyle: "openai",
    promptCache: "1h",
  },
  // Kimi caches implicitly (5m, writes at plain input price).
  // `prompt_cache_options` is documented for the Open Platform, not the Kimi
  // Code endpoint, so it is only sent when `promptCache` is set explicitly.
  kimi: { baseUrl: KIMI_API_BASE_URL, cacheStyle: "kimi" },
  anthropic: {
    baseUrl: ANTHROPIC_API_BASE_URL,
    apiKeyAuth: anthropicApiKeyAuth,
    // Caching is opt-in on the Messages API. One review fans out into several
    // calls sharing a system prompt, and pushes often land within the hour.
    promptCache: "1h",
  },
};

function parseProvider(provider: string): ReviewConfig["provider"] {
  if ((PROVIDERS as readonly string[]).includes(provider)) {
    return provider as ReviewConfig["provider"];
  }

  throw new ConfigError(
    `Invalid provider: "${provider}". Supported providers: ${PROVIDERS.join(", ")}`,
  );
}

/** Exactly one of a static API key or workload identity federation. */
function resolveAuth(
  { apiKey, federation, userAgent }: { apiKey?: string; federation?: FederationConfig; userAgent?: string },
  provider: ReviewConfig["provider"],
  baseUrl: string,
): RequestAuth {
  if (apiKey && federation) {
    throw new ConfigError(
      "Configure either an API key or workload identity federation, not both.",
    );
  }
  if (federation) return createFederatedAuth(provider, federation, { baseUrl, userAgent });
  if (apiKey) return (PROVIDER_DEFAULTS[provider].apiKeyAuth ?? bearerAuth)(apiKey);
  throw new ConfigError(
    "Missing LLM credentials: set an API key or workload identity federation.",
  );
}

/**
 * Provider options that come straight from repo config. Every entry point
 * spreads this into `createLLMProvider`, so a new config knob is wired once
 * here; callers add only what they override (provider, baseUrl, userAgent,
 * credentials).
 */
export function providerOptionsFromConfig(config: ReviewConfig): {
  model: string;
  modelParams?: Record<string, unknown>;
  promptCache?: PromptCacheSetting;
} {
  return {
    model: modelForRole(config, "groupReview"),
    modelParams: config.modelParams,
    promptCache: config.promptCache,
  };
}

export function createLLMProvider(config: {
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
}): LLMProvider {
  const provider = parseProvider(config.provider);
  const defaults = PROVIDER_DEFAULTS[provider];

  const baseUrl = config.baseUrl ?? defaults.baseUrl;
  if (!baseUrl) {
    throw new ConfigError(
      `Missing baseUrl for provider "${provider}". Configure an operator-controlled BASE_URL.`,
    );
  }

  const auth = resolveAuth(config, provider, baseUrl);
  const promptCache = config.promptCache ?? defaults.promptCache;

  if (provider === "anthropic") {
    return new ResilientProvider(
      new AnthropicProvider({
        auth,
        model: config.model,
        baseUrl,
        userAgent: config.userAgent,
        modelParams: config.modelParams,
        promptCache,
      }),
      config.retry,
    );
  }

  const inner = new OpenAICompatibleProvider({
    auth,
    model: config.model,
    baseUrl,
    userAgent: config.userAgent,
    completionTokenParam: defaults.completionTokenParam,
    modelParams: config.modelParams,
    cacheStyle: defaults.cacheStyle,
    promptCache,
  });

  return new ResilientProvider(inner, config.retry);
}
