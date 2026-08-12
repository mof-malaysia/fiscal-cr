import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError } from '../../src/utils/errors.js';
import { createLLMProvider } from '../../src/providers/factory.js';

describe('provider factory', () => {
  afterEach(() => {
    vi.restoreAllMocks();
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

  it('creates the openai provider without an explicit baseUrl (default applies)', () => {
    const provider = createLLMProvider({
      apiKey: 'test-key',
      provider: 'openai',
      model: 'gpt-5',
    });

    expect(provider).toBeTruthy();
    expect(typeof provider.chatCompletion).toBe('function');
  });
  it('creates the Anthropic provider with its native Messages endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), {
        status: 200,
      }),
    );
    const provider = createLLMProvider({
      apiKey: 'test-key',
      provider: 'anthropic',
      model: 'claude-sonnet-4.5',
    });

    await provider.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.anthropic.com/v1/messages');
  });


  it('threads modelParams through to the provider for any provider', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          status: 200,
        }),
    );

    for (const provider of ['openai', 'kimi', 'anthropic'] as const) {
      const llm = createLLMProvider({
        apiKey: 'test-key',
        provider,
        model:
          provider === 'openai'
            ? 'gpt-5'
            : provider === 'kimi'
              ? 'kimi-for-coding'
              : 'claude-sonnet-4.5',
        modelParams: { reasoning_effort: 'high' },
      });
      await llm.chatCompletion({ messages: [{ role: 'user', content: 'hi' }] });
    }

    for (const call of fetchMock.mock.calls) {
      const body = JSON.parse(String(call[1]?.body));
      expect(body.reasoning_effort).toBe('high');
    }
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
