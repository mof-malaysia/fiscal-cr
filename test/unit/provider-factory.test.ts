import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/utils/errors.js';
import { createLLMProvider } from '../../src/providers/factory.js';

describe('provider factory', () => {
  it('creates provider for legacy kimi without explicit baseUrl', () => {
    const provider = createLLMProvider({
      apiKey: 'test-key',
      provider: 'kimi',
      model: 'kimi-k2.5',
    });

    expect(provider).toBeTruthy();
    expect(typeof provider.chatCompletion).toBe('function');
  });

  it('creates provider for openai-compatible', () => {
    const provider = createLLMProvider({
      apiKey: 'test-key',
      provider: 'openai-compatible',
      model: 'gpt-4.1-mini',
      baseUrl: 'https://api.openai.com/v1',
    });

    expect(provider).toBeTruthy();
    expect(typeof provider.chatCompletion).toBe('function');
  });

  it('creates provider for openrouter without requiring an explicit baseUrl', () => {
    const provider = createLLMProvider({
      apiKey: 'test-key',
      provider: 'openrouter',
      model: 'nvidia/nemotron-3-super-120b-a12b:free',
    });

    expect(provider).toBeTruthy();
    expect(typeof provider.chatCompletion).toBe('function');
  });

  it('throws ConfigError when openai-compatible has no baseUrl', () => {
    expect(() =>
      createLLMProvider({
        apiKey: 'test-key',
        provider: 'openai-compatible',
        model: 'gpt-4.1-mini',
      }),
    ).toThrowError(ConfigError);

    expect(() =>
      createLLMProvider({
        apiKey: 'test-key',
        provider: 'openai-compatible',
        model: 'gpt-4.1-mini',
      }),
    ).toThrow(/Missing baseUrl/);
  });

  it('throws ConfigError for invalid provider', () => {
    expect(() =>
      createLLMProvider({
        apiKey: 'test-key',
        provider: 'invalid-provider',
        model: 'any-model',
      }),
    ).toThrowError(ConfigError);

    expect(() =>
      createLLMProvider({
        apiKey: 'test-key',
        provider: 'invalid-provider',
        model: 'any-model',
      }),
    ).toThrow(/Invalid provider/);
  });
});
