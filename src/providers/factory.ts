import type { ReviewConfig } from '../config/schema.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import type { LLMProvider } from './interface.js';
import { ConfigError } from '../utils/errors.js';

export const SUPPORTED_PROVIDERS = ['openai-compatible', 'kimi'] as const;
const KIMI_API_BASE_URL = 'https://api.kimi.com/coding/v1';

function parseProvider(provider: string): ReviewConfig['provider'] {
  if (provider === 'openai-compatible' || provider === 'kimi') {
    return provider;
  }

  throw new ConfigError(
    `Invalid provider: "${provider}". Supported providers: ${SUPPORTED_PROVIDERS.join(', ')}`,
  );
}

export function createLLMProvider(config: {
  apiKey: string;
  model: string;
  baseUrl?: string;
  provider: string;
}): LLMProvider {
  const provider = parseProvider(config.provider);

  // All providers share the OpenAI-compatible adapter.
  // Adding non-compatible providers (e.g., Anthropic) is straightforward.
  switch (provider) {
    case 'openai-compatible':
      if (!config.baseUrl) {
        throw new ConfigError(
          'Missing baseUrl for provider "openai-compatible". Configure an operator-controlled BASE_URL.',
        );
      }
      return new OpenAICompatibleProvider({
        apiKey: config.apiKey,
        model: config.model,
        baseUrl: config.baseUrl,
      });
    case 'kimi':
    default:
      return new OpenAICompatibleProvider({
        apiKey: config.apiKey,
        model: config.model,
        baseUrl: config.baseUrl ?? KIMI_API_BASE_URL,
      });
  }
}
