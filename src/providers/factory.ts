import type { ReviewConfig } from "../config/schema.js";
import { AnthropicProvider, anthropicApiKeyAuth } from "./anthropic.js";
import { bearerAuth, type RequestAuth } from "./auth.js";
import { createFederatedAuth, type FederationConfig } from "./federation.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import {
  ResilientProvider,
  type ResilientProviderOptions,
} from "./resilient.js";
import type { LLMProvider } from "./interface.js";
import { ConfigError } from "../utils/errors.js";

export const SUPPORTED_PROVIDERS = ["openai-compatible", "kimi", "openai", "anthropic"] as const;
const KIMI_API_BASE_URL = "https://api.kimi.com/coding/v1";
const OPENAI_API_BASE_URL = "https://api.openai.com/v1";
const ANTHROPIC_API_BASE_URL = "https://api.anthropic.com/v1";

/**
 * Per-provider construction defaults. OpenAI-compatible, OpenAI, and Kimi use
 * the shared Chat Completions adapter; Anthropic uses its native Messages API.
 */
const PROVIDER_DEFAULTS: Record<
  ReviewConfig["provider"],
  {
    baseUrl?: string;
    completionTokenParam?: "max_completion_tokens";
    /** How a static API key is sent; defaults to `Authorization: Bearer`. */
    apiKeyAuth?: (apiKey: string) => RequestAuth;
    /** System-prompt cache lifetime when `promptCache` is not configured. */
    promptCache?: ReviewConfig["promptCache"];
  }
> = {
  "openai-compatible": {},
  openai: {
    baseUrl: OPENAI_API_BASE_URL,
    completionTokenParam: "max_completion_tokens",
  },
  kimi: { baseUrl: KIMI_API_BASE_URL },
  anthropic: {
    baseUrl: ANTHROPIC_API_BASE_URL,
    apiKeyAuth: anthropicApiKeyAuth,
    // Caching is opt-in on the Messages API. One review fans out into several
    // calls sharing a system prompt, and pushes often land within the hour.
    promptCache: "1h",
  },
};

function parseProvider(provider: string): ReviewConfig["provider"] {
  if ((SUPPORTED_PROVIDERS as readonly string[]).includes(provider)) {
    return provider as ReviewConfig["provider"];
  }

  throw new ConfigError(
    `Invalid provider: "${provider}". Supported providers: ${SUPPORTED_PROVIDERS.join(", ")}`,
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
  promptCache?: ReviewConfig["promptCache"];
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

  if (provider === "anthropic") {
    return new ResilientProvider(
      new AnthropicProvider({
        auth,
        model: config.model,
        baseUrl,
        userAgent: config.userAgent,
        modelParams: config.modelParams,
        promptCache: config.promptCache ?? defaults.promptCache,
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
  });

  return new ResilientProvider(inner, config.retry);
}
