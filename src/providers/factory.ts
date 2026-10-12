import type { ReviewConfig } from "../config/schema.js";
import { AnthropicProvider } from "./anthropic.js";
import {
  apiKeyAuth,
  federationAuth,
  type AnthropicFederationConfig,
} from "./anthropic-auth.js";
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
  { baseUrl?: string; completionTokenParam?: "max_completion_tokens" }
> = {
  "openai-compatible": {},
  openai: {
    baseUrl: OPENAI_API_BASE_URL,
    completionTokenParam: "max_completion_tokens",
  },
  kimi: { baseUrl: KIMI_API_BASE_URL },
  anthropic: { baseUrl: ANTHROPIC_API_BASE_URL },
};

function parseProvider(provider: string): ReviewConfig["provider"] {
  if ((SUPPORTED_PROVIDERS as readonly string[]).includes(provider)) {
    return provider as ReviewConfig["provider"];
  }

  throw new ConfigError(
    `Invalid provider: "${provider}". Supported providers: ${SUPPORTED_PROVIDERS.join(", ")}`,
  );
}

export function createLLMProvider(config: {
  /** Static provider API key. Exactly one of `apiKey` or `anthropicFederation`. */
  apiKey?: string;
  /** Keyless Anthropic auth via workload identity federation (Anthropic only). */
  anthropicFederation?: AnthropicFederationConfig;
  model: string;
  baseUrl?: string;
  provider: string;
  /** Custom User-Agent for endpoints that whitelist clients. */
  userAgent?: string;
  /** Provider-native request fields merged into every call. */
  modelParams?: Record<string, unknown>;
  retry?: ResilientProviderOptions;
}): LLMProvider {
  const provider = parseProvider(config.provider);
  const defaults = PROVIDER_DEFAULTS[provider];

  const { apiKey, anthropicFederation } = config;
  if (apiKey && anthropicFederation) {
    throw new ConfigError(
      "Configure either an API key or Anthropic federation, not both.",
    );
  }
  if (anthropicFederation && provider !== "anthropic") {
    throw new ConfigError(
      `Anthropic federation requires provider "anthropic" (got "${provider}").`,
    );
  }
  if (!apiKey && !anthropicFederation) {
    throw new ConfigError(
      "Missing LLM credentials: set an API key, or Anthropic federation (provider anthropic).",
    );
  }

  const baseUrl = config.baseUrl ?? defaults.baseUrl;
  if (!baseUrl) {
    throw new ConfigError(
      `Missing baseUrl for provider "${provider}". Configure an operator-controlled BASE_URL.`,
    );
  }

  if (provider === "anthropic") {
    return new ResilientProvider(
      new AnthropicProvider({
        auth: anthropicFederation
          ? federationAuth({
              ...anthropicFederation,
              baseUrl,
              userAgent: config.userAgent,
            })
          : apiKeyAuth(apiKey!),
        model: config.model,
        baseUrl,
        userAgent: config.userAgent,
        modelParams: config.modelParams,
      }),
      config.retry,
    );
  }

  const inner = new OpenAICompatibleProvider({
    apiKey: config.apiKey!,
    model: config.model,
    baseUrl,
    userAgent: config.userAgent,
    completionTokenParam: defaults.completionTokenParam,
    modelParams: config.modelParams,
  });

  return new ResilientProvider(inner, config.retry);
}
