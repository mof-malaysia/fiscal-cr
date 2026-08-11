import type { ReviewConfig } from "../config/schema.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import {
  ResilientProvider,
  type ResilientProviderOptions,
} from "./resilient.js";
import type { LLMProvider } from "./interface.js";
import { ConfigError } from "../utils/errors.js";

export const SUPPORTED_PROVIDERS = ["openai-compatible", "kimi", "openai"] as const;
const KIMI_API_BASE_URL = "https://api.kimi.com/coding/v1";
const OPENAI_API_BASE_URL = "https://api.openai.com/v1";

/**
 * Per-provider construction defaults for the shared OpenAI-compatible adapter.
 * A missing `baseUrl` means the operator must supply one explicitly
 * (openai-compatible); the others default to their vendor endpoint.
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
  apiKey: string;
  model: string;
  baseUrl?: string;
  provider: string;
  /** Custom User-Agent for endpoints that whitelist clients. */
  userAgent?: string;
  retry?: ResilientProviderOptions;
}): LLMProvider {
  const provider = parseProvider(config.provider);
  const defaults = PROVIDER_DEFAULTS[provider];

  // All providers share the OpenAI-compatible adapter, differing only in their
  // base-URL default and token-cap field. Adding a non-compatible provider
  // (e.g., Anthropic) is straightforward — swap the adapter in a new branch.
  const baseUrl = config.baseUrl ?? defaults.baseUrl;
  if (!baseUrl) {
    throw new ConfigError(
      `Missing baseUrl for provider "${provider}". Configure an operator-controlled BASE_URL.`,
    );
  }

  const inner = new OpenAICompatibleProvider({
    apiKey: config.apiKey,
    model: config.model,
    baseUrl,
    userAgent: config.userAgent,
    completionTokenParam: defaults.completionTokenParam,
  });

  return new ResilientProvider(inner, config.retry);
}
