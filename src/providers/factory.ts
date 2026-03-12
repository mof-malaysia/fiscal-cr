import type { ReviewConfig } from '../config/schema.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import type { LLMProvider } from './interface.js';
import { ConfigError } from '../utils/errors.js';

export const SUPPORTED_PROVIDERS = ['kimi', 'openai-compatible'] as const;

function parseProvider(provider: string): ReviewConfig['provider'] {
  if (provider === 'kimi' || provider === 'openai-compatible') {
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
  maxTokens?: number;
  provider: string;
}): LLMProvider {
  const provider = parseProvider(config.provider);

  // For now, we support Kimi + any OpenAI-compatible endpoint through one adapter.
  // Keep this switch so adding non-compatible providers (e.g., Anthropic) is straightforward.
  switch (provider) {
    case 'openai-compatible':
    case 'kimi':
    default:
      return new OpenAICompatibleProvider({
        apiKey: config.apiKey,
        model: config.model,
        baseUrl: config.baseUrl,
        maxTokens: config.maxTokens,
      });
  }
}
